import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrainingJobRecord, TrainingJobStatus } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const activeStatusSet = new Set<TrainingJobStatus>(['queued', 'preparing', 'running', 'evaluating']);
const terminalStatusSet = new Set<TrainingJobStatus>(['completed', 'failed', 'cancelled']);
const backgroundRefreshIntervalMs = 5000;

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

    const timer = window.setInterval(() => {
      load('background').catch(() => {
        // no-op
      });
    }, backgroundRefreshIntervalMs);

    return () => window.clearInterval(timer);
  }, []);

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
    () => sortedJobs.filter((job) => activeStatusSet.has(job.status)).slice(0, 6),
    [sortedJobs]
  );
  const recentTerminalJobs = useMemo(
    () => sortedJobs.filter((job) => terminalStatusSet.has(job.status)).slice(0, 4),
    [sortedJobs]
  );

  return (
    <div className="workspace-overview-page stack">
      <section className="card workspace-overview-hero">
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
      </section>

      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}

      <section className="workspace-overview-signal-grid">
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Running')}</h3>
            <small className="muted">{t('Queued, running, or evaluating jobs are treated as active work.')}</small>
          </div>
          <strong className="metric">{summary.running}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Completed')}</h3>
            <small className="muted">{t('Finished runs stay visible for version registration and follow-up review.')}</small>
          </div>
          <strong className="metric">{summary.completed}</strong>
        </article>
        <article className="card stack workspace-signal-card attention">
          <div className="workspace-signal-top">
            <h3>{t('Failed/Cancelled')}</h3>
            <small className="muted">{t('Problem runs remain easy to revisit from the detail page.')}</small>
          </div>
          <strong className="metric">{summary.failed}</strong>
        </article>
        <article className="card stack workspace-signal-card">
          <div className="workspace-signal-top">
            <h3>{t('Total')}</h3>
            <small className="muted">{t('All visible jobs across the current workspace scope.')}</small>
          </div>
          <strong className="metric">{jobs.length}</strong>
        </article>
      </section>

      <section className="workspace-overview-panel-grid">
        <article className="card stack workspace-overview-main">
          <div className="workspace-section-header">
            <div className="stack tight">
              <h3>{t('Live queue')}</h3>
              <small className="muted">
                {t('Jobs that are still moving through preparation, runtime, or evaluation.')}
              </small>
            </div>
            <button
              type="button"
              className="workspace-inline-button"
              onClick={() => {
                load('manual').catch(() => {
                  // no-op
                });
              }}
              disabled={loading || refreshing}
            >
              {loading ? t('Loading') : refreshing ? t('Refreshing...') : t('Refresh')}
            </button>
          </div>

          {loading ? (
            <StateBlock variant="loading" title={t('Loading Jobs')} description={t('Fetching training jobs.')} />
          ) : liveJobs.length === 0 ? (
            <StateBlock variant="empty" title={t('No active jobs right now.')} description={t('Queued, running, or evaluating jobs will appear here.')} />
          ) : (
            <ul className="workspace-record-list">
              {liveJobs.map((job) => (
                <li key={job.id} className="workspace-record-item">
                  <div className="workspace-record-item-top">
                    <div className="workspace-record-summary stack tight">
                      <strong>{job.name}</strong>
                      <small className="muted">
                        {t(job.task_type)} · {t(job.framework)} · {t(job.status)} · {t('Last updated')}: {formatTimestamp(job.updated_at)}
                      </small>
                    </div>
                    <div className="workspace-record-actions">
                      <span className={`workspace-status-pill ${job.status}`}>{t(job.status)}</span>
                      <Link className="workspace-inline-link" to={`/training/jobs/${job.id}`}>
                        {t('Open Detail')}
                      </Link>
                    </div>
                  </div>
                  <small className="muted">{job.log_excerpt || t('Logs will become visible after execution starts.')}</small>
                </li>
              ))}
            </ul>
          )}
        </article>

        <div className="workspace-overview-side">
          <article className="card stack">
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
            <Link to="/training/jobs/new" className="workspace-inline-link">
              {t('Create Training Job')}
            </Link>
          </article>

          <article className="card stack">
            <div className="stack tight">
              <h3>{t('Recent terminal runs')}</h3>
              <small className="muted">
                {t('Latest completed, failed, or cancelled runs stay visible here for quick follow-up.')}
              </small>
            </div>

            {recentTerminalJobs.length === 0 ? (
              <StateBlock variant="empty" title={t('No terminal jobs yet.')} description={t('Finished jobs will appear here after execution ends.')} />
            ) : (
              <ul className="workspace-record-list compact">
                {recentTerminalJobs.map((job) => (
                  <li key={job.id} className="workspace-record-item compact">
                    <div className="workspace-record-item-top">
                      <div className="workspace-record-summary stack tight">
                        <strong>{job.name}</strong>
                        <small className="muted">
                          {t(job.framework)} · {t(job.status)}
                        </small>
                      </div>
                      <span className={`workspace-status-pill ${job.status}`}>{t(job.status)}</span>
                    </div>
                    <small className="muted">{formatTimestamp(job.updated_at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}
