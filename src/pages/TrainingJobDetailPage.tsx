import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  TrainingArtifactSummary,
  TrainingJobRecord,
  TrainingMetricRecord,
  RuntimeSettingsView
} from '../../shared/domain';
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
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { deriveTrainingExecutionInsight } from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';

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

const buildScopedDatasetDetailPath = (datasetId: string, versionId?: string | null): string => {
  if (!versionId?.trim()) {
    return `/datasets/${datasetId}`;
  }

  const searchParams = new URLSearchParams();
  searchParams.set('version', versionId.trim());
  return `/datasets/${datasetId}?${searchParams.toString()}`;
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

  const stepIndex = useMemo(() => {
    if (!job) {
      return 0;
    }

    const index = STATUS_STEPS.indexOf(job.status);
    return index >= 0 ? index : STATUS_STEPS.length - 1;
  }, [job]);
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

  const heroSection = (
    <WorkspaceHero
      eyebrow={t('Training Detail')}
      title={job ? job.name : t('Training Job Detail')}
      description={
        job
          ? t('Track readiness, metrics, worker delivery, and artifact handoff for this training run.')
          : t('Review status, logs, and metrics for the selected training run.')
      }
      stats={[
        { label: t('Status'), value: job ? t(job.status) : t('Pending') },
        {
          label: t('Version snapshot'),
          value: job ? (job.dataset_version_id ? t('Version bound') : t('Version pending')) : t('Pending')
        },
        { label: t('Artifact'), value: artifactAttachmentId ? t('Ready') : t('pending') }
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
  const linkedDataset = datasetsById.get(job.dataset_id);
  const queryScopedDatasetId = (searchParams.get('dataset') ?? '').trim();
  const queryScopedVersionId = (searchParams.get('version') ?? '').trim();
  const scopedDatasetId = queryScopedDatasetId || job.dataset_id;
  const scopedVersionId = queryScopedVersionId || job.dataset_version_id;
  const datasetDisplayName = linkedDataset?.name ?? t('Selected dataset record unavailable');
  const scopedJobsPath = buildScopedTrainingJobsPath(scopedDatasetId, scopedVersionId);
  const scopedInferencePath = buildScopedInferencePath(scopedDatasetId, scopedVersionId);
  const scopedDatasetDetailPath = buildScopedDatasetDetailPath(scopedDatasetId, scopedVersionId);
  const versionSnapshotLabel = job.dataset_version_id ? t('Version bound') : t('Version pending');
  const executionTargetLabel = job.execution_target === 'worker' ? t('Worker lane') : t('Control-plane lane');
  const describeSelectedWorker = (
    executionTarget: TrainingJobRecord['execution_target'],
    workerId: string | null
  ) => {
    if (executionTarget === 'control_plane') {
      return t('Local fallback');
    }

    if (workerId) {
      return t('Worker assigned');
    }

    return t('Awaiting worker assignment');
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
        ? t('Template execution')
        : executionInsight.reality === 'simulated'
          ? t('Simulated execution')
          : t('Unknown execution');
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

      {executionInsight.showWarning ? (
        <StateBlock
          variant={executionInsight.reality === 'simulated' ? 'error' : 'empty'}
          title={t('Template/Simulated Training Result')}
          description={
            executionInsight.fallbackReason
              ? t(
                  'Current training output is not produced by a fully real framework run. Verify runtime dependencies before publishing this version. Fallback reason from runner: {reason}',
                  {
                    reason: executionInsight.fallbackReason
                  }
                )
              : executionInsight.reality === 'unknown'
                ? t(
                    'Execution detail is still incomplete for this terminal run. Verify runtime dependencies and artifact metadata before publishing this version.'
                  )
                : t(
                    'Current training output is not produced by a fully real framework run. Verify runtime dependencies before publishing this version.'
                  )
          }
        />
      ) : null}
      {!runtimeSettingsLoading ? (
        runtimeSettingsError ? (
          <StateBlock
            variant="empty"
            title={t('Runtime strict mode status unavailable')}
            description={t('Unable to load runtime settings: {reason}', { reason: runtimeSettingsError })}
          />
        ) : runtimeDisableSimulatedTrainFallback || runtimeDisableInferenceFallback ? (
          <StateBlock
            variant="success"
            title={t('Runtime strict mode is active')}
            description={t(
              'Training and inference fallback guards are reflected in this workspace. Bundled runner python: {pythonBin}.',
              { pythonBin: runtimePythonBin || t('platform default (python3 / python)') }
            )}
            extra={
              <div className="row gap wrap">
                <Badge tone={runtimeDisableSimulatedTrainFallback ? 'success' : 'warning'}>
                  {t('Train strict')}: {runtimeDisableSimulatedTrainFallback ? t('yes') : t('no')}
                </Badge>
                <Badge tone={runtimeDisableInferenceFallback ? 'success' : 'warning'}>
                  {t('Inference strict')}: {runtimeDisableInferenceFallback ? t('yes') : t('no')}
                </Badge>
                <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                  {t('Open Runtime Settings')}
                </ButtonLink>
              </div>
            }
          />
        ) : (
          <StateBlock
            variant="error"
            title={t('Runtime strict mode is off')}
            description={t(
              'This training detail may still include fallback-generated evidence. Enable strict guards in Runtime settings before production approval.'
            )}
            extra={
              <ButtonLink to="/settings/runtime" variant="secondary" size="sm">
                {t('Open Runtime Settings')}
              </ButtonLink>
            }
          />
        )
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

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Run Controls')}</h3>
                <small className="muted">
                  {t('Keep operator actions, exports, and scoped navigation in one stable control strip.')}
                </small>
              </div>
              <div className="workspace-toolbar-actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={refreshDetail}
                  disabled={loading || refreshing || busy}
                >
                  {refreshing ? t('Refreshing...') : t('Refresh')}
                </Button>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={downloadMetricsJson}
                  disabled={exportingMetrics || exportingMetricsCsv || metrics.length === 0}
                  title={t('Export all metrics timeline in JSON format.')}
                >
                  {exportingMetrics ? t('Exporting...') : t('Metrics JSON')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={downloadMetricsCsv}
                  disabled={exportingMetrics || exportingMetricsCsv || metrics.length === 0}
                  title={t('Export all metrics timeline in CSV format.')}
                >
                  {exportingMetricsCsv ? t('Exporting...') : t('Metrics CSV')}
                </Button>
                {artifactAttachmentId ? (
                  <Button type="button" variant="ghost" size="sm" onClick={downloadArtifact}>
                    {t('Download Artifact')}
                  </Button>
                ) : null}
                <ButtonLink to={scopedJobsPath} variant="ghost" size="sm">
                  {t('Jobs List')}
                </ButtonLink>
                <ButtonLink to={scopedDatasetDetailPath} variant="ghost" size="sm">
                  {t('Dataset')}
                </ButtonLink>
                <ButtonLink to={scopedInferencePath} variant="ghost" size="sm">
                  {t('Validate')}
                </ButtonLink>
                <ButtonLink to="/models/versions" variant="ghost" size="sm">
                  {t('Model Versions')}
                </ButtonLink>
              </div>
            </div>
            <div className="workspace-toolbar-meta">
              <div className="workspace-segmented-actions">
                <Badge tone="neutral">{t('Dataset')}: {datasetDisplayName}</Badge>
                <Badge tone={job.dataset_version_id ? 'info' : 'warning'}>
                  {t('Version snapshot')}: {versionSnapshotLabel}
                </Badge>
                <Badge tone={job.execution_target === 'worker' ? 'info' : 'warning'}>
                  {t('Execution target')}: {executionTargetLabel}
                </Badge>
                <Badge tone="neutral">{t('Last updated')}: {latestUpdateLabel}</Badge>
                <Badge tone={artifactAttachmentId ? 'success' : 'neutral'}>
                  {t('Artifact')}: {artifactAttachmentId ? t('Ready') : t('pending')}
                </Badge>
              </div>
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            <Card as="section" className="stack">
              <WorkspaceSectionHeader
                title={t('Run Summary')}
                description={t('Dataset, launch state, scheduler trace, and handoff readiness for this run.')}
              />
              <div className="row gap wrap">
                <StatusTag status={job.status}>{t(job.status)}</StatusTag>
                <Badge tone="neutral">{t('Dataset')}: {datasetDisplayName}</Badge>
                <Badge tone="neutral">{t('Base model')}: {job.base_model}</Badge>
                <Badge tone={job.dataset_version_id ? 'success' : 'warning'}>
                  {t('Version snapshot')}: {versionSnapshotLabel}
                </Badge>
                <Badge tone={job.execution_target === 'worker' ? 'info' : 'warning'}>
                  {t('Execution target')}: {executionTargetLabel}
                </Badge>
                <Badge tone={artifactAttachmentId ? 'success' : 'warning'}>
                  {t('Artifact')}: {artifactAttachmentId ? t('Ready') : t('pending')}
                </Badge>
              </div>
              <small className="muted">
                {job.dataset_version_id
                  ? t('Dataset snapshot is already locked for this run.')
                  : t('Run is still preparing its version snapshot.')}
              </small>
              <small className="muted">
                {artifactAttachmentId
                  ? t('Artifact linked and ready for downstream use.')
                  : t('Artifact is still pending or unavailable for this version.')}
              </small>
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
                    <small className="muted">
                      {formatCompactTimestamp(job.scheduler_decision.decided_at, t('n/a'))}
                    </small>
                  </div>
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t('Trigger')}: {t(job.scheduler_decision.trigger)}</Badge>
                    <Badge tone="neutral">{t('Attempt')}: {job.scheduler_decision.attempt}</Badge>
                    <Badge tone={job.scheduler_decision.execution_target === 'worker' ? 'info' : 'warning'}>
                      {t('Target')}: {t(job.scheduler_decision.execution_target)}
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
                      {t('Selected worker')}:{' '}
                      {describeSelectedWorker(
                        job.scheduler_decision.execution_target,
                        job.scheduler_decision.selected_worker_id
                      )}
                    </Badge>
                  </div>
                  <details className="workspace-details">
                    <summary>{t('Scheduler score breakdown')}</summary>
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
                        {t('Capability bonus')}:{' '}
                        {job.scheduler_decision.selected_worker_capability_bonus?.toFixed(4) ?? t('n/a')}
                      </Badge>
                      <Badge tone="neutral">
                        {t('In flight')}: {job.scheduler_decision.selected_worker_in_flight_jobs ?? t('n/a')}
                      </Badge>
                      <Badge tone="neutral">
                        {t('Max concurrency')}: {job.scheduler_decision.selected_worker_max_concurrency ?? t('n/a')}
                      </Badge>
                    </div>
                  </details>
                  {job.scheduler_decision.excluded_worker_ids.length > 0 ? (
                    <small className="muted">
                      {t('Excluded worker count: {count}', {
                        count: job.scheduler_decision.excluded_worker_ids.length
                      })}
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
                                {t('Excluded worker count: {count}', {
                                  count: decision.excluded_worker_ids.length
                                })}
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
                  {hasTechnicalContext ? (
                    <details className="workspace-details">
                      <summary>{t('Technical context')}</summary>
                      <div className="stack tight">
                        <small className="muted">
                          {t('Storage paths and raw scheduler identifiers stay here when you need them.')}
                        </small>
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
                </Panel>
              ) : (
                <small className="muted">{t('Scheduler update not available yet.')}</small>
              )}
              {trimmedLogExcerpt ? (
                <details className="workspace-details">
                  <summary>{t('Latest log summary')}</summary>
                  <pre className="code-block">{trimmedLogExcerpt}</pre>
                </details>
              ) : null}
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
                      {t('Fallback reason')}: {artifactSummary.fallback_reason}
                    </small>
                  ) : null}
                </>
              ) : null}
            </Card>

            <Card as="section" className="stack">
              <WorkspaceSectionHeader
                title={t('Metrics')}
                description={t('Use JSON for structured integrations and CSV for spreadsheet analysis.')}
              />
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
              </Card>
            ) : null}

            <Card as="section" className="stack">
              <WorkspaceSectionHeader
                title={t('Training Logs')}
                description={t('Latest execution logs are shown here with optional backfill for earlier lines.')}
              />
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
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="section" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Run Inspector')}
                description={t('Selected run identity, scope, and current execution state.')}
              />
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
                    {t('Result authenticity')}: {executionRealityLabel}
                  </Badge>
                </div>
                <small className="muted">
                  {t('Execution mode')}: {t(job.execution_mode)} · {t('Last updated')}: {latestUpdateLabel}
                </small>
              </Panel>
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Dataset')}</span>
                  <small>{datasetDisplayName}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Version snapshot')}</span>
                  <strong>{versionSnapshotLabel}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Base model')}</span>
                  <small>{job.base_model}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Execution target')}</span>
                  <small>{executionTargetLabel}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Artifact')}</span>
                  <strong>{artifactAttachmentId ? t('Ready') : t('pending')}</strong>
                </div>
              </div>
              <small className="muted">
                {linkedDataset
                  ? t('Dataset scope stays pinned so downstream validation and version lookup remain reproducible.')
                  : t('Dataset record is unavailable, but run scope remains preserved from persisted job metadata.')}
              </small>
            </Card>

            <Card as="section" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Scheduler Snapshot')}
                description={t('Compact worker-routing context for quick operational triage.')}
              />
              {job.scheduler_decision ? (
                <>
                  <Panel as="section" className="stack tight" tone="soft">
                    <div className="row between gap wrap align-center">
                      <strong>{t(job.scheduler_decision.trigger)}</strong>
                      <Badge tone={job.scheduler_decision.execution_target === 'worker' ? 'info' : 'warning'}>
                        {t(job.scheduler_decision.execution_target)}
                      </Badge>
                    </div>
                    <small className="muted">
                      {formatCompactTimestamp(job.scheduler_decision.decided_at, t('n/a'))}
                    </small>
                    <small className="muted">{job.scheduler_decision.note}</small>
                  </Panel>
                  <div className="workspace-keyline-list">
                    <div className="workspace-keyline-item">
                      <span>{t('Attempt')}</span>
                      <strong>{job.scheduler_decision.attempt}</strong>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Selected worker')}</span>
                      <small>
                        {describeSelectedWorker(
                          job.scheduler_decision.execution_target,
                          job.scheduler_decision.selected_worker_id
                        )}
                      </small>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Score')}</span>
                      <small>{job.scheduler_decision.selected_worker_score?.toFixed(4) ?? t('n/a')}</small>
                    </div>
                    <div className="workspace-keyline-item">
                      <span>{t('Excluded')}</span>
                      <small>{job.scheduler_decision.excluded_worker_ids.length}</small>
                    </div>
                  </div>
                  {job.scheduler_decision.fallback_reason ? (
                    <small className="muted">
                      {t('Fallback reason')}: {job.scheduler_decision.fallback_reason}
                    </small>
                  ) : null}
                </>
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('No scheduler snapshot')}
                  description={t('Scheduler context will appear after the job enters a dispatchable state.')}
                />
              )}
            </Card>

            <Card as="section" className="workspace-inspector-card">
              <WorkspaceSectionHeader
                title={t('Outputs')}
                description={t('Artifact and runner metadata without leaving the detail lane.')}
              />
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Metrics points')}</span>
                  <strong>{metrics.length}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Log lines')}</span>
                  <strong>{logs.length}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Artifact')}</span>
                  <small>{artifactAttachmentId ? t('Attached') : t('Pending')}</small>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Workspace')}</span>
                  <small>{workspaceDir ?? '—'}</small>
                </div>
              </div>
              {artifactSummary ? (
                <Panel as="section" className="stack tight" tone="soft">
                  <div className="row gap wrap">
                    <Badge tone="neutral">{t('Runner mode')}: {artifactSummary.mode || t('pending')}</Badge>
                    <Badge tone="neutral">{t('Runner')}: {artifactSummary.runner || t('pending')}</Badge>
                    {artifactSummary.sampled_items !== null ? (
                      <Badge tone="info">{t('Sampled items')}: {artifactSummary.sampled_items}</Badge>
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
                      {t('Fallback reason')}: {artifactSummary.fallback_reason}
                    </small>
                  ) : null}
                </Panel>
              ) : (
                <small className="muted">{t('Artifact summary will appear after runner output is captured.')}</small>
              )}
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
