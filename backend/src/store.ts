import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth';
import { applyBundledLocalCommandDefaults, resolveBundledLocalModelPath } from './runtimeDefaults';
import {
  isCuratedFoundationModelName,
  isFixtureAttachmentFilename,
  isFixtureDatasetRecord,
  isFixtureModelRecord,
  isFixtureModelVersionRecord,
  isFixtureTrainingJobRecord
} from '../../shared/catalogFixtures';
import type {
  AnnotationRecord,
  AnnotationReviewRecord,
  ApprovalRequest,
  AuditLogRecord,
  ConversationRecord,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment,
  InferenceRunRecord,
  LlmConfig,
  MessageRecord,
  ModelRecord,
  ModelVersionRecord,
  RuntimeSettingsRecord,
  TrainingJobRecord,
  TrainingExecutionTarget,
  TrainingSchedulerDecision,
  TrainingWorkerBootstrapSessionRecord,
  TrainingWorkerNodeRecord,
  TrainingMetricRecord,
  TrainingExecutionMode,
  User
} from '../../shared/domain';

const now = () => new Date().toISOString();

const llmConfigDataFile = path.resolve(process.cwd(), '.data', 'llm-config.enc.json');
const runtimeSettingsDataFile = path.resolve(process.cwd(), '.data', 'runtime-settings.enc.json');
const appStateDataFile = path.resolve(
  process.cwd(),
  (process.env.APP_STATE_STORE_PATH ?? '.data/app-state.json').trim()
);
const appStateBootstrapMode: 'full' | 'minimal' = (() => {
  const raw = (process.env.APP_STATE_BOOTSTRAP_MODE ?? 'full').trim().toLowerCase();
  return raw === 'minimal' ? 'minimal' : 'full';
})();
const devFallbackSecret = 'vistral-dev-only-secret-change-me';

interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

interface AppStatePayload {
  users: User[];
  userPasswordHashes: Record<string, string>;
  models: ModelRecord[];
  conversations: ConversationRecord[];
  messages: MessageRecord[];
  attachments: FileAttachment[];
  datasets: DatasetRecord[];
  datasetItems: DatasetItemRecord[];
  annotations: AnnotationRecord[];
  annotationReviews: AnnotationReviewRecord[];
  datasetVersions: DatasetVersionRecord[];
  trainingJobs: TrainingJobRecord[];
  trainingWorkerNodes: TrainingWorkerNodeRecord[];
  trainingWorkerBootstrapSessions: TrainingWorkerBootstrapSessionRecord[];
  trainingWorkerAuthTokensByWorkerId: Record<string, string>;
  trainingMetrics: TrainingMetricRecord[];
  modelVersions: ModelVersionRecord[];
  inferenceRuns: InferenceRunRecord[];
  approvalRequests: ApprovalRequest[];
  auditLogs: AuditLogRecord[];
}

const normalizeRuntimeSettingField = (value: string | undefined): string =>
  (value ?? '').trim();

const parseRuntimeBoolean = (value: string | undefined, fallback = false): boolean => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const runtimeDefaultPythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
const runtimeDefaultPythonCandidates =
  process.platform === 'win32'
    ? ['C:\\opt\\vistral-venv\\Scripts\\python.exe', 'python']
    : ['/opt/vistral-venv/bin/python', '/opt/vistral-venv/bin/python3', 'python3', 'python'];

const resolveRuntimeDefaultPythonBin = (): string => {
  const fromEnv = normalizeRuntimeSettingField(process.env.VISTRAL_PYTHON_BIN ?? process.env.PYTHON_BIN);
  if (fromEnv) {
    return fromEnv;
  }

  const pathCandidate = runtimeDefaultPythonCandidates.find((candidate) => candidate.includes('/') || candidate.includes('\\'));
  const existingPathCandidate = runtimeDefaultPythonCandidates.find(
    (candidate) => (candidate.includes('/') || candidate.includes('\\')) && existsSync(candidate)
  );
  if (existingPathCandidate) {
    return existingPathCandidate;
  }
  if (pathCandidate) {
    return pathCandidate;
  }

  return runtimeDefaultPythonExecutable;
};

const buildDefaultRuntimeControlSettingsFromEnv = (): RuntimeSettingsRecord['controls'] => ({
  python_bin: resolveRuntimeDefaultPythonBin(),
  disable_simulated_train_fallback: parseRuntimeBoolean(
    process.env.VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK,
    false
  ),
  disable_inference_fallback: parseRuntimeBoolean(process.env.VISTRAL_DISABLE_INFERENCE_FALLBACK, false)
});

const buildDefaultRuntimeSettingsFromEnv = (): RuntimeSettingsRecord => ({
  updated_at: null,
  active_profile_id: null,
  frameworks: {
    paddleocr: applyBundledLocalCommandDefaults('paddleocr', {
      endpoint: normalizeRuntimeSettingField(process.env.PADDLEOCR_RUNTIME_ENDPOINT),
      api_key: normalizeRuntimeSettingField(process.env.PADDLEOCR_RUNTIME_API_KEY),
      default_model_id: '',
      default_model_version_id: '',
      model_api_keys: {},
      model_api_key_policies: {},
      local_model_path:
        normalizeRuntimeSettingField(process.env.PADDLEOCR_LOCAL_MODEL_PATH) ||
        resolveBundledLocalModelPath('paddleocr'),
      local_train_command: normalizeRuntimeSettingField(process.env.PADDLEOCR_LOCAL_TRAIN_COMMAND),
      local_predict_command: normalizeRuntimeSettingField(process.env.PADDLEOCR_LOCAL_PREDICT_COMMAND)
    }),
    doctr: applyBundledLocalCommandDefaults('doctr', {
      endpoint: normalizeRuntimeSettingField(process.env.DOCTR_RUNTIME_ENDPOINT),
      api_key: normalizeRuntimeSettingField(process.env.DOCTR_RUNTIME_API_KEY),
      default_model_id: '',
      default_model_version_id: '',
      model_api_keys: {},
      model_api_key_policies: {},
      local_model_path:
        normalizeRuntimeSettingField(process.env.DOCTR_LOCAL_MODEL_PATH) ||
        resolveBundledLocalModelPath('doctr'),
      local_train_command: normalizeRuntimeSettingField(process.env.DOCTR_LOCAL_TRAIN_COMMAND),
      local_predict_command: normalizeRuntimeSettingField(process.env.DOCTR_LOCAL_PREDICT_COMMAND)
    }),
    yolo: applyBundledLocalCommandDefaults('yolo', {
      endpoint: normalizeRuntimeSettingField(process.env.YOLO_RUNTIME_ENDPOINT),
      api_key: normalizeRuntimeSettingField(process.env.YOLO_RUNTIME_API_KEY),
      default_model_id: '',
      default_model_version_id: '',
      model_api_keys: {},
      model_api_key_policies: {},
      local_model_path:
        normalizeRuntimeSettingField(process.env.YOLO_LOCAL_MODEL_PATH) ||
        resolveBundledLocalModelPath('yolo'),
      local_train_command: normalizeRuntimeSettingField(process.env.YOLO_LOCAL_TRAIN_COMMAND),
      local_predict_command: normalizeRuntimeSettingField(process.env.YOLO_LOCAL_PREDICT_COMMAND)
    })
  },
  controls: buildDefaultRuntimeControlSettingsFromEnv()
});

const deriveKey = (): Buffer => {
  const secret = process.env.LLM_CONFIG_SECRET ?? devFallbackSecret;
  return createHash('sha256').update(secret).digest();
};

const encryptText = (plainText: string): EncryptedPayload => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
};

const decryptText = (payload: EncryptedPayload): string => {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(),
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
};

export const users: User[] = [
  {
    id: 'u-1',
    username: 'alice',
    role: 'user',
    status: 'active',
    status_reason: null,
    capabilities: ['manage_models'],
    last_login_at: null,
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'u-2',
    username: 'admin',
    role: 'admin',
    status: 'active',
    status_reason: null,
    capabilities: ['manage_models', 'global_governance'],
    last_login_at: null,
    created_at: now(),
    updated_at: now()
  }
];

export const userPasswordHashes: Record<string, string> = {
  'u-1': hashPassword(process.env.DEFAULT_USER_PASSWORD ?? 'mock-pass'),
  'u-2': hashPassword(process.env.DEFAULT_ADMIN_PASSWORD ?? 'mock-pass-admin')
};

export const models: ModelRecord[] = [
  {
    id: 'm-1',
    name: 'Road Damage Detector',
    description: 'Detects road cracks from photos.',
    model_type: 'detection',
    owner_user_id: 'u-1',
    visibility: 'workspace',
    status: 'published',
    metadata: { framework: 'yolo' },
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'm-2',
    name: 'Invoice OCR Assistant',
    description: 'Extracts invoice text and fields.',
    model_type: 'ocr',
    owner_user_id: 'u-1',
    visibility: 'workspace',
    status: 'published',
    metadata: { framework: 'paddleocr' },
    created_at: now(),
    updated_at: now()
  }
];

export const conversations: ConversationRecord[] = [];
export const messages: MessageRecord[] = [];

export const attachments: FileAttachment[] = [
  {
    id: 'f-1',
    filename: 'inspection-01.jpg',
    status: 'ready',
    owner_user_id: 'u-1',
    attached_to_type: 'Conversation',
    attached_to_id: null,
    mime_type: 'image/jpeg',
    byte_size: null,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'f-2',
    filename: 'notes.pdf',
    status: 'processing',
    owner_user_id: 'u-1',
    attached_to_type: 'Conversation',
    attached_to_id: null,
    mime_type: 'application/pdf',
    byte_size: null,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'f-3',
    filename: 'invoice-001.jpg',
    status: 'ready',
    owner_user_id: 'u-1',
    attached_to_type: 'Dataset',
    attached_to_id: 'd-1',
    mime_type: 'image/jpeg',
    byte_size: null,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'f-4',
    filename: 'defect-001.jpg',
    status: 'ready',
    owner_user_id: 'u-1',
    attached_to_type: 'Dataset',
    attached_to_id: 'd-2',
    mime_type: 'image/jpeg',
    byte_size: null,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  }
];

export const datasets: DatasetRecord[] = [
  {
    id: 'd-1',
    name: 'Invoice OCR Dataset',
    description: 'OCR training samples for invoices.',
    task_type: 'ocr',
    status: 'ready',
    owner_user_id: 'u-1',
    label_schema: {
      classes: ['text_line', 'table', 'stamp']
    },
    metadata: { source: 'internal' },
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'd-2',
    name: 'Surface Defect Dataset',
    description: 'Detection samples for scratches and dents.',
    task_type: 'detection',
    status: 'ready',
    owner_user_id: 'u-1',
    label_schema: {
      classes: ['defect', 'scratch']
    },
    metadata: { source: 'line-a' },
    created_at: now(),
    updated_at: now()
  }
];

export const datasetItems: DatasetItemRecord[] = [
  {
    id: 'di-1',
    dataset_id: 'd-1',
    attachment_id: 'f-3',
    split: 'train',
    status: 'ready',
    metadata: { page: '1' },
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'di-2',
    dataset_id: 'd-2',
    attachment_id: 'f-4',
    split: 'train',
    status: 'ready',
    metadata: { line: 'A1' },
    created_at: now(),
    updated_at: now()
  }
];

export const annotations: AnnotationRecord[] = [
  {
    id: 'ann-1',
    dataset_item_id: 'di-1',
    task_type: 'ocr',
    source: 'manual',
    status: 'approved',
    payload: {
      lines: [{ text: 'SEED_OCR_LINE_001', confidence: 0.99 }]
    },
    annotated_by: 'u-1',
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'ann-2',
    dataset_item_id: 'di-2',
    task_type: 'detection',
    source: 'manual',
    status: 'annotated',
    payload: {
      boxes: [{ x: 182, y: 204, width: 168, height: 102, label: 'defect' }]
    },
    annotated_by: 'u-1',
    created_at: now(),
    updated_at: now()
  }
];

export const annotationReviews: AnnotationReviewRecord[] = [
  {
    id: 'arv-1',
    annotation_id: 'ann-1',
    reviewer_user_id: 'u-2',
    status: 'approved',
    review_reason_code: null,
    quality_score: 0.97,
    review_comment: 'Good OCR quality.',
    created_at: now()
  }
];

export const datasetVersions: DatasetVersionRecord[] = [
  {
    id: 'dv-1',
    dataset_id: 'd-1',
    version_name: 'v1',
    split_summary: {
      train: 1,
      val: 0,
      test: 0,
      unassigned: 0
    },
    item_count: 1,
    annotation_coverage: 1,
    created_by: 'u-1',
    created_at: now()
  },
  {
    id: 'dv-2',
    dataset_id: 'd-2',
    version_name: 'v1',
    split_summary: {
      train: 1,
      val: 0,
      test: 0,
      unassigned: 0
    },
    item_count: 1,
    annotation_coverage: 1,
    created_by: 'u-1',
    created_at: now()
  }
];

export const trainingJobs: TrainingJobRecord[] = [
  {
    id: 'tj-ocr-1',
    name: 'invoice-ocr-finetune',
    task_type: 'ocr',
    framework: 'paddleocr',
    status: 'completed',
    dataset_id: 'd-1',
    dataset_version_id: 'dv-1',
    base_model: 'paddleocr-PP-OCRv4',
    config: {
      epochs: '20',
      batch_size: '16',
      learning_rate: '0.001'
    },
    execution_mode: 'simulated',
    execution_target: 'control_plane',
    scheduled_worker_id: null,
    scheduler_note: 'seed_default_local',
    scheduler_decision: null,
    scheduler_decision_history: [],
    log_excerpt: 'Training completed with stable CER improvement.',
    submitted_by: 'u-1',
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'tj-det-1',
    name: 'defect-det-finetune',
    task_type: 'detection',
    framework: 'yolo',
    status: 'running',
    dataset_id: 'd-2',
    dataset_version_id: 'dv-2',
    base_model: 'yolo11n',
    config: {
      epochs: '80',
      batch_size: '8',
      learning_rate: '0.0005'
    },
    execution_mode: 'simulated',
    execution_target: 'control_plane',
    scheduled_worker_id: null,
    scheduler_note: 'seed_default_local',
    scheduler_decision: null,
    scheduler_decision_history: [],
    log_excerpt: 'Epoch 12/80, improving recall.',
    submitted_by: 'u-1',
    created_at: now(),
    updated_at: now()
  }
];

export const trainingMetrics: TrainingMetricRecord[] = [
  {
    id: 'tm-1',
    training_job_id: 'tj-ocr-1',
    metric_name: 'accuracy',
    metric_value: 0.93,
    step: 20,
    recorded_at: now()
  },
  {
    id: 'tm-2',
    training_job_id: 'tj-ocr-1',
    metric_name: 'cer',
    metric_value: 0.08,
    step: 20,
    recorded_at: now()
  },
  {
    id: 'tm-3',
    training_job_id: 'tj-det-1',
    metric_name: 'map',
    metric_value: 0.71,
    step: 12,
    recorded_at: now()
  }
];

export const trainingWorkerNodes: TrainingWorkerNodeRecord[] = [
  {
    id: 'tw-1',
    name: 'control-plane-local',
    endpoint: null,
    status: 'online',
    enabled: true,
    max_concurrency: 1,
    last_heartbeat_at: null,
    last_reported_load: null,
    capabilities: ['framework:yolo', 'framework:paddleocr', 'framework:doctr'],
    auth_mode: 'shared',
    auth_token_preview: null,
    registration_source: 'seed',
    metadata: {
      role: 'control_plane_fallback'
    },
    created_at: now(),
    updated_at: now()
  }
];

export const trainingWorkerBootstrapSessions: TrainingWorkerBootstrapSessionRecord[] = [];
export const trainingWorkerAuthTokensByWorkerId: Record<string, string> = {};

export const modelVersions: ModelVersionRecord[] = [
  {
    id: 'mv-1',
    model_id: 'm-2',
    training_job_id: 'tj-ocr-1',
    version_name: 'ocr-v1',
    task_type: 'ocr',
    framework: 'paddleocr',
    status: 'registered',
    metrics_summary: {
      accuracy: '0.93',
      cer: '0.08',
      wer: '0.11'
    },
    artifact_attachment_id: null,
    created_by: 'u-1',
    created_at: now()
  },
  {
    id: 'mv-2',
    model_id: 'm-1',
    training_job_id: 'tj-det-1',
    version_name: 'det-v1',
    task_type: 'detection',
    framework: 'yolo',
    status: 'registered',
    metrics_summary: {
      map: '0.71',
      precision: '0.82',
      recall: '0.75'
    },
    artifact_attachment_id: null,
    created_by: 'u-1',
    created_at: now()
  }
];

export const inferenceRuns: InferenceRunRecord[] = [];

export const approvalRequests: ApprovalRequest[] = [];
export const auditLogs: AuditLogRecord[] = [];

export const llmConfigsByUser: Record<string, LlmConfig> = {};
export const runtimeSettings: RuntimeSettingsRecord = buildDefaultRuntimeSettingsFromEnv();

let appStateDirty = false;
let appStatePersistPromise: Promise<void> | null = null;

const replaceArray = <T>(target: T[], incoming: T[]): void => {
  target.splice(0, target.length, ...incoming);
};

const buildMinimalFoundationModels = (): ModelRecord[] => {
  const timestamp = now();
  return [
    {
      id: 'm-foundation-yolo',
      name: 'Road Damage Detector',
      description: 'Curated foundation model baseline for detection workflows.',
      model_type: 'detection',
      owner_user_id: 'u-1',
      visibility: 'workspace',
      status: 'published',
      metadata: { framework: 'yolo', foundation: 'true' },
      created_at: timestamp,
      updated_at: timestamp
    },
    {
      id: 'm-foundation-ocr',
      name: 'Invoice OCR Assistant',
      description: 'Curated foundation model baseline for OCR workflows.',
      model_type: 'ocr',
      owner_user_id: 'u-1',
      visibility: 'workspace',
      status: 'published',
      metadata: { framework: 'paddleocr', foundation: 'true' },
      created_at: timestamp,
      updated_at: timestamp
    }
  ];
};

const applyMinimalBootstrapState = (): void => {
  const foundationModels = models
    .filter((model) => isCuratedFoundationModelName(model.name))
    .map((model) => ({
      ...model,
      metadata: {
        ...(model.metadata ?? {}),
        foundation: 'true'
      }
    }));
  const nextModels =
    foundationModels.length > 0 ? foundationModels : buildMinimalFoundationModels();

  replaceArray(models, nextModels);
  replaceArray(conversations, []);
  replaceArray(messages, []);
  replaceArray(attachments, []);
  replaceArray(datasets, []);
  replaceArray(datasetItems, []);
  replaceArray(annotations, []);
  replaceArray(annotationReviews, []);
  replaceArray(datasetVersions, []);
  replaceArray(trainingJobs, []);
  replaceArray(trainingWorkerNodes, []);
  replaceArray(trainingWorkerBootstrapSessions, []);
  Object.keys(trainingWorkerAuthTokensByWorkerId).forEach((key) => {
    delete trainingWorkerAuthTokensByWorkerId[key];
  });
  replaceArray(trainingMetrics, []);
  replaceArray(modelVersions, []);
  replaceArray(inferenceRuns, []);
  replaceArray(approvalRequests, []);
  replaceArray(auditLogs, []);
};

const normalizeUser = (entry: User): User => {
  const status = entry.status === 'disabled' ? 'disabled' : 'active';

  return {
    ...entry,
    status,
    status_reason:
      status === 'disabled' &&
      typeof entry.status_reason === 'string' &&
      entry.status_reason.trim()
        ? entry.status_reason.trim()
        : null,
    capabilities: Array.isArray(entry.capabilities)
      ? entry.capabilities.filter(
          (capability): capability is User['capabilities'][number] =>
            capability === 'manage_models' || capability === 'global_governance'
        )
      : [],
    last_login_at:
      typeof entry.last_login_at === 'string' && entry.last_login_at.trim()
        ? entry.last_login_at
        : null
  };
};

const normalizeAttachment = (entry: FileAttachment): FileAttachment => ({
  ...entry,
  mime_type: entry.mime_type ?? null,
  byte_size: typeof entry.byte_size === 'number' ? entry.byte_size : null,
  storage_backend: entry.storage_backend ?? null,
  storage_path: entry.storage_path ?? null
});

const normalizeTrainingExecutionMode = (
  value: unknown
): TrainingExecutionMode => {
  if (value === 'simulated' || value === 'local_command' || value === 'unknown') {
    return value;
  }
  return 'unknown';
};

const normalizeTrainingExecutionTarget = (
  value: unknown
): TrainingExecutionTarget => {
  if (value === 'control_plane' || value === 'worker') {
    return value;
  }
  return 'control_plane';
};

const normalizeTrainingSchedulerDecision = (
  value: unknown
): TrainingSchedulerDecision | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = value as Partial<TrainingSchedulerDecision>;
  if (entry.policy !== 'load_aware_v1') {
    return null;
  }
  return {
    policy: 'load_aware_v1',
    trigger: typeof entry.trigger === 'string' && entry.trigger.trim() ? entry.trigger : 'unknown',
    attempt:
      typeof entry.attempt === 'number' && Number.isFinite(entry.attempt) && entry.attempt > 0
        ? Math.round(entry.attempt)
        : 1,
    execution_target: normalizeTrainingExecutionTarget(entry.execution_target),
    selected_worker_id:
      typeof entry.selected_worker_id === 'string' && entry.selected_worker_id.trim()
        ? entry.selected_worker_id
        : null,
    selected_worker_score:
      typeof entry.selected_worker_score === 'number' && Number.isFinite(entry.selected_worker_score)
        ? entry.selected_worker_score
        : null,
    selected_worker_load_component:
      typeof entry.selected_worker_load_component === 'number' &&
      Number.isFinite(entry.selected_worker_load_component)
        ? entry.selected_worker_load_component
        : null,
    selected_worker_health_penalty:
      typeof entry.selected_worker_health_penalty === 'number' &&
      Number.isFinite(entry.selected_worker_health_penalty)
        ? entry.selected_worker_health_penalty
        : null,
    selected_worker_capability_bonus:
      typeof entry.selected_worker_capability_bonus === 'number' &&
      Number.isFinite(entry.selected_worker_capability_bonus)
        ? entry.selected_worker_capability_bonus
        : null,
    selected_worker_in_flight_jobs:
      typeof entry.selected_worker_in_flight_jobs === 'number' &&
      Number.isFinite(entry.selected_worker_in_flight_jobs)
        ? Math.max(0, Math.round(entry.selected_worker_in_flight_jobs))
        : null,
    selected_worker_max_concurrency:
      typeof entry.selected_worker_max_concurrency === 'number' &&
      Number.isFinite(entry.selected_worker_max_concurrency)
        ? Math.max(1, Math.round(entry.selected_worker_max_concurrency))
        : null,
    excluded_worker_ids: Array.isArray(entry.excluded_worker_ids)
      ? entry.excluded_worker_ids
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : [],
    fallback_reason:
      typeof entry.fallback_reason === 'string' && entry.fallback_reason.trim()
        ? entry.fallback_reason
        : null,
    note: typeof entry.note === 'string' && entry.note.trim() ? entry.note : 'scheduler_note_unavailable',
    decided_at:
      typeof entry.decided_at === 'string' && entry.decided_at.trim()
        ? entry.decided_at
        : now()
  };
};

const normalizeTrainingSchedulerDecisionHistory = (
  history: unknown,
  latest: TrainingSchedulerDecision | null
): TrainingSchedulerDecision[] => {
  const normalized = Array.isArray(history)
    ? history
        .map((entry) => normalizeTrainingSchedulerDecision(entry))
        .filter((entry): entry is TrainingSchedulerDecision => Boolean(entry))
    : [];

  if (normalized.length === 0 && latest) {
    return [latest];
  }

  if (
    latest &&
    !normalized.some(
      (entry) =>
        entry.decided_at === latest.decided_at &&
        entry.trigger === latest.trigger &&
        entry.attempt === latest.attempt &&
        entry.note === latest.note
    )
  ) {
    normalized.push(latest);
  }

  return normalized
    .slice()
    .sort((left, right) => Date.parse(left.decided_at) - Date.parse(right.decided_at));
};

const normalizeTrainingJob = (entry: TrainingJobRecord): TrainingJobRecord => {
  const schedulerDecision = normalizeTrainingSchedulerDecision(entry.scheduler_decision);
  return {
    ...entry,
    execution_mode: normalizeTrainingExecutionMode(entry.execution_mode),
    execution_target: normalizeTrainingExecutionTarget(entry.execution_target),
    scheduled_worker_id:
      typeof entry.scheduled_worker_id === 'string' && entry.scheduled_worker_id.trim()
        ? entry.scheduled_worker_id
        : null,
    scheduler_note:
      typeof entry.scheduler_note === 'string' && entry.scheduler_note.trim()
        ? entry.scheduler_note
        : null,
    scheduler_decision: schedulerDecision,
    scheduler_decision_history: normalizeTrainingSchedulerDecisionHistory(
      entry.scheduler_decision_history,
      schedulerDecision
    )
  };
};

const normalizeTrainingWorkerNode = (
  entry: TrainingWorkerNodeRecord
): TrainingWorkerNodeRecord => {
  const status: TrainingWorkerNodeRecord['status'] =
    entry.status === 'online' || entry.status === 'draining' ? entry.status : 'offline';
  const maxConcurrencyRaw = Number(entry.max_concurrency);
  const maxConcurrency = Number.isFinite(maxConcurrencyRaw)
    ? Math.min(64, Math.max(1, Math.round(maxConcurrencyRaw)))
    : 1;
  const normalizedLoad =
    typeof entry.last_reported_load === 'number' && Number.isFinite(entry.last_reported_load)
      ? Math.max(0, Math.min(1, entry.last_reported_load))
      : null;

  return {
    ...entry,
    name: (entry.name ?? '').trim() || 'worker-node',
    endpoint:
      typeof entry.endpoint === 'string' && entry.endpoint.trim() ? entry.endpoint.trim() : null,
    status,
    enabled: Boolean(entry.enabled),
    max_concurrency: maxConcurrency,
    last_heartbeat_at:
      typeof entry.last_heartbeat_at === 'string' && entry.last_heartbeat_at.trim()
        ? entry.last_heartbeat_at
        : null,
    last_reported_load: normalizedLoad,
    capabilities: Array.isArray(entry.capabilities)
      ? entry.capabilities
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())
      : [],
    auth_mode: entry.auth_mode === 'dedicated' ? 'dedicated' : 'shared',
    auth_token_preview:
      typeof entry.auth_token_preview === 'string' && entry.auth_token_preview.trim()
        ? entry.auth_token_preview.trim()
        : null,
    metadata:
      entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
        ? Object.fromEntries(
            Object.entries(entry.metadata).map(([key, value]) => [String(key), String(value)])
          )
        : {},
    registration_source:
      entry.registration_source === 'admin' || entry.registration_source === 'heartbeat'
        ? entry.registration_source
        : 'seed'
  };
};

const normalizeTrainingWorkerBootstrapSession = (
  entry: TrainingWorkerBootstrapSessionRecord
): TrainingWorkerBootstrapSessionRecord => {
  const status = (
    entry.status === 'pairing' ||
    entry.status === 'validation_failed' ||
    entry.status === 'awaiting_confirmation' ||
    entry.status === 'online' ||
    entry.status === 'expired'
      ? entry.status
      : 'bootstrap_created'
  );
  const deploymentMode = entry.deployment_mode === 'script' ? 'script' : 'docker';
  const workerProfile =
    entry.worker_profile === 'paddleocr' ||
    entry.worker_profile === 'doctr' ||
    entry.worker_profile === 'mixed'
      ? entry.worker_profile
      : 'yolo';
  const maxConcurrencyRaw = Number(entry.max_concurrency);
  const maxConcurrency = Number.isFinite(maxConcurrencyRaw)
    ? Math.min(64, Math.max(1, Math.round(maxConcurrencyRaw)))
    : 1;
  const workerBindPortRaw = Number((entry as { worker_bind_port?: unknown }).worker_bind_port);
  const workerBindPort = Number.isFinite(workerBindPortRaw)
    ? Math.min(65535, Math.max(1, Math.round(workerBindPortRaw)))
    : 9090;
  const compatibility = (
    entry.compatibility &&
    typeof entry.compatibility === 'object' &&
    !Array.isArray(entry.compatibility)
      ? entry.compatibility
      : null
  ) as TrainingWorkerBootstrapSessionRecord['compatibility'];
  const compatibilityStatus = compatibility?.status;
  const normalizedCompatibilityStatus =
    compatibilityStatus === 'compatible' ||
    compatibilityStatus === 'warning' ||
    compatibilityStatus === 'incompatible'
      ? compatibilityStatus
      : 'unknown';

  return {
    ...entry,
    status,
    deployment_mode: deploymentMode,
    worker_profile: workerProfile,
    pairing_token: typeof entry.pairing_token === 'string' ? entry.pairing_token.trim() : '',
    token_preview: typeof entry.token_preview === 'string' ? entry.token_preview.trim() : '',
    control_plane_base_url:
      typeof entry.control_plane_base_url === 'string' ? entry.control_plane_base_url.trim() : '',
    worker_id: typeof entry.worker_id === 'string' ? entry.worker_id.trim() : '',
    worker_name: typeof entry.worker_name === 'string' ? entry.worker_name.trim() || 'worker-node' : 'worker-node',
    worker_public_host:
      typeof (entry as { worker_public_host?: unknown }).worker_public_host === 'string' &&
      (entry as { worker_public_host?: string }).worker_public_host?.trim()
        ? (entry as { worker_public_host: string }).worker_public_host.trim()
        : null,
    worker_bind_port: workerBindPort,
    worker_endpoint_hint:
      typeof entry.worker_endpoint_hint === 'string' && entry.worker_endpoint_hint.trim()
        ? entry.worker_endpoint_hint.trim()
        : null,
    worker_runtime_profile:
      typeof entry.worker_runtime_profile === 'string' && entry.worker_runtime_profile.trim()
        ? entry.worker_runtime_profile.trim()
        : 'base',
    capabilities: Array.isArray(entry.capabilities)
      ? entry.capabilities
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())
      : [],
    max_concurrency: maxConcurrency,
    issued_auth_mode: entry.issued_auth_mode === 'shared' ? 'shared' : 'dedicated',
    issued_auth_token_preview:
      typeof entry.issued_auth_token_preview === 'string' && entry.issued_auth_token_preview.trim()
        ? entry.issued_auth_token_preview.trim()
        : null,
    docker_command: typeof entry.docker_command === 'string' ? entry.docker_command : '',
    script_command: typeof entry.script_command === 'string' ? entry.script_command : '',
    setup_url_hint:
      typeof entry.setup_url_hint === 'string' && entry.setup_url_hint.trim()
        ? entry.setup_url_hint.trim()
        : 'http://<worker-host>:9090/setup',
    claimed_at:
      typeof entry.claimed_at === 'string' && entry.claimed_at.trim() ? entry.claimed_at : null,
    last_seen_at:
      typeof entry.last_seen_at === 'string' && entry.last_seen_at.trim() ? entry.last_seen_at : null,
    callback_checked_at:
      typeof entry.callback_checked_at === 'string' && entry.callback_checked_at.trim()
        ? entry.callback_checked_at
        : null,
    callback_validation_message:
      typeof entry.callback_validation_message === 'string' && entry.callback_validation_message.trim()
        ? entry.callback_validation_message.trim()
        : null,
    compatibility: compatibility
      ? {
          status: normalizedCompatibilityStatus,
          message:
            typeof compatibility.message === 'string' && compatibility.message.trim()
              ? compatibility.message.trim()
              : 'Compatibility check is not available.',
          expected_runtime_profile:
            typeof compatibility.expected_runtime_profile === 'string' &&
            compatibility.expected_runtime_profile.trim()
              ? compatibility.expected_runtime_profile.trim()
              : null,
          reported_runtime_profile:
            typeof compatibility.reported_runtime_profile === 'string' &&
            compatibility.reported_runtime_profile.trim()
              ? compatibility.reported_runtime_profile.trim()
              : null,
          reported_worker_version:
            typeof compatibility.reported_worker_version === 'string' &&
            compatibility.reported_worker_version.trim()
              ? compatibility.reported_worker_version.trim()
              : null,
          reported_contract_version:
            typeof compatibility.reported_contract_version === 'string' &&
            compatibility.reported_contract_version.trim()
              ? compatibility.reported_contract_version.trim()
              : null,
          missing_capabilities: Array.isArray(compatibility.missing_capabilities)
            ? compatibility.missing_capabilities
                .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                .map((value) => value.trim())
            : []
        }
      : {
          status: 'unknown',
          message: 'Compatibility check has not run yet.',
          expected_runtime_profile:
            typeof entry.worker_runtime_profile === 'string' && entry.worker_runtime_profile.trim()
              ? entry.worker_runtime_profile.trim()
              : null,
          reported_runtime_profile: null,
          reported_worker_version: null,
          reported_contract_version: null,
          missing_capabilities: []
        },
    linked_worker_id:
      typeof entry.linked_worker_id === 'string' && entry.linked_worker_id.trim()
        ? entry.linked_worker_id.trim()
        : null,
    metadata:
      entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
        ? Object.fromEntries(
            Object.entries(entry.metadata).map(([key, value]) => [String(key), String(value)])
          )
        : {},
    created_at: typeof entry.created_at === 'string' ? entry.created_at : now(),
    expires_at: typeof entry.expires_at === 'string' ? entry.expires_at : now()
  };
};

const sourceHasFallbackMarker = (value: string): boolean => /(fallback|template|mock|base_empty)/i.test(value);

const parseBooleanLikeRuntimeFlag = (value: unknown): boolean => {
  if (value === true) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
};

const hasInferenceFallbackEvidence = (rawOutput: Record<string, unknown>): boolean => {
  const directCandidates = [rawOutput.runtime_fallback_reason, rawOutput.local_command_fallback_reason];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return true;
    }
  }

  const rawMeta =
    rawOutput.meta && typeof rawOutput.meta === 'object' && !Array.isArray(rawOutput.meta)
      ? (rawOutput.meta as Record<string, unknown>)
      : null;
  if (typeof rawMeta?.fallback_reason === 'string' && rawMeta.fallback_reason.trim()) {
    return true;
  }
  if (typeof rawMeta?.mode === 'string' && rawMeta.mode.trim().toLowerCase() === 'template') {
    return true;
  }
  return parseBooleanLikeRuntimeFlag(rawOutput.local_command_template_mode);
};

const normalizeInferenceRun = (entry: InferenceRunRecord): InferenceRunRecord => {
  const executionSource =
    typeof entry.execution_source === 'string' && entry.execution_source.trim()
      ? entry.execution_source.trim()
      : '';
  const normalizedSource =
    typeof entry.normalized_output?.normalized_output?.source === 'string' &&
    entry.normalized_output.normalized_output.source.trim()
      ? entry.normalized_output.normalized_output.source.trim()
      : '';
  const baseSource = executionSource || normalizedSource || 'unknown';
  const rawOutput =
    entry.raw_output && typeof entry.raw_output === 'object' && !Array.isArray(entry.raw_output)
      ? (entry.raw_output as Record<string, unknown>)
      : {};
  const nextSource =
    !sourceHasFallbackMarker(baseSource) && hasInferenceFallbackEvidence(rawOutput)
      ? baseSource === 'unknown'
        ? 'explicit_fallback_detected'
        : `${baseSource}_fallback`
      : baseSource;
  return {
    ...entry,
    execution_source: nextSource
  };
};

const normalizeAnnotationReview = (entry: AnnotationReviewRecord): AnnotationReviewRecord => ({
  ...entry,
  review_reason_code:
    typeof entry.review_reason_code === 'string' && entry.review_reason_code.trim()
      ? entry.review_reason_code
      : null
});

const promoteDatasetsWithReadyItems = (
  sourceDatasets: DatasetRecord[],
  sourceDatasetItems: DatasetItemRecord[]
): { datasets: DatasetRecord[]; changed: boolean } => {
  const readyDatasetIds = new Set(
    sourceDatasetItems
      .filter((item) => item.status === 'ready')
      .map((item) => item.dataset_id)
  );

  let changed = false;
  const normalizedDatasets: DatasetRecord[] = sourceDatasets.map(
    (dataset): DatasetRecord => {
      if (dataset.status !== 'draft' || !readyDatasetIds.has(dataset.id)) {
        return dataset;
      }

      changed = true;
      return {
        ...dataset,
        status: 'ready',
        updated_at: now()
      };
    }
  );

  return { datasets: normalizedDatasets, changed };
};

const sanitizeAppStatePayload = (
  payload: Partial<AppStatePayload>
): { payload: Partial<AppStatePayload>; changed: boolean } => {
  const sourceUsers = Array.isArray(payload.users) ? payload.users : [];
  const sourceModels = Array.isArray(payload.models) ? payload.models : [];
  const sourceDatasets = Array.isArray(payload.datasets) ? payload.datasets : [];
  const sourceDatasetVersions = Array.isArray(payload.datasetVersions) ? payload.datasetVersions : [];
  const sourceTrainingJobs = Array.isArray(payload.trainingJobs)
    ? payload.trainingJobs.map(normalizeTrainingJob)
    : [];
  const sourceTrainingWorkerNodes = Array.isArray(payload.trainingWorkerNodes)
    ? payload.trainingWorkerNodes.map(normalizeTrainingWorkerNode)
    : [];
  const sourceTrainingWorkerBootstrapSessions = Array.isArray(payload.trainingWorkerBootstrapSessions)
    ? payload.trainingWorkerBootstrapSessions.map(normalizeTrainingWorkerBootstrapSession)
    : [];
  const sourceTrainingWorkerAuthTokensByWorkerId =
    payload.trainingWorkerAuthTokensByWorkerId &&
    typeof payload.trainingWorkerAuthTokensByWorkerId === 'object' &&
    !Array.isArray(payload.trainingWorkerAuthTokensByWorkerId)
      ? Object.fromEntries(
          Object.entries(payload.trainingWorkerAuthTokensByWorkerId)
            .filter(
              ([key, value]) =>
                typeof key === 'string' &&
                key.trim().length > 0 &&
                typeof value === 'string' &&
                value.trim().length > 0
            )
            .map(([key, value]) => [key.trim(), value.trim()])
        )
      : {};
  const keptTrainingWorkerIds = new Set(sourceTrainingWorkerNodes.map((worker) => worker.id));
  const sourceModelVersions = Array.isArray(payload.modelVersions) ? payload.modelVersions : [];
  const sourceConversations = Array.isArray(payload.conversations) ? payload.conversations : [];
  const sourceInferenceRuns = Array.isArray(payload.inferenceRuns) ? payload.inferenceRuns : [];
  const sourceAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const sourceDatasetItems = Array.isArray(payload.datasetItems) ? payload.datasetItems : [];
  const sourceAnnotations = Array.isArray(payload.annotations) ? payload.annotations : [];
  const sourceAnnotationReviews = Array.isArray(payload.annotationReviews)
    ? payload.annotationReviews.map(normalizeAnnotationReview)
    : [];
  const sourceMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const sourceApprovalRequests = Array.isArray(payload.approvalRequests)
    ? payload.approvalRequests
    : [];
  const sourceTrainingMetrics = Array.isArray(payload.trainingMetrics) ? payload.trainingMetrics : [];
  const sourceAuditLogs = Array.isArray(payload.auditLogs) ? payload.auditLogs : [];
  const datasetStatusReconciled = promoteDatasetsWithReadyItems(sourceDatasets, sourceDatasetItems);
  const normalizedDatasets = datasetStatusReconciled.datasets;
  const normalizedUsers = sourceUsers.map(normalizeUser);

  const keptModels = sourceModels.filter((model) => !isFixtureModelRecord(model));
  const keptModelIds = new Set(keptModels.map((model) => model.id));

  const keptDatasets = normalizedDatasets.filter((dataset) => !isFixtureDatasetRecord(dataset));
  const keptDatasetIds = new Set(keptDatasets.map((dataset) => dataset.id));

  const keptDatasetVersions = sourceDatasetVersions.filter((version) =>
    keptDatasetIds.has(version.dataset_id)
  );
  const keptDatasetVersionIds = new Set(keptDatasetVersions.map((version) => version.id));

  const keptTrainingJobs = sourceTrainingJobs.filter(
    (job) =>
      !isFixtureTrainingJobRecord(job) &&
      keptDatasetIds.has(job.dataset_id) &&
      (!job.dataset_version_id || keptDatasetVersionIds.has(job.dataset_version_id))
  );
  const keptTrainingJobIds = new Set(keptTrainingJobs.map((job) => job.id));

  const keptModelVersions = sourceModelVersions.filter(
    (version) =>
      !isFixtureModelVersionRecord(version) &&
      keptModelIds.has(version.model_id) &&
      (!version.training_job_id || keptTrainingJobIds.has(version.training_job_id))
  );
  const keptModelVersionIds = new Set(keptModelVersions.map((version) => version.id));
  const referencedArtifactAttachmentIds = new Set(
    keptModelVersions
      .map((version) => version.artifact_attachment_id)
      .filter((attachmentId): attachmentId is string => Boolean(attachmentId))
  );

  const keptConversations = sourceConversations.filter((conversation) =>
    keptModelIds.has(conversation.model_id)
  );
  const keptConversationIds = new Set(keptConversations.map((conversation) => conversation.id));

  const baseAttachments = sourceAttachments.filter((attachment) => {
    if (referencedArtifactAttachmentIds.has(attachment.id)) {
      return true;
    }

    if (isFixtureAttachmentFilename(attachment.filename)) {
      return false;
    }

    if (attachment.attached_to_type === 'Model') {
      return Boolean(attachment.attached_to_id && keptModelIds.has(attachment.attached_to_id));
    }

    if (attachment.attached_to_type === 'Dataset') {
      return !attachment.attached_to_id || keptDatasetIds.has(attachment.attached_to_id);
    }

    if (attachment.attached_to_type === 'Conversation') {
      return !attachment.attached_to_id || keptConversationIds.has(attachment.attached_to_id);
    }

    return true;
  });
  const baseAttachmentIds = new Set(baseAttachments.map((attachment) => attachment.id));

  const keptInferenceRuns = sourceInferenceRuns.filter(
    (run) =>
      keptModelVersionIds.has(run.model_version_id) && baseAttachmentIds.has(run.input_attachment_id)
  );
  const keptInferenceRunIds = new Set(keptInferenceRuns.map((run) => run.id));

  const keptAttachments = baseAttachments.filter((attachment) => {
    if (attachment.attached_to_type === 'InferenceRun') {
      return !attachment.attached_to_id || keptInferenceRunIds.has(attachment.attached_to_id);
    }

    return true;
  });
  const keptAttachmentIds = new Set(keptAttachments.map((attachment) => attachment.id));
  const normalizedModelVersions = keptModelVersions.map((version) => ({
    ...version,
    artifact_attachment_id:
      version.artifact_attachment_id && keptAttachmentIds.has(version.artifact_attachment_id)
        ? version.artifact_attachment_id
        : null
  }));

  const keptDatasetItems = sourceDatasetItems.filter(
    (item) => keptDatasetIds.has(item.dataset_id) && keptAttachmentIds.has(item.attachment_id)
  );
  const keptDatasetItemIds = new Set(keptDatasetItems.map((item) => item.id));

  const keptAnnotations = sourceAnnotations.filter((annotation) =>
    keptDatasetItemIds.has(annotation.dataset_item_id)
  );
  const keptAnnotationIds = new Set(keptAnnotations.map((annotation) => annotation.id));

  const keptAnnotationReviews = sourceAnnotationReviews.filter((review) =>
    keptAnnotationIds.has(review.annotation_id)
  );

  const keptMessages = sourceMessages
    .filter((message) => keptConversationIds.has(message.conversation_id))
    .map((message) => ({
      ...message,
      attachment_ids: message.attachment_ids.filter((attachmentId) => keptAttachmentIds.has(attachmentId))
    }));

  const keptApprovalRequests = sourceApprovalRequests.filter((request) =>
    keptModelIds.has(request.model_id)
  );

  const keptTrainingMetrics = sourceTrainingMetrics.filter((metric) =>
    keptTrainingJobIds.has(metric.training_job_id)
  );

  const keptEntityIds = new Set<string>([
    ...keptModelIds,
    ...keptDatasetIds,
    ...keptDatasetVersionIds,
    ...keptTrainingJobIds,
    ...keptTrainingWorkerIds,
    ...sourceTrainingWorkerBootstrapSessions.map((session) => session.id),
    ...keptModelVersionIds,
    ...keptConversationIds,
    ...keptInferenceRunIds,
    ...keptAttachmentIds,
    ...keptDatasetItemIds,
    ...keptAnnotationIds,
    ...keptApprovalRequests.map((request) => request.id)
  ]);

  const keptAuditLogs = sourceAuditLogs.filter(
    (log) => !log.entity_id || keptEntityIds.has(log.entity_id)
  );

  const sanitizedPayload: Partial<AppStatePayload> = {
    ...payload,
    users: normalizedUsers,
    models: keptModels,
    datasets: keptDatasets,
    datasetVersions: keptDatasetVersions,
    trainingJobs: keptTrainingJobs,
    trainingWorkerNodes: sourceTrainingWorkerNodes,
    trainingWorkerBootstrapSessions: sourceTrainingWorkerBootstrapSessions,
    trainingWorkerAuthTokensByWorkerId: sourceTrainingWorkerAuthTokensByWorkerId,
    modelVersions: normalizedModelVersions,
    conversations: keptConversations,
    inferenceRuns: keptInferenceRuns,
    attachments: keptAttachments,
    datasetItems: keptDatasetItems,
    annotations: keptAnnotations,
    annotationReviews: keptAnnotationReviews,
    messages: keptMessages,
    approvalRequests: keptApprovalRequests,
    trainingMetrics: keptTrainingMetrics,
    auditLogs: keptAuditLogs
  };

  const changed =
    normalizedUsers.some((user, index) => {
      const sourceUser = sourceUsers[index];
      return (
        !sourceUser ||
        sourceUser.status !== user.status ||
        sourceUser.status_reason !== user.status_reason ||
        sourceUser.last_login_at !== user.last_login_at ||
        sourceUser.capabilities.length !== user.capabilities.length
      );
    }) ||
    keptModels.length !== sourceModels.length ||
    keptDatasets.length !== sourceDatasets.length ||
    keptDatasetVersions.length !== sourceDatasetVersions.length ||
    keptTrainingJobs.length !== sourceTrainingJobs.length ||
    sourceTrainingWorkerNodes.length !==
      (Array.isArray(payload.trainingWorkerNodes) ? payload.trainingWorkerNodes.length : 0) ||
    sourceTrainingWorkerBootstrapSessions.length !==
      (Array.isArray(payload.trainingWorkerBootstrapSessions)
        ? payload.trainingWorkerBootstrapSessions.length
        : 0) ||
    Object.keys(sourceTrainingWorkerAuthTokensByWorkerId).length !==
      (payload.trainingWorkerAuthTokensByWorkerId &&
      typeof payload.trainingWorkerAuthTokensByWorkerId === 'object' &&
      !Array.isArray(payload.trainingWorkerAuthTokensByWorkerId)
        ? Object.keys(payload.trainingWorkerAuthTokensByWorkerId).length
        : 0) ||
    keptModelVersions.length !== sourceModelVersions.length ||
    keptConversations.length !== sourceConversations.length ||
    keptInferenceRuns.length !== sourceInferenceRuns.length ||
    keptAttachments.length !== sourceAttachments.length ||
    keptDatasetItems.length !== sourceDatasetItems.length ||
    keptAnnotations.length !== sourceAnnotations.length ||
    keptAnnotationReviews.length !== sourceAnnotationReviews.length ||
    keptMessages.length !== sourceMessages.length ||
    keptApprovalRequests.length !== sourceApprovalRequests.length ||
    keptTrainingMetrics.length !== sourceTrainingMetrics.length ||
    keptAuditLogs.length !== sourceAuditLogs.length ||
    datasetStatusReconciled.changed ||
    normalizedModelVersions.some((version, index) => {
      const sourceVersion = keptModelVersions[index];
      return sourceVersion ? sourceVersion.artifact_attachment_id !== version.artifact_attachment_id : false;
    }) ||
    keptMessages.some((message, index) => {
      const sourceMessage = sourceMessages[index];
      return sourceMessage ? sourceMessage.attachment_ids.length !== message.attachment_ids.length : false;
    });

  return { payload: sanitizedPayload, changed };
};

const buildAppStatePayload = (): AppStatePayload => ({
  users: users.map(normalizeUser),
  userPasswordHashes: { ...userPasswordHashes },
  models: [...models],
  conversations: [...conversations],
  messages: [...messages],
  attachments: attachments.map(normalizeAttachment),
  datasets: [...datasets],
  datasetItems: [...datasetItems],
  annotations: [...annotations],
  annotationReviews: [...annotationReviews],
  datasetVersions: [...datasetVersions],
  trainingJobs: trainingJobs.map(normalizeTrainingJob),
  trainingWorkerNodes: trainingWorkerNodes.map(normalizeTrainingWorkerNode),
  trainingWorkerBootstrapSessions: trainingWorkerBootstrapSessions.map(
    normalizeTrainingWorkerBootstrapSession
  ),
  trainingWorkerAuthTokensByWorkerId: { ...trainingWorkerAuthTokensByWorkerId },
  trainingMetrics: [...trainingMetrics],
  modelVersions: [...modelVersions],
  inferenceRuns: inferenceRuns.map(normalizeInferenceRun),
  approvalRequests: [...approvalRequests],
  auditLogs: [...auditLogs]
});

export const markAppStateDirty = (): void => {
  appStateDirty = true;
};

export const loadPersistedAppState = async (): Promise<void> => {
  let loadedDirty = false;
  try {
    const raw = await fs.readFile(appStateDataFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppStatePayload>;
    const sanitized = sanitizeAppStatePayload(parsed);
    const state = sanitized.payload;
    loadedDirty = sanitized.changed;

    if (Array.isArray(state.users)) {
      replaceArray(users, state.users.map(normalizeUser));
    }
    if (state.userPasswordHashes && typeof state.userPasswordHashes === 'object') {
      Object.keys(userPasswordHashes).forEach((key) => {
        delete userPasswordHashes[key];
      });
      Object.assign(userPasswordHashes, state.userPasswordHashes);
    }
    if (Array.isArray(state.models)) {
      replaceArray(models, state.models);
    }
    if (Array.isArray(state.conversations)) {
      replaceArray(conversations, state.conversations);
    }
    if (Array.isArray(state.messages)) {
      replaceArray(messages, state.messages);
    }
    if (Array.isArray(state.attachments)) {
      replaceArray(attachments, state.attachments.map(normalizeAttachment));
    }
    if (Array.isArray(state.datasets)) {
      replaceArray(datasets, state.datasets);
    }
    if (Array.isArray(state.datasetItems)) {
      replaceArray(datasetItems, state.datasetItems);
    }
    if (Array.isArray(state.annotations)) {
      replaceArray(annotations, state.annotations);
    }
    if (Array.isArray(state.annotationReviews)) {
      replaceArray(annotationReviews, state.annotationReviews.map(normalizeAnnotationReview));
    }
    if (Array.isArray(state.datasetVersions)) {
      replaceArray(datasetVersions, state.datasetVersions);
    }
    if (Array.isArray(state.trainingJobs)) {
      replaceArray(trainingJobs, state.trainingJobs.map(normalizeTrainingJob));
    }
    if (Array.isArray(state.trainingWorkerNodes)) {
      replaceArray(trainingWorkerNodes, state.trainingWorkerNodes.map(normalizeTrainingWorkerNode));
    }
    if (Array.isArray(state.trainingWorkerBootstrapSessions)) {
      replaceArray(
        trainingWorkerBootstrapSessions,
        state.trainingWorkerBootstrapSessions.map(normalizeTrainingWorkerBootstrapSession)
      );
    }
    Object.keys(trainingWorkerAuthTokensByWorkerId).forEach((key) => {
      delete trainingWorkerAuthTokensByWorkerId[key];
    });
    if (
      state.trainingWorkerAuthTokensByWorkerId &&
      typeof state.trainingWorkerAuthTokensByWorkerId === 'object' &&
      !Array.isArray(state.trainingWorkerAuthTokensByWorkerId)
    ) {
      Object.entries(state.trainingWorkerAuthTokensByWorkerId).forEach(([key, value]) => {
        if (typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim()) {
          trainingWorkerAuthTokensByWorkerId[key.trim()] = value.trim();
        }
      });
    }
    if (Array.isArray(state.trainingMetrics)) {
      replaceArray(trainingMetrics, state.trainingMetrics);
    }
    if (Array.isArray(state.modelVersions)) {
      replaceArray(modelVersions, state.modelVersions);
    }
    if (Array.isArray(state.inferenceRuns)) {
      replaceArray(inferenceRuns, state.inferenceRuns.map(normalizeInferenceRun));
    }
    if (Array.isArray(state.approvalRequests)) {
      replaceArray(approvalRequests, state.approvalRequests);
    }
    if (Array.isArray(state.auditLogs)) {
      replaceArray(auditLogs, state.auditLogs);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (appStateBootstrapMode === 'minimal') {
        applyMinimalBootstrapState();
        loadedDirty = true;
      }
      return;
    }
    console.warn('[vistral-api] Failed to load app state store:', (error as Error).message);
  } finally {
    appStateDirty = loadedDirty;
  }
};

export const persistAppState = async (force = false): Promise<void> => {
  if (!force && !appStateDirty) {
    return;
  }

  if (appStatePersistPromise) {
    await appStatePersistPromise;
    if (!force && !appStateDirty) {
      return;
    }
  }

  appStatePersistPromise = (async () => {
    const payload = buildAppStatePayload();
    const targetDir = path.dirname(appStateDataFile);
    const tempFile = `${appStateDataFile}.tmp`;
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tempFile, appStateDataFile);
    appStateDirty = false;
  })();

  try {
    await appStatePersistPromise;
  } finally {
    appStatePersistPromise = null;
  }
};

export const loadPersistedLlmConfigs = async (): Promise<void> => {
  try {
    const file = await fs.readFile(llmConfigDataFile, 'utf8');
    const encrypted = JSON.parse(file) as EncryptedPayload;
    const decrypted = decryptText(encrypted);
    const parsed = JSON.parse(decrypted) as Record<string, LlmConfig>;

    Object.assign(llmConfigsByUser, parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }

    // Keep service usable even when local encrypted store is unreadable.
    console.warn('[vistral-api] Failed to load encrypted LLM config store:', (error as Error).message);
  }
};

const normalizeRuntimeFrameworkConfig = (
  framework: 'paddleocr' | 'doctr' | 'yolo',
  raw: unknown,
  fallback: RuntimeSettingsRecord['frameworks'][keyof RuntimeSettingsRecord['frameworks']]
): RuntimeSettingsRecord['frameworks'][keyof RuntimeSettingsRecord['frameworks']] => {
  const normalizeIsoDate = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return new Date(parsed).toISOString();
  };

  const normalizeModelApiKeys = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ...fallback.model_api_keys };
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.trim();
      if (!normalizedKey || typeof entry !== 'string') {
        continue;
      }
      result[normalizedKey] = entry.trim();
    }
    return result;
  };

  const normalizeModelApiKeyPolicies = (
    value: unknown,
    legacyKeys: Record<string, string>
  ): RuntimeSettingsRecord['frameworks'][keyof RuntimeSettingsRecord['frameworks']]['model_api_key_policies'] => {
    const fallbackPolicies = fallback.model_api_key_policies ?? {};
    const rawPolicies =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const mergedKeys = new Set<string>([
      ...Object.keys(fallbackPolicies),
      ...Object.keys(legacyKeys),
      ...Object.keys(rawPolicies)
    ]);

    const result: RuntimeSettingsRecord['frameworks'][keyof RuntimeSettingsRecord['frameworks']]['model_api_key_policies'] =
      {};

    for (const rawKey of mergedKeys) {
      const key = rawKey.trim();
      if (!key) {
        continue;
      }
      const fallbackPolicy = fallbackPolicies[key];
      const rawEntry = rawPolicies[key];
      const entry =
        rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)
          ? (rawEntry as Record<string, unknown>)
          : null;
      const legacyApiKey = (legacyKeys[key] ?? '').trim();
      const normalizedApiKey =
        typeof entry?.api_key === 'string'
          ? entry.api_key.trim()
          : legacyApiKey || (fallbackPolicy?.api_key ?? '').trim();
      const normalizedMaxCalls =
        typeof entry?.max_calls === 'number' && Number.isFinite(entry.max_calls)
          ? Math.max(0, Math.floor(entry.max_calls))
          : typeof fallbackPolicy?.max_calls === 'number'
            ? Math.max(0, Math.floor(fallbackPolicy.max_calls))
            : null;
      const normalizedUsedCalls =
        typeof entry?.used_calls === 'number' && Number.isFinite(entry.used_calls)
          ? Math.max(0, Math.floor(entry.used_calls))
          : typeof fallbackPolicy?.used_calls === 'number' && Number.isFinite(fallbackPolicy.used_calls)
            ? Math.max(0, Math.floor(fallbackPolicy.used_calls))
            : 0;
      const cappedUsedCalls =
        typeof normalizedMaxCalls === 'number'
          ? Math.min(normalizedUsedCalls, normalizedMaxCalls)
          : normalizedUsedCalls;

      result[key] = {
        api_key: normalizedApiKey,
        expires_at:
          normalizeIsoDate(entry?.expires_at) ??
          normalizeIsoDate(fallbackPolicy?.expires_at) ??
          null,
        max_calls: normalizedMaxCalls,
        used_calls: cappedUsedCalls,
        last_used_at:
          normalizeIsoDate(entry?.last_used_at) ??
          normalizeIsoDate(fallbackPolicy?.last_used_at) ??
          null
      };
    }

    return result;
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return applyBundledLocalCommandDefaults(framework, { ...fallback });
  }

  const entry = raw as Partial<RuntimeSettingsRecord['frameworks'][keyof RuntimeSettingsRecord['frameworks']]>;
  const normalizedLegacyModelApiKeys = normalizeModelApiKeys(entry.model_api_keys);
  const normalizedModelApiKeyPolicies = normalizeModelApiKeyPolicies(
    entry.model_api_key_policies,
    normalizedLegacyModelApiKeys
  );
  const normalizedModelApiKeys = Object.fromEntries(
    Object.entries(normalizedModelApiKeyPolicies)
      .map(([key, policy]) => [key, (policy.api_key ?? '').trim()])
      .filter(([, apiKey]) => Boolean(apiKey))
  );

  return applyBundledLocalCommandDefaults(framework, {
    endpoint:
      typeof entry.endpoint === 'string' ? entry.endpoint.trim() : fallback.endpoint,
    api_key:
      typeof entry.api_key === 'string' ? entry.api_key.trim() : fallback.api_key,
    default_model_id:
      typeof entry.default_model_id === 'string'
        ? entry.default_model_id.trim()
        : fallback.default_model_id,
    default_model_version_id:
      typeof entry.default_model_version_id === 'string'
        ? entry.default_model_version_id.trim()
        : fallback.default_model_version_id,
    model_api_keys: normalizedModelApiKeys,
    model_api_key_policies: normalizedModelApiKeyPolicies,
    local_model_path:
      typeof entry.local_model_path === 'string'
        ? entry.local_model_path.trim()
        : fallback.local_model_path,
    local_train_command:
      typeof entry.local_train_command === 'string'
        ? entry.local_train_command.trim()
        : fallback.local_train_command,
    local_predict_command:
      typeof entry.local_predict_command === 'string'
        ? entry.local_predict_command.trim()
        : fallback.local_predict_command
  });
};

const normalizeRuntimeControlSettings = (
  raw: unknown,
  fallback: RuntimeSettingsRecord['controls']
): RuntimeSettingsRecord['controls'] => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...fallback };
  }

  const entry = raw as Partial<RuntimeSettingsRecord['controls']>;
  const requestedPythonBin = typeof entry.python_bin === 'string' ? entry.python_bin.trim() : '';
  const preferredPythonBin = resolveRuntimeDefaultPythonBin();
  const shouldPromotePreferredPythonBin =
    Boolean(preferredPythonBin) &&
    preferredPythonBin !== requestedPythonBin &&
    ['/usr/bin/python3', 'python3', 'python', ''].includes(requestedPythonBin);
  return {
    python_bin: shouldPromotePreferredPythonBin
      ? preferredPythonBin
      : requestedPythonBin || fallback.python_bin,
    disable_simulated_train_fallback:
      typeof entry.disable_simulated_train_fallback === 'boolean'
        ? entry.disable_simulated_train_fallback
        : fallback.disable_simulated_train_fallback,
    disable_inference_fallback:
      typeof entry.disable_inference_fallback === 'boolean'
        ? entry.disable_inference_fallback
        : fallback.disable_inference_fallback
  };
};

export const loadPersistedRuntimeSettings = async (): Promise<void> => {
  try {
    const file = await fs.readFile(runtimeSettingsDataFile, 'utf8');
    const encrypted = JSON.parse(file) as EncryptedPayload;
    const decrypted = decryptText(encrypted);
    const parsed = JSON.parse(decrypted) as Partial<RuntimeSettingsRecord>;
    const defaults = buildDefaultRuntimeSettingsFromEnv();
    const frameworks: Partial<RuntimeSettingsRecord['frameworks']> =
      parsed.frameworks && typeof parsed.frameworks === 'object' && !Array.isArray(parsed.frameworks)
        ? (parsed.frameworks as Partial<RuntimeSettingsRecord['frameworks']>)
        : {};

    runtimeSettings.frameworks.paddleocr = normalizeRuntimeFrameworkConfig(
      'paddleocr',
      frameworks.paddleocr,
      defaults.frameworks.paddleocr
    );
    runtimeSettings.frameworks.doctr = normalizeRuntimeFrameworkConfig(
      'doctr',
      frameworks.doctr,
      defaults.frameworks.doctr
    );
    runtimeSettings.frameworks.yolo = normalizeRuntimeFrameworkConfig(
      'yolo',
      frameworks.yolo,
      defaults.frameworks.yolo
    );
    runtimeSettings.controls = normalizeRuntimeControlSettings(parsed.controls, defaults.controls);
    runtimeSettings.active_profile_id =
      typeof parsed.active_profile_id === 'string' && parsed.active_profile_id.trim()
        ? parsed.active_profile_id.trim()
        : null;
    runtimeSettings.updated_at =
      typeof parsed.updated_at === 'string' && parsed.updated_at.trim()
        ? parsed.updated_at.trim()
        : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }

    console.warn('[vistral-api] Failed to load encrypted runtime settings store:', (error as Error).message);
  }
};

export const persistLlmConfigs = async (): Promise<void> => {
  const serialized = JSON.stringify(llmConfigsByUser);
  const encrypted = encryptText(serialized);

  await fs.mkdir(path.dirname(llmConfigDataFile), { recursive: true });
  await fs.writeFile(llmConfigDataFile, JSON.stringify(encrypted), 'utf8');
};

export const persistRuntimeSettings = async (): Promise<void> => {
  const serialized = JSON.stringify(runtimeSettings);
  const encrypted = encryptText(serialized);

  await fs.mkdir(path.dirname(runtimeSettingsDataFile), { recursive: true });
  await fs.writeFile(runtimeSettingsDataFile, JSON.stringify(encrypted), 'utf8');
};
