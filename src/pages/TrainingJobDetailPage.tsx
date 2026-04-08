import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { TrainingArtifactSummary, TrainingJobRecord, TrainingMetricRecord } from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import StepIndicator from '../components/StepIndicator';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspaceHero,
  WorkspaceMetricGrid,
  WorkspacePage,
  WorkspaceSplit
} from '../components/ui/WorkspacePage';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
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
const METRIC_CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)'
];
const metricTimelineVirtualizationThreshold = 24;
const metricTimelineVirtualRowHeight = 56;
const metricTimelineVirtualViewportHeight = 420;
const logsBatchSize = 300;
const backgroundRefreshIntervalMs = 5000;

type LoadMode = 'initial' | 'manual' | 'background';

export default function TrainingJobDetailPage() {
  const { t } = useI18n();
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<TrainingJobRecord | null>(null);
  const [metrics, setMetrics] = useState<TrainingMetricRecord[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [artifactAttachmentId, setArtifactAttachmentId] = useState<string | null>(null);
  const [artifactSummary, setArtifactSummary] = useState<TrainingArtifactSummary | null>(null);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportingMetrics, setExportingMetrics] = useState(false);
  const [exportingMetricsCsv, setExportingMetricsCsv] = useState(false);
  const [visibleLogCount, setVisibleLogCount] = useState(logsBatchSize);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const detailSignatureRef = useRef('');

  const load = useCallback(async (mode: LoadMode) => {
    if (!jobId) {
      return;
    }

    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    try {
      const detail = await api.getTrainingJobDetail(jobId);
      const nextSignature = JSON.stringify({
        job: detail.job,
        metrics: detail.metrics,
        logs: detail.logs,
        artifact_attachment_id: detail.artifact_attachment_id,
        artifact_summary: detail.artifact_summary,
        workspace_dir: detail.workspace_dir
      });

      if (detailSignatureRef.current !== nextSignature) {
        detailSignatureRef.current = nextSignature;
        setJob(detail.job);
        setMetrics(detail.metrics);
        setLogs(detail.logs);
        setArtifactAttachmentId(detail.artifact_attachment_id);
        setArtifactSummary(detail.artifact_summary);
        setWorkspaceDir(detail.workspace_dir);
      }
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, [jobId]);

  useEffect(() => {
    if (!jobId) {
      setLoading(false);
      return;
    }

    load('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [jobId, load]);

  useBackgroundPolling(
    () => {
      load('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled:
        Boolean(jobId) &&
        Boolean(job) &&
        !['completed', 'failed', 'cancelled'].includes(job?.status ?? 'completed')
    }
  );

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
  const shouldVirtualizeMetricTimeline = metricTimeline.length > metricTimelineVirtualizationThreshold;
  const schedulerDecisionHistory = useMemo(
    () => [...(job?.scheduler_decision_history ?? [])].sort((left, right) => Date.parse(right.decided_at) - Date.parse(left.decided_at)),
    [job]
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
  const hiddenLogCount = Math.max(0, logs.length - visibleLogCount);
  const visibleLogs = useMemo(() => {
    const startIndex = Math.max(0, logs.length - visibleLogCount);
    return logs.slice(startIndex);
  }, [logs, visibleLogCount]);
  const formatTimestamp = (value: string | null) => {
    if (!value) {
      return t('n/a');
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return value;
    }

    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(parsed));
  };

  useEffect(() => {
    setVisibleLogCount((previous) => {
      if (logs.length === 0) {
        return 0;
      }

      if (logs.length <= logsBatchSize) {
        return logs.length;
      }

      if (previous <= 0) {
        return logsBatchSize;
      }

      return Math.min(logs.length, Math.max(previous, logsBatchSize));
    });
  }, [logs.length]);

  const cancelJob = async () => {
    if (!jobId) {
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      await api.cancelTrainingJob(jobId);
      await load('manual');
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
      await load('manual');
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

  const downloadArtifact = () => {
    if (!artifactAttachmentId) {
      return;
    }

    const anchor = document.createElement('a');
    anchor.href = api.attachmentContentUrl(artifactAttachmentId);
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.click();
  };

  const renderMetricTimelineRow = (metric: TrainingMetricRecord, as: 'div' | 'li' = 'div') => (
    <Panel
      as={as}
      className={`workspace-record-item compact row between gap wrap${as === 'div' ? ' virtualized' : ''}`}
      tone="soft"
    >
      <span>{metric.metric_name}</span>
      <span className="muted">
        {t('step')} {metric.step}
      </span>
      <Badge tone="info">{metric.metric_value.toFixed(4)}</Badge>
    </Panel>
  );

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Training Detail')}
      title={t('Training Job Detail')}
      description={
        job
          ? `${job.name} · ${t(job.task_type)} · ${t(job.framework)}`
          : t('Review status, logs, and metrics for the selected training run.')
      }
      stats={[
        { label: t('Status'), value: job ? t(job.status) : t('Pending') },
        { label: t('Metrics'), value: metrics.length },
        { label: t('Logs'), value: logs.length }
      ]}
    />
  );

  const renderShell = (content: ReactNode) => (
    <WorkspacePage>
      {heroSection}
      {content}
    </WorkspacePage>
  );

  if (!jobId) {
    return renderShell(
      <StateBlock variant="error" title={t('Missing Job ID')} description={t('Open from training jobs list.')} />
    );
  }

  if (loading) {
    return renderShell(
      <StateBlock variant="loading" title={t('Loading')} description={t('Fetching training job detail.')} />
    );
  }

  if (!job) {
    return renderShell(
      <StateBlock variant="error" title={t('Not Found')} description={t('Training job does not exist.')} />
    );
  }

  const canCancel = ['queued', 'preparing', 'running'].includes(job.status);
  const canRetry = ['failed', 'cancelled'].includes(job.status);
  const isInterrupted = job.status === 'failed' || job.status === 'cancelled';
  const isCompleted = job.status === 'completed';
  const refreshDetail = () => {
    load('manual')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  };

  return (
    <WorkspacePage>
      {heroSection}

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

      {isInterrupted && !feedback ? (
        <StateBlock
          variant="error"
          title={t('Training Interrupted')}
          description={t('Job is currently {status}. You can retry from detail page.', {
            status: t(job.status)
          })}
        />
      ) : null}

      {isCompleted ? (
        <StateBlock variant="success" title={t('Training Completed')} description={t('Job reached completed state.')} />
      ) : null}

      <WorkspaceMetricGrid
        items={[
          {
            title: t('Run status'),
            description: t('Current lifecycle stage for this training job.'),
            value: t(job.status)
          },
          {
            title: t('Metrics'),
            description: t('Recorded metric points from this run timeline.'),
            value: metrics.length
          },
          {
            title: t('Logs'),
            description: t('Captured execution log lines for the selected run.'),
            value: logs.length
          },
          {
            title: t('Artifact'),
            description: t('Artifact attachment generated by this run.'),
            value: artifactAttachmentId ? t('Ready') : t('pending'),
            tone: artifactAttachmentId ? 'default' : 'attention'
          }
        ]}
      />

      <WorkspaceSplit
        main={
          <>
            <Card as="section" className="stack">
              <div className="stack tight">
                <h3>{t('Runtime Status')}</h3>
                <small className="muted">
                  {t('Execution metadata and artifact status for this run.')}
                </small>
              </div>
              <div className="row gap wrap">
                <StatusTag status={job.status}>{t(job.status)}</StatusTag>
                <Badge tone="neutral">{t('Dataset')}: {job.dataset_id}</Badge>
                <Badge tone="neutral">{t('Base model')}: {job.base_model}</Badge>
                <Badge tone="info">{t('Execution mode')}: {t(job.execution_mode)}</Badge>
                <Badge tone={artifactAttachmentId ? 'success' : 'warning'}>
                  {t('Artifact')}: {artifactAttachmentId ? t('Ready') : t('pending')}
                </Badge>
              </div>
              {artifactAttachmentId ? (
                <small className="muted">{t('Artifact attachment')}: {artifactAttachmentId}</small>
              ) : null}
              {artifactAttachmentId ? (
                <div className="row gap wrap">
                  <Button type="button" variant="secondary" size="sm" onClick={downloadArtifact}>
                    {t('Download Artifact')}
                  </Button>
                  <small className="muted">{t('Artifact ready for download from this detail page.')}</small>
                </div>
              ) : null}
              {job.scheduler_decision ? (
                <Panel className="stack tight" tone="soft">
                  <div className="row between align-center wrap">
                    <strong>{t('Scheduler decision')}</strong>
                    <small className="muted">{formatTimestamp(job.scheduler_decision.decided_at)}</small>
                  </div>
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t('Trigger')}: {t(job.scheduler_decision.trigger)}</Badge>
                    <Badge tone="neutral">{t('Attempt')}: {job.scheduler_decision.attempt}</Badge>
                    <Badge tone={job.scheduler_decision.execution_target === 'worker' ? 'info' : 'warning'}>
                      {t('Target')}: {t(job.scheduler_decision.execution_target)}
                    </Badge>
                    {job.scheduler_decision.selected_worker_id ? (
                      <Badge tone="info">
                        {t('Selected worker')}: {job.scheduler_decision.selected_worker_id}
                      </Badge>
                    ) : (
                      <Badge tone="warning">{t('Selected worker')}: {t('none')}</Badge>
                    )}
                  </div>
                  <div className="row gap wrap">
                    <Badge tone="neutral">
                      {t('Score')}: {job.scheduler_decision.selected_worker_score?.toFixed(4) ?? t('n/a')}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Load')}: {job.scheduler_decision.selected_worker_load_component?.toFixed(4) ?? t('n/a')}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Penalty')}: {job.scheduler_decision.selected_worker_health_penalty?.toFixed(4) ?? t('n/a')}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Capability bonus')}: {job.scheduler_decision.selected_worker_capability_bonus?.toFixed(4) ?? t('n/a')}
                    </Badge>
                    <Badge tone="neutral">
                      {t('In flight')}: {job.scheduler_decision.selected_worker_in_flight_jobs ?? t('n/a')}
                    </Badge>
                    <Badge tone="neutral">
                      {t('Max concurrency')}: {job.scheduler_decision.selected_worker_max_concurrency ?? t('n/a')}
                    </Badge>
                  </div>
                  {job.scheduler_decision.excluded_worker_ids.length > 0 ? (
                    <small className="muted">
                      {t('Excluded workers')}: {job.scheduler_decision.excluded_worker_ids.join(', ')}
                    </small>
                  ) : null}
                  {job.scheduler_decision.fallback_reason ? (
                    <small className="muted">
                      {t('Fallback reason')}: {job.scheduler_decision.fallback_reason}
                    </small>
                  ) : null}
                  <small className="muted">{job.scheduler_decision.note}</small>
                  {schedulerDecisionHistory.length > 1 ? (
                    <details className="workspace-details">
                      <summary>
                        {t('Scheduler history')} ({schedulerDecisionHistory.length})
                      </summary>
                      <div className="stack tight">
                        {schedulerDecisionHistory.map((decision, index) => (
                          <Panel
                            key={`${decision.decided_at}-${decision.trigger}-${decision.attempt}-${index}`}
                            tone="soft"
                            className="stack tight"
                          >
                            <div className="row between align-center wrap">
                              <strong>
                                {t(decision.trigger)} · {t('Attempt')} {decision.attempt}
                              </strong>
                              <small className="muted">{formatTimestamp(decision.decided_at)}</small>
                            </div>
                            <div className="row gap wrap">
                              <Badge tone={decision.execution_target === 'worker' ? 'info' : 'warning'}>
                                {t('Target')}: {t(decision.execution_target)}
                              </Badge>
                              <Badge tone="neutral">
                                {t('Worker')}: {decision.selected_worker_id ?? t('none')}
                              </Badge>
                              <Badge tone="neutral">
                                {t('Score')}: {decision.selected_worker_score?.toFixed(4) ?? t('n/a')}
                              </Badge>
                              <Badge tone="neutral">
                                {t('Load')}: {decision.selected_worker_load_component?.toFixed(4) ?? t('n/a')}
                              </Badge>
                              <Badge tone="neutral">
                                {t('Penalty')}: {decision.selected_worker_health_penalty?.toFixed(4) ?? t('n/a')}
                              </Badge>
                            </div>
                            {decision.excluded_worker_ids.length > 0 ? (
                              <small className="muted">
                                {t('Excluded workers')}: {decision.excluded_worker_ids.join(', ')}
                              </small>
                            ) : null}
                            {decision.fallback_reason ? (
                              <small className="muted">
                                {t('Fallback reason')}: {decision.fallback_reason}
                              </small>
                            ) : null}
                            <small className="muted">{decision.note}</small>
                          </Panel>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </Panel>
              ) : (
                <small className="muted">{t('Scheduler decision snapshot not available yet.')}</small>
              )}
              <small className="muted">{job.log_excerpt}</small>
              {artifactSummary ? (
                <>
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t('Runner mode')}: {artifactSummary.mode || t('pending')}</Badge>
                    <Badge tone="neutral">{t('Runner')}: {artifactSummary.runner || t('pending')}</Badge>
                    {artifactSummary.training_performed !== null ? (
                      <Badge tone={artifactSummary.training_performed ? 'success' : 'warning'}>
                        {t('Training performed')}: {artifactSummary.training_performed ? t('yes') : t('no')}
                      </Badge>
                    ) : null}
                    {artifactSummary.sampled_items !== null ? (
                      <Badge tone="info">{t('Sampled items')}: {artifactSummary.sampled_items}</Badge>
                    ) : null}
                    {artifactSummary.generated_at ? (
                      <Badge tone="neutral">{t('Artifact generated at')}: {formatTimestamp(artifactSummary.generated_at)}</Badge>
                    ) : null}
                  </div>
                  {artifactSummary.primary_model_path ? (
                    <small className="muted">
                      {t('Primary model path')}: {artifactSummary.primary_model_path}
                    </small>
                  ) : null}
                  {artifactSummary.metrics_keys.length > 0 ? (
                    <div className="row gap wrap">
                      {artifactSummary.metrics_keys.map((metricKey) => (
                        <Badge key={metricKey} tone="neutral">
                          {metricKey}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {artifactSummary.fallback_reason ? (
                    <small className="muted">
                      {t('Fallback reason')}: {artifactSummary.fallback_reason}
                    </small>
                  ) : null}
                </>
              ) : null}
              <small className="muted">
                {t('Workspace')}: {workspaceDir || t('pending')}
              </small>
            </Card>

            <Card as="section" className="stack">
              <div className="stack tight">
                <h3>{t('Metrics')}</h3>
                <small className="muted">
                  {t('Use JSON for structured integrations and CSV for spreadsheet analysis.')}
                </small>
              </div>
              {metrics.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Metrics Yet')}
                  description={t('Metrics will appear after evaluation stage.')}
                />
              ) : (
                <>
                  <div className="row gap wrap">
                    {latestMetrics.map((metric) => (
                      <Badge key={metric.id} tone="neutral">
                        {metric.metric_name}: {metric.metric_value.toFixed(4)} · {t('step')} {metric.step}
                      </Badge>
                    ))}
                  </div>
                  <details className="workspace-details">
                    <summary>{t('Metric Timeline')}</summary>
                    {shouldVirtualizeMetricTimeline ? (
                      <VirtualList
                        items={metricTimeline}
                        itemHeight={metricTimelineVirtualRowHeight}
                        height={metricTimelineVirtualViewportHeight}
                        ariaLabel={t('Metric Timeline')}
                        itemKey={(metric) => metric.id}
                        listClassName="workspace-record-list compact"
                        rowClassName="workspace-record-row"
                        renderItem={(metric) => renderMetricTimelineRow(metric)}
                      />
                    ) : (
                      <ul className="workspace-record-list compact">
                        {metricTimeline.map((metric) => renderMetricTimelineRow(metric, 'li'))}
                      </ul>
                    )}
                  </details>
                </>
              )}
            </Card>

            {metricCurves.length > 0 ? (
              <Card as="section">
                <h3>{t('Metric Curves')}</h3>
                <div className="metric-chart-grid">
                  {metricCurves.map((curve) => (
                    <article key={curve.metricName} className="metric-chart-card stack tight">
                      <div className="row between align-center">
                        <strong>{curve.metricName}</strong>
                        <Badge tone="info">{curve.latestValue.toFixed(4)}</Badge>
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
                          stroke="var(--color-border)"
                          strokeWidth="1"
                        />
                        <line
                          x1={METRIC_CHART_PADDING}
                          y1={METRIC_CHART_PADDING}
                          x2={METRIC_CHART_PADDING}
                          y2={METRIC_CHART_HEIGHT - METRIC_CHART_PADDING}
                          stroke="var(--color-border)"
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
              </Card>
            ) : null}

            <Card as="section" className="stack">
              <div className="stack tight">
                <h3>{t('Training Logs')}</h3>
                <small className="muted">
                  {t('Latest execution logs are shown here with optional backfill for earlier lines.')}
                </small>
              </div>
              {logs.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No Logs Yet')}
                  description={t('Logs will appear after local executor starts.')}
                />
              ) : (
                <div className="stack tight">
                  {hiddenLogCount > 0 ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setVisibleLogCount((previous) => Math.min(logs.length, previous + logsBatchSize));
                      }}
                    >
                      {t('Load earlier logs')} ({hiddenLogCount})
                    </Button>
                  ) : null}
                  <pre className="code-block">{visibleLogs.join('\n')}</pre>
                </div>
              )}
            </Card>
          </>
        }
        side={
          <>
            <Card as="section">
              <div className="stack tight">
                <h3>{t('Run actions')}</h3>
                <small className="muted">
                  {t('Primary controls for this run are grouped here to keep the detail surface quiet.')}
                </small>
              </div>
              <div className="workspace-button-stack">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={refreshDetail}
                  disabled={loading || refreshing || busy}
                >
                  {refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
                <Button onClick={cancelJob} variant="danger" disabled={busy || !canCancel}>
                  {t('Cancel')}
                </Button>
                <Button onClick={retryJob} variant="secondary" disabled={busy || !canRetry}>
                  {t('Retry')}
                </Button>
              </div>
            </Card>

            <Card as="section">
              <div className="stack tight">
                <h3>{t('Exports')}</h3>
                <small className="muted">
                  {t('Download timeline metrics or continue to adjacent training surfaces.')}
                </small>
              </div>
              <div className="workspace-button-stack">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={downloadMetricsJson}
                  disabled={exportingMetrics || exportingMetricsCsv || metrics.length === 0}
                  title={t('Export all metrics timeline in JSON format.')}
                >
                  {exportingMetrics ? t('Exporting...') : t('Download Metrics JSON')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={downloadMetricsCsv}
                  disabled={exportingMetrics || exportingMetricsCsv || metrics.length === 0}
                  title={t('Export all metrics timeline in CSV format.')}
                >
                  {exportingMetricsCsv ? t('Exporting...') : t('Download Metrics CSV')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={downloadArtifact}
                  disabled={!artifactAttachmentId}
                  title={t('Download artifact attachment generated by this run.')}
                >
                  {t('Download Artifact')}
                </Button>
                <ButtonLink to="/training/jobs" variant="secondary">
                  {t('Back to jobs list')}
                </ButtonLink>
                <ButtonLink to="/models/versions" variant="secondary">
                  {t('Open model versions')}
                </ButtonLink>
              </div>
            </Card>

            <Card as="section">
              <div className="stack tight">
                <h3>{t('Execution snapshot')}</h3>
                <small className="muted">
                  {t('Compact view of launch, runtime, and artifact status for quick triage.')}
                </small>
              </div>
              <ul className="workspace-record-list compact">
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{t('Dataset')}</strong>
                    <Badge tone="info">{job.dataset_id}</Badge>
                  </div>
                  <small className="muted">{t('Task')}: {t(job.task_type)}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{t('Framework')}</strong>
                    <Badge tone="neutral">{t(job.framework)}</Badge>
                  </div>
                  <small className="muted">{t('Base model')}: {job.base_model}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{t('Status')}</strong>
                    <StatusTag status={job.status}>{t(job.status)}</StatusTag>
                  </div>
                  <small className="muted">{t('Execution mode')}: {t(job.execution_mode)}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact" tone="soft">
                  <div className="row between gap wrap">
                    <strong>{t('Artifact')}</strong>
                    <StatusTag status={artifactAttachmentId ? 'ready' : 'draft'}>
                      {artifactAttachmentId ? t('Ready') : t('pending')}
                    </StatusTag>
                  </div>
                  <small className="muted">{artifactAttachmentId || t('Artifact not generated yet.')}</small>
                </Panel>
              </ul>
            </Card>
          </>
        }
      />
    </WorkspacePage>
  );
}
