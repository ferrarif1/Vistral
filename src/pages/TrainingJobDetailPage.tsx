import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { TrainingJobRecord, TrainingMetricRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
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
      setFeedback({ variant: 'success', text: 'Training job cancelled.' });
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
      setFeedback({ variant: 'success', text: 'Training job retried.' });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!jobId) {
    return (
      <div className="stack">
        <h2>Training Job Detail</h2>
        <StateBlock variant="error" title="Missing Job ID" description="Open from training jobs list." />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="stack">
        <h2>Training Job Detail</h2>
        <StateBlock variant="loading" title="Loading" description="Fetching training job detail." />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="stack">
        <h2>Training Job Detail</h2>
        <StateBlock variant="error" title="Not Found" description="Training job does not exist." />
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>Training Job Detail</h2>
      <p className="muted">
        {job.name} · {job.task_type} · {job.framework}
      </p>

      <StepIndicator
        steps={['Draft', 'Queued', 'Preparing', 'Running', 'Evaluating', 'Completed']}
        current={stepIndex}
      />

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? 'Completed' : 'Failed'}
          description={feedback.text}
        />
      ) : null}

      {(job.status === 'failed' || job.status === 'cancelled') && !feedback ? (
        <StateBlock
          variant="error"
          title="Training Interrupted"
          description={`Job is currently ${job.status}. You can retry from detail page.`}
        />
      ) : null}

      {job.status === 'completed' ? (
        <StateBlock variant="success" title="Training Completed" description="Job reached completed state." />
      ) : null}

      <section className="card stack">
        <h3>Runtime Status</h3>
        <small className="muted">{job.log_excerpt}</small>
        <small className="muted">Dataset: {job.dataset_id}</small>
        <small className="muted">Base model: {job.base_model}</small>
      </section>

      <section className="card stack">
        <h3>Metrics</h3>
        {metrics.length === 0 ? (
          <StateBlock
            variant="empty"
            title="No Metrics Yet"
            description="Metrics will appear after evaluation stage."
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
          Cancel
        </button>
        <button onClick={retryJob} disabled={busy || !['failed', 'cancelled'].includes(job.status)}>
          Retry
        </button>
      </div>
    </div>
  );
}
