import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  TrainingArtifactSummary,
  TrainingExecutionMode,
  TrainingJobRecord,
  TrainingJobStatus
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
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
    return t('Real');
  }
  if (insight.reality === 'template') {
    return t('Degraded output');
  }
  if (insight.reality === 'simulated') {
    return t('Needs verification');
  }
  return t('Unknown');
};

const describeExecutionModeLabel = (
  t: (source: string, vars?: Record<string, string | number>) => string,
  mode: TrainingExecutionMode
) => {
  if (mode === 'local_command') {
    return t('Local command');
  }
  if (mode === 'simulated') {
    return t('Degraded execution');
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

export default function TrainingJobsPage() {
  const { t } = useI18n();
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

  const selectedExecutionRealityLabel = useMemo(() => {
    if (!selectedExecutionInsight) {
      return '';
    }
    if (selectedExecutionInsight.reality === 'real') {
      return t('Real execution');
    }
    if (selectedExecutionInsight.reality === 'template') {
      return t('Degraded execution');
    }
    if (selectedExecutionInsight.reality === 'simulated') {
      return t('Degraded execution');
    }
    return t('Unknown execution');
  }, [selectedExecutionInsight, t]);

  const selectedJobKey = selectedJob?.id ?? '';
  const selectedJobUpdatedAt = selectedJob?.updated_at ?? '';

  useEffect(() => {
    if (!selectedJobKey) {
      setSelectedArtifactSummary(null);
      return;
    }

    let cancelled = false;

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
      })
      .finally(() => {
      });

    return () => {
      cancelled = true;
    };
  }, [selectedJobKey, selectedJobUpdatedAt]);

  const hasScopeFilter = Boolean(scopedDatasetId || scopedVersionId);
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
  const needsVerificationCount = filteredJobs.filter((job) => {
    const insight =
      jobExecutionInsights[job.id] ??
      deriveTrainingExecutionInsight({
        status: job.status,
        executionMode: job.execution_mode
      });
    return insight.reality !== 'real';
  }).length;

  const resetFilters = () => {
    setSearchText('');
    setTaskFilter('all');
    setFrameworkFilter('all');
    setQueueFilter('all');
  };

  const openJobDrawer = (jobId: string) => {
    setSelectedJobId(jobId);
    setDetailDrawerOpen(true);
  };

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
        width: '12%',
        cell: (job) => (
          <div className="stack tight">
            <Badge tone="neutral">{t(job.task_type)}</Badge>
            <small className="muted">{t(job.framework)}</small>
          </div>
        )
      },
      {
        key: 'snapshot',
        header: t('Dataset snapshot'),
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
        header: t('Execution'),
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
        key: 'base_model',
        header: t('Base model'),
        width: '14%',
        cell: (job) => <small className="muted">{job.base_model}</small>
      },
      {
        key: 'actions',
        header: t('Actions'),
        width: '10%',
        cell: (job) => (
          <div className="workspace-record-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                openJobDrawer(job.id);
              }}
            >
              {t('View')}
            </Button>
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
        description={t('Browse and compare training runs from one queue-first page. Open a run only when you need deeper evidence or follow-up actions.')}
        primaryAction={{
          label: t('Create Training Job'),
          onClick: () => {
            window.location.assign(scopedCreatePath);
          }
        }}
        secondaryActions={
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
        }
      />

      {error ? <InlineAlert tone="danger" title={t('Load Failed')} description={error} /> : null}

      <WorkspaceWorkbench
        toolbar={
          <FilterToolbar
            filters={
              <>
                <label className="stack tight">
                  <small className="muted">{t('Search')}</small>
                  <Input
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder={t('Search by job name, base model, or id')}
                  />
                </label>
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
                <label className="stack tight">
                  <small className="muted">{t('Queue')}</small>
                  <Select
                    value={queueFilter}
                    onChange={(event) => setQueueFilter(event.target.value as QueueFilter)}
                  >
                    <option value="all">{t('All')}</option>
                    <option value="active">{t('Active')}</option>
                    <option value="terminal">{t('Terminal')}</option>
                  </Select>
                </label>
              </>
            }
            actions={
              <>
                <div className="row gap wrap align-center">
                  <Badge tone="neutral">{t('Visible')}: {filteredJobs.length}</Badge>
                  <Badge tone={needsVerificationCount > 0 ? 'warning' : 'success'}>
                    {t('Needs verification')}: {needsVerificationCount}
                  </Badge>
                </div>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t('Clear filters')}
                  </Button>
                ) : null}
              </>
            }
          />
        }
        main={
          <div className="workspace-main-stack">
            <SectionCard
              title={t('Training queue')}
              description={t('Table-first queue view for comparing active and terminal jobs without turning the page into two separate workspaces.')}
            >
              {loading ? (
                <StateBlock
                  variant="loading"
                  title={t('Loading Jobs')}
                  description={t('Fetching training jobs.')}
                />
              ) : filteredJobs.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={hasActiveFilters ? t('No jobs match current filters.') : t('No training jobs yet.')}
                  description={
                    hasActiveFilters
                      ? t('Try clearing filters or changing queue scope to see more runs.')
                      : t('Create your first run to start monitoring training execution here.')
                  }
                  extra={
                    <div className="row gap wrap">
                      <ButtonLink to={scopedCreatePath} variant="secondary" size="sm">
                        {t('Create Training Job')}
                      </ButtonLink>
                      {hasActiveFilters ? (
                        <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                          {t('Clear filters')}
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
                  emptyDescription={t('No training jobs are available in this view.')}
                />
              )}
            </SectionCard>
          </div>
        }
      />

      <DetailDrawer
        open={detailDrawerOpen && Boolean(selectedJob)}
        onClose={() => setDetailDrawerOpen(false)}
        title={selectedJob ? selectedJob.name : t('Job detail')}
        description={t('Keep the list focused on comparison. Use this drawer for a short summary, then open the full detail page only when you need deeper evidence.')}
        actions={
          selectedJob ? (
            <>
              <ButtonLink
                to={`/training/jobs/${selectedJob.id}${detailQuerySuffix}`}
                variant="secondary"
                size="sm"
              >
                {t('Open Job Detail')}
              </ButtonLink>
            </>
          ) : null
        }
      >
        {selectedJob ? (
          <>
            <div className="row gap wrap">
              <StatusTag status={selectedJob.status}>{t(selectedJob.status)}</StatusTag>
              <Badge tone="neutral">{t(selectedJob.task_type)}</Badge>
              <Badge tone="info">{t(selectedJob.framework)}</Badge>
              <Badge tone={selectedExecutionInsight?.reality === 'real' ? 'success' : 'warning'}>
                {selectedExecutionInsight ? selectedExecutionRealityLabel : t('Unknown execution')}
              </Badge>
            </div>
            <DetailList
              items={[
                { label: t('Base model'), value: selectedJob.base_model },
                {
                  label: t('Execution'),
                  value: `${describeExecutionTargetLabel(t, selectedJob.execution_target)} · ${describeExecutionModeLabel(
                    t,
                    selectedJob.execution_mode
                  )}`
                },
                { label: t('Dataset'), value: selectedJob.dataset_id || '—' },
                { label: t('Version'), value: selectedJob.dataset_version_id || '—' },
                { label: t('Last updated'), value: formatTimestamp(selectedJob.updated_at) }
              ]}
            />
            <small className="muted">
              {t('Open the full detail page for execution evidence, logs, and metrics.')}
            </small>
            {selectedExecutionInsight?.showWarning ? (
              <InlineAlert
                tone={selectedExecutionInsight.reality === 'simulated' ? 'danger' : 'warning'}
                title={t('Training output needs verification')}
                description={
                  selectedExecutionInsight.fallbackReason
                    ? t(
                        'Selected job finished without fully verified real training evidence. Review details before model registration. Reason: {reason}',
                        { reason: describeFallbackReasonLabel(t, selectedExecutionInsight.fallbackReason) }
                      )
                    : t('Selected job finished without fully verified real training evidence. Review details before model registration.')
                }
              />
            ) : null}
          </>
        ) : null}
      </DetailDrawer>
    </WorkspacePage>
  );
}
