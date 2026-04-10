import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  TrainingArtifactSummary,
  TrainingJobRecord,
  TrainingJobStatus
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Input, Select } from '../components/ui/Field';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import {
  deriveTrainingExecutionInsight,
  type TrainingExecutionInsight
} from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

const activeStatusSet = new Set<TrainingJobStatus>(['queued', 'preparing', 'running', 'evaluating']);
const terminalStatusSet = new Set<TrainingJobStatus>(['completed', 'failed', 'cancelled']);
const backgroundRefreshIntervalMs = 5000;
const liveJobsVirtualizationThreshold = 12;
const terminalJobsVirtualizationThreshold = 10;
const liveJobsVirtualRowHeight = 130;
const liveJobsVirtualViewportHeight = 460;
const terminalJobsVirtualRowHeight = 122;
const terminalJobsVirtualViewportHeight = 420;

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

export default function TrainingJobsPage() {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>(
    'all'
  );
  const [frameworkFilter, setFrameworkFilter] = useState<'all' | 'yolo' | 'paddleocr' | 'doctr'>('all');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [selectedJobId, setSelectedJobId] = useState('');
  const [selectedArtifactSummary, setSelectedArtifactSummary] = useState<TrainingArtifactSummary | null>(null);
  const [selectedDetailLoading, setSelectedDetailLoading] = useState(false);
  const [jobExecutionInsights, setJobExecutionInsights] = useState<Record<string, TrainingExecutionInsight>>({});
  const [jobInsightsLoading, setJobInsightsLoading] = useState(false);
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
      setJobInsightsLoading(false);
      return;
    }

    let active = true;
    setJobInsightsLoading(true);

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
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setJobInsightsLoading(false);
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

  const liveJobs = useMemo(
    () => filteredJobs.filter((job) => activeStatusSet.has(job.status)),
    [filteredJobs]
  );
  const terminalJobs = useMemo(
    () => filteredJobs.filter((job) => terminalStatusSet.has(job.status)),
    [filteredJobs]
  );

  useEffect(() => {
    if (!filteredJobs.length) {
      setSelectedJobId('');
      return;
    }
    if (!selectedJobId || !filteredJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(filteredJobs[0].id);
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
      return t('Template execution');
    }
    if (selectedExecutionInsight.reality === 'simulated') {
      return t('Simulated execution');
    }
    return t('Unknown execution');
  }, [selectedExecutionInsight, t]);
  const selectedJobKey = selectedJob?.id ?? '';
  const selectedJobUpdatedAt = selectedJob?.updated_at ?? '';

  useEffect(() => {
    if (!selectedJobKey) {
      setSelectedArtifactSummary(null);
      setSelectedDetailLoading(false);
      return;
    }

    let cancelled = false;
    setSelectedDetailLoading(true);
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
        if (!cancelled) {
          setSelectedDetailLoading(false);
        }
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

  const summary = useMemo(
    () => ({
      running: scopedJobs.filter((job) => activeStatusSet.has(job.status)).length,
      completed: scopedJobs.filter((job) => job.status === 'completed').length,
      failed: scopedJobs.filter((job) => ['failed', 'cancelled'].includes(job.status)).length
    }),
    [scopedJobs]
  );

  const workerLiveJobs = liveJobs.filter((job) => job.execution_target === 'worker').length;
  const controlPlaneLiveJobs = liveJobs.filter((job) => job.execution_target === 'control_plane').length;
  const shouldVirtualizeLiveJobs = liveJobs.length > liveJobsVirtualizationThreshold;
  const shouldVirtualizeTerminalJobs = terminalJobs.length > terminalJobsVirtualizationThreshold;

  const describeExecutionTarget = (target: TrainingJobRecord['execution_target']) =>
    target === 'worker' ? t('Worker execution') : t('Local execution');

  const renderJobRecord = (
    job: TrainingJobRecord,
    as: 'div' | 'li',
    compact = false
  ) => {
    const selected = selectedJobId === job.id;
    const snapshotReady = Boolean(job.dataset_version_id);
    const executionInsight =
      jobExecutionInsights[job.id] ??
      deriveTrainingExecutionInsight({
        status: job.status,
        executionMode: job.execution_mode
      });
    return (
      <Panel
        as={as}
        key={job.id}
        className={`workspace-record-item training-job-record${compact ? ' compact' : ''}${as === 'div' ? ' virtualized' : ''}${
          selected ? ' selected' : ''
        }`}
        tone={selected ? 'accent' : 'soft'}
      >
        <button
          type="button"
          className="dataset-inventory-record-btn"
          onClick={() => setSelectedJobId(job.id)}
        >
          <div className="workspace-record-item-top">
            <div className="workspace-record-summary stack tight">
              <strong>{job.name}</strong>
              <small className="muted">
                {t(job.task_type)} · {t(job.framework)} · {t('Last updated')}: {formatTimestamp(job.updated_at)}
              </small>
            </div>
            <div className="workspace-record-actions">
              <StatusTag status={job.status}>{t(job.status)}</StatusTag>
            </div>
          </div>
          <div className="row gap wrap">
            <Badge tone="neutral">
              {t('Base model')}: {job.base_model}
            </Badge>
            <Badge tone="neutral">{describeExecutionTarget(job.execution_target)}</Badge>
            <Badge tone={executionInsight.reality === 'real' ? 'neutral' : 'warning'}>
              {t('Execution mode')}: {t(job.execution_mode)}
            </Badge>
            <Badge tone={snapshotReady ? 'info' : 'warning'}>
              {snapshotReady ? t('Version bound') : t('Version pending')}
            </Badge>
            <Badge tone={executionInsight.reality === 'real' ? 'success' : 'warning'}>
              {t('Authenticity')}:{' '}
              {executionInsight.reality === 'real'
                ? t('Real')
                : executionInsight.reality === 'template'
                  ? t('Template/Fallback')
                  : executionInsight.reality === 'simulated'
                    ? t('Simulated')
                    : t('Unknown')}
            </Badge>
            {executionInsight.showWarning ? <Badge tone="warning">{t('Needs runtime verification')}</Badge> : null}
          </div>
          {!compact ? (
            <small className="muted line-clamp-2">
              {job.log_excerpt || t('Logs will become visible after execution starts.')}
            </small>
          ) : null}
        </button>
      </Panel>
    );
  };

  const hasActiveFilters =
    searchText.trim().length > 0 || taskFilter !== 'all' || frameworkFilter !== 'all' || queueFilter !== 'all';

  const resetFilters = () => {
    setSearchText('');
    setTaskFilter('all');
    setFrameworkFilter('all');
    setQueueFilter('all');
  };

  return (
    <WorkspacePage>
      <WorkspaceHero
        eyebrow={t('Training Control')}
        title={t('Training Jobs')}
        description={t('Track job stages, execution targets, and follow-up actions from one control workbench.')}
        stats={[
          { label: t('Active runs'), value: summary.running },
          { label: t('Recent completions'), value: summary.completed },
          { label: t('Failure watch'), value: summary.failed }
        ]}
      />

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Running'),
            description: t('Queued, running, and evaluating jobs currently consuming capacity.'),
            value: summary.running
          },
          {
            title: t('Completed'),
            description: t('Finished runs ready for version registration and comparison.'),
            value: summary.completed
          },
          {
            title: t('Failed/Cancelled'),
            description: t('Runs needing retry or incident review.'),
            value: summary.failed,
            tone: 'attention'
          },
          {
            title: t('Scoped total'),
            description: t('All jobs in current dataset/version scope.'),
            value: scopedJobs.length
          }
        ]}
      />

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Queue Controls')}</h3>
                <small className="muted">
                  {t('Narrow the queue, switch job lanes, and refresh live execution from one stable toolbar.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <div className="workspace-segmented-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant={queueFilter === 'all' ? 'secondary' : 'ghost'}
                    onClick={() => setQueueFilter('all')}
                  >
                    {t('All')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={queueFilter === 'active' ? 'secondary' : 'ghost'}
                    onClick={() => setQueueFilter('active')}
                  >
                    {t('Active')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={queueFilter === 'terminal' ? 'secondary' : 'ghost'}
                    onClick={() => setQueueFilter('terminal')}
                  >
                    {t('Terminal')}
                  </Button>
                </div>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t('Clear filters')}
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
            </div>

            <div className="workspace-filter-grid">
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
            </div>

            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="info">{t('Showing {count} jobs.', { count: filteredJobs.length })}</Badge>
                {hasScopeFilter && scopedDatasetId ? <Badge tone="info">{t('dataset')}: {scopedDatasetId}</Badge> : null}
                {hasScopeFilter && scopedVersionId ? <Badge tone="info">{t('version')}: {scopedVersionId}</Badge> : null}
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Live Queue')}
                description={t('Jobs currently progressing through queue, run, or evaluation stages.')}
              />
              {loading ? (
                <StateBlock variant="loading" title={t('Loading Jobs')} description={t('Fetching training jobs.')} />
              ) : liveJobs.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No active jobs right now.')}
                  description={t('Queued, running, or evaluating jobs will appear here.')}
                />
              ) : shouldVirtualizeLiveJobs ? (
                <VirtualList
                  items={liveJobs}
                  itemHeight={liveJobsVirtualRowHeight}
                  height={liveJobsVirtualViewportHeight}
                  itemKey={(job) => job.id}
                  listClassName="workspace-record-list"
                  rowClassName="workspace-record-row"
                  ariaLabel={t('Live queue')}
                  renderItem={(job) => renderJobRecord(job, 'div')}
                />
              ) : (
                <ul className="workspace-record-list">{liveJobs.map((job) => renderJobRecord(job, 'li'))}</ul>
              )}
            </Card>

            <Card as="article">
              <WorkspaceSectionHeader
                title={t('Terminal Queue')}
                description={t('Completed, failed, and cancelled jobs kept for retry and analysis.')}
              />
              {loading ? (
                <StateBlock variant="loading" title={t('Loading Jobs')} description={t('Preparing terminal queue.')} />
              ) : terminalJobs.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No terminal jobs in this view.')}
                  description={t('Finished jobs will appear here after execution ends.')}
                />
              ) : shouldVirtualizeTerminalJobs ? (
                <VirtualList
                  items={terminalJobs}
                  itemHeight={terminalJobsVirtualRowHeight}
                  height={terminalJobsVirtualViewportHeight}
                  itemKey={(job) => job.id}
                  listClassName="workspace-record-list compact"
                  rowClassName="workspace-record-row"
                  ariaLabel={t('Terminal queue')}
                  renderItem={(job) => renderJobRecord(job, 'div', true)}
                />
              ) : (
                <ul className="workspace-record-list compact">
                  {terminalJobs.map((job) => renderJobRecord(job, 'li', true))}
                </ul>
              )}
            </Card>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Selected Job')}
                description={t('Inspector lane for current training job selection.')}
              />
              {!selectedJob ? (
                <StateBlock
                  variant="empty"
                  title={t('No selection')}
                  description={t('Select one job in the queue to inspect details and follow-up actions.')}
                />
              ) : (
                <>
                  <Panel as="section" className="stack tight" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{selectedJob.name}</strong>
                      <StatusTag status={selectedJob.status}>{t(selectedJob.status)}</StatusTag>
                    </div>
                    <div className="row gap wrap">
                      <Badge tone="neutral">{t(selectedJob.task_type)}</Badge>
                      <Badge tone="info">{t(selectedJob.framework)}</Badge>
                      <Badge tone="neutral">{describeExecutionTarget(selectedJob.execution_target)}</Badge>
                      <Badge tone={selectedExecutionInsight?.reality === 'real' ? 'success' : 'warning'}>
                        {t('Result authenticity')}:{' '}
                        {selectedExecutionInsight ? selectedExecutionRealityLabel : t('Unknown execution')}
                      </Badge>
                    </div>
                    <small className="muted">
                      {t('Last updated')}: {formatTimestamp(selectedJob.updated_at)}
                    </small>
                    {selectedJob.log_excerpt ? (
                      <small className="muted line-clamp-3">{selectedJob.log_excerpt}</small>
                    ) : (
                      <small className="muted">{t('Logs will become visible after execution starts.')}</small>
                    )}
                  </Panel>
                  <div className="workspace-keyline-list">
                    <div className="workspace-keyline-item">
                      <span>{t('Base model')}</span>
                      <strong>{selectedJob.base_model}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Execution')}</span>
                      <strong>{describeExecutionTarget(selectedJob.execution_target)}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Dataset')}</span>
                      <small>{selectedJob.dataset_id || '—'}</small>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Version')}</span>
                      <small>{selectedJob.dataset_version_id || '—'}</small>
                    </div>
                  </div>
                  {selectedDetailLoading ? (
                    <small className="muted">{t('Refreshing execution summary...')}</small>
                  ) : null}
                  {jobInsightsLoading && selectedJob.execution_mode === 'local_command' ? (
                    <small className="muted">{t('Refreshing authenticity checks...')}</small>
                  ) : null}
                  {selectedExecutionInsight?.showWarning ? (
                    <StateBlock
                      variant={selectedExecutionInsight.reality === 'simulated' ? 'error' : 'empty'}
                      title={t('Template/Simulated Training Result')}
                      description={
                        selectedExecutionInsight.fallbackReason
                          ? t(
                              'Selected job ended without fully real training evidence. Review detail before model registration. Fallback reason from runner: {reason}',
                              { reason: selectedExecutionInsight.fallbackReason }
                            )
                          : t('Selected job ended without fully real training evidence. Review detail before model registration.')
                      }
                    />
                  ) : null}
                  <div className="workspace-action-cluster">
                    <ButtonLink to={`/training/jobs/${selectedJob.id}${detailQuerySuffix}`} variant="secondary" size="sm" block>
                      {t('Open Job Detail')}
                    </ButtonLink>
                    {selectedJob.dataset_id ? (
                      <ButtonLink to={`/datasets/${selectedJob.dataset_id}`} variant="ghost" size="sm" block>
                        {t('Open Dataset')}
                      </ButtonLink>
                    ) : null}
                    {selectedJob.dataset_id ? (
                      <ButtonLink
                        to={`/inference/validate?dataset=${encodeURIComponent(selectedJob.dataset_id)}${
                          selectedJob.dataset_version_id
                            ? `&version=${encodeURIComponent(selectedJob.dataset_version_id)}`
                            : ''
                        }`}
                        variant="ghost"
                        size="sm"
                        block
                      >
                        {t('Validate Inference')}
                      </ButtonLink>
                    ) : null}
                  </div>
                </>
              )}
            </Card>

            <Card as="article" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Launch next experiment')}
                description={t('Keep creation and queue monitoring in one place.')}
              />
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Active jobs')}</span>
                  <strong>{summary.running}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Worker execution')}</span>
                  <strong>{workerLiveJobs}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Local execution')}</span>
                  <strong>{controlPlaneLiveJobs}</strong>
                </div>
              </div>
              <div className="workspace-action-cluster">
                <ButtonLink to={scopedCreatePath} block>
                  {t('Create Training Job')}
                </ButtonLink>
                {hasScopeFilter ? (
                  <ButtonLink to="/training/jobs" variant="ghost" size="sm" block>
                    {t('Clear scope')}
                  </ButtonLink>
                ) : null}
              </div>
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
