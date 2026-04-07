import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrainingJobRecord, TrainingJobStatus } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

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

const formatTimestamp = (iso: string): string => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  return new Date(value).toLocaleString();
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

export default function TrainingJobsPage() {
  const { t } = useI18n();
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

  const summary = useMemo(
    () => ({
      running: jobs.filter((job) => activeStatusSet.has(job.status)).length,
      completed: jobs.filter((job) => job.status === 'completed').length,
      failed: jobs.filter((job) => ['failed', 'cancelled'].includes(job.status)).length
    }),
    [jobs]
  );

  const liveJobs = useMemo(
    () => sortedJobs.filter((job) => activeStatusSet.has(job.status)),
    [sortedJobs]
  );
  const recentTerminalJobs = useMemo(
    () => sortedJobs.filter((job) => terminalStatusSet.has(job.status)),
    [sortedJobs]
  );
  const shouldVirtualizeLiveJobs = liveJobs.length > liveJobsVirtualizationThreshold;
  const shouldVirtualizeTerminalJobs = recentTerminalJobs.length > terminalJobsVirtualizationThreshold;

  return (
    <div className="workspace-overview-page stack">
      <Card className="workspace-overview-hero">
        <div className="workspace-overview-hero-grid">
          <div className="workspace-overview-copy stack">
            <small className="workspace-eyebrow">{t('Training Control')}</small>
            <h1>{t('Training Jobs')}</h1>
            <p className="muted">{t('Track job states, logs, and metrics for OCR and detection tasks.')}</p>
          </div>
          <div className="workspace-overview-badges">
            <div className="workspace-overview-badge">
              <span>{t('Active runs')}</span>
              <strong>{summary.running}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Recent completions')}</span>
              <strong>{summary.completed}</strong>
            </div>
            <div className="workspace-overview-badge">
              <span>{t('Failure watch')}</span>
              <strong>{summary.failed}</strong>
            </div>
          </div>
        </div>
      </Card>

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}

      <section className="workspace-overview-signal-grid">
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Running')}</h3>
            <small className="muted">{t('Queued, running, or evaluating jobs are treated as active work.')}</small>
          </div>
          <strong className="metric">{summary.running}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Completed')}</h3>
            <small className="muted">{t('Finished runs stay visible for version registration and follow-up review.')}</small>
          </div>
          <strong className="metric">{summary.completed}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card attention">
          <div className="workspace-signal-top">
            <h3>{t('Failed/Cancelled')}</h3>
            <small className="muted">{t('Problem runs remain easy to revisit from the detail page.')}</small>
          </div>
          <strong className="metric">{summary.failed}</strong>
        </Card>
        <Card as="article" className="workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Total')}</h3>
            <small className="muted">{t('All visible jobs across the current workspace scope.')}</small>
          </div>
          <strong className="metric">{jobs.length}</strong>
        </Card>
      </section>

      <section className="workspace-overview-panel-grid">
        <Card as="article" className="workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Live queue')}</h3>
              <small className="muted">
                {t('Jobs that are still moving through preparation, runtime, or evaluation.')}
              </small>
            </div>
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
              renderItem={(job) => (
                <Panel className="workspace-record-item virtualized" tone="soft">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{job.name}</strong>
                      <small className="muted">
                        {t(job.task_type)} · {t(job.framework)} · {t(job.status)} · {t('Last updated')}: {formatTimestamp(job.updated_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <StatusTag status={job.status}>{t(job.status)}</StatusTag>
                      <ButtonLink to={`/training/jobs/${job.id}`} variant="secondary" size="sm">
                        {t('Open Detail')}
                      </ButtonLink>
                    </div>
                  </div>
                  <small className="muted line-clamp-2">
                    {job.log_excerpt || t('Logs will become visible after execution starts.')}
                  </small>
                </Panel>
              )}
            />
          ) : (
            <ul className="workspace-record-list">
              {liveJobs.map((job) => (
                <Panel key={job.id} as="li" className="workspace-record-item" tone="soft">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{job.name}</strong>
                      <small className="muted">
                        {t(job.task_type)} · {t(job.framework)} · {t(job.status)} · {t('Last updated')}: {formatTimestamp(job.updated_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <StatusTag status={job.status}>{t(job.status)}</StatusTag>
                      <ButtonLink to={`/training/jobs/${job.id}`} variant="secondary" size="sm">
                        {t('Open Detail')}
                      </ButtonLink>
                    </div>
                  </div>
                  <small className="muted line-clamp-2">
                    {job.log_excerpt || t('Logs will become visible after execution starts.')}
                  </small>
                </Panel>
              ))}
            </ul>
          )}
        </Card>

        <div className="workspace-overview-side">
          <Card as="article">
            <div className="stack tight">
              <h3>{t('Create next run')}</h3>
              <small className="muted">
                {t('Open the training wizard when you are ready to launch another experiment.')}
              </small>
            </div>
            <strong className="workspace-side-metric">{summary.running}</strong>
            <small className="muted">
              {t('Active runs')} · {summary.running} / {jobs.length}
            </small>
            <ButtonLink to="/training/jobs/new" variant="secondary">
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
                renderItem={(job) => (
                  <Panel className="workspace-record-item compact virtualized" tone="soft">
                    <div className="workspace-record-item-top">
                      <div className="workspace-record-summary stack tight">
                        <strong>{job.name}</strong>
                        <small className="muted">
                          {t(job.framework)} · {t(job.status)}
                        </small>
                      </div>
                      <div className="workspace-record-actions">
                        <StatusTag status={job.status}>{t(job.status)}</StatusTag>
                        <ButtonLink to={`/training/jobs/${job.id}`} variant="ghost" size="sm">
                          {t('Open Detail')}
                        </ButtonLink>
                      </div>
                    </div>
                    <small className="muted">{formatTimestamp(job.updated_at)}</small>
                  </Panel>
                )}
              />
            ) : (
              <ul className="workspace-record-list compact">
                {recentTerminalJobs.map((job) => (
                  <Panel key={job.id} as="li" className="workspace-record-item compact" tone="soft">
                    <div className="workspace-record-item-top">
                      <div className="workspace-record-summary stack tight">
                        <strong>{job.name}</strong>
                        <small className="muted">
                          {t(job.framework)} · {t(job.status)}
                        </small>
                      </div>
                      <div className="workspace-record-actions">
                        <StatusTag status={job.status}>{t(job.status)}</StatusTag>
                        <ButtonLink to={`/training/jobs/${job.id}`} variant="ghost" size="sm">
                          {t('Open Detail')}
                        </ButtonLink>
                      </div>
                    </div>
                    <small className="muted">{formatTimestamp(job.updated_at)}</small>
                  </Panel>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>
    </div>
  );
}
