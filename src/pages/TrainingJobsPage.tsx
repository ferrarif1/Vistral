import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TrainingJobRecord, TrainingJobStatus } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
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
const liveJobsVirtualViewportHeight = 620;
const terminalJobsVirtualRowHeight = 122;
const terminalJobsVirtualViewportHeight = 440;

type LoadMode = 'initial' | 'manual' | 'background';

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

  const liveJobs = useMemo(
    () => scopedJobs.filter((job) => activeStatusSet.has(job.status)),
    [scopedJobs]
  );
  const recentTerminalJobs = useMemo(
    () => scopedJobs.filter((job) => terminalStatusSet.has(job.status)),
    [scopedJobs]
  );
  const shouldVirtualizeLiveJobs = liveJobs.length > liveJobsVirtualizationThreshold;
  const shouldVirtualizeTerminalJobs = recentTerminalJobs.length > terminalJobsVirtualizationThreshold;
  const workerLiveJobs = liveJobs.filter((job) => job.execution_target === 'worker').length;
  const controlPlaneLiveJobs = liveJobs.filter((job) => job.execution_target === 'control_plane').length;
  const describeExecutionTarget = (target: TrainingJobRecord['execution_target']) =>
    target === 'worker' ? t('Worker execution') : t('Local execution');

  const renderLiveJobRecord = (job: TrainingJobRecord, as: 'div' | 'li' = 'li') => {
    const snapshotReady = Boolean(job.dataset_version_id);

    return (
      <Panel
        as={as}
        key={job.id}
        className={`workspace-record-item${as === 'div' ? ' virtualized' : ''}`}
        tone="soft"
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
            <ButtonLink to={`/training/jobs/${job.id}${detailQuerySuffix}`} variant="ghost" size="sm">
              {t('Open Detail')}
            </ButtonLink>
          </div>
        </div>
        <div className="row gap wrap">
          <Badge tone="neutral">
            {t('Base model')}: {job.base_model}
          </Badge>
          <Badge tone="neutral">{describeExecutionTarget(job.execution_target)}</Badge>
          <Badge tone={snapshotReady ? 'info' : 'warning'}>
            {snapshotReady ? t('Version bound') : t('Version pending')}
          </Badge>
        </div>
        <small className="muted line-clamp-2">
          {job.log_excerpt || t('Logs will become visible after execution starts.')}
        </small>
      </Panel>
    );
  };

  const renderTerminalJobRecord = (job: TrainingJobRecord, as: 'div' | 'li' = 'li') => (
    <Panel
      as={as}
      key={job.id}
      className={`workspace-record-item compact${as === 'div' ? ' virtualized' : ''}`}
      tone="soft"
    >
      <div className="workspace-record-item-top">
        <div className="workspace-record-summary stack tight">
          <strong>{job.name}</strong>
          <small className="muted">
            {t(job.framework)} · {t(job.status)} · {formatTimestamp(job.updated_at)}
          </small>
        </div>
        <div className="workspace-record-actions">
          <StatusTag status={job.status}>{t(job.status)}</StatusTag>
          <ButtonLink to={`/training/jobs/${job.id}${detailQuerySuffix}`} variant="ghost" size="sm">
            {t('Open Detail')}
          </ButtonLink>
        </div>
      </div>
    </Panel>
  );

  return (
    <WorkspacePage>
      <WorkspaceHero
        eyebrow={t('Training Control')}
        title={t('Training Jobs')}
        description={t('Track job states, logs, and metrics for OCR and detection tasks.')}
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
            description: t('Queued, running, or evaluating jobs are treated as active work.'),
            value: summary.running
          },
          {
            title: t('Completed'),
            description: t('Finished runs stay visible for version registration and follow-up review.'),
            value: summary.completed
          },
          {
            title: t('Failed/Cancelled'),
            description: t('Problem runs remain easy to revisit from the detail page.'),
            value: summary.failed,
            tone: 'attention'
          },
          {
            title: t('Total'),
            description: t('All jobs in current scoped view.'),
            value: scopedJobs.length
          }
        ]}
      />

      {hasScopeFilter ? (
        <StateBlock
          variant="success"
          title={t('Version-scoped job view active')}
          description={t('Showing jobs filtered by dataset/version context from dataset detail.')}
          extra={
            <div className="row gap wrap">
              {scopedDatasetId ? <Badge tone="info">{t('dataset')}: {scopedDatasetId}</Badge> : null}
              {scopedVersionId ? <Badge tone="info">{t('version')}: {scopedVersionId}</Badge> : null}
              <ButtonLink variant="ghost" size="sm" to="/training/jobs">
                {t('Clear scope')}
              </ButtonLink>
            </div>
          }
        />
      ) : null}

      <WorkspaceSplit
        main={
          <Card as="article">
            <WorkspaceSectionHeader
              title={t('Live queue')}
              description={t('Jobs that are still moving through preparation, runtime, or evaluation.')}
              actions={
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

          {loading ? (
            <StateBlock variant="loading" title={t('Loading Jobs')} description={t('Fetching training jobs.')} />
          ) : liveJobs.length === 0 ? (
            <StateBlock variant="empty" title={t('No active jobs right now.')} description={t('Queued, running, or evaluating jobs will appear here.')} />
          ) : shouldVirtualizeLiveJobs ? (
            <VirtualList
              items={liveJobs}
              itemHeight={liveJobsVirtualRowHeight}
              height={liveJobsVirtualViewportHeight}
                itemKey={(job) => job.id}
                listClassName="workspace-record-list"
                rowClassName="workspace-record-row"
                ariaLabel={t('Live queue')}
                renderItem={(job) => renderLiveJobRecord(job, 'div')}
              />
            ) : (
            <ul className="workspace-record-list">{liveJobs.map((job) => renderLiveJobRecord(job))}</ul>
          )}
          </Card>
        }
        side={
          <>
            <Card as="article">
            <div className="stack tight">
              <h3>{t('Launch next experiment')}</h3>
              <small className="muted">
                {t('Open the training wizard when you are ready to launch another experiment.')}
              </small>
            </div>
            <strong className="workspace-side-metric">{summary.running}</strong>
            <small className="muted">
              {t('Worker execution')}: {workerLiveJobs} · {t('Local execution')}: {controlPlaneLiveJobs}
            </small>
            <ButtonLink to={scopedCreatePath}>
              {t('Create Training Job')}
            </ButtonLink>
            </Card>

            <Card as="article">
            <div className="stack tight">
              <h3>{t('Recent terminal runs')}</h3>
              <small className="muted">
                {t('Latest completed, failed, or cancelled runs stay visible here for quick follow-up.')}
              </small>
            </div>

            {recentTerminalJobs.length === 0 ? (
              <StateBlock variant="empty" title={t('No terminal jobs yet.')} description={t('Finished jobs will appear here after execution ends.')} />
            ) : shouldVirtualizeTerminalJobs ? (
              <VirtualList
                items={recentTerminalJobs}
                itemHeight={terminalJobsVirtualRowHeight}
                height={terminalJobsVirtualViewportHeight}
                itemKey={(job) => job.id}
                listClassName="workspace-record-list compact"
                rowClassName="workspace-record-row"
                ariaLabel={t('Recent terminal runs')}
                renderItem={(job) => renderTerminalJobRecord(job, 'div')}
              />
            ) : (
              <ul className="workspace-record-list compact">
                {recentTerminalJobs.map((job) => renderTerminalJobRecord(job))}
              </ul>
            )}
            </Card>
          </>
        }
      />
    </WorkspacePage>
  );
}
