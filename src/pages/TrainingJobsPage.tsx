import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrainingJobRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

export default function TrainingJobsPage() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.listTrainingJobs();
      setJobs(result);
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => {
      // no-op
    });

    const timer = window.setInterval(() => {
      load().catch(() => {
        // no-op
      });
    }, 900);

    return () => window.clearInterval(timer);
  }, []);

  const summary = useMemo(
    () => ({
      running: jobs.filter((job) => ['queued', 'preparing', 'running', 'evaluating'].includes(job.status)).length,
      completed: jobs.filter((job) => job.status === 'completed').length,
      failed: jobs.filter((job) => ['failed', 'cancelled'].includes(job.status)).length
    }),
    [jobs]
  );

  return (
    <div className="stack">
      <div className="row between gap align-center">
        <div className="stack tight">
          <h2>{t('Training Jobs')}</h2>
          <small className="muted">{t('Track job states, logs, and metrics for OCR and detection tasks.')}</small>
        </div>
        <Link className="quick-link" to="/training/jobs/new">
          {t('Create Training Job')}
        </Link>
      </div>

      <section className="console-grid">
        <article className="card stack tight">
          <strong className="metric">{summary.running}</strong>
          <small className="muted">{t('Running')}</small>
        </article>
        <article className="card stack tight">
          <strong className="metric">{summary.completed}</strong>
          <small className="muted">{t('Completed')}</small>
        </article>
        <article className="card stack tight">
          <strong className="metric">{summary.failed}</strong>
          <small className="muted">{t('Failed/Cancelled')}</small>
        </article>
        <article className="card stack tight">
          <strong className="metric">{jobs.length}</strong>
          <small className="muted">{t('Total')}</small>
        </article>
      </section>

      {loading ? <StateBlock variant="loading" title={t('Loading Jobs')} description={t('Fetching training jobs.')} /> : null}
      {error ? <StateBlock variant="error" title={t('Load Failed')} description={error} /> : null}

      {!loading && !error && jobs.length === 0 ? (
        <StateBlock variant="empty" title={t('No Jobs')} description={t('Create your first training job.')} />
      ) : null}

      {!loading && !error && jobs.length > 0 ? (
        <ul className="list">
          {jobs.map((job) => (
            <li key={job.id} className="card stack">
              <div className="row between gap">
                <div className="stack tight">
                  <strong>{job.name}</strong>
                  <small className="muted">
                    {job.task_type} · {job.framework} · {job.status}
                  </small>
                </div>
                <Link className="quick-link" to={`/training/jobs/${job.id}`}>
                  {t('Open Detail')}
                </Link>
              </div>
              <small className="muted">{job.log_excerpt}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
