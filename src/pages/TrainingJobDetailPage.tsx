import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  ModelRecord,
  ModelVersionRecord,
  TrainingWorkerNodeView,
  TrainingArtifactSummary,
  TrainingJobRecord,
  TrainingMetricRecord,
  RuntimeSettingsView
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import VirtualList from '../components/VirtualList';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { DetailList, InlineAlert, PageHeader, SectionCard } from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
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
const adminAccessMessagePattern = /(forbidden|permission|unauthorized|not allowed|admin|管理员|权限)/i;
const errorHintMaxLength = 200;
const errorHintPreviewLimit = 5;
const errorHintContextRadius = 2;

type LoadMode = 'initial' | 'manual' | 'background';
type LaunchContext = {
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
};
type TroubleshootingRecommendation = {
  id: string;
  title: string;
  detail: string;
  action: 'runtime' | 'worker_settings' | 'control_plane_retry' | 'refresh_logs' | 'none';
};

const deriveTroubleshootingRecommendations = (input: {
  t: (source: string, vars?: Record<string, string | number>) => string;
  summaryText: string;
  jobStatus: TrainingJobRecord['status'] | null;
  executionTarget: TrainingJobRecord['execution_target'] | null;
  hasMatches: boolean;
  queryLength: number;
}): TroubleshootingRecommendation[] => {
  const { t, summaryText, jobStatus, executionTarget, hasMatches, queryLength } = input;
  const text = summaryText.toLowerCase();
  const items: TroubleshootingRecommendation[] = [];
  const append = (item: TroubleshootingRecommendation) => {
    if (items.some((existing) => existing.id === item.id)) {
      return;
    }
    items.push(item);
  };

  if (queryLength > 0 && queryLength < 3) {
    append({
      id: 'query_too_short',
      title: t('Use a longer keyword'),
      detail: t('Use at least 3 characters so matching is more stable and less noisy.'),
      action: 'none'
    });
  }
  if (!hasMatches && queryLength >= 3) {
    append({
      id: 'no_matches',
      title: t('Broaden keyword and check full logs'),
      detail: t('Current keyword has no matches. Try a shorter core phrase and inspect nearby logs.'),
      action: 'refresh_logs'
    });
  }
  if (/(module not found|no module named|importerror|pip|python|dependency|command not found)/i.test(text)) {
    append({
      id: 'runtime_issue',
      title: t('Review runtime environment'),
      detail: t('The error hints at missing runtime dependencies or python configuration.'),
      action: 'runtime'
    });
  }
  if (/(worker|offline|heartbeat|timeout|connection refused|unreachable)/i.test(text)) {
    append({
      id: 'worker_path_issue',
      title: t('Retry on control-plane lane'),
      detail: t('Worker availability seems unstable. Switch retry dispatch to control-plane to unblock quickly.'),
      action: 'control_plane_retry'
    });
  }
  if (/(permission|forbidden|unauthorized|access denied|eacces|权限|拒绝)/i.test(text)) {
    append({
      id: 'permission_issue',
      title: t('Check worker/account permissions'),
      detail: t('The error hints at authorization or access limits on current execution path.'),
      action: executionTarget === 'worker' ? 'worker_settings' : 'runtime'
    });
  }
  if (/(dataset|annotation|label|file not found|no such file|missing|not found)/i.test(text)) {
    append({
      id: 'data_issue',
      title: t('Verify dataset and artifact paths'),
      detail: t('The error hints at missing files, labels, or dataset path mismatches.'),
      action: 'refresh_logs'
    });
  }
  if (items.length === 0 && (jobStatus === 'failed' || jobStatus === 'cancelled')) {
    append({
      id: 'generic_retry',
      title: t('Recheck logs then retry'),
      detail: t('Open full logs once, then retry with a clear dispatch choice to collect cleaner evidence.'),
      action: executionTarget === 'worker' ? 'control_plane_retry' : 'refresh_logs'
    });
  }
  return items;
};

const appendTrainingLaunchContext = (searchParams: URLSearchParams, context?: LaunchContext) => {
  if (!context) {
    return;
  }
  if (context.taskType?.trim() && !searchParams.has('task_type')) {
    searchParams.set('task_type', context.taskType.trim());
  }
  if (context.framework?.trim() && !searchParams.has('framework')) {
    searchParams.set('framework', context.framework.trim());
  }
  if (
    context.executionTarget?.trim() &&
    context.executionTarget.trim() !== 'auto' &&
    !searchParams.has('execution_target')
  ) {
    searchParams.set('execution_target', context.executionTarget.trim());
  }
  if (context.workerId?.trim() && !searchParams.has('worker')) {
    searchParams.set('worker', context.workerId.trim());
  }
};

const sanitizeReturnToPath = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return null;
  }
  return trimmed;
};

const appendReturnTo = (searchParams: URLSearchParams, returnTo?: string | null) => {
  const safeReturnTo = sanitizeReturnToPath(returnTo);
  if (safeReturnTo && !searchParams.has('return_to')) {
    searchParams.set('return_to', safeReturnTo);
  }
};

const buildScopedInferencePath = (
  datasetId: string,
  versionId?: string | null,
  modelVersionId?: string | null,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  if (modelVersionId?.trim()) {
    searchParams.set('modelVersion', modelVersionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/inference/validate?${searchParams.toString()}`;
};

const buildScopedClosurePath = (
  datasetId: string,
  versionId?: string | null,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/workflow/closure?${searchParams.toString()}`;
};

const buildScopedModelVersionsPath = (
  job: TrainingJobRecord,
  versionName?: string,
  selectedVersionId?: string,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('job', job.id);
  if (versionName?.trim()) {
    searchParams.set('version_name', versionName.trim());
  }
  if (selectedVersionId?.trim()) {
    searchParams.set('selectedVersion', selectedVersionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/versions?${searchParams.toString()}`;
};

const buildScopedVersionDeliveryPath = (
  job: TrainingJobRecord,
  versionName?: string,
  selectedVersionId?: string,
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('job', job.id);
  if (versionName?.trim()) {
    searchParams.set('version_name', versionName.trim());
  }
  if (selectedVersionId?.trim()) {
    searchParams.set('selectedVersion', selectedVersionId.trim());
    searchParams.set('focus', 'device');
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/models/versions?${searchParams.toString()}`;
};

const buildCreateModelDraftPath = (
  taskType?: string,
  options?: {
    jobId?: string;
    versionName?: string;
  },
  launchContext?: LaunchContext
): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  if (taskType?.trim()) {
    searchParams.set('task_type', taskType.trim());
  }
  if (options?.jobId?.trim()) {
    searchParams.set('job', options.jobId.trim());
  }
  if (options?.versionName?.trim()) {
    searchParams.set('version_name', options.versionName.trim());
  }
  const query = searchParams.toString();
  return query ? `/models/create?${query}` : '/models/create';
};

const buildRuntimeSettingsPath = (
  focus: 'setup' | 'readiness' | 'advanced' = 'readiness',
  framework?: string | null,
  launchContext?: LaunchContext,
  returnTo?: string | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', focus);
  if (framework?.trim()) {
    searchParams.set('framework', framework.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  return `/settings/runtime?${searchParams.toString()}`;
};

const buildWorkerSettingsPath = (
  job?: TrainingJobRecord | null,
  launchContext?: LaunchContext,
  returnTo?: string | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'inventory');
  if (job?.framework) {
    searchParams.set('profile', job.framework);
  }
  if (job?.scheduled_worker_id) {
    searchParams.set('worker', job.scheduled_worker_id);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  return `/settings/workers?${searchParams.toString()}`;
};

export default function TrainingJobDetailPage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const { jobId } = useParams<{ jobId: string }>();
  const [searchParams] = useSearchParams();
  const operationErrorHint = useMemo(
    () => (searchParams.get('error_hint') ?? '').trim().slice(0, errorHintMaxLength),
    [searchParams]
  );
  const errorMatchQueryFromQuery = useMemo(
    () => (searchParams.get('error_match') ?? '').trim().slice(0, errorHintMaxLength),
    [searchParams]
  );
  const resolvedErrorMatchQuery = errorMatchQueryFromQuery || operationErrorHint;
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const [job, setJob] = useState<TrainingJobRecord | null>(null);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [modelVersions, setModelVersions] = useState<ModelVersionRecord[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
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
  const [workersLoading, setWorkersLoading] = useState(false);
  const [workers, setWorkers] = useState<TrainingWorkerNodeView[]>([]);
  const [workersAccessDenied, setWorkersAccessDenied] = useState(false);
  const [workersError, setWorkersError] = useState('');
  const [retryDispatchPreference, setRetryDispatchPreference] = useState<'auto' | 'control_plane' | 'worker'>('auto');
  const [retryWorkerId, setRetryWorkerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportingMetrics, setExportingMetrics] = useState(false);
  const [exportingMetricsCsv, setExportingMetricsCsv] = useState(false);
  const [visibleLogCount, setVisibleLogCount] = useState(logsBatchSize);
  const [errorMatchQuery, setErrorMatchQuery] = useState(resolvedErrorMatchQuery);
  const [activeMatchedErrorIndex, setActiveMatchedErrorIndex] = useState(0);
  const [copiedTroubleshootingBundle, setCopiedTroubleshootingBundle] = useState(false);
  const [troubleshootingBundleCopyError, setTroubleshootingBundleCopyError] = useState('');
  const [recommendationActionBusy, setRecommendationActionBusy] = useState('');
  const [recommendationActionFeedback, setRecommendationActionFeedback] = useState<{
    variant: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [scopedContextSyncHint, setScopedContextSyncHint] = useState('');
  const [evidenceView, setEvidenceView] = useState<'overview' | 'metrics' | 'logs'>(() => {
    const value = (searchParams.get('evidence') ?? '').trim().toLowerCase();
    if (value === 'metrics' || value === 'logs') {
      return value;
    }
    return 'overview';
  });
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const detailSignatureRef = useRef('');
  const retryDispatchTouchedRef = useRef(false);
  const scopedContextSyncAppliedRef = useRef('');
  const logsBlockRef = useRef<HTMLPreElement | null>(null);
  const scopedDatasetIdFromQuery = (searchParams.get('dataset') ?? '').trim();
  const scopedVersionIdFromQuery = (searchParams.get('version') ?? '').trim();
  const launchTaskTypeFromQuery = (searchParams.get('task_type') ?? '').trim();
  const launchFrameworkFromQuery = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
  const launchExecutionTargetFromQuery = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
  const launchWorkerFromQuery = (searchParams.get('worker') ?? '').trim();
  const launchContextForDetail = useMemo(
    () => ({
      taskType: launchTaskTypeFromQuery || job?.task_type || null,
      framework: launchFrameworkFromQuery || job?.framework || null,
      executionTarget: launchExecutionTargetFromQuery || job?.execution_target || null,
      workerId: launchWorkerFromQuery || job?.scheduled_worker_id || null
    }),
    [
      job?.execution_target,
      job?.framework,
      job?.scheduled_worker_id,
      job?.task_type,
      launchExecutionTargetFromQuery,
      launchFrameworkFromQuery,
      launchTaskTypeFromQuery,
      launchWorkerFromQuery
    ]
  );
  const backToJobsSearchParams = new URLSearchParams(searchParams);
  backToJobsSearchParams.delete('created');
  const backToJobsQuery = backToJobsSearchParams.toString();
  const backToJobsPath = backToJobsQuery ? `/training/jobs?${backToJobsQuery}` : '/training/jobs';
  const clearOperationErrorHintPath = useMemo(() => {
    if (!operationErrorHint) {
      return '';
    }
    const next = new URLSearchParams(searchParams);
    next.delete('error_hint');
    next.delete('error_match');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, operationErrorHint, searchParams]);
  const fallbackBackToJobsPath = requestedReturnTo ?? backToJobsPath;
  const backToJobsActionLabel =
    requestedReturnTo && !requestedReturnTo.startsWith('/training/jobs')
      ? t('Return to current task')
      : t('Back to jobs');
  const clearScopedContextPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('dataset');
    next.delete('version');
    next.delete('task_type');
    next.delete('model_type');
    next.delete('framework');
    next.delete('profile');
    next.delete('execution_target');
    next.delete('worker');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);

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
      const [detail, datasetResult, modelResult, versionResult] = await Promise.all([
        api.getTrainingJobDetail(jobId),
        api.listDatasets().catch(() => [] as DatasetRecord[]),
        api.listMyModels().catch(() => null),
        api.listModelVersions().catch(() => [] as ModelVersionRecord[])
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
        })),
        models: modelResult
          ? modelResult.map((model) => ({
              id: model.id,
              name: model.name,
              model_type: model.model_type,
              updated_at: model.updated_at
            }))
          : [],
        model_versions: versionResult.map((version) => ({
          id: version.id,
          model_id: version.model_id,
          status: version.status,
          version_name: version.version_name,
          training_job_id: version.training_job_id,
          created_at: version.created_at
        }))
      });

      if (detailSignatureRef.current !== nextSignature) {
        detailSignatureRef.current = nextSignature;
        setJob(detail.job);
        setDatasets(datasetResult);
        setModels(modelResult ?? []);
        setModelVersions(versionResult);
        setModelsLoaded(Boolean(modelResult));
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
    const evidenceValue = (searchParams.get('evidence') ?? '').trim().toLowerCase();
    const nextEvidenceView: 'overview' | 'metrics' | 'logs' =
      evidenceValue === 'metrics' || evidenceValue === 'logs' ? evidenceValue : 'overview';
    if (nextEvidenceView !== evidenceView) {
      setEvidenceView(nextEvidenceView);
    }
  }, [searchParams]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (evidenceView === 'overview') {
      next.delete('evidence');
    } else {
      next.set('evidence', evidenceView);
    }

    const currentQuery = searchParams.toString();
    const nextQuery = next.toString();
    if (nextQuery === currentQuery) {
      return;
    }

    navigate(nextQuery ? `${location.pathname}?${nextQuery}` : location.pathname, {
      replace: true
    });
  }, [evidenceView, location.pathname, navigate, searchParams]);

  useEffect(() => {
    setScopedContextSyncHint('');
    scopedContextSyncAppliedRef.current = '';
  }, [jobId]);

  useEffect(() => {
    if (!job) {
      return;
    }

    const next = new URLSearchParams(searchParams);
    const mismatchTokens: string[] = [];
    const expectedVersionId = job.dataset_version_id ?? '';
    const expectedWorkerId = job.scheduled_worker_id ?? '';

    if (scopedDatasetIdFromQuery && scopedDatasetIdFromQuery !== job.dataset_id) {
      mismatchTokens.push('dataset');
      next.set('dataset', job.dataset_id);
    }
    if (scopedVersionIdFromQuery && scopedVersionIdFromQuery !== expectedVersionId) {
      mismatchTokens.push('version');
      if (expectedVersionId) {
        next.set('version', expectedVersionId);
      } else {
        next.delete('version');
      }
    }
    if (launchTaskTypeFromQuery && launchTaskTypeFromQuery !== job.task_type) {
      mismatchTokens.push('task_type');
      next.set('task_type', job.task_type);
    }
    if (launchFrameworkFromQuery && launchFrameworkFromQuery !== job.framework) {
      mismatchTokens.push('framework');
      next.set('framework', job.framework);
      next.delete('profile');
    }
    if (launchExecutionTargetFromQuery && launchExecutionTargetFromQuery !== job.execution_target) {
      mismatchTokens.push('execution_target');
      next.set('execution_target', job.execution_target);
    }
    if (launchWorkerFromQuery && launchWorkerFromQuery !== expectedWorkerId) {
      mismatchTokens.push('worker');
      if (expectedWorkerId) {
        next.set('worker', expectedWorkerId);
      } else {
        next.delete('worker');
      }
    }

    if (mismatchTokens.length === 0) {
      return;
    }

    const syncKey = `${job.id}:${mismatchTokens.join(',')}:${searchParams.toString()}`;
    if (scopedContextSyncAppliedRef.current === syncKey) {
      return;
    }
    scopedContextSyncAppliedRef.current = syncKey;
    setScopedContextSyncHint(t('Synced scoped context to match job {jobId}.', { jobId: job.id }));

    const nextQuery = next.toString();
    const currentQuery = searchParams.toString();
    if (nextQuery === currentQuery) {
      return;
    }
    navigate(nextQuery ? `${location.pathname}?${nextQuery}` : location.pathname, { replace: true });
  }, [
    job,
    launchExecutionTargetFromQuery,
    launchFrameworkFromQuery,
    launchTaskTypeFromQuery,
    launchWorkerFromQuery,
    location.pathname,
    navigate,
    scopedDatasetIdFromQuery,
    scopedVersionIdFromQuery,
    searchParams,
    t
  ]);

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

  useEffect(() => {
    let active = true;
    setWorkersLoading(true);
    setWorkersError('');
    setWorkersAccessDenied(false);
    api
      .listTrainingWorkers()
      .then((inventory) => {
        if (!active) {
          return;
        }
        setWorkers(inventory);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        const message = (error as Error).message;
        setWorkers([]);
        if (adminAccessMessagePattern.test(message)) {
          setWorkersAccessDenied(true);
          setWorkersError('');
          return;
        }
        setWorkersError(message);
      })
      .finally(() => {
        if (active) {
          setWorkersLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!job || retryDispatchTouchedRef.current) {
      return;
    }
    if (!['failed', 'cancelled'].includes(job.status)) {
      return;
    }

    if (job.execution_target === 'control_plane') {
      setRetryDispatchPreference('control_plane');
      setRetryWorkerId('');
      return;
    }

    setRetryDispatchPreference('worker');
    setRetryWorkerId(job.scheduled_worker_id ?? '');
  }, [job]);

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
  const modelsById = useMemo(
    () => new Map(models.map((model) => [model.id, model])),
    [models]
  );
  const matchingOwnedModel = useMemo(() => {
    if (!job || !modelsLoaded) {
      return null;
    }

    return models.find((model) => model.model_type === job.task_type) ?? null;
  }, [job, models, modelsLoaded]);

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
  const onlineWorkers = useMemo(
    () =>
      workers.filter(
        (worker) => worker.enabled && worker.effective_status === 'online' && Boolean(worker.endpoint)
      ),
    [workers]
  );
  const selectedRetryWorker = useMemo(
    () => workers.find((worker) => worker.id === retryWorkerId) ?? null,
    [retryWorkerId, workers]
  );
  const retryWorkerAvailable =
    !retryWorkerId || workersLoading || workersAccessDenied || Boolean(selectedRetryWorker);
  const retryDispatchSummary = useMemo(() => {
    if (retryDispatchPreference === 'auto') {
      return t('Scheduler chooses between worker and control-plane automatically.');
    }
    if (retryDispatchPreference === 'control_plane') {
      return t('Run will stay on control-plane local execution path.');
    }
    if (retryWorkerId) {
      if (workersLoading || workersAccessDenied) {
        return t('Worker inventory is unavailable. Worker ID will be validated at submit time.');
      }
      return selectedRetryWorker
        ? t('Worker dispatch is pinned to {worker}.', { worker: selectedRetryWorker.name })
        : t('Pinned worker is not in current inventory.');
    }
    return t('Worker dispatch is required. Scheduler will pick one online eligible worker.');
  }, [
    retryDispatchPreference,
    retryWorkerId,
    selectedRetryWorker,
    t,
    workersAccessDenied,
    workersLoading
  ]);

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
  const trimmedErrorMatchQuery = errorMatchQuery.trim();
  const normalizedErrorMatchQuery = trimmedErrorMatchQuery.toLowerCase();
  const matchedErrorLogLines = useMemo(() => {
    if (!normalizedErrorMatchQuery || normalizedErrorMatchQuery.length < 3) {
      return [] as Array<{ lineNumber: number; content: string }>;
    }
    const matches: Array<{ lineNumber: number; content: string }> = [];
    logs.forEach((line, index) => {
      if (matches.length >= errorHintPreviewLimit) {
        return;
      }
      if (line.toLowerCase().includes(normalizedErrorMatchQuery)) {
        matches.push({
          lineNumber: index + 1,
          content: line
        });
      }
    });
    return matches;
  }, [logs, normalizedErrorMatchQuery]);
  const activeMatchedErrorLine =
    matchedErrorLogLines.length > 0 ? matchedErrorLogLines[activeMatchedErrorIndex] ?? null : null;
  const activeMatchedErrorContextLines = useMemo(() => {
    if (!activeMatchedErrorLine) {
      return [] as Array<{ lineNumber: number; content: string; active: boolean }>;
    }
    const startLine = Math.max(1, activeMatchedErrorLine.lineNumber - errorHintContextRadius);
    const endLine = Math.min(logs.length, activeMatchedErrorLine.lineNumber + errorHintContextRadius);
    const context: Array<{ lineNumber: number; content: string; active: boolean }> = [];
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      context.push({
        lineNumber,
        content: logs[lineNumber - 1] ?? '',
        active: lineNumber === activeMatchedErrorLine.lineNumber
      });
    }
    return context;
  }, [activeMatchedErrorLine, logs]);
  const troubleshootingRecommendations = useMemo(
    () =>
      deriveTroubleshootingRecommendations({
        t,
        summaryText: [
          operationErrorHint,
          trimmedErrorMatchQuery,
          activeMatchedErrorLine?.content ?? ''
        ]
          .filter(Boolean)
          .join('\n'),
        jobStatus: job?.status ?? null,
        executionTarget: job?.execution_target ?? null,
        hasMatches: matchedErrorLogLines.length > 0,
        queryLength: trimmedErrorMatchQuery.length
      }),
    [
      activeMatchedErrorLine?.content,
      job?.execution_target,
      job?.status,
      matchedErrorLogLines.length,
      operationErrorHint,
      t,
      trimmedErrorMatchQuery
    ]
  );
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
  useEffect(() => {
    if (evidenceView !== 'logs' || !operationErrorHint || logs.length === 0) {
      return;
    }
    setVisibleLogCount(logs.length);
  }, [evidenceView, logs.length, operationErrorHint]);
  useEffect(() => {
    setErrorMatchQuery(resolvedErrorMatchQuery);
  }, [resolvedErrorMatchQuery]);
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const current = (searchParams.get('error_match') ?? '').trim();
    if (!operationErrorHint) {
      if (!current) {
        return;
      }
      next.delete('error_match');
      const query = next.toString();
      navigate(query ? `${location.pathname}?${query}` : location.pathname, { replace: true });
      return;
    }

    const nextMatchQuery = errorMatchQuery.trim().slice(0, errorHintMaxLength);
    const persistedMatchQuery =
      nextMatchQuery.length > 0 && nextMatchQuery !== operationErrorHint ? nextMatchQuery : '';
    if (persistedMatchQuery) {
      next.set('error_match', persistedMatchQuery);
    } else {
      next.delete('error_match');
    }
    const currentQuery = searchParams.toString();
    const nextQuery = next.toString();
    if (currentQuery === nextQuery) {
      return;
    }
    navigate(nextQuery ? `${location.pathname}?${nextQuery}` : location.pathname, {
      replace: true
    });
  }, [errorMatchQuery, location.pathname, navigate, operationErrorHint, searchParams]);
  useEffect(() => {
    if (matchedErrorLogLines.length === 0) {
      setActiveMatchedErrorIndex(0);
      return;
    }
    setActiveMatchedErrorIndex((previous) =>
      Math.min(Math.max(previous, 0), matchedErrorLogLines.length - 1)
    );
  }, [matchedErrorLogLines]);
  const jumpToActiveMatchedLogInFullLogs = useCallback(() => {
    if (!activeMatchedErrorLine) {
      return;
    }
    const requiredVisibleCount = Math.max(
      logsBatchSize,
      logs.length - activeMatchedErrorLine.lineNumber + 1
    );
    setVisibleLogCount((previous) => Math.max(previous, requiredVisibleCount));
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        logsBlockRef.current?.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        });
      });
    });
  }, [activeMatchedErrorLine, logs.length]);
  const copyTroubleshootingBundle = useCallback(async () => {
    setTroubleshootingBundleCopyError('');
    setCopiedTroubleshootingBundle(false);
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error(t('Clipboard API unavailable.'));
      }
      const contextSnippet = activeMatchedErrorContextLines
        .map((line) => `${line.active ? '>' : '-'} #${line.lineNumber} ${line.content}`)
        .join('\n');
      const pageLink =
        typeof window !== 'undefined' && window.location?.href
          ? window.location.href
          : `${location.pathname}${location.search}`;
      const recommendationSummary = troubleshootingRecommendations
        .map((item, index) => `${index + 1}. ${item.title} — ${item.detail}`)
        .join('\n');
      const bundle = [
        t('Troubleshooting bundle'),
        `${t('Job ID')}: ${job?.id ?? '-'}`,
        `${t('Job name')}: ${job?.name ?? '-'}`,
        `${t('Match keyword')}: ${trimmedErrorMatchQuery || '-'}`,
        `${t('Original hint')}: ${operationErrorHint || '-'}`,
        `${t('Current match')}: ${
          activeMatchedErrorLine
            ? `#${activeMatchedErrorLine.lineNumber} ${activeMatchedErrorLine.content}`
            : t('No active match')
        }`,
        `${t('Match count')}: ${matchedErrorLogLines.length}`,
        `${t('Suggested next steps')}:\n${recommendationSummary || '-'}`,
        `${t('Context snippet')}:\n${contextSnippet || '-'}`,
        `${t('Page link')}: ${pageLink}`
      ].join('\n');
      await navigator.clipboard.writeText(bundle);
      setCopiedTroubleshootingBundle(true);
      window.setTimeout(() => {
        setCopiedTroubleshootingBundle(false);
      }, 1800);
    } catch (error) {
      setTroubleshootingBundleCopyError(
        t('Copy failed. Please copy manually. Error: {message}', {
          message: (error as Error).message || t('Unknown')
        })
      );
    }
  }, [
    activeMatchedErrorContextLines,
    activeMatchedErrorLine,
    job?.id,
    job?.name,
    location.pathname,
    location.search,
    matchedErrorLogLines.length,
    operationErrorHint,
    t,
    troubleshootingRecommendations,
    trimmedErrorMatchQuery
  ]);
  const primaryTroubleshootingRecommendation = useMemo(
    () =>
      troubleshootingRecommendations.find((item) => item.action !== 'none') ??
      troubleshootingRecommendations[0] ??
      null,
    [troubleshootingRecommendations]
  );
  const canAutoRetryFromSuggestion = Boolean(
    jobId &&
      !busy &&
      primaryTroubleshootingRecommendation?.action === 'control_plane_retry' &&
      (job?.status === 'failed' || job?.status === 'cancelled')
  );
  const recommendationActionLabel = useCallback(
    (item: TroubleshootingRecommendation) => {
      if (item.action === 'runtime') {
        return t('Open runtime settings');
      }
      if (item.action === 'worker_settings') {
        return t('Open worker settings');
      }
      if (item.action === 'control_plane_retry') {
        return t('Use control-plane retry');
      }
      if (item.action === 'refresh_logs') {
        return t('Refresh detail');
      }
      return t('Review suggestion');
    },
    [t]
  );
  const runTroubleshootingRecommendation = useCallback(
    async (item: TroubleshootingRecommendation, options?: { autoRetry?: boolean }) => {
      const busyKey = `${item.id}:${item.action}`;
      setRecommendationActionBusy(busyKey);
      setRecommendationActionFeedback(null);
      try {
        if (item.action === 'runtime') {
          navigate(
            buildRuntimeSettingsPath('readiness', job?.framework, launchContextForDetail, outboundReturnTo)
          );
          setRecommendationActionFeedback({
            variant: 'success',
            text: t('Opened runtime settings.')
          });
          return;
        }
        if (item.action === 'worker_settings') {
          navigate(buildWorkerSettingsPath(job, launchContextForDetail, outboundReturnTo));
          setRecommendationActionFeedback({
            variant: 'success',
            text: t('Opened worker settings.')
          });
          return;
        }
        if (item.action === 'control_plane_retry') {
          setRetryDispatchPreference('control_plane');
          setRetryWorkerId('');
          if (
            options?.autoRetry &&
            jobId &&
            (job?.status === 'failed' || job?.status === 'cancelled')
          ) {
            setBusy(true);
            setFeedback(null);
            await api.retryTrainingJob(jobId, {
              execution_target: 'control_plane'
            });
            await load('manual');
            setFeedback({
              variant: 'success',
              text: t('Training job retried with selected dispatch strategy.')
            });
            setEvidenceView('logs');
            setRecommendationActionFeedback({
              variant: 'success',
              text: t('Applied control-plane strategy, retried run, and switched to logs view.')
            });
            setBusy(false);
            return;
          }
          setRecommendationActionFeedback({
            variant: 'success',
            text: t('Retry dispatch switched to control-plane.')
          });
          return;
        }
        if (item.action === 'refresh_logs') {
          await load('manual');
          setRecommendationActionFeedback({
            variant: 'success',
            text: t('Detail refreshed.')
          });
          return;
        }
        setRecommendationActionFeedback({
          variant: 'warning',
          text: t('This suggestion is informational and has no direct action.')
        });
      } catch (error) {
        setRecommendationActionFeedback({
          variant: 'error',
          text: (error as Error).message || t('Unknown')
        });
        setBusy(false);
      } finally {
        setRecommendationActionBusy('');
      }
    },
    [busy, job, jobId, launchContextForDetail, load, navigate, outboundReturnTo, t]
  );
  const runTopTroubleshootingSuggestion = useCallback(() => {
    if (!primaryTroubleshootingRecommendation) {
      return Promise.resolve();
    }
    const autoRetry =
      primaryTroubleshootingRecommendation.action === 'control_plane_retry' &&
      canAutoRetryFromSuggestion;
    return runTroubleshootingRecommendation(primaryTroubleshootingRecommendation, {
      autoRetry
    });
  }, [
    canAutoRetryFromSuggestion,
    primaryTroubleshootingRecommendation,
    runTroubleshootingRecommendation
  ]);

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

    if (retryDispatchPreference === 'worker' && !retryWorkerAvailable) {
      setFeedback({ variant: 'error', text: t('Selected worker is not in current inventory.') });
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const executionTarget = retryDispatchPreference === 'auto' ? undefined : retryDispatchPreference;
      const workerId =
        retryDispatchPreference === 'worker' && retryWorkerId.trim() ? retryWorkerId.trim() : undefined;
      await api.retryTrainingJob(jobId, {
        ...(executionTarget ? { execution_target: executionTarget } : {}),
        ...(workerId ? { worker_id: workerId } : {})
      });
      await load('manual');
      setFeedback({ variant: 'success', text: t('Training job retried with selected dispatch strategy.') });
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
            <ButtonLink to={fallbackBackToJobsPath} variant="ghost" size="sm">
              {backToJobsActionLabel}
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
            <ButtonLink to={fallbackBackToJobsPath} variant="ghost" size="sm">
              {backToJobsActionLabel}
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
            <ButtonLink to={fallbackBackToJobsPath} variant="ghost" size="sm">
              {backToJobsActionLabel}
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
  const linkedVersions = modelVersions
    .filter((version) => version.training_job_id === job.id)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const latestLinkedVersion = linkedVersions[0] ?? null;
  const linkedVersionModel = latestLinkedVersion ? modelsById.get(latestLinkedVersion.model_id) ?? null : null;
  const createdFromWizard = searchParams.get('created') === '1';
  const scopedDatasetId = scopedDatasetIdFromQuery || job.dataset_id;
  const scopedVersionId = scopedVersionIdFromQuery || job.dataset_version_id;
  const datasetDisplayName = linkedDataset?.name ?? t('Dataset record unavailable');
  const scopedJobsSearchParams = new URLSearchParams(searchParams);
  scopedJobsSearchParams.delete('created');
  if (scopedDatasetId) {
    scopedJobsSearchParams.set('dataset', scopedDatasetId);
  } else {
    scopedJobsSearchParams.delete('dataset');
  }
  if (scopedVersionId) {
    scopedJobsSearchParams.set('version', scopedVersionId);
  } else {
    scopedJobsSearchParams.delete('version');
  }
  const scopedJobsQuery = scopedJobsSearchParams.toString();
  const scopedJobsPath = scopedJobsQuery ? `/training/jobs?${scopedJobsQuery}` : '/training/jobs';
  const backToJobsActionPath = requestedReturnTo ?? scopedJobsPath;
  const scopedInferencePath = buildScopedInferencePath(
    scopedDatasetId,
    scopedVersionId,
    latestLinkedVersion?.id ?? undefined,
    launchContextForDetail
  );
  const scopedClosurePath = buildScopedClosurePath(scopedDatasetId, scopedVersionId, launchContextForDetail);
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
  const canRegisterVersion = job.status === 'completed' && executionInsight.reality === 'standard';
  const versionRegistryPath = buildScopedModelVersionsPath(
    job,
    job.name,
    latestLinkedVersion?.id ?? undefined,
    launchContextForDetail
  );
  const versionDeliveryPath = latestLinkedVersion
    ? buildScopedVersionDeliveryPath(job, latestLinkedVersion.version_name, latestLinkedVersion.id, launchContextForDetail)
    : versionRegistryPath;
  const createModelDraftPath = buildCreateModelDraftPath(job.task_type, {
    jobId: job.id,
    versionName: job.name
  }, launchContextForDetail);
  const myModelsPath = '/models/my-models';
  const completionAction =
    job.status !== 'completed'
      ? null
      : latestLinkedVersion
        ? {
            label: t('Continue in version delivery lane'),
            to: versionDeliveryPath,
            variant: 'secondary' as const
          }
        : canRegisterVersion
        ? {
            label: t('Register version'),
            to: versionRegistryPath,
            variant: 'secondary' as const
          }
        : modelsLoaded && !matchingOwnedModel
          ? {
              label: t('Create model draft'),
              to: createModelDraftPath,
              variant: 'secondary' as const
            }
          : {
              label: t('Open model versions'),
              to: versionRegistryPath,
              variant: 'ghost' as const
            };
  const executionRealityLabel =
    executionInsight.reality === 'standard'
      ? t('Standard execution')
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
  const creationHandoffDescription = createdFromWizard
    ? job.status === 'completed'
      ? !modelsLoaded
        ? t('The run is complete. Load models to continue with validation or version registration.')
        : matchingOwnedModel
          ? t('The run is complete. Continue with validation or version registration.')
          : t('The run is complete, but you still need a matching owned model before registering a version.')
      : t('This run was just created. Keep this page open to watch progress and return here for the next step.')
    : '';
  const refreshDetail = () => {
    load('manual')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  };

  type GuidanceAction = {
    label: string;
    to?: string;
    onClick?: () => void;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    disabled?: boolean;
  };
  type TrainingNextStepState = {
    current: number;
    total: number;
    title: string;
    detail: string;
    badgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    badgeLabel: string;
    actions: GuidanceAction[];
  };

  const trainingNextStep: TrainingNextStepState = (() => {
    if (['queued', 'preparing', 'running', 'evaluating'].includes(job.status)) {
      return {
        current: 2,
        total: 5,
        title: t('Keep watching this run until artifacts are ready'),
        detail: t('The job is still executing. Stay on this page for logs and metrics, then continue to version registration when it completes.'),
        badgeTone: 'info',
        badgeLabel: t('In progress'),
        actions: [
          { label: t('Refresh now'), onClick: refreshDetail },
          { label: t('Open closure lane'), to: scopedClosurePath, variant: 'ghost' }
        ]
      };
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      return {
        current: 2,
        total: 5,
        title: t('Review logs and retry this run'),
        detail: t('The run ended early. Check logs first, then retry with a clearer dispatch choice if needed.'),
        badgeTone: 'danger',
        badgeLabel: t('Needs retry'),
        actions: [
          {
            label: t('Open logs'),
            onClick: () => {
              setEvidenceView('logs');
            }
          },
	          ...(job.execution_target === 'worker'
	            ? [
	                {
	                  label: t('Worker Settings'),
	                  to: buildWorkerSettingsPath(job, launchContextForDetail, outboundReturnTo),
	                  variant: 'ghost' as const
	                }
	              ]
            : []),
          canRetry
            ? {
                label: t('Retry run'),
                onClick: () => {
                  void retryJob();
                },
                variant: 'secondary',
                disabled: busy
              }
            : {
                label: t('Open jobs'),
                to: backToJobsActionPath,
                variant: 'ghost'
              }
        ]
      };
    }

    if (!artifactAttachmentId) {
      return {
        current: 3,
        total: 5,
        title: t('Wait for the artifact package to finish'),
        detail: t('The run completed, but the packaged artifact is not visible yet. Refresh this page before moving to registration or validation.'),
        badgeTone: 'warning',
        badgeLabel: t('Artifact pending'),
        actions: [
          { label: t('Refresh now'), onClick: refreshDetail },
	          {
	            label: t('Open runtime settings'),
	            to: buildRuntimeSettingsPath('readiness', job.framework, launchContextForDetail, outboundReturnTo),
	            variant: 'ghost'
	          }
	        ]
      };
    }

    if (executionInsight.reality !== 'standard') {
      return {
        current: 4,
        total: 5,
        title: t('Fix runtime evidence before registration'),
        detail: t('This run completed with incomplete or fallback evidence. Review runtime settings and closure checks before treating it as a publishable version.'),
        badgeTone: 'warning',
        badgeLabel: t('Evidence review'),
	        actions: [
	          {
	            label: t('Open runtime settings'),
	            to: buildRuntimeSettingsPath('readiness', job.framework, launchContextForDetail, outboundReturnTo)
	          },
	          { label: t('Open closure lane'), to: scopedClosurePath, variant: 'ghost' }
	        ]
	      };
    }

    if (modelsLoaded && !matchingOwnedModel) {
      return {
        current: 4,
        total: 5,
        title: t('Create a matching model shell first'),
        detail: t('The training result is standard, but you still need an owned model draft before this run can register a version.'),
        badgeTone: 'info',
        badgeLabel: t('Model needed'),
        actions: [
          { label: t('Create model draft'), to: createModelDraftPath },
          { label: t('Open My Models'), to: myModelsPath, variant: 'ghost' }
        ]
      };
    }

    if (linkedVersions.length === 0) {
      return {
        current: 5,
        total: 5,
        title: t('Register this completed run as a model version'),
        detail: t('The run is standard and artifacts are ready. Register one model version now so downstream validation and device delivery stay anchored to this run.'),
        badgeTone: 'success',
        badgeLabel: t('Ready to register'),
        actions: [
          { label: t('Register version'), to: versionRegistryPath },
          { label: t('Validate inference'), to: scopedInferencePath, variant: 'ghost' }
        ]
      };
    }

    return {
      current: 5,
      total: 5,
      title: t('Move the linked version into validation or delivery'),
      detail: t('Version {version} is already linked to this run. Continue with inference validation, governance follow-up, or device delivery from the version page.', {
        version: latestLinkedVersion?.version_name ?? job.name
      }),
      badgeTone: 'success',
      badgeLabel: t('Linked version ready'),
      actions: [
        {
          label: t('Continue in version delivery lane'),
          to: versionDeliveryPath
        },
        { label: t('Validate inference'), to: scopedInferencePath, variant: 'secondary' },
        { label: t('Open closure lane'), to: scopedClosurePath, variant: 'ghost' }
      ]
    };
  })();

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Training detail')}
        title={job.name}
        description={t('Review the run and decide the next step.')}
        meta={
          <div className="stack tight">
            <div className="row gap wrap align-center">
              <StatusTag status={job.status}>{t(job.status)}</StatusTag>
              <Badge tone={artifactAttachmentId ? 'success' : 'neutral'}>
                {t('Artifact')}: {artifactAttachmentId ? t('Ready') : t('Pending')}
              </Badge>
            </div>
            <TrainingLaunchContextPills
              taskType={launchContextForDetail.taskType}
              framework={launchContextForDetail.framework}
              executionTarget={launchContextForDetail.executionTarget}
              workerId={launchContextForDetail.workerId}
              t={t}
            />
          </div>
        }
        primaryAction={{
          label: refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: refreshDetail,
          disabled: loading || refreshing || busy
        }}
        secondaryActions={
          <div className="row gap wrap">
            {completionAction ? (
              <ButtonLink to={completionAction.to} variant={completionAction.variant} size="sm">
                {completionAction.label}
              </ButtonLink>
            ) : null}
            <ButtonLink to={scopedClosurePath} variant="ghost" size="sm">
              {t('Continue to next loop lane')}
            </ButtonLink>
            <ButtonLink to={backToJobsActionPath} variant="ghost" size="sm">
              {backToJobsActionLabel}
            </ButtonLink>
          </div>
        }
      />

      {feedback ? (
        <InlineAlert
          tone={feedback.variant === 'success' ? 'success' : 'danger'}
          title={feedback.variant === 'success' ? t('Done') : t('Failed')}
          description={feedback.text}
        />
      ) : null}
      {scopedContextSyncHint ? (
        <InlineAlert
          tone="info"
          title={t('Selection synced')}
          description={scopedContextSyncHint}
          actions={
            <ButtonLink to={clearScopedContextPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}

      {createdFromWizard ? (
        <InlineAlert
          tone={job.status === 'completed' ? 'success' : 'info'}
          title={t('Training run created')}
          description={creationHandoffDescription}
          actions={
            <div className="row gap wrap">
              {job.status === 'completed' && modelsLoaded && !matchingOwnedModel ? (
                <ButtonLink to={createModelDraftPath} variant="secondary" size="sm">
                  {t('Create model draft')}
                </ButtonLink>
              ) : null}
              <ButtonLink to={backToJobsActionPath} variant="ghost" size="sm">
                {backToJobsActionLabel}
              </ButtonLink>
            </div>
          }
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
            {canRetry ? (
              <Panel tone="soft" className="stack tight">
                <strong>{t('Retry dispatch strategy')}</strong>
                <small className="muted">{t('Choose where the retried run should execute.')}</small>
                <div className="workspace-form-grid">
                  <label className="workspace-form-span-2">
                    {t('Dispatch target')}
                    <Select
                      value={retryDispatchPreference}
                      onChange={(event) => {
                        retryDispatchTouchedRef.current = true;
                        const nextPreference = event.target.value as 'auto' | 'control_plane' | 'worker';
                        setRetryDispatchPreference(nextPreference);
                        if (nextPreference !== 'worker') {
                          setRetryWorkerId('');
                        }
                      }}
                    >
                      <option value="auto">{t('Auto (scheduler decides)')}</option>
                      <option value="control_plane">{t('Force control-plane')}</option>
                      <option value="worker">{t('Prefer worker dispatch')}</option>
                    </Select>
                  </label>
                  {retryDispatchPreference === 'worker' ? (
                    <label className="workspace-form-span-2">
                      {t('Worker preference (optional)')}
                      <Select
                        value={retryWorkerId}
                        onChange={(event) => {
                          retryDispatchTouchedRef.current = true;
                          setRetryWorkerId(event.target.value);
                        }}
                        disabled={workersLoading || workersAccessDenied || workers.length === 0}
                      >
                        <option value="">{t('Auto-select from online workers')}</option>
                        {onlineWorkers.map((worker) => (
                          <option key={worker.id} value={worker.id}>
                            {worker.name} · {worker.id}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : null}
                </div>
                <small className="muted">{retryDispatchSummary}</small>
                {retryDispatchPreference === 'worker' ? (
                  <div className="row gap wrap">
                    <Badge tone={onlineWorkers.length > 0 ? 'success' : 'warning'}>
                      {t('Online workers')}: {onlineWorkers.length}
                    </Badge>
                    {retryWorkerId ? (
                      <Badge tone={retryWorkerAvailable ? 'success' : 'danger'}>
                        {retryWorkerAvailable ? t('Selected worker ready') : t('Selected worker missing')}
                      </Badge>
                    ) : null}
                  </div>
                ) : null}
                {workersLoading ? <small className="muted">{t('Loading worker inventory...')}</small> : null}
                {workersAccessDenied ? (
                  <small className="muted">{t('Worker inventory is restricted to admins.')}</small>
                ) : null}
                {!workersAccessDenied && workersError ? <small className="muted">{workersError}</small> : null}
                {retryDispatchPreference === 'worker' &&
                !workersLoading &&
                !workersAccessDenied &&
                onlineWorkers.length === 0 ? (
                  <InlineAlert
                    tone="warning"
                    title={t('No online worker')}
                    description={t('Worker dispatch may fail if no eligible online worker is available.')}
                  />
                ) : null}
              </Panel>
            ) : null}
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
                    executionInsight.showWarning
                      ? t('Verify before publishing')
                      : !matchingOwnedModel && modelsLoaded
                        ? t('Training complete, model needed')
                        : t('Training complete')
                  }
                  description={
                    executionInsight.showWarning
                      ? t('The run is complete, but the evidence is not complete yet.')
                      : !matchingOwnedModel && modelsLoaded
                        ? t('Create a matching model draft before registering this run.')
                        : t('Next you can validate inference or register a version.')
                  }
                  actions={
                    executionInsight.showWarning ? (
                      <ButtonLink
                        to={buildRuntimeSettingsPath('readiness', job.framework, launchContextForDetail, outboundReturnTo)}
                        variant="secondary"
                        size="sm"
                      >
                        {t('Open runtime settings')}
                      </ButtonLink>
                    ) : !createdFromWizard ? (
                      <ButtonLink to={scopedInferencePath} variant="secondary" size="sm">
                        {t('Validate inference')}
                      </ButtonLink>
                    ) : null
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
                  {operationErrorHint ? (
                    <Panel tone="soft" className="stack tight">
                      <strong>{t('Failure context from previous step')}</strong>
                      <small className="muted">{operationErrorHint}</small>
                      <label className="stack tight">
                        <small className="muted">{t('Match keyword')}</small>
                        <Input
                          value={errorMatchQuery}
                          onChange={(event) => setErrorMatchQuery(event.target.value)}
                          placeholder={t('Edit keyword to retry matching')}
                        />
                      </label>
                      <div className="row gap wrap">
                        {clearOperationErrorHintPath ? (
                          <ButtonLink to={clearOperationErrorHintPath} variant="ghost" size="sm">
                            {t('Clear failure context')}
                          </ButtonLink>
                        ) : null}
                        {errorMatchQuery.trim() !== operationErrorHint ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setErrorMatchQuery(operationErrorHint)}
                          >
                            {t('Restore original keyword')}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEvidenceView('overview')}
                        >
                          {t('Back to overview')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            copyTroubleshootingBundle().catch(() => {
                              // no-op
                            });
                          }}
                        >
                          {copiedTroubleshootingBundle
                            ? t('Copied troubleshooting bundle')
                            : t('Copy troubleshooting bundle')}
                        </Button>
                      </div>
                      {troubleshootingBundleCopyError ? (
                        <InlineAlert
                          tone="warning"
                          title={t('Copy failed')}
                          description={troubleshootingBundleCopyError}
                        />
                      ) : null}
                      {recommendationActionFeedback ? (
                        <InlineAlert
                          tone={
                            recommendationActionFeedback.variant === 'success'
                              ? 'success'
                              : recommendationActionFeedback.variant === 'warning'
                                ? 'warning'
                                : 'danger'
                          }
                          title={
                            recommendationActionFeedback.variant === 'error'
                              ? t('Action failed')
                              : recommendationActionFeedback.variant === 'warning'
                                ? t('Notice')
                                : t('Action complete')
                          }
                          description={recommendationActionFeedback.text}
                        />
                      ) : null}
                      {troubleshootingRecommendations.length > 0 ? (
                        <div className="stack tight">
                          <div className="row between align-center gap wrap">
                            <small className="muted">{t('Suggested next steps')}</small>
                            <div className="row gap wrap">
                              {primaryTroubleshootingRecommendation ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    runTopTroubleshootingSuggestion().catch(() => {
                                      // no-op
                                    });
                                  }}
                                  disabled={Boolean(recommendationActionBusy) || busy}
                                >
                                  {recommendationActionBusy
                                    ? t('Applying...')
                                    : canAutoRetryFromSuggestion
                                      ? t('Run top suggestion (auto-retry)')
                                      : t('Run top suggestion')}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          {troubleshootingRecommendations.map((item) => (
                            <Panel key={item.id} tone="soft" className="stack tight">
                              <strong>{item.title}</strong>
                              <small className="muted">{item.detail}</small>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  runTroubleshootingRecommendation(item).catch(() => {
                                    // no-op
                                  });
                                }}
                                disabled={Boolean(recommendationActionBusy)}
                              >
                                {recommendationActionBusy === `${item.id}:${item.action}`
                                  ? t('Applying...')
                                  : recommendationActionLabel(item)}
                              </Button>
                            </Panel>
                          ))}
                        </div>
                      ) : null}
                      {matchedErrorLogLines.length > 0 ? (
                        <div className="stack tight">
                          <div className="row between align-center gap wrap">
                            <small className="muted">
                              {t('Matched log lines')} ({activeMatchedErrorIndex + 1}/{matchedErrorLogLines.length})
                            </small>
                            <div className="row gap">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setActiveMatchedErrorIndex((previous) =>
                                    previous <= 0 ? 0 : previous - 1
                                  )
                                }
                                disabled={activeMatchedErrorIndex <= 0}
                              >
                                {t('Previous match')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setActiveMatchedErrorIndex((previous) =>
                                    previous >= matchedErrorLogLines.length - 1
                                      ? matchedErrorLogLines.length - 1
                                      : previous + 1
                                  )
                                }
                                disabled={activeMatchedErrorIndex >= matchedErrorLogLines.length - 1}
                              >
                                {t('Next match')}
                              </Button>
                            </div>
                          </div>
                          {activeMatchedErrorLine ? (
                            <pre className="code-block">
                              {t('Current match')} #{activeMatchedErrorLine.lineNumber} {activeMatchedErrorLine.content}
                            </pre>
                          ) : null}
                          {activeMatchedErrorLine ? (
                            <div className="row gap wrap">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={jumpToActiveMatchedLogInFullLogs}
                              >
                                {t('View in full logs')}
                              </Button>
                            </div>
                          ) : null}
                          {activeMatchedErrorContextLines.length > 0 ? (
                            <div className="stack tight">
                              <small className="muted">{t('Match context')}</small>
                              {activeMatchedErrorContextLines.map((line) => (
                                <pre
                                  key={`context-${line.lineNumber}-${line.content}`}
                                  className="code-block"
                                  style={{
                                    border: line.active ? '1px solid #60a5fa' : undefined,
                                    background: line.active ? 'rgba(59, 130, 246, 0.08)' : undefined
                                  }}
                                >
                                  #{line.lineNumber} {line.content}
                                </pre>
                              ))}
                            </div>
                          ) : null}
                          {matchedErrorLogLines.map((line, index) => (
                            <button
                              key={`${line.lineNumber}-${line.content}`}
                              type="button"
                              className="workspace-record-row"
                              style={{
                                textAlign: 'left',
                                borderRadius: '0.5rem',
                                border:
                                  index === activeMatchedErrorIndex
                                    ? '1px solid #60a5fa'
                                    : '1px solid transparent',
                                background:
                                  index === activeMatchedErrorIndex
                                    ? 'rgba(59, 130, 246, 0.08)'
                                    : 'transparent'
                              }}
                              onClick={() => setActiveMatchedErrorIndex(index)}
                            >
                              <small className="muted">#{line.lineNumber}</small>
                              <div>{line.content}</div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <small className="muted">
                          {trimmedErrorMatchQuery.length < 3
                            ? t('Enter at least 3 characters for matching.')
                            : t('No exact match found in current logs. Review full logs below.')}
                        </small>
                      )}
                    </Panel>
                  ) : null}
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
                      <pre ref={logsBlockRef} className="code-block">{visibleLogs.join('\n')}</pre>
                    </div>
                  )}
                </div>
              )}
            </SectionCard>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <WorkspaceNextStepCard
              title={t('Next step')}
              description={t('Keep the post-training handoff obvious from this page.')}
              stepLabel={trainingNextStep.title}
              stepDetail={trainingNextStep.detail}
              current={trainingNextStep.current}
              total={trainingNextStep.total}
              badgeLabel={trainingNextStep.badgeLabel}
              badgeTone={trainingNextStep.badgeTone}
              actions={trainingNextStep.actions.map((action) =>
                action.to ? (
                  <ButtonLink
                    key={action.label}
                    to={action.to}
                    variant={action.variant ?? 'primary'}
                    size="sm"
                  >
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button
                    key={action.label}
                    type="button"
                    variant={action.variant ?? 'primary'}
                    size="sm"
                    onClick={action.onClick}
                    disabled={action.disabled}
                  >
                    {action.label}
                  </Button>
                )
              )}
            />

            <SectionCard
              title={t('Downstream snapshot')}
              description={t('Track the training result, model shell, and version registration without leaving this page.')}
            >
              <DetailList
                items={[
                  { label: t('Dataset'), value: datasetDisplayName },
                  { label: t('Dataset version'), value: job.dataset_version_id ?? t('not pinned') },
                  { label: t('Artifact'), value: artifactAttachmentId ? t('Ready') : t('Pending') },
                  { label: t('Evidence'), value: executionRealityLabel },
                  {
                    label: t('Owned model'),
                    value: linkedVersionModel?.name ?? matchingOwnedModel?.name ?? t('No matching model yet')
                  },
                  {
                    label: t('Model status'),
                    value: linkedVersionModel ? t(linkedVersionModel.status) : matchingOwnedModel ? t(matchingOwnedModel.status) : '-'
                  },
                  { label: t('Linked versions'), value: linkedVersions.length },
                  {
                    label: t('Latest linked version'),
                    value: latestLinkedVersion?.version_name ?? '-'
                  }
                ]}
              />
              <div className="row gap wrap">
                <ButtonLink to={linkedVersions.length > 0 ? versionDeliveryPath : versionRegistryPath} variant="ghost" size="sm">
                  {linkedVersions.length > 0 ? t('Continue in version delivery lane') : t('Register version')}
                </ButtonLink>
                <ButtonLink to={scopedInferencePath} variant="ghost" size="sm">
                  {t('Validate inference')}
                </ButtonLink>
                <ButtonLink to={myModelsPath} variant="ghost" size="sm">
                  {t('Open My Models')}
                </ButtonLink>
              </div>
            </SectionCard>

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
                  <Badge tone={executionInsight.reality === 'standard' ? 'success' : 'warning'}>
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
                <ButtonLink
                  to={buildRuntimeSettingsPath('readiness', job.framework, launchContextForDetail, outboundReturnTo)}
                  variant="ghost"
                  size="sm"
                >
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
                      <ButtonLink
                        to={buildRuntimeSettingsPath('readiness', job.framework, launchContextForDetail, outboundReturnTo)}
                        variant="secondary"
                        size="sm"
                      >
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
