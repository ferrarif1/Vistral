import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type {
  ApprovalRequest,
  DatasetRecord,
  FileAttachment,
  InferenceRunRecord,
  ModelRecord,
  ModelVersionRecord,
  RuntimeDeviceAccessRecord,
  RuntimeDeviceAccessIssueResult,
  RuntimeDeviceLifecycleSnapshot,
  TrainingJobRecord,
  User
} from '../../shared/domain';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import { Input } from '../components/ui/Field';
import WorkspaceActionStack from '../components/ui/WorkspaceActionStack';
import { Card, Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceSectionHeader, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import { deriveTrainingExecutionInsight } from '../features/trainingExecutionInsight';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import { detectInferenceRunReality } from '../utils/inferenceSource';
import {
  isStandardGateReady,
  resolveRegistrationEvidenceLevel,
  resolveRegistrationGateLevel
} from '../utils/registrationEvidence';

interface ConsoleSnapshot {
  user: User;
  datasets: DatasetRecord[];
  visibleModels: ModelRecord[];
  myModels: ModelRecord[];
  modelVersions: ModelVersionRecord[];
  conversationAttachments: FileAttachment[];
  approvals: ApprovalRequest[];
  trainingJobs: TrainingJobRecord[];
  inferenceRuns: InferenceRunRecord[];
}

interface ConsoleActionGroup {
  title: string;
  description: string;
  links: Array<{ to: string; label: string }>;
}

const backgroundRefreshIntervalMs = 6000;
type LoadMode = 'initial' | 'manual' | 'background';
const terminalTrainingStatuses = new Set<TrainingJobRecord['status']>(['completed', 'failed', 'cancelled']);
const activeTrainingStatuses = new Set<TrainingJobRecord['status']>(['queued', 'preparing', 'running', 'evaluating']);

const formatTimestamp = (iso: string): string => formatCompactTimestamp(iso);
const toTimestampValue = (iso: string | null | undefined): number => {
  if (!iso) {
    return 0;
  }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};
const isAuthenticationRequiredMessage = (message: string): boolean => message === 'Authentication required.';

type LaunchContext = {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
};

const appendTrainingLaunchContext = (searchParams: URLSearchParams, context?: LaunchContext) => {
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

const buildScopedClosurePath = (
  datasetId: string,
  versionId?: string | null,
  launchContext?: LaunchContext,
  returnTo?: string | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  return `/workflow/closure?${searchParams.toString()}`;
};

const buildClosureLandingPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/workflow/closure?${query}` : '/workflow/closure';
};
const buildScopedInferencePath = (
  modelVersionId?: string | null,
  datasetId?: string | null,
  versionId?: string | null,
  options?: {
    runId?: string | null;
    focus?: string | null;
    launchContext?: LaunchContext;
    returnTo?: string | null;
  }
): string => {
  const searchParams = new URLSearchParams();
  if (modelVersionId?.trim()) {
    searchParams.set('modelVersion', modelVersionId.trim());
  }
  if (datasetId?.trim()) {
    searchParams.set('dataset', datasetId.trim());
  }
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  if (options?.runId?.trim()) {
    searchParams.set('run', options.runId.trim());
  }
  if (options?.focus?.trim()) {
    searchParams.set('focus', options.focus.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  appendReturnTo(searchParams, options?.returnTo);
  const query = searchParams.toString();
  return query ? `/inference/validate?${query}` : '/inference/validate';
};
const buildDatasetDetailPath = (
  datasetId?: string | null,
  options?: { focus?: string | null; launchContext?: LaunchContext; returnTo?: string | null }
): string => {
  if (!datasetId?.trim()) {
    return '/datasets';
  }
  const searchParams = new URLSearchParams();
  if (options?.focus?.trim()) {
    searchParams.set('focus', options.focus.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  appendReturnTo(searchParams, options?.returnTo);
  const query = searchParams.toString();
  return query
    ? `/datasets/${encodeURIComponent(datasetId.trim())}?${query}`
    : `/datasets/${encodeURIComponent(datasetId.trim())}`;
};

const buildDatasetsPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/datasets?${query}` : '/datasets';
};

const buildTrainingCreatePath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/training/jobs/new?${query}` : '/training/jobs/new';
};

const buildRuntimeSettingsPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'readiness');
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  return `/settings/runtime?${searchParams.toString()}`;
};

const buildWorkerSettingsPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', 'inventory');
  if (launchContext?.framework?.trim()) {
    searchParams.set('profile', launchContext.framework.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  return `/settings/workers?${searchParams.toString()}`;
};

const buildTrainingJobsPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/training/jobs?${query}` : '/training/jobs';
};

const buildCreateModelPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/models/create?${query}` : '/models/create';
};

const buildMyModelsPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/models/my-models?${query}` : '/models/my-models';
};

const buildModelVersionsPath = (
  options?: {
    selectedVersionId?: string | null;
    focus?: string | null;
    launchContext?: LaunchContext;
    returnTo?: string | null;
  }
): string => {
  const searchParams = new URLSearchParams();
  if (options?.selectedVersionId?.trim()) {
    searchParams.set('selectedVersion', options.selectedVersionId.trim());
  }
  if (options?.focus?.trim()) {
    searchParams.set('focus', options.focus.trim());
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  appendReturnTo(searchParams, options?.returnTo);
  const query = searchParams.toString();
  return query ? `/models/versions?${query}` : '/models/versions';
};

const buildAdminPendingPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/admin/models/pending?${query}` : '/admin/models/pending';
};

const buildAdminAuditPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/admin/audit?${query}` : '/admin/audit';
};

const buildAdminVerificationReportsPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/admin/verification-reports?${query}` : '/admin/verification-reports';
};

const buildWorkspaceChatPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/workspace/chat?${query}` : '/workspace/chat';
};

const buildSettingsPath = (launchContext?: LaunchContext, returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/settings/account?${query}` : '/settings/account';
};

const buildLoginPath = (returnTo?: string | null): string => {
  const searchParams = new URLSearchParams();
  appendReturnTo(searchParams, returnTo);
  const query = searchParams.toString();
  return query ? `/auth/login?${query}` : '/auth/login';
};

const buildConsoleSnapshotSignature = (snapshot: ConsoleSnapshot): string =>
  JSON.stringify({
    user: {
      id: snapshot.user.id,
      role: snapshot.user.role,
      updated_at: snapshot.user.updated_at
    },
    datasets: snapshot.datasets
      .map((dataset) => ({
        id: dataset.id,
        status: dataset.status,
        updated_at: dataset.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    visibleModels: snapshot.visibleModels
      .map((model) => ({
        id: model.id,
        status: model.status,
        updated_at: model.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    myModels: snapshot.myModels
      .map((model) => ({
        id: model.id,
        status: model.status,
        updated_at: model.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    modelVersions: snapshot.modelVersions
      .map((version) => ({
        id: version.id,
        status: version.status,
        updated_at: version.created_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    conversationAttachments: snapshot.conversationAttachments
      .map((attachment) => ({
        id: attachment.id,
        status: attachment.status,
        updated_at: attachment.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    approvals: snapshot.approvals
      .map((approval) => ({
        id: approval.id,
        status: approval.status,
        requested_at: approval.requested_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    trainingJobs: snapshot.trainingJobs
      .map((job) => ({
        id: job.id,
        status: job.status,
        execution_mode: job.execution_mode,
        updated_at: job.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    inferenceRuns: snapshot.inferenceRuns
      .map((run) => ({
        id: run.id,
        status: run.status,
        execution_source: run.execution_source,
        updated_at: run.updated_at
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  });

export default function ProfessionalConsolePage() {
  const { t, roleLabel } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [latestVersionDeviceAccess, setLatestVersionDeviceAccess] = useState<RuntimeDeviceAccessRecord[]>([]);
  const [latestVersionDeviceAccessLoading, setLatestVersionDeviceAccessLoading] = useState(false);
  const [latestVersionDeviceAccessError, setLatestVersionDeviceAccessError] = useState('');
  const [latestVersionDeviceLifecycle, setLatestVersionDeviceLifecycle] =
    useState<RuntimeDeviceLifecycleSnapshot | null>(null);
  const [latestVersionDeviceLifecycleLoading, setLatestVersionDeviceLifecycleLoading] = useState(false);
  const [latestVersionDeviceLifecycleError, setLatestVersionDeviceLifecycleError] = useState('');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceMaxCalls, setNewDeviceMaxCalls] = useState('');
  const [newDeviceExpireDays, setNewDeviceExpireDays] = useState('');
  const [latestIssuedDeviceAccess, setLatestIssuedDeviceAccess] = useState<RuntimeDeviceAccessIssueResult | null>(null);
  const [deviceActionBusy, setDeviceActionBusy] = useState(false);
  const [deviceActionFeedback, setDeviceActionFeedback] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const snapshotSignatureRef = useRef('');
  const requestedContext = useMemo<LaunchContext>(
    () => ({
      datasetId: (searchParams.get('dataset') ?? '').trim() || null,
      versionId: (searchParams.get('version') ?? '').trim() || null,
      taskType: (searchParams.get('task_type') ?? '').trim() || null,
      framework: (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase() || null,
      executionTarget: (searchParams.get('execution_target') ?? '').trim().toLowerCase() || null,
      workerId: (searchParams.get('worker') ?? '').trim() || null
    }),
    [searchParams]
  );
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentConsolePath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentConsolePath;

  const load = useCallback(async (mode: LoadMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    }

    if (mode === 'manual') {
      setRefreshing(true);
    }

    setError('');

    try {
      const user = await api.me();
      const [
        datasets,
        visibleModels,
        myModels,
        modelVersions,
        conversationAttachments,
        approvals,
        trainingJobs,
        inferenceRuns
      ] = await Promise.all([
        api.listDatasets(),
        api.listModels(),
        api.listMyModels(),
        api.listModelVersions(),
        api.listConversationAttachments(),
        user.role === 'admin' ? api.listApprovalRequests() : Promise.resolve([]),
        api.listTrainingJobs(),
        api.listInferenceRuns()
      ]);

      const nextSnapshot = {
        user,
        datasets,
        visibleModels,
        myModels,
        modelVersions,
        conversationAttachments,
        approvals,
        trainingJobs,
        inferenceRuns
      };
      const nextSignature = buildConsoleSnapshotSignature(nextSnapshot);
      if (snapshotSignatureRef.current !== nextSignature) {
        snapshotSignatureRef.current = nextSignature;
        setSnapshot(nextSnapshot);
      }
    } catch (loadError) {
      setError((loadError as Error).message);
      setSnapshot(null);
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }

      if (mode === 'manual') {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    load('initial').catch(() => {
      // handled by local state
    });
  }, [load]);

  const hasTransientConsoleState = Boolean(
    snapshot?.conversationAttachments.some(
      (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
    ) ||
      snapshot?.approvals.some((approval) => approval.status === 'pending') ||
      snapshot?.trainingJobs.some((job) => activeTrainingStatuses.has(job.status))
  );

  useBackgroundPolling(
    () => {
      load('background').catch(() => {
        // no-op
      });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: hasTransientConsoleState
    }
  );

  const processingFiles =
    snapshot?.conversationAttachments.filter(
      (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
    ).length ?? 0;
  const pendingApprovals =
    snapshot?.approvals.filter((approval) => approval.status === 'pending') ?? [];
  const pendingReviews = pendingApprovals.length;

  const recentMyModels = useMemo(
    () =>
      snapshot
        ? [...snapshot.myModels]
            .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
            .slice(0, 4)
        : [],
    [snapshot]
  );
  const recentProcessingAttachments = useMemo(
    () =>
      snapshot
        ? snapshot.conversationAttachments
            .filter(
              (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
            )
            .slice(0, 4)
        : [],
    [snapshot]
  );
  const modelIndex = useMemo(
    () =>
      new Map(snapshot ? [...snapshot.visibleModels, ...snapshot.myModels].map((model) => [model.id, model]) : []),
    [snapshot]
  );
  const nonRealTrainingCount = useMemo(
    () =>
      snapshot
        ? snapshot.trainingJobs
            .filter((job) => terminalTrainingStatuses.has(job.status))
            .filter(
              (job) =>
                deriveTrainingExecutionInsight({
                  status: job.status,
                  executionMode: job.execution_mode,
                  artifactSummary: null
                }).reality !== 'standard'
            ).length
        : 0,
    [snapshot]
  );
  const fallbackInferenceCount = useMemo(
    () =>
      snapshot
        ? snapshot.inferenceRuns
            .map((run) => detectInferenceRunReality(run))
            .filter((reality) => reality.fallback).length
        : 0,
    [snapshot]
  );
  const hasRealityWarning = nonRealTrainingCount > 0 || fallbackInferenceCount > 0;
  const trainingJobsById = useMemo(
    () => new Map(snapshot ? snapshot.trainingJobs.map((job) => [job.id, job]) : []),
    [snapshot]
  );
  const latestCompletedTrainingJob = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    return (
      [...snapshot.trainingJobs]
        .filter((job) => job.status === 'completed')
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0] ?? null
    );
  }, [snapshot]);
  const latestRegisteredVersion = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    const registered = snapshot.modelVersions.filter((version) => version.status === 'registered');
    if (registered.length === 0) {
      return null;
    }
    if (latestCompletedTrainingJob) {
      const aligned = registered
        .filter((version) => version.training_job_id === latestCompletedTrainingJob.id)
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      if (aligned.length > 0) {
        return aligned[0];
      }
    }
    return [...registered].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0] ?? null;
  }, [latestCompletedTrainingJob, snapshot]);
  const latestVersionTrainingJob = useMemo(() => {
    if (!latestRegisteredVersion?.training_job_id) {
      return latestCompletedTrainingJob;
    }
    return trainingJobsById.get(latestRegisteredVersion.training_job_id) ?? latestCompletedTrainingJob;
  }, [latestCompletedTrainingJob, latestRegisteredVersion, trainingJobsById]);
  const latestVersionRuns = useMemo(() => {
    if (!snapshot || !latestRegisteredVersion) {
      return [];
    }
    return [...snapshot.inferenceRuns]
      .filter((run) => run.model_version_id === latestRegisteredVersion.id)
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  }, [latestRegisteredVersion, snapshot]);
  const latestVersionRun = latestVersionRuns[0] ?? null;
  const latestVersionFeedbackRun = latestVersionRuns.find((run) => Boolean(run.feedback_dataset_id)) ?? null;
  const closureDatasetId = latestVersionTrainingJob?.dataset_id ?? '';
  const closureDatasetVersionId = latestVersionTrainingJob?.dataset_version_id ?? '';
  const launchTaskType = requestedContext.taskType ?? latestVersionTrainingJob?.task_type ?? null;
  const launchFramework =
    requestedContext.framework ??
    latestRegisteredVersion?.framework ??
    latestVersionTrainingJob?.framework ??
    (launchTaskType === 'ocr'
      ? 'paddleocr'
      : launchTaskType === 'detection' ||
          launchTaskType === 'classification' ||
          launchTaskType === 'segmentation' ||
          launchTaskType === 'obb'
        ? 'yolo'
        : null);
  const launchContext: LaunchContext = {
    datasetId: requestedContext.datasetId ?? (closureDatasetId || null),
    versionId: requestedContext.versionId ?? (closureDatasetVersionId || null),
    taskType: launchTaskType,
    framework: launchFramework,
    executionTarget: requestedContext.executionTarget ?? null,
    workerId: requestedContext.workerId ?? null
  };
  const requestedDatasetMissing = useMemo(
    () =>
      Boolean(
        requestedContext.datasetId &&
          snapshot &&
          !snapshot.datasets.some((dataset) => dataset.id === requestedContext.datasetId)
      ),
    [requestedContext.datasetId, snapshot]
  );
  const clearRequestedContextPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('dataset');
    next.delete('version');
    next.delete('task_type');
    next.delete('framework');
    next.delete('profile');
    next.delete('execution_target');
    next.delete('worker');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);
  const scopedClosurePath = launchContext.datasetId
    ? buildScopedClosurePath(
        launchContext.datasetId,
        launchContext.versionId ?? null,
        launchContext,
        outboundReturnTo
      )
    : buildClosureLandingPath(launchContext, outboundReturnTo);
  const scopedInferencePath = buildScopedInferencePath(
    latestRegisteredVersion?.id ?? null,
    closureDatasetId || null,
    closureDatasetVersionId || null,
    {
      launchContext,
      returnTo: outboundReturnTo
    }
  );
  const scopedLatestRunPath = buildScopedInferencePath(
    latestRegisteredVersion?.id ?? null,
    closureDatasetId || null,
    closureDatasetVersionId || null,
    {
      runId: latestVersionRun?.id ?? null,
      focus: latestVersionRun ? 'result' : null,
      launchContext,
      returnTo: outboundReturnTo
    }
  );
  const scopedFeedbackDatasetPath = buildDatasetDetailPath(
    latestVersionFeedbackRun?.feedback_dataset_id ?? null,
    { focus: latestVersionFeedbackRun ? 'workflow' : null, launchContext, returnTo: outboundReturnTo }
  );
  const registrationGateLevel = latestRegisteredVersion
    ? resolveRegistrationGateLevel(latestRegisteredVersion)
    : 'pending';
  const registrationEvidenceLevel = latestRegisteredVersion
    ? resolveRegistrationEvidenceLevel(latestRegisteredVersion.registration_evidence_mode)
    : 'pending';
  const registrationGateLabel = latestRegisteredVersion
    ? registrationGateLevel === 'override'
      ? t('Policy override')
      : registrationGateLevel === 'standard'
        ? t('Standard gate')
        : t('Gate pending')
    : '-';
  const registrationEvidenceLabel = latestRegisteredVersion
    ? registrationEvidenceLevel === 'standard'
      ? t('Standard evidence')
      : registrationEvidenceLevel === 'calibrated'
        ? t('Calibrated evidence')
        : registrationEvidenceLevel === 'compatibility'
          ? t('Compatibility evidence')
          : t('Pending evidence')
    : '-';
  const standardGateReady = Boolean(latestRegisteredVersion && isStandardGateReady(latestRegisteredVersion));
  const runtimePublicInferenceEndpoint =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/runtime/public/inference`
      : '/api/runtime/public/inference';
  const runtimePublicModelPackageEndpoint =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/runtime/public/model-package`
      : '/api/runtime/public/model-package';

  const loadLatestVersionRuntimeVisibility = useCallback(
    async (modelVersionId: string, options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setLatestVersionDeviceAccessLoading(true);
        setLatestVersionDeviceLifecycleLoading(true);
      }
      setLatestVersionDeviceAccessError('');
      setLatestVersionDeviceLifecycleError('');

      const [deviceAccessResult, lifecycleResult] = await Promise.allSettled([
        api.listRuntimeDeviceAccess(modelVersionId),
        api.getRuntimeDeviceLifecycle(modelVersionId)
      ]);

      if (deviceAccessResult.status === 'fulfilled') {
        setLatestVersionDeviceAccess(
          [...deviceAccessResult.value].sort((left, right) => {
            const leftTime = toTimestampValue(left.last_used_at ?? left.issued_at);
            const rightTime = toTimestampValue(right.last_used_at ?? right.issued_at);
            return rightTime - leftTime;
          })
        );
      } else {
        setLatestVersionDeviceAccess([]);
        setLatestVersionDeviceAccessError(deviceAccessResult.reason instanceof Error ? deviceAccessResult.reason.message : String(deviceAccessResult.reason));
      }

      if (lifecycleResult.status === 'fulfilled') {
        setLatestVersionDeviceLifecycle(lifecycleResult.value);
      } else {
        setLatestVersionDeviceLifecycle(null);
        setLatestVersionDeviceLifecycleError(lifecycleResult.reason instanceof Error ? lifecycleResult.reason.message : String(lifecycleResult.reason));
      }

      if (!options?.silent) {
        setLatestVersionDeviceAccessLoading(false);
        setLatestVersionDeviceLifecycleLoading(false);
      }
    },
    []
  );

  const copyToClipboard = useCallback(
    async (text: string, label: string) => {
      const value = text.trim();
      if (!value) {
        return;
      }

      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value);
        } else {
          const textArea = document.createElement('textarea');
          textArea.value = value;
          textArea.setAttribute('readonly', 'readonly');
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
        }
        setDeviceActionFeedback({ tone: 'success', text: t('{label} copied.', { label }) });
      } catch (copyError) {
        setDeviceActionFeedback({
          tone: 'danger',
          text: t('Copy failed: {message}', { message: (copyError as Error).message })
        });
      }
    },
    [t]
  );

  useEffect(() => {
    if (!latestRegisteredVersion) {
      setLatestVersionDeviceAccess([]);
      setLatestVersionDeviceAccessLoading(false);
      setLatestVersionDeviceAccessError('');
      setLatestVersionDeviceLifecycle(null);
      setLatestVersionDeviceLifecycleLoading(false);
      setLatestVersionDeviceLifecycleError('');
      setLatestIssuedDeviceAccess(null);
      return;
    }

    void loadLatestVersionRuntimeVisibility(latestRegisteredVersion.id);
  }, [latestRegisteredVersion?.id, loadLatestVersionRuntimeVisibility]);

  useBackgroundPolling(
    () => {
      if (!latestRegisteredVersion) {
        return;
      }
      void loadLatestVersionRuntimeVisibility(latestRegisteredVersion.id, { silent: true });
    },
    {
      intervalMs: backgroundRefreshIntervalMs,
      enabled: Boolean(latestRegisteredVersion)
    }
  );

  const issueDeviceAccess = useCallback(async () => {
    if (!latestRegisteredVersion) {
      setDeviceActionFeedback({
        tone: 'danger',
        text: t('Register a model version before issuing device access.')
      });
      return;
    }
    if (!latestVersionFeedbackRun) {
      setDeviceActionFeedback({
        tone: 'danger',
        text: t('Finish inference + feedback loop before issuing device access.')
      });
      return;
    }

    const deviceName = newDeviceName.trim();
    if (!deviceName) {
      setDeviceActionFeedback({ tone: 'danger', text: t('Device name is required.') });
      return;
    }

    let maxCalls: number | null = null;
    if (newDeviceMaxCalls.trim()) {
      const parsed = Number.parseInt(newDeviceMaxCalls.trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setDeviceActionFeedback({ tone: 'danger', text: t('max_calls must be a positive integer.') });
        return;
      }
      maxCalls = parsed;
    }

    let expiresAt: string | null = null;
    if (newDeviceExpireDays.trim()) {
      const days = Number.parseInt(newDeviceExpireDays.trim(), 10);
      if (!Number.isFinite(days) || days <= 0) {
        setDeviceActionFeedback({ tone: 'danger', text: t('Expire days must be a positive integer.') });
        return;
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    setDeviceActionBusy(true);
    setDeviceActionFeedback(null);
    try {
      const issued = await api.issueRuntimeDeviceAccess({
        model_version_id: latestRegisteredVersion.id,
        device_name: deviceName,
        max_calls: maxCalls,
        expires_at: expiresAt
      });
      setLatestIssuedDeviceAccess(issued);
      setNewDeviceName('');
      setNewDeviceExpireDays('');
      setNewDeviceMaxCalls('');
      await loadLatestVersionRuntimeVisibility(latestRegisteredVersion.id);
      setDeviceActionFeedback({
        tone: 'success',
        text: t('Device access key issued for {device}. Keep this key in your device secret manager.', {
          device: issued.record.device_name
        })
      });
    } catch (issueError) {
      setDeviceActionFeedback({ tone: 'danger', text: (issueError as Error).message });
    } finally {
      setDeviceActionBusy(false);
    }
  }, [
    latestRegisteredVersion,
    latestVersionFeedbackRun,
    loadLatestVersionRuntimeVisibility,
    newDeviceExpireDays,
    newDeviceMaxCalls,
    newDeviceName,
    t
  ]);

  const latestVersionActiveDeviceAccessCount = useMemo(
    () =>
      latestVersionDeviceAccess.filter(
        (record) => !record.is_expired && (record.remaining_calls === null || record.remaining_calls > 0)
      ).length,
    [latestVersionDeviceAccess]
  );
  const latestVersionMostRecentlyUsedDeviceAccess = useMemo(() => {
    return (
      [...latestVersionDeviceAccess]
        .filter((record) => Boolean(record.last_used_at))
        .sort((left, right) => Date.parse(right.last_used_at ?? '') - Date.parse(left.last_used_at ?? ''))[0] ??
      null
    );
  }, [latestVersionDeviceAccess]);
  const recentVersionDeviceAccessRecords = useMemo(
    () =>
      [...latestVersionDeviceAccess]
        .slice(0, 4),
    [latestVersionDeviceAccess]
  );
  const latestPublicInferenceInvocation =
    latestVersionDeviceLifecycle?.public_inference_invocations[0] ?? null;
  const latestModelPackageDelivery =
    latestVersionDeviceLifecycle?.model_package_deliveries[0] ?? null;
  const hasRemoteOpsProof = Boolean(
    latestRegisteredVersion &&
      latestVersionDeviceAccess.length > 0 &&
      latestPublicInferenceInvocation &&
      latestModelPackageDelivery
  );
  const canReviewAudit = snapshot?.user.role === 'admin';
  const scopedModelVersionsPath = buildModelVersionsPath({
    selectedVersionId: latestRegisteredVersion?.id ?? null,
    focus: latestRegisteredVersion ? (hasRemoteOpsProof ? 'ops' : 'device') : null,
    launchContext,
    returnTo: outboundReturnTo
  });
  const scopedTrainingCreatePath = buildTrainingCreatePath(launchContext, outboundReturnTo);
  const scopedRuntimeSettingsPath = buildRuntimeSettingsPath(launchContext, outboundReturnTo);
  const scopedWorkerSettingsPath = buildWorkerSettingsPath(launchContext, outboundReturnTo);
  const scopedDatasetsPath = buildDatasetsPath(launchContext, outboundReturnTo);
  const scopedTrainingJobsPath = buildTrainingJobsPath(launchContext, outboundReturnTo);
  const scopedCreateModelPath = buildCreateModelPath(launchContext, outboundReturnTo);
  const scopedMyModelsPath = buildMyModelsPath(launchContext, outboundReturnTo);
  const scopedAdminApprovalsPath = buildAdminPendingPath(launchContext, outboundReturnTo);
  const scopedAdminAuditPath = buildAdminAuditPath(launchContext, outboundReturnTo);
  const scopedVerificationReportsPath = buildAdminVerificationReportsPath(
    launchContext,
    outboundReturnTo
  );
  const scopedWorkspaceChatPath = buildWorkspaceChatPath(launchContext, outboundReturnTo);
  const scopedSettingsPath = buildSettingsPath(launchContext, outboundReturnTo);
  const scopedLoginPath = buildLoginPath(outboundReturnTo);
  const deviceLifecycleTimeline = useMemo(() => {
    const credentialEvents = latestVersionDeviceAccess.map((record) => ({
      id: `credential-${record.binding_key}`,
      kind: 'credential' as const,
      title: t('Credential ready for device {device}', { device: record.device_name }),
      subtitle: `${record.binding_key} · ${record.api_key_masked}`,
      detail:
        `${t('remaining calls')}: ${record.remaining_calls ?? 'unlimited'} · ` +
        `${t('last used')}: ${formatTimestamp(record.last_used_at ?? '')}`,
      timestamp: record.issued_at ?? record.last_used_at ?? '',
      statusTone: record.is_expired ? 'danger' : 'success',
      statusLabel: record.is_expired ? t('expired') : t('active')
    }));
    const inferenceEvents =
      latestVersionDeviceLifecycle?.public_inference_invocations.map((record) => ({
        id: record.id,
        kind: 'inference' as const,
        title: t('Public inference invoked'),
        subtitle: `${record.request_id} · ${record.runtime_auth_binding_key}`,
        detail: `${record.filename} · ${record.execution_source}`,
        timestamp: record.created_at,
        statusTone: 'neutral' as const,
        statusLabel: record.framework
      })) ?? [];
    const deliveryEvents =
      latestVersionDeviceLifecycle?.model_package_deliveries.map((record) => ({
        id: record.id,
        kind: 'delivery' as const,
        title: t('Encrypted model package delivered'),
        subtitle: `${record.delivery_id} · ${record.runtime_auth_binding_key}`,
        detail: `${record.source_filename} · ${record.source_byte_size} bytes`,
        timestamp: record.generated_at,
        statusTone: 'info' as const,
        statusLabel: record.framework
      })) ?? [];

    return [...credentialEvents, ...inferenceEvents, ...deliveryEvents]
      .sort((left, right) => toTimestampValue(right.timestamp) - toTimestampValue(left.timestamp))
      .slice(0, 8);
  }, [latestVersionDeviceAccess, latestVersionDeviceLifecycle, t]);

  const actionGroups: ConsoleActionGroup[] = useMemo(() => {
    const groups: ConsoleActionGroup[] = [
      {
        title: t('Build & Ship'),
        description: t('Move from draft to version.'),
        links: [
          { to: scopedCreateModelPath, label: t('Create New Model') },
          { to: scopedMyModelsPath, label: t('Manage My Models') },
          { to: scopedModelVersionsPath, label: t('Open Model Versions') }
        ]
      },
      {
        title: t('Data & Run'),
        description: t('Open data, training, and validation.'),
        links: [
          { to: scopedClosurePath, label: t('Training Closure Wizard') },
          { to: scopedDatasetsPath, label: t('Manage Datasets') },
          { to: scopedTrainingJobsPath, label: t('Open Training Jobs') },
          { to: scopedInferencePath, label: t('Validate Inference') }
        ]
      }
    ];

    if (snapshot?.user.role === 'admin') {
      groups.push({
        title: t('Admin & Audit'),
        description: t('Review approvals and audit trails.'),
        links: [
          { to: scopedAdminApprovalsPath, label: t('Review Approval Queue') },
          { to: scopedAdminAuditPath, label: t('View Audit Logs') },
          { to: scopedVerificationReportsPath, label: t('View Verification Reports') }
        ]
      });
    }

    return groups;
  }, [
    scopedAdminApprovalsPath,
    scopedAdminAuditPath,
    scopedClosurePath,
    scopedCreateModelPath,
    scopedDatasetsPath,
    scopedInferencePath,
    scopedModelVersionsPath,
    scopedMyModelsPath,
    scopedTrainingJobsPath,
    scopedVerificationReportsPath,
    snapshot?.user.role,
    t
  ]);

  const priorityMode =
    pendingApprovals.length > 0
      ? 'approval'
      : recentMyModels.length > 0
        ? 'model'
        : recentProcessingAttachments.length > 0
          ? 'attachment'
          : 'idle';
  const priorityDescription =
    priorityMode === 'approval'
      ? t('Items needing governance decisions now.')
      : priorityMode === 'model'
        ? t('Continue the latest model work without scanning the full navigation tree.')
        : priorityMode === 'attachment'
          ? t('Recent files still processing can be resumed from chat.')
          : t('No immediate follow-up item.');
  const priorityCta =
    priorityMode === 'approval'
      ? { to: scopedAdminApprovalsPath, label: t('Open Queue') }
      : priorityMode === 'model'
        ? { to: scopedMyModelsPath, label: t('Inspect my models') }
        : priorityMode === 'attachment'
          ? { to: scopedWorkspaceChatPath, label: t('Continue in Chat') }
          : { to: scopedDatasetsPath, label: t('Open Datasets') };

  const authRequired = isAuthenticationRequiredMessage(error);

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Workspace')}
        title={t('Professional Console')}
        description={t('Focus on one priority lane, then jump in.')}
        meta={
          snapshot ? (
            <div className="row gap wrap align-center">
              <Badge tone="neutral">{t('Role')}: {roleLabel(snapshot.user.role)}</Badge>
              <Badge tone={pendingReviews > 0 ? 'warning' : 'neutral'}>
                {t('Pending reviews')}: {pendingReviews}
              </Badge>
              <Badge tone={processingFiles > 0 ? 'warning' : 'neutral'}>
                {t('Processing files')}: {processingFiles}
              </Badge>
              <Badge tone={hasRealityWarning ? 'warning' : 'success'}>
                {t('Execution warnings')}: {nonRealTrainingCount + fallbackInferenceCount}
              </Badge>
            </div>
          ) : undefined
        }
        primaryAction={{
          label: refreshing ? t('Refreshing...') : t('Refresh'),
          onClick: () => {
            load('manual').catch(() => {
              // handled by local state
            });
          },
          disabled: loading || refreshing
        }}
        secondaryActions={
          <div className="row gap wrap">
            {requestedReturnTo ? (
              <ButtonLink to={requestedReturnTo} variant="secondary" size="sm">
                {t('Return to current task')}
              </ButtonLink>
            ) : null}
            <ButtonLink to={scopedSettingsPath} variant="ghost" size="sm">
              {t('Open Settings')}
            </ButtonLink>
          </div>
        }
      />

      {loading ? (
        <StateBlock
          variant="loading"
          title={t('Loading Console')}
          description={t('Preparing workspace summary.')}
        />
      ) : error && !snapshot ? (
        authRequired ? (
          <StateBlock
            variant="empty"
            title={t('Login to open professional workspace')}
            description={t('Sign in to access operational snapshots and console actions.')}
            extra={
              <div className="chat-auth-state-actions">
                <ButtonLink to={scopedLoginPath} variant="secondary" size="sm">
                  {t('Login')}
                </ButtonLink>
              </div>
            }
          />
        ) : (
          <StateBlock variant="error" title={t('Console Load Failed')} description={error} />
        )
      ) : !snapshot ? (
        <StateBlock
          variant="empty"
        title={t('No Snapshot')}
          description={t('It fills itself after data, training, or runtime work.')}
          extra={
            <div className="row gap wrap">
              <ButtonLink to={scopedDatasetsPath} variant="secondary" size="sm">
                {t('Open Datasets')}
              </ButtonLink>
              <ButtonLink to={scopedRuntimeSettingsPath} variant="ghost" size="sm">
                {t('Open Runtime Settings')}
              </ButtonLink>
              <ButtonLink to={scopedWorkerSettingsPath} variant="ghost" size="sm">
                {t('Open Worker Settings')}
              </ButtonLink>
            </div>
          }
        />
      ) : (
        <>
          {requestedDatasetMissing ? (
            <InlineAlert
              tone="warning"
              title={t('Requested dataset context not found')}
              description={t('The dataset from the incoming link is unavailable. Console links now use the latest available context.')}
              actions={
                <ButtonLink to={clearRequestedContextPath} variant="ghost" size="sm">
                  {t('Clear context')}
                </ButtonLink>
              }
            />
          ) : null}
          {hasRealityWarning ? (
            <InlineAlert
              tone="warning"
              title={t('Execution quality warnings detected')}
              description={t(
                'Training degraded outputs: {trainingCount}; inference degraded outputs: {inferenceCount}. Check the dedicated pages before publishing.',
                {
                  trainingCount: nonRealTrainingCount,
                  inferenceCount: fallbackInferenceCount
                }
              )}
              actions={
                <div className="row gap wrap">
                  <ButtonLink to={scopedTrainingJobsPath} variant="secondary" size="sm">
                    {t('Open Training Jobs')}
                  </ButtonLink>
                  <ButtonLink to={scopedInferencePath} variant="ghost" size="sm">
                    {t('Open Inference Validation')}
                  </ButtonLink>
                </div>
              }
            />
          ) : null}

          <WorkspaceWorkbench
            toolbar={
              <Card as="section" className="workspace-toolbar-card">
                <div className="workspace-toolbar-head">
                  <div className="workspace-toolbar-copy">
                    <h3>{t('Current Priority')}</h3>
                    <small className="muted">{priorityDescription}</small>
                  </div>
                  <div className="workspace-toolbar-actions">
                    <ButtonLink to={priorityCta.to} variant="secondary" size="sm">
                      {priorityCta.label}
                    </ButtonLink>
                  </div>
                </div>
              </Card>
            }
            main={
              <div className="workspace-main-stack">
                <Card as="article">
                  <WorkspaceSectionHeader
                    title={t('Main Work Queue')}
                    description={t('Handle one priority lane, then continue in the linked page.')}
                  />

                  {priorityMode === 'idle' ? (
                    <StateBlock
                      variant="empty"
                      title={t('No follow-up items right now')}
                      description={t('No pending approvals, active model work, or processing attachments were found.')}
                      extra={
                        <div className="row gap wrap">
                          <ButtonLink to={scopedDatasetsPath} variant="secondary" size="sm">
                            {t('Open Datasets')}
                          </ButtonLink>
                          <ButtonLink to={scopedCreateModelPath} variant="ghost" size="sm">
                            {t('Create New Model')}
                          </ButtonLink>
                        </div>
                      }
                    />
                  ) : (
                    <ul className="workspace-record-list compact">
                      {priorityMode === 'approval'
                        ? pendingApprovals.slice(0, 4).map((approval) => {
                            const model = modelIndex.get(approval.model_id);
                            return (
                              <Panel key={approval.id} as="li" className="workspace-record-item compact" tone="soft">
                                <div className="workspace-record-item-top">
                                  <div className="workspace-record-summary stack tight">
                                    <strong>{model?.name ?? t('Unavailable model record')}</strong>
                                    <small className="muted">
                                      {model
                                        ? `${t(model.model_type)} · ${t(model.status)}`
                                        : t('Model record is not currently available in the catalog.')}
                                    </small>
                                    <small className="muted">
                                      {t('Requested at')}: {formatTimestamp(approval.requested_at)}
                                    </small>
                                  </div>
                                  <StatusTag status={approval.status}>{t(approval.status)}</StatusTag>
                                </div>
                                <ButtonLink to={scopedAdminApprovalsPath} variant="ghost" size="sm">
                                  {t('Open Queue')}
                                </ButtonLink>
                              </Panel>
                            );
                          })
                        : null}
                      {priorityMode === 'model'
                        ? recentMyModels.map((model) => (
                            <Panel key={model.id} as="li" className="workspace-record-item compact" tone="soft">
                              <div className="workspace-record-item-top">
                                <div className="workspace-record-summary stack tight">
                                  <strong>{model.name}</strong>
                                  <small className="muted">
                                    {t(model.model_type)} · {t(model.status)}
                                  </small>
                                  <small className="muted">
                                    {t('Last updated')}: {formatTimestamp(model.updated_at)}
                                  </small>
                                </div>
                                <StatusTag status={model.status}>{t(model.status)}</StatusTag>
                              </div>
                              <ButtonLink to={scopedMyModelsPath} variant="ghost" size="sm">
                                {t('Inspect my models')}
                              </ButtonLink>
                            </Panel>
                          ))
                        : null}
                      {priorityMode === 'attachment'
                        ? recentProcessingAttachments.map((attachment) => (
                            <Panel key={attachment.id} as="li" className="workspace-record-item compact" tone="soft">
                              <div className="workspace-record-item-top">
                                <div className="workspace-record-summary stack tight">
                                  <strong>{attachment.filename}</strong>
                                  <small className="muted">
                                    {t(attachment.status)} · {t('Last updated')}: {formatTimestamp(attachment.updated_at)}
                                  </small>
                                </div>
                                <StatusTag status={attachment.status}>{t(attachment.status)}</StatusTag>
                              </div>
                              <ButtonLink to={scopedWorkspaceChatPath} variant="ghost" size="sm">
                                {t('Continue in Chat')}
                              </ButtonLink>
                            </Panel>
                          ))
                        : null}
                    </ul>
                  )}
                </Card>

                <Card as="article">
                  <WorkspaceSectionHeader
                    title={t('Workflow Lanes')}
                    description={t('Open the dedicated page for each task.')}
                  />
                  <div className="workspace-action-grid">
                    {actionGroups.map((group) => (
                      <Panel key={group.title} as="section" className="stack tight" tone="soft">
                        <div className="stack tight">
                          <strong>{group.title}</strong>
                          <small className="muted">{group.description}</small>
                        </div>
                        <WorkspaceActionStack>
                          {group.links.map((link) => (
                            <ButtonLink key={link.to} to={link.to} variant="secondary" size="sm" block>
                              {link.label}
                            </ButtonLink>
                          ))}
                        </WorkspaceActionStack>
                      </Panel>
                    ))}
                  </div>
                </Card>

                <Card as="article">
                  <WorkspaceSectionHeader
                    title={t('Loop objects')}
                    description={t('Track exactly what has been produced in this loop.')}
                    actions={
                      <div className="row gap wrap">
                        <ButtonLink to={scopedClosurePath} variant="secondary" size="sm">
                          {t('Training Closure Wizard')}
                        </ButtonLink>
                        {latestRegisteredVersion ? (
                          <ButtonLink to={scopedModelVersionsPath} variant="ghost" size="sm">
                            {t('Continue in version delivery lane')}
                          </ButtonLink>
                        ) : null}
                        <ButtonLink to={scopedInferencePath} variant="ghost" size="sm">
                          {t('Validate Inference')}
                        </ButtonLink>
                        {latestVersionRun ? (
                          <ButtonLink to={scopedLatestRunPath} variant="ghost" size="sm">
                            {t('Open latest run')}
                          </ButtonLink>
                        ) : null}
                        {latestVersionFeedbackRun?.feedback_dataset_id ? (
                          <ButtonLink to={scopedFeedbackDatasetPath} variant="ghost" size="sm">
                            {t('Open feedback dataset')}
                          </ButtonLink>
                        ) : null}
                      </div>
                    }
                  />
                  {latestVersionTrainingJob || latestRegisteredVersion ? (
                    <div className="stack">
                      <ul className="workspace-record-list compact">
                        <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                          <strong>{t('Dataset')}</strong>
                          <small className="muted">{closureDatasetId || '-'}</small>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                          <strong>{t('Dataset Version')}</strong>
                          <small className="muted">{closureDatasetVersionId || '-'}</small>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                          <strong>{t('Training Job')}</strong>
                          <small className="muted">{latestVersionTrainingJob?.id ?? '-'}</small>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                          <strong>{t('Model Version')}</strong>
                          <small className="muted">{latestRegisteredVersion?.id ?? '-'}</small>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                          <strong>{t('Inference run')}</strong>
                          <small className="muted">{latestVersionRun?.id ?? '-'}</small>
                        </Panel>
                        <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                          <strong>{t('Feedback dataset')}</strong>
                          <small className="muted">{latestVersionFeedbackRun?.feedback_dataset_id ?? '-'}</small>
                        </Panel>
                      </ul>
                      <Card as="section">
                        <WorkspaceSectionHeader
                          title={t('Evidence & gate status')}
                          description={t('Keep evidence mode and registration gate visible for every handoff.')}
                        />
                        <ul className="workspace-record-list compact">
                          <Panel
                            as="li"
                            className="workspace-record-item compact stack tight"
                            tone={standardGateReady ? 'accent' : 'soft'}
                          >
                            <strong>{t('evidence mode')}</strong>
                            <small className="muted">{registrationEvidenceLabel}</small>
                          </Panel>
                          <Panel
                            as="li"
                            className="workspace-record-item compact stack tight"
                            tone={latestRegisteredVersion?.registration_gate_exempted ? 'danger' : 'soft'}
                          >
                            <strong>{t('gate status')}</strong>
                            <small className="muted">{registrationGateLabel}</small>
                          </Panel>
                          <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                            <strong>{t('gate interpretation')}</strong>
                            <small className="muted">
                              {latestRegisteredVersion
                                ? standardGateReady
                                  ? t('This version meets the standard registration gate.')
                                  : t('This version is usable, but still requires gate review.')
                                : '-'}
                            </small>
                          </Panel>
                        </ul>
                        {latestRegisteredVersion ? (
                          <div className="row gap wrap">
                            <Badge tone={standardGateReady ? 'success' : 'warning'}>
                              {standardGateReady
                                ? t('Registration meets standard gate')
                                : t('Registration still requires gate review')}
                            </Badge>
                          </div>
                        ) : null}
                      </Card>

                      <Card as="section">
                        <WorkspaceSectionHeader
                          title={t('Device API authorization')}
                          description={t(
                            'Issue scoped credentials so robots/edge clients can call runtime inference and pull model packages.'
                          )}
                          actions={
                            <div className="row gap wrap">
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  void issueDeviceAccess();
                                }}
                                disabled={deviceActionBusy || latestVersionDeviceAccessLoading}
                              >
                                {deviceActionBusy ? t('Working...') : t('Issue device credential')}
                              </Button>
                              <ButtonLink to={scopedClosurePath} variant="ghost" size="sm">
                                {t('Training Closure Wizard')}
                              </ButtonLink>
                              <ButtonLink to={scopedModelVersionsPath} variant="ghost" size="sm">
                                {t('Continue in version delivery lane')}
                              </ButtonLink>
                            </div>
                          }
                        />
                        {!latestRegisteredVersion ? (
                          <StateBlock
                            variant="empty"
                            title={t('No registered model version yet')}
                            description={t('Complete training and version registration first, then issue device credentials here.')}
                          />
                        ) : (
                          <div className="stack">
                            <InlineAlert
                              tone="info"
                              title={t('Use Model Versions as the main remote-delivery lane')}
                              description={t(
                                'Use this page for cross-workspace visibility. Open the version lane when you need the exact credential, inference curl, model package curl, and lifecycle proof for one concrete version.'
                              )}
                              actions={
                                <ButtonLink to={scopedModelVersionsPath} variant="secondary" size="sm">
                                  {t('Continue in version delivery lane')}
                                </ButtonLink>
                              }
                            />
                            {deviceActionFeedback ? (
                              <InlineAlert
                                tone={deviceActionFeedback.tone}
                                title={deviceActionFeedback.tone === 'success' ? t('Done') : t('Failed')}
                                description={deviceActionFeedback.text}
                              />
                            ) : null}
                            <div className="row gap wrap">
                              <Badge tone={latestVersionDeviceAccess.length > 0 ? 'success' : 'warning'}>
                                {t('Credentials')}: {latestVersionDeviceAccess.length}
                              </Badge>
                              <Badge tone={latestVersionActiveDeviceAccessCount > 0 ? 'success' : 'warning'}>
                                {t('active')}: {latestVersionActiveDeviceAccessCount}
                              </Badge>
                              <Badge tone={hasRemoteOpsProof ? 'success' : 'warning'}>
                                {hasRemoteOpsProof ? t('Remote ops ready') : t('Collecting evidence')}
                              </Badge>
                              <Badge tone="neutral">
                                {t('last used')}:{' '}
                                {formatTimestamp(latestVersionMostRecentlyUsedDeviceAccess?.last_used_at ?? '')}
                              </Badge>
                            </div>
                            <div className="row gap wrap">
                              <label className="stack tight">
                                <small className="muted">{t('Device name')}</small>
                                <Input
                                  value={newDeviceName}
                                  onChange={(event) => setNewDeviceName(event.target.value)}
                                  placeholder={t('e.g. robot-dog-unit-01')}
                                  disabled={deviceActionBusy}
                                />
                              </label>
                              <label className="stack tight">
                                <small className="muted">{t('Expire days (optional)')}</small>
                                <Input
                                  value={newDeviceExpireDays}
                                  onChange={(event) => setNewDeviceExpireDays(event.target.value)}
                                  placeholder={t('e.g. 30')}
                                  disabled={deviceActionBusy}
                                />
                              </label>
                              <label className="stack tight">
                                <small className="muted">{t('Max calls (optional)')}</small>
                                <Input
                                  value={newDeviceMaxCalls}
                                  onChange={(event) => setNewDeviceMaxCalls(event.target.value)}
                                  placeholder={t('e.g. 5000')}
                                  disabled={deviceActionBusy}
                                />
                              </label>
                            </div>
                            <Panel tone="soft" className="stack tight">
                              <strong>{t('Endpoint')}</strong>
                              <small className="muted">{runtimePublicInferenceEndpoint}</small>
                              <small className="muted">{runtimePublicModelPackageEndpoint}</small>
                            </Panel>
                            {latestIssuedDeviceAccess ? (
                              <Panel tone="soft" className="stack">
                                <strong>{t('Latest issued credential (copy once)')}</strong>
                                <small className="muted">
                                  {latestIssuedDeviceAccess.record.device_name} · {latestIssuedDeviceAccess.record.api_key_masked}
                                </small>
                                <div className="row gap wrap align-center">
                                  <small className="muted">{latestIssuedDeviceAccess.api_key}</small>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      void copyToClipboard(latestIssuedDeviceAccess.api_key, t('key'));
                                    }}
                                  >
                                    {t('Copy')}
                                  </Button>
                                </div>
                                <div className="row gap wrap align-center">
                                  <small className="muted">{t('Inference API sample')}</small>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      void copyToClipboard(
                                        latestIssuedDeviceAccess.snippets.sample_inference_curl,
                                        t('Inference API sample')
                                      );
                                    }}
                                  >
                                    {t('Copy')}
                                  </Button>
                                </div>
                                <pre>{latestIssuedDeviceAccess.snippets.sample_inference_curl}</pre>
                                <div className="row gap wrap align-center">
                                  <small className="muted">{t('Model package API sample')}</small>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      void copyToClipboard(
                                        latestIssuedDeviceAccess.snippets.sample_model_package_curl,
                                        t('Model package API sample')
                                      );
                                    }}
                                  >
                                    {t('Copy')}
                                  </Button>
                                </div>
                                <pre>{latestIssuedDeviceAccess.snippets.sample_model_package_curl}</pre>
                              </Panel>
                            ) : null}
                            {latestVersionDeviceAccessLoading ? (
                              <StateBlock
                                variant="loading"
                                title={t('Loading')}
                                description={t('Collecting recent training and inference execution sources.')}
                              />
                            ) : latestVersionDeviceAccessError ? (
                              <InlineAlert tone="danger" title={t('Load Failed')} description={latestVersionDeviceAccessError} />
                            ) : recentVersionDeviceAccessRecords.length > 0 ? (
                              <ul className="workspace-record-list compact">
                                {recentVersionDeviceAccessRecords.map((record) => (
                                  <Panel key={record.binding_key} as="li" className="workspace-record-item compact stack">
                                    <div className="workspace-record-item-top">
                                      <div className="workspace-record-summary stack tight">
                                        <strong>{record.device_name}</strong>
                                        <small className="muted">{record.binding_key}</small>
                                        <small className="muted">
                                          {t('key')}: {record.api_key_masked}
                                        </small>
                                        <small className="muted">
                                          {t('issued at')}: {formatTimestamp(record.issued_at ?? '')} · {t('remaining calls')}:{' '}
                                          {record.remaining_calls ?? 'unlimited'}
                                        </small>
                                        <small className="muted">
                                          {t('last used')}: {formatTimestamp(record.last_used_at ?? '')}
                                        </small>
                                      </div>
                                      <Badge tone={record.is_expired ? 'danger' : 'success'}>
                                {record.is_expired ? t('expired') : t('active')}
                              </Badge>
                            </div>
                          </Panel>
                                ))}
                              </ul>
                            ) : (
                              <StateBlock
                                variant="empty"
                                title={t('No device credential')}
                                description={t('Issue one credential to enable API-based model usage from field devices.')}
                              />
                            )}
                          </div>
                        )}
                      </Card>

                      <Card as="section">
                        <WorkspaceSectionHeader
                          title={t('Device delivery lifecycle')}
                          description={t(
                            'Show whether the issued credential has already been used for public inference and encrypted package delivery.'
                          )}
                        />
                        {latestVersionDeviceLifecycleLoading && !latestVersionDeviceLifecycle ? (
                          <StateBlock
                            variant="loading"
                            title={t('Loading')}
                            description={t('Collecting recent device activity.')}
                          />
                        ) : latestVersionDeviceLifecycleError ? (
                          <InlineAlert
                            tone="danger"
                            title={t('Load Failed')}
                            description={latestVersionDeviceLifecycleError}
                          />
                        ) : deviceLifecycleTimeline.length > 0 ? (
                          <div className="stack">
                            <InlineAlert
                              tone={hasRemoteOpsProof ? 'success' : 'info'}
                              title={
                                hasRemoteOpsProof
                                  ? t('Shift into remote ops monitoring and audit follow-up')
                                  : t('Keep collecting remote delivery evidence in the version lane')
                              }
                              description={
                                hasRemoteOpsProof
                                  ? t(
                                      'Credential issuance, public inference, and encrypted package delivery are all evidenced. Continue governance and operational follow-up from Model Versions.'
                                    )
                                  : t(
                                      'Keep this lane open until credential issuance, public inference, and package delivery evidence are all visible for this version.'
                                    )
                              }
                              actions={
                                <div className="row gap wrap">
                                  <ButtonLink to={scopedModelVersionsPath} variant="secondary" size="sm">
                                    {t('Open remote ops summary')}
                                  </ButtonLink>
                                  {canReviewAudit ? (
                                    <ButtonLink to={scopedAdminAuditPath} variant="ghost" size="sm">
                                      {t('Open audit logs')}
                                    </ButtonLink>
                                  ) : null}
                                </div>
                              }
                            />
                            <div className="row gap wrap">
                              <Badge tone={latestVersionDeviceAccess.length > 0 ? 'success' : 'warning'}>
                                {t('Credentials')}: {latestVersionDeviceAccess.length}
                              </Badge>
                              <Badge
                                tone={
                                  (latestVersionDeviceLifecycle?.public_inference_invocations.length ?? 0) > 0
                                    ? 'success'
                                    : 'warning'
                                }
                              >
                                {t('Public inference')}:{' '}
                                {latestVersionDeviceLifecycle?.public_inference_invocations.length ?? 0}
                              </Badge>
                              <Badge
                                tone={
                                  (latestVersionDeviceLifecycle?.model_package_deliveries.length ?? 0) > 0
                                    ? 'success'
                                    : 'warning'
                                }
                              >
                                {t('Package deliveries')}:{' '}
                                {latestVersionDeviceLifecycle?.model_package_deliveries.length ?? 0}
                              </Badge>
                            </div>
                            <ul className="workspace-record-list compact">
                              <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                                <strong>{t('Latest public inference')}</strong>
                                <small className="muted">
                                  {latestPublicInferenceInvocation
                                    ? `${latestPublicInferenceInvocation.request_id} · ${latestPublicInferenceInvocation.execution_source}`
                                    : t('No public inference has used this model version yet.')}
                                </small>
                                <small className="muted">
                                  {latestPublicInferenceInvocation
                                    ? `${latestPublicInferenceInvocation.runtime_auth_binding_key} · ${formatTimestamp(latestPublicInferenceInvocation.created_at)}`
                                    : t('Copy the inference curl from the authorization card to let a device call it once.')}
                                </small>
                              </Panel>
                              <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                                <strong>{t('Latest package delivery')}</strong>
                                <small className="muted">
                                  {latestModelPackageDelivery
                                    ? `${latestModelPackageDelivery.delivery_id} · ${latestModelPackageDelivery.source_filename}`
                                    : t('No encrypted model package has been delivered yet.')}
                                </small>
                                <small className="muted">
                                  {latestModelPackageDelivery
                                    ? `${latestModelPackageDelivery.runtime_auth_binding_key} · ${formatTimestamp(latestModelPackageDelivery.generated_at)}`
                                    : t('Copy the model package curl from the authorization card to let a device pull the package once.')}
                                </small>
                              </Panel>
                            </ul>
                            <ul className="workspace-record-list compact">
                              {deviceLifecycleTimeline.map((event) => (
                                <Panel key={event.id} as="li" className="workspace-record-item compact stack">
                                  <div className="workspace-record-item-top">
                                    <div className="workspace-record-summary stack tight">
                                      <strong>{event.title}</strong>
                                      <small className="muted">{event.subtitle}</small>
                                      <small className="muted">{event.detail}</small>
                                      <small className="muted">
                                        {t('Timestamp')}: {formatTimestamp(event.timestamp)}
                                      </small>
                                    </div>
                                    <Badge
                                      tone={event.statusTone as 'neutral' | 'info' | 'success' | 'warning' | 'danger'}
                                    >
                                      {event.statusLabel}
                                    </Badge>
                                  </div>
                                </Panel>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <StateBlock
                            variant="empty"
                            title={t('No device delivery activity yet')}
                            description={t(
                              'Issue a credential first, then let the device invoke public inference or download the encrypted package once.'
                            )}
                          />
                        )}
                      </Card>
                    </div>
                  ) : (
                    <StateBlock
                      variant="empty"
                      title={t('No training jobs yet')}
                      description={t('Create the first training job.')}
                      extra={
                        <div className="row gap wrap">
                          <ButtonLink to={scopedClosurePath} variant="secondary" size="sm">
                            {t('Training Closure Wizard')}
                          </ButtonLink>
                          <ButtonLink to={scopedTrainingCreatePath} variant="ghost" size="sm">
                            {t('Create Training Job')}
                          </ButtonLink>
                        </div>
                      }
                    />
                  )}
                </Card>
              </div>
            }
          />
        </>
      )}
    </WorkspacePage>
  );
}
