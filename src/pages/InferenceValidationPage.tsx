import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  FileAttachment,
  InferenceRunRecord,
  ModelVersionRecord,
  RuntimeConnectivityRecord,
  VisionModelingTaskRecord
} from '../../shared/domain';
import AttachmentUploader from '../components/AttachmentUploader';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import StateBlock from '../components/StateBlock';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { ActionBar, InlineAlert, PageHeader, SectionCard } from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import { Card } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { detectInferenceRunReality, resolveInferenceRunSource } from '../utils/inferenceSource';
import { bucketRuntimeFallbackReason, runtimeFallbackReasonLabelKey } from '../utils/runtimeFallbackReason';

const backgroundRefreshIntervalMs = 5000;
const PredictionVisualizer = lazy(() => import('../components/PredictionVisualizer'));

type LoadMode = 'initial' | 'manual' | 'background';

const buildInferenceWorkspaceSignature = (payload: {
  versions: ModelVersionRecord[];
  datasets: DatasetRecord[];
  attachments: FileAttachment[];
  runs: InferenceRunRecord[];
}): string =>
  JSON.stringify({
    versions: [...payload.versions].sort((left, right) => left.id.localeCompare(right.id)),
    datasets: [...payload.datasets].sort((left, right) => left.id.localeCompare(right.id)),
    attachments: [...payload.attachments].sort((left, right) => left.id.localeCompare(right.id)),
    runs: [...payload.runs].sort((left, right) => left.id.localeCompare(right.id))
  });

const buildScopedAnnotationPath = (
  datasetId: string,
  queue: 'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved',
  versionId?: string,
  options?: {
    metadataFilter?: string;
    launchContext?: {
      datasetId?: string | null;
      versionId?: string | null;
      taskType?: string | null;
      framework?: string | null;
      executionTarget?: string | null;
      workerId?: string | null;
    };
  }
): string => {
  const searchParams = new URLSearchParams();
  if (queue !== 'all') {
    searchParams.set('queue', queue);
  }
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  const normalizedMetadataFilter = options?.metadataFilter?.trim() ?? '';
  if (normalizedMetadataFilter) {
    searchParams.set('meta', normalizedMetadataFilter);
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}/annotate?${query}` : `/datasets/${datasetId}/annotate`;
};

const buildScopedVersionDeliveryPath = (
  versionId?: string | null,
  launchContext?: {
    datasetId?: string | null;
    versionId?: string | null;
    taskType?: string | null;
    framework?: string | null;
    executionTarget?: string | null;
    workerId?: string | null;
  }
): string => {
  const normalizedVersionId = versionId?.trim() ?? '';
  const searchParams = new URLSearchParams();
  if (normalizedVersionId) {
    searchParams.set('selectedVersion', normalizedVersionId);
    searchParams.set('focus', 'device');
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/models/versions?${query}` : '/models/versions';
};

const buildDatasetDetailPath = (
  datasetId?: string | null,
  options?: {
    versionId?: string | null;
    launchContext?: {
      datasetId?: string | null;
      versionId?: string | null;
      taskType?: string | null;
      framework?: string | null;
      executionTarget?: string | null;
      workerId?: string | null;
    };
  }
): string => {
  const normalizedDatasetId = datasetId?.trim() ?? '';
  if (!normalizedDatasetId) {
    return '/datasets';
  }
  const searchParams = new URLSearchParams();
  if (options?.versionId?.trim()) {
    searchParams.set('version', options.versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  const query = searchParams.toString();
  return query ? `/datasets/${normalizedDatasetId}?${query}` : `/datasets/${normalizedDatasetId}`;
};

const buildDatasetsPath = (context?: {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
}): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, context);
  const query = searchParams.toString();
  return query ? `/datasets?${query}` : '/datasets';
};

const appendTrainingLaunchContext = (
  searchParams: URLSearchParams,
  context?: {
    datasetId?: string | null;
    versionId?: string | null;
    taskType?: string | null;
    framework?: string | null;
    executionTarget?: string | null;
    workerId?: string | null;
  }
) => {
  if (!context) {
    return;
  }
  if (context.datasetId?.trim() && !searchParams.has('dataset')) {
    searchParams.set('dataset', context.datasetId.trim());
  }
  if (context.versionId?.trim() && !searchParams.has('version')) {
    searchParams.set('version', context.versionId.trim());
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

const buildTrainingLaunchPath = (context?: {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
}): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, context);
  const query = searchParams.toString();
  return query ? `/training/jobs/new?${query}` : '/training/jobs/new';
};

const buildRuntimeSettingsPath = (context?: {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
},
returnTo?: string | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'readiness');
  appendTrainingLaunchContext(searchParams, context);
  appendReturnTo(searchParams, returnTo);
  return `/settings/runtime?${searchParams.toString()}`;
};

const buildWorkerSettingsPath = (context?: {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
},
returnTo?: string | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'inventory');
  if (context?.framework?.trim()) {
    searchParams.set('profile', context.framework.trim());
  }
  appendTrainingLaunchContext(searchParams, context);
  appendReturnTo(searchParams, returnTo);
  return `/settings/workers?${searchParams.toString()}`;
};

type ValidationGuidanceAction = {
  label: string;
  to?: string;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
};

type ValidationGuidanceState = {
  current: number;
  total: number;
  title: string;
  description: string;
  badgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  badgeLabel: string;
  actions: ValidationGuidanceAction[];
};

export default function InferenceValidationPage() {
  const { t } = useI18n();
  const location = useLocation();
  const formatFallbackReasonLabel = useCallback(
    (reason: string | null | undefined): string => t(runtimeFallbackReasonLabelKey(bucketRuntimeFallbackReason(reason))),
    [t]
  );
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const [versions, setVersions] = useState<ModelVersionRecord[]>([]);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [runs, setRuns] = useState<InferenceRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRunDetail, setSelectedRunDetail] = useState<InferenceRunRecord | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [selectedAttachmentId, setSelectedAttachmentId] = useState('');
  const [feedbackReason, setFeedbackReason] = useState('missing_detection');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedRunLoading, setSelectedRunLoading] = useState(false);
  const [selectedRunError, setSelectedRunError] = useState('');
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeChecks, setRuntimeChecks] = useState<RuntimeConnectivityRecord[]>([]);
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [runSelectionSyncHint, setRunSelectionSyncHint] = useState('');
  const [linkedVisionTask, setLinkedVisionTask] = useState<VisionModelingTaskRecord | null>(null);
  const [linkedVisionTaskError, setLinkedVisionTaskError] = useState('');
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredDatasetVersionId = (searchParams.get('version') ?? '').trim();
  const preferredTaskTypeRaw = (searchParams.get('task_type') ?? '').trim().toLowerCase();
  const preferredTaskType =
    preferredTaskTypeRaw === 'ocr' ||
    preferredTaskTypeRaw === 'detection' ||
    preferredTaskTypeRaw === 'classification' ||
    preferredTaskTypeRaw === 'segmentation' ||
    preferredTaskTypeRaw === 'obb'
      ? preferredTaskTypeRaw
      : null;
  const preferredFrameworkRaw = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
  const preferredFramework =
    preferredFrameworkRaw === 'paddleocr' || preferredFrameworkRaw === 'doctr' || preferredFrameworkRaw === 'yolo'
      ? preferredFrameworkRaw
      : null;
  const preferredExecutionTarget = (searchParams.get('execution_target') ?? '').trim();
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();
  const preferredModelVersionId = (searchParams.get('modelVersion') ?? searchParams.get('model_version') ?? '').trim();
  const preferredRunId = (searchParams.get('run') ?? '').trim();
  const preferredVisionTaskId = (searchParams.get('vision_task') ?? '').trim();
  const preferredFocus = (searchParams.get('focus') ?? '').trim();
  const preferredContextAppliedRef = useRef(false);
  const resourcesSignatureRef = useRef('');
  const inputUploaderRef = useRef<HTMLDivElement | null>(null);
  const latestOutputRef = useRef<HTMLDivElement | null>(null);
  const feedbackPanelRef = useRef<HTMLDivElement | null>(null);
  const focusAppliedRef = useRef('');
  const runVersionSyncAppliedRef = useRef('');
  const backgroundSyncHint = t(
    'Background sync is unavailable right now. Deletion is already applied locally. Click Refresh to retry.'
  );

  const loadAll = useCallback(async (mode: LoadMode) => {
    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    try {
      const [versionResult, datasetResult, attachmentResult, runResult] = await Promise.all([
        api.listModelVersions(),
        api.listDatasets(),
        api.listInferenceAttachments(),
        api.listInferenceRuns()
      ]);
      const nextSignature = buildInferenceWorkspaceSignature({
        versions: versionResult,
        datasets: datasetResult,
        attachments: attachmentResult,
        runs: runResult
      });

      if (resourcesSignatureRef.current !== nextSignature) {
        resourcesSignatureRef.current = nextSignature;
        const preferredDataset =
          preferredDatasetId && !preferredContextAppliedRef.current
            ? datasetResult.find((dataset) => dataset.id === preferredDatasetId) ?? null
            : null;
        const preferredTaskTypeForVersion = preferredDataset?.task_type ?? preferredTaskType ?? null;
        const preferredTaskVersion = preferredTaskTypeForVersion
          ? versionResult.find(
              (version) =>
                version.task_type === preferredTaskTypeForVersion &&
                (!preferredFramework || version.framework === preferredFramework)
            ) ??
            versionResult.find((version) => version.task_type === preferredTaskTypeForVersion) ??
            null
          : preferredFramework
            ? versionResult.find((version) => version.framework === preferredFramework) ?? null
            : null;
        const requestedModelVersion =
          preferredModelVersionId && versionResult.find((version) => version.id === preferredModelVersionId)
            ? preferredModelVersionId
            : '';
        const legacyRequestedModelVersion =
          !requestedModelVersion &&
          preferredDatasetVersionId &&
          versionResult.find((version) => version.id === preferredDatasetVersionId)
            ? preferredDatasetVersionId
            : '';
        setVersions(versionResult);
        setDatasets(datasetResult);
        setAttachments(attachmentResult);
        setRuns(runResult);
        setSelectedRunId((prev) =>
          (preferredRunId && runResult.some((run) => run.id === preferredRunId) ? preferredRunId : '') ||
          (prev && runResult.some((run) => run.id === prev) ? prev : runResult[0]?.id || '')
        );
        setSelectedVersionId((prev) =>
          requestedModelVersion ||
          legacyRequestedModelVersion ||
          (preferredTaskVersion?.id ?? '') ||
          (prev && versionResult.some((version) => version.id === prev) ? prev : versionResult[0]?.id || '')
        );
        setSelectedDatasetId((prev) =>
          (preferredDataset?.id ?? '') ||
          (prev && datasetResult.some((dataset) => dataset.id === prev) ? prev : datasetResult[0]?.id || '')
        );
        setSelectedAttachmentId((prev) => {
          const readyAttachments = attachmentResult.filter((attachment) => attachment.status === 'ready');
          return prev && readyAttachments.some((attachment) => attachment.id === prev)
            ? prev
            : readyAttachments[0]?.id || '';
        });
        if (preferredDataset || requestedModelVersion || legacyRequestedModelVersion) {
          preferredContextAppliedRef.current = true;
        }
      }
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, [
    preferredDatasetId,
    preferredDatasetVersionId,
    preferredFramework,
    preferredModelVersionId,
    preferredRunId,
    preferredTaskType
  ]);

  useEffect(() => {
    loadAll('initial')
      .then(() => setFeedback(null))
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }));
  }, [loadAll]);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [versions, selectedVersionId]
  );
  const prefilledModelVersion = useMemo(
    () => (preferredModelVersionId ? versions.find((version) => version.id === preferredModelVersionId) ?? null : null),
    [preferredModelVersionId, versions]
  );
  const versionsById = useMemo(() => new Map(versions.map((version) => [version.id, version])), [versions]);

  const selectedRunSummary = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );
  const prefilledRun = useMemo(
    () => (preferredRunId ? runs.find((run) => run.id === preferredRunId) ?? null : null),
    [preferredRunId, runs]
  );
  const describeRun = useCallback(
    (run: InferenceRunRecord) => versionsById.get(run.model_version_id)?.version_name ?? t('Recent run'),
    [t, versionsById]
  );
  const selectedRun = selectedRunDetail && selectedRunDetail.id === selectedRunId ? selectedRunDetail : selectedRunSummary;
  const selectedRunVersion = useMemo(
    () => (selectedRun ? versionsById.get(selectedRun.model_version_id) ?? null : null),
    [selectedRun, versionsById]
  );
  const selectedActiveLearningCandidate = useMemo(
    () =>
      selectedRun && linkedVisionTask?.active_learning_pool
        ? linkedVisionTask.active_learning_pool.top_candidates.find(
            (candidate) => candidate.run_id === selectedRun.id
          ) ?? null
        : null,
    [linkedVisionTask?.active_learning_pool, selectedRun]
  );
  const selectedActiveLearningCluster = useMemo(
    () =>
      selectedActiveLearningCandidate && linkedVisionTask?.active_learning_pool
        ? linkedVisionTask.active_learning_pool.clusters.find(
            (cluster) => cluster.cluster_id === selectedActiveLearningCandidate.cluster_id
          ) ?? null
        : null,
    [linkedVisionTask?.active_learning_pool, selectedActiveLearningCandidate]
  );
  const runPrefillMissing = useMemo(
    () => Boolean(preferredRunId && runs.length > 0 && !prefilledRun),
    [prefilledRun, preferredRunId, runs.length]
  );
  const feedbackTaskType = useMemo(
    () => selectedRun?.task_type ?? selectedVersion?.task_type ?? null,
    [selectedRun?.task_type, selectedVersion?.task_type]
  );
  const feedbackDatasets = useMemo(
    () =>
      feedbackTaskType
        ? datasets.filter((dataset) => dataset.task_type === feedbackTaskType)
        : datasets,
    [datasets, feedbackTaskType]
  );
  const selectedFeedbackDataset = useMemo(
    () => feedbackDatasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [feedbackDatasets, selectedDatasetId]
  );
  const selectedRunFeedbackDataset = useMemo(
    () =>
      selectedRun?.feedback_dataset_id
        ? datasets.find((dataset) => dataset.id === selectedRun.feedback_dataset_id) ?? null
        : null,
    [datasets, selectedRun?.feedback_dataset_id]
  );
  const linkedVisionTaskFeedbackDatasetId = (linkedVisionTask?.metadata.feedback_dataset_id ?? '').trim();
  const linkedVisionTaskFeedbackDataset = useMemo(
    () =>
      linkedVisionTaskFeedbackDatasetId
        ? datasets.find((dataset) => dataset.id === linkedVisionTaskFeedbackDatasetId) ?? null
        : null,
    [datasets, linkedVisionTaskFeedbackDatasetId]
  );
  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId]
  );
  const preferredDatasetRecord = useMemo(
    () => (preferredDatasetId ? datasets.find((dataset) => dataset.id === preferredDatasetId) ?? null : null),
    [datasets, preferredDatasetId]
  );
  const datasetPrefillMissing = useMemo(
    () => Boolean(preferredDatasetId && datasets.length > 0 && !preferredDatasetRecord),
    [datasets.length, preferredDatasetId, preferredDatasetRecord]
  );
  const effectiveLaunchDatasetId = preferredDatasetRecord?.id ?? selectedDataset?.id ?? null;
  const linkedVisionTaskPath = preferredVisionTaskId
    ? `/vision/tasks/${encodeURIComponent(preferredVisionTaskId)}`
    : null;
  const launchContext = useMemo(
    () => ({
      datasetId: effectiveLaunchDatasetId,
      versionId: preferredDatasetVersionId || null,
      taskType: preferredTaskType || selectedRun?.task_type || selectedVersion?.task_type || null,
      framework: preferredFramework || selectedRun?.framework || selectedVersion?.framework || null,
      executionTarget: preferredExecutionTarget || null,
      workerId: preferredWorkerId || null
    }),
    [
      effectiveLaunchDatasetId,
      preferredDatasetVersionId,
      preferredExecutionTarget,
      preferredFramework,
      preferredTaskType,
      preferredWorkerId,
      selectedRun?.framework,
      selectedRun?.task_type,
      selectedVersion?.framework,
      selectedVersion?.task_type
    ]
  );
  const scopedDatasetId = selectedRunFeedbackDataset?.id ?? selectedDataset?.id ?? preferredDatasetId;
  const scopedVersionId =
    scopedDatasetId && preferredDatasetId && scopedDatasetId === preferredDatasetId ? preferredDatasetVersionId : undefined;
  const scopedAnnotationQueue = useMemo<'all' | 'needs_work' | 'in_review' | 'rejected' | 'approved'>(() => {
    if (!selectedRun) {
      return 'needs_work';
    }
    if (selectedRun.feedback_dataset_id) {
      return 'needs_work';
    }
    return 'in_review';
  }, [selectedRun]);
  const scopedAnnotationPath = scopedDatasetId
    ? buildScopedAnnotationPath(scopedDatasetId, scopedAnnotationQueue, scopedVersionId, {
        metadataFilter: selectedRun ? `inference_run_id=${selectedRun.id}` : '',
        launchContext
      })
    : '/datasets';
  const selectedRunDeliveryPath = useMemo(
    () =>
      buildScopedVersionDeliveryPath(
        selectedRunVersion?.id ?? selectedVersion?.id ?? preferredModelVersionId,
        launchContext
      ),
    [launchContext, preferredModelVersionId, selectedRunVersion?.id, selectedVersion?.id]
  );
  const scopedDatasetsPath = useMemo(
    () => buildDatasetsPath(launchContext),
    [launchContext]
  );
  const selectedFeedbackDatasetPath = useMemo(
    () =>
      buildDatasetDetailPath(selectedRunFeedbackDataset?.id ?? selectedFeedbackDataset?.id ?? preferredDatasetId, {
        versionId: launchContext.versionId ?? undefined,
        launchContext
      }),
    [
      launchContext,
      preferredDatasetId,
      selectedFeedbackDataset?.id,
      selectedRunFeedbackDataset?.id
    ]
  );
  const selectedRunPreviewUrl = useMemo(() => {
    if (!selectedRun) {
      return null;
    }

    const sourceAttachmentId =
      selectedRun.normalized_output.image.source_attachment_id ?? selectedRun.input_attachment_id;
    return sourceAttachmentId ? api.attachmentContentUrl(sourceAttachmentId) : null;
  }, [selectedRun]);
  const hasTrainingLaunchContext = Boolean(
    launchContext.datasetId ||
      launchContext.versionId ||
      launchContext.taskType ||
      launchContext.framework ||
      launchContext.executionTarget ||
      launchContext.workerId
  );
  const returnTrainingLaunchPath = useMemo(
    () => buildTrainingLaunchPath(launchContext),
    [launchContext]
  );
  const runtimeSettingsPath = useMemo(
    () => buildRuntimeSettingsPath(launchContext, outboundReturnTo),
    [launchContext, outboundReturnTo]
  );
  const workerSettingsPath = useMemo(
    () => buildWorkerSettingsPath(launchContext, outboundReturnTo),
    [launchContext, outboundReturnTo]
  );
  const clearPrefillPath = useMemo(() => {
    const nextParams = new URLSearchParams();
    appendTrainingLaunchContext(nextParams, launchContext);
    const query = nextParams.toString();
    return query ? `/inference/validate?${query}` : '/inference/validate';
  }, [launchContext]);
  const clearDatasetContextPath = useMemo(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('dataset');
    nextParams.delete('version');
    nextParams.delete('focus');
    const query = nextParams.toString();
    return query ? `/inference/validate?${query}` : '/inference/validate';
  }, [searchParams]);
  const clearVersionFiltersPath = useMemo(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('task_type');
    nextParams.delete('framework');
    nextParams.delete('profile');
    const query = nextParams.toString();
    return query ? `/inference/validate?${query}` : '/inference/validate';
  }, [searchParams]);
  const versionFilterBlockerHint = useMemo(() => {
    if (versions.length === 0 || (!preferredTaskType && !preferredFramework)) {
      return '';
    }
    const taskTypeLabel = preferredTaskType ? t(preferredTaskType) : t('n/a');
    const frameworkLabel = preferredFramework ? t(preferredFramework) : t('n/a');

    const hasTaskMatch = preferredTaskType ? versions.some((version) => version.task_type === preferredTaskType) : true;
    const hasFrameworkMatch = preferredFramework
      ? versions.some((version) => version.framework === preferredFramework)
      : true;
    const hasCombinedMatch = versions.some(
      (version) =>
        (!preferredTaskType || version.task_type === preferredTaskType) &&
        (!preferredFramework || version.framework === preferredFramework)
    );

    if (hasCombinedMatch) {
      return '';
    }

    if (!hasTaskMatch && !hasFrameworkMatch) {
      return t('No model version matches task type {taskType} and framework {framework}. Showing available versions instead.', {
        taskType: taskTypeLabel,
        framework: frameworkLabel
      });
    }

    if (!hasTaskMatch) {
      return t('No model version matches task type {taskType}. Showing available versions instead.', {
        taskType: taskTypeLabel
      });
    }

    return t('No model version matches framework {framework}. Showing available versions instead.', {
      framework: frameworkLabel
    });
  }, [preferredFramework, preferredTaskType, t, versions]);

  const runtimeInsight = useMemo(() => {
    if (!selectedRun) {
      return null;
    }

    const inferredSource = resolveInferenceRunSource(selectedRun);
    const inferredReality = detectInferenceRunReality(selectedRun);
    const rawMeta =
      selectedRun.raw_output.meta && typeof selectedRun.raw_output.meta === 'object' && !Array.isArray(selectedRun.raw_output.meta)
        ? (selectedRun.raw_output.meta as Record<string, unknown>)
        : null;
    const source = inferredSource;
    const runnerMode =
      rawMeta && typeof rawMeta.mode === 'string' && rawMeta.mode.trim() ? rawMeta.mode.trim() : '';

    const fallbackReason =
      inferredReality.reason ||
      (typeof selectedRun.raw_output.runtime_fallback_reason === 'string'
        ? selectedRun.raw_output.runtime_fallback_reason
        : '') ||
      (typeof selectedRun.raw_output.local_command_fallback_reason === 'string'
        ? selectedRun.raw_output.local_command_fallback_reason
        : '');
    const normalizedSource = source.toLowerCase();
    const sourceKind =
      normalizedSource.includes('template')
        ? 'template'
        : normalizedSource.endsWith('_runtime') && !inferredReality.fallback
          ? 'runtime'
          : normalizedSource.endsWith('_local_command') && !inferredReality.fallback
            ? 'local_command'
            : normalizedSource.includes('fallback') || normalizedSource.includes('mock') || normalizedSource.includes('base_empty')
        ? 'fallback'
            : inferredReality.fallback
              ? 'fallback'
              : 'unknown';

    const title =
      sourceKind === 'runtime'
        ? t('Runtime output active')
        : sourceKind === 'local_command' && runnerMode === 'real'
          ? t('Local runner active')
          : sourceKind === 'local_command'
            ? t('Local fallback output')
            : t('Fallback output active');
    const description =
      sourceKind === 'runtime'
        ? t('Output comes from the configured runtime endpoint.')
        : sourceKind === 'local_command' && runnerMode === 'real'
          ? t('Output comes from the local runner and version artifact.')
          : sourceKind === 'local_command'
            ? fallbackReason
              ? t('Built-in fallback runner used: {reason}', {
                  reason: formatFallbackReasonLabel(fallbackReason)
                })
              : t('Built-in fallback runner used.')
              : fallbackReason
                ? t('Fallback output used: {reason}', {
                    reason: formatFallbackReasonLabel(fallbackReason)
                  })
                : t('Fallback output used.');
    const variant: 'success' | 'error' | 'empty' =
      sourceKind === 'runtime' || (sourceKind === 'local_command' && runnerMode === 'real')
        ? 'success'
        : sourceKind === 'fallback'
          ? 'error'
          : 'empty';

    return {
      displaySourceLabel: inferredReality.fallback ? t('Fallback output') : t('Standard output'),
      title,
      description,
      variant
    };
  }, [selectedRun, formatFallbackReasonLabel, t]);

  const selectedRunFallbackWarning = useMemo(() => {
    if (!selectedRun) {
      return null;
    }

    const normalizedMeta = selectedRun.normalized_output.normalized_output as Record<string, unknown>;
    const rawMeta =
      selectedRun.raw_output.meta && typeof selectedRun.raw_output.meta === 'object' && !Array.isArray(selectedRun.raw_output.meta)
        ? (selectedRun.raw_output.meta as Record<string, unknown>)
        : null;
    const source =
      typeof normalizedMeta.source === 'string' && normalizedMeta.source.trim()
        ? normalizedMeta.source.toLowerCase()
        : '';
    const sourceIndicatesFallback =
      source.includes('mock') || source.includes('template') || source.includes('fallback');
    const templateMode =
      rawMeta && typeof rawMeta.mode === 'string' ? rawMeta.mode.toLowerCase() === 'template' : false;
    const localFallbackReason =
      typeof selectedRun.raw_output.local_command_fallback_reason === 'string'
        ? selectedRun.raw_output.local_command_fallback_reason
        : '';
    const runtimeFallbackReason =
      typeof selectedRun.raw_output.runtime_fallback_reason === 'string'
        ? selectedRun.raw_output.runtime_fallback_reason
        : '';
    const templateFallbackReason =
      rawMeta && typeof rawMeta.fallback_reason === 'string' ? rawMeta.fallback_reason : '';

    if (!sourceIndicatesFallback && !localFallbackReason && !runtimeFallbackReason && !templateMode) {
      return null;
    }

    return {
      reason: localFallbackReason || runtimeFallbackReason || templateFallbackReason
    };
  }, [selectedRun]);

  const selectedRunHasEmptyOcrResult = useMemo(() => {
    if (!selectedRun || selectedRun.task_type !== 'ocr') {
      return false;
    }

    return (selectedRun.normalized_output.ocr?.lines ?? []).length === 0;
  }, [selectedRun]);

  const selectedRunNotice = useMemo(() => {
    if (selectedRunFallbackWarning) {
      return {
        tone: 'danger' as const,
        title: t('Current result requires verification'),
        description: selectedRunFallbackWarning.reason
          ? `${t('Fallback reason')}: ${formatFallbackReasonLabel(selectedRunFallbackWarning.reason)}`
          : t('Fix Runtime or local command settings first.')
      };
    }

    if (selectedRunHasEmptyOcrResult) {
      return {
        tone: 'warning' as const,
        title: t('No OCR text recognized'),
        description: t('Check Runtime or the local command and try again.')
      };
    }

    return null;
  }, [formatFallbackReasonLabel, selectedRunFallbackWarning, selectedRunHasEmptyOcrResult, t]);
  const modelVersionPrefillBanner = useMemo(() => {
    if (!preferredModelVersionId) {
      return null;
    }

    if (!prefilledModelVersion) {
      return {
        tone: 'warning' as const,
        title: t('Model version prefill missing'),
        description: t('The requested model version is no longer available. Choose another one.'),
        actionLabel: t('Open model versions')
      };
    }

    return {
      tone: 'info' as const,
      title: t('Model version prefilled'),
      description: t('{name} is already selected.', { name: prefilledModelVersion.version_name }),
      actionLabel: t('Clear prefill')
    };
  }, [prefilledModelVersion, preferredModelVersionId, t]);

  const readyAttachmentCount = useMemo(
    () => attachments.filter((attachment) => attachment.status === 'ready').length,
    [attachments]
  );

  const runtimeSummary = useMemo(() => {
    const reachableCount = runtimeChecks.filter((check) => check.configured && check.reachable).length;
    const configuredCount = runtimeChecks.filter((check) => check.configured).length;

    if (runtimeLoading) {
      return {
        tone: 'info' as const,
        title: t('Checking Runtime'),
        description: t('Checking readiness.')
      };
    }

    if (reachableCount > 0) {
      return {
        tone: 'success' as const,
        title: t('Runtime ready'),
        description: t('At least one framework is available.')
      };
    }

    if (configuredCount > 0) {
      return {
        tone: 'warning' as const,
        title: t('Runtime configured'),
        description: t('Configured, but not reachable yet.')
      };
    }

    return {
      tone: 'warning' as const,
      title: t('Runtime not configured'),
      description: t('Choose local mode or an endpoint first.')
    };
  }, [runtimeChecks, runtimeLoading, t]);

  const hasTransientInferenceState = useMemo(
    () =>
      attachments.some((attachment) => attachment.status === 'uploading' || attachment.status === 'processing') ||
      runs.some((run) => run.status === 'queued' || run.status === 'running'),
    [attachments, runs]
  );

  useEffect(() => {
    if (!selectedRunSummary?.id || !selectedRunSummary.model_version_id) {
      return;
    }
    const syncKey = `${selectedRunSummary.id}:${selectedRunSummary.model_version_id}`;
    if (runVersionSyncAppliedRef.current === syncKey) {
      return;
    }
    runVersionSyncAppliedRef.current = syncKey;
    if (selectedVersionId === selectedRunSummary.model_version_id) {
      return;
    }
    if (!versions.some((version) => version.id === selectedRunSummary.model_version_id)) {
      return;
    }
    setSelectedVersionId(selectedRunSummary.model_version_id);
    setRunSelectionSyncHint(
      t('Synced model version to match run {runId}.', { runId: selectedRunSummary.id })
    );
  }, [selectedRunSummary?.id, selectedRunSummary?.model_version_id, selectedVersionId, t, versions]);

  useEffect(() => {
    if (!runSelectionSyncHint) {
      return;
    }
    const timer = window.setTimeout(() => {
      setRunSelectionSyncHint('');
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [runSelectionSyncHint]);

  useBackgroundPolling(
    () => {
      loadAll('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: hasTransientInferenceState
    }
  );

  const loadRuntimeConnectivity = useCallback(async () => {
    setRuntimeLoading(true);
    try {
      const result = await api.getRuntimeConnectivity();
      setRuntimeChecks(result);
    } catch {
      setRuntimeChecks([]);
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuntimeConnectivity();
  }, [loadRuntimeConnectivity]);

  useEffect(() => {
    if (!preferredVisionTaskId) {
      setLinkedVisionTask(null);
      setLinkedVisionTaskError('');
      return;
    }

    let active = true;
    api
      .getVisionTask(preferredVisionTaskId)
      .then((task) => {
        if (!active) {
          return;
        }
        setLinkedVisionTask(task);
        setLinkedVisionTaskError('');
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setLinkedVisionTask(null);
        setLinkedVisionTaskError((error as Error).message);
      });
    return () => {
      active = false;
    };
  }, [preferredVisionTaskId]);

  useEffect(() => {
    if (feedbackDatasets.length === 0) {
      if (selectedDatasetId) {
        setSelectedDatasetId('');
      }
      return;
    }

    if (!feedbackDatasets.some((dataset) => dataset.id === selectedDatasetId)) {
      setSelectedDatasetId(feedbackDatasets[0].id);
    }
  }, [feedbackDatasets, selectedDatasetId]);

  useEffect(() => {
    if (
      selectedRun?.feedback_dataset_id &&
      feedbackDatasets.some((dataset) => dataset.id === selectedRun.feedback_dataset_id) &&
      selectedDatasetId !== selectedRun.feedback_dataset_id
    ) {
      setSelectedDatasetId(selectedRun.feedback_dataset_id);
    }
  }, [feedbackDatasets, selectedDatasetId, selectedRun?.feedback_dataset_id]);

  useEffect(() => {
    if (
      linkedVisionTaskFeedbackDatasetId &&
      feedbackDatasets.some((dataset) => dataset.id === linkedVisionTaskFeedbackDatasetId) &&
      selectedDatasetId !== linkedVisionTaskFeedbackDatasetId
    ) {
      setSelectedDatasetId(linkedVisionTaskFeedbackDatasetId);
    }
  }, [feedbackDatasets, linkedVisionTaskFeedbackDatasetId, selectedDatasetId]);

  useEffect(() => {
    const clusterId = selectedActiveLearningCandidate?.cluster_id?.trim() ?? '';
    if (!clusterId) {
      return;
    }
    setFeedbackReason((previous) =>
      !previous || previous === 'missing_detection' || previous.startsWith('active_learning:')
        ? `active_learning:${clusterId}`
        : previous
    );
  }, [selectedActiveLearningCandidate?.cluster_id]);

  const focusInputUploader = useCallback(() => {
    inputUploaderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const focusLatestOutput = useCallback(() => {
    latestOutputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const focusFeedbackPanel = useCallback(() => {
    feedbackPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    if (!preferredFocus || loading) {
      return;
    }

    const focusKey = `${preferredFocus}:${selectedRun?.id ?? 'none'}:${selectedVersionId}:${selectedAttachmentId}`;
    if (focusAppliedRef.current === focusKey) {
      return;
    }

    const focusMap: Record<string, () => void> = {
      inputs: focusInputUploader,
      input: focusInputUploader,
      upload: focusInputUploader,
      result: focusLatestOutput,
      output: focusLatestOutput,
      feedback: focusFeedbackPanel
    };

    const action = focusMap[preferredFocus];
    if (!action) {
      return;
    }

    focusAppliedRef.current = focusKey;
    window.setTimeout(() => {
      action();
    }, 120);
  }, [
    focusFeedbackPanel,
    focusInputUploader,
    focusLatestOutput,
    loading,
    preferredFocus,
    selectedAttachmentId,
    selectedRun?.id,
    selectedVersionId
  ]);

  const validationGuidance = useMemo<ValidationGuidanceState>(() => {
    if (versions.length === 0) {
      return {
        current: 1,
        total: 5,
        title: t('Choose a registered version first'),
        description: t('Validation, feedback routing, and remote delivery should stay anchored to one concrete model version.'),
        badgeTone: 'warning',
        badgeLabel: t('Need version'),
        actions: [{ label: t('Open Model Versions'), to: selectedRunDeliveryPath }]
      };
    }

    if (readyAttachmentCount === 0) {
      return {
        current: 2,
        total: 5,
        title: t('Upload one ready validation input'),
        description: t('Add at least one image input here before you judge runtime quality or send anything back for rework.'),
        badgeTone: 'warning',
        badgeLabel: t('Need input'),
        actions: [{ label: t('Jump to input upload'), onClick: focusInputUploader }]
      };
    }

    if (!selectedVersion || !selectedAttachmentId) {
      return {
        current: 2,
        total: 5,
        title: t('Select version and input'),
        description: t('Choose both the model version and the ready input so the next run is attached to the correct scope.'),
        badgeTone: 'info',
        badgeLabel: t('Selection needed'),
        actions: [{ label: t('Jump to input upload'), onClick: focusInputUploader }]
      };
    }

    if (!selectedRun) {
      return {
        current: 3,
        total: 5,
        title: t('Run the first validation sample'),
        description: t('Execute one concrete sample first so output quality, feedback routing, and downstream delivery all have a visible record.'),
        badgeTone: 'info',
        badgeLabel: t('Ready to run'),
        actions: [
          { label: t('Jump to run result'), onClick: focusLatestOutput },
          { label: t('Open version delivery lane'), to: selectedRunDeliveryPath, variant: 'ghost' }
        ]
      };
    }

    if (selectedRunNotice || runtimeSummary.tone !== 'success') {
      return {
        current: 3,
        total: 5,
        title: t('Fix execution path before trusting this result'),
        description: selectedRunNotice?.description ?? runtimeSummary.description,
        badgeTone: selectedRunNotice?.tone === 'danger' ? 'danger' : 'warning',
        badgeLabel: selectedRunNotice?.tone === 'danger' ? t('Output risk') : t('Runtime check'),
        actions: [
          { label: t('Open Runtime Settings'), to: runtimeSettingsPath },
          { label: t('Focus feedback panel'), onClick: focusFeedbackPanel, variant: 'ghost' }
        ]
      };
    }

    if (feedbackDatasets.length === 0) {
      return {
        current: 4,
        total: 5,
        title: t('Create or choose a matching feedback dataset'),
        description: t('This run is ready to review, but there is no dataset with task type {taskType} available for feedback routing yet.', {
          taskType: t(feedbackTaskType ?? selectedRun.task_type)
        }),
        badgeTone: 'info',
        badgeLabel: t('Need dataset'),
        actions: [
          { label: t('Back to Datasets'), to: scopedDatasetsPath },
          { label: t('Open version delivery lane'), to: selectedRunDeliveryPath, variant: 'ghost' }
        ]
      };
    }

    if (!selectedRun.feedback_dataset_id) {
      return {
        current: 4,
        total: 5,
        title: t('Route one validation result back to feedback'),
        description: t('Send this run back to one dataset so annotation, versioning, and retraining can continue from the exact bad case instead of a vague note.'),
        badgeTone: 'info',
        badgeLabel: t('Feedback needed'),
        actions: [
          { label: t('Focus feedback panel'), onClick: focusFeedbackPanel },
          { label: t('Open feedback dataset'), to: selectedFeedbackDatasetPath, variant: 'ghost' }
        ]
      };
    }

    if (selectedRunVersion?.status === 'registered') {
      return {
        current: 5,
        total: 5,
        title: t('Continue into annotation or controlled delivery'),
        description: t('Feedback is already linked to dataset {dataset}. Continue in annotation to correct the sample, or move into the version delivery lane for device and API rollout.', {
          dataset: selectedRunFeedbackDataset?.name ?? selectedRun.feedback_dataset_id
        }),
        badgeTone: 'success',
        badgeLabel: t('Closed loop visible'),
        actions: [
          { label: t('Open Annotation Workspace'), to: scopedAnnotationPath },
          { label: t('Open version delivery lane'), to: selectedRunDeliveryPath, variant: 'secondary' },
          { label: t('Open feedback dataset'), to: selectedFeedbackDatasetPath, variant: 'ghost' }
        ]
      };
    }

    return {
      current: 5,
      total: 5,
      title: t('Continue into annotation and dataset iteration'),
      description: t('Feedback is already linked to dataset {dataset}. Finish correction there, then continue into dataset versioning and training from the dataset lane.', {
        dataset: selectedRunFeedbackDataset?.name ?? selectedRun.feedback_dataset_id ?? t('the linked dataset')
      }),
      badgeTone: 'success',
      badgeLabel: t('Feedback linked'),
      actions: [
        { label: t('Open Annotation Workspace'), to: scopedAnnotationPath },
        { label: t('Open feedback dataset'), to: selectedFeedbackDatasetPath, variant: 'secondary' }
      ]
    };
  }, [
    feedbackDatasets.length,
    feedbackTaskType,
    focusFeedbackPanel,
    focusInputUploader,
    focusLatestOutput,
    readyAttachmentCount,
    runtimeSummary.description,
    runtimeSummary.tone,
    scopedAnnotationPath,
    scopedDatasetsPath,
    selectedAttachmentId,
    selectedFeedbackDatasetPath,
    selectedRun,
    selectedRunDeliveryPath,
    selectedRunFeedbackDataset?.name,
    selectedRunNotice,
    selectedRunVersion?.status,
    selectedVersion,
    runtimeSettingsPath,
    t,
    versions.length
  ]);

  const refreshSelectedRunDetail = useCallback(async (runId: string) => {
    if (!runId) {
      setSelectedRunDetail(null);
      setSelectedRunError('');
      return;
    }

    setSelectedRunLoading(true);
    setSelectedRunError('');
    try {
      const detail = await api.getInferenceRun(runId);
      setSelectedRunDetail(detail);
      setRuns((prev) => {
        const exists = prev.some((run) => run.id === detail.id);
        const next = exists ? prev.map((run) => (run.id === detail.id ? detail : run)) : [detail, ...prev];
        return [...next].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      });
    } catch (error) {
      setSelectedRunError((error as Error).message);
    } finally {
      setSelectedRunLoading(false);
    }
  }, []);

  useEffect(() => {
    const targetRunId = selectedRunSummary?.id ?? '';
    if (!targetRunId) {
      setSelectedRunDetail(null);
      setSelectedRunError('');
      return;
    }

    const summaryUpdatedAt = selectedRunSummary?.updated_at ?? '';
    const detailUpdatedAt = selectedRunDetail?.updated_at ?? '';

    if (selectedRunDetail?.id === targetRunId && summaryUpdatedAt === detailUpdatedAt) {
      return;
    }

    void refreshSelectedRunDetail(targetRunId);
  }, [
    refreshSelectedRunDetail,
    selectedRunDetail?.id,
    selectedRunDetail?.updated_at,
    selectedRunSummary?.id,
    selectedRunSummary?.updated_at
  ]);

  const uploadInput = async (filename: string) => {
    await api.uploadInferenceAttachment(filename);
    await loadAll('manual');
  };

  const uploadInputFiles = async (files: File[]) => {
    for (const file of files) {
      await api.uploadInferenceFile(file);
    }
    await loadAll('manual');
  };

  const removeInput = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    let fallbackReadyAttachmentId = '';
    setAttachments((prev) => {
      const next = prev.filter((attachment) => attachment.id !== attachmentId);
      fallbackReadyAttachmentId = next.find((attachment) => attachment.status === 'ready')?.id ?? '';
      return next;
    });
    setSelectedAttachmentId((prev) => (prev === attachmentId ? fallbackReadyAttachmentId : prev));
    loadAll('background').catch(() => {
      setFeedback({ variant: 'success', text: backgroundSyncHint });
    });
  };

  const runInference = async () => {
    if (!selectedVersion || !selectedAttachmentId) {
      setFeedback({ variant: 'error', text: t('Select a version and a ready input first.') });
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const created = await api.runInference({
        model_version_id: selectedVersion.id,
        input_attachment_id: selectedAttachmentId,
        task_type: selectedVersion.task_type
      });

      setFeedback({ variant: 'success', text: t('Inference complete.') });
      await loadAll('manual');
      setSelectedRunId(created.id);
      await refreshSelectedRunDetail(created.id);
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const sendFeedback = async () => {
    if (!selectedRun || !selectedDatasetId) {
      setFeedback({ variant: 'error', text: t('Run inference first, then choose a dataset.') });
      return;
    }

    if (!selectedFeedbackDataset || selectedFeedbackDataset.task_type !== selectedRun.task_type) {
      setFeedback({
        variant: 'error',
        text: t('Feedback dataset task type must match.')
      });
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      await api.sendInferenceFeedback({
        run_id: selectedRun.id,
        dataset_id: selectedDatasetId,
        reason: feedbackReason
      });

      setFeedback({ variant: 'success', text: t('Sample routed back.') });
      await loadAll('manual');
      await refreshSelectedRunDetail(selectedRun.id);
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <WorkspacePage>
        <PageHeader
        eyebrow={t('Validation')}
        title={t('Inference Validation')}
        description={t('Run once, then route failures back.')}
          primaryAction={{
            label: refreshing ? t('Refreshing...') : t('Refresh'),
            onClick: () => {
              loadAll('manual').catch((error) => {
                setFeedback({ variant: 'error', text: (error as Error).message });
              });
            },
            disabled: busy || refreshing
          }}
        />
        <StateBlock variant="loading" title={t('Loading Validation Workspace')} description={t('Preparing resources.')} />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Validation')}
        title={t('Inference Validation')}
        description={t('Run one sample, inspect the result, then route it back.')}
        meta={
          <div className="stack tight">
            <div className="row gap wrap align-center">
              <Badge tone="neutral">{t('Ready inputs')}: {readyAttachmentCount}</Badge>
              {hasTrainingLaunchContext ? (
                <Badge tone="info">{t('Context linked')}</Badge>
              ) : (
                <Badge tone="neutral">{t('Context open')}</Badge>
              )}
            </div>
            <TrainingLaunchContextPills
              taskType={launchContext.taskType}
              framework={launchContext.framework}
              executionTarget={launchContext.executionTarget}
              workerId={launchContext.workerId}
              t={t}
            />
          </div>
        }
        primaryAction={{
          label: busy ? t('Running...') : t('Run Inference'),
          onClick: () => {
            void runInference();
          },
          disabled: busy || refreshing || !selectedVersionId || !selectedAttachmentId
        }}
        secondaryActions={
          hasTrainingLaunchContext ? (
            <div className="row gap wrap">
              <ButtonLink to={returnTrainingLaunchPath} variant="secondary" size="sm">
                {t('Return to training launch')}
              </ButtonLink>
              <ButtonLink to={runtimeSettingsPath} variant="ghost" size="sm">
                {t('Open Runtime Settings')}
              </ButtonLink>
              <ButtonLink to={workerSettingsPath} variant="ghost" size="sm">
                {t('Worker Settings')}
              </ButtonLink>
            </div>
          ) : undefined
        }
        />

      {feedback ? (
        <InlineAlert
          tone={feedback.variant === 'success' ? 'success' : 'danger'}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}
      {runSelectionSyncHint ? (
        <InlineAlert tone="info" title={t('Selection synced')} description={runSelectionSyncHint} />
      ) : null}
      {runPrefillMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested run not found')}
          description={t('The run from the incoming link is unavailable. Showing the latest available run instead.')}
          actions={
            <ButtonLink to={clearPrefillPath} variant="ghost" size="sm">
              {t('Clear prefill')}
            </ButtonLink>
          }
        />
      ) : null}
      {datasetPrefillMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested dataset not found')}
          description={t('The dataset from the incoming link is unavailable. Switched to available validation resources.')}
          actions={
            <ButtonLink to={clearDatasetContextPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}
      {versionFilterBlockerHint ? (
        <InlineAlert
          tone="warning"
          title={t('Incoming filters do not match available versions')}
          description={versionFilterBlockerHint}
          actions={
            <ButtonLink to={clearVersionFiltersPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}

      {runtimeSummary.tone === 'success' ? null : (
        <InlineAlert
          tone={runtimeSummary.tone}
          title={runtimeSummary.title}
          description={runtimeSummary.description}
          actions={
            <ButtonLink to={runtimeSettingsPath} variant="secondary" size="sm">
              {t('Open Runtime')}
            </ButtonLink>
          }
        />
      )}

      {modelVersionPrefillBanner ? (
        <InlineAlert
          tone={modelVersionPrefillBanner.tone}
          title={modelVersionPrefillBanner.title}
          description={modelVersionPrefillBanner.description}
          actions={
            modelVersionPrefillBanner.actionLabel === t('Clear prefill') ? (
              <ButtonLink to={clearPrefillPath} variant="ghost" size="sm">
                {modelVersionPrefillBanner.actionLabel}
              </ButtonLink>
            ) : (
              <ButtonLink to={selectedRunDeliveryPath} variant="secondary" size="sm">
                {modelVersionPrefillBanner.actionLabel}
              </ButtonLink>
            )
          }
        />
      ) : null}
      {linkedVisionTaskError ? (
        <InlineAlert tone="warning" title={t('Vision task context unavailable')} description={linkedVisionTaskError} />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <div className="workspace-toolbar-head">
              <div className="workspace-toolbar-copy">
                <h3>{t('Inputs')}</h3>
                <small className="muted">{t('Select a version and a ready input.')}</small>
              </div>
            </div>
            <div className="workspace-filter-grid">
              {versions.length > 0 ? (
                <label className="stack tight">
                  <small className="muted">{t('Model Version')}</small>
                  <Select value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}>
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.version_name} ({t(version.task_type)} / {t(version.framework)})
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              {readyAttachmentCount > 0 ? (
                <label className="stack tight">
                  <small className="muted">{t('Input Attachment')}</small>
                  <Select
                    value={selectedAttachmentId}
                    onChange={(event) => setSelectedAttachmentId(event.target.value)}
                  >
                    {attachments
                      .filter((attachment) => attachment.status === 'ready')
                      .map((attachment) => (
                        <option key={attachment.id} value={attachment.id}>
                          {attachment.filename}
                        </option>
                      ))}
                  </Select>
                </label>
              ) : null}
              {versions.length === 0 || readyAttachmentCount === 0 ? (
                <small className="muted">
                  {t('Add a version and one ready input to enable validation.')}
                </small>
              ) : null}
            </div>
          </Card>
        }
        main={
          <div className="workspace-main-stack">
            {versions.length === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No versions yet')}
                description={t('Add a version first.')}
                extra={
                  <ButtonLink to={selectedRunDeliveryPath} variant="secondary" size="sm">
                    {t('Open Versions')}
                  </ButtonLink>
                }
              />
            ) : readyAttachmentCount === 0 ? (
              <StateBlock
                variant="empty"
                title={t('No ready inputs yet')}
                description={t('Upload one ready input first.')}
                extra={<small className="muted">{t('Try again after upload.')}</small>}
              />
            ) : null}

            <div ref={inputUploaderRef}>
              <AttachmentUploader
                title={t('Inference Inputs')}
                items={attachments}
                onUpload={uploadInput}
                onUploadFiles={uploadInputFiles}
                contentUrlBuilder={api.attachmentContentUrl}
                onDelete={removeInput}
                emptyDescription={t('Upload an image to validate it.')}
                uploadButtonLabel={t('Upload Inference Input')}
                disabled={busy}
              />
            </div>

            <div ref={latestOutputRef}>
              <Card as="article">
                <WorkspaceSectionHeader
                  title={t('Run result')}
                  description={t('Review status and normalized output.')}
                  actions={
                    selectedRun ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void refreshSelectedRunDetail(selectedRun.id)}
                        disabled={selectedRunLoading}
                      >
                        {selectedRunLoading ? t('Refreshing...') : t('Refresh selected run')}
                      </Button>
                    ) : null
                  }
                />

                {!selectedRun ? (
                  <StateBlock
                    variant="empty"
                    title={t('No runs yet')}
                    description={t('Run once to see a result.')}
                    extra={<small className="muted">{t('Choose a version and input above first.')}</small>}
                  />
                ) : (
                  <>
                    {selectedRunError ? (
                      <StateBlock variant="error" title={t('Run detail unavailable')} description={selectedRunError} />
                    ) : null}
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {t('Run')}: {selectedRunVersion?.version_name ?? t('Recent run')}
                      </Badge>
                      <Badge tone="neutral">
                        {t('Updated')}: {formatCompactTimestamp(selectedRun.updated_at, t('n/a'))}
                      </Badge>
                      <Badge tone="neutral">
                        {t('Task')}: {t(selectedRun.task_type)}
                      </Badge>
                      <Badge tone="neutral">
                        {t('Framework')}: {t(selectedRun.framework)}
                      </Badge>
                      <Badge tone="info">
                        {t('Execution')}: {runtimeInsight?.displaySourceLabel ?? t('Unknown execution')}
                      </Badge>
                    </div>
                    <StateBlock
                      variant={runtimeInsight?.variant ?? 'empty'}
                      title={runtimeInsight?.title ?? t('Fallback output active')}
                      description={
                        runtimeInsight?.description ??
                        t('Runtime is unavailable, showing fallback output.')
                      }
                    />
                    {selectedRunNotice ? (
                      <InlineAlert
                        tone={selectedRunNotice.tone}
                        title={selectedRunNotice.title}
                        description={selectedRunNotice.description}
                      />
                    ) : null}
                    <Suspense
                      fallback={
                        <StateBlock
                          variant="loading"
                          title={t('Loading')}
                          description={t('Preparing result preview.')}
                        />
                      }
                    >
                      <PredictionVisualizer output={selectedRun.normalized_output} imageUrl={selectedRunPreviewUrl} />
                    </Suspense>
                    <details className="workspace-details">
                      <summary>{t('Raw output (advanced)')}</summary>
                      <pre className="code-block">
                        {JSON.stringify(
                          {
                            raw_output: selectedRun.raw_output,
                            normalized_output: selectedRun.normalized_output
                          },
                          null,
                          2
                        )}
                      </pre>
                    </details>
                  </>
                )}
              </Card>
            </div>
          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <WorkspaceNextStepCard
              title={t('Validation handoff')}
              description={t('Keep the next validation action obvious while you inspect one run at a time.')}
              stepLabel={validationGuidance.title}
              stepDetail={validationGuidance.description}
              current={validationGuidance.current}
              total={validationGuidance.total}
              badgeLabel={validationGuidance.badgeLabel}
              badgeTone={validationGuidance.badgeTone}
              actions={validationGuidance.actions.map((action) =>
                action.to ? (
                  <ButtonLink key={`${action.label}:${action.to}`} to={action.to} variant={action.variant ?? 'primary'} size="sm">
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button
                    key={action.label}
                    type="button"
                    variant={action.variant ?? 'primary'}
                    size="sm"
                    onClick={action.onClick}
                  >
                    {action.label}
                  </Button>
                )
              )}
            />
            {linkedVisionTask ? (
              <SectionCard
                title={t('Vision task context')}
                description={t('This validation run was opened from a task-level active-learning lane.')}
                actions={
                  <div className="inline-actions">
                    <Badge tone="info">{linkedVisionTask.id}</Badge>
                    {selectedActiveLearningCluster ? (
                      <Badge tone="neutral">{t(selectedActiveLearningCluster.title)}</Badge>
                    ) : null}
                  </div>
                }
              >
                <div className="stack-tight">
                  <small className="muted">
                    {selectedActiveLearningCandidate
                      ? t('This run is one of the task\'s current active-learning candidates.')
                      : t('Keep task context visible while you inspect and route the current run.')}
                  </small>
                  {linkedVisionTask.active_learning_pool ? (
                    <small className="muted">
                      {t('Active learning pool')}: {linkedVisionTask.active_learning_pool.total_candidates} ·{' '}
                      {t('Candidate clusters')}: {linkedVisionTask.active_learning_pool.clusters.length}
                    </small>
                  ) : null}
                  {linkedVisionTaskFeedbackDataset ? (
                    <small className="muted">
                      {t('This task already has a linked feedback dataset. Routing this run there keeps the data loop tight.')}
                    </small>
                  ) : null}
                  <ActionBar
                    primary={
                      linkedVisionTaskPath ? (
                        <ButtonLink to={linkedVisionTaskPath} variant="secondary" size="sm">
                          {t('Open vision task')}
                        </ButtonLink>
                      ) : undefined
                    }
                    secondary={
                      requestedReturnTo ? (
                        <ButtonLink to={requestedReturnTo} variant="ghost" size="sm">
                          {t('Return to task')}
                        </ButtonLink>
                      ) : undefined
                    }
                  />
                </div>
              </SectionCard>
            ) : null}
            <div ref={feedbackPanelRef}>
              <SectionCard
                title={t('Feedback')}
                description={t('Route the sample back to a matching dataset.')}
              >
                {!selectedRun ? (
                  <StateBlock
                    variant="empty"
                    title={t('No runs yet')}
                    description={t('Run inference first.')}
                  />
                ) : datasets.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No datasets yet')}
                    description={t('Create or import a dataset first.')}
                  />
                ) : feedbackDatasets.length === 0 ? (
                  <StateBlock
                    variant="empty"
                    title={t('No matching datasets')}
                    description={t('Create a dataset with the same task type first.')}
                    extra={
                      <ButtonLink to={scopedDatasetsPath} variant="secondary" size="sm">
                        {t('Open Datasets')}
                      </ButtonLink>
                    }
                  />
                ) : feedbackTaskType ? (
                  <small className="muted">
                    {t('Only datasets with task type {taskType} are shown.', {
                      taskType: t(feedbackTaskType)
                    })}
                  </small>
                ) : null}
                {linkedVisionTaskFeedbackDataset ? (
                  <small className="muted">
                    {t('Prefilled feedback dataset from linked vision task.')}
                  </small>
                ) : null}
                {selectedActiveLearningCluster ? (
                  <small className="muted">
                    {t('Suggested feedback reason')}: {`active_learning:${selectedActiveLearningCandidate?.cluster_id ?? ''}`} ·{' '}
                    {t(selectedActiveLearningCluster.title)}
                  </small>
                ) : null}

                <div className="workspace-form-grid">
                  <label>
                    {t('Target Dataset')}
                    <Select
                      value={selectedDatasetId}
                      onChange={(event) => setSelectedDatasetId(event.target.value)}
                    >
                      {feedbackDatasets.map((dataset) => (
                        <option key={dataset.id} value={dataset.id}>
                          {dataset.name} ({t(dataset.task_type)})
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>

                <details className="workspace-details">
                  <summary>{t('Feedback reason')}</summary>
                  <label>
                    {t('Reason')}
                    <Input
                      value={feedbackReason}
                      onChange={(event) => setFeedbackReason(event.target.value)}
                      placeholder={t('For example: missing_detection')}
                    />
                  </label>
                </details>

                <ActionBar
                  primary={
                    <Button onClick={sendFeedback} disabled={busy || !selectedRun || !selectedDatasetId}>
                      {t('Send to Dataset')}
                    </Button>
                  }
                  secondary={
                    <ButtonLink to={scopedAnnotationPath} variant="ghost" size="sm">
                      {t('Open Annotation Workspace')}
                    </ButtonLink>
                  }
                />
                {selectedRun ? (
                  <small className="muted">
                    {t('The link includes queue and run metadata.')}
                  </small>
                ) : null}
              </SectionCard>

              <details className="workspace-details">
                <summary>
                  <span>{t('Recent runs')}</span>
                  <Badge tone="neutral">{runs.length}</Badge>
                </summary>
                <div className="workspace-disclosure-content">
                  <label className="stack tight">
                    <small className="muted">{t('Select run')}</small>
                    <Select
                      value={selectedRun?.id ?? ''}
                      onChange={(event) => setSelectedRunId(event.target.value)}
                      disabled={runs.length === 0}
                    >
                      {runs.length === 0 ? (
                        <option value="">{t('No runs yet')}</option>
                      ) : (
                        runs.map((run) => (
                          <option key={run.id} value={run.id}>
                            {describeRun(run)} · {formatCompactTimestamp(run.updated_at, t('n/a'))} · {t(run.status)}
                          </option>
                        ))
                      )}
                    </Select>
                  </label>
                </div>
              </details>
            </div>
          </div>
        }
      />
    </WorkspacePage>
  );
}
