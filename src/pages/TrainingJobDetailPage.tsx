import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  TrainingArtifactSummary,
  TrainingJobRecord,
  TrainingMetricRecord,
  RuntimeSettingsView
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { DetailList, InlineAlert, PageHeader, SectionCard } from '../components/ui/ConsolePage';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { deriveTrainingExecutionInsight } from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { bucketRuntimeFallbackReason, runtimeFallbackReasonLabelKey } from '../utils/runtimeFallbackReason';

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

const buildScopedTrainingJobsPath = (datasetId: string, versionId?: string | null): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  return `/training/jobs?${searchParams.toString()}`;
};

const buildScopedInferencePath = (datasetId: string, versionId?: string | null): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  return `/inference/validate?${searchParams.toString()}`;
};

export default function TrainingJobDetailPage() {
  const { t } = useI18n();
  const { jobId } = useParams<{ jobId: string }>();
  const [searchParams] = useSearchParams();
  const [job, setJob] = useState<TrainingJobRecord | null>(null);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [metrics, setMetrics] = useState<TrainingMetricRecord[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [artifactAttachmentId, setArtifactAttachmentId] = useState<string | null>(null);
  const [artifactSummary, setArtifactSummary] = useState<TrainingArtifactSummary | null>(null);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [runtimeSettingsLoading, setRuntimeSettingsLoading] = useState(true);
  const [runtimeSettingsError, setRuntimeSettingsError] = useState('');
  const [runtimeDisableSimulatedTrainFallback, setRuntimeDisableSimulatedTrainFallback] = useState(false);
  const [runtimeDisableInferenceFallback, setRuntimeDisableInferenceFallback] = useState(false);
  const [runtimePythonBin, setRuntimePythonBin] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportingMetrics, setExportingMetrics] = useState(false);
  const [exportingMetricsCsv, setExportingMetricsCsv] = useState(false);
  const [visibleLogCount, setVisibleLogCount] = useState(logsBatchSize);
  const [evidenceView, setEvidenceView] = useState<'overview' | 'metrics' | 'logs'>('overview');
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
      const [detail, datasetResult] = await Promise.all([
        api.getTrainingJobDetail(jobId),
        api.listDatasets().catch(() => [] as DatasetRecord[])
      ]);
      const nextSignature = JSON.stringify({
        job: detail.job,
        metrics: detail.metrics,
        logs: detail.logs,
        artifact_attachment_id: detail.artifact_attachment_id,
        artifact_summary: detail.artifact_summary,
        workspace_dir: detail.workspace_dir,
        datasets: datasetResult.map((dataset) => ({
          id: dataset.id,
          name: dataset.name,
          updated_at: dataset.updated_at
        }))
      });

      if (detailSignatureRef.current !== nextSignature) {
        detailSignatureRef.current = nextSignature;
        setJob(detail.job);
        setDatasets(datasetResult);
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

  useEffect(() => {
    let active = true;
    setRuntimeSettingsLoading(true);
    setRuntimeSettingsError('');
    api
      .getRuntimeSettings()
      .then((view: RuntimeSettingsView) => {
        if (!active) {
          return;
        }
        setRuntimeDisableSimulatedTrainFallback(view.controls.disable_simulated_train_fallback);
        setRuntimeDisableInferenceFallback(view.controls.disable_inference_fallback);
        setRuntimePythonBin(view.controls.python_bin.trim());
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setRuntimeSettingsError((error as Error).message);
      })
      .finally(() => {
        if (active) {
          setRuntimeSettingsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

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

  const datasetsById = useMemo(
    () => new Map(datasets.map((dataset) => [dataset.id, dataset])),
    [datasets]
  );

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

  if (!jobId) {
    return (
      <WorkspacePage>
        <PageHeader
        eyebrow={t('Training detail')}
        title={t('Job detail')}
        description={t('Review status, logs, and metrics for the selected training run.')}
          secondaryActions={
            <ButtonLink to="/training/jobs" variant="ghost" size="sm">
              {t('Back to jobs')}
            </ButtonLink>
          }
        />
        <StateBlock variant="error" title={t('Missing Job ID')} description={t('Open from training jobs list.')} />
      </WorkspacePage>
    );
  }

  if (loading) {
    return (
      <WorkspacePage>
        <PageHeader
        eyebrow={t('Training detail')}
        title={t('Job detail')}
        description={t('Review status, logs, and metrics for the selected training run.')}
          secondaryActions={
            <ButtonLink to="/training/jobs" variant="ghost" size="sm">
              {t('Back to jobs')}
            </ButtonLink>
          }
        />
        <StateBlock variant="loading" title={t('Loading')} description={t('Fetching job detail.')} />
      </WorkspacePage>
    );
  }

  if (!job) {
    return (
      <WorkspacePage>
        <PageHeader
        eyebrow={t('Training detail')}
        title={t('Job detail')}
        description={t('Review status, logs, and metrics for the selected training run.')}
          secondaryActions={
            <ButtonLink to="/training/jobs" variant="ghost" size="sm">
              {t('Back to jobs')}
            </ButtonLink>
          }
        />
        <StateBlock variant="error" title={t('Not Found')} description={t('Training job does not exist.')} />
      </WorkspacePage>
    );
  }

  const canCancel = ['queued', 'preparing', 'running'].includes(job.status);
  const canRetry = ['failed', 'cancelled'].includes(job.status);
  const isInterrupted = job.status === 'failed' || job.status === 'cancelled';
  const linkedDataset = datasetsById.get(job.dataset_id);
  const queryScopedDatasetId = (searchParams.get('dataset') ?? '').trim();
  const queryScopedVersionId = (searchParams.get('version') ?? '').trim();
  const scopedDatasetId = queryScopedDatasetId || job.dataset_id;
  const scopedVersionId = queryScopedVersionId || job.dataset_version_id;
  const datasetDisplayName = linkedDataset?.name ?? t('Dataset record unavailable');
  const scopedJobsPath = buildScopedTrainingJobsPath(scopedDatasetId, scopedVersionId);
  const scopedInferencePath = buildScopedInferencePath(scopedDatasetId, scopedVersionId);
  const versionSnapshotLabel = job.dataset_version_id ? t('Version set') : t('Version pending');
  const executionTargetLabel = job.execution_target === 'worker' ? t('Worker lane') : t('Control plane');
  const describeSelectedWorker = (
    executionTarget: TrainingJobRecord['execution_target'],
    workerId: string | null
  ) => {
    if (executionTarget === 'control_plane') {
      return t('Local lane');
    }

    if (workerId) {
      return t('Worker set');
    }

    return t('Worker pending');
  };
  const latestUpdateLabel = formatCompactTimestamp(job.updated_at, t('n/a'));
  const executionInsight = deriveTrainingExecutionInsight({
    status: job.status,
    executionMode: job.execution_mode,
    artifactSummary
  });
  const executionRealityLabel =
    executionInsight.reality === 'real'
      ? t('Real execution')
      : executionInsight.reality === 'template'
        ? t('Fallback')
        : executionInsight.reality === 'simulated'
          ? t('Fallback')
          : t('Needs verification');
  const formatFallbackReasonLabel = (reason: string | null | undefined): string =>
    t(runtimeFallbackReasonLabelKey(bucketRuntimeFallbackReason(reason)));
  const trimmedLogExcerpt = job.log_excerpt.trim();
  const hasTechnicalContext = Boolean(
    workspaceDir ||
      artifactSummary?.primary_model_path ||
      job.scheduler_decision?.selected_worker_id ||
      (job.scheduler_decision?.excluded_worker_ids.length ?? 0) > 0
  );
  const refreshDetail = () => {
    load('manual')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  };

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Training detail')}
        title={job.name}
        description={t('Track readiness, metrics, worker delivery, and artifact handoff for this training run.')}
        meta={
          <div className="row gap wrap align-center">
            <StatusTag status={job.status}>{t(job.status)}</StatusTag>
            <Badge tone={artifactAttachmentId ? 'success' : 'neutral'}>
              {t('Artifact')}: {artifactAttachmentId ? t('Ready') : t('Pending')}
            </Badge>
          </div>
        }
        primaryAction={{
          label: refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: refreshDetail,
          disabled: loading || refreshing || busy
        }}
        secondaryActions={
          <>
            <ButtonLink to={scopedJobsPath} variant="ghost" size="sm">
              {t('Back to jobs')}
            </ButtonLink>
          </>
        }
      />

      {feedback ? (
        <InlineAlert
          tone={feedback.variant === 'success' ? 'success' : 'danger'}
          title={feedback.variant === 'success' ? t('Done') : t('Failed')}
          description={feedback.text}
        />
      ) : null}

      {isInterrupted && !feedback ? (
        <InlineAlert
          tone="danger"
          title={t('Interrupted')}
          description={t('Job is {status}. Retry from here when ready.', {
            status: t(job.status)
          })}
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Primary actions')}</h3>
                <small className="muted">{t('Cancel or retry this run.')}</small>
              </div>
              <div className="workspace-toolbar-actions">
                {canCancel ? (
                  <Button type="button" variant="danger" size="sm" onClick={cancelJob} disabled={busy}>
                    {t('Cancel')}
                  </Button>
                ) : null}
                {canRetry ? (
                  <Button type="button" variant="secondary" size="sm" onClick={retryJob} disabled={busy}>
                    {t('Retry')}
                  </Button>
                ) : null}
              </div>
            </div>
            {artifactAttachmentId ? (
              <details className="workspace-details">
                <summary>{t('More actions')}</summary>
                <div className="workspace-disclosure-content">
                  <Button type="button" variant="ghost" size="sm" onClick={downloadArtifact}>
                    {t('Download artifact')}
                  </Button>
                </div>
              </details>
            ) : null}
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="section" className="stack">
              <WorkspaceSectionHeader
                title={t('Run summary')}
                description={t('Dataset, base model, and artifact status.')}
              />
              <DetailList
                items={[
                  { label: t('Status'), value: <StatusTag status={job.status}>{t(job.status)}</StatusTag> },
                  { label: t('Dataset'), value: datasetDisplayName },
                  { label: t('Base model'), value: job.base_model },
                  { label: t('Version snapshot'), value: versionSnapshotLabel },
                  { label: t('Lane'), value: executionTargetLabel },
                  {
                    label: t('Artifact'),
                    value: artifactAttachmentId ? (
                      <div className="row gap wrap align-center">
                        <Badge tone="success">{t('Ready')}</Badge>
                        <Button type="button" variant="ghost" size="sm" onClick={downloadArtifact}>
                          {t('Download artifact')}
                        </Button>
                      </div>
                    ) : (
                      t('Pending')
                    )
                  }
                ]}
              />
              {job.status === 'completed' ? (
                <InlineAlert
                  tone={executionInsight.showWarning ? 'warning' : 'success'}
                  title={
                    executionInsight.showWarning ? t('Verify before publishing') : t('Training complete')
                  }
                  description={
                    executionInsight.showWarning
                      ? t('The run is complete, but the evidence is not complete yet.')
                      : t('Next you can validate inference or register a version.')
                  }
                  actions={
                    executionInsight.showWarning ? (
                      <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                        {t('Open runtime settings')}
                      </ButtonLink>
                    ) : (
                      <ButtonLink to={scopedInferencePath} variant="secondary" size="sm">
                        {t('Validate inference')}
                      </ButtonLink>
                    )
                  }
                />
              ) : job.status === 'failed' || job.status === 'cancelled' ? (
                <InlineAlert
                  tone="danger"
                  title={t('Run ended early')}
                  description={t('Review logs and metrics before retrying.')}
                />
              ) : (
                <small className="muted">{t('Refresh again when status changes.')}</small>
              )}
            </Card>

            <SectionCard
              title={t('Run evidence')}
              description={t('Artifacts, metrics, and logs.')}
              actions={
                <div className="row gap wrap">
                  <Button
                    type="button"
                    variant={evidenceView === 'overview' ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setEvidenceView('overview')}
                  >
                    {t('Summary')}
                  </Button>
                  <Button
                    type="button"
                    variant={evidenceView === 'metrics' ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setEvidenceView('metrics')}
                  >
                    {t('Metrics')}
                  </Button>
                  <Button
                    type="button"
                    variant={evidenceView === 'logs' ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setEvidenceView('logs')}
                  >
                    {t('Logs')}
                  </Button>
                </div>
              }
            >
              {evidenceView === 'overview' ? (
                <div className="stack">
                  {artifactSummary ? (
                    <Panel className="stack tight" tone="soft">
                      <div className="row gap wrap">
                        <Badge tone="neutral">
                          {t('Runner mode')}: {artifactSummary.mode || t('Pending')}
                        </Badge>
                        {artifactSummary.training_performed !== null ? (
                          <Badge tone={artifactSummary.training_performed ? 'success' : 'warning'}>
                            {t('Training')}: {artifactSummary.training_performed ? t('Yes') : t('No')}
                          </Badge>
                        ) : null}
                        {artifactSummary.sampled_items !== null ? (
                          <Badge tone="info">{t('Sampled items')}: {artifactSummary.sampled_items}</Badge>
                        ) : null}
                        {artifactSummary.generated_at ? (
                          <Badge tone="neutral">
                            {t('Artifact generated at')}:{' '}
                            {formatCompactTimestamp(artifactSummary.generated_at, t('n/a'))}
                          </Badge>
                        ) : null}
                      </div>
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
                          {t('Fallback reason')}: {formatFallbackReasonLabel(artifactSummary.fallback_reason)}
                        </small>
                      ) : null}
                    </Panel>
                  ) : null}
                  {latestMetrics.length === 0 ? (
                    <small className="muted">{t('No metrics yet.')}</small>
                  ) : (
                    <small className="muted">
                      {t('{count} metrics ready.', { count: latestMetrics.length })}
                    </small>
                  )}
                  {trimmedLogExcerpt ? (
                    <Panel className="stack tight" tone="soft">
                      <strong>{t('Latest logs')}</strong>
                      <pre className="code-block">{trimmedLogExcerpt}</pre>
                    </Panel>
                  ) : (
                    <small className="muted">{t('No log summary yet.')}</small>
                  )}
                </div>
              ) : evidenceView === 'metrics' ? (
                <div className="stack">
                  {latestMetrics.length > 0 ? (
                    <div className="row gap wrap">
                      {latestMetrics.map((metric) => (
                        <Badge key={metric.id} tone="neutral">
                          {metric.metric_name}: {metric.metric_value.toFixed(4)} · {t('step')} {metric.step}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <small className="muted">{t('No metrics yet.')}</small>
                  )}
                  <details className="workspace-details">
                    <summary>{t('Metric timeline')}</summary>
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
                  {metricCurves.length > 0 ? (
                    <details className="workspace-details">
                      <summary>{t('Metric curves')}</summary>
                      <div className="metric-chart-grid">
                        {metricCurves.map((curve) => (
                          <article key={curve.metricName} className="metric-chart-card stack tight">
                            <div className="row between gap wrap align-center">
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
                    </details>
                  ) : null}
                </div>
              ) : (
                <div className="stack">
                  <small className="muted">{t('Logs live here.')}</small>
                  {logs.length === 0 ? (
                    <small className="muted">{t('No logs yet.')}</small>
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
                </div>
              )}
            </SectionCard>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="section" className="workspace-inspector-card">
              <WorkspaceSectionHeader title={t('Inspector')} description={t('Job snapshot.') } />
              <Panel as="section" className="stack tight" tone="soft">
                <div className="row between gap wrap align-center">
                  <strong>{job.name}</strong>
                  <StatusTag status={job.status}>{t(job.status)}</StatusTag>
                </div>
                <div className="row gap wrap">
                  <Badge tone="neutral">{t(job.task_type)}</Badge>
                  <Badge tone="neutral">{t(job.framework)}</Badge>
                  <Badge tone="info">{describeSelectedWorker(job.execution_target, job.scheduled_worker_id)}</Badge>
                  <Badge tone={executionInsight.reality === 'real' ? 'success' : 'warning'}>
                    {t('Result')}: {executionRealityLabel}
                  </Badge>
                </div>
                <small className="muted">
                  {t('Mode')}: {t(job.execution_mode)} · {t('Updated')}: {latestUpdateLabel}
                </small>
              </Panel>
            </Card>

            <SectionCard
              title={t('Runtime')}
              description={t('Python path and readiness.')}
              actions={
                <ButtonLink to="/settings/runtime" variant="ghost" size="sm">
                  {t('Open runtime settings')}
                </ButtonLink>
              }
            >
              {!runtimeSettingsLoading ? (
                runtimeSettingsError ? (
                  <InlineAlert
                    tone="warning"
                    title={t('Runtime unavailable')}
                    description={t('Go to Runtime settings.')}
                    actions={
                      <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                        {t('Open runtime settings')}
                      </ButtonLink>
                    }
                  />
                ) : (
                  <Panel className="stack tight" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{t('Status')}</strong>
                      <Badge
                        tone={
                          runtimeDisableSimulatedTrainFallback || runtimeDisableInferenceFallback
                            ? 'success'
                            : 'warning'
                        }
                      >
                        {runtimeDisableSimulatedTrainFallback || runtimeDisableInferenceFallback
                          ? t('Ready')
                          : t('Review')}
                      </Badge>
                    </div>
                    <div className="row gap wrap align-center">
                      <Badge tone="neutral">
                        {t('Python')}: {runtimePythonBin || t('default path')}
                      </Badge>
                    </div>
                  </Panel>
                )
              ) : null}
            </SectionCard>

            <SectionCard
              title={t('Advanced diagnostics')}
              description={t('Scheduler history, technical paths, and exports.')}
            >
              <div className="stack tight">
                <details className="workspace-details">
                  <summary>{t('Exports')}</summary>
                  <div className="row gap wrap">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={downloadMetricsJson}
                      disabled={exportingMetrics || exportingMetricsCsv || metrics.length === 0}
                    >
                      {exportingMetrics ? t('Exporting...') : t('Metrics JSON')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={downloadMetricsCsv}
                      disabled={exportingMetrics || exportingMetricsCsv || metrics.length === 0}
                    >
                      {exportingMetricsCsv ? t('Exporting...') : t('Metrics CSV')}
                    </Button>
                  </div>
                </details>

                {job.scheduler_decision ? (
                  <details className="workspace-details">
                    <summary>{t('Scheduler')}</summary>
                    <div className="stack tight">
                      <Panel className="stack tight" tone="soft">
                        <div className="row between align-center wrap">
                          <strong>{t('Scheduler')}</strong>
                          <small className="muted">
                            {formatCompactTimestamp(job.scheduler_decision.decided_at, t('n/a'))}
                          </small>
                        </div>
                        <div className="row gap wrap">
                          <Badge tone="neutral">
                            {t('Trigger')}: {t(job.scheduler_decision.trigger)}
                          </Badge>
                          <Badge tone="neutral">
                            {t('Attempt')}: {job.scheduler_decision.attempt}
                          </Badge>
                          <Badge tone={job.scheduler_decision.execution_target === 'worker' ? 'info' : 'warning'}>
                            {t('Lane')}: {t(job.scheduler_decision.execution_target)}
                          </Badge>
                          <Badge
                            tone={
                              job.scheduler_decision.execution_target === 'worker' &&
                              job.scheduler_decision.selected_worker_id
                                ? 'info'
                                : job.scheduler_decision.execution_target === 'control_plane'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {t('Worker')}:{' '}
                            {describeSelectedWorker(
                              job.scheduler_decision.execution_target,
                              job.scheduler_decision.selected_worker_id
                            )}
                          </Badge>
                        </div>
                        <small className="muted">{job.scheduler_decision.note}</small>
                      </Panel>
                      {schedulerDecisionHistory.length > 1 ? (
                        <details className="workspace-details">
                          <summary>
                            {t('Previous checks')} ({schedulerDecisionHistory.length})
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
                                  <small className="muted">
                                    {formatCompactTimestamp(decision.decided_at, t('n/a'))}
                                  </small>
                                </div>
                                <div className="row gap wrap">
                                  <Badge tone={decision.execution_target === 'worker' ? 'info' : 'warning'}>
                                    {t('Target')}: {t(decision.execution_target)}
                                  </Badge>
                                  <Badge tone="neutral">
                                    {t('Selected worker')}:{' '}
                                    {describeSelectedWorker(decision.execution_target, decision.selected_worker_id)}
                                  </Badge>
                                </div>
                                <small className="muted">{decision.note}</small>
                              </Panel>
                            ))}
                          </div>
                        </details>
                      ) : null}
                      {hasTechnicalContext ? (
                        <details className="workspace-details">
                          <summary>{t('Paths')}</summary>
                          <div className="stack tight">
                            {job.scheduler_decision.selected_worker_id ? (
                              <small className="muted">
                                {t('Worker ID: {id}', { id: job.scheduler_decision.selected_worker_id })}
                              </small>
                            ) : null}
                            {job.scheduler_decision.excluded_worker_ids.length > 0 ? (
                              <small className="muted">
                                {t('Excluded worker IDs: {ids}', {
                                  ids: job.scheduler_decision.excluded_worker_ids.join(', ')
                                })}
                              </small>
                            ) : null}
                            {artifactSummary?.primary_model_path ? (
                              <small className="muted">
                                {t('Primary model path')}: {artifactSummary.primary_model_path}
                              </small>
                            ) : null}
                            {workspaceDir ? (
                              <small className="muted">
                                {t('Workspace')}: {workspaceDir}
                              </small>
                            ) : null}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </details>
                ) : (
                  <small className="muted">{t('No scheduling update yet.')}</small>
                )}
              </div>
            </SectionCard>
          </div>
        }
      />
    </WorkspacePage>
  );
}
