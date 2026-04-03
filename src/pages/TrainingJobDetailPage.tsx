import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { TrainingJobRecord, TrainingMetricRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const STATUS_STEPS: Array<TrainingJobRecord['status']> = [
  'draft',
  'queued',
  'preparing',
  'running',
  'evaluating',
  'completed'
];

export default function TrainingJobDetailPage() {
  const { t } = useI18n();
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<TrainingJobRecord | null>(null);
  const [metrics, setMetrics] = useState<TrainingMetricRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!jobId) {
      return;
    }

    const detail = await api.getTrainingJobDetail(jobId);
    setJob(detail.job);
    setMetrics(detail.metrics);
  }, [jobId]);

  useEffect(() => {
    if (!jobId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    load()
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [jobId, load]);

  useEffect(() => {
    if (!jobId) {
      return;
    }

    const timer = window.setInterval(() => {
      load().catch(() => {
        // no-op
      });
    }, 900);

    return () => window.clearInterval(timer);
  }, [jobId, load]);

  const stepIndex = useMemo(() => {
    if (!job) {
      return 0;
    }

    const index = STATUS_STEPS.indexOf(job.status);
    return index >= 0 ? index : STATUS_STEPS.length - 1;
  }, [job]);

  const cancelJob = async () => {
    if (!jobId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      await api.cancelTrainingJob(jobId);
      await load();
      setFeedback({ variant: 'success', text: t('Training job cancelled.') });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const retryJob = async () => {
    if (!jobId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      await api.retryTrainingJob(jobId);
      await load();
      setFeedback({ variant: 'success', text: t('Training job retried.') });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!jobId) {
    return (
      <div className="stack">
        <h2>{t('Training Job Detail')}</h2>
        <StateBlock variant="error" title={t('Missing Job ID')} description={t('Open from training jobs list.')} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="stack">
        <h2>{t('Training Job Detail')}</h2>
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching training job detail.')} />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="stack">
        <h2>{t('Training Job Detail')}</h2>
        <StateBlock variant="error" title={t('Not Found')} description={t('Training job does not exist.')} />
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>{t('Training Job Detail')}</h2>
      <p className="muted">
        {job.name} · {t(job.task_type)} · {t(job.framework)}
      </p>

      <StepIndicator
        steps={[t('Draft'), t('Queued'), t('Preparing'), t('Running'), t('Evaluating'), t('Completed')]}
        current={stepIndex}
      />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Completed') : t('Failed')}
          description={feedback.text}
        />
      ) : null}

      {(job.status === 'failed' || job.status === 'cancelled') && !feedback ? (
        <StateBlock
          variant="error"
          title={t('Training Interrupted')}
          description={t('Job is currently {status}. You can retry from detail page.', {
            status: t(job.status)
          })}
        />
      ) : null}

      {job.status === 'completed' ? (
        <StateBlock variant="success" title={t('Training Completed')} description={t('Job reached completed state.')} />
      ) : null}

      <section className="card stack">
        <h3>{t('Runtime Status')}</h3>
        <small className="muted">{job.log_excerpt}</small>
        <small className="muted">{t('Dataset')}: {job.dataset_id}</small>
        <small className="muted">{t('Base model')}: {job.base_model}</small>
      </section>

      <section className="card stack">
        <h3>{t('Metrics')}</h3>
        {metrics.length === 0 ? (
          <StateBlock
            variant="empty"
            title={t('No Metrics Yet')}
            description={t('Metrics will appear after evaluation stage.')}
          />
        ) : (
          <ul className="list">
            {metrics.map((metric) => (
              <li key={metric.id} className="list-item row between gap">
                <span>{metric.metric_name}</span>
                <span className="chip">{metric.metric_value.toFixed(4)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="row gap">
        <button
          onClick={cancelJob}
          disabled={busy || !['queued', 'preparing', 'running'].includes(job.status)}
        >
          {t('Cancel')}
        </button>
        <button onClick={retryJob} disabled={busy || !['failed', 'cancelled'].includes(job.status)}>
          {t('Retry')}
        </button>
      </div>
    </div>
  );
}
