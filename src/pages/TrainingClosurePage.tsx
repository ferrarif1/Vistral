import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment,
  InferenceRunRecord,
  ModelVersionRecord,
  RuntimeDeviceAccessIssueResult,
  RuntimeDeviceAccessRecord,
  RuntimeDeviceLifecycleSnapshot,
  RuntimeReadinessReport,
  TaskType,
  TrainingWorkerNodeView,
  TrainingJobRecord,
  User
} from '../../shared/domain';
import AttachmentUploader from '../components/AttachmentUploader';
import StateBlock from '../components/StateBlock';
import WorkspaceNextStepCard from '../components/onboarding/WorkspaceNextStepCard';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import { Input, Select } from '../components/ui/Field';
import ProgressStepper from '../components/ui/ProgressStepper';
import { Card, Panel } from '../components/ui/Surface';
import { WorkspacePage, WorkspaceSectionHeader, WorkspaceWorkbench } from '../components/ui/WorkspacePage';
import useBackgroundPolling from '../hooks/useBackgroundPolling';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';
import { formatCompactTimestamp } from '../utils/formatting';
import {
  isStandardGateReady,
  resolveRegistrationEvidenceLevel,
  resolveRegistrationGateLevel
} from '../utils/registrationEvidence';

type LoadMode = 'initial' | 'manual' | 'background';
type NextActionKind = 'route' | 'scroll';
type NextAction = {
  label: string;
  kind: NextActionKind;
  to?: string;
};

interface WorkflowStep {
  key: string;
  title: string;
  detail: string;
  requirement: string;
  blocked?: string;
  done: boolean;
  primary?: {
    label: string;
    to?: string;
    onClick?: () => void;
    disabled?: boolean;
  };
  secondary?: {
    label: string;
    to?: string;
    onClick?: () => void;
    disabled?: boolean;
  };
}

const activeTrainingStatuses = new Set<TrainingJobRecord['status']>([
  'queued',
  'preparing',
  'running',
  'evaluating'
]);

const labelSchemaByTaskType: Record<TaskType, string[]> = {
  ocr: ['text_line'],
  detection: ['object'],
  classification: ['class'],
  segmentation: ['segment'],
  obb: ['object']
};

const taskTypeOptions: TaskType[] = ['ocr', 'detection', 'classification', 'segmentation', 'obb'];
const selectedDatasetStorageKey = 'vistral-training-closure-selected-dataset';
const adminAccessMessagePattern = /(forbidden|permission|unauthorized|not allowed|admin|管理员|权限)/i;

const toTime = (value: string | null | undefined): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortByUpdatedDesc = <T extends { updated_at: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => toTime(right.updated_at) - toTime(left.updated_at));

const sortByCreatedDesc = <T extends { created_at: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => toTime(right.created_at) - toTime(left.created_at));

const formatTime = (value?: string | null): string => {
  if (!value) {
    return '-';
  }
  return formatCompactTimestamp(value);
};

const buildPath = (base: string, params: Record<string, string | null | undefined>): string => {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    const normalized = value?.trim() ?? '';
    if (normalized) {
      query.set(key, normalized);
    }
  });
  const queryString = query.toString();
  return queryString ? `${base}?${queryString}` : base;
};

type LaunchContext = {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: string | null;
  workerId?: string | null;
  returnTo?: string | null;
};

const appendTrainingLaunchContext = (
  params: Record<string, string | null | undefined>,
  context?: LaunchContext
): Record<string, string | null | undefined> => ({
  ...params,
  dataset: params.dataset ?? context?.datasetId ?? null,
  version: params.version ?? context?.versionId ?? null,
  task_type: params.task_type ?? context?.taskType ?? null,
  framework: params.framework ?? context?.framework ?? null,
  execution_target:
    params.execution_target ?? (context?.executionTarget && context.executionTarget !== 'auto' ? context.executionTarget : null),
  worker: params.worker ?? context?.workerId ?? null,
  return_to:
    params.return_to ??
    (() => {
      const returnTo = context?.returnTo?.trim() ?? '';
      if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('://')) {
        return null;
      }
      return returnTo;
    })()
});

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

const readStoredDatasetId = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    return (window.localStorage.getItem(selectedDatasetStorageKey) ?? '').trim();
  } catch {
    return '';
  }
};

const writeStoredDatasetId = (datasetId: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const normalized = datasetId.trim();
    if (normalized) {
      window.localStorage.setItem(selectedDatasetStorageKey, normalized);
      return;
    }
    window.localStorage.removeItem(selectedDatasetStorageKey);
  } catch {
    // Ignore storage errors in local client mode.
  }
};

export default function TrainingClosurePage() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = sanitizeReturnToPath(searchParams.get('return_to'));
  const currentTaskPath = useMemo(
    () => `${location.pathname}${location.search || ''}`,
    [location.pathname, location.search]
  );
  const outboundReturnTo = requestedReturnTo ?? currentTaskPath;
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredDatasetAppliedRef = useRef(false);
  const selectedDatasetIdRef = useRef('');
  const uploaderAnchorRef = useRef<HTMLDivElement | null>(null);
  const deviceAccessAnchorRef = useRef<HTMLDivElement | null>(null);

  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [trainingJobs, setTrainingJobs] = useState<TrainingJobRecord[]>([]);
  const [modelVersions, setModelVersions] = useState<ModelVersionRecord[]>([]);
  const [inferenceRuns, setInferenceRuns] = useState<InferenceRunRecord[]>([]);
  const [datasetVersions, setDatasetVersions] = useState<DatasetVersionRecord[]>([]);
  const [datasetAttachments, setDatasetAttachments] = useState<FileAttachment[]>([]);
  const [deviceAccessRecords, setDeviceAccessRecords] = useState<RuntimeDeviceAccessRecord[]>([]);
  const [deviceLifecycle, setDeviceLifecycle] = useState<RuntimeDeviceLifecycleSnapshot | null>(null);
  const [deviceLifecycleLoading, setDeviceLifecycleLoading] = useState(false);
  const [deviceLifecycleError, setDeviceLifecycleError] = useState('');
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeReadinessReport | null>(null);
  const [runtimeReadinessError, setRuntimeReadinessError] = useState('');
  const [workers, setWorkers] = useState<TrainingWorkerNodeView[]>([]);
  const [workersAccessDenied, setWorkersAccessDenied] = useState(false);
  const [workersError, setWorkersError] = useState('');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState(() => readStoredDatasetId());

  const [newDatasetName, setNewDatasetName] = useState('');
  const [newDatasetTaskType, setNewDatasetTaskType] = useState<TaskType>('ocr');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceMaxCalls, setNewDeviceMaxCalls] = useState('');
  const [newDeviceExpireDays, setNewDeviceExpireDays] = useState('');
  const [latestIssuedDeviceAccess, setLatestIssuedDeviceAccess] = useState<RuntimeDeviceAccessIssueResult | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const backgroundSyncHint = t(
    'Background sync is unavailable right now. Deletion is already applied locally. Click Refresh to retry.'
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
        setFeedback({ tone: 'success', text: t('{label} copied.', { label }) });
      } catch (error) {
        setFeedback({
          tone: 'danger',
          text: t('Copy failed: {message}', { message: (error as Error).message })
        });
      }
    },
    [t]
  );

  useEffect(() => {
    selectedDatasetIdRef.current = selectedDatasetId;
  }, [selectedDatasetId]);

  useEffect(() => {
    writeStoredDatasetId(selectedDatasetId);
  }, [selectedDatasetId]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const normalizedDatasetId = selectedDatasetId.trim();
    if (normalizedDatasetId) {
      next.set('dataset', normalizedDatasetId);
    } else {
      next.delete('dataset');
    }

    const currentQuery = searchParams.toString();
    const nextQuery = next.toString();
    if (nextQuery === currentQuery) {
      return;
    }

    navigate(nextQuery ? `${location.pathname}?${nextQuery}` : location.pathname, {
      replace: true
    });
  }, [location.pathname, navigate, searchParams, selectedDatasetId]);

  const loadAll = useCallback(
    async (mode: LoadMode = 'initial', datasetIdHint?: string) => {
      if (mode === 'initial') {
        setLoading(true);
      }
      if (mode === 'manual') {
        setRefreshing(true);
      }

      try {
        const [datasetList, jobs, versions, runs, runtimeReadinessResult, workerInventoryResult, currentUserResult] =
          await Promise.all([
            api.listDatasets(),
            api.listTrainingJobs(),
            api.listModelVersions(),
            api.listInferenceRuns(),
            api
              .getRuntimeReadiness()
              .then((report) => ({ ok: true as const, report }))
              .catch((error) => ({ ok: false as const, error: error as Error })),
            api
              .listTrainingWorkers()
              .then((inventory) => ({ ok: true as const, inventory }))
              .catch((error) => ({ ok: false as const, error: error as Error })),
            api.me().catch(() => null)
          ]);

        setDatasets(datasetList);
        setTrainingJobs(jobs);
        setModelVersions(versions);
        setInferenceRuns(runs);
        setCurrentUser(currentUserResult);
        if (runtimeReadinessResult.ok) {
          setRuntimeReadiness(runtimeReadinessResult.report);
          setRuntimeReadinessError('');
        } else {
          setRuntimeReadiness(null);
          setRuntimeReadinessError(runtimeReadinessResult.error.message);
        }
        if (workerInventoryResult.ok) {
          setWorkers(workerInventoryResult.inventory);
          setWorkersAccessDenied(false);
          setWorkersError('');
        } else {
          const workerMessage = workerInventoryResult.error.message;
          setWorkers([]);
          if (adminAccessMessagePattern.test(workerMessage)) {
            setWorkersAccessDenied(true);
            setWorkersError('');
          } else {
            setWorkersAccessDenied(false);
            setWorkersError(workerMessage);
          }
        }

        const preferredDataset =
          !preferredDatasetAppliedRef.current && preferredDatasetId
            ? datasetList.find((dataset) => dataset.id === preferredDatasetId) ?? null
            : null;

        if (preferredDataset) {
          preferredDatasetAppliedRef.current = true;
        }

        const fallbackDataset =
          sortByUpdatedDesc(datasetList).find((dataset) => dataset.task_type === 'ocr') ??
          sortByUpdatedDesc(datasetList)[0] ??
          null;

        const chosenDataset =
          preferredDataset ??
          datasetList.find((dataset) => dataset.id === (datasetIdHint ?? selectedDatasetIdRef.current)) ??
          fallbackDataset;

        const chosenDatasetId = chosenDataset?.id ?? '';
        if (chosenDatasetId !== selectedDatasetIdRef.current) {
          setSelectedDatasetId(chosenDatasetId);
        }

        if (chosenDatasetId) {
          const [attachments, versionsForDataset] = await Promise.all([
            api.listDatasetAttachments(chosenDatasetId),
            api.listDatasetVersions(chosenDatasetId)
          ]);
          setDatasetAttachments(attachments);
          setDatasetVersions(versionsForDataset);
        } else {
          setDatasetAttachments([]);
          setDatasetVersions([]);
        }
      } catch (error) {
        if (mode !== 'background') {
          setFeedback({ tone: 'danger', text: (error as Error).message });
        }
      } finally {
        if (mode === 'initial') {
          setLoading(false);
        }
        if (mode === 'manual') {
          setRefreshing(false);
        }
      }
    },
    [preferredDatasetId]
  );

  useEffect(() => {
    void loadAll('initial');
  }, [loadAll]);

  const hasTransientState = useMemo(
    () =>
      datasetAttachments.some(
        (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
      ) || trainingJobs.some((job) => activeTrainingStatuses.has(job.status)),
    [datasetAttachments, trainingJobs]
  );

  useBackgroundPolling(
    () => {
      void loadAll('background');
    },
    {
      intervalMs: 8000,
      enabled: hasTransientState
    }
  );

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId]
  );
  const requestedDatasetMissing = useMemo(
    () => Boolean(preferredDatasetId && datasets.length > 0 && !datasets.some((dataset) => dataset.id === preferredDatasetId)),
    [datasets, preferredDatasetId]
  );
  const clearRequestedDatasetPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('dataset');
    next.delete('version');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);
  const readyAttachments = useMemo(
    () => datasetAttachments.filter((attachment) => attachment.status === 'ready'),
    [datasetAttachments]
  );
  const latestTrainableVersion = useMemo(() => {
    const trainable = datasetVersions.filter(
      (version) =>
        (version.split_summary.train ?? 0) > 0 && (version.annotation_coverage ?? 0) > 0
    );
    return sortByCreatedDesc(trainable)[0] ?? null;
  }, [datasetVersions]);
  const latestVersion = useMemo(() => sortByCreatedDesc(datasetVersions)[0] ?? null, [datasetVersions]);

  const latestCompletedJob = useMemo(() => {
    if (!selectedDatasetId) {
      return null;
    }

    const completedForDataset = sortByUpdatedDesc(
      trainingJobs.filter(
        (job) => job.dataset_id === selectedDatasetId && job.status === 'completed'
      )
    );
    if (completedForDataset.length === 0) {
      return null;
    }

    if (!latestTrainableVersion) {
      return completedForDataset[0];
    }

    const aligned = completedForDataset.find(
      (job) => job.dataset_version_id === latestTrainableVersion.id
    );
    return aligned ?? completedForDataset[0];
  }, [latestTrainableVersion, selectedDatasetId, trainingJobs]);

  const latestActiveJob = useMemo(() => {
    if (!selectedDatasetId) {
      return null;
    }

    const activeForDataset = sortByUpdatedDesc(
      trainingJobs.filter(
        (job) => job.dataset_id === selectedDatasetId && activeTrainingStatuses.has(job.status)
      )
    );
    return activeForDataset[0] ?? null;
  }, [selectedDatasetId, trainingJobs]);

  const latestRegisteredVersion = useMemo(() => {
    if (!latestCompletedJob) {
      return null;
    }
    const registered = sortByCreatedDesc(
      modelVersions.filter(
        (version) =>
          version.status === 'registered' && version.training_job_id === latestCompletedJob.id
      )
    );
    return registered[0] ?? null;
  }, [latestCompletedJob, modelVersions]);

  const { latestRun, latestFeedbackRun } = useMemo(() => {
    if (!latestRegisteredVersion) {
      return { latestRun: null as InferenceRunRecord | null, latestFeedbackRun: null as InferenceRunRecord | null };
    }

    const runs = sortByUpdatedDesc(
      inferenceRuns.filter((run) => run.model_version_id === latestRegisteredVersion.id)
    );
    return {
      latestRun: runs[0] ?? null,
      latestFeedbackRun: runs.find((run) => Boolean(run.feedback_dataset_id)) ?? null
    };
  }, [inferenceRuns, latestRegisteredVersion]);
  const latestPublicInferenceInvocation =
    deviceLifecycle?.public_inference_invocations[0] ?? null;
  const latestModelPackageDelivery =
    deviceLifecycle?.model_package_deliveries[0] ?? null;
  const hasRemoteOpsProof = Boolean(
    latestRegisteredVersion &&
      deviceAccessRecords.length > 0 &&
      latestPublicInferenceInvocation &&
      latestModelPackageDelivery
  );
  const deviceLifecycleTimeline = useMemo(() => {
    const credentialEvents = deviceAccessRecords.map((record) => ({
      id: `credential-${record.binding_key}`,
      title: t('Credential ready for device {device}', { device: record.device_name }),
      subtitle: `${record.binding_key} · ${record.api_key_masked}`,
      detail:
        `${t('remaining calls')}: ${record.remaining_calls ?? 'unlimited'} · ` +
        `${t('last used')}: ${formatTime(record.last_used_at)}`,
      timestamp: record.issued_at ?? record.last_used_at ?? '',
      badgeTone: record.is_expired ? 'danger' : 'success',
      badgeLabel: record.is_expired ? t('expired') : t('active')
    }));
    const inferenceEvents =
      deviceLifecycle?.public_inference_invocations.map((record) => ({
        id: record.id,
        title: t('Public inference invoked'),
        subtitle: `${record.request_id} · ${record.runtime_auth_binding_key}`,
        detail: `${record.filename} · ${record.execution_source}`,
        timestamp: record.created_at,
        badgeTone: 'neutral' as const,
        badgeLabel: record.framework
      })) ?? [];
    const deliveryEvents =
      deviceLifecycle?.model_package_deliveries.map((record) => ({
        id: record.id,
        title: t('Encrypted model package delivered'),
        subtitle: `${record.delivery_id} · ${record.runtime_auth_binding_key}`,
        detail: `${record.source_filename} · ${record.source_byte_size} bytes`,
        timestamp: record.generated_at,
        badgeTone: 'info' as const,
        badgeLabel: record.framework
      })) ?? [];

    return [...credentialEvents, ...inferenceEvents, ...deliveryEvents]
      .sort((left, right) => toTime(right.timestamp) - toTime(left.timestamp))
      .slice(0, 6);
  }, [deviceAccessRecords, deviceLifecycle, t]);
  const workerOnlineCount = useMemo(
    () => workers.filter((worker) => worker.effective_status === 'online').length,
    [workers]
  );
  const workerDrainingCount = useMemo(
    () => workers.filter((worker) => worker.effective_status === 'draining').length,
    [workers]
  );
  const runtimeReadinessTone = useMemo(() => {
    if (!runtimeReadiness) {
      return runtimeReadinessError ? 'warning' : 'neutral';
    }
    if (runtimeReadiness.status === 'ready') {
      return 'success';
    }
    if (runtimeReadiness.status === 'degraded') {
      return 'warning';
    }
    return 'danger';
  }, [runtimeReadiness, runtimeReadinessError]);
  const preferredLaunchWorker = useMemo(() => {
    const eligibleWorkers = workers.filter(
      (worker) => worker.enabled && worker.effective_status === 'online' && Boolean(worker.endpoint)
    );
    if (eligibleWorkers.length !== 1) {
      return null;
    }
    return eligibleWorkers[0];
  }, [workers]);

  const loadDeviceSurface = useCallback(async (modelVersionId: string, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setDeviceLifecycleLoading(true);
    }
    setDeviceLifecycleError('');

    try {
      const [deviceAccessResult, lifecycleResult] = await Promise.allSettled([
        api.listRuntimeDeviceAccess(modelVersionId),
        api.getRuntimeDeviceLifecycle(modelVersionId)
      ]);

      if (deviceAccessResult.status === 'fulfilled') {
        setDeviceAccessRecords(
          [...deviceAccessResult.value].sort(
            (left, right) => toTime(right.last_used_at ?? right.issued_at) - toTime(left.last_used_at ?? left.issued_at)
          )
        );
      } else {
        setDeviceAccessRecords([]);
        throw new Error(
          deviceAccessResult.reason instanceof Error
            ? deviceAccessResult.reason.message
            : String(deviceAccessResult.reason)
        );
      }

      if (lifecycleResult.status === 'fulfilled') {
        setDeviceLifecycle(lifecycleResult.value);
        setDeviceLifecycleError('');
      } else {
        setDeviceLifecycle(null);
        setDeviceLifecycleError(
          lifecycleResult.reason instanceof Error
            ? lifecycleResult.reason.message
            : String(lifecycleResult.reason)
        );
      }
    } finally {
      if (!options?.silent) {
        setDeviceLifecycleLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!latestRegisteredVersion) {
      setDeviceAccessRecords([]);
      setDeviceLifecycle(null);
      setDeviceLifecycleLoading(false);
      setDeviceLifecycleError('');
      setLatestIssuedDeviceAccess(null);
      return;
    }

    void loadDeviceSurface(latestRegisteredVersion.id).catch((error) => {
      setFeedback({ tone: 'danger', text: (error as Error).message });
    });
  }, [latestRegisteredVersion, loadDeviceSurface]);

  useBackgroundPolling(
    () => {
      if (!latestRegisteredVersion) {
        return;
      }
      void loadDeviceSurface(latestRegisteredVersion.id, { silent: true });
    },
    {
      intervalMs: 8000,
      enabled: Boolean(latestRegisteredVersion)
    }
  );

  const registrationGateLabel = useMemo(() => {
    if (!latestRegisteredVersion) {
      return '-';
    }
    const gateLevel = resolveRegistrationGateLevel(latestRegisteredVersion);
    return gateLevel === 'override'
      ? t('Policy override')
      : gateLevel === 'standard'
        ? t('Standard gate')
        : t('Gate pending');
  }, [latestRegisteredVersion, t]);
  const registrationEvidenceLabel = useMemo(() => {
    if (!latestRegisteredVersion) {
      return '-';
    }
    const evidenceLevel = resolveRegistrationEvidenceLevel(latestRegisteredVersion.registration_evidence_mode);
    if (evidenceLevel === 'standard') {
      return t('Standard evidence');
    }
    if (evidenceLevel === 'calibrated') {
      return t('Calibrated evidence');
    }
    if (evidenceLevel === 'compatibility') {
      return t('Compatibility evidence');
    }
    return t('Pending evidence');
  }, [latestRegisteredVersion, t]);

  const standardGateReady = useMemo(
    () =>
      Boolean(
        latestRegisteredVersion &&
          isStandardGateReady(latestRegisteredVersion)
      ),
    [latestRegisteredVersion]
  );
  const canReviewAudit = currentUser?.role === 'admin';
  const launchTaskType = selectedDataset?.task_type ?? latestCompletedJob?.task_type ?? null;
  const launchFramework =
    latestRegisteredVersion?.framework ??
    latestCompletedJob?.framework ??
    (launchTaskType === 'ocr'
      ? 'paddleocr'
      : launchTaskType === 'detection' ||
          launchTaskType === 'classification' ||
          launchTaskType === 'segmentation' ||
          launchTaskType === 'obb'
        ? 'yolo'
        : null);
  const launchContext: LaunchContext = {
    datasetId: selectedDatasetId || null,
    versionId: latestTrainableVersion?.id ?? null,
    taskType: launchTaskType,
    framework: launchFramework,
    executionTarget: preferredLaunchWorker ? 'worker' : null,
    workerId: preferredLaunchWorker?.id ?? null,
    returnTo: outboundReturnTo
  };

  const datasetDetailPath = selectedDatasetId
    ? buildPath(`/datasets/${encodeURIComponent(selectedDatasetId)}`, appendTrainingLaunchContext({}, launchContext))
    : '/datasets';
  const annotationPath = selectedDatasetId
    ? buildPath(`/datasets/${encodeURIComponent(selectedDatasetId)}/annotate`, appendTrainingLaunchContext({}, launchContext))
    : '/datasets';
  const trainingCreatePath = buildPath(
    '/training/jobs/new',
    appendTrainingLaunchContext(
      {
        dataset: selectedDatasetId || null,
        version: latestTrainableVersion?.id ?? null,
        task_type: selectedDataset?.task_type ?? null
      },
      launchContext
    )
  );
  const trainingJobsPath = buildPath(
    '/training/jobs',
    appendTrainingLaunchContext({}, launchContext)
  );
  const registerVersionPath = buildPath(
    '/models/versions',
    appendTrainingLaunchContext(
      {
        job: latestCompletedJob?.id ?? null,
        version_name: latestCompletedJob
          ? `${selectedDataset?.name ?? 'model'}-${latestCompletedJob.framework}-v1`
          : null
      },
      launchContext
    )
  );
  const versionDeliveryPath = buildPath(
    '/models/versions',
    appendTrainingLaunchContext(
      {
        selectedVersion: latestRegisteredVersion?.id ?? null,
        focus: latestRegisteredVersion ? (hasRemoteOpsProof ? 'ops' : 'device') : null
      },
      launchContext
    )
  );
  const inferencePath = buildPath(
    '/inference/validate',
    appendTrainingLaunchContext(
      {
        modelVersion: latestRegisteredVersion?.id ?? null,
        dataset: selectedDatasetId || null,
        version: latestTrainableVersion?.id ?? null,
        task_type: launchTaskType,
        framework: launchFramework,
        execution_target: preferredLaunchWorker ? 'worker' : null,
        worker: preferredLaunchWorker?.id ?? null
      },
      launchContext
    )
  );
  const latestRunPath = buildPath(
    '/inference/validate',
    appendTrainingLaunchContext(
      {
        modelVersion: latestRegisteredVersion?.id ?? null,
        dataset: selectedDatasetId || null,
        version: latestTrainableVersion?.id ?? null,
        run: latestRun?.id ?? null,
        focus: latestRun ? 'result' : null,
        task_type: launchTaskType,
        framework: launchFramework,
        execution_target: preferredLaunchWorker ? 'worker' : null,
        worker: preferredLaunchWorker?.id ?? null
      },
      launchContext
    )
  );
  const latestFeedbackDatasetPath = buildPath(
    latestFeedbackRun?.feedback_dataset_id
      ? `/datasets/${encodeURIComponent(latestFeedbackRun.feedback_dataset_id)}`
      : '/datasets',
    appendTrainingLaunchContext(
      {
        focus: latestFeedbackRun ? 'workflow' : null
      },
      launchContext
    )
  );
  const runtimeSettingsPath = buildPath(
    '/settings/runtime',
    appendTrainingLaunchContext(
      {
        focus: 'readiness',
        framework: launchFramework
      },
      launchContext
    )
  );
  const workerSettingsPath = buildPath(
    '/settings/workers',
    appendTrainingLaunchContext(
      {
        focus: 'inventory',
        profile: launchFramework
      },
      launchContext
    )
  );
  const runtimeTemplatesPath = buildPath(
    '/settings/runtime/templates',
    appendTrainingLaunchContext(
      {
        framework: launchFramework
      },
      launchContext
    )
  );
  const workspaceConsolePath = buildPath(
    '/workspace/console',
    appendTrainingLaunchContext({}, launchContext)
  );
  const adminAuditPath = buildPath(
    '/admin/audit',
    appendTrainingLaunchContext({}, launchContext)
  );

  const scrollToUploader = useCallback(() => {
    uploaderAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const scrollToDeviceAccess = useCallback(() => {
    deviceAccessAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const steps = useMemo<WorkflowStep[]>(() => {
    const hasDataset = Boolean(selectedDataset);
    const hasImages = readyAttachments.length > 0;
    const processingAttachmentCount = datasetAttachments.filter(
      (attachment) => attachment.status === 'uploading' || attachment.status === 'processing'
    ).length;
    const failedAttachmentCount = datasetAttachments.filter(
      (attachment) => attachment.status === 'error'
    ).length;
    const hasTrainableVersion = Boolean(latestTrainableVersion);
    const hasCompletedTraining = Boolean(latestCompletedJob);
    const hasRegisteredVersion = Boolean(latestRegisteredVersion);
    const hasFeedbackLoop = Boolean(latestFeedbackRun);
    const hasDeviceAuthorization = deviceAccessRecords.length > 0;

    return [
      {
        key: 'upload',
        title: t('Bring your images'),
        detail: hasDataset
          ? hasImages
            ? t('Ready files: {count}. Dataset: {dataset}', {
                count: String(readyAttachments.length),
                dataset: selectedDataset?.name ?? '-'
              })
            : processingAttachmentCount > 0
              ? t('Files are still preparing ({count}). Wait until at least one file is ready.', {
                  count: String(processingAttachmentCount)
                })
              : failedAttachmentCount > 0
                ? t('Some uploads failed ({count}). Re-upload failed files before annotation.', {
                    count: String(failedAttachmentCount)
                  })
                : t('No ready images yet for this dataset. Upload files to continue.')
          : t('Create or select a dataset first, then upload your files.'),
        requirement: t('One selected dataset and at least one ready image.'),
        blocked: !hasDataset
          ? t('No dataset context yet. Create a dataset below first.')
          : hasImages
            ? undefined
            : processingAttachmentCount > 0
              ? t('Uploads are still processing. Wait for ready status.')
              : failedAttachmentCount > 0
                ? t('Some files are in error state. Re-upload failed files.')
                : t('Upload at least one image to this dataset.'),
        done: hasDataset && hasImages,
        primary: hasDataset
          ? hasImages
            ? {
                label: t('Open dataset'),
                to: datasetDetailPath
              }
            : {
                label: t('Upload images here'),
                onClick: scrollToUploader
              }
          : undefined
      },
      {
        key: 'annotate',
        title: t('Annotate and freeze a trainable version'),
        detail: hasTrainableVersion
          ? t('Version {version} is trainable. train={train}, coverage={coverage}', {
              version: latestTrainableVersion?.version_name ?? '-',
              train: String(latestTrainableVersion?.split_summary.train ?? 0),
              coverage: `${Math.round((latestTrainableVersion?.annotation_coverage ?? 0) * 100)}%`
            })
          : latestVersion
            ? t('Current latest version is not trainable yet. Add annotation coverage and train split.')
            : t('No dataset version yet. Annotate files, split train/val/test, then create a version.'),
        requirement: t('A dataset version with train split > 0 and annotation coverage > 0.'),
        blocked: !hasDataset
          ? t('Select or create a dataset first.')
          : !hasImages
            ? t('You need ready images before annotation and versioning.')
            : latestVersion
              ? t('Latest version exists but is not trainable yet. Improve annotation coverage and split.')
              : t('No dataset version created yet. Finish annotation and create a version.'),
        done: hasTrainableVersion,
        primary: hasDataset
          ? {
              label: t('Open annotation workspace'),
              to: annotationPath
            }
          : undefined,
        secondary: hasDataset
          ? {
              label: t('Open dataset detail'),
              to: datasetDetailPath
            }
          : undefined
      },
      {
        key: 'train',
        title: t('Launch training'),
        detail: hasCompletedTraining
          ? t('Latest completed job: {job} ({framework}) at {time}', {
              job: latestCompletedJob?.id ?? '-',
              framework: latestCompletedJob?.framework ?? '-',
              time: formatTime(latestCompletedJob?.updated_at)
            })
          : latestActiveJob
            ? t('Training job {job} is {status}. Wait for completion before registration.', {
                job: latestActiveJob.id,
                status: latestActiveJob.status
              })
          : t('Start a training job from the trainable dataset version.'),
        requirement: t('One completed training job aligned to the trainable dataset version.'),
        blocked: hasCompletedTraining
          ? undefined
          : !hasTrainableVersion
            ? t('Prepare a trainable dataset version first.')
            : latestActiveJob
              ? t('Training is running. Wait for completion and artifacts.')
              : t('No completed training job yet. Launch a training job now.'),
        done: hasCompletedTraining,
        primary: hasTrainableVersion
          ? {
              label: t('Smart Launch'),
              to: trainingCreatePath
            }
          : {
              label: t('Prepare trainable version first'),
              to: datasetDetailPath
            }
      },
      {
        key: 'register',
        title: t('Register a model version'),
        detail: hasRegisteredVersion
          ? t('Model version {version} registered. evidence={mode}, gate={gate}', {
              version: latestRegisteredVersion?.id ?? '-',
              mode: registrationEvidenceLabel,
              gate: registrationGateLabel
            })
          : t('Bind your completed training job into a new model version.'),
        requirement: t('A registered model version linked to the completed training job.'),
        blocked: hasRegisteredVersion
          ? undefined
          : !hasCompletedTraining
            ? t('Complete training before registration.')
            : t('No registered version yet. Register the completed job output.'),
        done: hasRegisteredVersion,
        primary: hasCompletedTraining
          ? {
              label: t('Open version registration'),
              to: registerVersionPath
            }
          : {
              label: t('Complete training first'),
              to: trainingJobsPath
            }
      },
      {
        key: 'validate',
        title: t('Validate inference and route feedback'),
        detail: hasFeedbackLoop
          ? t('Closed loop confirmed. run={run}, feedback_dataset={dataset}', {
              run: latestFeedbackRun?.id ?? '-',
              dataset: latestFeedbackRun?.feedback_dataset_id ?? '-'
            })
          : latestRun
            ? t('Inference run exists ({run}). Route it back to a dataset to finish the loop.', {
                run: latestRun.id
              })
            : t('Run inference with the registered version, then send feedback back to dataset.'),
        requirement: t('At least one inference run and one feedback dataset handoff.'),
        blocked: hasFeedbackLoop
          ? undefined
          : !hasRegisteredVersion
            ? t('Register a model version first.')
            : !latestRun
              ? t('Run at least one inference with the registered version.')
              : t('Inference exists, but feedback has not been routed to a dataset yet.'),
        done: hasFeedbackLoop,
        primary: hasRegisteredVersion
          ? {
              label: t('Open inference validation'),
              to: inferencePath
            }
          : {
              label: t('Register a version first'),
              to: registerVersionPath
            }
      },
      {
        key: 'authorize_device',
        title: t('Authorize device API access'),
        detail: hasDeviceAuthorization
          ? t('Device credentials ready: {count}. Hardware can call runtime public APIs directly.', {
              count: String(deviceAccessRecords.length)
            })
          : t('Issue at least one device credential so robots/edge clients can consume this model.'),
        requirement: t('At least one active device API credential bound to the registered model version.'),
        blocked: hasDeviceAuthorization
          ? undefined
          : !hasRegisteredVersion
            ? t('Register a model version first.')
            : !hasFeedbackLoop
              ? t('Finish inference + feedback loop before granting external device access.')
              : t('No device API credential yet. Issue one in the section below.'),
        done: hasRegisteredVersion && hasFeedbackLoop && hasDeviceAuthorization,
        primary: hasRegisteredVersion
          ? {
              label: t('Continue in version delivery lane'),
              to: versionDeliveryPath
            }
          : {
              label: t('Register a version first'),
              to: registerVersionPath
            },
        secondary: hasRegisteredVersion
          ? {
              label: t('Open device authorization'),
              onClick: scrollToDeviceAccess
            }
          : undefined
      }
    ];
  }, [
    annotationPath,
    deviceAccessRecords.length,
    datasetDetailPath,
    inferencePath,
    latestCompletedJob,
    latestActiveJob,
    latestFeedbackRun,
    latestRegisteredVersion,
    latestRun,
    latestTrainableVersion,
    latestVersion,
    hasRemoteOpsProof,
    datasetAttachments,
    readyAttachments.length,
    registrationEvidenceLabel,
    registrationGateLabel,
    registerVersionPath,
    versionDeliveryPath,
    scrollToDeviceAccess,
    scrollToUploader,
    selectedDataset,
    preferredLaunchWorker,
    t,
    trainingCreatePath,
    trainingJobsPath
  ]);

  const completedStepCount = useMemo(
    () => steps.filter((step) => step.done).length,
    [steps]
  );
  const progressPercent = useMemo(
    () => (steps.length > 0 ? Math.round((completedStepCount / steps.length) * 100) : 0),
    [completedStepCount, steps.length]
  );
  const stepperCurrent = useMemo(() => {
    if (steps.length === 0) {
      return 0;
    }
    const firstPendingIndex = steps.findIndex((step) => !step.done);
    if (firstPendingIndex >= 0) {
      return firstPendingIndex;
    }
    return steps.length - 1;
  }, [steps]);
  const stepTitles = useMemo(
    () => steps.map((step) => step.title),
    [steps]
  );

  const nextIncompleteIndex = steps.findIndex((step) => !step.done);
  const nextStep = nextIncompleteIndex >= 0 ? steps[nextIncompleteIndex] : null;
  const nextAction = useMemo<NextAction | null>(() => {
    if (!nextStep?.primary) {
      return null;
    }
    if (nextStep.primary.to) {
      return { label: nextStep.primary.label, kind: 'route', to: nextStep.primary.to };
    }
    if (nextStep.primary.onClick) {
      return { label: nextStep.primary.label, kind: 'scroll' };
    }
    return null;
  }, [nextStep]);

  const handlePrimaryAction = useCallback(() => {
    if (!nextStep?.primary) {
      return;
    }
    if (nextAction?.kind === 'route' && nextAction.to) {
      navigate(nextAction.to);
      return;
    }
    nextStep.primary.onClick?.();
  }, [navigate, nextAction, nextStep]);

  const handleDatasetSwitch = useCallback(
    async (nextDatasetId: string) => {
      setSelectedDatasetId(nextDatasetId);
      await loadAll('manual', nextDatasetId);
    },
    [loadAll]
  );

  useEffect(() => {
    const queryDatasetId = (searchParams.get('dataset') ?? '').trim();
    if (!queryDatasetId || queryDatasetId === selectedDatasetIdRef.current) {
      return;
    }
    if (!datasets.some((dataset) => dataset.id === queryDatasetId)) {
      return;
    }
    void handleDatasetSwitch(queryDatasetId);
  }, [datasets, handleDatasetSwitch, searchParams]);

  const createDataset = async () => {
    const trimmedName = newDatasetName.trim();
    if (!trimmedName) {
      setFeedback({ tone: 'danger', text: t('Dataset name is required.') });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const created = await api.createDataset({
        name: trimmedName,
        description: t('Created from training closure wizard.'),
        task_type: newDatasetTaskType,
        label_schema: {
          classes: labelSchemaByTaskType[newDatasetTaskType]
        }
      });
      setNewDatasetName('');
      setSelectedDatasetId(created.id);
      setFeedback({
        tone: 'success',
        text: t('Dataset {datasetId} created. You can upload images now.', { datasetId: created.id })
      });
      await loadAll('manual', created.id);
      scrollToUploader();
    } catch (error) {
      setFeedback({ tone: 'danger', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const uploadDatasetAttachment = async (filename: string) => {
    if (!selectedDatasetId) {
      throw new Error(t('Select a dataset first.'));
    }
    await api.uploadDatasetAttachment(selectedDatasetId, filename);
    await loadAll('manual', selectedDatasetId);
  };

  const uploadDatasetFiles = async (files: File[]) => {
    if (!selectedDatasetId) {
      throw new Error(t('Select a dataset first.'));
    }
    for (const file of files) {
      await api.uploadDatasetFile(selectedDatasetId, file);
    }
    await loadAll('manual', selectedDatasetId);
  };

  const deleteDatasetAttachment = async (attachmentId: string) => {
    await api.removeAttachment(attachmentId);
    setDatasetAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
    loadAll('background', selectedDatasetId).catch(() => {
      setFeedback({ tone: 'success', text: backgroundSyncHint });
    });
  };

  const issueDeviceAccess = async () => {
    if (!latestRegisteredVersion) {
      setFeedback({ tone: 'danger', text: t('Register a model version before issuing device access.') });
      return;
    }
    if (!latestFeedbackRun) {
      setFeedback({ tone: 'danger', text: t('Finish inference + feedback loop before issuing device access.') });
      return;
    }

    const deviceName = newDeviceName.trim();
    if (!deviceName) {
      setFeedback({ tone: 'danger', text: t('Device name is required.') });
      return;
    }

    let maxCalls: number | null = null;
    if (newDeviceMaxCalls.trim()) {
      const parsed = Number.parseInt(newDeviceMaxCalls.trim(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setFeedback({ tone: 'danger', text: t('max_calls must be a positive integer.') });
        return;
      }
      maxCalls = parsed;
    }

    let expiresAt: string | null = null;
    if (newDeviceExpireDays.trim()) {
      const days = Number.parseInt(newDeviceExpireDays.trim(), 10);
      if (!Number.isFinite(days) || days <= 0) {
        setFeedback({ tone: 'danger', text: t('Expire days must be a positive integer.') });
        return;
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    setBusy(true);
    setFeedback(null);
    try {
      const issued = await api.issueRuntimeDeviceAccess({
        model_version_id: latestRegisteredVersion.id,
        device_name: deviceName,
        max_calls: maxCalls,
        expires_at: expiresAt
      });
      setLatestIssuedDeviceAccess(issued);
      setNewDeviceName('');
      await loadDeviceSurface(latestRegisteredVersion.id);
      setFeedback({
        tone: 'success',
        text: t('Device access key issued for {device}. Keep this key in your device secret manager.', {
          device: issued.record.device_name
        })
      });
    } catch (error) {
      setFeedback({ tone: 'danger', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const rotateDeviceAccess = async (bindingKey: string) => {
    if (!latestRegisteredVersion) {
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const rotated = await api.rotateRuntimeDeviceAccess({
        model_version_id: latestRegisteredVersion.id,
        binding_key: bindingKey
      });
      setLatestIssuedDeviceAccess(rotated);
      await loadDeviceSurface(latestRegisteredVersion.id);
      setFeedback({
        tone: 'success',
        text: t('Device key rotated for {device}. Distribute the new key to the device now.', {
          device: rotated.record.device_name
        })
      });
    } catch (error) {
      setFeedback({ tone: 'danger', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const revokeDeviceAccess = async (bindingKey: string) => {
    if (!latestRegisteredVersion) {
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const nextRecords = await api.revokeRuntimeDeviceAccess({
        model_version_id: latestRegisteredVersion.id,
        binding_key: bindingKey
      });
      setDeviceAccessRecords(
        [...nextRecords].sort(
          (left, right) => toTime(right.last_used_at ?? right.issued_at) - toTime(left.last_used_at ?? left.issued_at)
        )
      );
      await loadDeviceSurface(latestRegisteredVersion.id, { silent: true });
      setFeedback({
        tone: 'success',
        text: t('Device access revoked.')
      });
    } catch (error) {
      setFeedback({ tone: 'danger', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <WorkspacePage>
        <PageHeader
          eyebrow={t('Guided Loop')}
          title={t('Training Closure Wizard')}
          description={t('Bring images, then follow one clear next step until you get a model.')}
        />
        <StateBlock
          variant="loading"
          title={t('Loading workspace')}
          description={t('Collecting datasets, jobs, versions, and inference runs.')}
        />
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Guided Loop')}
        title={t('Training Closure Wizard')}
        description={t('One page to move from raw images to a validated model version.')}
        meta={
          <div className="row gap wrap">
            <Badge tone="neutral">{t('Datasets')}: {datasets.length}</Badge>
            <Badge tone="neutral">{t('Versions')}: {datasetVersions.length}</Badge>
            <Badge tone="neutral">{t('Training Jobs')}: {trainingJobs.length}</Badge>
            <Badge tone="neutral">{t('Inference run')}: {inferenceRuns.length}</Badge>
          </div>
        }
        primaryAction={
          nextAction
            ? {
                label: nextAction.label,
                onClick: handlePrimaryAction,
                disabled: busy || refreshing
              }
            : {
                label: t('Refresh'),
                onClick: () => {
                  void loadAll('manual');
                },
                disabled: busy || refreshing
              }
        }
        secondaryActions={
          <div className="row gap wrap">
            {requestedReturnTo ? (
              <ButtonLink to={requestedReturnTo} variant="secondary" size="sm">
                {t('Return to current task')}
              </ButtonLink>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void loadAll('manual');
              }}
              disabled={busy || refreshing}
            >
              {refreshing ? t('Refreshing...') : t('Refresh')}
            </Button>
          </div>
        }
      />

      {feedback ? (
        <InlineAlert
          tone={feedback.tone}
          title={feedback.tone === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}
      {requestedDatasetMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested dataset context not found')}
          description={t('The dataset from the incoming link is unavailable. The page now uses the latest available dataset context.')}
          actions={
            <ButtonLink to={clearRequestedDatasetPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}

      <WorkspaceWorkbench
        toolbar={
          <Card as="section" className="workspace-toolbar-card">
            <WorkspaceSectionHeader
              title={t('Dataset context')}
              description={t('Pick one dataset as your loop context, then every next action stays aligned.')}
              actions={
                selectedDatasetId ? (
                  <ButtonLink to={datasetDetailPath} variant="ghost" size="sm">
                    {t('Open dataset detail')}
                  </ButtonLink>
                ) : null
              }
            />
            <div className="workspace-filter-grid">
              <label className="stack tight">
                <small className="muted">{t('Current dataset')}</small>
                <Select
                  value={selectedDatasetId}
                  onChange={(event) => {
                    void handleDatasetSwitch(event.target.value);
                  }}
                >
                  {datasets.length === 0 ? (
                    <option value="">{t('No Datasets Yet')}</option>
                  ) : (
                    datasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name} ({dataset.task_type}) · {dataset.id}
                      </option>
                    ))
                  )}
                </Select>
              </label>
            </div>
            <Panel tone="soft" className="stack tight">
              <strong>{t('Create a fresh dataset')}</strong>
              <small className="muted">
                {t('Engineers can start here with only images and skip manual navigation between pages.')}
              </small>
              <div className="workspace-filter-grid">
                <label className="stack tight">
                  <small className="muted">{t('Name')}</small>
                  <Input
                    value={newDatasetName}
                    onChange={(event) => setNewDatasetName(event.target.value)}
                    placeholder={t('For example: Invoice OCR Batch A')}
                    disabled={busy}
                  />
                </label>
                <label className="stack tight">
                  <small className="muted">{t('Task Type')}</small>
                  <Select
                    value={newDatasetTaskType}
                    onChange={(event) => setNewDatasetTaskType(event.target.value as TaskType)}
                    disabled={busy}
                  >
                    {taskTypeOptions.map((taskType) => (
                      <option key={taskType} value={taskType}>
                        {taskType}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <div className="row gap wrap">
                <Button type="button" onClick={() => void createDataset()} disabled={busy}>
                  {busy ? t('Working...') : t('Create dataset and continue')}
                </Button>
              </div>
            </Panel>
          </Card>
        }
        main={
          <div className="stack">
            <Card as="section">
              <WorkspaceSectionHeader
                title={t('Workflow progress')}
                description={t('Complete each step in order so engineers can move from images to model without detours.')}
              />
              <ProgressStepper
                steps={stepTitles}
                current={stepperCurrent}
                title={t('Progress {done}/{total} ({percent}%)', {
                  done: completedStepCount,
                  total: steps.length,
                  percent: progressPercent
                })}
                caption={
                  hasTransientState
                    ? t('Auto-refreshing while uploads or training are still running.')
                    : t('Status refreshes on demand and after each action.')
                }
              />
              <div className="row gap wrap">
                <Badge tone={completedStepCount === steps.length ? 'success' : 'warning'}>
                  {completedStepCount === steps.length
                    ? t('Closure flow completed')
                    : t('Next unlock depends on the current step requirement')}
                </Badge>
                {latestRegisteredVersion ? (
                <Badge tone={standardGateReady ? 'success' : 'warning'}>
                  {standardGateReady
                    ? t('Registration meets standard gate')
                    : t('Registration still requires gate review')}
                </Badge>
                ) : null}
              </div>
            </Card>

            <WorkspaceNextStepCard
              title={t('Single next step')}
              description={t('Always execute this first to avoid page-hopping confusion.')}
              stepLabel={nextStep ? nextStep.title : t('Loop completed')}
              stepDetail={
                nextStep
                  ? nextStep.detail
                  : t('You already have images, trainable data, model version, and feedback loop evidence.')
              }
              current={nextIncompleteIndex >= 0 ? nextIncompleteIndex + 1 : steps.length}
              total={steps.length}
              badgeTone={nextStep ? 'warning' : 'success'}
              badgeLabel={nextStep ? t('Recommended next step') : t('Completed')}
              actions={
                nextStep?.primary ? (
                  <div className="row gap wrap">
                    {nextStep.primary.to ? (
                      <ButtonLink to={nextStep.primary.to} size="sm">
                        {nextStep.primary.label}
                      </ButtonLink>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        onClick={nextStep.primary.onClick}
                        disabled={nextStep.primary.disabled}
                      >
                        {nextStep.primary.label}
                      </Button>
                    )}
                    {nextStep.secondary ? (
                      nextStep.secondary.to ? (
                        <ButtonLink to={nextStep.secondary.to} variant="ghost" size="sm">
                          {nextStep.secondary.label}
                        </ButtonLink>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={nextStep.secondary.onClick}
                          disabled={nextStep.secondary.disabled}
                        >
                          {nextStep.secondary.label}
                        </Button>
                      )
                    ) : null}
                  </div>
                ) : null
              }
            />

            <Card as="section">
              <WorkspaceSectionHeader
                title={t('Closure checklist')}
                description={t('Every step maps to a concrete object so engineers can trace handoff clearly.')}
              />
              <ul className="workspace-record-list">
                {steps.map((step, index) => {
                  const isActive = !step.done && index === nextIncompleteIndex;
                  return (
                    <Panel
                      key={step.key}
                      as="li"
                      tone={step.done ? 'accent' : isActive ? 'soft' : 'default'}
                      className="workspace-record-item stack"
                    >
                      <div className="workspace-record-item-top">
                        <div className="workspace-record-summary stack tight">
                          <strong>
                            {index + 1}. {step.title}
                          </strong>
                          <small className="muted">{step.detail}</small>
                          <small className="muted">
                            {t('Done when: {condition}', { condition: step.requirement })}
                          </small>
                          {!step.done && step.blocked ? (
                            <small className="muted">
                              {t('Blocked by: {reason}', { reason: step.blocked })}
                            </small>
                          ) : null}
                        </div>
                        <Badge tone={step.done ? 'success' : isActive ? 'warning' : 'neutral'}>
                          {step.done ? t('Completed') : isActive ? t('Now') : t('Pending')}
                        </Badge>
                      </div>
                      {step.primary || step.secondary ? (
                        <div className="row gap wrap">
                          {step.primary ? (
                            step.primary.to ? (
                              <ButtonLink to={step.primary.to} variant="secondary" size="sm">
                                {step.primary.label}
                              </ButtonLink>
                            ) : (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={step.primary.onClick}
                                disabled={step.primary.disabled}
                              >
                                {step.primary.label}
                              </Button>
                            )
                          ) : null}
                          {step.secondary ? (
                            step.secondary.to ? (
                              <ButtonLink to={step.secondary.to} variant="ghost" size="sm">
                                {step.secondary.label}
                              </ButtonLink>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={step.secondary.onClick}
                                disabled={step.secondary.disabled}
                              >
                                {step.secondary.label}
                              </Button>
                            )
                          ) : null}
                        </div>
                      ) : null}
                    </Panel>
                  );
                })}
              </ul>
            </Card>

            <div ref={deviceAccessAnchorRef}>
              <Card as="section">
                <WorkspaceSectionHeader
                  title={t('Device API authorization')}
                  description={t('Issue scoped credentials so robots/edge clients can call runtime inference and pull model packages.')}
                  actions={
                    latestRegisteredVersion ? (
                      <div className="row gap wrap">
                        <ButtonLink to={versionDeliveryPath} variant="secondary" size="sm">
                          {t('Continue in version delivery lane')}
                        </ButtonLink>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void loadDeviceSurface(latestRegisteredVersion.id);
                          }}
                          disabled={busy || refreshing}
                        >
                          {t('Refresh credentials')}
                        </Button>
                      </div>
                    ) : null
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
                        'Keep this page for quick closure checks, but continue in Model Versions when you need version-scoped device/API delivery, public inference proof, encrypted package delivery, and audit follow-up.'
                      )}
                      actions={
                        <ButtonLink to={versionDeliveryPath} variant="secondary" size="sm">
                          {t('Continue in version delivery lane')}
                        </ButtonLink>
                      }
                    />
                    <div className="row gap wrap">
                      <Badge tone="neutral">
                        {t('Model Version')}: {latestRegisteredVersion.id}
                      </Badge>
                      <Badge tone="neutral">
                        {t('Framework')}: {latestRegisteredVersion.framework}
                      </Badge>
                      <Badge tone={deviceAccessRecords.length > 0 ? 'success' : 'warning'}>
                        {t('Credentials')}: {deviceAccessRecords.length}
                      </Badge>
                      <Badge tone={hasRemoteOpsProof ? 'success' : 'warning'}>
                        {hasRemoteOpsProof ? t('Remote ops ready') : t('Collecting evidence')}
                      </Badge>
                    </div>
                    <div className="row gap wrap">
                      <label className="stack tight">
                        <small className="muted">{t('Device name')}</small>
                        <Input
                          value={newDeviceName}
                          onChange={(event) => setNewDeviceName(event.target.value)}
                          placeholder={t('e.g. robot-dog-unit-01')}
                        />
                      </label>
                      <label className="stack tight">
                        <small className="muted">{t('Expire days (optional)')}</small>
                        <Input
                          value={newDeviceExpireDays}
                          onChange={(event) => setNewDeviceExpireDays(event.target.value)}
                          placeholder={t('e.g. 30')}
                        />
                      </label>
                      <label className="stack tight">
                        <small className="muted">{t('Max calls (optional)')}</small>
                        <Input
                          value={newDeviceMaxCalls}
                          onChange={(event) => setNewDeviceMaxCalls(event.target.value)}
                          placeholder={t('e.g. 5000')}
                        />
                      </label>
                    </div>
                    <div className="row gap wrap">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          void issueDeviceAccess();
                        }}
                        disabled={busy || refreshing}
                      >
                        {t('Issue device credential')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!latestRegisteredVersion) {
                            return;
                          }
                          void loadDeviceSurface(latestRegisteredVersion.id);
                        }}
                        disabled={busy || refreshing || !latestRegisteredVersion}
                      >
                        {deviceLifecycleLoading ? t('Refreshing...') : t('Refresh activity')}
                      </Button>
                    </div>

                    {deviceAccessRecords.length > 0 ? (
                      <ul className="workspace-record-list compact">
                        {deviceAccessRecords.map((record) => (
                          <Panel key={record.binding_key} as="li" className="workspace-record-item compact stack">
                            <div className="workspace-record-item-top">
                              <div className="workspace-record-summary stack tight">
                                <strong>{record.device_name}</strong>
                                <small className="muted">{record.binding_key}</small>
                                <small className="muted">
                                  {t('key')}: {record.api_key_masked}
                                </small>
                                <small className="muted">
                                  {t('issued at')}: {formatTime(record.issued_at)} · {t('remaining calls')}:{' '}
                                  {record.remaining_calls ?? 'unlimited'}
                                </small>
                                <small className="muted">
                                  {t('last used')}: {formatTime(record.last_used_at)}
                                </small>
                              </div>
                              <Badge tone={record.is_expired ? 'danger' : 'success'}>
                                {record.is_expired ? t('expired') : t('active')}
                              </Badge>
                            </div>
                            <div className="row gap wrap">
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={busy || refreshing}
                                onClick={() => {
                                  void rotateDeviceAccess(record.binding_key);
                                }}
                              >
                                {t('Rotate key')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={busy || refreshing}
                                onClick={() => {
                                  void revokeDeviceAccess(record.binding_key);
                                }}
                              >
                                {t('Revoke')}
                              </Button>
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

                    <Panel tone="soft" className="stack">
                      <div className="row gap wrap align-center">
                        <strong>{t('Device delivery lifecycle')}</strong>
                        <ButtonLink to={inferencePath} variant="ghost" size="sm">
                          {t('Open Validation')}
                        </ButtonLink>
                        <ButtonLink to={workspaceConsolePath} variant="ghost" size="sm">
                          {t('Open Console')}
                        </ButtonLink>
                      </div>
                      <small className="muted">
                        {t(
                          'Check whether the issued credential has already been used for public inference and encrypted package delivery.'
                        )}
                      </small>
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
                            <ButtonLink to={versionDeliveryPath} variant="secondary" size="sm">
                              {t('Open remote ops summary')}
                            </ButtonLink>
                            {canReviewAudit ? (
                              <ButtonLink to={adminAuditPath} variant="ghost" size="sm">
                                {t('Open audit logs')}
                              </ButtonLink>
                            ) : null}
                          </div>
                        }
                      />
                      {deviceLifecycleLoading ? (
                        <small className="muted">{t('Loading device lifecycle...')}</small>
                      ) : deviceLifecycleError ? (
                        <InlineAlert tone="danger" title={t('Load Failed')} description={deviceLifecycleError} />
                      ) : (
                        <>
                          <div className="row gap wrap">
                            <Badge tone={deviceAccessRecords.length > 0 ? 'success' : 'warning'}>
                              {t('Credentials')}: {deviceAccessRecords.length}
                            </Badge>
                            <Badge
                              tone={
                                (deviceLifecycle?.public_inference_invocations.length ?? 0) > 0
                                  ? 'success'
                                  : 'warning'
                              }
                            >
                              {t('Public inference')}: {deviceLifecycle?.public_inference_invocations.length ?? 0}
                            </Badge>
                            <Badge
                              tone={
                                (deviceLifecycle?.model_package_deliveries.length ?? 0) > 0
                                  ? 'success'
                                  : 'warning'
                              }
                            >
                              {t('Package deliveries')}: {deviceLifecycle?.model_package_deliveries.length ?? 0}
                            </Badge>
                          </div>
                          <small className="muted">
                            {latestPublicInferenceInvocation
                              ? `${t('Latest public inference')}: ${latestPublicInferenceInvocation.request_id} · ${latestPublicInferenceInvocation.runtime_auth_binding_key} · ${formatTime(latestPublicInferenceInvocation.created_at)}`
                              : deviceAccessRecords.length > 0
                                ? t('No device has invoked public inference yet. Copy the inference curl above and verify once from the target device.')
                                : t('Issue a device credential first, then this lifecycle view will start to populate.')}
                          </small>
                          <small className="muted">
                            {latestModelPackageDelivery
                              ? `${t('Latest package delivery')}: ${latestModelPackageDelivery.delivery_id} · ${latestModelPackageDelivery.source_filename} · ${formatTime(latestModelPackageDelivery.generated_at)}`
                              : deviceAccessRecords.length > 0
                                ? t('No encrypted model package has been delivered yet. Copy the model package curl above when the device is ready to pull.')
                                : t('After issuing a credential, model package deliveries will be listed here.')}
                          </small>
                          {deviceLifecycleTimeline.length > 0 ? (
                            <ul className="workspace-record-list compact">
                              {deviceLifecycleTimeline.map((event) => (
                                <Panel key={event.id} as="li" className="workspace-record-item compact stack">
                                  <div className="workspace-record-item-top">
                                    <div className="workspace-record-summary stack tight">
                                      <strong>{event.title}</strong>
                                      <small className="muted">{event.subtitle}</small>
                                      <small className="muted">{event.detail}</small>
                                      <small className="muted">
                                        {t('Timestamp')}: {formatTime(event.timestamp)}
                                      </small>
                                    </div>
                                    <Badge
                                      tone={
                                        event.badgeTone as 'neutral' | 'info' | 'success' | 'warning' | 'danger'
                                      }
                                    >
                                      {event.badgeLabel}
                                    </Badge>
                                  </div>
                                </Panel>
                              ))}
                            </ul>
                          ) : null}
                        </>
                      )}
                    </Panel>
                  </div>
                )}
              </Card>
            </div>

            <div ref={uploaderAnchorRef}>
              <AttachmentUploader
                title={t('Image uploads for current dataset')}
                items={datasetAttachments}
                onUpload={uploadDatasetAttachment}
                onUploadFiles={uploadDatasetFiles}
                onDelete={deleteDatasetAttachment}
                contentUrlBuilder={api.attachmentContentUrl}
                disabled={!selectedDatasetId || busy || refreshing}
                emptyDescription={t('Upload images here. Once ready, continue with annotation.')}
                uploadButtonLabel={t('Upload')}
                headerActions={
                  selectedDataset ? (
                    <Badge tone="info">
                      {selectedDataset.name} · {selectedDataset.id}
                    </Badge>
                  ) : (
                    <Badge tone="warning">{t('Select or create dataset first')}</Badge>
                  )
                }
              />
            </div>
          </div>
        }
        side={
          <div className="stack">
            <Card as="section">
              <WorkspaceSectionHeader
                title={t('Loop objects')}
                description={t('Track exactly what has been produced in this loop.')}
                actions={
                  <div className="row gap wrap">
                    {latestCompletedJob ? (
                      <ButtonLink to={registerVersionPath} variant="ghost" size="sm">
                        {t('Open version registration')}
                      </ButtonLink>
                    ) : null}
                    {latestRun ? (
                      <ButtonLink to={latestRunPath} variant="ghost" size="sm">
                        {t('Open latest run')}
                      </ButtonLink>
                    ) : null}
                    {latestFeedbackRun?.feedback_dataset_id ? (
                      <ButtonLink to={latestFeedbackDatasetPath} variant="ghost" size="sm">
                        {t('Open feedback dataset')}
                      </ButtonLink>
                    ) : null}
                  </div>
                }
              />
              <ul className="workspace-record-list compact">
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Dataset')}</strong>
                  <small className="muted">{selectedDataset?.id ?? '-'}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Dataset Version')}</strong>
                  <small className="muted">{latestTrainableVersion?.id ?? latestVersion?.id ?? '-'}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Training Job')}</strong>
                  <small className="muted">{latestCompletedJob?.id ?? '-'}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Model Version')}</strong>
                  <small className="muted">{latestRegisteredVersion?.id ?? '-'}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Inference run')}</strong>
                  <small className="muted">{latestRun?.id ?? '-'}</small>
                </Panel>
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Feedback dataset')}</strong>
                  <small className="muted">{latestFeedbackRun?.feedback_dataset_id ?? '-'}</small>
                </Panel>
              </ul>
            </Card>

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
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Last updated')}</strong>
                  <small className="muted">
                    {formatTime(
                      latestFeedbackRun?.updated_at ??
                        latestRun?.updated_at ??
                        latestRegisteredVersion?.created_at ??
                        latestCompletedJob?.updated_at ??
                        latestTrainableVersion?.created_at
                    )}
                  </small>
                </Panel>
              </ul>
            </Card>

            <Card as="section">
              <WorkspaceSectionHeader
                title={t('Runtime & worker handoff')}
                description={t('Check runtime readiness and worker inventory before dispatching jobs or exposing APIs.')}
              />
              <ul className="workspace-record-list compact">
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Runtime readiness')}</strong>
                  <div className="row gap wrap">
                    <Badge tone={runtimeReadinessTone}>
                      {runtimeReadiness ? t(runtimeReadiness.status) : runtimeReadinessError ? t('not available') : t('unknown')}
                    </Badge>
                    <small className="muted">
                      {t('Last checked')}: {formatTime(runtimeReadiness?.checked_at)}
                    </small>
                  </div>
                  {runtimeReadinessError ? <small className="muted">{runtimeReadinessError}</small> : null}
                </Panel>
                <Panel as="li" className="workspace-record-item compact stack tight" tone="soft">
                  <strong>{t('Workers')}</strong>
                  {workersAccessDenied ? (
                    <small className="muted">{t('Worker inventory is restricted to admins.')}</small>
                  ) : workersError ? (
                    <small className="muted">{workersError}</small>
                  ) : (
                    <div className="row gap wrap">
                      <Badge tone={workers.length > 0 ? 'info' : 'warning'}>
                        {t('Workers')}: {workers.length}
                      </Badge>
                      <Badge tone={workerOnlineCount > 0 ? 'success' : 'warning'}>
                        {t('Online')}: {workerOnlineCount}
                      </Badge>
                      <Badge tone={workerDrainingCount > 0 ? 'warning' : 'neutral'}>
                        {t('Draining')}: {workerDrainingCount}
                      </Badge>
                    </div>
                  )}
                </Panel>
              </ul>
              <div className="row gap wrap">
                <ButtonLink to={runtimeSettingsPath} variant="ghost" size="sm">
                  {t('Open Runtime Settings')}
                </ButtonLink>
                <ButtonLink to={workerSettingsPath} variant="ghost" size="sm">
                  {t('Worker Settings')}
                </ButtonLink>
                <ButtonLink to={runtimeTemplatesPath} variant="ghost" size="sm">
                  {t('Runtime Templates')}
                </ButtonLink>
              </div>
            </Card>

            <Card as="section">
              <WorkspaceSectionHeader
                title={t('Quick routes')}
                description={t('If you must jump, use these scoped links so context is preserved.')}
              />
              <div className="row gap wrap">
                <ButtonLink to={datasetDetailPath} variant="ghost" size="sm">
                  {t('Dataset')}
                </ButtonLink>
                <ButtonLink to={trainingCreatePath} variant="ghost" size="sm">
                  {t('Training')}
                </ButtonLink>
                <ButtonLink to={registerVersionPath} variant="ghost" size="sm">
                  {t('Model Versions')}
                </ButtonLink>
                <ButtonLink to={inferencePath} variant="ghost" size="sm">
                  {t('Inference Validation')}
                </ButtonLink>
              </div>
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
