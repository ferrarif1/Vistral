import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  DatasetRecord,
  DatasetVersionRecord,
  RequirementTaskDraft,
  TrainingJobRecord,
  TrainingWorkerNodeView,
  VisionModelingTaskRecord
} from '../../shared/domain';
import {
  UPLOAD_SOFT_LIMIT_LABEL,
  findOversizedUpload,
  formatByteSize
} from '../../shared/uploadLimits';
import AdvancedSection from '../components/AdvancedSection';
import TrainingLaunchContextPills from '../components/onboarding/TrainingLaunchContextPills';
import StateBlock from '../components/StateBlock';
import { Badge, StatusTag } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { InlineAlert, PageHeader } from '../components/ui/ConsolePage';
import { HiddenFileInput, Input, Select, Textarea } from '../components/ui/Field';
import ProgressStepper from '../components/ui/ProgressStepper';
import { Card, Panel } from '../components/ui/Surface';
import {
  WorkspacePage,
  WorkspaceSectionHeader,
  WorkspaceWorkbench
} from '../components/ui/WorkspacePage';
import { useI18n } from '../i18n/I18nProvider';
import { api } from '../services/api';

const taskTypeOptions = ['ocr', 'detection', 'classification', 'segmentation', 'obb'] as const;
const adminAccessMessagePattern = /(forbidden|permission|unauthorized|not allowed|admin|管理员|权限)/i;

type TrainingTaskType = (typeof taskTypeOptions)[number];
type TrainingFramework = 'paddleocr' | 'doctr' | 'yolo';
const trainingFrameworkOptions: TrainingFramework[] = ['paddleocr', 'doctr', 'yolo'];
const frameworkBaseModelCatalog: Record<TrainingFramework, string[]> = {
  paddleocr: ['paddleocr-PP-OCRv4', 'paddleocr-PP-OCRv3'],
  doctr: ['doctr-crnn-vitstr-base', 'doctr-vitstr-small'],
  yolo: ['yolo11n', 'yolo11s', 'yolo11m']
};
const taskBaseModelOverrides: Partial<Record<TrainingTaskType, Partial<Record<TrainingFramework, string[]>>>> = {
  ocr: {
    paddleocr: ['paddleocr-PP-OCRv4', 'paddleocr-PP-OCRv3'],
    doctr: ['doctr-crnn-vitstr-base', 'doctr-vitstr-small']
  },
  detection: {
    yolo: ['yolo11n', 'yolo11s', 'yolo11m']
  },
  classification: {
    yolo: ['yolo11n-cls', 'yolo11s-cls']
  },
  segmentation: {
    yolo: ['yolo11n-seg', 'yolo11s-seg']
  },
  obb: {
    yolo: ['yolo11n-obb', 'yolo11s-obb']
  }
};
const recommendedTrainingConfigCatalog: Record<
  TrainingFramework,
  Partial<
    Record<
      TrainingTaskType,
      { epochs: string; batchSize: string; learningRate: string; warmupRatio: string; weightDecay: string }
    >
  >
> = {
  paddleocr: {
    ocr: { epochs: '24', batchSize: '32', learningRate: '0.001', warmupRatio: '0.1', weightDecay: '0.0001' }
  },
  doctr: {
    ocr: { epochs: '28', batchSize: '24', learningRate: '0.0008', warmupRatio: '0.1', weightDecay: '0.0001' }
  },
  yolo: {
    detection: { epochs: '30', batchSize: '16', learningRate: '0.001', warmupRatio: '0.1', weightDecay: '0.0005' },
    obb: { epochs: '36', batchSize: '16', learningRate: '0.0008', warmupRatio: '0.1', weightDecay: '0.0005' },
    segmentation: { epochs: '36', batchSize: '12', learningRate: '0.0008', warmupRatio: '0.1', weightDecay: '0.0005' },
    classification: { epochs: '20', batchSize: '32', learningRate: '0.001', warmupRatio: '0.05', weightDecay: '0.0001' }
  }
};
const defaultLabelClassesByTask: Record<TrainingTaskType, string[]> = {
  ocr: ['text'],
  detection: ['object'],
  classification: ['class_a', 'class_b'],
  segmentation: ['segment'],
  obb: ['rotated_object']
};
const maxBootstrapSampleEntries = 80;

const buildBootstrapSampleFileKey = (file: Pick<File, 'name' | 'size' | 'lastModified'>): string =>
  `${file.name.trim().toLowerCase()}::${file.size}::${file.lastModified}`;

const dedupeBootstrapSampleFiles = (files: File[]): File[] => {
  const seen = new Set<string>();
  const unique: File[] = [];
  for (const file of files) {
    const key = buildBootstrapSampleFileKey(file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(file);
  }
  return unique;
};
type TrainingLaunchContext = {
  datasetId?: string | null;
  versionId?: string | null;
  taskType?: string | null;
  framework?: string | null;
  executionTarget?: 'auto' | 'control_plane' | 'worker' | null;
  workerId?: string | null;
};
const formatCoveragePercent = (value: number) => `${Math.round(value * 100)}%`;
const parsePositiveInteger = (value: string): number | null => {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseNonNegativeNumber = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parsePositiveNumber = (value: string): number | null => {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const isTrainingReadyDatasetVersion = (version: DatasetVersionRecord): boolean =>
  version.split_summary.train > 0 && version.annotation_coverage > 0;

const selectPreferredLaunchVersion = (
  versions: DatasetVersionRecord[],
  preferredVersionId?: string | null,
  currentVersionId?: string | null
): string => {
  const preferred = preferredVersionId?.trim() ?? '';
  const current = currentVersionId?.trim() ?? '';
  const hasVersion = (id: string) => versions.some((version) => version.id === id);
  const readyVersions = versions.filter(isTrainingReadyDatasetVersion);
  const topReadyId = readyVersions[0]?.id ?? '';
  if (preferred && hasVersion(preferred)) {
    return preferred;
  }
  if (current && hasVersion(current) && isTrainingReadyDatasetVersion(versions.find((item) => item.id === current)!)) {
    return current;
  }
  if (topReadyId) {
    return topReadyId;
  }
  if (current && hasVersion(current)) {
    return current;
  }
  return versions[0]?.id ?? '';
};

const resolveBaseModelOptions = (framework: TrainingFramework, taskType: TrainingTaskType): string[] => {
  const taskSpecific = taskBaseModelOverrides[taskType]?.[framework] ?? [];
  if (taskSpecific.length > 0) {
    return [...taskSpecific];
  }
  return [...frameworkBaseModelCatalog[framework]];
};

const parseBootstrapFilenames = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(/\r?\n|[,，;；]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ).slice(0, 80);

const appendTrainingLaunchContext = (
  searchParams: URLSearchParams,
  context?: TrainingLaunchContext
) => {
  if (context?.datasetId?.trim() && !searchParams.has('dataset')) {
    searchParams.set('dataset', context.datasetId.trim());
  }
  if (context?.versionId?.trim() && !searchParams.has('version')) {
    searchParams.set('version', context.versionId.trim());
  }
  if (context?.taskType?.trim() && !searchParams.has('task_type')) {
    searchParams.set('task_type', context.taskType.trim());
  }
  if (context?.framework?.trim() && !searchParams.has('framework')) {
    searchParams.set('framework', context.framework.trim());
  }
  if (context?.executionTarget && context.executionTarget !== 'auto' && !searchParams.has('execution_target')) {
    searchParams.set('execution_target', context.executionTarget);
  }
  if (context?.workerId?.trim() && !searchParams.has('worker')) {
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

const buildDatasetDetailPath = (
  datasetId: string,
  versionId?: string | null,
  launchContext?: TrainingLaunchContext
): string => {
  const searchParams = new URLSearchParams();
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/datasets/${datasetId}?${query}` : `/datasets/${datasetId}`;
};

const buildClosurePath = (
  datasetId: string,
  versionId?: string | null,
  launchContext?: TrainingLaunchContext
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('dataset', datasetId);
  if (versionId?.trim()) {
    searchParams.set('version', versionId.trim());
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  return `/workflow/closure?${searchParams.toString()}`;
};

const buildDatasetsPath = (launchContext?: TrainingLaunchContext): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, launchContext);
  const query = searchParams.toString();
  return query ? `/datasets?${query}` : '/datasets';
};

const buildRuntimeSettingsPath = (
  focus: 'setup' | 'readiness' | 'advanced' = 'readiness',
  framework?: TrainingFramework | null,
  launchContext?: TrainingLaunchContext,
  returnTo?: string | null
): string => {
  const searchParams = new URLSearchParams();
  searchParams.set('focus', focus);
  if (framework) {
    searchParams.set('framework', framework);
  }
  appendTrainingLaunchContext(searchParams, launchContext);
  appendReturnTo(searchParams, returnTo);
  return `/settings/runtime?${searchParams.toString()}`;
};

const buildWorkerSettingsPath = (options?: {
  focus?: 'inventory' | 'pairing';
  onboarding?: boolean;
  profile?: TrainingFramework | null;
  workerId?: string | null;
  launchContext?: TrainingLaunchContext;
  returnTo?: string | null;
}): string => {
  const searchParams = new URLSearchParams();
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  if (options?.focus) {
    searchParams.set('focus', options.focus);
  }
  if (options?.onboarding) {
    searchParams.set('onboarding', '1');
  }
  if (options?.profile) {
    searchParams.set('profile', options.profile);
  }
  if (options?.workerId?.trim()) {
    searchParams.set('worker', options.workerId.trim());
  }
  appendReturnTo(searchParams, options?.returnTo);
  const query = searchParams.toString();
  return query ? `/settings/workers?${query}` : '/settings/workers';
};

const buildTrainingJobDetailPath = (
  jobId: string,
  options?: {
    datasetId?: string | null;
    versionId?: string | null;
    visionTaskId?: string | null;
    created?: boolean;
    launchContext?: TrainingLaunchContext;
    returnTo?: string | null;
  }
): string => {
  const searchParams = new URLSearchParams();
  if (options?.datasetId?.trim()) {
    searchParams.set('dataset', options.datasetId.trim());
  }
  if (options?.versionId?.trim()) {
    searchParams.set('version', options.versionId.trim());
  }
  if (options?.visionTaskId?.trim()) {
    searchParams.set('vision_task', options.visionTaskId.trim());
  }
  if (options?.created) {
    searchParams.set('created', '1');
  }
  appendTrainingLaunchContext(searchParams, options?.launchContext);
  appendReturnTo(searchParams, options?.returnTo);
  const query = searchParams.toString();
  const encodedJobId = encodeURIComponent(jobId);
  return query ? `/training/jobs/${encodedJobId}?${query}` : `/training/jobs/${encodedJobId}`;
};

const buildVisionTaskDetailPath = (taskId: string): string => `/vision/tasks/${encodeURIComponent(taskId)}`;

export default function CreateTrainingJobPage() {
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
  const preferredTaskType = (searchParams.get('task_type') ?? searchParams.get('model_type') ?? '').trim();
  const preferredTaskTypeNormalized = taskTypeOptions.includes(preferredTaskType as (typeof taskTypeOptions)[number])
    ? (preferredTaskType as (typeof taskTypeOptions)[number])
    : null;
  const preferredFrameworkRaw = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
  const preferredFramework = trainingFrameworkOptions.includes(preferredFrameworkRaw as TrainingFramework)
    ? (preferredFrameworkRaw as TrainingFramework)
    : null;
  const preferredExecutionTargetRaw = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
  const preferredExecutionTarget =
    preferredExecutionTargetRaw === 'control_plane' || preferredExecutionTargetRaw === 'worker'
      ? preferredExecutionTargetRaw
      : 'auto';
  const preferredWorkerId = (searchParams.get('worker') ?? '').trim();
  const preferredSourceJobId = (searchParams.get('source_job') ?? searchParams.get('sourceJob') ?? '').trim();
  const preferredSourceVisionTaskId = (searchParams.get('source_vision_task') ?? searchParams.get('vision_task') ?? '').trim();

  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [datasetVersions, setDatasetVersions] = useState<DatasetVersionRecord[]>([]);
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState<'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'>(() =>
    taskTypeOptions.includes(preferredTaskType as (typeof taskTypeOptions)[number])
      ? (preferredTaskType as (typeof taskTypeOptions)[number])
      : 'ocr'
  );
  const [framework, setFramework] = useState<TrainingFramework>(preferredFramework ?? 'paddleocr');
  const [datasetId, setDatasetId] = useState('');
  const [datasetVersionId, setDatasetVersionId] = useState('');
  const [baseModel, setBaseModel] = useState('');
  const [epochs, setEpochs] = useState('20');
  const [batchSize, setBatchSize] = useState('16');
  const [learningRate, setLearningRate] = useState('0.001');
  const [warmupRatio, setWarmupRatio] = useState('0.1');
  const [weightDecay, setWeightDecay] = useState('0.0001');
  const [requirementDescription, setRequirementDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [taskDraft, setTaskDraft] = useState<RequirementTaskDraft | null>(null);
  const [runtimeSettingsLoading, setRuntimeSettingsLoading] = useState(true);
  const [runtimeSettingsError, setRuntimeSettingsError] = useState('');
  const [runtimeDisableSimulatedTrainFallback, setRuntimeDisableSimulatedTrainFallback] = useState(false);
  const [dispatchPreference, setDispatchPreference] = useState<'auto' | 'control_plane' | 'worker'>(() =>
    preferredWorkerId ? 'worker' : preferredExecutionTarget
  );
  const [selectedWorkerId, setSelectedWorkerId] = useState(preferredWorkerId);
  const [workersLoading, setWorkersLoading] = useState(false);
  const [workers, setWorkers] = useState<TrainingWorkerNodeView[]>([]);
  const [workersAccessDenied, setWorkersAccessDenied] = useState(false);
  const [workersError, setWorkersError] = useState('');
  const [sourceJobPrefillLoading, setSourceJobPrefillLoading] = useState(false);
  const [sourceJobPrefillError, setSourceJobPrefillError] = useState('');
  const [sourceJobPrefillJob, setSourceJobPrefillJob] = useState<TrainingJobRecord | null>(null);
  const [sourceVisionTaskLoading, setSourceVisionTaskLoading] = useState(false);
  const [sourceVisionTaskError, setSourceVisionTaskError] = useState('');
  const [sourceVisionTask, setSourceVisionTask] = useState<VisionModelingTaskRecord | null>(null);
  const [agentTaskPreparing, setAgentTaskPreparing] = useState(false);
  const [nonStrictLaunchConfirmed, setNonStrictLaunchConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preparingSnapshot, setPreparingSnapshot] = useState(false);
  const [creatingDatasetFromSamples, setCreatingDatasetFromSamples] = useState(false);
  const [autoPrepareSnapshot, setAutoPrepareSnapshot] = useState(true);
  const [bootstrapSampleFilenames, setBootstrapSampleFilenames] = useState('');
  const [bootstrapSampleFiles, setBootstrapSampleFiles] = useState<File[]>([]);
  const [bootstrapDropActive, setBootstrapDropActive] = useState(false);
  const [snapshotPreparationNote, setSnapshotPreparationNote] = useState('');
  const [feedback, setFeedback] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [preferredLaunchContextHint, setPreferredLaunchContextHint] = useState('');
  const preferredDatasetId = (searchParams.get('dataset') ?? '').trim();
  const preferredVersionId = (searchParams.get('version') ?? '').trim();
  const preferredDatasetAppliedRef = useRef(false);
  const preferredVersionAppliedRef = useRef(false);
  const preferredDatasetRecoveryAppliedRef = useRef(false);
  const preferredVersionRecoveryAppliedRef = useRef(false);
  const preferredWorkerRecoveryAppliedRef = useRef(false);
  const preferredTaskFrameworkRecoveryAppliedRef = useRef(false);
  const sourceJobPrefillAppliedRef = useRef(false);
  const jobNameInputRef = useRef<HTMLInputElement | null>(null);
  const datasetSelectRef = useRef<HTMLSelectElement | null>(null);
  const datasetVersionSelectRef = useRef<HTMLSelectElement | null>(null);
  const paramsEpochsInputRef = useRef<HTMLInputElement | null>(null);
  const bootstrapSampleFileInputRef = useRef<HTMLInputElement | null>(null);
  const appendPreferredLaunchContextHint = useCallback(
    (reason: string) => {
      setPreferredLaunchContextHint((current) => {
        const nextHint = t('Adjusted launch context to match available training data and runtime options. {reason}', {
          reason
        });
        if (!current) {
          return nextHint;
        }
        if (current.includes(reason)) {
          return current;
        }
        return `${current} ${nextHint}`;
      });
    },
    [t]
  );

  useEffect(() => {
    setPreferredLaunchContextHint('');
    preferredDatasetRecoveryAppliedRef.current = false;
    preferredVersionRecoveryAppliedRef.current = false;
    preferredWorkerRecoveryAppliedRef.current = false;
    preferredTaskFrameworkRecoveryAppliedRef.current = false;
    sourceJobPrefillAppliedRef.current = false;
    setSourceJobPrefillError('');
    setSourceJobPrefillJob(null);
    setSourceVisionTaskError('');
    setSourceVisionTask(null);
  }, [
    preferredDatasetId,
    preferredExecutionTarget,
    preferredFramework,
    preferredSourceJobId,
    preferredSourceVisionTaskId,
    preferredTaskTypeNormalized,
    preferredVersionId,
    preferredWorkerId
  ]);

  useEffect(() => {
    setSnapshotPreparationNote('');
  }, [datasetId, taskType, framework]);

  useEffect(() => {
    setLoading(true);
    api
      .listDatasets()
      .then((result) => {
        setDatasets(result);
        const preferredDataset =
          preferredDatasetId && !preferredDatasetAppliedRef.current
            ? result.find((dataset) => dataset.id === preferredDatasetId) ?? null
            : null;

        if (preferredDataset) {
          preferredDatasetAppliedRef.current = true;
          if (preferredDataset.task_type !== taskType) {
            setTaskType(preferredDataset.task_type);
            if (!preferredDatasetRecoveryAppliedRef.current) {
              preferredDatasetRecoveryAppliedRef.current = true;
              appendPreferredLaunchContextHint(
                t('Switched task type to match the requested dataset.')
              );
            }
          }
          setDatasetId(preferredDataset.id);
          return;
        }

        const first = result.find((dataset) => dataset.task_type === taskType) ?? result[0] ?? null;
        if (preferredDatasetId && result.length > 0 && !preferredDatasetRecoveryAppliedRef.current) {
          preferredDatasetRecoveryAppliedRef.current = true;
          appendPreferredLaunchContextHint(
            t('Requested dataset is unavailable, using current task inventory instead.')
          );
        }
        setDatasetId((current) =>
          current && result.some((dataset) => dataset.id === current)
            ? current
            : (first?.id ?? '')
        );
      })
      .catch((error) => setFeedback({ variant: 'error', text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [appendPreferredLaunchContextHint, preferredDatasetId, taskType, t]);

  useEffect(() => {
    if (!datasetId) {
      setDatasetVersions([]);
      setDatasetVersionId('');
      return;
    }

    let active = true;
    setVersionsLoading(true);

    api
      .listDatasetVersions(datasetId)
      .then((result) => {
        if (!active) {
          return;
        }

        setDatasetVersions(result);
        const preferredVersion =
          preferredVersionId &&
          !preferredVersionAppliedRef.current &&
          result.find((version) => version.id === preferredVersionId)
            ? preferredVersionId
            : '';

        if (preferredVersion) {
          preferredVersionAppliedRef.current = true;
        } else if (preferredVersionId && result.length > 0 && !preferredVersionRecoveryAppliedRef.current) {
          preferredVersionRecoveryAppliedRef.current = true;
          appendPreferredLaunchContextHint(
            t('Requested dataset version is unavailable, using an available snapshot.')
          );
        }

        setDatasetVersionId((current) =>
          preferredVersion || selectPreferredLaunchVersion(result, preferredVersionId, current)
        );
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setFeedback({ variant: 'error', text: (error as Error).message });
      })
      .finally(() => {
        if (active) {
          setVersionsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [appendPreferredLaunchContextHint, datasetId, preferredVersionId, t]);

  useEffect(() => {
    if (taskType === 'ocr' && framework === 'yolo') {
      setFramework('paddleocr');
    }

    if (taskType !== 'ocr' && (framework === 'paddleocr' || framework === 'doctr')) {
      setFramework('yolo');
    }
  }, [framework, taskType]);

  useEffect(() => {
    if (
      preferredTaskFrameworkRecoveryAppliedRef.current ||
      !preferredTaskTypeNormalized ||
      !preferredFramework
    ) {
      return;
    }
    const incompatible =
      (preferredTaskTypeNormalized === 'ocr' && preferredFramework === 'yolo') ||
      (preferredTaskTypeNormalized !== 'ocr' &&
        (preferredFramework === 'paddleocr' || preferredFramework === 'doctr'));
    if (!incompatible) {
      return;
    }
    preferredTaskFrameworkRecoveryAppliedRef.current = true;
    appendPreferredLaunchContextHint(t('Adjusted framework to align with task type compatibility.'));
  }, [appendPreferredLaunchContextHint, preferredFramework, preferredTaskTypeNormalized, t]);

  useEffect(() => {
    let active = true;
    setRuntimeSettingsLoading(true);
    setRuntimeSettingsError('');
    api
      .getRuntimeSettings()
      .then((view) => {
        if (!active) {
          return;
        }
        setRuntimeDisableSimulatedTrainFallback(view.controls.disable_simulated_train_fallback);
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
    if (!preferredSourceJobId || sourceJobPrefillAppliedRef.current) {
      return;
    }
    let active = true;
    sourceJobPrefillAppliedRef.current = true;
    setSourceJobPrefillLoading(true);
    setSourceJobPrefillError('');
    api
      .getTrainingJobDetail(preferredSourceJobId)
      .then((detail) => {
        if (!active) {
          return;
        }
        const sourceJob = detail.job;
        setSourceJobPrefillJob(sourceJob);
        setTaskType(sourceJob.task_type);
        setFramework(sourceJob.framework);
        setDatasetId(sourceJob.dataset_id);
        setDatasetVersionId(sourceJob.dataset_version_id ?? '');
        setBaseModel(sourceJob.base_model);

        const pickConfigValue = (...keys: string[]): string => {
          for (const key of keys) {
            const value = sourceJob.config[key];
            if (typeof value === 'string' && value.trim().length > 0) {
              return value.trim();
            }
          }
          return '';
        };
        const nextEpochs = pickConfigValue('epochs');
        const nextBatchSize = pickConfigValue('batch_size', 'batchSize');
        const nextLearningRate = pickConfigValue('learning_rate', 'learningRate');
        const nextWarmupRatio = pickConfigValue('warmup_ratio', 'warmupRatio');
        const nextWeightDecay = pickConfigValue('weight_decay', 'weightDecay');
        if (nextEpochs) {
          setEpochs(nextEpochs);
        }
        if (nextBatchSize) {
          setBatchSize(nextBatchSize);
        }
        if (nextLearningRate) {
          setLearningRate(nextLearningRate);
        }
        if (nextWarmupRatio) {
          setWarmupRatio(nextWarmupRatio);
        }
        if (nextWeightDecay) {
          setWeightDecay(nextWeightDecay);
        }
        setDispatchPreference(sourceJob.execution_target);
        setSelectedWorkerId(
          sourceJob.execution_target === 'worker' ? sourceJob.scheduled_worker_id?.trim() ?? '' : ''
        );
        setName((current) => (current.trim().length > 0 ? current : `${sourceJob.name}-next`));
        appendPreferredLaunchContextHint(
          t('Prefilled launch settings from source run {jobId}.', { jobId: sourceJob.id })
        );
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setSourceJobPrefillError((error as Error).message);
      })
      .finally(() => {
        if (active) {
          setSourceJobPrefillLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [appendPreferredLaunchContextHint, preferredSourceJobId, t]);

  useEffect(() => {
    if (!preferredSourceVisionTaskId) {
      return;
    }
    let active = true;
    setSourceVisionTaskLoading(true);
    setSourceVisionTaskError('');
    api
      .getVisionTask(preferredSourceVisionTaskId)
      .then((task) => {
        if (!active) {
          return;
        }
        setSourceVisionTask(task);
        setRequirementDescription((current) => (current.trim().length > 0 ? current : task.source_prompt));
        if (task.spec.task_type && task.spec.task_type !== 'unknown') {
          setTaskType(task.spec.task_type as TrainingTaskType);
        }
        if (task.dataset_id) {
          setDatasetId(task.dataset_id);
        }
        if (task.dataset_version_id) {
          setDatasetVersionId(task.dataset_version_id);
        }
        if (task.training_plan?.base_model) {
          setBaseModel(task.training_plan.base_model);
        }
        const pickTrainArg = (...keys: string[]) => {
          const trainArgs = task.training_plan?.train_args ?? {};
          for (const key of keys) {
            const value = trainArgs[key];
            if (typeof value === 'string' && value.trim().length > 0) {
              return value.trim();
            }
          }
          return '';
        };
        const nextEpochs = pickTrainArg('epochs');
        const nextBatchSize = pickTrainArg('batch_size', 'batchSize');
        const nextLearningRate = pickTrainArg('learning_rate', 'learningRate');
        const nextWarmupRatio = pickTrainArg('warmup_ratio', 'warmupRatio');
        const nextWeightDecay = pickTrainArg('weight_decay', 'weightDecay');
        if (nextEpochs) {
          setEpochs(nextEpochs);
        }
        if (nextBatchSize) {
          setBatchSize(nextBatchSize);
        }
        if (nextLearningRate) {
          setLearningRate(nextLearningRate);
        }
        if (nextWarmupRatio) {
          setWarmupRatio(nextWarmupRatio);
        }
        if (nextWeightDecay) {
          setWeightDecay(nextWeightDecay);
        }
        setName((current) => (current.trim().length > 0 ? current : `${task.id}-launch`));
        appendPreferredLaunchContextHint(
          t('Linked Smart Launch back to vision task {taskId}.', { taskId: task.id })
        );
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setSourceVisionTaskError((error as Error).message);
      })
      .finally(() => {
        if (active) {
          setSourceVisionTaskLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [appendPreferredLaunchContextHint, preferredSourceVisionTaskId, t]);

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
    if (runtimeDisableSimulatedTrainFallback || runtimeSettingsError) {
      setNonStrictLaunchConfirmed(false);
    }
  }, [runtimeDisableSimulatedTrainFallback, runtimeSettingsError]);

  useEffect(() => {
    if (dispatchPreference !== 'worker' && selectedWorkerId) {
      setSelectedWorkerId('');
    }
  }, [dispatchPreference, selectedWorkerId]);

  useEffect(() => {
    if (
      preferredWorkerRecoveryAppliedRef.current ||
      dispatchPreference !== 'worker' ||
      !preferredWorkerId ||
      workersLoading ||
      workersAccessDenied
    ) {
      return;
    }
    if (workers.some((worker) => worker.id === preferredWorkerId)) {
      return;
    }
    preferredWorkerRecoveryAppliedRef.current = true;
    setSelectedWorkerId('');
    setDispatchPreference('auto');
    appendPreferredLaunchContextHint(
      t('Requested worker is unavailable, switched dispatch back to auto scheduling.')
    );
  }, [
    appendPreferredLaunchContextHint,
    dispatchPreference,
    preferredWorkerId,
    workers,
    workersAccessDenied,
    workersLoading,
    t
  ]);

  useEffect(() => {
    const queryTaskType = (() => {
      const value = (searchParams.get('task_type') ?? searchParams.get('model_type') ?? '').trim();
      if (taskTypeOptions.includes(value as (typeof taskTypeOptions)[number])) {
        return value as (typeof taskTypeOptions)[number];
      }
      return null;
    })();
    if (queryTaskType && queryTaskType !== taskType) {
      setTaskType(queryTaskType);
    }

    const queryFramework = (() => {
      const value = (searchParams.get('framework') ?? searchParams.get('profile') ?? '').trim().toLowerCase();
      if (trainingFrameworkOptions.includes(value as TrainingFramework)) {
        return value as TrainingFramework;
      }
      return null;
    })();
    if (queryFramework && queryFramework !== framework) {
      setFramework(queryFramework);
    }

    const queryExecutionTarget = (() => {
      const value = (searchParams.get('execution_target') ?? '').trim().toLowerCase();
      return value === 'control_plane' || value === 'worker' ? value : 'auto';
    })();
    if (queryExecutionTarget !== dispatchPreference) {
      setDispatchPreference(queryExecutionTarget);
    }

    const queryWorkerId = (searchParams.get('worker') ?? '').trim();
    if (queryExecutionTarget === 'worker' && queryWorkerId !== selectedWorkerId) {
      setSelectedWorkerId(queryWorkerId);
    }
  }, [dispatchPreference, framework, searchParams, selectedWorkerId, taskType]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);

    if (datasetId.trim()) {
      next.set('dataset', datasetId.trim());
    } else {
      next.delete('dataset');
    }

    if (datasetVersionId.trim()) {
      next.set('version', datasetVersionId.trim());
    } else {
      next.delete('version');
    }

    next.set('task_type', taskType);
    // Backward compatibility cleanup for older task key.
    next.delete('model_type');

    next.set('framework', framework);
    // Backward compatibility cleanup for older framework alias.
    next.delete('profile');

    if (dispatchPreference === 'auto') {
      next.delete('execution_target');
    } else {
      next.set('execution_target', dispatchPreference);
    }

    if (dispatchPreference === 'worker' && selectedWorkerId.trim()) {
      next.set('worker', selectedWorkerId.trim());
    } else {
      next.delete('worker');
    }

    const currentQuery = searchParams.toString();
    const nextQuery = next.toString();
    if (nextQuery === currentQuery) {
      return;
    }

    navigate(nextQuery ? `${location.pathname}?${nextQuery}` : location.pathname, {
      replace: true
    });
  }, [
    datasetId,
    datasetVersionId,
    dispatchPreference,
    framework,
    location.pathname,
    navigate,
    searchParams,
    selectedWorkerId,
    taskType
  ]);

  const baseModelOptions = useMemo<string[]>(
    () => resolveBaseModelOptions(framework, taskType),
    [framework, taskType]
  );

  useEffect(() => {
    setBaseModel((current) => {
      if (current && baseModelOptions.includes(current)) {
        return current;
      }

      return baseModelOptions[0] ?? '';
    });
  }, [baseModelOptions]);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === datasetId) ?? null,
    [datasetId, datasets]
  );
  useEffect(() => {
    if (!selectedDataset) {
      return;
    }
    if (selectedDataset.task_type !== taskType) {
      setTaskType(selectedDataset.task_type);
    }
  }, [selectedDataset, taskType]);
  const preferredDatasetRecord = useMemo(
    () => (preferredDatasetId ? datasets.find((dataset) => dataset.id === preferredDatasetId) ?? null : null),
    [datasets, preferredDatasetId]
  );
  const preferredDatasetMissing = useMemo(
    () => Boolean(preferredDatasetId && datasets.length > 0 && !preferredDatasetRecord),
    [datasets.length, preferredDatasetId, preferredDatasetRecord]
  );
  const preferredVersionRecord = useMemo(
    () => (preferredVersionId ? datasetVersions.find((version) => version.id === preferredVersionId) ?? null : null),
    [datasetVersions, preferredVersionId]
  );
  const preferredVersionMissing = useMemo(() => {
    if (!preferredVersionId || versionsLoading || datasetVersions.length === 0) {
      return false;
    }
    if (preferredDatasetId && datasetId !== preferredDatasetId) {
      return false;
    }
    return !preferredVersionRecord;
  }, [
    datasetId,
    datasetVersions.length,
    preferredDatasetId,
    preferredVersionId,
    preferredVersionRecord,
    versionsLoading
  ]);
  const clearRequestedLaunchContextPath = useMemo(() => {
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
  const clearSourceJobPrefillPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('source_job');
    next.delete('sourceJob');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);
  const clearSourceVisionTaskPath = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('source_vision_task');
    next.delete('vision_task');
    const query = next.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  }, [location.pathname, searchParams]);
  const onlineWorkers = useMemo(
    () =>
      workers.filter(
        (worker) => worker.enabled && worker.effective_status === 'online' && Boolean(worker.endpoint)
      ),
    [workers]
  );
  const selectedWorker = useMemo(
    () => workers.find((worker) => worker.id === selectedWorkerId) ?? null,
    [selectedWorkerId, workers]
  );
  const requestedWorkerMissing = useMemo(
    () =>
      Boolean(
        preferredWorkerId &&
          !workersLoading &&
          !workersAccessDenied &&
          !workers.some((worker) => worker.id === preferredWorkerId)
      ),
    [preferredWorkerId, workers, workersAccessDenied, workersLoading]
  );
  const selectedWorkerAvailable =
    !selectedWorkerId || workersLoading || workersAccessDenied || Boolean(selectedWorker);
  const dispatchSummary = useMemo(() => {
    if (dispatchPreference === 'auto') {
      return t('Scheduler chooses between worker and control-plane automatically.');
    }
    if (dispatchPreference === 'control_plane') {
      return t('Run will stay on control-plane local execution path.');
    }
    if (selectedWorkerId) {
      if (workersLoading || workersAccessDenied) {
        return t('Worker inventory is unavailable. Worker ID will be validated at submit time.');
      }
      return selectedWorker
        ? t('Worker dispatch is pinned to {worker}.', { worker: selectedWorker.name })
        : t('Pinned worker is not in current inventory.');
    }
    return t('Worker dispatch is required. Scheduler will pick one online eligible worker.');
  }, [dispatchPreference, selectedWorker, selectedWorkerId, t, workersAccessDenied, workersLoading]);
  const selectedDatasetVersion = useMemo(
    () => datasetVersions.find((version) => version.id === datasetVersionId) ?? null,
    [datasetVersionId, datasetVersions]
  );
  const launchContext = useMemo(
    () => ({
      datasetId: datasetId || null,
      versionId: datasetVersionId || null,
      taskType: taskType || null,
      framework: framework || null,
      executionTarget: dispatchPreference,
      workerId: dispatchPreference === 'worker' ? selectedWorkerId || null : null
    }),
    [datasetId, datasetVersionId, dispatchPreference, framework, selectedWorkerId, taskType]
  );
  const datasetsPath = useMemo(() => buildDatasetsPath(launchContext), [launchContext]);
  const selectedDatasetDetailPath = useMemo(
    () =>
      selectedDataset
        ? buildDatasetDetailPath(selectedDataset.id, selectedDatasetVersion?.id, launchContext)
        : datasetsPath,
    [datasetsPath, launchContext, selectedDataset, selectedDatasetVersion?.id]
  );
  const selectedClosurePath = useMemo(
    () =>
      selectedDataset
        ? buildClosurePath(selectedDataset.id, selectedDatasetVersion?.id, launchContext)
        : '/workflow/closure',
    [launchContext, selectedDataset, selectedDatasetVersion?.id]
  );
  const sourceJobDetailPath = useMemo(() => {
    if (!sourceJobPrefillJob) {
      return '';
    }
    return buildTrainingJobDetailPath(sourceJobPrefillJob.id, {
      datasetId: sourceJobPrefillJob.dataset_id,
      versionId: sourceJobPrefillJob.dataset_version_id,
      launchContext,
      returnTo: currentTaskPath
    });
  }, [currentTaskPath, launchContext, sourceJobPrefillJob]);
  const sourceVisionTaskDetailPath = useMemo(
    () => (sourceVisionTask ? buildVisionTaskDetailPath(sourceVisionTask.id) : ''),
    [sourceVisionTask]
  );
  const runtimeReadinessPath = useMemo(
    () => buildRuntimeSettingsPath('readiness', framework, launchContext, outboundReturnTo),
    [framework, launchContext, outboundReturnTo]
  );
  const workerInventoryPath = useMemo(
    () =>
      buildWorkerSettingsPath({
        focus: 'inventory',
        profile: framework,
        workerId: selectedWorkerId || undefined,
        launchContext,
        returnTo: outboundReturnTo
      }),
    [framework, launchContext, outboundReturnTo, selectedWorkerId]
  );
  const workerPairingPath = useMemo(
    () =>
      buildWorkerSettingsPath({
        focus: 'pairing',
        onboarding: true,
        profile: framework,
        launchContext,
        returnTo: outboundReturnTo
      }),
    [framework, launchContext, outboundReturnTo]
  );
  const snapshotPrefilledFromLink =
    Boolean(preferredDatasetId) &&
    datasetId === preferredDatasetId &&
    (!preferredVersionId || datasetVersionId === preferredVersionId);
  const datasetStatusReady = selectedDataset?.status === 'ready';
  const datasetVersionHasTrainSplit = (selectedDatasetVersion?.split_summary.train ?? 0) > 0;
  const datasetVersionHasAnnotationCoverage = (selectedDatasetVersion?.annotation_coverage ?? 0) > 0;
  const launchReady =
    Boolean(selectedDataset) &&
    datasetStatusReady &&
    Boolean(selectedDatasetVersion) &&
    datasetVersionHasTrainSplit &&
    datasetVersionHasAnnotationCoverage;
  const strictLaunchGateReady = runtimeDisableSimulatedTrainFallback || nonStrictLaunchConfirmed;
  const paramValidationIssues = useMemo(() => {
    const issues: string[] = [];
    if (parsePositiveInteger(epochs) === null) {
      issues.push(t('Epochs must be a positive integer.'));
    }
    if (parsePositiveInteger(batchSize) === null) {
      issues.push(t('Batch size must be a positive integer.'));
    }
    if (parsePositiveNumber(learningRate) === null) {
      issues.push(t('Learning rate must be greater than 0.'));
    }
    const parsedWarmupRatio = parseNonNegativeNumber(warmupRatio);
    if (parsedWarmupRatio === null || parsedWarmupRatio > 1) {
      issues.push(t('Warmup ratio must be between 0 and 1.'));
    }
    if (parseNonNegativeNumber(weightDecay) === null) {
      issues.push(t('Weight decay must be 0 or greater.'));
    }
    return issues;
  }, [batchSize, epochs, learningRate, t, warmupRatio, weightDecay]);
  const paramsReady = paramValidationIssues.length === 0;
  const dispatchReady = dispatchPreference !== 'worker' || selectedWorkerAvailable;
  const snapshotAutoRecoverable = autoPrepareSnapshot && Boolean(selectedDataset) && datasetStatusReady;
  const submitReady =
    (launchReady || snapshotAutoRecoverable) &&
    !runtimeSettingsLoading &&
    !runtimeSettingsError &&
    strictLaunchGateReady &&
    paramsReady &&
    dispatchReady;
  const launchCheckpoints = useMemo(() => {
    const runtimeState = runtimeSettingsLoading
      ? ('pending' as const)
      : runtimeSettingsError
        ? ('blocked' as const)
        : runtimeDisableSimulatedTrainFallback || nonStrictLaunchConfirmed
          ? ('ready' as const)
          : ('blocked' as const);

    return [
      {
        key: 'name',
        label: t('Run name'),
        state: name.trim() ? ('ready' as const) : ('blocked' as const),
        detail: name.trim() || t('Add a short run name.'),
        action: () => jobNameInputRef.current?.focus()
      },
      {
        key: 'snapshot',
        label: t('Data snapshot'),
        state: launchReady ? ('ready' as const) : ('blocked' as const),
        detail: selectedDatasetVersion
          ? [selectedDataset?.name, selectedDatasetVersion.version_name].filter(Boolean).join(' · ')
          : autoPrepareSnapshot
            ? t('Snapshot will be auto-prepared at launch.')
            : t('Choose a dataset and version first.'),
        action: () => {
          if (!datasetId) {
            datasetSelectRef.current?.focus();
            return;
          }
          datasetVersionSelectRef.current?.focus();
        }
      },
      {
        key: 'params',
        label: t('Core params'),
        state: paramsReady ? ('ready' as const) : ('blocked' as const),
        detail: paramsReady ? t('Core values look valid.') : paramValidationIssues[0] ?? t('Fix the numeric values.'),
        action: () => paramsEpochsInputRef.current?.focus()
      },
      {
        key: 'dispatch',
        label: t('Dispatch strategy'),
        state: dispatchReady ? ('ready' as const) : ('blocked' as const),
        detail: dispatchReady ? dispatchSummary : t('Selected worker is not in current inventory.'),
        action:
          dispatchPreference === 'worker'
            ? () => navigate(onlineWorkers.length > 0 || selectedWorkerId ? workerInventoryPath : workerPairingPath)
            : null
      },
      {
        key: 'runtime',
        label: t('Runtime guard'),
        state: runtimeState,
        detail: runtimeSettingsLoading
          ? t('Checking Runtime...')
          : runtimeSettingsError
            ? t('Go fix it in Runtime settings.')
            : runtimeDisableSimulatedTrainFallback
              ? t('Strict fallback is enabled.')
              : t('Confirm the risk to continue.'),
        action: runtimeSettingsError
          ? () => navigate(runtimeReadinessPath)
          : !runtimeDisableSimulatedTrainFallback && !nonStrictLaunchConfirmed
            ? () => setNonStrictLaunchConfirmed(true)
            : null
      }
    ];
  }, [
    autoPrepareSnapshot,
    datasetId,
    launchReady,
    name,
    navigate,
    nonStrictLaunchConfirmed,
    dispatchReady,
    dispatchPreference,
    dispatchSummary,
    onlineWorkers.length,
    paramsReady,
    paramValidationIssues,
    runtimeDisableSimulatedTrainFallback,
    runtimeSettingsError,
    runtimeSettingsLoading,
    runtimeReadinessPath,
    selectedWorkerId,
    selectedDataset,
    selectedDatasetVersion,
    workerInventoryPath,
    workerPairingPath,
    t
  ]);
  const blockedLaunchCheckpoints = launchCheckpoints.filter((item) => item.state !== 'ready');
  const nextLaunchCheckpoint = blockedLaunchCheckpoints[0] ?? null;
  const launchStatusDescription =
    runtimeSettingsLoading && blockedLaunchCheckpoints.length > 0
      ? t('Runtime is still loading.')
      : blockedLaunchCheckpoints.length === 0
        ? t('Snapshot, params, and Runtime are ready.')
        : t('{count} check(s) still need attention.', { count: blockedLaunchCheckpoints.length });
  const launchStatusAction =
    nextLaunchCheckpoint?.action && nextLaunchCheckpoint.state !== 'pending'
      ? {
          label:
            nextLaunchCheckpoint.key === 'name'
              ? t('Focus run name')
              : nextLaunchCheckpoint.key === 'snapshot'
                ? t('Focus snapshot')
                : nextLaunchCheckpoint.key === 'params'
                  ? t('Focus params')
                  : nextLaunchCheckpoint.key === 'dispatch'
                    ? t('Worker Settings')
                  : nextLaunchCheckpoint.key === 'runtime' && runtimeSettingsError
                    ? t('Open Runtime Settings')
                    : t('Confirm risk'),
          onClick: nextLaunchCheckpoint.action
        }
      : null;

  const taskFrameworkOptions = useMemo(() => {
    if (taskType === 'ocr') {
      return ['paddleocr', 'doctr'] as const;
    }
    return ['yolo'] as const;
  }, [taskType]);

  const recommendedParams = useMemo(() => {
    const byFramework = recommendedTrainingConfigCatalog[framework];
    const fallbackTask = framework === 'yolo' ? 'detection' : 'ocr';
    return byFramework[taskType] ?? byFramework[fallbackTask] ?? null;
  }, [framework, taskType]);

  const applyRecommendedParams = useCallback(() => {
    const recommended = recommendedParams;
    if (!recommended) {
      return;
    }
    setEpochs(recommended.epochs);
    setBatchSize(recommended.batchSize);
    setLearningRate(recommended.learningRate);
    setWarmupRatio(recommended.warmupRatio);
    setWeightDecay(recommended.weightDecay);
    setFeedback({
      variant: 'success',
      text: t('Applied recommended params for {framework}/{task}.', {
        framework,
        task: taskType
      })
    });
  }, [framework, recommendedParams, taskType, t]);

  const queueBootstrapSampleFiles = useCallback(
    (incomingFiles: File[]) => {
      if (incomingFiles.length === 0) {
        return;
      }
      const oversized = findOversizedUpload(incomingFiles);
      if (oversized) {
        setFeedback({
          variant: 'error',
          text: t('File {filename} is {size}. Keep each file under {limit} to avoid proxy rejection (413).', {
            filename: oversized.name,
            size: formatByteSize(oversized.size),
            limit: UPLOAD_SOFT_LIMIT_LABEL
          })
        });
        return;
      }

      setBootstrapSampleFiles((current) => {
        const unique = dedupeBootstrapSampleFiles([...current, ...incomingFiles]).slice(0, maxBootstrapSampleEntries);
        if (unique.length < current.length + incomingFiles.length) {
          setFeedback({
            variant: 'success',
            text: t('Only {count} sample files are kept for Smart Launch. Remove duplicates or extra files if needed.', {
              count: maxBootstrapSampleEntries
            })
          });
        }
        return unique;
      });
    },
    [t]
  );

  const removeBootstrapSampleFile = useCallback((targetKey: string) => {
    setBootstrapSampleFiles((current) =>
      current.filter((file) => buildBootstrapSampleFileKey(file) !== targetKey)
    );
  }, []);

  const clearBootstrapSampleFiles = useCallback(() => {
    setBootstrapSampleFiles([]);
    setBootstrapDropActive(false);
  }, []);

  const handleBootstrapSampleFileInput = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>) => {
      const selectedFiles = event.target.files ? Array.from(event.target.files) : [];
      event.target.value = '';
      queueBootstrapSampleFiles(selectedFiles);
    },
    [queueBootstrapSampleFiles]
  );

  const handleBootstrapDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setBootstrapDropActive(false);
      const droppedFiles = Array.from(event.dataTransfer.files ?? []);
      queueBootstrapSampleFiles(droppedFiles);
    },
    [queueBootstrapSampleFiles]
  );

  const waitForDatasetAttachmentsReady = useCallback(
    async (
      targetDatasetId: string,
      expectedCount: number
    ): Promise<{ ready: boolean; failedFilenames: string[] }> => {
      const maxRounds = 30;
      for (let round = 0; round < maxRounds; round += 1) {
        const attachments = await api.listDatasetAttachments(targetDatasetId);
        const readyCount = attachments.filter((item) => item.status === 'ready').length;
        const hasPending = attachments.some((item) => item.status === 'uploading' || item.status === 'processing');
        const failed = attachments.filter((item) => item.status === 'error').map((item) => item.filename);
        if (failed.length > 0) {
          return { ready: false, failedFilenames: failed };
        }
        if (readyCount >= expectedCount && !hasPending) {
          return { ready: true, failedFilenames: [] };
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
      return { ready: false, failedFilenames: [] };
    },
    []
  );

  const createDatasetFromSamples = useCallback(
    async (runName: string): Promise<DatasetRecord | null> => {
      const parsedFilenames = parseBootstrapFilenames(bootstrapSampleFilenames);
      const selectedFiles = dedupeBootstrapSampleFiles(bootstrapSampleFiles).slice(0, maxBootstrapSampleEntries);
      const selectedFileNameSet = new Set(selectedFiles.map((file) => file.name.trim().toLowerCase()));
      const filenames = parsedFilenames.filter((filename) => !selectedFileNameSet.has(filename.toLowerCase()));
      const sampleCount = selectedFiles.length + filenames.length;
      if (sampleCount === 0) {
        setFeedback({
          variant: 'error',
          text: t('Add sample files or filenames so Smart Launch can create dataset automatically.')
        });
        return null;
      }

      setCreatingDatasetFromSamples(true);
      try {
        const datasetNameBase = runName.trim() || `${taskType}-${framework}`;
        const createdDataset = await api.createDataset({
          name: `${datasetNameBase}-dataset-${Date.now().toString().slice(-6)}`,
          description: t('Auto-created by Smart Launch from sample inputs.'),
          task_type: taskType,
          label_schema: {
            classes: defaultLabelClassesByTask[taskType]
          }
        });

        for (const file of selectedFiles) {
          await api.uploadDatasetFile(createdDataset.id, file);
        }
        for (const filename of filenames) {
          await api.uploadDatasetAttachment(createdDataset.id, filename);
        }

        const readiness = await waitForDatasetAttachmentsReady(createdDataset.id, sampleCount);
        if (!readiness.ready) {
          if (readiness.failedFilenames.length > 0) {
            setFeedback({
              variant: 'error',
              text: t('Some sample files failed to process: {files}', {
                files: readiness.failedFilenames.slice(0, 6).join(', ')
              })
            });
            return null;
          }
          setFeedback({
            variant: 'success',
            text: t('Dataset files are still processing. Smart Launch will continue once they are ready.')
          });
        }

        setDatasets((previous) => [createdDataset, ...previous.filter((item) => item.id !== createdDataset.id)]);
        setDatasetId(createdDataset.id);
        setSnapshotPreparationNote(
          t('Smart Launch created dataset from {count} sample file(s).', { count: sampleCount })
        );
        setBootstrapSampleFilenames('');
        setBootstrapSampleFiles([]);
        return createdDataset;
      } catch (error) {
        setFeedback({
          variant: 'error',
          text: t('Smart dataset bootstrap failed: {message}', {
            message: (error as Error).message
          })
        });
        return null;
      } finally {
        setCreatingDatasetFromSamples(false);
      }
    },
    [bootstrapSampleFilenames, bootstrapSampleFiles, framework, taskType, t, waitForDatasetAttachmentsReady]
  );

  const autoPrepareTrainingSnapshot = useCallback(async (options?: {
    datasetIdOverride?: string;
    datasetOverride?: DatasetRecord | null;
  }) => {
    const effectiveDatasetId = options?.datasetIdOverride ?? datasetId;
    const effectiveDataset = options?.datasetOverride ?? selectedDataset;
    if (!effectiveDatasetId || !effectiveDataset) {
      setFeedback({ variant: 'error', text: t('Please select a dataset first.') });
      return null;
    }
    if (effectiveDataset.status !== 'ready') {
      setFeedback({ variant: 'error', text: t('Selected dataset must be ready before creating a run.') });
      return null;
    }

    setPreparingSnapshot(true);
    setFeedback(null);
    const notes: string[] = [];

    try {
      let versions = await api.listDatasetVersions(effectiveDatasetId);
      let readyVersion = versions.find(isTrainingReadyDatasetVersion) ?? null;

      if (!readyVersion) {
        const hasTrainSplit = versions.some((version) => version.split_summary.train > 0);
        if (!hasTrainSplit) {
          await api.splitDataset({
            dataset_id: effectiveDatasetId,
            train_ratio: 0.8,
            val_ratio: 0.1,
            test_ratio: 0.1,
            seed: 42
          });
          notes.push(t('Auto-split applied'));
        }

        const hasCoverage = versions.some((version) => version.annotation_coverage > 0);
        if (!hasCoverage) {
          try {
            const preAnnotationResult = await api.runDatasetPreAnnotations(effectiveDatasetId);
            if (preAnnotationResult.created + preAnnotationResult.updated > 0) {
              notes.push(
                t('Auto pre-annotation added {count} item(s).', {
                  count: preAnnotationResult.created + preAnnotationResult.updated
                })
              );
            }
          } catch {
            notes.push(t('Auto pre-annotation skipped'));
          }
        }

        await api.createDatasetVersion(effectiveDatasetId, `auto-v${Date.now().toString().slice(-6)}`);
        notes.push(t('Auto dataset version created'));
        versions = await api.listDatasetVersions(effectiveDatasetId);
        readyVersion = versions.find(isTrainingReadyDatasetVersion) ?? null;
      }

      setDatasetVersions(versions);
      const selectedVersionId = selectPreferredLaunchVersion(
        versions,
        preferredVersionId,
        readyVersion?.id ?? datasetVersionId
      );
      setDatasetVersionId(selectedVersionId);
      const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? null;

      if (selectedVersion && isTrainingReadyDatasetVersion(selectedVersion)) {
        const note = notes.length > 0 ? notes.join(' · ') : t('Training-ready snapshot selected automatically.');
        setSnapshotPreparationNote(note);
        return selectedVersion;
      }

      setSnapshotPreparationNote(notes.join(' · '));
      setFeedback({
        variant: 'error',
        text: t('Snapshot is still not launch-ready. Please complete annotation or dataset versioning in dataset lane.')
      });
      return null;
    } catch (error) {
      setSnapshotPreparationNote('');
      setFeedback({
        variant: 'error',
        text: t('Auto snapshot preparation failed: {message}', {
          message: (error as Error).message
        })
      });
      return null;
    } finally {
      setPreparingSnapshot(false);
    }
  }, [datasetId, datasetVersionId, preferredVersionId, selectedDataset, t]);

  const ensureTaskDraftFromRequirement = useCallback(
    async (options?: { silent?: boolean }) => {
      const prompt = requirementDescription.trim();
      if (!prompt) {
        if (!options?.silent) {
          setFeedback({ variant: 'error', text: t('Please describe your requirement first.') });
        }
        return null;
      }

      setDrafting(true);
      if (!options?.silent) {
        setFeedback(null);
      }

      try {
        const draft = await api.draftTaskFromRequirement(prompt);
        const lockedTaskType = selectedDataset?.task_type ?? null;
        const effectiveTaskType = lockedTaskType ?? draft.task_type;
        const effectiveFramework: TrainingFramework =
          effectiveTaskType === 'ocr'
            ? draft.recommended_framework === 'paddleocr' || draft.recommended_framework === 'doctr'
              ? draft.recommended_framework
              : 'paddleocr'
            : 'yolo';

        setTaskDraft(draft);
        if (effectiveTaskType !== taskType) {
          setTaskType(effectiveTaskType);
        }
        if (effectiveFramework !== framework) {
          setFramework(effectiveFramework);
        }
        if (!name.trim()) {
          setName(
            `${selectedDataset?.name ?? effectiveTaskType}-${effectiveFramework}-job-${Date.now().toString().slice(-6)}`
          );
        }
        if (!options?.silent) {
          setFeedback({
            variant: 'success',
            text:
              lockedTaskType && lockedTaskType !== draft.task_type
                ? t('Requirement was understood. Dataset task type stays fixed, and the launch plan was updated around that dataset.')
                : t('Requirement was understood and the launch plan was updated.')
          });
        }
        return draft;
      } catch (error) {
        setFeedback({ variant: 'error', text: (error as Error).message });
        return null;
      } finally {
        setDrafting(false);
      }
    },
    [framework, name, requirementDescription, selectedDataset, t, taskType]
  );

  const resolveLaunchVisionTaskContext = useCallback(
    async (options: { datasetId: string; datasetVersionId: string }) => {
      if (preferredSourceVisionTaskId) {
        if (sourceVisionTask?.id === preferredSourceVisionTaskId) {
          return sourceVisionTask;
        }
        setAgentTaskPreparing(true);
        try {
          const task = await api.getVisionTask(preferredSourceVisionTaskId);
          setSourceVisionTask(task);
          setSourceVisionTaskError('');
          return task;
        } catch (error) {
          setSourceVisionTaskError((error as Error).message);
          return null;
        } finally {
          setAgentTaskPreparing(false);
        }
      }

      const prompt = requirementDescription.trim();
      if (!prompt) {
        return null;
      }

      setAgentTaskPreparing(true);
      try {
        const result = await api.understandVisionTask({
          prompt,
          dataset_id: options.datasetId,
          dataset_version_id: options.datasetVersionId
        });
        setSourceVisionTask(result.task);
        setSourceVisionTaskError('');
        return result.task;
      } catch (error) {
        setSourceVisionTaskError((error as Error).message);
        return null;
      } finally {
        setAgentTaskPreparing(false);
      }
    },
    [preferredSourceVisionTaskId, requirementDescription, sourceVisionTask]
  );

  const submit = async (options?: { autoFill?: boolean }) => {
    const autoFill = options?.autoFill ?? false;
    if (agentTaskPreparing) {
      return;
    }
    if (requirementDescription.trim()) {
      const ensuredDraft = await ensureTaskDraftFromRequirement({ silent: true });
      if (!ensuredDraft) {
        return;
      }
    }
    const generatedName = `${selectedDataset?.name ?? taskType}-${framework}-job-${Date.now().toString().slice(-6)}`;
    const effectiveName = name.trim() || (autoFill ? generatedName : '');
    if (!effectiveName) {
      setFeedback({ variant: 'error', text: t('Training job name is required.') });
      return;
    }
    if (!name.trim() && autoFill) {
      setName(effectiveName);
    }

    let resolvedDatasetId = datasetId;
    let resolvedDataset = selectedDataset;
    if (!resolvedDatasetId && autoFill) {
      const createdDataset = await createDatasetFromSamples(effectiveName);
      if (!createdDataset) {
        return;
      }
      resolvedDatasetId = createdDataset.id;
      resolvedDataset = createdDataset;
    }
    if (!resolvedDatasetId || !resolvedDataset) {
      setFeedback({ variant: 'error', text: t('Please select a dataset.') });
      return;
    }

    let resolvedVersion = selectedDatasetVersion;
    if (autoPrepareSnapshot && (!resolvedVersion || !launchReady)) {
      resolvedVersion = await autoPrepareTrainingSnapshot({
        datasetIdOverride: resolvedDatasetId,
        datasetOverride: resolvedDataset
      });
      if (!resolvedVersion) {
        return;
      }
    }

    if (!(resolvedVersion?.id ?? datasetVersionId).trim()) {
      setFeedback({ variant: 'error', text: t('Please select a dataset version.') });
      return;
    }

    if (!resolvedVersion) {
      setFeedback({ variant: 'error', text: t('Selected dataset version is unavailable.') });
      return;
    }

    if (!datasetStatusReady) {
      setFeedback({ variant: 'error', text: t('Selected dataset must be ready before creating a run.') });
      return;
    }

    if (resolvedVersion.split_summary.train <= 0) {
      setFeedback({ variant: 'error', text: t('Selected dataset version must include train split items before launch.') });
      return;
    }

    if (resolvedVersion.annotation_coverage <= 0) {
      setFeedback({ variant: 'error', text: t('Selected dataset version must include annotation coverage before launch.') });
      return;
    }

    if (runtimeSettingsError) {
      setFeedback({
        variant: 'error',
        text: t('Runtime safety status is unavailable. Resolve runtime settings before creating this run.')
      });
      return;
    }

    const runtimeRiskConfirmed =
      runtimeDisableSimulatedTrainFallback || nonStrictLaunchConfirmed || autoFill;
    if (!runtimeSettingsLoading && !runtimeDisableSimulatedTrainFallback && !nonStrictLaunchConfirmed && autoFill) {
      setNonStrictLaunchConfirmed(true);
    }
    if (!runtimeSettingsLoading && !runtimeRiskConfirmed) {
      setFeedback({
        variant: 'error',
        text: t('Runtime safety guard is off. Confirm risk acknowledgment before creating this run.')
      });
      return;
    }

    const fallbackParams = recommendedParams;
    const effectiveEpochs =
      parsePositiveInteger(epochs) !== null
        ? epochs
        : autoFill && fallbackParams
          ? fallbackParams.epochs
          : epochs;
    const effectiveBatchSize =
      parsePositiveInteger(batchSize) !== null
        ? batchSize
        : autoFill && fallbackParams
          ? fallbackParams.batchSize
          : batchSize;
    const effectiveLearningRate =
      parsePositiveNumber(learningRate) !== null
        ? learningRate
        : autoFill && fallbackParams
          ? fallbackParams.learningRate
          : learningRate;
    const warmupCandidate =
      parseNonNegativeNumber(warmupRatio) !== null &&
      (parseNonNegativeNumber(warmupRatio) ?? 0) <= 1
        ? warmupRatio
        : autoFill && fallbackParams
          ? fallbackParams.warmupRatio
          : warmupRatio;
    const effectiveWeightDecay =
      parseNonNegativeNumber(weightDecay) !== null
        ? weightDecay
        : autoFill && fallbackParams
          ? fallbackParams.weightDecay
          : weightDecay;

    const autoParamIssues: string[] = [];
    if (parsePositiveInteger(effectiveEpochs) === null) {
      autoParamIssues.push(t('Epochs must be a positive integer.'));
    }
    if (parsePositiveInteger(effectiveBatchSize) === null) {
      autoParamIssues.push(t('Batch size must be a positive integer.'));
    }
    if (parsePositiveNumber(effectiveLearningRate) === null) {
      autoParamIssues.push(t('Learning rate must be greater than 0.'));
    }
    const parsedWarmup = parseNonNegativeNumber(warmupCandidate);
    if (parsedWarmup === null || parsedWarmup > 1) {
      autoParamIssues.push(t('Warmup ratio must be between 0 and 1.'));
    }
    if (parseNonNegativeNumber(effectiveWeightDecay) === null) {
      autoParamIssues.push(t('Weight decay must be 0 or greater.'));
    }

    if (autoParamIssues.length > 0) {
      setFeedback({
        variant: 'error',
        text: autoParamIssues[0] ?? t('Fix the training params before launch.')
      });
      return;
    }
    if (autoFill && fallbackParams) {
      if (effectiveEpochs !== epochs) {
        setEpochs(effectiveEpochs);
      }
      if (effectiveBatchSize !== batchSize) {
        setBatchSize(effectiveBatchSize);
      }
      if (effectiveLearningRate !== learningRate) {
        setLearningRate(effectiveLearningRate);
      }
      if (warmupCandidate !== warmupRatio) {
        setWarmupRatio(warmupCandidate);
      }
      if (effectiveWeightDecay !== weightDecay) {
        setWeightDecay(effectiveWeightDecay);
      }
    }

    if (!dispatchReady) {
      setFeedback({
        variant: 'error',
        text: t('Selected worker is not in current inventory.')
      });
      return;
    }

    const linkedVisionTask = await resolveLaunchVisionTaskContext({
      datasetId: resolvedDatasetId,
      datasetVersionId: resolvedVersion.id
    });
    if (preferredSourceVisionTaskId && !linkedVisionTask) {
      setFeedback({
        variant: 'error',
        text: t('Source vision task is unavailable. Reload the agent context before launching.')
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    try {
      const executionTarget =
        dispatchPreference === 'auto' ? undefined : dispatchPreference;
      const workerId =
        dispatchPreference === 'worker' && selectedWorkerId.trim()
          ? selectedWorkerId.trim()
          : undefined;
      const created = await api.createTrainingJob({
        name: effectiveName,
        task_type: taskType,
        framework,
        dataset_id: resolvedDatasetId,
        dataset_version_id: resolvedVersion.id,
        ...(linkedVisionTask ? { vision_task_id: linkedVisionTask.id } : {}),
        base_model: baseModel.trim() || baseModelOptions[0] || `${framework}-base`,
        config: {
          epochs: effectiveEpochs,
          batch_size: effectiveBatchSize,
          learning_rate: effectiveLearningRate,
          warmup_ratio: warmupCandidate,
          weight_decay: effectiveWeightDecay
        },
        ...(executionTarget ? { execution_target: executionTarget } : {}),
        ...(workerId ? { worker_id: workerId } : {})
      });

      navigate(
        buildTrainingJobDetailPath(created.id, {
          datasetId: resolvedDatasetId,
          versionId: resolvedVersion.id,
          visionTaskId: linkedVisionTask?.id ?? null,
          created: true,
          launchContext,
          returnTo: outboundReturnTo
        })
      );
    } catch (error) {
      setFeedback({ variant: 'error', text: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const createTaskDraft = async () => {
    await ensureTaskDraftFromRequirement();
  };

  const wizardStep =
    !requirementDescription.trim() && !taskDraft && !name.trim()
      ? 0
      : !selectedDatasetVersion
        ? 1
        : 2;

  return (
    <WorkspacePage>
      <PageHeader
        eyebrow={t('Smart Launch')}
        title={t('Create Training Run')}
        description={t('Describe the target, confirm one snapshot, and let Vistral assemble the launch plan.')}
        primaryAction={{
          label: sourceVisionTaskLoading || agentTaskPreparing
            ? t('Preparing agent...')
            : creatingDatasetFromSamples
            ? t('Preparing dataset...')
            : preparingSnapshot
            ? t('Preparing snapshot...')
            : submitting
              ? t('Launching...')
              : t('Smart Launch'),
          onClick: () => {
            void submit({ autoFill: true });
          },
          disabled:
            submitting ||
            sourceVisionTaskLoading ||
            agentTaskPreparing ||
            creatingDatasetFromSamples ||
            preparingSnapshot ||
            loading ||
            versionsLoading ||
            !submitReady
        }}
        secondaryActions={
          <div className="row gap wrap">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void submit();
              }}
              disabled={
                submitting ||
                sourceVisionTaskLoading ||
                agentTaskPreparing ||
                creatingDatasetFromSamples ||
                preparingSnapshot ||
                loading ||
                versionsLoading
              }
            >
              {t('Use manual launch')}
            </Button>
            <ButtonLink to={datasetsPath} variant="ghost" size="sm">
              {t('Open datasets')}
            </ButtonLink>
            {selectedDataset ? (
              <ButtonLink to={selectedDatasetDetailPath} variant="ghost" size="sm">
                {t('Open dataset detail')}
              </ButtonLink>
            ) : null}
            {selectedDataset ? (
              <ButtonLink to={selectedClosurePath} variant="ghost" size="sm">
                {t('Open closure lane')}
              </ButtonLink>
            ) : null}
          </div>
        }
        meta={
          <div className="stack tight">
            <div className="row gap wrap align-center">
              <Badge tone="info">{t('Task')}: {t(selectedDataset?.task_type ?? taskType)}</Badge>
              <Badge tone={snapshotPrefilledFromLink ? 'success' : 'neutral'}>
                {t('Snapshot prefill')}: {snapshotPrefilledFromLink ? t('Ready') : t('N/A')}
              </Badge>
              <Badge
                tone={
                  runtimeSettingsError
                    ? 'danger'
                    : runtimeSettingsLoading
                      ? 'info'
                      : runtimeDisableSimulatedTrainFallback
                        ? 'success'
                        : 'warning'
                }
              >
                {t('Runtime')}: {
                  runtimeSettingsError
                    ? t('Unavailable')
                    : runtimeSettingsLoading
                      ? t('Checking...')
                      : runtimeDisableSimulatedTrainFallback
                        ? t('Guarded')
                        : t('Review')
                }
              </Badge>
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
      />

      <ProgressStepper
        steps={[t('Requirement'), t('Dataset snapshot'), t('Smart Launch')]}
        current={wizardStep}
        title={t('Launch steps')}
        caption={t('Tell the agent what to train, then confirm the snapshot.')}
      />

      {loading ? (
        <StateBlock variant="loading" title={t('Preparing')} description={t('Loading data.')} />
      ) : null}

      {snapshotPrefilledFromLink ? (
        <InlineAlert
          tone="success"
          title={t('Snapshot prefilled')}
          description={
            preferredVersionId
              ? t('Dataset and version are prefilled. Confirm to launch.')
              : t('Dataset is prefilled. Pick a version next.')
          }
        />
      ) : null}
      {preferredSourceJobId ? (
        <InlineAlert
          tone={sourceJobPrefillError ? 'warning' : sourceJobPrefillLoading ? 'info' : sourceJobPrefillJob ? 'success' : 'info'}
          title={
            sourceJobPrefillError
              ? t('Source run prefill unavailable')
              : sourceJobPrefillLoading
                ? t('Loading source run prefill...')
                : sourceJobPrefillJob
                  ? t('Source run prefilled')
                  : t('Training run prefilled')
          }
          description={
            sourceJobPrefillError
              ? t('Source run prefill failed. Continue manually or clear source context.')
              : sourceJobPrefillLoading
                ? t('Loading launch fields from source run {jobId}.', { jobId: preferredSourceJobId })
                : sourceJobPrefillJob
                  ? t('Launcher fields were prefilled from run {jobId}. You can adjust any value before launch.', {
                      jobId: sourceJobPrefillJob.id
                    })
                  : t('Use the completed run as the registration anchor.')
          }
          actions={
            <div className="row gap wrap">
              {sourceJobDetailPath ? (
                <ButtonLink to={sourceJobDetailPath} variant="ghost" size="sm">
                  {t('Open source run')}
                </ButtonLink>
              ) : null}
              <ButtonLink to={clearSourceJobPrefillPath} variant="ghost" size="sm">
                {t('Clear prefill')}
              </ButtonLink>
            </div>
          }
        />
      ) : null}
      {preferredSourceVisionTaskId ? (
        <InlineAlert
          tone={sourceVisionTaskError ? 'warning' : sourceVisionTaskLoading ? 'info' : sourceVisionTask ? 'success' : 'info'}
          title={
            sourceVisionTaskError
              ? t('Agent context unavailable')
              : sourceVisionTaskLoading
                ? t('Loading agent context...')
                : sourceVisionTask
                  ? t('Agent context active')
                  : t('Agent continuation ready')
          }
          description={
            sourceVisionTaskError
              ? t('The linked vision task could not be loaded. Launch can continue only after that context is restored.')
              : sourceVisionTaskLoading
                ? t('Loading linked vision task {taskId}.', { taskId: preferredSourceVisionTaskId })
                : sourceVisionTask
                  ? t('Training will stay linked to vision task {taskId} so Vistral can continue toward model registration.', {
                      taskId: sourceVisionTask.id
                    })
                  : t('This launch will stay attached to its agent task.')
          }
          actions={
            <div className="row gap wrap">
              {sourceVisionTaskDetailPath ? (
                <ButtonLink to={sourceVisionTaskDetailPath} variant="ghost" size="sm">
                  {t('Open vision task')}
                </ButtonLink>
              ) : null}
              <ButtonLink to={clearSourceVisionTaskPath} variant="ghost" size="sm">
                {t('Clear agent context')}
              </ButtonLink>
            </div>
          }
        />
      ) : requirementDescription.trim() ? (
        <InlineAlert
          tone="info"
          title={t('Agent continuation ready')}
          description={t('Smart Launch will keep this run attached to a vision task so Vistral can continue from training to model output.')}
        />
      ) : null}
      {preferredLaunchContextHint ? (
        <InlineAlert
          tone="info"
          title={t('Launch context adjusted')}
          description={preferredLaunchContextHint}
        />
      ) : null}
      {preferredDatasetMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested dataset not found')}
          description={t('The dataset from the incoming link is unavailable. Showing available datasets instead.')}
          actions={
            <ButtonLink to={clearRequestedLaunchContextPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}
      {preferredVersionMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested dataset version not found')}
          description={t('The requested snapshot is unavailable for the current dataset. Switched to an available version.')}
          actions={
            <ButtonLink to={clearRequestedLaunchContextPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}
      {requestedWorkerMissing ? (
        <InlineAlert
          tone="warning"
          title={t('Requested worker not found')}
          description={t('The worker from the incoming link is unavailable. Dispatch now falls back to scheduler auto mode.')}
          actions={
            <ButtonLink to={clearRequestedLaunchContextPath} variant="ghost" size="sm">
              {t('Clear context')}
            </ButtonLink>
          }
        />
      ) : null}

      {feedback ? (
        <StateBlock
          variant={feedback.variant}
          title={feedback.variant === 'success' ? t('Action Completed') : t('Action Failed')}
          description={feedback.text}
        />
      ) : null}
      <WorkspaceWorkbench
        main={
          <div className="workspace-main-stack training-launch-stack">
            <Card as="article" className="stack">
              <WorkspaceSectionHeader
                title={t('1. Requirement')}
                description={t('Describe the model goal first. Run name and recipe can be generated for you.')}
                actions={<Badge tone="neutral">{t(selectedDataset?.task_type ?? taskType)}</Badge>}
              />
              <div className="workspace-form-grid">
                <label className="workspace-form-span-2">
                  {t('Requirement')}
                  <Textarea
                    value={requirementDescription}
                    onChange={(event) => setRequirementDescription(event.target.value)}
                    rows={4}
                    placeholder={t('For example: detect vehicle defects or read a vehicle number')}
                  />
                </label>
                <label className="workspace-form-span-2">
                  {t('Run Name')}
                  <Input
                    ref={jobNameInputRef}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('Optional. Smart Launch can generate one automatically.')}
                  />
                </label>
              </div>
              <div className="row gap wrap align-center">
                <Button type="button" size="sm" variant="secondary" onClick={createTaskDraft} disabled={drafting || loading}>
                  {drafting ? t('Generating...') : t('Preview agent plan')}
                </Button>
                <small className="muted">
                  {taskDraft
                    ? t('The inferred plan is shown below and will be reused during Smart Launch.')
                    : t('If you skip the requirement text, launch will follow the selected dataset defaults.')}
                </small>
              </div>
              <Panel className="stack tight" tone="soft">
                <div className="row gap wrap align-center">
                  <Badge tone="info">{t('Task')}: {t(selectedDataset?.task_type ?? taskDraft?.task_type ?? taskType)}</Badge>
                  <Badge tone="neutral">{t('Framework')}: {t(taskDraft?.recommended_framework ?? framework)}</Badge>
                  <Badge tone="neutral">{t('Base Model')}: {baseModel.trim() || baseModelOptions[0] || `${framework}-base`}</Badge>
                </div>
                {taskDraft ? (
                  <small className="muted">{taskDraft.rationale}</small>
                ) : (
                  <small className="muted">
                    {t('Smart Launch will infer task type, framework, and baseline params from your dataset scope and requirement.')}
                  </small>
                )}
              </Panel>
              <AdvancedSection
                title={t('Expert overrides')}
                description={t('Only open this when the agent defaults are wrong.')}
              >
                <div className="workspace-form-grid">
                  <label>
                    {t('Task Type')}
                    <Select
                      value={taskType}
                      onChange={(event) =>
                        setTaskType(
                          event.target.value as 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb'
                        )
                      }
                    >
                      {taskTypeOptions.map((option) => (
                        <option key={option} value={option}>
                          {t(option)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    {t('Framework')}
                    <Select
                      value={framework}
                      onChange={(event) => setFramework(event.target.value as 'paddleocr' | 'doctr' | 'yolo')}
                    >
                      {taskFrameworkOptions.map((option) => (
                        <option key={option} value={option}>
                          {t(option)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="workspace-form-span-2">
                    {t('Base Model')}
                    <Select value={baseModel} onChange={(event) => setBaseModel(event.target.value)}>
                      {baseModelOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
              </AdvancedSection>
            </Card>

            <Card as="article" className="stack">
              <WorkspaceSectionHeader
                title={t('2. Dataset snapshot')}
                description={t('Choose one reproducible snapshot. Smart Launch can prepare it when the data is close but not fully ready.')}
                actions={
                  selectedDatasetVersion ? (
                    <StatusTag status={launchReady ? 'ready' : 'draft'}>
                      {launchReady ? t('Ready') : t('Review')}
                    </StatusTag>
                  ) : null
                }
              />
              {datasets.length === 0 ? (
                <StateBlock
                  variant="empty"
                  title={t('No dataset yet')}
                  description={t('Create a dataset first, or let Smart Launch bootstrap one from sample files.')}
                  extra={
                    <div className="row gap wrap">
                      <ButtonLink to={datasetsPath} variant="secondary" size="sm">
                        {t('Open Datasets')}
                      </ButtonLink>
                    </div>
                  }
                />
              ) : null}
              <div className="workspace-form-grid">
                <label className="workspace-form-span-2">
                  {t('Dataset')}
                  <Select ref={datasetSelectRef} value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                    <option value="">{t('Pick a dataset')}</option>
                    {datasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name} · {t(dataset.task_type)} · {t(dataset.status)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {t('Dataset Version')}
                  <Select
                    ref={datasetVersionSelectRef}
                    value={datasetVersionId}
                    onChange={(event) => setDatasetVersionId(event.target.value)}
                    disabled={!selectedDataset || versionsLoading || datasetVersions.length === 0}
                  >
                    <option value="">
                      {versionsLoading ? t('Loading versions...') : t('Pick a version')}
                    </option>
                    {datasetVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.version_name} · {t('train')} {version.split_summary.train} ·{' '}
                        {formatCoveragePercent(version.annotation_coverage)}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <div className="row gap wrap align-center">
                <label className="row gap wrap align-center">
                  <input
                    type="checkbox"
                    className="ui-checkbox"
                    checked={autoPrepareSnapshot}
                    onChange={(event) => setAutoPrepareSnapshot(event.target.checked)}
                  />
                  <span>{t('Auto-prepare snapshot before launch')}</span>
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void autoPrepareTrainingSnapshot();
                  }}
                  disabled={preparingSnapshot || !selectedDataset || versionsLoading || loading}
                >
                  {preparingSnapshot ? t('Preparing...') : t('Prepare snapshot now')}
                </Button>
              </div>
              {snapshotPreparationNote ? (
                <small className="muted">{snapshotPreparationNote}</small>
              ) : null}
              <AdvancedSection
                title={t('No dataset yet? Bootstrap from samples')}
                description={t('Optional. Smart Launch can create a dataset first, then continue the training plan.')}
              >
                <Panel className="stack tight" tone="soft">
                  <div className="row gap wrap align-center">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => bootstrapSampleFileInputRef.current?.click()}
                      disabled={submitting || preparingSnapshot || creatingDatasetFromSamples}
                    >
                      {t('Upload sample files')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearBootstrapSampleFiles}
                      disabled={
                        bootstrapSampleFiles.length === 0 || submitting || preparingSnapshot || creatingDatasetFromSamples
                      }
                    >
                      {t('Clear files')}
                    </Button>
                    <span className="muted">
                      {t('{count} local sample file(s) queued', { count: bootstrapSampleFiles.length })}
                    </span>
                  </div>
                  <HiddenFileInput
                    ref={bootstrapSampleFileInputRef}
                    multiple
                    onChange={handleBootstrapSampleFileInput}
                    disabled={submitting || preparingSnapshot || creatingDatasetFromSamples}
                  />
                  <div
                    className={`training-bootstrap-dropzone${bootstrapDropActive ? ' is-active' : ''}`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';
                      if (!bootstrapDropActive) {
                        setBootstrapDropActive(true);
                      }
                    }}
                    onDragLeave={() => setBootstrapDropActive(false)}
                    onDrop={handleBootstrapDrop}
                  >
                    <strong>{t('Drag and drop sample files here')}</strong>
                    <small className="muted">
                      {t('BMP and common image/document files are supported. Keep each file under {limit}.', {
                        limit: UPLOAD_SOFT_LIMIT_LABEL
                      })}
                    </small>
                  </div>
                  {bootstrapSampleFiles.length > 0 ? (
                    <ul className="workspace-record-list compact">
                      {bootstrapSampleFiles.map((file) => {
                        const fileKey = buildBootstrapSampleFileKey(file);
                        return (
                          <Panel key={fileKey} as="li" className="workspace-record-item stack tight" tone="soft">
                            <div className="row between gap wrap align-center">
                              <small>{file.name}</small>
                              <div className="row gap">
                                <Badge tone="neutral">{formatByteSize(file.size)}</Badge>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeBootstrapSampleFile(fileKey)}
                                >
                                  {t('Delete')}
                                </Button>
                              </div>
                            </div>
                          </Panel>
                        );
                      })}
                    </ul>
                  ) : (
                    <small className="muted">{t('No local sample files queued yet.')}</small>
                  )}
                  <label>
                    {t('Sample filenames for Smart Launch')}
                    <Textarea
                      value={bootstrapSampleFilenames}
                      onChange={(event) => setBootstrapSampleFilenames(event.target.value)}
                      rows={3}
                      placeholder={t('One filename per line, e.g. wagon_001.jpg')}
                    />
                  </label>
                  <small className="muted">
                    {t(
                      'When no dataset is selected, Smart Launch can auto-create dataset from local files and filenames, then continue training setup.'
                    )}
                  </small>
                </Panel>
              </AdvancedSection>
              {selectedDatasetVersion ? (
                <Panel className="stack tight" tone="soft">
                  <div className="row gap wrap align-center">
                    <Badge tone="neutral">{selectedDataset?.name ?? t('Dataset')}</Badge>
                    <Badge tone="info">{selectedDatasetVersion.version_name}</Badge>
                    <Badge tone={datasetVersionHasTrainSplit ? 'success' : 'warning'}>
                      {t('Train')}: {selectedDatasetVersion.split_summary.train}
                    </Badge>
                    <Badge tone={datasetVersionHasAnnotationCoverage ? 'success' : 'warning'}>
                      {t('Coverage')}: {formatCoveragePercent(selectedDatasetVersion.annotation_coverage)}
                    </Badge>
                  </div>
                  <small className="muted">{t('Launch uses only this snapshot.')}</small>
                </Panel>
              ) : (
                <StateBlock
                  variant="empty"
                  title={t('No dataset version')}
                  description={t('Create or pick a snapshot before launch.')}
                />
              )}
              {selectedDataset && datasetVersions.length === 0 && !versionsLoading ? (
                <StateBlock
                  variant="empty"
                  title={t('No dataset version')}
                  description={t('Create a dataset version snapshot first.')}
                  extra={
                    <ButtonLink to={selectedDatasetDetailPath} variant="secondary" size="sm">
                      {t('Open Detail')}
                    </ButtonLink>
                  }
                />
              ) : null}
            </Card>

            <Card as="article" className="stack">
              <WorkspaceSectionHeader
                title={t('3. Launch plan')}
                description={t('Review the auto-composed plan. Expert controls stay collapsed unless you really need them.')}
                actions={
                  <div className="row gap wrap align-center">
                    <Badge tone={blockedLaunchCheckpoints.length === 0 ? 'success' : 'warning'}>
                      {blockedLaunchCheckpoints.length === 0 ? t('Ready') : t('Needs review')}
                    </Badge>
                    <Button type="button" size="sm" variant="ghost" onClick={applyRecommendedParams}>
                      {t('Use recommended params')}
                    </Button>
                  </div>
                }
              />
              <div className="workspace-keyline-list">
                <div className="workspace-keyline-item">
                  <span>{t('Task Type')}</span>
                  <strong>{t(selectedDataset?.task_type ?? taskDraft?.task_type ?? taskType)}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Framework')}</span>
                  <strong>{t(taskDraft?.recommended_framework ?? framework)}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Base Model')}</span>
                  <strong>{baseModel.trim() || baseModelOptions[0] || `${framework}-base`}</strong>
                </div>
                <div className="workspace-keyline-item">
                  <span>{t('Dispatch')}</span>
                  <strong>{dispatchPreference === 'auto' ? t('Auto') : dispatchPreference === 'control_plane' ? t('Control-plane') : t('Worker')}</strong>
                </div>
              </div>
              {!paramsReady ? (
                <InlineAlert
                  tone="warning"
                  title={t('Params need attention')}
                  description={paramValidationIssues.join(' ')}
                />
              ) : (
                <small className="muted">{t('Core params checked.')}</small>
              )}
              <Panel className="stack tight" tone="soft">
                <div className="row gap wrap align-center">
                  <Badge tone={preferredSourceVisionTaskId ? 'success' : requirementDescription.trim() ? 'info' : 'neutral'}>
                    {t('Agent lane')}: {preferredSourceVisionTaskId ? t('Linked') : requirementDescription.trim() ? t('Will create') : t('Standalone')}
                  </Badge>
                  {sourceVisionTask ? <Badge tone="neutral">{sourceVisionTask.id}</Badge> : null}
                </div>
                <small className="muted">
                  {preferredSourceVisionTaskId
                    ? t('This launch will reuse the linked vision task so post-training actions stay in one agent lane.')
                    : requirementDescription.trim()
                      ? t('Smart Launch will create an agent continuation task before submit so the run can keep flowing toward model registration.')
                      : t('Without a goal description, this run launches as a standalone training job.')}
                </small>
              </Panel>
              <div className="row gap wrap">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void submit({ autoFill: true });
                  }}
                  disabled={
                    submitting ||
                    sourceVisionTaskLoading ||
                    agentTaskPreparing ||
                    creatingDatasetFromSamples ||
                    preparingSnapshot ||
                    loading ||
                    versionsLoading ||
                    !submitReady
                  }
                >
                  {submitting || creatingDatasetFromSamples || preparingSnapshot
                    ? t('Launching...')
                    : sourceVisionTaskLoading || agentTaskPreparing
                      ? t('Preparing agent...')
                      : t('Smart Launch')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void submit();
                  }}
                  disabled={
                    submitting ||
                    sourceVisionTaskLoading ||
                    agentTaskPreparing ||
                    creatingDatasetFromSamples ||
                    preparingSnapshot ||
                    loading ||
                    versionsLoading ||
                    !submitReady
                  }
                >
                  {t('Use manual launch')}
                </Button>
              </div>
              <AdvancedSection
                title={t('Expert controls')}
                description={t('Manual overrides for params, dispatch, runtime guard, and worker routing.')}
              >
                <div className="three-col">
                  <label>
                    {t('Epochs')}
                    <Input
                      ref={paramsEpochsInputRef}
                      value={epochs}
                      inputMode="numeric"
                      onChange={(event) => setEpochs(event.target.value)}
                    />
                  </label>
                  <label>
                    {t('Batch Size')}
                    <Input value={batchSize} inputMode="numeric" onChange={(event) => setBatchSize(event.target.value)} />
                  </label>
                  <label>
                    {t('Learning Rate')}
                    <Input
                      value={learningRate}
                      inputMode="decimal"
                      onChange={(event) => setLearningRate(event.target.value)}
                    />
                  </label>
                  <label>
                    {t('Warmup Ratio')}
                    <Input
                      value={warmupRatio}
                      inputMode="decimal"
                      onChange={(event) => setWarmupRatio(event.target.value)}
                    />
                  </label>
                  <label>
                    {t('Weight Decay')}
                    <Input
                      value={weightDecay}
                      inputMode="decimal"
                      onChange={(event) => setWeightDecay(event.target.value)}
                    />
                  </label>
                  <label className="workspace-form-span-2">
                    {t('Dispatch target')}
                    <Select
                      value={dispatchPreference}
                      onChange={(event) =>
                        setDispatchPreference(event.target.value as 'auto' | 'control_plane' | 'worker')
                      }
                    >
                      <option value="auto">{t('Auto (scheduler decides)')}</option>
                      <option value="control_plane">{t('Force control-plane')}</option>
                      <option value="worker">{t('Prefer worker dispatch')}</option>
                    </Select>
                  </label>
                  {dispatchPreference === 'worker' ? (
                    <label className="workspace-form-span-2">
                      {t('Worker preference (optional)')}
                      <Select
                        value={selectedWorkerId}
                        onChange={(event) => setSelectedWorkerId(event.target.value)}
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
                <small className="muted">{dispatchSummary}</small>
                <div className="row gap wrap">
                  <ButtonLink to={runtimeReadinessPath} variant="secondary" size="sm">
                    {t('Open Runtime Settings')}
                  </ButtonLink>
                  <ButtonLink
                    to={dispatchPreference === 'worker' && onlineWorkers.length === 0 ? workerPairingPath : workerInventoryPath}
                    variant="ghost"
                    size="sm"
                  >
                    {t('Worker Settings')}
                  </ButtonLink>
                </div>
                {nextLaunchCheckpoint?.key === 'runtime' &&
                !runtimeSettingsLoading &&
                !runtimeSettingsError &&
                !runtimeDisableSimulatedTrainFallback ? (
                  <label className="row gap wrap align-center">
                    <input
                      type="checkbox"
                      className="ui-checkbox"
                      checked={nonStrictLaunchConfirmed}
                      onChange={(event) => setNonStrictLaunchConfirmed(event.target.checked)}
                    />
                    <span>{t('Confirm risk')}</span>
                  </label>
                ) : null}
                {workersLoading ? <small className="muted">{t('Loading worker inventory...')}</small> : null}
                {workersAccessDenied ? (
                  <small className="muted">{t('Worker inventory is restricted to admins.')}</small>
                ) : null}
                {!workersAccessDenied && workersError ? <small className="muted">{workersError}</small> : null}
                {dispatchPreference === 'worker' && !workersLoading && !workersAccessDenied && onlineWorkers.length === 0 ? (
                  <InlineAlert
                    tone="warning"
                    title={t('No online worker')}
                    description={t('Worker dispatch may fail if no eligible online worker is available.')}
                  />
                ) : null}
              </AdvancedSection>
            </Card>

          </div>
        }
        side={
          <div className="workspace-inspector-rail">
            <Card as="article" className="workspace-inspector-card">
              <div className="row between gap wrap align-center">
                <h3>{t('Agent launch status')}</h3>
                <StatusTag status={blockedLaunchCheckpoints.length === 0 ? 'ready' : 'draft'}>
                  {blockedLaunchCheckpoints.length === 0 ? t('Ready') : t('Needs review')}
                </StatusTag>
              </div>
              <small className="muted">
                {launchStatusDescription}
              </small>
              {launchStatusAction ? (
                <div className="row gap wrap align-center">
                  <Button type="button" variant="secondary" size="sm" onClick={launchStatusAction.onClick}>
                    {launchStatusAction.label}
                  </Button>
                  {nextLaunchCheckpoint?.key === 'runtime' &&
                  !runtimeSettingsLoading &&
                  !runtimeSettingsError &&
                  !runtimeDisableSimulatedTrainFallback ? (
                    <label className="row gap wrap align-center">
                      <input
                        type="checkbox"
                        className="ui-checkbox"
                        checked={nonStrictLaunchConfirmed}
                        onChange={(event) => setNonStrictLaunchConfirmed(event.target.checked)}
                      />
                      <span>{t('Confirm risk')}</span>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {nextLaunchCheckpoint ? (
                <small className="muted">
                  {nextLaunchCheckpoint.label}: {nextLaunchCheckpoint.state === 'ready' ? t('Ready') : nextLaunchCheckpoint.detail}
                </small>
              ) : null}
              <details className="workspace-details">
                <summary>{t('All checks')}</summary>
                <div className="workspace-keyline-list">
                  {launchCheckpoints.map((item) => (
                    <div key={item.key} className="workspace-keyline-item">
                      <span>{item.label}</span>
                      <small>{item.state === 'ready' ? t('Ready') : item.detail}</small>
                    </div>
                  ))}
                </div>
              </details>
            </Card>

            <Card as="article" className="workspace-inspector-card">
              <div className="stack tight">
                <h3>{t('Snapshot handoff')}</h3>
                <small className="muted">
                  {!selectedDataset
                    ? t('Pick a dataset first, then use these links to fix files, versions, or closure steps without losing context.')
                    : !selectedDatasetVersion
                      ? t('Go to dataset detail to create a snapshot, or open the closure lane for guided loop work on this dataset.')
                      : launchReady
                        ? t('This snapshot is launch-ready. If you still need annotation or split work, use the links below and come back here.')
                        : t('This snapshot still needs annotation, split, or readiness work. Continue from dataset detail or the closure lane.')}
                </small>
              </div>
              <div className="row gap wrap">
                <ButtonLink to={selectedDatasetDetailPath} variant="secondary" size="sm">
                  {selectedDataset ? t('Open dataset detail') : t('Open datasets')}
                </ButtonLink>
                <ButtonLink to={selectedClosurePath} variant="ghost" size="sm">
                  {t('Open closure lane')}
                </ButtonLink>
              </div>
              {(selectedDataset || selectedDatasetVersion) ? (
                <div className="workspace-keyline-list">
                  <div className="workspace-keyline-item">
                    <span>{t('Dataset')}</span>
                    <small>{selectedDataset?.name ?? t('Not selected')}</small>
                  </div>
                  <div className="workspace-keyline-item">
                    <span>{t('Dataset Version')}</span>
                    <small>{selectedDatasetVersion?.version_name ?? t('Pick a version')}</small>
                  </div>
                </div>
              ) : null}
            </Card>
          </div>
        }
      />
    </WorkspacePage>
  );
}
