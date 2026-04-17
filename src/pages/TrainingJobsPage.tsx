import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  TrainingArtifactSummary,
  TrainingExecutionMode,
  TrainingJobRecord,
  TrainingJobStatus
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import AdvancedSection from '../components/AdvancedSection';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import {
  DetailDrawer,
  DetailList,
  FilterToolbar,
  InlineAlert,
  PageHeader,
  SectionCard,
  StatusTable,
  type StatusTableColumn
} from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import { Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import {
  deriveTrainingExecutionInsight,
  type TrainingExecutionInsight
} from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { bucketRuntimeFallbackReason, runtimeFallbackReasonLabelKey } from '../utils/runtimeFallbackReason';

const activeStatusSet = new Set<TrainingJobStatus>(['queued', 'preparing', 'running', 'evaluating']);
const terminalStatusSet = new Set<TrainingJobStatus>(['completed', 'failed', 'cancelled']);
const backgroundRefreshIntervalMs = 5000;

type LoadMode = 'initial' | 'manual' | 'background';
type QueueFilter = 'all' | 'active' | 'terminal';

const formatTimestamp = (iso: string): string => formatCompactTimestamp(iso);

const buildScopedDatasetPath = (datasetId: string, versionId?: string | null): string => {
  const searchParams = new URLSearchParams();
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}?${query}` : `/datasets/${datasetId}`;
};

const buildJobsSignature = (jobs: TrainingJobRecord[]): string =>
  JSON.stringify(
    [...jobs]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        updated_at: job.updated_at,
        log_excerpt: job.log_excerpt,
        task_type: job.task_type,
        framework: job.framework
      }))
  );

const describeRealityLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  insight: TrainingExecutionInsight
) => {
  if (insight.reality === 'real') {
    return t('Real output');
  }
  if (insight.reality === 'template') {
    return t('Fallback output');
  }
  if (insight.reality === 'simulated') {
    return t('Needs verification');
  }
  return t('Unknown execution');
};

const describeExecutionModeLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  mode: TrainingExecutionMode
) => {
  if (mode === 'local_command') {
    return t('Local command');
  }
  if (mode === 'simulated') {
    return t('Fallback execution');
  }
  return t('Unknown');
};

const describeExecutionTargetLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  target: TrainingJobRecord['execution_target']
) => (target === 'worker' ? t('Worker execution') : t('Local execution'));

const describeFallbackReasonLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  reason: string
) => t(runtimeFallbackReasonLabelKey(bucketRuntimeFallbackReason(reason)));

interface TrainingJobSummaryBlockProps {
  t: (source: string, vars?: Record<string, string | number>) => string;
  job: TrainingJobRecord;
  insight: TrainingExecutionInsight | null;
  realityLabel: string;
  variant: 'glance' | 'full';
}

function TrainingJobSummaryBlock({
  t,
  job,
  insight,
  realityLabel,
  variant
}: TrainingJobSummaryBlockProps) {
  const showMode = variant === 'full';
  return (
    <div className="stack">
      <div className="stack tight">
        <strong>{job.name}</strong>
        <div className="row gap wrap">
          <StatusTag status={job.status}>{t(job.status)}</StatusTag>
          <Badge tone="neutral">{t(job.task_type)}</Badge>
          <Badge tone="info">{t(job.framework)}</Badge>
          <Badge tone={insight?.reality === 'real' ? 'success' : 'warning'}>
            {insight ? realityLabel : t('Unknown')}
          </Badge>
        </div>
        <small className="muted">
          {job.base_model} · {t('Last updated')}: {formatTimestamp(job.updated_at)}
        </small>
      </div>
      <DetailList
        items={[
          { label: t('Dataset'), value: job.dataset_id || '—' },
          { label: t('Version'), value: job.dataset_version_id || '—' },
          { label: t('Lane'), value: describeExecutionTargetLabel(t, job.execution_target) },
          ...(showMode
            ? [{ label: t('Mode:'), value: describeExecutionModeLabel(t, job.execution_mode) }]
            : [])
        ]}
      />
      {insight?.showWarning ? (
        <InlineAlert
          tone={insight.reality === 'simulated' ? 'danger' : 'warning'}
          title={t('Needs verification')}
          description={
            insight.fallbackReason
              ? t(
                  'The job does not have complete real execution evidence. Review the detail first. Reason: {reason}',
                  { reason: describeFallbackReasonLabel(t, insight.fallbackReason) }
                )
              : t('The job does not have complete real execution evidence. Review the detail first.')
          }
        />
      ) : null}
    </div>
  );
}

export default function TrainingJobsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [taskFilter, setTaskFilter] = useState<
    'all' | 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
  >('all');
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | 'yolo' | 'paddleocr' | 'doctr'>(
    'all'
  );
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [selectedJobId, setSelectedJobId] = useState('');
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [selectedArtifactSummary, setSelectedArtifactSummary] = useState<TrainingArtifactSummary | null>(
    null
  );
  const [jobExecutionInsights, setJobExecutionInsights] = useState<Record<string, TrainingExecutionInsight>>(
    {}
  );
  const jobsSignatureRef = useRef('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const load = async (mode: LoadMode) => {
    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    try {
      const result = await api.listTrainingJobs();
      const nextSignature = buildJobsSignature(result);
      if (jobsSignatureRef.current !== nextSignature) {
        jobsSignatureRef.current = nextSignature;
        setJobs(result);
      }
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    load('initial').catch(() => {
      // no-op
    });
  }, []);

  useBackgroundPolling(
    () => {
      load('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: jobs.some((job) => activeStatusSet.has(job.status))
    }
  );

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((left, right) => {
        const leftPriority = activeStatusSet.has(left.status) ? 0 : terminalStatusSet.has(left.status) ? 2 : 1;
        const rightPriority = activeStatusSet.has(right.status) ? 0 : terminalStatusSet.has(right.status) ? 2 : 1;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        const leftTime = Date.parse(left.updated_at);
        const rightTime = Date.parse(right.updated_at);
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }),
    [jobs]
  );

  const terminalLocalCommandCandidates = useMemo(
    () =>
      [...jobs]
        .filter((job) => terminalStatusSet.has(job.status) && job.execution_mode === 'local_command')
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, 36),
    [jobs]
  );

  const terminalInsightSignature = useMemo(
    () =>
      terminalLocalCommandCandidates
        .map((job) => `${job.id}:${job.updated_at}`)
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    [terminalLocalCommandCandidates]
  );

  useEffect(() => {
    if (!terminalLocalCommandCandidates.length) {
      setJobExecutionInsights({});
      return;
    }

    let active = true;

    Promise.all(
      terminalLocalCommandCandidates.map(async (job) => {
        try {
          const detail = await api.getTrainingJobDetail(job.id);
          return [
            job.id,
            deriveTrainingExecutionInsight({
              status: detail.job.status,
              executionMode: detail.job.execution_mode,
              artifactSummary: detail.artifact_summary
            })
          ] as const;
        } catch {
          return [
            job.id,
            deriveTrainingExecutionInsight({
              status: job.status,
              executionMode: job.execution_mode,
              artifactSummary: null
            })
          ] as const;
        }
      })
    )
      .then((entries) => {
        if (!active) {
          return;
        }
        const next: Record<string, TrainingExecutionInsight> = {};
        entries.forEach(([id, insight]) => {
          next[id] = insight;
        });
        setJobExecutionInsights(next);
      });

    return () => {
      active = false;
    };
  }, [terminalInsightSignature, terminalLocalCommandCandidates]);

  const scopedDatasetId = (searchParams.get('dataset') ?? '').trim();
  const scopedVersionId = (searchParams.get('version') ?? '').trim();
  const scopedJobs = useMemo(
    () =>
      sortedJobs.filter((job) => {
        if (scopedDatasetId && job.dataset_id !== scopedDatasetId) {
          return false;
        }
        if (scopedVersionId && job.dataset_version_id !== scopedVersionId) {
          return false;
        }
        return true;
      }),
    [scopedDatasetId, scopedVersionId, sortedJobs]
  );

  const filteredJobs = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return scopedJobs.filter((job) => {
      if (taskFilter !== 'all' && job.task_type !== taskFilter) {
        return false;
      }
      if (frameworkFilter !== 'all' && job.framework !== frameworkFilter) {
        return false;
      }
      if (queueFilter === 'active' && !activeStatusSet.has(job.status)) {
        return false;
      }
      if (queueFilter === 'terminal' && !terminalStatusSet.has(job.status)) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        job.name.toLowerCase().includes(query) ||
        job.base_model.toLowerCase().includes(query) ||
        job.id.toLowerCase().includes(query)
      );
    });
  }, [frameworkFilter, queueFilter, scopedJobs, searchText, taskFilter]);

  useEffect(() => {
    if (!filteredJobs.length) {
      setSelectedJobId('');
      setDetailDrawerOpen(false);
      return;
    }
    if (selectedJobId && !filteredJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId('');
      setDetailDrawerOpen(false);
    }
  }, [filteredJobs, selectedJobId]);

  const selectedJob = useMemo(
    () => filteredJobs.find((job) => job.id === selectedJobId) ?? null,
    [filteredJobs, selectedJobId]
  );

  const selectedExecutionInsight = useMemo(() => {
    if (!selectedJob) {
      return null;
    }
    const cachedInsight = jobExecutionInsights[selectedJob.id];
    if (cachedInsight) {
      return cachedInsight;
    }
    return deriveTrainingExecutionInsight({
      status: selectedJob.status,
      executionMode: selectedJob.execution_mode,
      artifactSummary: selectedArtifactSummary
    });
  }, [jobExecutionInsights, selectedArtifactSummary, selectedJob]);

  const firstVisibleJob = filteredJobs[0] ?? null;
  const firstActiveJob = filteredJobs.find((job) => activeStatusSet.has(job.status)) ?? firstVisibleJob;

  const selectedExecutionRealityLabel = useMemo(() => {
    if (!selectedExecutionInsight) {
      return '';
    }
    if (selectedExecutionInsight.reality === 'real') {
      return t('Real output');
    }
    if (selectedExecutionInsight.reality === 'template') {
      return t('Fallback output');
    }
    if (selectedExecutionInsight.reality === 'simulated') {
      return t('Fallback output');
    }
    return t('Unknown execution');
  }, [selectedExecutionInsight, t]);

  const selectedJobKey = selectedJob?.id ?? '';
  const selectedJobUpdatedAt = selectedJob?.updated_at ?? '';

  useEffect(() => {
    if (selectedJobId || !firstActiveJob) {
      return;
    }

    setSelectedJobId(firstActiveJob.id);
    setDetailDrawerOpen(false);
  }, [firstActiveJob, selectedJobId]);

  useEffect(() => {
    if (!selectedJobKey) {
      setSelectedArtifactSummary(null);
      return;
    }

    let cancelled = false;
    setSelectedArtifactSummary(null);

    api
      .getTrainingJobDetail(selectedJobKey)
      .then((detail) => {
        if (!cancelled) {
          setSelectedArtifactSummary(detail.artifact_summary);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedArtifactSummary(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedJobKey, selectedJobUpdatedAt]);

  const hasScopeFilter = Boolean(scopedDatasetId || scopedVersionId);
  const scopeLabel = scopedVersionId
    ? t('Scoped to dataset {datasetId} / version {versionId}', {
        datasetId: scopedDatasetId,
        versionId: scopedVersionId
      })
    : scopedDatasetId
      ? t('Scoped to dataset {datasetId}', { datasetId: scopedDatasetId })
      : '';
  const detailQuerySuffix = useMemo(() => {
    const query = searchParams.toString();
    return query ? `?${query}` : '';
  }, [searchParams]);

  const scopedCreatePath = useMemo(() => {
    if (!hasScopeFilter) {
      return '/training/jobs/new';
    }
    const next = new URLSearchParams();
    if (scopedDatasetId) {
      next.set('dataset', scopedDatasetId);
    }
    if (scopedVersionId) {
      next.set('version', scopedVersionId);
    }
    return `/training/jobs/new?${next.toString()}`;
  }, [hasScopeFilter, scopedDatasetId, scopedVersionId]);

  const hasActiveFilters =
    searchText.trim().length > 0 || taskFilter !== 'all' || frameworkFilter !== 'all' || queueFilter !== 'all';
  const activeJobsCount = filteredJobs.filter((job) => activeStatusSet.has(job.status)).length;
  const completedJobsCount = filteredJobs.filter((job) => job.status === 'completed').length;
  const verificationNeededCount = filteredJobs.filter((job) => {
    const insight =
      jobExecutionInsights[job.id] ??
      deriveTrainingExecutionInsight({
        status: job.status,
        executionMode: job.execution_mode,
        artifactSummary:
          selectedJob?.id === job.id ? selectedArtifactSummary : null
      });
    return insight.reality !== 'real';
  }).length;
  const selectedJobPosition = selectedJob
    ? filteredJobs.findIndex((job) => job.id === selectedJob.id) + 1
    : 0;
  const selectedJobIndex = selectedJob ? filteredJobs.findIndex((job) => job.id === selectedJob.id) : -1;
  const selectedJobPositionLabel =
    selectedJob && selectedJobPosition > 0
      ? t('Queue position {current} / {total}', {
          current: selectedJobPosition,
          total: filteredJobs.length
        })
      : '';
  const resetFilters = useCallback(() => {
    setSearchText('');
    setTaskFilter('all');
    setFrameworkFilter('all');
    setQueueFilter('all');
  }, []);
  const openJobDrawer = useCallback((jobId: string) => {
    setSelectedJobId(jobId);
    setDetailDrawerOpen(true);
  }, []);
  const openBestVisibleJob = useCallback(() => {
    if (!firstActiveJob) {
      return;
    }
    openJobDrawer(firstActiveJob.id);
  }, [firstActiveJob, openJobDrawer]);
  const moveSelectedJob = useCallback(
    (delta: number) => {
      if (!selectedJob || filteredJobs.length === 0) {
        return;
      }
      const currentIndex = filteredJobs.findIndex((job) => job.id === selectedJob.id);
      if (currentIndex < 0) {
        return;
      }
      const nextIndex = currentIndex + delta;
      if (nextIndex < 0 || nextIndex >= filteredJobs.length) {
        return;
      }
      setSelectedJobId(filteredJobs[nextIndex].id);
      setDetailDrawerOpen(true);
    },
    [filteredJobs, selectedJob]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (isTypingField) {
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (!detailDrawerOpen || !selectedJob) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveSelectedJob(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveSelectedJob(1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setDetailDrawerOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [detailDrawerOpen, moveSelectedJob, selectedJob]);

  const tableColumns = useMemo<StatusTableColumn<TrainingJobRecord>[]>(
    () => [
      {
        key: 'status',
        header: t('Status'),
        width: '10%',
        cell: (job) => <StatusTag status={job.status}>{t(job.status)}</StatusTag>
      },
      {
        key: 'job',
        header: t('Job'),
        width: '22%',
        cell: (job) => (
          <div className="stack tight">
            <strong>{job.name}</strong>
            <small className="muted">
              {job.id} · {t('Last updated')}: {formatTimestamp(job.updated_at)}
            </small>
          </div>
        )
      },
      {
        key: 'task',
        header: t('Task / Framework'),
        width: '16%',
        cell: (job) => (
          <div className="stack tight">
            <Badge tone="neutral">{t(job.task_type)}</Badge>
            <small className="muted">
              {t(job.framework)} · {job.base_model}
            </small>
          </div>
        )
      },
      {
        key: 'snapshot',
        header: t('Dataset'),
        width: '16%',
        cell: (job) => (
          <div className="stack tight">
            <small className="muted">{job.dataset_id || '—'}</small>
            <small className="muted">{job.dataset_version_id || t('Version pending')}</small>
          </div>
        )
      },
      {
        key: 'execution',
        header: t('Evidence'),
        width: '16%',
        cell: (job) => {
          const insight =
            jobExecutionInsights[job.id] ??
            deriveTrainingExecutionInsight({
              status: job.status,
              executionMode: job.execution_mode
            });
          return (
            <div className="stack tight">
              <Badge tone={insight.reality === 'real' ? 'success' : 'warning'}>
                {describeRealityLabel(t, insight)}
              </Badge>
              <small className="muted">
                {describeExecutionTargetLabel(t, job.execution_target)} ·{' '}
                {describeExecutionModeLabel(t, job.execution_mode)}
              </small>
            </div>
          );
        }
      },
      {
        key: 'actions',
        header: t('Open'),
        width: '10%',
        cell: (job) => (
          <div className="workspace-record-actions">
            <ButtonLink
              to={`/training/jobs/${job.id}${detailQuerySuffix}`}
              variant="ghost"
              size="sm"
              onClick={(event) => event.stopPropagation()}
            >
              {t('Open')}
            </ButtonLink>
          </div>
        )
      }
    ],
    [detailQuerySuffix, jobExecutionInsights, t]
  );

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Training control')}
        title={t('Training Jobs')}
        description={t('Select one job to inspect details or create a new run.')}
        meta={
          <div className="row gap wrap align-center">
            <Badge tone="info">
              {t('Visible jobs')}: {filteredJobs.length}
            </Badge>
            <Badge tone="success">
              {t('Active')}: {activeJobsCount}
            </Badge>
            <Badge tone="neutral">
              {t('Completed')}: {completedJobsCount}
            </Badge>
            {verificationNeededCount > 0 ? (
              <Badge tone="warning">
                {t('Needs verification')}: {verificationNeededCount}
              </Badge>
            ) : null}
          </div>
        }
        primaryAction={{
          label: t('Create Training Job'),
          onClick: () => {
            navigate(scopedCreatePath);
          }
        }}
        secondaryActions={
          <div className="row gap wrap align-center">
            {firstActiveJob ? (
              <Button type="button" variant="ghost" size="sm" onClick={openBestVisibleJob}>
                {t('Open active job')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                load('manual').catch(() => {
                  // no-op
                });
              }}
              disabled={loading || refreshing}
            >
              {loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
          </div>
        }
      />

      {error ? <InlineAlert tone="danger" title={t('Load Failed')} description={error} /> : null}

      {hasScopeFilter ? (
        <InlineAlert
          tone="info"
          title={t('Current scope')}
          description={scopeLabel}
          actions={
            <div className="row gap wrap">
              {scopedDatasetId ? (
                <ButtonLink to={buildScopedDatasetPath(scopedDatasetId, scopedVersionId)} variant="ghost" size="sm">
                  {t('Open dataset')}
                </ButtonLink>
              ) : null}
              <ButtonLink to="/training/jobs" variant="secondary" size="sm">
                {t('Clear scope')}
              </ButtonLink>
            </div>
          }
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <FilterToolbar
            filters={
              <>
                <label className="stack tight">
                  <small className="muted">{t('Search')}</small>
                  <Input
                    ref={searchInputRef}
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder={t('Search by job name, base model, or ID')}
                  />
                  <small className="muted">{t('Press / to focus search')}</small>
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Queue')}</small>
                  <Select
                    value={queueFilter}
                    onChange={(event) => setQueueFilter(event.target.value as QueueFilter)}
                  >
                    <option value="all">{t('All')}</option>
                    <option value="active">{t('Active')}</option>
                    <option value="terminal">{t('Completed')}</option>
                  </Select>
                </label>
              </>
            }
            actions={
              <>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t('Clear Filters')}
                  </Button>
                ) : null}
              </>
            }
            summary={null}
          />
        }
        main={
          <div className="workspace-main-stack">
            <AdvancedSection
              title={t('More filters')}
              description={t('Collapsed by default for progressive disclosure.')}
            >
              <div className="row gap wrap">
                <label className="stack tight">
                  <small className="muted">{t('Task')}</small>
                  <Select
                    value={taskFilter}
                    onChange={(event) =>
                      setTaskFilter(
                        event.target.value as
                          | 'all'
                          | 'ocr'
                          | 'detection'
                          | 'classification'
                          | 'segmentation'
                          | 'obb'
                      )
                    }
                  >
                    <option value="all">{t('all')}</option>
                    <option value="ocr">{t('ocr')}</option>
                    <option value="detection">{t('detection')}</option>
                    <option value="classification">{t('classification')}</option>
                    <option value="segmentation">{t('segmentation')}</option>
                    <option value="obb">{t('obb')}</option>
                  </Select>
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Framework')}</small>
                  <Select
                    value={frameworkFilter}
                    onChange={(event) =>
                      setFrameworkFilter(event.target.value as 'all' | 'yolo' | 'paddleocr' | 'doctr')
                    }
                  >
                    <option value="all">{t('all')}</option>
                    <option value="yolo">{t('yolo')}</option>
                    <option value="paddleocr">{t('paddleocr')}</option>
                    <option value="doctr">{t('doctr')}</option>
                  </Select>
                </label>
              </div>
            </AdvancedSection>
            <SectionCard
              title={t('Job Queue')}
              description={t('Scan the list, then open one row for details.')}
            >
              {loading ? (
                <StateBlock
                  variant="loading"
                  title={t('Loading jobs')}
                  description={t('Loading training jobs.')}
                />
              ) : filteredJobs.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={hasActiveFilters ? t('No matches') : t('No training jobs yet')}
                  description={
                    hasActiveFilters
                      ? t('Clear filters or switch scope.')
                      : t('Create the first training job.')
                  }
                  extra={
                    <div className="row gap wrap">
                      <ButtonLink to={scopedCreatePath} variant="secondary" size="sm">
                        {t('Create Training Job')}
                      </ButtonLink>
                      {hasActiveFilters ? (
                        <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                          {t('Clear Filters')}
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              ) : (
                <StatusTable
                  columns={tableColumns}
                  rows={filteredJobs}
                  getRowKey={(job) => job.id}
                  onRowClick={(job) => openJobDrawer(job.id)}
                  rowClassName={(job) =>
                    selectedJobId === job.id && detailDrawerOpen ? 'selected' : undefined
                  }
                  emptyTitle={t('No jobs')}
                  emptyDescription={t('No jobs are visible in the current view.')}
                />
              )}
            </SectionCard>
          </div>
        }
        side={
          <SectionCard
            title={t('Current task')}
            description={
              filteredJobs.length === 0
                ? hasActiveFilters
                  ? t('Clear filters or broaden the scope.')
                  : t('Create a job to start tracking evidence.')
                : selectedJob
                  ? selectedJobPositionLabel || t('Review status and evidence.')
                  : firstActiveJob
                    ? t('Open the active job first.')
                    : t('Select a row to inspect it.')
            }
            actions={
              <div className="row gap wrap">
                {selectedJob ? (
                  <>
                    {selectedJob.dataset_id ? (
                      <ButtonLink
                        to={buildScopedDatasetPath(selectedJob.dataset_id, selectedJob.dataset_version_id)}
                        variant="ghost"
                        size="sm"
                      >
                        {t('Open dataset')}
                      </ButtonLink>
                    ) : null}
                    <ButtonLink
                      to={`/training/jobs/${selectedJob.id}${detailQuerySuffix}`}
                      variant="secondary"
                      size="sm"
                    >
                      {t('View full detail')}
                    </ButtonLink>
                  </>
                ) : filteredJobs.length === 0 ? (
                  hasActiveFilters ? (
                    <Button type="button" variant="secondary" size="sm" onClick={resetFilters}>
                      {t('Clear Filters')}
                    </Button>
                  ) : (
                    <ButtonLink to={scopedCreatePath} variant="secondary" size="sm">
                      {t('Create Training Job')}
                    </ButtonLink>
                  )
                ) : null}
              </div>
            }
          >
            {selectedJob ? (
              <TrainingJobSummaryBlock
                t={t}
                job={selectedJob}
                insight={selectedExecutionInsight}
                realityLabel={selectedExecutionRealityLabel}
                variant="glance"
              />
            ) : firstActiveJob ? (
              <div className="stack tight">
                <small className="muted">{t('Open the active job first.')}</small>
                <Button type="button" variant="secondary" size="sm" onClick={openBestVisibleJob}>
                  {t('Open active job')}
                </Button>
              </div>
            ) : (
              <small className="muted">
                {hasActiveFilters ? t('Filters are hiding every row right now.') : t('Select a row to inspect it.')}
              </small>
            )}
          </SectionCard>
        }
      />

      <DetailDrawer
        open={detailDrawerOpen && Boolean(selectedJob)}
        onClose={() => setDetailDrawerOpen(false)}
        title={selectedJob ? selectedJob.name : t('Job detail')}
        description={t('Execution summary')}
        actions={
          selectedJob ? (
            <div className="row gap wrap align-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => moveSelectedJob(-1)}
                disabled={selectedJobIndex <= 0}
              >
                {t('Previous')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => moveSelectedJob(1)}
                disabled={selectedJobIndex >= filteredJobs.length - 1}
              >
                {t('Next')}
              </Button>
              <ButtonLink to={`/training/jobs/${selectedJob.id}${detailQuerySuffix}`} variant="secondary" size="sm">
                {t('View full detail')}
              </ButtonLink>
            </div>
          ) : null
        }
      >
        {selectedJob ? (
          <>
            <small className="muted">{t('Queue shortcuts: Previous / next · Esc close')}</small>
            <TrainingJobSummaryBlock
              t={t}
              job={selectedJob}
              insight={selectedExecutionInsight}
              realityLabel={selectedExecutionRealityLabel}
              variant="full"
            />
            {selectedArtifactSummary ? (
              <Panel className="stack tight" tone="soft">
                <div className="row gap wrap">
                  <Badge tone="neutral">
                    {t('Runner')}: {selectedArtifactSummary.runner || t('Pending')}
                  </Badge>
                  {selectedArtifactSummary.mode ? (
                    <Badge tone="info">
                      {t('Mode:')} {selectedArtifactSummary.mode}
                    </Badge>
                  ) : null}
                  {selectedArtifactSummary.training_performed !== null ? (
                    <Badge tone={selectedArtifactSummary.training_performed ? 'success' : 'warning'}>
                      {t('Training')}: {selectedArtifactSummary.training_performed ? t('Yes') : t('No')}
                    </Badge>
                  ) : null}
                  {selectedArtifactSummary.sampled_items !== null ? (
                    <Badge tone="info">
                      {t('Sampled items')}: {selectedArtifactSummary.sampled_items}
                    </Badge>
                  ) : null}
                </div>
                {selectedArtifactSummary.generated_at ? (
                  <small className="muted">
                    {t('Artifact generated at')}:{' '}
                    {formatCompactTimestamp(selectedArtifactSummary.generated_at, t('n/a'))}
                  </small>
                ) : null}
                {selectedArtifactSummary.primary_model_path ? (
                  <small className="muted">
                    {t('Primary model path')}: {selectedArtifactSummary.primary_model_path}
                  </small>
                ) : null}
                {selectedArtifactSummary.metrics_keys.length > 0 ? (
                  <div className="row gap wrap">
                    {selectedArtifactSummary.metrics_keys.map((metricKey) => (
                      <Badge key={metricKey} tone="neutral">
                        {metricKey}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {selectedArtifactSummary.fallback_reason ? (
                  <small className="muted">
                    {t('Fallback reason')}: {describeFallbackReasonLabel(t, selectedArtifactSummary.fallback_reason)}
                  </small>
                ) : null}
              </Panel>
            ) : selectedExecutionInsight?.showWarning ? (
              <InlineAlert
                tone={selectedExecutionInsight.reality === 'simulated' ? 'danger' : 'warning'}
                title={t('Needs verification')}
                description={
                  selectedExecutionInsight.fallbackReason
                    ? t(
                        'The job does not have complete real execution evidence. Review the detail first. Reason: {reason}',
                        { reason: describeFallbackReasonLabel(t, selectedExecutionInsight.fallbackReason) }
                      )
                    : t('The job does not have complete real execution evidence. Review the detail first.')
                }
              />
            ) : null}
          </>
        ) : null}
      </DetailDrawer>
    </WorkspacePage>
  );
}
