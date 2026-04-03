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

const METRIC_CHART_WIDTH = 300;
const METRIC_CHART_HEIGHT = 120;
const METRIC_CHART_PADDING = 12;
const METRIC_CHART_COLORS = ['#2f6f5b', '#1f7f9a', '#916a2f', '#7a5bb7', '#9b3a61', '#2f5aa8'];

export default function TrainingJobDetailPage() {
  const { t } = useI18n();
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<TrainingJobRecord | null>(null);
  const [metrics, setMetrics] = useState<TrainingMetricRecord[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [artifactAttachmentId, setArtifactAttachmentId] = useState<string | null>(null);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [exportingMetrics, setExportingMetrics] = useState(false);
  const [exportingMetricsCsv, setExportingMetricsCsv] = useState(false);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!jobId) {
      return;
    }

    const detail = await api.getTrainingJobDetail(jobId);
    setJob(detail.job);
    setMetrics(detail.metrics);
    setLogs(detail.logs);
    setArtifactAttachmentId(detail.artifact_attachment_id);
    setWorkspaceDir(detail.workspace_dir);
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

  const latestMetrics = useMemo(() => {
    const latestByMetric = new Map<string, TrainingMetricRecord>();
    metrics.forEach((metric) => {
      const existing = latestByMetric.get(metric.metric_name);
      if (!existing || metric.step >= existing.step) {
        latestByMetric.set(metric.metric_name, metric);
      }
    });

    return Array.from(latestByMetric.values()).sort((left, right) =>
      left.metric_name.localeCompare(right.metric_name)
    );
  }, [metrics]);

  const metricTimeline = useMemo(
    () =>
      [...metrics].sort((left, right) =>
        left.step === right.step
          ? left.metric_name.localeCompare(right.metric_name)
          : left.step - right.step
      ),
    [metrics]
  );

  const metricCurves = useMemo(() => {
    const grouped = new Map<string, TrainingMetricRecord[]>();
    metricTimeline.forEach((metric) => {
      const list = grouped.get(metric.metric_name) ?? [];
      list.push(metric);
      grouped.set(metric.metric_name, list);
    });

    return Array.from(grouped.entries())
      .map(([metricName, entries], index) => {
        const sorted = [...entries].sort((left, right) =>
          left.step === right.step ? left.recorded_at.localeCompare(right.recorded_at) : left.step - right.step
        );
        const minStep = sorted[0]?.step ?? 1;
        const maxStep = sorted[sorted.length - 1]?.step ?? minStep;
        const minValue = Math.min(...sorted.map((item) => item.metric_value));
        const maxValue = Math.max(...sorted.map((item) => item.metric_value));
        const hasSpread = maxValue > minValue;
        const stepRange = Math.max(1, maxStep - minStep);
        const drawWidth = METRIC_CHART_WIDTH - METRIC_CHART_PADDING * 2;
        const drawHeight = METRIC_CHART_HEIGHT - METRIC_CHART_PADDING * 2;
        const points = sorted.map((item) => {
          const x = METRIC_CHART_PADDING + ((item.step - minStep) / stepRange) * drawWidth;
          const y = hasSpread
            ? METRIC_CHART_HEIGHT -
              METRIC_CHART_PADDING -
              ((item.metric_value - minValue) / Math.max(maxValue - minValue, Number.EPSILON)) * drawHeight
            : METRIC_CHART_HEIGHT / 2;
          return {
            x,
            y
          };
        });
        const polyline = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
        const lastPoint = points[points.length - 1] ?? null;

        return {
          metricName,
          color: METRIC_CHART_COLORS[index % METRIC_CHART_COLORS.length],
          minStep,
          maxStep,
          minValue,
          maxValue,
          points,
          polyline,
          lastPoint,
          latestValue: sorted[sorted.length - 1]?.metric_value ?? 0
        };
      })
      .sort((left, right) => left.metricName.localeCompare(right.metricName));
  }, [metricTimeline]);

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

  const downloadMetricsJson = async () => {
    if (!jobId) {
      return;
    }

    setExportingMetrics(true);
    try {
      const exported = await api.exportTrainingJobMetrics(jobId);
      const blob = new Blob([JSON.stringify(exported, null, 2)], {
        type: 'application/json;charset=utf-8'
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `training-metrics-${jobId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setFeedback({ variant: 'success', text: t('Training metrics JSON exported.') });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setExportingMetrics(false);
    }
  };

  const downloadMetricsCsv = async () => {
    if (!jobId) {
      return;
    }

    setExportingMetricsCsv(true);
    try {
      const exported = await api.downloadTrainingJobMetricsCsv(jobId);
      const url = URL.createObjectURL(exported.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exported.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setFeedback({ variant: 'success', text: t('Training metrics CSV exported.') });
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setExportingMetricsCsv(false);
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
        <small className="muted">
          {t('Artifact attachment')}: {artifactAttachmentId || t('pending')}
        </small>
        <small className="muted">
          {t('Workspace')}: {workspaceDir || t('pending')}
        </small>
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
          <>
            <p className="muted">
              {t('Use JSON for structured integrations and CSV for spreadsheet analysis.')}
            </p>
            <div className="row gap wrap">
              <button
                type="button"
                className="small-btn"
                onClick={downloadMetricsJson}
                disabled={exportingMetrics || exportingMetricsCsv}
                title={t('Export all metrics timeline in JSON format.')}
              >
                {exportingMetrics ? t('Exporting...') : t('Download Metrics JSON')}
              </button>
              <button
                type="button"
                className="small-btn"
                onClick={downloadMetricsCsv}
                disabled={exportingMetrics || exportingMetricsCsv}
                title={t('Export all metrics timeline in CSV format.')}
              >
                {exportingMetricsCsv ? t('Exporting...') : t('Download Metrics CSV')}
              </button>
            </div>
            <div className="row gap wrap">
              {latestMetrics.map((metric) => (
                <span key={metric.id} className="chip">
                  {metric.metric_name}: {metric.metric_value.toFixed(4)} · {t('step')} {metric.step}
                </span>
              ))}
            </div>
            <details>
              <summary>{t('Metric Timeline')}</summary>
              <ul className="list">
                {metricTimeline.map((metric) => (
                  <li key={metric.id} className="list-item row between gap">
                    <span>{metric.metric_name}</span>
                    <span className="muted">
                      {t('step')} {metric.step}
                    </span>
                    <span className="chip">{metric.metric_value.toFixed(4)}</span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>

      {metricCurves.length > 0 ? (
        <section className="card stack">
          <h3>{t('Metric Curves')}</h3>
          <div className="metric-chart-grid">
            {metricCurves.map((curve) => (
              <article key={curve.metricName} className="metric-chart-card stack tight">
                <div className="row between align-center">
                  <strong>{curve.metricName}</strong>
                  <span className="chip">{curve.latestValue.toFixed(4)}</span>
                </div>
                <svg
                  className="metric-chart-svg"
                  viewBox={`0 0 ${METRIC_CHART_WIDTH} ${METRIC_CHART_HEIGHT}`}
                  role="img"
                  aria-label={`${curve.metricName} metric curve`}
                >
                  <line
                    x1={METRIC_CHART_PADDING}
                    y1={METRIC_CHART_HEIGHT - METRIC_CHART_PADDING}
                    x2={METRIC_CHART_WIDTH - METRIC_CHART_PADDING}
                    y2={METRIC_CHART_HEIGHT - METRIC_CHART_PADDING}
                    stroke="#d2ddd7"
                    strokeWidth="1"
                  />
                  <line
                    x1={METRIC_CHART_PADDING}
                    y1={METRIC_CHART_PADDING}
                    x2={METRIC_CHART_PADDING}
                    y2={METRIC_CHART_HEIGHT - METRIC_CHART_PADDING}
                    stroke="#d2ddd7"
                    strokeWidth="1"
                  />
                  <polyline points={curve.polyline} fill="none" stroke={curve.color} strokeWidth="2.2" />
                  {curve.lastPoint ? (
                    <circle cx={curve.lastPoint.x} cy={curve.lastPoint.y} r="3.4" fill={curve.color} />
                  ) : null}
                </svg>
                <small className="muted">
                  {t('Step range')}: {curve.minStep} - {curve.maxStep} · {t('Value range')}:{' '}
                  {curve.minValue.toFixed(4)} - {curve.maxValue.toFixed(4)}
                </small>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card stack">
        <h3>{t('Training Logs')}</h3>
        {logs.length === 0 ? (
          <StateBlock
            variant="empty"
            title={t('No Logs Yet')}
            description={t('Logs will appear after local executor starts.')}
          />
        ) : (
          <pre className="code-block">{logs.join('\n')}</pre>
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
