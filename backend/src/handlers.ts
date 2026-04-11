import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  isCuratedFoundationModelName,
  isFixtureAttachmentFilename,
  isFixtureModelVersionRecord
} from '../../shared/catalogFixtures';
import {
  annotationReviews,
  annotations,
  approvalRequests,
  auditLogs,
  attachments,
  conversations,
  datasetItems,
  datasets,
  datasetVersions,
  inferenceRuns,
  llmConfigsByUser,
  markAppStateDirty,
  messages,
  models,
  modelVersions,
  persistLlmConfigs,
  persistRuntimeSettings,
  runtimeSettings,
  trainingJobs,
  trainingWorkerAuthTokensByWorkerId,
  trainingWorkerBootstrapSessions,
  trainingWorkerNodes,
  trainingMetrics,
  userPasswordHashes,
  users
} from './store';
import { hashPassword, verifyPassword } from './auth';
import { checkRuntimeConnectivity, getTrainerByFramework } from './runtimeAdapters';
import type {
  ActivateTrainingWorkerResult,
  AnnotationRecord,
  AnnotationReviewReasonCode,
  AnnotationReviewRecord,
  AnnotationWithReview,
  AnnotationStatus,
  ApprovalRequest,
  AuditLogRecord,
  ChangePasswordInput,
  ConversationActionMetadata,
  ConversationRecord,
  ClaimTrainingWorkerBootstrapSessionInput,
  ClaimTrainingWorkerBootstrapSessionResult,
  CreateTrainingWorkerInput,
  CreateTrainingWorkerBootstrapSessionInput,
  GetTrainingWorkerBootstrapSessionStatusInput,
  CreateUserInput,
  CreateDatasetInput,
  CreateModelDraftInput,
  CreateTrainingJobInput,
  DatasetItemRecord,
  DatasetRecord,
  DatasetVersionRecord,
  FileAttachment,
  FileAttachmentStatus,
  InferenceFeedbackInput,
  InferenceRunRecord,
  LlmConfig,
  LlmConfigView,
  RuntimeFrameworkConfig,
  RuntimeProfileView,
  RuntimeSettingsRecord,
  RuntimeSettingsView,
  LoginInput,
  MessageRecord,
  MessageMetadata,
  ModelRecord,
  ModelVersionRecord,
  RequirementAnnotationType,
  RequirementTaskDraft,
  RegisterInput,
  RenameConversationInput,
  RegisterModelVersionInput,
  ResetUserPasswordInput,
  ReviewAnnotationInput,
  RuntimeConnectivityRecord,
  RuntimeMetricsRetentionSummary,
  RunInferenceInput,
  TrainingSchedulerDecision,
  TrainingWorkerBootstrapSessionRecord,
  TrainingWorkerCompatibilitySnapshot,
  TrainingWorkerDeploymentMode,
  TrainingWorkerHeartbeatInput,
  TrainingWorkerNodeRecord,
  TrainingWorkerNodeView,
  TrainingWorkerProfile,
  SendMessageInput,
  StartConversationInput,
  SubmitApprovalInput,
  TrainingMetricsExport,
  TaskType,
  ModelFramework,
  TrainingJobRecord,
  TrainingArtifactSummary,
  TrainingMetricRecord,
  UpdateTrainingWorkerInput,
  UpdateUserStatusInput,
  UpsertAnnotationInput,
  VerificationCheckRecord,
  VerificationReportRecord,
  User
} from '../../shared/domain';

const delay = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const normalizeUsername = (value: string) => value.trim().toLowerCase();
const toEnvFlagBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};
const allowNonRealLocalCommandModelVersionRegistration = toEnvFlagBoolean(
  process.env.MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND,
  false
);
const verificationReportsDir = path.resolve(
  process.cwd(),
  (process.env.VERIFICATION_REPORTS_DIR ?? '.data/verify-reports').trim()
);
const uploadStorageRoot = path.resolve(
  process.cwd(),
  (process.env.UPLOAD_STORAGE_ROOT ?? '.data/uploads').trim()
);
const attachmentStorageDirByTarget: Record<FileAttachment['attached_to_type'], string> = {
  Conversation: 'conversation',
  Model: 'model',
  Dataset: 'dataset',
  InferenceRun: 'inference'
};
type StoredAttachmentBinary = {
  file_path: string;
  mime_type: string;
  byte_size: number;
};
type AttachmentUploadInput = string | {
  filename: string;
  byte_size?: number;
  mime_type?: string;
  content?: Buffer;
};
type CreateDatasetItemInput = {
  attachment_id?: string;
  filename?: string;
  split?: DatasetItemRecord['split'];
  status?: DatasetItemRecord['status'];
  metadata?: Record<string, string>;
};
type UpdateDatasetItemInput = {
  split?: DatasetItemRecord['split'];
  status?: DatasetItemRecord['status'];
  metadata?: Record<string, string>;
};
type NormalizedAttachmentUploadInput = {
  filename: string;
  byte_size: number;
  mime_type: string;
  content: Buffer | null;
};
const storedAttachmentBinaryById = new Map<string, StoredAttachmentBinary>();

let idSeed = 400;
const currentUserId = process.env.DEFAULT_USER_ID ?? 'u-1';
const actorStore = new AsyncLocalStorage<{ userId: string }>();

const defaultLlmConfig: LlmConfig = {
  enabled: false,
  provider: 'chatanywhere',
  base_url: process.env.VITE_DEFAULT_LLM_BASE_URL ?? 'https://api.chatanywhere.tech/v1',
  api_key: '',
  model: process.env.VITE_DEFAULT_LLM_MODEL ?? 'gpt-3.5-turbo',
  temperature: 0.2
};

const nextId = (prefix: string) => `${prefix}-${idSeed++}`;

const idSuffix = (value: string): number => {
  const match = value.match(/-(\d+)$/);
  if (!match?.[1]) {
    return 0;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const resolveMaxIdSeedFromState = (): number => {
  const sources: Array<Array<{ id: string }>> = [
    users,
    models,
    conversations,
    messages,
    attachments,
    datasets,
    datasetItems,
    annotations,
    annotationReviews,
    datasetVersions,
    trainingJobs,
    trainingWorkerNodes,
    trainingWorkerBootstrapSessions,
    trainingMetrics,
    modelVersions,
    inferenceRuns,
    approvalRequests,
    auditLogs
  ];

  let maxId = 0;
  sources.forEach((collection) => {
    collection.forEach((entry) => {
      maxId = Math.max(maxId, idSuffix(entry.id));
    });
  });
  return maxId;
};

export const syncRuntimeIdSeed = (): void => {
  idSeed = Math.max(400, resolveMaxIdSeedFromState() + 1);
};

const resolveActorUserId = (): string => actorStore.getStore()?.userId ?? currentUserId;

const findCurrentUser = (): User => {
  const found = users.find((user) => user.id === resolveActorUserId());
  if (!found) {
    throw new Error('Current user not found in mock store.');
  }
  assertUserAccountActive(found);
  return found;
};

export const runAsUser = async <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  actorStore.run({ userId }, fn);

const canManageModels = (user: User) =>
  user.role === 'admin' || user.capabilities.includes('manage_models');

const defaultCapabilitiesByRole = (role: User['role']): User['capabilities'] =>
  role === 'admin' ? ['manage_models', 'global_governance'] : ['manage_models'];

const assertAdmin = (user: User, message: string): void => {
  if (user.role !== 'admin') {
    throw new Error(message);
  }
};

const assertUserAccountActive = (user: User): void => {
  if (user.status === 'disabled') {
    throw new Error('Account is disabled. Ask an administrator to reactivate it.');
  }
};

const findUserById = (userId: string): User => {
  const matched = users.find((user) => user.id === userId);
  if (!matched) {
    throw new Error('User not found.');
  }

  return matched;
};

const countActiveAdminUsers = (): number =>
  users.filter((user) => user.role === 'admin' && user.status === 'active').length;

const assertOwnershipOrAdmin = (ownerUserId: string, user: User, message: string): void => {
  if (!(user.role === 'admin' || ownerUserId === user.id)) {
    throw new Error(message);
  }
};

const maskApiKey = (key: string): string => {
  if (!key) {
    return 'Not set';
  }

  if (key.length <= 8) {
    return '*'.repeat(key.length);
  }

  return `${key.slice(0, 4)}...${key.slice(-4)}`;
};

const normalizeLlmConfig = (input: Partial<LlmConfig>): LlmConfig => {
  const safeTempRaw =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? input.temperature
      : defaultLlmConfig.temperature;

  return {
    enabled: Boolean(input.enabled),
    provider: 'chatanywhere',
    base_url: (input.base_url ?? defaultLlmConfig.base_url).trim(),
    api_key: (input.api_key ?? '').trim(),
    model: (input.model ?? defaultLlmConfig.model).trim(),
    temperature: Math.max(0, Math.min(2, safeTempRaw))
  };
};

const runtimeFrameworks: ModelFramework[] = ['paddleocr', 'doctr', 'yolo'];
type RuntimeProfileSource = 'env' | 'saved';

interface RuntimeProfileRecord {
  id: string;
  label: string;
  description: string;
  source: RuntimeProfileSource;
  frameworks: Record<ModelFramework, RuntimeFrameworkConfig>;
  controls: RuntimeSettingsRecord['controls'];
}

const emptyRuntimeFrameworkConfig: RuntimeFrameworkConfig = {
  endpoint: '',
  api_key: '',
  local_train_command: '',
  local_predict_command: ''
};

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

const emptyRuntimeControlConfig: RuntimeSettingsRecord['controls'] = {
  python_bin: '',
  disable_simulated_train_fallback: false,
  disable_inference_fallback: false
};

const getEnvRuntimeControlConfig = (): RuntimeSettingsRecord['controls'] => ({
  python_bin: (process.env.VISTRAL_PYTHON_BIN ?? process.env.PYTHON_BIN ?? '').trim(),
  disable_simulated_train_fallback: parseRuntimeBoolean(
    process.env.VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK,
    false
  ),
  disable_inference_fallback: parseRuntimeBoolean(process.env.VISTRAL_DISABLE_INFERENCE_FALLBACK, false)
});

const getEnvRuntimeFrameworkConfig = (framework: ModelFramework): RuntimeFrameworkConfig => {
  if (framework === 'paddleocr') {
    return {
      endpoint: (process.env.PADDLEOCR_RUNTIME_ENDPOINT ?? '').trim(),
      api_key: (process.env.PADDLEOCR_RUNTIME_API_KEY ?? '').trim(),
      local_train_command: (process.env.PADDLEOCR_LOCAL_TRAIN_COMMAND ?? '').trim(),
      local_predict_command: (process.env.PADDLEOCR_LOCAL_PREDICT_COMMAND ?? '').trim()
    };
  }

  if (framework === 'doctr') {
    return {
      endpoint: (process.env.DOCTR_RUNTIME_ENDPOINT ?? '').trim(),
      api_key: (process.env.DOCTR_RUNTIME_API_KEY ?? '').trim(),
      local_train_command: (process.env.DOCTR_LOCAL_TRAIN_COMMAND ?? '').trim(),
      local_predict_command: (process.env.DOCTR_LOCAL_PREDICT_COMMAND ?? '').trim()
    };
  }

  return {
    endpoint: (process.env.YOLO_RUNTIME_ENDPOINT ?? '').trim(),
    api_key: (process.env.YOLO_RUNTIME_API_KEY ?? '').trim(),
    local_train_command: (process.env.YOLO_LOCAL_TRAIN_COMMAND ?? '').trim(),
    local_predict_command: (process.env.YOLO_LOCAL_PREDICT_COMMAND ?? '').trim()
  };
};

const normalizeRuntimeFrameworkConfig = (
  input: Partial<RuntimeFrameworkConfig> | null | undefined,
  fallback: RuntimeFrameworkConfig
): RuntimeFrameworkConfig => ({
  endpoint: typeof input?.endpoint === 'string' ? input.endpoint.trim() : fallback.endpoint,
  api_key: typeof input?.api_key === 'string' ? input.api_key.trim() : fallback.api_key,
  local_train_command:
    typeof input?.local_train_command === 'string'
      ? input.local_train_command.trim()
      : fallback.local_train_command,
  local_predict_command:
    typeof input?.local_predict_command === 'string'
      ? input.local_predict_command.trim()
      : fallback.local_predict_command
});

const normalizeRuntimeControlConfig = (
  input: Partial<RuntimeSettingsRecord['controls']> | null | undefined,
  fallback: RuntimeSettingsRecord['controls']
): RuntimeSettingsRecord['controls'] => ({
  python_bin: typeof input?.python_bin === 'string' ? input.python_bin.trim() : fallback.python_bin,
  disable_simulated_train_fallback:
    typeof input?.disable_simulated_train_fallback === 'boolean'
      ? input.disable_simulated_train_fallback
      : fallback.disable_simulated_train_fallback,
  disable_inference_fallback:
    typeof input?.disable_inference_fallback === 'boolean'
      ? input.disable_inference_fallback
      : fallback.disable_inference_fallback
});

const getStoredRuntimeFrameworkConfig = (framework: ModelFramework): RuntimeFrameworkConfig => {
  const fallback = runtimeSettings.updated_at ? emptyRuntimeFrameworkConfig : getEnvRuntimeFrameworkConfig(framework);
  return normalizeRuntimeFrameworkConfig(runtimeSettings.frameworks[framework], fallback);
};

const getStoredRuntimeControlConfig = (): RuntimeSettingsRecord['controls'] => {
  const fallback = runtimeSettings.updated_at ? emptyRuntimeControlConfig : getEnvRuntimeControlConfig();
  return normalizeRuntimeControlConfig(runtimeSettings.controls, fallback);
};

const getCurrentRuntimeSettingsRecord = (): RuntimeSettingsRecord => ({
  updated_at: runtimeSettings.updated_at,
  active_profile_id:
    typeof runtimeSettings.active_profile_id === 'string' && runtimeSettings.active_profile_id.trim()
      ? runtimeSettings.active_profile_id.trim()
      : null,
  frameworks: {
    paddleocr: getStoredRuntimeFrameworkConfig('paddleocr'),
    doctr: getStoredRuntimeFrameworkConfig('doctr'),
    yolo: getStoredRuntimeFrameworkConfig('yolo')
  },
  controls: getStoredRuntimeControlConfig()
});

const parseRuntimeProfilesFromEnv = (): RuntimeProfileRecord[] => {
  const raw = (process.env.VISTRAL_RUNTIME_PROFILES_JSON ?? '').trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const envProfiles: RuntimeProfileRecord[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const candidate = item as {
        id?: unknown;
        label?: unknown;
        description?: unknown;
        frameworks?: Partial<Record<ModelFramework, Partial<RuntimeFrameworkConfig>>>;
        controls?: Partial<RuntimeSettingsRecord['controls']>;
      };
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      if (!id || !label) {
        continue;
      }
      const frameworks = candidate.frameworks ?? {};
      envProfiles.push({
        id,
        label,
        description:
          typeof candidate.description === 'string' && candidate.description.trim()
            ? candidate.description.trim()
            : 'Runtime profile loaded from deployment environment.',
        source: 'env',
        frameworks: {
          paddleocr: normalizeRuntimeFrameworkConfig(frameworks.paddleocr, emptyRuntimeFrameworkConfig),
          doctr: normalizeRuntimeFrameworkConfig(frameworks.doctr, emptyRuntimeFrameworkConfig),
          yolo: normalizeRuntimeFrameworkConfig(frameworks.yolo, emptyRuntimeFrameworkConfig)
        },
        controls: normalizeRuntimeControlConfig(candidate.controls, emptyRuntimeControlConfig)
      });
    }
    return envProfiles;
  } catch {
    return [];
  }
};

const buildRuntimeProfiles = (record: RuntimeSettingsRecord): RuntimeProfileRecord[] => {
  const envProfiles = parseRuntimeProfilesFromEnv();
  const savedProfile: RuntimeProfileRecord = {
    id: 'saved',
    label: 'Saved runtime settings',
    description: 'Current persisted runtime configuration used by API runtime adapters.',
    source: 'saved',
    frameworks: {
      paddleocr: normalizeRuntimeFrameworkConfig(record.frameworks.paddleocr, emptyRuntimeFrameworkConfig),
      doctr: normalizeRuntimeFrameworkConfig(record.frameworks.doctr, emptyRuntimeFrameworkConfig),
      yolo: normalizeRuntimeFrameworkConfig(record.frameworks.yolo, emptyRuntimeFrameworkConfig)
    },
    controls: normalizeRuntimeControlConfig(record.controls, emptyRuntimeControlConfig)
  };
  return [savedProfile, ...envProfiles];
};

const toRuntimeProfileView = (profile: RuntimeProfileRecord): RuntimeProfileView => ({
  id: profile.id,
  label: profile.label,
  description: profile.description,
  source: profile.source,
  frameworks: {
    paddleocr: {
      endpoint: profile.frameworks.paddleocr.endpoint,
      local_train_command: profile.frameworks.paddleocr.local_train_command,
      local_predict_command: profile.frameworks.paddleocr.local_predict_command,
      has_api_key: profile.frameworks.paddleocr.api_key.length > 0,
      api_key_masked: maskApiKey(profile.frameworks.paddleocr.api_key)
    },
    doctr: {
      endpoint: profile.frameworks.doctr.endpoint,
      local_train_command: profile.frameworks.doctr.local_train_command,
      local_predict_command: profile.frameworks.doctr.local_predict_command,
      has_api_key: profile.frameworks.doctr.api_key.length > 0,
      api_key_masked: maskApiKey(profile.frameworks.doctr.api_key)
    },
    yolo: {
      endpoint: profile.frameworks.yolo.endpoint,
      local_train_command: profile.frameworks.yolo.local_train_command,
      local_predict_command: profile.frameworks.yolo.local_predict_command,
      has_api_key: profile.frameworks.yolo.api_key.length > 0,
      api_key_masked: maskApiKey(profile.frameworks.yolo.api_key)
    }
  },
  controls: {
    python_bin: profile.controls.python_bin,
    disable_simulated_train_fallback: profile.controls.disable_simulated_train_fallback,
    disable_inference_fallback: profile.controls.disable_inference_fallback
  }
});

const getStoredLlmConfigByUser = (userId: string): LlmConfig => {
  const fromStore = llmConfigsByUser[userId];
  return fromStore ? normalizeLlmConfig(fromStore) : { ...defaultLlmConfig };
};

const assertModelAccess = (modelId: string, user: User): ModelRecord => {
  const model = models.find((item) => item.id === modelId);
  if (!model) {
    throw new Error('Model not found.');
  }

  const hasReadAccess =
    user.role === 'admin' ||
    model.visibility === 'public' ||
    model.owner_user_id === user.id ||
    model.visibility === 'workspace';

  if (!hasReadAccess) {
    throw new Error('No permission to access this model.');
  }

  return model;
};

const assertDatasetAccess = (datasetId: string, user: User): DatasetRecord => {
  const dataset = datasets.find((item) => item.id === datasetId);
  if (!dataset) {
    throw new Error('Dataset not found.');
  }

  if (!(user.role === 'admin' || dataset.owner_user_id === user.id)) {
    throw new Error('No permission to access this dataset.');
  }

  return dataset;
};

const assertModelVersionAccess = (modelVersionId: string, user: User): ModelVersionRecord => {
  const version = modelVersions.find((item) => item.id === modelVersionId);
  if (!version) {
    throw new Error('Model version not found.');
  }

  const model = models.find((item) => item.id === version.model_id);
  if (!model) {
    throw new Error('Model for model version not found.');
  }

  const hasAccess =
    user.role === 'admin' ||
    model.owner_user_id === user.id ||
    model.visibility === 'workspace' ||
    model.visibility === 'public';

  if (!hasAccess) {
    throw new Error('No permission to access this model version.');
  }

  return version;
};

const startAttachmentLifecycle = (
  attachment: FileAttachment,
  shouldFail: boolean,
  onStatusChange?: (status: FileAttachmentStatus) => void
) => {
  setTimeout(() => {
    attachment.status = 'processing';
    attachment.updated_at = now();
    markAppStateDirty();
    onStatusChange?.('processing');
  }, 450);

  setTimeout(() => {
    if (shouldFail) {
      attachment.status = 'error';
      attachment.upload_error = 'Mock upload failed. Rename file and retry.';
    } else {
      attachment.status = 'ready';
      attachment.upload_error = null;
    }
    attachment.updated_at = now();
    markAppStateDirty();
    onStatusChange?.(attachment.status);
  }, 1000);
};

const sanitizeFilename = (value: string): string =>
  value
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 140) || `file-${Date.now()}.bin`;

const guessMimeType = (filename: string): string => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (lower.endsWith('.pdf')) {
    return 'application/pdf';
  }
  if (lower.endsWith('.txt')) {
    return 'text/plain; charset=utf-8';
  }
  if (lower.endsWith('.json')) {
    return 'application/json';
  }
  return 'application/octet-stream';
};

const normalizeAttachmentUploadInput = (input: AttachmentUploadInput): NormalizedAttachmentUploadInput => {
  const filename =
    typeof input === 'string'
      ? input
      : typeof input.filename === 'string'
        ? input.filename
        : '';
  const normalizedFilename = filename.trim() || `file-${Date.now()}.bin`;
  const contentBuffer =
    typeof input === 'string'
      ? null
      : Buffer.isBuffer(input.content)
        ? input.content
        : null;
  const byteSize =
    contentBuffer?.byteLength ??
    (typeof input === 'string'
      ? 0
      : typeof input.byte_size === 'number' && Number.isFinite(input.byte_size)
        ? input.byte_size
        : 0);
  const mimeType =
    typeof input === 'string'
      ? guessMimeType(normalizedFilename)
      : typeof input.mime_type === 'string' && input.mime_type.trim()
        ? input.mime_type.trim()
        : guessMimeType(normalizedFilename);

  return {
    filename: normalizedFilename,
    byte_size: byteSize,
    mime_type: mimeType,
    content: contentBuffer
  };
};

const resolveAttachmentStorageDir = (target: FileAttachment['attached_to_type']): string =>
  path.join(uploadStorageRoot, attachmentStorageDirByTarget[target]);

const storeAttachmentBinary = async (
  attachment: FileAttachment,
  filename: string,
  content: Buffer,
  mimeType?: string
): Promise<StoredAttachmentBinary> => {
  const targetDir = resolveAttachmentStorageDir(attachment.attached_to_type);
  await fs.mkdir(targetDir, { recursive: true });
  const safeName = sanitizeFilename(filename);
  const diskPath = path.join(targetDir, `${attachment.id}__${safeName}`);
  await fs.writeFile(diskPath, content);

  const stored: StoredAttachmentBinary = {
    file_path: diskPath,
    mime_type: mimeType?.trim() || guessMimeType(filename),
    byte_size: content.byteLength
  };
  storedAttachmentBinaryById.set(attachment.id, stored);
  return stored;
};

const findStoredAttachmentBinary = async (
  attachment: FileAttachment
): Promise<StoredAttachmentBinary | null> => {
  const inMemory = storedAttachmentBinaryById.get(attachment.id);
  if (inMemory) {
    try {
      const stats = await fs.stat(inMemory.file_path);
      if (stats.isFile()) {
        return {
          ...inMemory,
          byte_size: stats.size
        };
      }
    } catch {
      storedAttachmentBinaryById.delete(attachment.id);
    }
  }

  if (attachment.storage_path) {
    try {
      const stats = await fs.stat(attachment.storage_path);
      if (stats.isFile()) {
        const resolved: StoredAttachmentBinary = {
          file_path: attachment.storage_path,
          mime_type: attachment.mime_type?.trim() || guessMimeType(attachment.filename),
          byte_size: stats.size
        };
        storedAttachmentBinaryById.set(attachment.id, resolved);
        return resolved;
      }
    } catch {
      // continue with prefix scan fallback
    }
  }

  try {
    const targetDir = resolveAttachmentStorageDir(attachment.attached_to_type);
    const entries = await fs.readdir(targetDir);
    const matched = entries.find((item) => item.startsWith(`${attachment.id}__`));
    if (!matched) {
      return null;
    }
    const diskPath = path.join(targetDir, matched);
    const stats = await fs.stat(diskPath);
    if (!stats.isFile()) {
      return null;
    }

    const resolved: StoredAttachmentBinary = {
      file_path: diskPath,
      mime_type: attachment.mime_type?.trim() || guessMimeType(attachment.filename),
      byte_size: stats.size
    };
    storedAttachmentBinaryById.set(attachment.id, resolved);
    return resolved;
  } catch {
    return null;
  }
};

const removeStoredAttachmentBinary = async (attachment: FileAttachment): Promise<void> => {
  const known = storedAttachmentBinaryById.get(attachment.id);
  storedAttachmentBinaryById.delete(attachment.id);

  const candidatePaths = new Set<string>();
  if (known?.file_path) {
    candidatePaths.add(known.file_path);
  }
  if (attachment.storage_path) {
    candidatePaths.add(attachment.storage_path);
  }

  for (const candidate of candidatePaths) {
    try {
      await fs.unlink(candidate);
      return;
    } catch {
      // continue and fallback to prefix scan
    }
  }

  try {
    const targetDir = resolveAttachmentStorageDir(attachment.attached_to_type);
    const entries = await fs.readdir(targetDir);
    const matched = entries.filter((item) => item.startsWith(`${attachment.id}__`));
    await Promise.all(
      matched.map(async (name) => {
        try {
          await fs.unlink(path.join(targetDir, name));
        } catch {
          // ignore best-effort cleanup failures
        }
      })
    );
  } catch {
    // ignore
  }
};

const buildAssistantReply = (content: string, fileNames: string[]) => {
  const attachmentPart =
    fileNames.length > 0 ? `I reviewed ${fileNames.join(', ')}.` : 'No attachments were provided.';
  return `Mock analysis complete. ${attachmentPart} Key point from your request: "${content.slice(0, 80)}".`;
};

const buildAttachmentContext = (fileNames: string[]) =>
  fileNames.length > 0
    ? `Attached files: ${fileNames.join(', ')}.`
    : 'No files attached in this turn.';

const providerResponsePreviewMaxLength = 200;

const normalizeProviderResponsePreview = (rawText: string): string => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return 'empty response body';
  }

  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('<!doctype') || lowered.startsWith('<html')) {
    return 'non-JSON response body';
  }

  return trimmed.replace(/\s+/g, ' ').slice(0, providerResponsePreviewMaxLength);
};

const readJsonObjectFromResponse = async (
  response: Response
): Promise<{ payload: Record<string, unknown> | null; rawText: string }> => {
  const rawText = await response.text();
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { payload: null, rawText };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { payload: null, rawText };
    }

    return { payload: parsed as Record<string, unknown>, rawText };
  } catch {
    return { payload: null, rawText };
  }
};

const readMessageFromPayload = (payload: Record<string, unknown>): string => {
  const errorPart = payload.error;
  if (errorPart && typeof errorPart === 'object' && !Array.isArray(errorPart)) {
    const nestedMessage = (errorPart as { message?: unknown }).message;
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }

  const directMessage = payload.message;
  if (typeof directMessage === 'string' && directMessage.trim()) {
    return directMessage.trim();
  }

  const detail = payload.detail;
  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim();
  }

  return '';
};

const toCompletionEndpoint = (baseUrl: string) => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/chat/completions';
  }

  if (/\/v1\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }

  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }

  if (/\/v1$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }

  return `${normalized}/v1/chat/completions`;
};

const readProviderErrorMessage = async (response: Response): Promise<string> => {
  try {
    const { payload } = await readJsonObjectFromResponse(response);
    if (!payload) {
      return '';
    }
    return readMessageFromPayload(payload);
  } catch {
    return '';
  }
};

const callConfiguredLlm = async (
  content: string,
  fileNames: string[],
  llmConfig: LlmConfig
): Promise<string> => {
  if (!llmConfig.api_key.trim()) {
    throw new Error('LLM API key is missing.');
  }

  const endpoint = toCompletionEndpoint(llmConfig.base_url);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llmConfig.api_key}`
    },
    body: JSON.stringify({
      model: llmConfig.model,
      temperature: llmConfig.temperature,
      messages: [
        {
          role: 'system',
          content:
            'You are the Vistral assistant for visual-model analysis. Answer clearly with concise technical observations.'
        },
        {
          role: 'user',
          content: `${content}\n\n${buildAttachmentContext(fileNames)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const providerMessage = await readProviderErrorMessage(response);
    if (providerMessage) {
      throw new Error(`LLM provider request failed (${response.status}): ${providerMessage}`);
    }
    throw new Error(`LLM provider request failed (${response.status}).`);
  }

  const { payload, rawText } = await readJsonObjectFromResponse(response);
  if (!payload) {
    throw new Error(
      `LLM provider returned non-JSON payload: ${normalizeProviderResponsePreview(rawText)}`
    );
  }

  const choicesRaw = payload.choices;
  const firstChoice =
    Array.isArray(choicesRaw) && choicesRaw.length > 0
      ? choicesRaw[0]
      : null;
  const messagePart =
    firstChoice && typeof firstChoice === 'object' && !Array.isArray(firstChoice)
      ? (firstChoice as { message?: unknown }).message
      : null;
  const outputRaw =
    messagePart && typeof messagePart === 'object' && !Array.isArray(messagePart)
      ? (messagePart as { content?: unknown }).content
      : null;
  const output = typeof outputRaw === 'string' ? outputRaw.trim() : '';
  if (!output) {
    throw new Error('LLM provider returned empty content.');
  }

  return output;
};

const generateAssistantReply = async (
  content: string,
  fileNames: string[],
  llmConfig?: LlmConfig | null
): Promise<string> => {
  if (!llmConfig || !llmConfig.enabled) {
    return buildAssistantReply(content, fileNames);
  }

  try {
    return await callConfiguredLlm(content, fileNames, llmConfig);
  } catch (error) {
    const reason = (error as Error).message;
    return `${buildAssistantReply(content, fileNames)}\n\nFallback reason: ${reason}`;
  }
};

const requirementAnnotationTypeSet = new Set<RequirementAnnotationType>([
  'ocr_text',
  'bbox',
  'rotated_bbox',
  'polygon',
  'classification'
]);

const taskTypeSet = new Set<TaskType>(['ocr', 'detection', 'classification', 'segmentation', 'obb']);

const frameworkSet = new Set<ModelFramework>(['paddleocr', 'doctr', 'yolo']);

const isRequirementAnnotationType = (value: unknown): value is RequirementAnnotationType =>
  typeof value === 'string' && requirementAnnotationTypeSet.has(value as RequirementAnnotationType);

const isTaskType = (value: unknown): value is TaskType =>
  typeof value === 'string' && taskTypeSet.has(value as TaskType);

const isModelFramework = (value: unknown): value is ModelFramework =>
  typeof value === 'string' && frameworkSet.has(value as ModelFramework);

const buildRuleBasedTaskDraft = (description: string): RequirementTaskDraft => {
  const normalized = description.toLowerCase();
  const has = (...keywords: string[]) => keywords.some((keyword) => normalized.includes(keyword));

  if (has('ocr', '识别', '文字', '文本', '车号', '编号', 'read text', 'text line')) {
    return {
      task_type: 'ocr',
      recommended_framework: 'paddleocr',
      recommended_annotation_type: 'ocr_text',
      annotation_type: 'ocr_text',
      label_hints: ['text_line', 'serial_number', 'region'],
      dataset_suggestions: ['采集不同光照与角度的车体编号样本', '保留高分辨率原图，标注文本行与关键字段'],
      evaluation_metric_suggestions: ['accuracy', 'cer', 'wer'],
      rationale: '需求描述以文字识别为核心，优先 OCR 任务与 PaddleOCR 基线。',
      source: 'rule'
    };
  }

  if (has('旋转', 'obb', 'oriented', '倾斜框')) {
    return {
      task_type: 'obb',
      recommended_framework: 'yolo',
      recommended_annotation_type: 'rotated_bbox',
      annotation_type: 'rotated_bbox',
      label_hints: ['target', 'defect', 'component'],
      dataset_suggestions: ['优先标注旋转框并覆盖不同方位', '补充密集目标场景样本'],
      evaluation_metric_suggestions: ['map', 'precision', 'recall'],
      rationale: '需求强调旋转目标，采用 YOLO OBB 路线更直接。',
      source: 'rule'
    };
  }

  if (has('分割', '轮廓', 'mask', 'segmentation')) {
    return {
      task_type: 'segmentation',
      recommended_framework: 'yolo',
      recommended_annotation_type: 'polygon',
      annotation_type: 'polygon',
      label_hints: ['defect_region', 'background'],
      dataset_suggestions: ['优先清晰边界样本', '保持多边形点位精度并覆盖复杂背景'],
      evaluation_metric_suggestions: ['miou', 'dice'],
      rationale: '需求指向像素级区域识别，建议分割任务。',
      source: 'rule'
    };
  }

  if (has('分类', '是否', '判断', 'classif', 'normal vs abnormal', '开闭')) {
    return {
      task_type: 'classification',
      recommended_framework: 'yolo',
      recommended_annotation_type: 'classification',
      annotation_type: 'classification',
      label_hints: ['open', 'closed', 'normal', 'abnormal'],
      dataset_suggestions: ['正负样本比例保持平衡', '覆盖同一部件的不同拍摄距离与角度'],
      evaluation_metric_suggestions: ['accuracy', 'f1'],
      rationale: '需求更像状态判断，采用分类任务更轻量。',
      source: 'rule'
    };
  }

  return {
    task_type: 'detection',
    recommended_framework: 'yolo',
    recommended_annotation_type: 'bbox',
    annotation_type: 'bbox',
    label_hints: ['defect', 'scratch', 'component'],
    dataset_suggestions: ['先做目标框标注并建立统一标签定义', '样本覆盖白天/夜晚/运动模糊等场景'],
    evaluation_metric_suggestions: ['map', 'precision', 'recall'],
    rationale: '默认走检测任务，适合多数目标定位类需求。',
    source: 'rule'
  };
};

const parseDraftFromLlmText = (text: string): RequirementTaskDraft | null => {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fencedMatch?.[1]?.trim() || trimmed;

  try {
    const parsed = JSON.parse(jsonText) as Partial<RequirementTaskDraft>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const annotationTypeCandidate =
      parsed.recommended_annotation_type ?? parsed.annotation_type;
    if (
      !isTaskType(parsed.task_type) ||
      !isModelFramework(parsed.recommended_framework) ||
      !isRequirementAnnotationType(annotationTypeCandidate)
    ) {
      return null;
    }

    return {
      task_type: parsed.task_type,
      recommended_framework: parsed.recommended_framework,
      recommended_annotation_type: annotationTypeCandidate,
      annotation_type: annotationTypeCandidate,
      label_hints: Array.isArray(parsed.label_hints)
        ? parsed.label_hints.map((item) => String(item)).filter(Boolean)
        : [],
      dataset_suggestions: Array.isArray(parsed.dataset_suggestions)
        ? parsed.dataset_suggestions.map((item) => String(item)).filter(Boolean)
        : [],
      evaluation_metric_suggestions: Array.isArray(parsed.evaluation_metric_suggestions)
        ? parsed.evaluation_metric_suggestions.map((item) => String(item)).filter(Boolean)
        : [],
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : 'LLM generated draft.',
      source: 'llm'
    };
  } catch {
    return null;
  }
};

const generateTaskDraftFromLlm = async (description: string, llmConfig: LlmConfig): Promise<RequirementTaskDraft | null> => {
  const response = await callConfiguredLlm(
    [
      '请根据下面需求生成任务草案，严格返回 JSON，不要输出额外文本。',
      '字段：task_type, recommended_framework, recommended_annotation_type, label_hints, dataset_suggestions, evaluation_metric_suggestions, rationale。',
      "task_type 只能是: ocr, detection, classification, segmentation, obb。",
      "recommended_framework 只能是: paddleocr, doctr, yolo。",
      "recommended_annotation_type 只能是: ocr_text, bbox, rotated_bbox, polygon, classification。",
      `需求：${description}`
    ].join('\n'),
    [],
    llmConfig
  );

  return parseDraftFromLlmText(response);
};

const getCurrentUserLlmConfigView = (): LlmConfigView => {
  const currentUser = findCurrentUser();
  const config = getStoredLlmConfigByUser(currentUser.id);

  return {
    enabled: config.enabled,
    provider: config.provider,
    base_url: config.base_url,
    model: config.model,
    temperature: config.temperature,
    has_api_key: Boolean(config.api_key),
    api_key_masked: maskApiKey(config.api_key)
  };
};

const getCurrentRuntimeSettingsView = (): RuntimeSettingsView => {
  const record = getCurrentRuntimeSettingsRecord();
  const profiles = buildRuntimeProfiles(record);
  return {
    updated_at: record.updated_at,
    active_profile_id: record.active_profile_id,
    available_profiles: profiles.map((item) => toRuntimeProfileView(item)),
    frameworks: {
      paddleocr: {
        endpoint: record.frameworks.paddleocr.endpoint,
        local_train_command: record.frameworks.paddleocr.local_train_command,
        local_predict_command: record.frameworks.paddleocr.local_predict_command,
        has_api_key: Boolean(record.frameworks.paddleocr.api_key),
        api_key_masked: maskApiKey(record.frameworks.paddleocr.api_key)
      },
      doctr: {
        endpoint: record.frameworks.doctr.endpoint,
        local_train_command: record.frameworks.doctr.local_train_command,
        local_predict_command: record.frameworks.doctr.local_predict_command,
        has_api_key: Boolean(record.frameworks.doctr.api_key),
        api_key_masked: maskApiKey(record.frameworks.doctr.api_key)
      },
      yolo: {
        endpoint: record.frameworks.yolo.endpoint,
        local_train_command: record.frameworks.yolo.local_train_command,
        local_predict_command: record.frameworks.yolo.local_predict_command,
        has_api_key: Boolean(record.frameworks.yolo.api_key),
        api_key_masked: maskApiKey(record.frameworks.yolo.api_key)
      }
    },
    controls: {
      python_bin: record.controls.python_bin,
      disable_simulated_train_fallback: record.controls.disable_simulated_train_fallback,
      disable_inference_fallback: record.controls.disable_inference_fallback
    }
  };
};

const getEffectiveConversationLlmConfig = (override?: LlmConfig | null): LlmConfig | null => {
  if (override) {
    return normalizeLlmConfig(override);
  }

  const currentUser = findCurrentUser();
  const config = getStoredLlmConfigByUser(currentUser.id);
  if (!config.enabled) {
    return null;
  }
  return config;
};

type ConversationActionResolution = {
  content: string;
  metadata: MessageMetadata;
};

const hasChineseText = (value: string): boolean => /[\u4e00-\u9fff]/.test(value);

const compactWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sanitizeCapturedValue = (value: string): string =>
  compactWhitespace(value)
    .replace(/^[`"'“”]+/, '')
    .replace(/[`"'“”]+$/, '')
    .replace(/[。！？.!?]+$/, '')
    .trim();

const extractPatternValue = (text: string, patterns: RegExp[]): string => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = sanitizeCapturedValue(match?.[1] ?? '');
    if (candidate) {
      return candidate;
    }
  }
  return '';
};

const extractQuotedValue = (text: string): string =>
  extractPatternValue(text, [/[“"'`](.{2,80}?)[”"'`]/]);

const detectConversationActionType = (text: string): ConversationActionMetadata['action'] | null => {
  const looksLikeQuestion =
    /(如何|怎么|what is|what are|why|解释|介绍)/i.test(text) &&
    !/(帮我|请|直接|现在|立即|马上)/i.test(text);
  const hasCreateIntent =
    /(创建|新建|建立|帮我建|帮我创建|生成|create|set up|setup|start)/i.test(text);
  const hasDirectExecutionIntent = /(帮我|请|直接|现在|立即|马上|run|train|启动)/i.test(text);

  if (looksLikeQuestion) {
    return null;
  }

  if (
    (hasCreateIntent || hasDirectExecutionIntent) &&
    /(训练任务|训练|微调|train(?:ing)? job|fine[- ]?tune|training)/i.test(text)
  ) {
    return 'create_training_job';
  }

  if (hasCreateIntent && /(数据集|dataset)/i.test(text)) {
    return 'create_dataset';
  }

  if (hasCreateIntent && /(模型草稿|模型|model draft|model)/i.test(text)) {
    return 'create_model_draft';
  }

  return null;
};

const detectCancelIntent = (text: string): boolean =>
  /(取消|算了|不用了|先不用|停止|cancel|never mind|forget it)/i.test(text);

const confirmationPhraseZh = '确认执行';
const confirmationPhraseEn = 'confirm execute';

const normalizeConfirmationToken = (text: string): string =>
  compactWhitespace(text)
    .toLowerCase()
    .replace(/[“”"'`]/g, '')
    .replace(/[。.!！?？]+$/g, '');

const matchRequiredConfirmationPhrase = (text: string, confirmationPhrase: string): boolean => {
  const normalizedText = normalizeConfirmationToken(text);
  const normalizedPhrase = normalizeConfirmationToken(confirmationPhrase);
  if (!normalizedText || !normalizedPhrase) {
    return false;
  }
  return normalizedText === normalizedPhrase;
};

const detectExecutionConfirmation = (text: string): boolean =>
  /(确认执行|确认开始|确认创建|同意执行|确认提交|confirm execute|confirm run|yes, execute|approved, run)/i.test(
    text
  );

const resolveConversationConfirmation = (
  text: string,
  pendingAction: ConversationActionMetadata | null
): boolean => {
  if (pendingAction?.requires_confirmation && pendingAction.confirmation_phrase) {
    return matchRequiredConfirmationPhrase(text, pendingAction.confirmation_phrase);
  }
  return detectExecutionConfirmation(text);
};

const inferTaskTypeFromText = (text: string): TaskType | null => {
  if (/(obb|rotated box|rotated bbox|旋转框|旋转目标)/i.test(text)) {
    return 'obb';
  }
  if (/(segmentation|segment|polygon|mask|分割|多边形)/i.test(text)) {
    return 'segmentation';
  }
  if (/(classification|classify|分类)/i.test(text)) {
    return 'classification';
  }
  if (/(ocr|文字|文本|serial number|read text|text line|车号|编号|识别)/i.test(text)) {
    return 'ocr';
  }
  if (/(detection|detect|bbox|检测|框选)/i.test(text)) {
    return 'detection';
  }
  return null;
};

const inferFrameworkFromText = (text: string): ModelFramework | null => {
  if (/paddleocr/i.test(text)) {
    return 'paddleocr';
  }
  if (/doctr/i.test(text)) {
    return 'doctr';
  }
  if (/yolo/i.test(text)) {
    return 'yolo';
  }
  return null;
};

const inferVisibilityFromText = (
  text: string
): CreateModelDraftInput['visibility'] | null => {
  if (/(公开|public)/i.test(text)) {
    return 'public';
  }
  if (/(工作区|workspace)/i.test(text)) {
    return 'workspace';
  }
  if (/(私有|private)/i.test(text)) {
    return 'private';
  }
  return null;
};

const inferActionNameFromText = (text: string): string =>
  extractPatternValue(text, [
    /(?:名字叫|名称叫|叫|命名为|名称(?:是|为)?|名字(?:是|为)?|named|called|name\s*(?:is|as)?)[：:\s]*[“"'`]?([^”"'`\n，。,；;]+)/i
  ]) || extractQuotedValue(text);

const inferDescriptionFromText = (text: string): string =>
  extractPatternValue(text, [
    /(?:描述(?:是|为)?|description(?:\s+is)?|用于|用来)[：:\s]*([^\n]+)/i
  ]);

const inferLabelClassesFromText = (text: string): string[] => {
  const raw = extractPatternValue(text, [
    /(?:labels?|label classes|标签(?:类别)?|类别)[：:\s]*([^\n]+)/i
  ]);

  if (!raw) {
    return [];
  }

  return Array.from(
    new Set(
      raw
        .split(/[，,、;；|]/)
        .map((item) => sanitizeCapturedValue(item))
        .filter(Boolean)
    )
  ).slice(0, 12);
};

const inferDatasetReferenceFromText = (text: string): string =>
  extractPatternValue(text, [
    /\b(d-\d+)\b/i,
    /(?:数据集|dataset)(?:是|为|:|：)?\s*[“"'`]?([^”"'`\n，。,；;]+)/i,
    /(?:用|使用|就用|选择|选用)\s*[“"'`]?([^”"'`\n，。,；;]+?)(?:数据集|dataset)?(?:$|[，。,；;\n])/i
  ]) || (compactWhitespace(text).length <= 48 ? extractQuotedValue(text) : '');

const inferBaseModelFromText = (text: string): string =>
  extractPatternValue(text, [
    /(?:base model|基座模型|基础模型|预训练模型|base_model)[：:\s]*([^\s，。,；;]+)/i
  ]);

const inferDatasetVersionIdFromText = (text: string): string =>
  extractPatternValue(text, [/\b(dv-\d+)\b/i]);

const inferNumericConfigFromText = (text: string): Record<string, string> => {
  const epochs = extractPatternValue(text, [/(?:epochs?|轮次)[：:\s]*([0-9]+)/i]);
  const batchSize = extractPatternValue(text, [/(?:batch size|batch_size|批大小)[：:\s]*([0-9]+)/i]);
  const learningRate = extractPatternValue(text, [/(?:learning rate|lr|学习率)[：:\s]*([0-9.]+)/i]);
  const warmupRatio = extractPatternValue(text, [/(?:warmup ratio|warmup|预热比例)[：:\s]*([0-9.]+)/i]);
  const weightDecay = extractPatternValue(text, [/(?:weight decay|权重衰减)[：:\s]*([0-9.]+)/i]);

  return Object.fromEntries(
    Object.entries({
      epochs,
      batch_size: batchSize,
      learning_rate: learningRate,
      warmup_ratio: warmupRatio,
      weight_decay: weightDecay
    }).filter(([, value]) => Boolean(value))
  );
};

const listAccessibleDatasetsForConversation = (currentUser: User): DatasetRecord[] =>
  datasets.filter((dataset) => currentUser.role === 'admin' || dataset.owner_user_id === currentUser.id);

const normalizeSearchToken = (value: string): string =>
  compactWhitespace(value).toLowerCase().replace(/[“”"'`]/g, '');

const formatDatasetSuggestion = (dataset: DatasetRecord): string =>
  `${dataset.name} (${dataset.id})`;

const hasTrainingReadyTrainSplit = (version: DatasetVersionRecord): boolean =>
  version.split_summary.train > 0;

const hasTrainingReadyAnnotationCoverage = (version: DatasetVersionRecord): boolean =>
  version.annotation_coverage > 0;

const isDatasetVersionTrainingReady = (version: DatasetVersionRecord): boolean =>
  hasTrainingReadyTrainSplit(version) && hasTrainingReadyAnnotationCoverage(version);

const listDatasetVersionsForTraining = (datasetId: string): DatasetVersionRecord[] =>
  [...datasetVersions]
    .filter((version) => version.dataset_id === datasetId)
    .filter((version) => isDatasetVersionTrainingReady(version))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));

const formatDatasetVersionSuggestion = (version: DatasetVersionRecord): string =>
  `${version.version_name} (${version.id})`;

const findDatasetVersionForTraining = (
  datasetId: string,
  reference: string
): DatasetVersionRecord | null => {
  const normalizedReference = normalizeSearchToken(reference);
  if (!normalizedReference) {
    return null;
  }

  const candidates = listDatasetVersionsForTraining(datasetId);
  return (
    candidates.find((version) => version.id.toLowerCase() === normalizedReference) ??
    candidates.find((version) => normalizeSearchToken(version.version_name) === normalizedReference) ??
    null
  );
};

const findDatasetByReference = (
  reference: string,
  currentUser: User
): { dataset: DatasetRecord | null; matches: DatasetRecord[] } => {
  const accessible = listAccessibleDatasetsForConversation(currentUser);
  const normalizedReference = normalizeSearchToken(reference);
  if (!normalizedReference) {
    return { dataset: null, matches: [] };
  }

  const byId = accessible.find((dataset) => dataset.id.toLowerCase() === normalizedReference) ?? null;
  if (byId) {
    return { dataset: byId, matches: [byId] };
  }

  const exactNameMatches = accessible.filter(
    (dataset) => normalizeSearchToken(dataset.name) === normalizedReference
  );
  if (exactNameMatches.length === 1) {
    return { dataset: exactNameMatches[0] ?? null, matches: exactNameMatches };
  }

  const partialMatches = accessible.filter((dataset) =>
    normalizeSearchToken(dataset.name).includes(normalizedReference)
  );
  if (partialMatches.length === 1) {
    return { dataset: partialMatches[0] ?? null, matches: partialMatches };
  }

  return {
    dataset: null,
    matches: exactNameMatches.length > 1 ? exactNameMatches : partialMatches
  };
};

const isTaskTypeValue = (value: string): value is TaskType =>
  value === 'ocr' ||
  value === 'detection' ||
  value === 'classification' ||
  value === 'segmentation' ||
  value === 'obb';

const isFrameworkValue = (value: string): value is ModelFramework =>
  value === 'paddleocr' || value === 'doctr' || value === 'yolo';

const normalizeCollectedFields = (input: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key, sanitizeCapturedValue(value)] as const)
      .filter(([, value]) => Boolean(value))
  );

const getPendingConversationAction = (conversationId: string): ConversationActionMetadata | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.conversation_id !== conversationId) {
      continue;
    }

    const action = message.metadata?.conversation_action;
    if (!action) {
      continue;
    }

    if (action.status === 'requires_input') {
      return action;
    }

    if (action.status === 'completed' || action.status === 'failed' || action.status === 'cancelled') {
      return null;
    }
  }

  return null;
};

const buildActionSummary = (
  action: ConversationActionMetadata['action'],
  status: ConversationActionMetadata['status'],
  inputText: string,
  detail: string
): string => {
  const chinese = hasChineseText(inputText);
  if (action === 'create_training_job') {
    if (status === 'requires_input') {
      return chinese
        ? `我可以继续创建训练任务，但还缺少这些信息：${detail}`
        : `I can continue creating the training job, but I still need: ${detail}`;
    }
    if (status === 'completed') {
      return chinese ? `训练任务已创建：${detail}` : `Training job created: ${detail}`;
    }
    if (status === 'cancelled') {
      return chinese ? '已取消这次训练任务创建。' : 'Cancelled this training-job creation flow.';
    }
    return chinese ? `训练任务创建失败：${detail}` : `Training job creation failed: ${detail}`;
  }

  if (action === 'create_dataset') {
    if (status === 'requires_input') {
      return chinese
        ? `我可以继续创建数据集，但还缺少这些信息：${detail}`
        : `I can continue creating the dataset, but I still need: ${detail}`;
    }
    if (status === 'completed') {
      return chinese ? `数据集已创建：${detail}` : `Dataset created: ${detail}`;
    }
    if (status === 'cancelled') {
      return chinese ? '已取消这次数据集创建。' : 'Cancelled this dataset-creation flow.';
    }
    return chinese ? `数据集创建失败：${detail}` : `Dataset creation failed: ${detail}`;
  }

  if (status === 'requires_input') {
    return chinese
      ? `我可以继续创建模型草稿，但还缺少这些信息：${detail}`
      : `I can continue creating the model draft, but I still need: ${detail}`;
  }
  if (status === 'completed') {
    return chinese ? `模型草稿已创建：${detail}` : `Model draft created: ${detail}`;
  }
  if (status === 'cancelled') {
    return chinese ? '已取消这次模型草稿创建。' : 'Cancelled this model-draft creation flow.';
  }
  return chinese ? `模型草稿创建失败：${detail}` : `Model draft creation failed: ${detail}`;
};

const parseConsolePayloadParams = (payloadJson: string): Record<string, unknown> => {
  if (!payloadJson.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(payloadJson) as { params?: Record<string, unknown> };
    return parsed.params && typeof parsed.params === 'object' ? parsed.params : {};
  } catch {
    return {};
  }
};

const buildConsoleActionLinks = (
  api: string,
  params: Record<string, unknown>,
  chinese: boolean
): Array<{ label: string; href: string }> => {
  const datasetId = typeof params.dataset_id === 'string' ? params.dataset_id : '';
  const modelVersionId = typeof params.model_version_id === 'string' ? params.model_version_id : '';
  const links: Record<string, Array<{ label: string; href: string }>> = {
    list_datasets: [{ label: chinese ? '打开数据集' : 'Open Datasets', href: '/datasets' }],
    create_dataset: [{ label: chinese ? '打开数据集' : 'Open Datasets', href: '/datasets' }],
    create_dataset_version: [
      {
        label: chinese ? '打开数据集详情' : 'Open Dataset Detail',
        href: datasetId ? `/datasets/${datasetId}` : '/datasets'
      }
    ],
    list_dataset_annotations: [
      {
        label: chinese ? '打开标注工作台' : 'Open Annotation Workspace',
        href: datasetId ? `/datasets/${datasetId}/annotate` : '/datasets'
      }
    ],
    export_dataset_annotations: [
      {
        label: chinese ? '打开标注工作台' : 'Open Annotation Workspace',
        href: datasetId ? `/datasets/${datasetId}/annotate` : '/datasets'
      }
    ],
    import_dataset_annotations: [
      {
        label: chinese ? '打开标注工作台' : 'Open Annotation Workspace',
        href: datasetId ? `/datasets/${datasetId}/annotate` : '/datasets'
      }
    ],
    upsert_dataset_annotation: [{ label: chinese ? '打开标注工作台' : 'Open Annotation Workspace', href: '/datasets' }],
    review_dataset_annotation: [{ label: chinese ? '打开标注工作台' : 'Open Annotation Workspace', href: '/datasets' }],
    run_dataset_pre_annotations: [
      {
        label: chinese ? '打开标注工作台' : 'Open Annotation Workspace',
        href: datasetId ? `/datasets/${datasetId}/annotate` : '/datasets'
      }
    ],
    list_training_jobs: [{ label: chinese ? '打开训练任务' : 'Open Training Jobs', href: '/training/jobs' }],
    create_training_job: [{ label: chinese ? '打开训练任务' : 'Open Training Jobs', href: '/training/jobs' }],
    cancel_training_job: [{ label: chinese ? '打开训练任务' : 'Open Training Jobs', href: '/training/jobs' }],
    retry_training_job: [{ label: chinese ? '打开训练任务' : 'Open Training Jobs', href: '/training/jobs' }],
    list_model_versions: [{ label: chinese ? '打开模型版本' : 'Open Model Versions', href: '/models/versions' }],
    register_model_version: [{ label: chinese ? '打开模型版本' : 'Open Model Versions', href: '/models/versions' }],
    run_inference: [
      {
        label: chinese ? '打开推理验证' : 'Open Inference Validation',
        href: modelVersionId ? `/inference/validate?modelVersion=${encodeURIComponent(modelVersionId)}` : '/inference/validate'
      }
    ],
    send_inference_feedback: [{ label: chinese ? '打开推理验证' : 'Open Inference Validation', href: '/inference/validate' }]
  };
  return links[api] ?? [];
};

const toActionMetadata = (
  action: ConversationActionMetadata['action'],
  status: ConversationActionMetadata['status'],
  summary: string,
  collectedFields: Record<string, string>,
  options?: {
    missingFields?: string[];
    suggestions?: string[];
    requiresConfirmation?: boolean;
    confirmationPhrase?: string | null;
    createdEntityType?: ConversationActionMetadata['created_entity_type'];
    createdEntityId?: string | null;
    createdEntityLabel?: string | null;
    actionLinks?: Array<{ label: string; href: string }>;
  }
): MessageMetadata => {
  const normalizedCollectedFields = normalizeCollectedFields(collectedFields);
  const api = action === 'console_api_call' ? normalizedCollectedFields.api ?? '' : '';
  const payloadParams =
    action === 'console_api_call'
      ? parseConsolePayloadParams(normalizedCollectedFields.payload_json ?? '')
      : {};
  const autoActionLinks =
    action === 'console_api_call'
      ? buildConsoleActionLinks(api, payloadParams, hasChineseText(summary))
      : [];
  return {
    conversation_action: {
      action,
      status,
      summary,
      missing_fields: options?.missingFields ?? [],
      collected_fields: normalizedCollectedFields,
      action_links: options?.actionLinks ?? autoActionLinks,
      suggestions: options?.suggestions ?? [],
      requires_confirmation: options?.requiresConfirmation ?? false,
      confirmation_phrase: options?.confirmationPhrase ?? null,
      created_entity_type: options?.createdEntityType ?? null,
      created_entity_id: options?.createdEntityId ?? null,
      created_entity_label: options?.createdEntityLabel ?? null
    }
  };
};

const resolveCreateTrainingJobAction = async (
  content: string,
  currentUser: User,
  pendingAction: ConversationActionMetadata | null
): Promise<ConversationActionResolution> => {
  const inferredDatasetVersionId = inferDatasetVersionIdFromText(content);
  const inferredDatasetReference = inferDatasetReferenceFromText(content);
  const confirmed = resolveConversationConfirmation(content, pendingAction);
  const numericFields = {
    ...(pendingAction?.collected_fields ?? {}),
    ...inferNumericConfigFromText(content)
  };
  const collectedFields = normalizeCollectedFields({
    ...(pendingAction?.collected_fields ?? {}),
    task_type: inferTaskTypeFromText(content) ?? pendingAction?.collected_fields.task_type ?? '',
    framework: inferFrameworkFromText(content) ?? pendingAction?.collected_fields.framework ?? '',
    name: inferActionNameFromText(content) || pendingAction?.collected_fields.name || '',
    dataset_reference:
      (inferredDatasetVersionId && inferredDatasetReference === inferredDatasetVersionId
        ? ''
        : inferredDatasetReference) || pendingAction?.collected_fields.dataset_reference || '',
    dataset_version_id:
      inferredDatasetVersionId || pendingAction?.collected_fields.dataset_version_id || '',
    base_model: inferBaseModelFromText(content) || pendingAction?.collected_fields.base_model || '',
    epochs: numericFields.epochs ?? '',
    batch_size: numericFields.batch_size ?? '',
    learning_rate: numericFields.learning_rate ?? '',
    warmup_ratio: numericFields.warmup_ratio ?? '',
    weight_decay: numericFields.weight_decay ?? '',
    confirmed: confirmed ? 'true' : pendingAction?.collected_fields.confirmed ?? ''
  });

  const datasetLookup = findDatasetByReference(collectedFields.dataset_reference ?? '', currentUser);
  const taskTypeCandidate =
    collectedFields.task_type && isTaskTypeValue(collectedFields.task_type)
      ? collectedFields.task_type
      : datasetLookup.dataset?.task_type ?? null;
  const frameworkCandidate =
    collectedFields.framework && isFrameworkValue(collectedFields.framework)
      ? collectedFields.framework
      : null;
  const validFrameworks: ModelFramework[] =
    taskTypeCandidate === 'ocr' ? ['paddleocr', 'doctr'] : taskTypeCandidate ? ['yolo'] : [];

  if ((collectedFields.dataset_reference ?? '') && !datasetLookup.dataset && datasetLookup.matches.length > 1) {
    const suggestions = datasetLookup.matches.slice(0, 5).map(formatDatasetSuggestion);
    const summary = buildActionSummary(
      'create_training_job',
      'requires_input',
      content,
      hasChineseText(content)
        ? '数据集匹配不唯一，请从建议列表里指定一个数据集名称或 ID。'
        : 'dataset selection is ambiguous. Please reply with one dataset name or ID from the suggestions.'
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'requires_input', summary, collectedFields, {
        missingFields: ['dataset_id'],
        suggestions
      })
    };
  }

  const missingFields: string[] = [];
  const suggestions: string[] = [];

  if (!datasetLookup.dataset) {
    missingFields.push('dataset_id');
    suggestions.push(
      ...listAccessibleDatasetsForConversation(currentUser)
        .filter((dataset) => !taskTypeCandidate || dataset.task_type === taskTypeCandidate)
        .slice(0, 5)
        .map(formatDatasetSuggestion)
    );
  }

  if (!taskTypeCandidate && !datasetLookup.dataset) {
    missingFields.push('task_type');
  }

  if (datasetLookup.dataset && taskTypeCandidate && datasetLookup.dataset.task_type !== taskTypeCandidate) {
    const summary = buildActionSummary(
      'create_training_job',
      'requires_input',
      content,
      hasChineseText(content)
        ? `当前数据集任务类型为 ${datasetLookup.dataset.task_type}，与请求不一致，请换一个数据集或明确改用匹配的任务类型。`
        : `selected dataset uses task type ${datasetLookup.dataset.task_type}. Please choose a matching dataset or revise the task type.`
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'requires_input', summary, collectedFields, {
        missingFields: ['dataset_id'],
        suggestions: listAccessibleDatasetsForConversation(currentUser)
          .filter((dataset) => dataset.task_type === taskTypeCandidate)
          .slice(0, 5)
          .map(formatDatasetSuggestion)
      })
    };
  }

  if (frameworkCandidate && taskTypeCandidate && !validFrameworks.includes(frameworkCandidate)) {
    const summary = buildActionSummary(
      'create_training_job',
      'requires_input',
      content,
      hasChineseText(content)
        ? `当前任务类型只支持这些框架：${validFrameworks.join(' / ')}`
        : `valid frameworks for this task are: ${validFrameworks.join(' / ')}`
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'requires_input', summary, collectedFields, {
        missingFields: ['framework'],
        suggestions: validFrameworks
      })
    };
  }

  if (missingFields.length > 0) {
    const summary = buildActionSummary('create_training_job', 'requires_input', content, missingFields.join(', '));
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'requires_input', summary, collectedFields, {
        missingFields,
        suggestions
      })
    };
  }

  const dataset = datasetLookup.dataset;
  if (!dataset || !taskTypeCandidate) {
    const summary = buildActionSummary(
      'create_training_job',
      'failed',
      content,
      hasChineseText(content) ? '无法解析训练任务所需的基础信息。' : 'unable to resolve training inputs.'
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'failed', summary, collectedFields)
    };
  }

  const datasetVersionSuggestions = listDatasetVersionsForTraining(dataset.id)
    .slice(0, 5)
    .map(formatDatasetVersionSuggestion);

  if (datasetVersionSuggestions.length === 0) {
    const summary = buildActionSummary(
      'create_training_job',
      'requires_input',
      content,
      hasChineseText(content)
        ? '当前数据集没有满足训练条件的版本，请先创建版本并确保 train 切分与标注覆盖率都大于 0。'
        : 'selected dataset has no training-ready version yet. Please create a dataset version with train split and positive annotation coverage.'
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'requires_input', summary, collectedFields, {
        missingFields: ['dataset_version_id']
      })
    };
  }

  if (!collectedFields.dataset_version_id) {
    const summary = buildActionSummary(
      'create_training_job',
      'requires_input',
      content,
      hasChineseText(content)
        ? '请指定要训练的数据集版本。'
        : 'please specify the dataset version snapshot to train on.'
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'requires_input', summary, collectedFields, {
        missingFields: ['dataset_version_id'],
        suggestions: datasetVersionSuggestions
      })
    };
  }

  const datasetVersion = findDatasetVersionForTraining(dataset.id, collectedFields.dataset_version_id);
  if (!datasetVersion) {
    const summary = buildActionSummary(
      'create_training_job',
      'requires_input',
      content,
      hasChineseText(content)
        ? '指定的数据集版本不可用，请从建议列表中选择一个版本。'
        : 'dataset version is unavailable. Please choose one version from the suggestions.'
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'requires_input', summary, collectedFields, {
        missingFields: ['dataset_version_id'],
        suggestions: datasetVersionSuggestions
      })
    };
  }

  const finalFramework =
    frameworkCandidate ?? (taskTypeCandidate === 'ocr' ? 'paddleocr' : 'yolo');
  const finalName =
    collectedFields.name || `${dataset.name}-${taskTypeCandidate}-job-${Date.now().toString().slice(-6)}`;
  const finalBaseModel = collectedFields.base_model || `${finalFramework}-base`;
  const finalConfig = {
    epochs: collectedFields.epochs || '20',
    batch_size: collectedFields.batch_size || '16',
    learning_rate: collectedFields.learning_rate || '0.001',
    warmup_ratio: collectedFields.warmup_ratio || '0.1',
    weight_decay: collectedFields.weight_decay || '0.0001'
  };

  if (collectedFields.confirmed !== 'true') {
    const confirmationPhrase = hasChineseText(content) ? confirmationPhraseZh : confirmationPhraseEn;
    const summary = hasChineseText(content)
      ? `训练任务参数已就绪。若要真正创建任务，请回复“${confirmationPhrase}”。`
      : `Training job parameters are ready. Reply "${confirmationPhrase}" to execute.`;
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'requires_input', summary, collectedFields, {
        missingFields: ['confirmation'],
        requiresConfirmation: true,
        confirmationPhrase
      })
    };
  }

  try {
    const created = await createTrainingJob({
      name: finalName,
      task_type: taskTypeCandidate,
      framework: finalFramework,
      dataset_id: dataset.id,
      dataset_version_id: datasetVersion.id,
      base_model: finalBaseModel,
      config: finalConfig
    });
    const completedFields = normalizeCollectedFields({
      ...collectedFields,
      dataset_id: dataset.id,
      dataset_name: dataset.name,
      dataset_version_id: datasetVersion.id,
      task_type: taskTypeCandidate,
      framework: finalFramework,
      name: created.name,
      base_model: finalBaseModel
    });
    const summary = buildActionSummary(
      'create_training_job',
      'completed',
      content,
      `${created.name} (${created.id})`
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'completed', summary, completedFields, {
        createdEntityType: 'TrainingJob',
        createdEntityId: created.id,
        createdEntityLabel: created.name
      })
    };
  } catch (error) {
    const summary = buildActionSummary(
      'create_training_job',
      'failed',
      content,
      (error as Error).message
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_training_job', 'failed', summary, {
        ...collectedFields,
        dataset_id: dataset.id,
        dataset_name: dataset.name,
        task_type: taskTypeCandidate,
        framework: finalFramework,
        name: finalName
      })
    };
  }
};

const resolveCreateDatasetAction = async (
  content: string,
  pendingAction: ConversationActionMetadata | null
): Promise<ConversationActionResolution> => {
  const confirmed = resolveConversationConfirmation(content, pendingAction);
  const collectedFields = normalizeCollectedFields({
    ...(pendingAction?.collected_fields ?? {}),
    name: inferActionNameFromText(content) || pendingAction?.collected_fields.name || '',
    task_type:
      inferTaskTypeFromText(content) ?? pendingAction?.collected_fields.task_type ?? '',
    description:
      inferDescriptionFromText(content) || pendingAction?.collected_fields.description || '',
    label_classes:
      inferLabelClassesFromText(content).join(', ') || pendingAction?.collected_fields.label_classes || '',
    confirmed: confirmed ? 'true' : pendingAction?.collected_fields.confirmed ?? ''
  });

  const missingFields: string[] = [];
  if (!collectedFields.name) {
    missingFields.push('name');
  }
  if (!collectedFields.task_type || !isTaskTypeValue(collectedFields.task_type)) {
    missingFields.push('task_type');
  }

  if (missingFields.length > 0) {
    const summary = buildActionSummary('create_dataset', 'requires_input', content, missingFields.join(', '));
    return {
      content: summary,
      metadata: toActionMetadata('create_dataset', 'requires_input', summary, collectedFields, {
        missingFields
      })
    };
  }

  const taskType = collectedFields.task_type as TaskType;
  const description =
    collectedFields.description ||
    (hasChineseText(content)
      ? `由对话请求创建：${content.slice(0, 120)}`
      : `Created from conversation request: ${content.slice(0, 120)}`);
  const labelClasses = collectedFields.label_classes
    ? collectedFields.label_classes.split(/[，,、;；|]/).map((item) => sanitizeCapturedValue(item)).filter(Boolean)
    : [];

  if (collectedFields.confirmed !== 'true') {
    const confirmationPhrase = hasChineseText(content) ? confirmationPhraseZh : confirmationPhraseEn;
    const summary = hasChineseText(content)
      ? `数据集参数已就绪。若要真正创建数据集，请回复“${confirmationPhrase}”。`
      : `Dataset parameters are ready. Reply "${confirmationPhrase}" to execute.`;
    return {
      content: summary,
      metadata: toActionMetadata('create_dataset', 'requires_input', summary, collectedFields, {
        missingFields: ['confirmation'],
        requiresConfirmation: true,
        confirmationPhrase
      })
    };
  }

  try {
    const created = await createDataset({
      name: collectedFields.name,
      description,
      task_type: taskType,
      label_schema: {
        classes: labelClasses
      }
    });
    const completedFields = normalizeCollectedFields({
      ...collectedFields,
      description,
      task_type: taskType,
      label_classes: labelClasses.join(', ')
    });
    const summary = buildActionSummary(
      'create_dataset',
      'completed',
      content,
      `${created.name} (${created.id})`
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_dataset', 'completed', summary, completedFields, {
        createdEntityType: 'Dataset',
        createdEntityId: created.id,
        createdEntityLabel: created.name
      })
    };
  } catch (error) {
    const summary = buildActionSummary('create_dataset', 'failed', content, (error as Error).message);
    return {
      content: summary,
      metadata: toActionMetadata('create_dataset', 'failed', summary, {
        ...collectedFields,
        description
      })
    };
  }
};

const resolveCreateModelDraftAction = async (
  content: string,
  pendingAction: ConversationActionMetadata | null
): Promise<ConversationActionResolution> => {
  const confirmed = resolveConversationConfirmation(content, pendingAction);
  const collectedFields = normalizeCollectedFields({
    ...(pendingAction?.collected_fields ?? {}),
    name: inferActionNameFromText(content) || pendingAction?.collected_fields.name || '',
    model_type:
      inferTaskTypeFromText(content) ?? pendingAction?.collected_fields.model_type ?? '',
    description:
      inferDescriptionFromText(content) || pendingAction?.collected_fields.description || '',
    visibility:
      inferVisibilityFromText(content) ?? pendingAction?.collected_fields.visibility ?? '',
    confirmed: confirmed ? 'true' : pendingAction?.collected_fields.confirmed ?? ''
  });

  const missingFields: string[] = [];
  if (!collectedFields.name) {
    missingFields.push('name');
  }
  if (!collectedFields.model_type || !isTaskTypeValue(collectedFields.model_type)) {
    missingFields.push('model_type');
  }

  if (missingFields.length > 0) {
    const summary = buildActionSummary('create_model_draft', 'requires_input', content, missingFields.join(', '));
    return {
      content: summary,
      metadata: toActionMetadata('create_model_draft', 'requires_input', summary, collectedFields, {
        missingFields,
        suggestions: ['private', 'workspace', 'public']
      })
    };
  }

  const description =
    collectedFields.description ||
    (hasChineseText(content)
      ? `由对话请求创建：${content.slice(0, 120)}`
      : `Created from conversation request: ${content.slice(0, 120)}`);
  const visibility =
    collectedFields.visibility === 'public' ||
    collectedFields.visibility === 'workspace' ||
    collectedFields.visibility === 'private'
      ? collectedFields.visibility
      : 'private';

  if (collectedFields.confirmed !== 'true') {
    const confirmationPhrase = hasChineseText(content) ? confirmationPhraseZh : confirmationPhraseEn;
    const summary = hasChineseText(content)
      ? `模型草稿参数已就绪。若要真正创建模型草稿，请回复“${confirmationPhrase}”。`
      : `Model draft parameters are ready. Reply "${confirmationPhrase}" to execute.`;
    return {
      content: summary,
      metadata: toActionMetadata('create_model_draft', 'requires_input', summary, collectedFields, {
        missingFields: ['confirmation'],
        requiresConfirmation: true,
        confirmationPhrase
      })
    };
  }

  try {
    const created = await createModelDraft({
      name: collectedFields.name,
      description,
      model_type: collectedFields.model_type as TaskType,
      visibility
    });
    const completedFields = normalizeCollectedFields({
      ...collectedFields,
      description,
      visibility,
      model_type: created.model_type
    });
    const summary = buildActionSummary(
      'create_model_draft',
      'completed',
      content,
      `${created.name} (${created.id})`
    );
    return {
      content: summary,
      metadata: toActionMetadata('create_model_draft', 'completed', summary, completedFields, {
        createdEntityType: 'Model',
        createdEntityId: created.id,
        createdEntityLabel: created.name
      })
    };
  } catch (error) {
    const summary = buildActionSummary('create_model_draft', 'failed', content, (error as Error).message);
    return {
      content: summary,
      metadata: toActionMetadata('create_model_draft', 'failed', summary, {
        ...collectedFields,
        description,
        visibility
      })
    };
  }
};

const detectConversationInferenceIntent = (content: string, attachmentIds: string[]): boolean => {
  if (attachmentIds.length === 0) {
    return false;
  }
  if (detectConversationActionType(content)) {
    return false;
  }
  return /(识别|推理|检测|ocr|read|predict|inference|analy[sz]e|请分析|帮我识别)/i.test(content);
};

const formatInferenceSummary = (run: InferenceRunRecord, inputText: string, attachmentLabel: string): string => {
  const chinese = hasChineseText(inputText);
  const output = run.normalized_output;
  const source = run.execution_source;
  if (run.task_type === 'ocr') {
    const lines = output.ocr.lines.map((item) => item.text).filter(Boolean).slice(0, 5);
    const detail = lines.length > 0 ? lines.join(' | ') : chinese ? '未返回可读文本。' : 'No OCR lines returned.';
    return chinese
      ? `已完成 OCR 推理（${source}）。文件：${attachmentLabel}。识别结果：${detail}`
      : `OCR inference completed (${source}). File: ${attachmentLabel}. Result: ${detail}`;
  }
  if (run.task_type === 'detection' || run.task_type === 'obb') {
    const count = output.boxes.length + output.rotated_boxes.length;
    return chinese
      ? `已完成目标检测推理（${source}）。文件：${attachmentLabel}。检测到 ${count} 个目标。`
      : `Detection inference completed (${source}). File: ${attachmentLabel}. Detected ${count} objects.`;
  }
  if (run.task_type === 'segmentation') {
    const count = output.polygons.length + output.masks.length;
    return chinese
      ? `已完成分割推理（${source}）。文件：${attachmentLabel}。分割结果 ${count} 项。`
      : `Segmentation inference completed (${source}). File: ${attachmentLabel}. Segmentation outputs: ${count}.`;
  }
  const top = output.labels[0];
  return chinese
    ? `已完成分类推理（${source}）。文件：${attachmentLabel}。Top-1：${top?.label ?? 'unknown'} (${top?.score ?? 0}).`
    : `Classification inference completed (${source}). File: ${attachmentLabel}. Top-1: ${top?.label ?? 'unknown'} (${top?.score ?? 0}).`;
};

const resolveConversationInferenceAction = async (
  conversation: ConversationRecord,
  content: string,
  attachmentIds: string[],
  currentUser: User
): Promise<ConversationActionResolution | null> => {
  if (!detectConversationInferenceIntent(content, attachmentIds)) {
    return null;
  }
  const model = assertModelAccess(conversation.model_id, currentUser);
  const taskType = model.model_type;
  const version = [...modelVersions]
    .filter((item) => item.model_id === model.id && item.status === 'registered' && item.task_type === taskType)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
  if (!version) {
    const chinese = hasChineseText(content);
    const summary = chinese
      ? '当前会话模型还没有可用的已注册版本，无法执行真实推理。请先完成训练并注册模型版本。'
      : 'No registered model version is available for this conversation model yet. Train/register a version first.';
    return {
      content: summary,
      metadata: toActionMetadata('run_model_inference', 'failed', summary, {
        model_id: model.id,
        task_type: taskType
      })
    };
  }
  const readyAttachment = attachments.find(
    (item) =>
      attachmentIds.includes(item.id) &&
      item.owner_user_id === currentUser.id &&
      item.status === 'ready'
  );
  if (!readyAttachment) {
    const chinese = hasChineseText(content);
    const summary = chinese
      ? '附件尚未 ready，暂时无法执行推理。请稍后重试。'
      : 'Attachment is not ready yet, inference cannot run right now. Please retry shortly.';
    return {
      content: summary,
      metadata: toActionMetadata('run_model_inference', 'failed', summary, {
        model_version_id: version.id
      })
    };
  }
  try {
    const run = await runInference({
      model_version_id: version.id,
      input_attachment_id: readyAttachment.id,
      task_type: taskType
    });
    const summary = formatInferenceSummary(run, content, readyAttachment.filename);
    return {
      content: summary,
      metadata: toActionMetadata('run_model_inference', 'completed', summary, {
        model_id: model.id,
        model_version_id: version.id,
        inference_run_id: run.id,
        task_type: taskType,
        execution_source: run.execution_source
      }, {
        createdEntityType: null,
        createdEntityId: run.id,
        createdEntityLabel: readyAttachment.filename
      })
    };
  } catch (error) {
    const chinese = hasChineseText(content);
    const summary = chinese ? `推理执行失败：${(error as Error).message}` : `Inference failed: ${(error as Error).message}`;
    return {
      content: summary,
      metadata: toActionMetadata('run_model_inference', 'failed', summary, {
        model_id: model.id,
        model_version_id: version.id,
        task_type: taskType
      })
    };
  }
};

const detectOcrExtractionIntent = (content: string): boolean =>
  /(提取|抽取|抓取|车号|车牌|数字|编号|serial|plate|number|extract)/i.test(content);

type ConsoleOpsPayload = {
  api: string;
  params?: Record<string, unknown>;
  confirm?: boolean;
};

const suggestDatasetRefs = (): string[] =>
  datasets.slice(0, 8).map((item) => `${item.name} (${item.id})`);

const suggestModelRefs = (): string[] =>
  models.slice(0, 8).map((item) => `${item.name} (${item.id})`);

const suggestTrainingJobRefs = (): string[] =>
  trainingJobs.slice(0, 8).map((item) => `${item.name} (${item.id})`);

const suggestInferenceRunRefs = (): string[] =>
  inferenceRuns.slice(0, 8).map((item) => `${item.id}`);

const suggestAttachmentRefs = (): string[] =>
  attachments
    .filter((item) => item.status === 'ready')
    .slice(0, 8)
    .map((item) => `${item.filename} (${item.id})`);

const suggestModelVersionRefs = (): string[] =>
  modelVersions.slice(0, 8).map((item) => `${item.version_name} (${item.id})`);

const resolveDatasetReference = (content: string): string => {
  const byId = extractPatternValue(content, [/\b(d-\d+)\b/i]);
  if (byId) {
    return byId;
  }
  const quoted = extractQuotedValue(content);
  const normalized = normalizeSearchToken(quoted);
  if (!normalized) {
    return '';
  }
  const matched = datasets.find((item) => normalizeSearchToken(item.name) === normalized);
  return matched?.id ?? '';
};

const resolveModelReference = (content: string): string => {
  const byId = extractPatternValue(content, [/\b(m-\d+)\b/i]);
  if (byId) {
    return byId;
  }
  const quoted = extractQuotedValue(content);
  const normalized = normalizeSearchToken(quoted);
  if (!normalized) {
    return '';
  }
  const matched = models.find((item) => normalizeSearchToken(item.name) === normalized);
  return matched?.id ?? '';
};

const resolveTrainingJobReference = (content: string): string => {
  const byId = extractPatternValue(content, [/\b(tj-[a-z0-9-]+)\b/i]);
  if (byId) {
    return byId;
  }
  const quoted = extractQuotedValue(content);
  const normalized = normalizeSearchToken(quoted);
  if (!normalized) {
    return '';
  }
  const matched = trainingJobs.find((item) => normalizeSearchToken(item.name) === normalized);
  return matched?.id ?? '';
};

const resolveModelVersionReference = (content: string): string => {
  const byId = extractPatternValue(content, [/\b(mv-\d+)\b/i]);
  if (byId) {
    return byId;
  }
  const quoted = extractQuotedValue(content);
  const normalized = normalizeSearchToken(quoted);
  if (!normalized) {
    return '';
  }
  const matched = modelVersions.find((item) => normalizeSearchToken(item.version_name) === normalized);
  return matched?.id ?? '';
};

const resolveDatasetItemReference = (content: string): string => {
  const byId = extractPatternValue(content, [/\b(di-[a-z0-9-]+)\b/i]);
  if (byId) {
    return byId;
  }
  return '';
};

const resolveAnnotationReference = (content: string): string => {
  const byId = extractPatternValue(content, [/\b(ann-[a-z0-9-]+)\b/i]);
  if (byId) {
    return byId;
  }
  return '';
};

const parseConsoleOpsPayload = (content: string): ConsoleOpsPayload | null => {
  const match = content.trim().match(/^\/ops\s+(\{[\s\S]+\})$/i);
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]) as ConsoleOpsPayload;
    if (!parsed || typeof parsed.api !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const extractEntityId = (text: string, pattern: RegExp): string =>
  extractPatternValue(text, [pattern]);

const buildNaturalConsoleOpsPayload = (
  content: string,
  pendingAction: ConversationActionMetadata | null
): ConsoleOpsPayload | null => {
  if (pendingAction?.action === 'console_api_call' && resolveConversationConfirmation(content, pendingAction)) {
    const raw = pendingAction.collected_fields.payload_json ?? '';
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ConsoleOpsPayload;
      return {
        ...parsed,
        confirm: true
      };
    } catch {
      return null;
    }
  }

  const lower = content.toLowerCase();
  const datasetId = extractEntityId(content, /\b(d-\d+)\b/i);
  const attachmentId = extractEntityId(content, /\b(f-\d+)\b/i);
  const runId = extractEntityId(content, /\b(ir-\d+)\b/i);
  const jobId = extractEntityId(content, /\b(tj-[a-z0-9-]+)\b/i);
  const modelId = extractEntityId(content, /\b(m-\d+)\b/i);
  const modelVersionId = extractEntityId(content, /\b(mv-\d+)\b/i);
  const taskType = inferTaskTypeFromText(content);
  const reviewStatus =
    /(通过|approved?|approve)/i.test(content) ? 'approved' : /(拒绝|驳回|rejected?|reject)/i.test(content) ? 'rejected' : '';

  if (/(查看|列出|list).*(训练任务|training job)/i.test(content)) {
    return { api: 'list_training_jobs' };
  }
  if (/(查看|列出|list).*(推理记录|inference run)/i.test(content)) {
    return { api: 'list_inference_runs' };
  }
  if (/(查看|列出|list).*(模型版本|model version)/i.test(content)) {
    return { api: 'list_model_versions' };
  }
  if (/(查看|列出|list).*(模型|models?)/i.test(content)) {
    return { api: 'list_models' };
  }
  if (/(查看|列出|list).*(数据集|dataset)/i.test(content)) {
    return { api: 'list_datasets' };
  }
  if (/(查看|列出|list).*(标注|annotation)/i.test(content) && datasetId) {
    return {
      api: 'list_dataset_annotations',
      params: {
        dataset_id: datasetId
      }
    };
  }
  if (/(导出|export).*(标注|annotation)/i.test(content) && datasetId) {
    return {
      api: 'export_dataset_annotations',
      params: {
        dataset_id: datasetId,
        format: /(ocr)/i.test(lower) ? 'ocr' : /(coco)/i.test(lower) ? 'coco' : /(labelme)/i.test(lower) ? 'labelme' : 'yolo'
      }
    };
  }
  if (/(导入|import).*(标注|annotation)/i.test(content) && datasetId && attachmentId) {
    return {
      api: 'import_dataset_annotations',
      params: {
        dataset_id: datasetId,
        attachment_id: attachmentId,
        format: /(ocr)/i.test(lower) ? 'ocr' : /(coco)/i.test(lower) ? 'coco' : /(labelme)/i.test(lower) ? 'labelme' : 'yolo'
      }
    };
  }
  if (/(预标注|pre-?annotat)/i.test(content) && datasetId && modelId) {
    return {
      api: 'run_dataset_pre_annotations',
      params: {
        dataset_id: datasetId,
        source_model_id: modelId,
        source_model_version_id: modelVersionId || undefined,
        task_type: taskType ?? 'detection'
      }
    };
  }
  if (/(运行推理|执行推理|run inference|inference)/i.test(content) && modelVersionId && attachmentId && taskType) {
    return {
      api: 'run_inference',
      params: {
        model_version_id: modelVersionId,
        input_attachment_id: attachmentId,
        task_type: taskType
      }
    };
  }
  if (/(反馈回流|inference feedback|反馈到数据集)/i.test(content) && runId && datasetId) {
    return {
      api: 'send_inference_feedback',
      params: {
        run_id: runId,
        dataset_id: datasetId,
        reason: inferDescriptionFromText(content) || 'feedback'
      }
    };
  }
  if (/(取消训练|cancel training)/i.test(content) && jobId) {
    return {
      api: 'cancel_training_job',
      params: { job_id: jobId }
    };
  }
  if (/(重试训练|retry training)/i.test(content) && jobId) {
    return {
      api: 'retry_training_job',
      params: { job_id: jobId }
    };
  }
  if (/(创建数据集版本|create dataset version)/i.test(content) && datasetId) {
    return {
      api: 'create_dataset_version',
      params: {
        dataset_id: datasetId,
        version_name: inferActionNameFromText(content) || undefined
      }
    };
  }
  if (/(注册模型版本|register model version)/i.test(content) && modelId && jobId) {
    return {
      api: 'register_model_version',
      params: {
        model_id: modelId,
        training_job_id: jobId,
        version_name: inferActionNameFromText(content) || `v-${Date.now().toString().slice(-6)}`
      }
    };
  }
  if (/(提交审批|submit approval)/i.test(content) && modelId) {
    return {
      api: 'submit_approval_request',
      params: {
        model_id: modelId,
        review_notes: inferDescriptionFromText(content) || '',
        parameter_snapshot: {}
      }
    };
  }
  if (/(激活.*runtime profile|activate runtime profile|切换 runtime profile)/i.test(content)) {
    const profileId = inferActionNameFromText(content) || extractQuotedValue(content);
    if (profileId) {
      return {
        api: 'activate_runtime_profile',
        params: {
          profile_id: profileId
        }
      };
    }
  }
  if (/(更新标注|写入标注|upsert annotation)/i.test(content)) {
    const datasetItemId = extractEntityId(content, /\b(di-[a-z0-9-]+)\b/i);
    if (datasetItemId && taskType) {
      return {
        api: 'upsert_dataset_annotation',
        params: {
          dataset_item_id: datasetItemId,
          task_type: taskType,
          source: 'manual',
          status: 'annotated',
          payload: {}
        }
      };
    }
  }
  if (/(审核标注|review annotation)/i.test(content)) {
    const annotationId = extractEntityId(content, /\b(ann-[a-z0-9-]+)\b/i);
    if (annotationId && reviewStatus) {
      return {
        api: 'review_dataset_annotation',
        params: {
          annotation_id: annotationId,
          status: reviewStatus
        }
      };
    }
  }
  return null;
};

const detectNaturalConsoleIntentMissingFields = (
  content: string
): { api: string; missingFields: string[] } | null => {
  const lower = content.toLowerCase();
  const hasDatasetId = /\b(d-\d+)\b/i.test(content);
  const hasAttachmentId = /\b(f-\d+)\b/i.test(content);
  const hasRunId = /\b(ir-\d+)\b/i.test(content);
  const hasJobId = /\b(tj-[a-z0-9-]+)\b/i.test(content);
  const hasModelId = /\b(m-\d+)\b/i.test(content);
  const hasModelVersionId = /\b(mv-\d+)\b/i.test(content);
  const taskType = inferTaskTypeFromText(content);
  const hasReviewStatus = /(通过|approved?|approve|拒绝|驳回|rejected?|reject)/i.test(content);

  if (/(取消训练|cancel training)/i.test(content) && !hasJobId) {
    return { api: 'cancel_training_job', missingFields: ['job_id'] };
  }
  if (/(重试训练|retry training)/i.test(content) && !hasJobId) {
    return { api: 'retry_training_job', missingFields: ['job_id'] };
  }
  if (/(查看|列出|list).*(标注|annotation)/i.test(content) && !hasDatasetId) {
    return { api: 'list_dataset_annotations', missingFields: ['dataset_id'] };
  }
  if (/(导出|export).*(标注|annotation)/i.test(content) && !hasDatasetId) {
    return { api: 'export_dataset_annotations', missingFields: ['dataset_id'] };
  }
  if (/(导入|import).*(标注|annotation)/i.test(content) && (!hasDatasetId || !hasAttachmentId)) {
    const missing = [];
    if (!hasDatasetId) {
      missing.push('dataset_id');
    }
    if (!hasAttachmentId) {
      missing.push('attachment_id');
    }
    return { api: 'import_dataset_annotations', missingFields: missing };
  }
  if (/(预标注|pre-?annotat)/i.test(content) && (!hasDatasetId || !hasModelId || !taskType)) {
    const missing = [];
    if (!hasDatasetId) {
      missing.push('dataset_id');
    }
    if (!hasModelId) {
      missing.push('source_model_id');
    }
    if (!taskType) {
      missing.push('task_type');
    }
    return { api: 'run_dataset_pre_annotations', missingFields: missing };
  }
  if (/(运行推理|执行推理|run inference|inference)/i.test(content) && (!hasModelVersionId || !hasAttachmentId || !taskType)) {
    const missing = [];
    if (!hasModelVersionId) {
      missing.push('model_version_id');
    }
    if (!hasAttachmentId) {
      missing.push('input_attachment_id');
    }
    if (!taskType) {
      missing.push('task_type');
    }
    return { api: 'run_inference', missingFields: missing };
  }
  if (/(反馈回流|inference feedback|反馈到数据集)/i.test(content) && (!hasRunId || !hasDatasetId)) {
    const missing = [];
    if (!hasRunId) {
      missing.push('run_id');
    }
    if (!hasDatasetId) {
      missing.push('dataset_id');
    }
    return { api: 'send_inference_feedback', missingFields: missing };
  }
  if (/(创建数据集版本|create dataset version)/i.test(content) && !hasDatasetId) {
    return { api: 'create_dataset_version', missingFields: ['dataset_id'] };
  }
  if (/(注册模型版本|register model version)/i.test(content) && (!hasModelId || !hasJobId)) {
    const missing = [];
    if (!hasModelId) {
      missing.push('model_id');
    }
    if (!hasJobId) {
      missing.push('training_job_id');
    }
    return { api: 'register_model_version', missingFields: missing };
  }
  if (/(提交审批|submit approval)/i.test(content) && !hasModelId) {
    return { api: 'submit_approval_request', missingFields: ['model_id'] };
  }
  if (/(激活.*runtime profile|activate runtime profile|切换 runtime profile)/i.test(content) && !extractQuotedValue(content)) {
    return { api: 'activate_runtime_profile', missingFields: ['profile_id'] };
  }
  if (/(更新标注|写入标注|upsert annotation)/i.test(content)) {
    const hasDatasetItemId = /\b(di-[a-z0-9-]+)\b/i.test(content);
    if (!hasDatasetItemId || !taskType) {
      const missing = [];
      if (!hasDatasetItemId) {
        missing.push('dataset_item_id');
      }
      if (!taskType) {
        missing.push('task_type');
      }
      return { api: 'upsert_dataset_annotation', missingFields: missing };
    }
  }
  if (/(审核标注|review annotation)/i.test(content)) {
    const hasAnnotationId = /\b(ann-[a-z0-9-]+)\b/i.test(content);
    if (!hasAnnotationId || !hasReviewStatus) {
      const missing = [];
      if (!hasAnnotationId) {
        missing.push('annotation_id');
      }
      if (!hasReviewStatus) {
        missing.push('status');
      }
      return { api: 'review_dataset_annotation', missingFields: missing };
    }
  }
  if (lower.includes('runtime profile') && !/(activate|切换)/i.test(content)) {
    return null;
  }
  return null;
};

const suggestionsForMissingConsoleField = (field: string): string[] => {
  if (field === 'dataset_id') {
    return suggestDatasetRefs();
  }
  if (field === 'model_id' || field === 'source_model_id') {
    return suggestModelRefs();
  }
  if (field === 'training_job_id' || field === 'job_id') {
    return suggestTrainingJobRefs();
  }
  if (field === 'run_id') {
    return suggestInferenceRunRefs();
  }
  if (field === 'attachment_id' || field === 'input_attachment_id') {
    return suggestAttachmentRefs();
  }
  if (field === 'model_version_id' || field === 'source_model_version_id') {
    return suggestModelVersionRefs();
  }
  if (field === 'task_type') {
    return ['ocr', 'detection', 'classification', 'segmentation', 'obb'];
  }
  if (field === 'dataset_item_id') {
    return datasetItems.slice(0, 8).map((item) => item.id);
  }
  if (field === 'annotation_id') {
    return annotations.slice(0, 8).map((item) => item.id);
  }
  if (field === 'status') {
    return ['approved', 'rejected'];
  }
  if (field === 'profile_id') {
    const record = getCurrentRuntimeSettingsRecord();
    return buildRuntimeProfiles(record).map((item) => item.id);
  }
  return [];
};

const fillConsoleMissingField = (
  field: string,
  content: string,
  params: Record<string, unknown>
): boolean => {
  if (field === 'dataset_id') {
    const resolved = resolveDatasetReference(content);
    if (resolved) {
      params.dataset_id = resolved;
      return true;
    }
    return false;
  }
  if (field === 'model_id' || field === 'source_model_id') {
    const resolved = resolveModelReference(content);
    if (resolved) {
      params[field] = resolved;
      return true;
    }
    return false;
  }
  if (field === 'training_job_id' || field === 'job_id') {
    const resolved = resolveTrainingJobReference(content);
    if (resolved) {
      params[field] = resolved;
      return true;
    }
    return false;
  }
  if (field === 'run_id') {
    const resolved = extractPatternValue(content, [/\b(ir-\d+)\b/i]);
    if (resolved) {
      params.run_id = resolved;
      return true;
    }
    return false;
  }
  if (field === 'attachment_id' || field === 'input_attachment_id') {
    const resolved = extractPatternValue(content, [/\b(f-\d+)\b/i]);
    if (resolved) {
      params[field] = resolved;
      return true;
    }
    return false;
  }
  if (field === 'model_version_id' || field === 'source_model_version_id') {
    const resolved = resolveModelVersionReference(content);
    if (resolved) {
      params[field] = resolved;
      return true;
    }
    return false;
  }
  if (field === 'task_type') {
    const inferred = inferTaskTypeFromText(content);
    if (inferred) {
      params.task_type = inferred;
      return true;
    }
    return false;
  }
  if (field === 'status') {
    if (/(通过|approved?|approve)/i.test(content)) {
      params.status = 'approved';
      return true;
    }
    if (/(拒绝|驳回|rejected?|reject)/i.test(content)) {
      params.status = 'rejected';
      return true;
    }
    return false;
  }
  if (field === 'dataset_item_id') {
    const resolved = resolveDatasetItemReference(content);
    if (resolved) {
      params.dataset_item_id = resolved;
      return true;
    }
    return false;
  }
  if (field === 'annotation_id') {
    const resolved = resolveAnnotationReference(content);
    if (resolved) {
      params.annotation_id = resolved;
      return true;
    }
    return false;
  }
  if (field === 'profile_id') {
    const candidate = inferActionNameFromText(content) || extractQuotedValue(content);
    if (candidate) {
      params.profile_id = candidate;
      return true;
    }
    return false;
  }
  return false;
};

const highRiskConsoleApis = new Set([
  'create_dataset',
  'create_model_draft',
  'create_training_job',
  'activate_runtime_profile',
  'register_model_version',
  'submit_approval_request',
  'send_inference_feedback',
  'cancel_training_job',
  'retry_training_job',
  'upsert_dataset_annotation',
  'review_dataset_annotation',
  'import_dataset_annotations',
  'run_dataset_pre_annotations'
]);

const resolveConsoleApiAction = async (
  content: string,
  pendingAction: ConversationActionMetadata | null
): Promise<ConversationActionResolution | null> => {
  const parsed = parseConsoleOpsPayload(content);
  if (!parsed && /^\/ops\b/i.test(content.trim())) {
    const summary = hasChineseText(content)
      ? '控制台调用格式错误。请使用：/ops {"api":"run_inference","params":{...}}'
      : 'Invalid console call format. Use: /ops {"api":"run_inference","params":{...}}';
    return {
      content: summary,
      metadata: toActionMetadata('console_api_call', 'failed', summary, {})
    };
  }
  let pendingMissingAfterFill: string[] = [];
  let pendingPayloadJsonAfterFill = '';
  const recoveredFromPending =
    !parsed && pendingAction?.action === 'console_api_call'
      ? (() => {
          try {
            const raw = pendingAction.collected_fields.payload_json ?? '';
            if (!raw) {
              return null;
            }
            const recovered = JSON.parse(raw) as ConsoleOpsPayload;
            const params =
              recovered.params && typeof recovered.params === 'object'
                ? { ...(recovered.params as Record<string, unknown>) }
                : {};
            const missingFields = Array.isArray(pendingAction.missing_fields)
              ? pendingAction.missing_fields
              : [];
            const remainingMissing = missingFields.filter((field) => !fillConsoleMissingField(field, content, params));
            pendingMissingAfterFill = remainingMissing;
            pendingPayloadJsonAfterFill = JSON.stringify({
              api: recovered.api,
              params
            });
            if (remainingMissing.length > 0) {
              return null;
            }
            return {
              ...recovered,
              params
            } as ConsoleOpsPayload;
          } catch {
            return null;
          }
        })()
      : null;
  const naturalPayload = !parsed && !recoveredFromPending
    ? buildNaturalConsoleOpsPayload(content, pendingAction)
    : null;
  const payload = parsed ?? recoveredFromPending ?? naturalPayload;
  if (!payload) {
    const naturalMissing = detectNaturalConsoleIntentMissingFields(content);
    const pendingApi =
      pendingAction?.action === 'console_api_call' && typeof pendingAction.collected_fields.api === 'string'
        ? pendingAction.collected_fields.api
        : '';
    if (naturalMissing && naturalMissing.api && naturalMissing.api !== pendingApi) {
      const summary = hasChineseText(content)
        ? `已识别到控制台意图 ${naturalMissing.api}，但缺少参数：${naturalMissing.missingFields.join(', ')}`
        : `Detected console intent ${naturalMissing.api}, but missing parameters: ${naturalMissing.missingFields.join(', ')}`;
      return {
        content: summary,
        metadata: toActionMetadata(
          'console_api_call',
          'requires_input',
          summary,
          {
            api: naturalMissing.api,
            payload_json: JSON.stringify({
              api: naturalMissing.api,
              params: {}
            })
          },
          {
            missingFields: naturalMissing.missingFields,
            suggestions: naturalMissing.missingFields
              .flatMap((field) => suggestionsForMissingConsoleField(field))
              .slice(0, 8)
          }
        )
      };
    }
    if (
      !parsed &&
      pendingAction?.action === 'console_api_call' &&
      (pendingAction.missing_fields.length > 0 || pendingMissingAfterFill.length > 0)
    ) {
      const missingFields =
        pendingMissingAfterFill.length > 0 ? pendingMissingAfterFill : pendingAction.missing_fields;
      const summary = hasChineseText(content)
        ? `请补充这些字段后我再执行：${missingFields.join(', ')}`
        : `Please provide these fields so I can continue: ${missingFields.join(', ')}`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'requires_input', summary, {
          api: pendingAction.collected_fields.api ?? '',
          payload_json: pendingPayloadJsonAfterFill || pendingAction.collected_fields.payload_json || ''
        }, {
          missingFields,
          suggestions: missingFields.flatMap((field) => suggestionsForMissingConsoleField(field)).slice(0, 8),
          requiresConfirmation: missingFields.includes('confirmation') && pendingAction.requires_confirmation,
          confirmationPhrase:
            missingFields.includes('confirmation') && pendingAction.requires_confirmation
              ? pendingAction.confirmation_phrase ?? null
              : null
        })
      };
    }
    const missing = naturalMissing;
    if (missing) {
      const summary = hasChineseText(content)
        ? `已识别到控制台意图 ${missing.api}，但缺少参数：${missing.missingFields.join(', ')}`
        : `Detected console intent ${missing.api}, but missing parameters: ${missing.missingFields.join(', ')}`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'requires_input', summary, {
          api: missing.api,
          payload_json: JSON.stringify({
            api: missing.api,
            params: {}
          })
        }, {
          missingFields: missing.missingFields,
          suggestions: missing.missingFields.flatMap((field) => suggestionsForMissingConsoleField(field)).slice(0, 8)
        })
      };
    }
    return null;
  }

  const normalizedApi = payload.api.trim().toLowerCase();
  const params = payload.params ?? {};
  const confirmed = Boolean(payload.confirm) || resolveConversationConfirmation(content, pendingAction);
  if (highRiskConsoleApis.has(normalizedApi) && !confirmed) {
    const confirmationPhrase = hasChineseText(content) ? confirmationPhraseZh : confirmationPhraseEn;
    const summary = hasChineseText(content)
      ? `准备调用高危控制台 API（${normalizedApi}）。请回复“${confirmationPhrase}”确认执行。`
      : `High-risk console API call queued (${normalizedApi}). Reply "${confirmationPhrase}" to execute.`;
    return {
      content: summary,
      metadata: toActionMetadata('console_api_call', 'requires_input', summary, {
        api: normalizedApi,
        payload_json: JSON.stringify({
          api: normalizedApi,
          params
        })
      }, {
        missingFields: ['confirmation'],
        requiresConfirmation: true,
        confirmationPhrase
      })
    };
  }

  try {
    if (normalizedApi === 'list_datasets') {
      const list = await listDatasets();
      const summary = hasChineseText(content)
        ? `控制台 API list_datasets 已执行，返回 ${list.length} 条数据集记录。`
        : `Console API list_datasets executed, returned ${list.length} datasets.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          count: String(list.length)
        })
      };
    }

    if (normalizedApi === 'list_model_versions') {
      const list = await listModelVersions();
      const summary = hasChineseText(content)
        ? `控制台 API list_model_versions 已执行，返回 ${list.length} 条模型版本记录。`
        : `Console API list_model_versions executed, returned ${list.length} model versions.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          count: String(list.length)
        })
      };
    }

    if (normalizedApi === 'list_models') {
      const list = await listModels();
      const summary = hasChineseText(content)
        ? `控制台 API list_models 已执行，返回 ${list.length} 条模型记录。`
        : `Console API list_models executed, returned ${list.length} models.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          count: String(list.length)
        })
      };
    }

    if (normalizedApi === 'list_training_jobs') {
      const list = await listTrainingJobs();
      const summary = hasChineseText(content)
        ? `控制台 API list_training_jobs 已执行，返回 ${list.length} 条训练任务记录。`
        : `Console API list_training_jobs executed, returned ${list.length} jobs.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          count: String(list.length)
        })
      };
    }

    if (normalizedApi === 'list_inference_runs') {
      const list = await listInferenceRuns();
      const summary = hasChineseText(content)
        ? `控制台 API list_inference_runs 已执行，返回 ${list.length} 条推理记录。`
        : `Console API list_inference_runs executed, returned ${list.length} runs.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          count: String(list.length)
        })
      };
    }

    if (normalizedApi === 'list_dataset_annotations') {
      const list = await listDatasetAnnotations(String(params.dataset_id ?? ''));
      const summary = hasChineseText(content)
        ? `控制台 API list_dataset_annotations 已执行，返回 ${list.length} 条标注记录。`
        : `Console API list_dataset_annotations executed, returned ${list.length} annotations.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          count: String(list.length)
        })
      };
    }

    if (normalizedApi === 'run_inference') {
      const created = await runInference({
        model_version_id: String(params.model_version_id ?? ''),
        input_attachment_id: String(params.input_attachment_id ?? ''),
        task_type: String(params.task_type ?? '') as TaskType
      });
      const summary = hasChineseText(content)
        ? `控制台 API run_inference 已执行，任务 ${created.id}，来源 ${created.execution_source}。`
        : `Console API run_inference executed, run=${created.id}, source=${created.execution_source}.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          inference_run_id: created.id
        })
      };
    }

    if (normalizedApi === 'create_dataset') {
      const created = await createDataset({
        name: String(params.name ?? ''),
        description: String(params.description ?? ''),
        task_type: String(params.task_type ?? '') as TaskType,
        label_schema: {
          classes: Array.isArray(params.classes)
            ? params.classes.map((item) => String(item)).filter(Boolean)
            : []
        }
      });
      const summary = hasChineseText(content)
        ? `控制台 API create_dataset 已执行：${created.name} (${created.id})。`
        : `Console API create_dataset executed: ${created.name} (${created.id}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          dataset_id: created.id
        })
      };
    }

    if (normalizedApi === 'create_dataset_version') {
      const created = await createDatasetVersion({
        dataset_id: String(params.dataset_id ?? ''),
        version_name: String(params.version_name ?? '')
      });
      const summary = hasChineseText(content)
        ? `控制台 API create_dataset_version 已执行：${created.version_name} (${created.id})。`
        : `Console API create_dataset_version executed: ${created.version_name} (${created.id}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          dataset_version_id: created.id
        })
      };
    }

    if (normalizedApi === 'import_dataset_annotations') {
      const result = await importDatasetAnnotations(String(params.dataset_id ?? ''), {
        format: String(params.format ?? '') as 'yolo' | 'coco' | 'labelme' | 'ocr',
        attachment_id: String(params.attachment_id ?? '')
      });
      const summary = hasChineseText(content)
        ? `控制台 API import_dataset_annotations 已执行：导入 ${result.imported}，更新 ${result.updated}。`
        : `Console API import_dataset_annotations executed: imported=${result.imported}, updated=${result.updated}.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          imported: String(result.imported),
          updated: String(result.updated)
        })
      };
    }

    if (normalizedApi === 'export_dataset_annotations') {
      const result = await exportDatasetAnnotations(String(params.dataset_id ?? ''), {
        format: String(params.format ?? '') as 'yolo' | 'coco' | 'labelme' | 'ocr'
      });
      const summary = hasChineseText(content)
        ? `控制台 API export_dataset_annotations 已执行：${result.filename} (${result.attachment_id})。`
        : `Console API export_dataset_annotations executed: ${result.filename} (${result.attachment_id}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          attachment_id: result.attachment_id
        })
      };
    }

    if (normalizedApi === 'create_model_draft') {
      const created = await createModelDraft({
        name: String(params.name ?? ''),
        description: String(params.description ?? ''),
        model_type: String(params.model_type ?? '') as TaskType,
        visibility: String(params.visibility ?? 'private') as ModelRecord['visibility']
      });
      const summary = hasChineseText(content)
        ? `控制台 API create_model_draft 已执行：${created.name} (${created.id})。`
        : `Console API create_model_draft executed: ${created.name} (${created.id}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          model_id: created.id
        })
      };
    }

    if (normalizedApi === 'upsert_dataset_annotation') {
      const updated = await upsertDatasetAnnotation(String(params.dataset_id ?? ''), {
        dataset_item_id: String(params.dataset_item_id ?? ''),
        task_type: String(params.task_type ?? '') as TaskType,
        source: String(params.source ?? '') as 'manual' | 'import' | 'pre_annotation',
        status: String(params.status ?? '') as
          | 'unannotated'
          | 'in_progress'
          | 'annotated'
          | 'in_review'
          | 'approved'
          | 'rejected',
        payload:
          params.payload && typeof params.payload === 'object'
            ? (params.payload as Record<string, unknown>)
            : {}
      });
      const summary = hasChineseText(content)
        ? `控制台 API upsert_dataset_annotation 已执行：${updated.id}。`
        : `Console API upsert_dataset_annotation executed: ${updated.id}.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          annotation_id: updated.id
        })
      };
    }

    if (normalizedApi === 'review_dataset_annotation') {
      const updated = await reviewDatasetAnnotation(
        String(params.dataset_id ?? ''),
        String(params.annotation_id ?? ''),
        {
        status: String(params.status ?? '') as 'approved' | 'rejected',
        review_reason_code:
          params.review_reason_code === null || typeof params.review_reason_code === 'undefined'
            ? null
            : (String(params.review_reason_code) as AnnotationReviewReasonCode),
        quality_score:
          typeof params.quality_score === 'number' ? params.quality_score : null,
        review_comment:
          params.review_comment === null || typeof params.review_comment === 'undefined'
            ? null
            : String(params.review_comment)
        }
      );
      const summary = hasChineseText(content)
        ? `控制台 API review_dataset_annotation 已执行：${updated.id} (${updated.status})。`
        : `Console API review_dataset_annotation executed: ${updated.id} (${updated.status}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          annotation_id: updated.id,
          status: updated.status
        })
      };
    }

    if (normalizedApi === 'run_dataset_pre_annotations') {
      const result = await runDatasetPreAnnotations(
        String(params.dataset_id ?? ''),
        {
          model_version_id:
            typeof params.source_model_version_id === 'string' ? params.source_model_version_id : undefined
        }
      );
      const summary = hasChineseText(content)
        ? `控制台 API run_dataset_pre_annotations 已执行：创建 ${result.created} 条，更新 ${result.updated} 条。`
        : `Console API run_dataset_pre_annotations executed: created=${result.created}, updated=${result.updated}.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          created: String(result.created),
          updated: String(result.updated)
        })
      };
    }

    if (normalizedApi === 'create_training_job') {
      const created = await createTrainingJob({
        name: String(params.name ?? ''),
        task_type: String(params.task_type ?? '') as TaskType,
        framework: String(params.framework ?? '') as ModelFramework,
        dataset_id: String(params.dataset_id ?? ''),
        dataset_version_id: String(params.dataset_version_id ?? ''),
        base_model: String(params.base_model ?? ''),
        config:
          params.config && typeof params.config === 'object'
            ? Object.fromEntries(
                Object.entries(params.config as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
              )
            : {}
      });
      const summary = hasChineseText(content)
        ? `控制台 API create_training_job 已执行：${created.name} (${created.id})。`
        : `Console API create_training_job executed: ${created.name} (${created.id}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          training_job_id: created.id
        })
      };
    }

    if (normalizedApi === 'register_model_version') {
      const created = await registerModelVersion({
        model_id: String(params.model_id ?? ''),
        training_job_id: String(params.training_job_id ?? ''),
        version_name: String(params.version_name ?? '')
      });
      const summary = hasChineseText(content)
        ? `控制台 API register_model_version 已执行：${created.version_name} (${created.id})。`
        : `Console API register_model_version executed: ${created.version_name} (${created.id}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          model_version_id: created.id
        })
      };
    }

    if (normalizedApi === 'submit_approval_request') {
      const created = await submitApprovalRequest({
        model_id: String(params.model_id ?? ''),
        review_notes: typeof params.review_notes === 'string' ? params.review_notes : undefined,
        parameter_snapshot:
          params.parameter_snapshot && typeof params.parameter_snapshot === 'object'
            ? Object.fromEntries(
                Object.entries(params.parameter_snapshot as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
              )
            : {}
      });
      const summary = hasChineseText(content)
        ? `控制台 API submit_approval_request 已执行：${created.id}。`
        : `Console API submit_approval_request executed: ${created.id}.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          approval_id: created.id
        })
      };
    }

    if (normalizedApi === 'send_inference_feedback') {
      const updated = await sendInferenceFeedback({
        run_id: String(params.run_id ?? ''),
        dataset_id: String(params.dataset_id ?? ''),
        reason: String(params.reason ?? 'feedback')
      });
      const summary = hasChineseText(content)
        ? `控制台 API send_inference_feedback 已执行：run=${updated.id}。`
        : `Console API send_inference_feedback executed: run=${updated.id}.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          inference_run_id: updated.id
        })
      };
    }

    if (normalizedApi === 'cancel_training_job') {
      const updated = await cancelTrainingJob(String(params.job_id ?? ''));
      const summary = hasChineseText(content)
        ? `控制台 API cancel_training_job 已执行：${updated.name} (${updated.status})。`
        : `Console API cancel_training_job executed: ${updated.name} (${updated.status}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          training_job_id: updated.id,
          status: updated.status
        })
      };
    }

    if (normalizedApi === 'retry_training_job') {
      const updated = await retryTrainingJob(String(params.job_id ?? ''));
      const summary = hasChineseText(content)
        ? `控制台 API retry_training_job 已执行：${updated.name} (${updated.status})。`
        : `Console API retry_training_job executed: ${updated.name} (${updated.status}).`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          training_job_id: updated.id,
          status: updated.status
        })
      };
    }

    if (normalizedApi === 'activate_runtime_profile') {
      const profileId = String(params.profile_id ?? '').trim();
      const view = await activateRuntimeProfile(profileId);
      const summary = hasChineseText(content)
        ? `控制台 API activate_runtime_profile 已执行，当前 profile=${view.active_profile_id ?? 'saved'}。`
        : `Console API activate_runtime_profile executed, active_profile=${view.active_profile_id ?? 'saved'}.`;
      return {
        content: summary,
        metadata: toActionMetadata('console_api_call', 'completed', summary, {
          api: normalizedApi,
          active_profile_id: view.active_profile_id ?? 'saved'
        })
      };
    }

    const unsupportedSummary = hasChineseText(content)
      ? `暂不支持的控制台 API：${normalizedApi}`
      : `Unsupported console API: ${normalizedApi}`;
    return {
      content: unsupportedSummary,
      metadata: toActionMetadata('console_api_call', 'failed', unsupportedSummary, {
        api: normalizedApi
      })
    };
  } catch (error) {
    const summary = hasChineseText(content)
      ? `控制台 API ${normalizedApi} 执行失败：${(error as Error).message}`
      : `Console API ${normalizedApi} failed: ${(error as Error).message}`;
    return {
      content: summary,
      metadata: toActionMetadata('console_api_call', 'failed', summary, {
        api: normalizedApi
      })
    };
  }
};

const resolveConversationExtractionAction = (
  conversationId: string,
  content: string
): ConversationActionResolution | null => {
  if (!detectOcrExtractionIntent(content)) {
    return null;
  }

  let latestInferenceRunId = '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!item || item.conversation_id !== conversationId || item.sender !== 'assistant') {
      continue;
    }
    const action = item.metadata?.conversation_action;
    if (action?.action === 'run_model_inference' && action.status === 'completed') {
      latestInferenceRunId = action.collected_fields.inference_run_id ?? '';
      if (latestInferenceRunId) {
        break;
      }
    }
  }

  if (!latestInferenceRunId) {
    const summary = hasChineseText(content)
      ? '未找到可提取的最近一次推理结果，请先上传图片并发起识别。'
      : 'No recent inference result found. Upload an image and run inference first.';
    return {
      content: summary,
      metadata: toActionMetadata('run_model_inference', 'failed', summary, {})
    };
  }

  const run = inferenceRuns.find((entry) => entry.id === latestInferenceRunId);
  if (!run) {
    const summary = hasChineseText(content)
      ? '最近推理记录不存在，请重新执行识别。'
      : 'Latest inference record no longer exists. Please run inference again.';
    return {
      content: summary,
      metadata: toActionMetadata('run_model_inference', 'failed', summary, {
        inference_run_id: latestInferenceRunId
      })
    };
  }

  const ocrLines = run.normalized_output.ocr.lines.map((item) => item.text).filter(Boolean);
  const joined = ocrLines.join(' ');
  const plateCandidate =
    joined.match(/[A-Z]{1,2}[A-Z0-9]{4,7}/i)?.[0] ??
    joined.match(/[0-9]{5,12}/)?.[0] ??
    '';
  const summary = hasChineseText(content)
    ? plateCandidate
      ? `已从最近推理中提取候选编号：${plateCandidate}`
      : '未提取到明确编号，你可以继续指定提取规则（例如“只要连续 6 位数字”）。'
    : plateCandidate
      ? `Extracted candidate identifier from latest inference: ${plateCandidate}`
      : 'No clear identifier extracted. Provide a stricter rule (e.g. "exactly 6 consecutive digits").';
  return {
    content: summary,
    metadata: toActionMetadata('run_model_inference', 'completed', summary, {
      inference_run_id: latestInferenceRunId,
      extracted_identifier: plateCandidate
    })
  };
};

const resolveConversationAction = async (
  conversation: ConversationRecord,
  content: string,
  attachmentIds: string[],
  currentUser: User
): Promise<ConversationActionResolution | null> => {
  const pendingAction = getPendingConversationAction(conversation.id);
  const consoleApiResolution = await resolveConsoleApiAction(content, pendingAction);
  if (consoleApiResolution) {
    return consoleApiResolution;
  }

  const extractionResolution = resolveConversationExtractionAction(conversation.id, content);
  if (extractionResolution) {
    return extractionResolution;
  }
  const inferenceResolution = await resolveConversationInferenceAction(
    conversation,
    content,
    attachmentIds,
    currentUser
  );
  if (inferenceResolution) {
    return inferenceResolution;
  }
  const explicitAction = detectConversationActionType(content);
  const action = explicitAction ?? pendingAction?.action ?? null;

  if (!action) {
    return null;
  }

  if (pendingAction && !explicitAction && detectCancelIntent(content)) {
    const summary = buildActionSummary(action, 'cancelled', content, '');
    return {
      content: summary,
      metadata: toActionMetadata(action, 'cancelled', summary, pendingAction.collected_fields)
    };
  }

  if (action === 'create_training_job') {
    return resolveCreateTrainingJobAction(content, currentUser, explicitAction ? null : pendingAction);
  }
  if (action === 'create_dataset') {
    return resolveCreateDatasetAction(content, explicitAction ? null : pendingAction);
  }
  return resolveCreateModelDraftAction(content, explicitAction ? null : pendingAction);
};

const conversationMessages = (conversationId: string): MessageRecord[] =>
  messages.filter((item) => item.conversation_id === conversationId);

const assertConversationAccess = (conversationId: string, user: User): ConversationRecord => {
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) {
    throw new Error('Conversation not found.');
  }

  if (!(user.role === 'admin' || conversation.created_by === user.id)) {
    throw new Error('No permission to message in this conversation.');
  }

  return conversation;
};

const assertAttachmentReadAccess = (attachment: FileAttachment, user: User): void => {
  if (user.role === 'admin' || attachment.owner_user_id === user.id) {
    return;
  }

  if (attachment.attached_to_type === 'Dataset' && attachment.attached_to_id) {
    assertDatasetAccess(attachment.attached_to_id, user);
    return;
  }

  if (attachment.attached_to_type === 'Model' && attachment.attached_to_id) {
    assertModelAccess(attachment.attached_to_id, user);
    return;
  }

  if (attachment.attached_to_type === 'Conversation' && attachment.attached_to_id) {
    assertConversationAccess(attachment.attached_to_id, user);
    return;
  }

  if (attachment.attached_to_type === 'InferenceRun' && attachment.attached_to_id) {
    const run = inferenceRuns.find((item) => item.id === attachment.attached_to_id);
    if (!run) {
      throw new Error('Inference run for attachment not found.');
    }

    assertModelVersionAccess(run.model_version_id, user);
    return;
  }

  throw new Error('No permission to access this attachment.');
};

const logAudit = (
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, string> = {},
  actorUserId?: string
): void => {
  const actor = actorUserId ? users.find((item) => item.id === actorUserId) : findCurrentUser();
  const entry: AuditLogRecord = {
    id: nextId('audit'),
    user_id: actor?.id ?? null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    metadata,
    timestamp: now()
  };

  auditLogs.unshift(entry);
  markAppStateDirty();
};

const imageAttachmentExtensionSet = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.bmp',
  '.webp',
  '.gif',
  '.tif',
  '.tiff'
]);

const isImageAttachment = (attachment: FileAttachment | null | undefined): boolean => {
  if (!attachment) {
    return false;
  }
  if (typeof attachment.mime_type === 'string' && attachment.mime_type.toLowerCase().startsWith('image/')) {
    return true;
  }
  const ext = path.extname(attachment.filename || '').toLowerCase();
  return imageAttachmentExtensionSet.has(ext);
};

const isTrainableDatasetItem = (item: DatasetItemRecord): boolean => {
  if (item.status !== 'ready') {
    return false;
  }
  const attachment = attachments.find((entry) => entry.id === item.attachment_id);
  return isImageAttachment(attachment);
};

const seedStableScore = (value: string, seed: number): number => {
  let hash = (seed >>> 0) || 1;
  for (let index = 0; index < value.length; index += 1) {
    hash = (((hash << 5) - hash + value.charCodeAt(index)) >>> 0);
  }
  return hash;
};

const sortItemsBySeed = (items: DatasetItemRecord[], seed: number): DatasetItemRecord[] => {
  return [...items].sort((left, right) => {
    const leftScore = seedStableScore(left.id, seed);
    const rightScore = seedStableScore(right.id, seed);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return left.id.localeCompare(right.id);
  });
};

const annotationCoverageForDataset = (datasetId: string): number => {
  const items = datasetItems.filter((item) => item.dataset_id === datasetId && isTrainableDatasetItem(item));
  if (items.length === 0) {
    return 0;
  }

  const itemIds = new Set(items.map((item) => item.id));
  const coveredCount = annotations.filter((annotation) => {
    const coveredStatus: AnnotationStatus[] = ['annotated', 'in_review', 'approved'];
    return itemIds.has(annotation.dataset_item_id) && coveredStatus.includes(annotation.status);
  }).length;

  return Number((coveredCount / items.length).toFixed(2));
};

const computeSplitSummary = (datasetId: string, options?: { trainableOnly?: boolean }) => {
  const items = datasetItems.filter(
    (item) =>
      item.dataset_id === datasetId &&
      (!options?.trainableOnly || isTrainableDatasetItem(item))
  );
  return {
    train: items.filter((item) => item.split === 'train').length,
    val: items.filter((item) => item.split === 'val').length,
    test: items.filter((item) => item.split === 'test').length,
    unassigned: items.filter((item) => item.split === 'unassigned').length
  };
};

const annotationTransitionMap: Record<AnnotationStatus, AnnotationStatus[]> = {
  unannotated: ['in_progress'],
  in_progress: ['annotated'],
  annotated: ['in_review'],
  in_review: ['approved', 'rejected'],
  approved: [],
  rejected: ['in_progress']
};

const canTransitionAnnotationStatus = (from: AnnotationStatus, to: AnnotationStatus): boolean => {
  if (from === to) {
    return true;
  }

  return annotationTransitionMap[from].includes(to);
};

const annotationEditableStatuses = new Set<AnnotationStatus>(['unannotated', 'in_progress', 'annotated']);

const canUpsertAnnotationStatus = (from: AnnotationStatus, to: AnnotationStatus): boolean => {
  if (from === 'rejected') {
    return to === 'in_progress';
  }

  if (!annotationEditableStatuses.has(from) || !annotationEditableStatuses.has(to)) {
    return false;
  }

  if (from === to) {
    return true;
  }

  return annotationTransitionMap[from].includes(to);
};

const annotationReviewReasonCodes = new Set<AnnotationReviewReasonCode>([
  'box_mismatch',
  'label_error',
  'text_error',
  'missing_object',
  'polygon_issue',
  'other'
]);

const findDatasetItem = (datasetId: string, itemId: string): DatasetItemRecord => {
  const found = datasetItems.find((item) => item.id === itemId && item.dataset_id === datasetId);
  if (!found) {
    throw new Error('Dataset item not found in this dataset.');
  }
  return found;
};

const latestAnnotationReview = (annotationId: string): AnnotationReviewRecord | null =>
  annotationReviews.find((review) => review.annotation_id === annotationId) ?? null;

const listDatasetAnnotationsInternal = (datasetId: string): AnnotationWithReview[] => {
  const itemIds = new Set(datasetItems.filter((item) => item.dataset_id === datasetId).map((item) => item.id));
  return annotations
    .filter((annotation) => itemIds.has(annotation.dataset_item_id))
    .map((annotation) => ({
      ...annotation,
      latest_review: latestAnnotationReview(annotation.id)
    }));
};

type DetectionImportEntry = {
  filename: string;
  boxes: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
    score: number;
  }>;
};

type OcrImportEntry = {
  filename: string;
  lines: Array<{
    text: string;
    confidence: number;
  }>;
};

type GenericImportEntry = {
  filename: string;
  payload: Record<string, unknown>;
};

const normalizeImportFilename = (filename: string): string => path.basename(filename.trim()).toLowerCase();

const parseJsonObject = (content: string): unknown => {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Import file is empty.');
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error('Import file JSON is invalid.');
  }
};

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseYoloImportFromJson = (raw: unknown): DetectionImportEntry[] => {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items ?? [])
      : [];

  return list
    .map((entry): DetectionImportEntry | null => {
      const record = entry as { filename?: unknown; boxes?: unknown };
      if (typeof record.filename !== 'string' || !record.filename.trim()) {
        return null;
      }

      const boxesRaw = Array.isArray(record.boxes) ? record.boxes : [];
      const boxes = boxesRaw
        .map((boxEntry) => {
          const box = boxEntry as {
            x?: unknown;
            y?: unknown;
            width?: unknown;
            height?: unknown;
            label?: unknown;
            score?: unknown;
          };
          const x = toNumberOrNull(box.x);
          const y = toNumberOrNull(box.y);
          const width = toNumberOrNull(box.width);
          const height = toNumberOrNull(box.height);
          if (
            x === null ||
            y === null ||
            width === null ||
            height === null ||
            width <= 0 ||
            height <= 0
          ) {
            return null;
          }

          return {
            x,
            y,
            width,
            height,
            label: typeof box.label === 'string' && box.label.trim() ? box.label.trim() : 'object',
            score: toNumberOrNull(box.score) ?? 0.5
          };
        })
        .filter(
          (
            value
          ): value is {
            x: number;
            y: number;
            width: number;
            height: number;
            label: string;
            score: number;
          } => value !== null
        );

      if (boxes.length === 0) {
        return null;
      }

      return {
        filename: record.filename.trim(),
        boxes
      };
    })
    .filter((value): value is DetectionImportEntry => value !== null);
};

const parseYoloImportFromTxt = (content: string): DetectionImportEntry[] => {
  const grouped = new Map<string, DetectionImportEntry['boxes']>();
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('#')) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length < 6) {
      continue;
    }

    const [filename, label, xRaw, yRaw, widthRaw, heightRaw, scoreRaw] = parts;
    const x = toNumberOrNull(xRaw);
    const y = toNumberOrNull(yRaw);
    const width = toNumberOrNull(widthRaw);
    const height = toNumberOrNull(heightRaw);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
      continue;
    }

    const key = normalizeImportFilename(filename);
    const existing = grouped.get(key) ?? [];
    existing.push({
      x,
      y,
      width,
      height,
      label: label?.trim() || 'object',
      score: toNumberOrNull(scoreRaw) ?? 0.5
    });
    grouped.set(key, existing);
  }

  return Array.from(grouped.entries()).map(([filename, boxes]) => ({
    filename,
    boxes
  }));
};

const parseYoloImport = (content: string, filename: string): DetectionImportEntry[] => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) {
    return parseYoloImportFromJson(parseJsonObject(content));
  }

  return parseYoloImportFromTxt(content);
};

const parseOcrImportFromJson = (raw: unknown): OcrImportEntry[] => {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items ?? [])
      : [];

  return list
    .map((entry) => {
      const record = entry as { filename?: unknown; lines?: unknown };
      if (typeof record.filename !== 'string' || !record.filename.trim()) {
        return null;
      }

      const linesRaw = Array.isArray(record.lines) ? record.lines : [];
      const lines = linesRaw
        .map((lineEntry) => {
          const line = lineEntry as { text?: unknown; confidence?: unknown };
          if (typeof line.text !== 'string' || !line.text.trim()) {
            return null;
          }

          return {
            text: line.text.trim(),
            confidence: toNumberOrNull(line.confidence) ?? 0.9
          };
        })
        .filter((value): value is { text: string; confidence: number } => value !== null);

      if (lines.length === 0) {
        return null;
      }

      return {
        filename: record.filename.trim(),
        lines
      };
    })
    .filter((value): value is OcrImportEntry => value !== null);
};

const parseOcrImportFromTxt = (content: string): OcrImportEntry[] => {
  const grouped = new Map<string, OcrImportEntry['lines']>();
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('#')) {
      continue;
    }

    const [filenamePart, textPart, confidencePart] = line.split('\t');
    if (!filenamePart || !textPart) {
      continue;
    }

    const key = normalizeImportFilename(filenamePart);
    const existing = grouped.get(key) ?? [];
    existing.push({
      text: textPart.trim(),
      confidence: toNumberOrNull(confidencePart) ?? 0.9
    });
    grouped.set(key, existing);
  }

  return Array.from(grouped.entries()).map(([filename, lineItems]) => ({
    filename,
    lines: lineItems
  }));
};

const parseOcrImport = (content: string, filename: string): OcrImportEntry[] => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) {
    return parseOcrImportFromJson(parseJsonObject(content));
  }

  return parseOcrImportFromTxt(content);
};

const parseCocoImport = (content: string): DetectionImportEntry[] => {
  const raw = parseJsonObject(content) as {
    images?: unknown;
    annotations?: unknown;
    categories?: unknown;
  };

  const images = Array.isArray(raw.images) ? raw.images : [];
  const imageNameById = new Map<string, string>();
  images.forEach((entry) => {
    const record = entry as { id?: unknown; file_name?: unknown; filename?: unknown };
    const imageId = record.id;
    const fileName = typeof record.file_name === 'string'
      ? record.file_name
      : typeof record.filename === 'string'
        ? record.filename
        : null;
    if ((typeof imageId === 'string' || typeof imageId === 'number') && fileName?.trim()) {
      imageNameById.set(String(imageId), fileName.trim());
    }
  });

  const categories = Array.isArray(raw.categories) ? raw.categories : [];
  const categoryNameById = new Map<string, string>();
  categories.forEach((entry) => {
    const record = entry as { id?: unknown; name?: unknown };
    if (
      (typeof record.id === 'string' || typeof record.id === 'number') &&
      typeof record.name === 'string' &&
      record.name.trim()
    ) {
      categoryNameById.set(String(record.id), record.name.trim());
    }
  });

  const grouped = new Map<string, DetectionImportEntry['boxes']>();
  const annotationsRaw = Array.isArray(raw.annotations) ? raw.annotations : [];
  annotationsRaw.forEach((entry) => {
    const record = entry as {
      image_id?: unknown;
      category_id?: unknown;
      bbox?: unknown;
      score?: unknown;
    };

    const imageId = record.image_id;
    if (!(typeof imageId === 'string' || typeof imageId === 'number')) {
      return;
    }
    const filename = imageNameById.get(String(imageId));
    if (!filename) {
      return;
    }

    const bbox = Array.isArray(record.bbox) ? record.bbox : [];
    if (bbox.length < 4) {
      return;
    }
    const x = toNumberOrNull(bbox[0]);
    const y = toNumberOrNull(bbox[1]);
    const width = toNumberOrNull(bbox[2]);
    const height = toNumberOrNull(bbox[3]);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
      return;
    }

    const categoryId = record.category_id;
    const label =
      (typeof categoryId === 'string' || typeof categoryId === 'number'
        ? categoryNameById.get(String(categoryId))
        : null) ?? 'object';

    const key = normalizeImportFilename(filename);
    const boxes = grouped.get(key) ?? [];
    boxes.push({
      x,
      y,
      width,
      height,
      label,
      score: toNumberOrNull(record.score) ?? 0.5
    });
    grouped.set(key, boxes);
  });

  return Array.from(grouped.entries()).map(([filename, boxes]) => ({
    filename,
    boxes
  }));
};

const toBoundingBoxFromPoints = (pointsRaw: unknown): { x: number; y: number; width: number; height: number } | null => {
  const points = Array.isArray(pointsRaw) ? pointsRaw : [];
  if (points.length < 2) {
    return null;
  }

  const coords = points
    .map((point) => {
      if (Array.isArray(point) && point.length >= 2) {
        const x = toNumberOrNull(point[0]);
        const y = toNumberOrNull(point[1]);
        if (x !== null && y !== null) {
          return { x, y };
        }
      }

      const record = point as { x?: unknown; y?: unknown };
      const x = toNumberOrNull(record.x);
      const y = toNumberOrNull(record.y);
      if (x !== null && y !== null) {
        return { x, y };
      }
      return null;
    })
    .filter((value): value is { x: number; y: number } => value !== null);

  if (coords.length < 2) {
    return null;
  }

  const xs = coords.map((item) => item.x);
  const ys = coords.map((item) => item.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width,
    height
  };
};

const parseLabelMeImport = (
  content: string,
  taskType: DatasetRecord['task_type']
): GenericImportEntry[] => {
  const raw = parseJsonObject(content);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items ?? [])
      : [raw];

  return list
    .map((entry) => {
      const record = entry as {
        imagePath?: unknown;
        filename?: unknown;
        image_filename?: unknown;
        shapes?: unknown;
      };
      const filename =
        typeof record.imagePath === 'string'
          ? record.imagePath
          : typeof record.filename === 'string'
            ? record.filename
            : typeof record.image_filename === 'string'
              ? record.image_filename
              : null;
      if (!filename?.trim()) {
        return null;
      }

      const shapesRaw = Array.isArray(record.shapes) ? record.shapes : [];
      const boxes: DetectionImportEntry['boxes'] = [];
      const polygons: Array<{
        label: string;
        score: number;
        points: Array<{ x: number; y: number }>;
      }> = [];

      shapesRaw.forEach((shapeEntry) => {
        const shape = shapeEntry as {
          label?: unknown;
          points?: unknown;
          shape_type?: unknown;
        };
        const label = typeof shape.label === 'string' && shape.label.trim() ? shape.label.trim() : 'object';
        const shapeType = typeof shape.shape_type === 'string' ? shape.shape_type.toLowerCase() : '';
        const bbox = toBoundingBoxFromPoints(shape.points);
        if (bbox) {
          boxes.push({
            ...bbox,
            label,
            score: 0.5
          });
        }

        if (taskType === 'segmentation') {
          const points = (Array.isArray(shape.points) ? shape.points : [])
            .map((point) => {
              if (Array.isArray(point) && point.length >= 2) {
                const x = toNumberOrNull(point[0]);
                const y = toNumberOrNull(point[1]);
                if (x !== null && y !== null) {
                  return { x, y };
                }
              }
              return null;
            })
            .filter((value): value is { x: number; y: number } => value !== null);
          if (shapeType === 'polygon' && points.length >= 3) {
            polygons.push({
              label,
              score: 0.5,
              points
            });
          }
        }
      });

      if (taskType === 'segmentation') {
        if (polygons.length === 0 && boxes.length === 0) {
          return null;
        }
        const payload: Record<string, unknown> = {
          polygons,
          boxes
        };
        return {
          filename: filename.trim(),
          payload
        };
      }

      if (boxes.length === 0) {
        return null;
      }
      const payload: Record<string, unknown> = { boxes };
      return {
        filename: filename.trim(),
        payload
      };
    })
    .filter((value): value is GenericImportEntry => value !== null);
};

type DatasetAnnotationExportEntry = {
  annotation: AnnotationWithReview;
  item: DatasetItemRecord;
  filename: string;
};

const listDatasetAnnotationExportEntries = (datasetId: string): DatasetAnnotationExportEntry[] => {
  const items = datasetItems.filter((item) => item.dataset_id === datasetId);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const attachmentById = new Map(
    attachments
      .filter((attachment) => attachment.attached_to_type === 'Dataset' && attachment.attached_to_id === datasetId)
      .map((attachment) => [attachment.id, attachment])
  );

  return listDatasetAnnotationsInternal(datasetId)
    .map((annotation) => {
      const item = itemById.get(annotation.dataset_item_id);
      if (!item) {
        return null;
      }
      const attachment = attachmentById.get(item.attachment_id);
      const filename =
        (attachment?.filename && attachment.filename.trim()) ||
        item.metadata.original_filename ||
        `dataset-item-${item.id}.bin`;

      return {
        annotation,
        item,
        filename
      };
    })
    .filter((entry): entry is DatasetAnnotationExportEntry => entry !== null);
};

const toExportDetectionBoxes = (payload: Record<string, unknown>): DetectionImportEntry['boxes'] => {
  const boxesRaw = Array.isArray(payload.boxes) ? payload.boxes : [];
  return boxesRaw
    .map((boxEntry) => {
      const box = boxEntry as {
        x?: unknown;
        y?: unknown;
        width?: unknown;
        height?: unknown;
        label?: unknown;
        score?: unknown;
      };
      const x = toNumberOrNull(box.x);
      const y = toNumberOrNull(box.y);
      const width = toNumberOrNull(box.width);
      const height = toNumberOrNull(box.height);
      if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
        return null;
      }
      return {
        x,
        y,
        width,
        height,
        label: typeof box.label === 'string' && box.label.trim() ? box.label.trim() : 'object',
        score: toNumberOrNull(box.score) ?? 0.5
      };
    })
    .filter((entry): entry is DetectionImportEntry['boxes'][number] => entry !== null);
};

const toExportOcrLines = (payload: Record<string, unknown>): OcrImportEntry['lines'] => {
  const linesRaw = Array.isArray(payload.lines) ? payload.lines : [];
  return linesRaw
    .map((lineEntry) => {
      const line = lineEntry as { text?: unknown; confidence?: unknown };
      if (typeof line.text !== 'string' || !line.text.trim()) {
        return null;
      }
      return {
        text: line.text.trim(),
        confidence: toNumberOrNull(line.confidence) ?? 0.9
      };
    })
    .filter((entry): entry is OcrImportEntry['lines'][number] => entry !== null);
};

const toExportSegmentationPolygons = (
  payload: Record<string, unknown>
): Array<{ label: string; score: number; points: Array<{ x: number; y: number }> }> => {
  const polygonsRaw = Array.isArray(payload.polygons) ? payload.polygons : [];
  return polygonsRaw
    .map((polygonEntry) => {
      const polygon = polygonEntry as { label?: unknown; score?: unknown; points?: unknown };
      const pointsRaw = Array.isArray(polygon.points) ? polygon.points : [];
      const points = pointsRaw
        .map((pointEntry) => {
          const point = pointEntry as { x?: unknown; y?: unknown };
          const x = toNumberOrNull(point.x);
          const y = toNumberOrNull(point.y);
          if (x === null || y === null) {
            return null;
          }
          return { x, y };
        })
        .filter((point): point is { x: number; y: number } => point !== null);
      if (points.length < 3) {
        return null;
      }
      return {
        label: typeof polygon.label === 'string' && polygon.label.trim() ? polygon.label.trim() : 'object',
        score: toNumberOrNull(polygon.score) ?? 0.5,
        points
      };
    })
    .filter(
      (
        polygon
      ): polygon is { label: string; score: number; points: Array<{ x: number; y: number }> } =>
        polygon !== null
    );
};

const buildYoloExportPayload = (
  entries: DatasetAnnotationExportEntry[]
): Array<{ filename: string; boxes: DetectionImportEntry['boxes'] }> => {
  const grouped = new Map<string, { filename: string; boxes: DetectionImportEntry['boxes'] }>();
  entries.forEach((entry) => {
    const boxes = toExportDetectionBoxes(entry.annotation.payload);
    if (boxes.length === 0) {
      return;
    }
    const key = normalizeImportFilename(entry.filename);
    const existing = grouped.get(key) ?? { filename: entry.filename, boxes: [] };
    existing.boxes.push(...boxes);
    grouped.set(key, existing);
  });
  return Array.from(grouped.values());
};

const buildOcrExportPayload = (
  entries: DatasetAnnotationExportEntry[]
): Array<{ filename: string; lines: OcrImportEntry['lines'] }> => {
  const grouped = new Map<string, { filename: string; lines: OcrImportEntry['lines'] }>();
  entries.forEach((entry) => {
    const lines = toExportOcrLines(entry.annotation.payload);
    if (lines.length === 0) {
      return;
    }
    const key = normalizeImportFilename(entry.filename);
    const existing = grouped.get(key) ?? { filename: entry.filename, lines: [] };
    existing.lines.push(...lines);
    grouped.set(key, existing);
  });
  return Array.from(grouped.values());
};

const buildCocoExportPayload = (entries: DatasetAnnotationExportEntry[]): {
  images: Array<{ id: number; file_name: string }>;
  categories: Array<{ id: number; name: string }>;
  annotations: Array<{
    id: number;
    image_id: number;
    category_id: number;
    bbox: [number, number, number, number];
    score: number;
  }>;
} => {
  const grouped = buildYoloExportPayload(entries);
  const labels = new Set<string>();
  grouped.forEach((entry) => {
    entry.boxes.forEach((box) => labels.add(box.label.trim() || 'object'));
  });
  const categories = Array.from(labels)
    .sort((left, right) => left.localeCompare(right))
    .map((name, index) => ({ id: index + 1, name }));
  const categoryIdByName = new Map(categories.map((category) => [category.name, category.id]));

  const images = grouped.map((entry, index) => ({
    id: index + 1,
    file_name: entry.filename
  }));
  const imageIdByFilename = new Map(images.map((image) => [normalizeImportFilename(image.file_name), image.id]));

  const annotationsOut: Array<{
    id: number;
    image_id: number;
    category_id: number;
    bbox: [number, number, number, number];
    score: number;
  }> = [];
  let annotationId = 1;
  grouped.forEach((entry) => {
    const imageId = imageIdByFilename.get(normalizeImportFilename(entry.filename));
    if (!imageId) {
      return;
    }
    entry.boxes.forEach((box) => {
      const categoryId = categoryIdByName.get(box.label.trim() || 'object') ?? 1;
      annotationsOut.push({
        id: annotationId,
        image_id: imageId,
        category_id: categoryId,
        bbox: [box.x, box.y, box.width, box.height],
        score: box.score
      });
      annotationId += 1;
    });
  });

  return {
    images,
    categories,
    annotations: annotationsOut
  };
};

const buildLabelMeExportPayload = (
  entries: DatasetAnnotationExportEntry[],
  taskType: DatasetRecord['task_type']
): Array<{ imagePath: string; shapes: Array<{ label: string; shape_type: string; points: Array<[number, number]> }> }> => {
  const grouped = new Map<
    string,
    { imagePath: string; shapes: Array<{ label: string; shape_type: string; points: Array<[number, number]> }> }
  >();

  entries.forEach((entry) => {
    const key = normalizeImportFilename(entry.filename);
    const existing = grouped.get(key) ?? { imagePath: entry.filename, shapes: [] };
    const boxes = toExportDetectionBoxes(entry.annotation.payload);
    boxes.forEach((box) => {
      existing.shapes.push({
        label: box.label,
        shape_type: 'rectangle',
        points: [
          [box.x, box.y],
          [box.x + box.width, box.y + box.height]
        ]
      });
    });

    if (taskType === 'segmentation') {
      const polygons = toExportSegmentationPolygons(entry.annotation.payload);
      polygons.forEach((polygon) => {
        existing.shapes.push({
          label: polygon.label,
          shape_type: 'polygon',
          points: polygon.points.map((point) => [point.x, point.y] as [number, number])
        });
      });
    }

    grouped.set(key, existing);
  });

  return Array.from(grouped.values()).filter((entry) => entry.shapes.length > 0);
};

const buildDatasetItemByFilenameMap = (datasetId: string): Map<string, DatasetItemRecord[]> => {
  const map = new Map<string, DatasetItemRecord[]>();
  const items = datasetItems.filter((item) => item.dataset_id === datasetId && item.status === 'ready');

  items.forEach((item) => {
    const attachment = attachments.find((entry) => entry.id === item.attachment_id);
    if (!attachment) {
      return;
    }

    const key = normalizeImportFilename(attachment.filename);
    const existing = map.get(key) ?? [];
    existing.push(item);
    map.set(key, existing);
  });

  return map;
};

const parseDatasetItemSplit = (
  input: unknown,
  fallback: DatasetItemRecord['split'] = 'unassigned'
): DatasetItemRecord['split'] => {
  if (typeof input !== 'string' || !input.trim()) {
    return fallback;
  }
  if (input === 'train' || input === 'val' || input === 'test' || input === 'unassigned') {
    return input;
  }
  throw new Error('Invalid dataset item split.');
};

const parseDatasetItemStatus = (
  input: unknown,
  fallback: DatasetItemRecord['status'] = 'ready'
): DatasetItemRecord['status'] => {
  if (typeof input !== 'string' || !input.trim()) {
    return fallback;
  }
  if (input === 'uploading' || input === 'processing' || input === 'ready' || input === 'error') {
    return input;
  }
  throw new Error('Invalid dataset item status.');
};

const normalizeDatasetItemMetadata = (input: unknown): Record<string, string> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [String(key).trim(), String(value).trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0)
  );
};

const findDatasetReadyAttachmentByFilename = (datasetId: string, filename: string): FileAttachment | null => {
  const key = normalizeImportFilename(filename);
  const matched = attachments.find(
    (attachment) =>
      attachment.attached_to_type === 'Dataset' &&
      attachment.attached_to_id === datasetId &&
      attachment.status === 'ready' &&
      normalizeImportFilename(attachment.filename) === key
  );
  return matched ?? null;
};

const createDatasetReferenceAttachment = (
  dataset: DatasetRecord,
  currentUser: User,
  filename: string
): FileAttachment => {
  const created: FileAttachment = {
    id: nextId('f'),
    filename: filename.trim() || `dataset-reference-${Date.now()}.bin`,
    status: 'ready',
    owner_user_id: currentUser.id,
    attached_to_type: 'Dataset',
    attached_to_id: dataset.id,
    mime_type: guessMimeType(filename),
    byte_size: null,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };
  attachments.unshift(created);
  return created;
};

const cloneAttachmentToDatasetScope = async (
  sourceAttachment: FileAttachment,
  dataset: DatasetRecord,
  currentUser: User
): Promise<FileAttachment> => {
  const cloned: FileAttachment = {
    id: nextId('f'),
    filename: sourceAttachment.filename,
    status: sourceAttachment.status,
    owner_user_id: currentUser.id,
    attached_to_type: 'Dataset',
    attached_to_id: dataset.id,
    mime_type: sourceAttachment.mime_type ?? guessMimeType(sourceAttachment.filename),
    byte_size: sourceAttachment.byte_size,
    storage_backend: null,
    storage_path: null,
    upload_error: sourceAttachment.upload_error,
    created_at: now(),
    updated_at: now()
  };
  attachments.unshift(cloned);

  const sourceStored = await findStoredAttachmentBinary(sourceAttachment);
  if (!sourceStored) {
    return cloned;
  }

  try {
    const content = await fs.readFile(sourceStored.file_path);
    const stored = await storeAttachmentBinary(
      cloned,
      sourceAttachment.filename,
      content,
      sourceAttachment.mime_type ?? sourceStored.mime_type
    );
    cloned.status = 'ready';
    cloned.mime_type = stored.mime_type;
    cloned.byte_size = stored.byte_size;
    cloned.storage_backend = 'local';
    cloned.storage_path = stored.file_path;
    cloned.upload_error = null;
    cloned.updated_at = now();
    return cloned;
  } catch {
    const index = attachments.findIndex((item) => item.id === cloned.id);
    if (index >= 0) {
      attachments.splice(index, 1);
    }
    throw new Error('Failed to copy inference attachment into dataset scope.');
  }
};

const upsertDatasetItemForAttachment = (
  dataset: DatasetRecord,
  attachment: FileAttachment,
  options?: {
    split?: unknown;
    status?: unknown;
    metadata?: unknown;
  }
): { item: DatasetItemRecord; created: boolean } => {
  const existing = datasetItems.find(
    (item) => item.dataset_id === dataset.id && item.attachment_id === attachment.id
  );
  const nextMetadata = normalizeDatasetItemMetadata(options?.metadata);
  const nextSplit = parseDatasetItemSplit(options?.split, existing?.split ?? 'unassigned');
  const nextStatus = parseDatasetItemStatus(
    options?.status,
    existing?.status ?? parseDatasetItemStatus(attachment.status, 'ready')
  );

  if (existing) {
    const mergedMetadata =
      Object.keys(nextMetadata).length > 0
        ? {
            ...existing.metadata,
            ...nextMetadata
          }
        : existing.metadata;
    const changed =
      existing.split !== nextSplit ||
      existing.status !== nextStatus ||
      JSON.stringify(existing.metadata) !== JSON.stringify(mergedMetadata);
    if (changed) {
      existing.split = nextSplit;
      existing.status = nextStatus;
      existing.metadata = mergedMetadata;
      existing.updated_at = now();
    }
    return {
      item: existing,
      created: false
    };
  }

  const created: DatasetItemRecord = {
    id: nextId('di'),
    dataset_id: dataset.id,
    attachment_id: attachment.id,
    split: nextSplit,
    status: nextStatus,
    metadata: nextMetadata,
    created_at: now(),
    updated_at: now()
  };
  datasetItems.unshift(created);
  return {
    item: created,
    created: true
  };
};

interface ImageDimensions {
  width: number;
  height: number;
}

const parsePngDimensions = (content: Buffer): ImageDimensions | null => {
  if (content.byteLength < 24) {
    return null;
  }

  const signature = '89504e470d0a1a0a';
  if (content.subarray(0, 8).toString('hex') !== signature) {
    return null;
  }

  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
};

const parseGifDimensions = (content: Buffer): ImageDimensions | null => {
  if (content.byteLength < 10) {
    return null;
  }

  const header = content.subarray(0, 6).toString('ascii');
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    return null;
  }

  const width = content.readUInt16LE(6);
  const height = content.readUInt16LE(8);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
};

const parseJpegDimensions = (content: Buffer): ImageDimensions | null => {
  if (content.byteLength < 4 || content[0] !== 0xff || content[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < content.byteLength - 9) {
    if (content[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let markerOffset = offset + 1;
    while (markerOffset < content.byteLength && content[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    if (markerOffset >= content.byteLength) {
      break;
    }

    const marker = content[markerOffset] as number;
    offset = markerOffset + 1;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }

    if (offset + 1 >= content.byteLength) {
      break;
    }

    const segmentLength = content.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > content.byteLength) {
      break;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame && offset + 7 < content.byteLength) {
      const height = content.readUInt16BE(offset + 3);
      const width = content.readUInt16BE(offset + 5);
      if (width > 0 && height > 0) {
        return { width, height };
      }
      return null;
    }

    offset += segmentLength;
  }

  return null;
};

const readImageDimensions = async (filePath: string): Promise<ImageDimensions | null> => {
  try {
    const content = await fs.readFile(filePath);
    return parsePngDimensions(content) ?? parseGifDimensions(content) ?? parseJpegDimensions(content);
  } catch {
    return null;
  }
};

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const ordered: string[] = [];

  values.forEach((value) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    ordered.push(normalized);
  });

  return ordered;
};

const trainingAnnotationStatusPriority: Record<AnnotationStatus, number> = {
  approved: 6,
  in_review: 5,
  annotated: 4,
  in_progress: 3,
  unannotated: 2,
  rejected: 1
};

const pickTrainingAnnotationForItem = (datasetItemId: string): AnnotationRecord | null =>
  annotations
    .filter((annotation) => annotation.dataset_item_id === datasetItemId && annotation.status !== 'rejected')
    .sort((left, right) => {
      const priorityDelta =
        (trainingAnnotationStatusPriority[right.status] ?? 0) -
        (trainingAnnotationStatusPriority[left.status] ?? 0);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return Date.parse(right.updated_at) - Date.parse(left.updated_at);
    })[0] ?? null;

const copyStoredAttachmentToPath = async (
  attachment: FileAttachment,
  destinationPath: string
): Promise<string | null> => {
  const stored = await findStoredAttachmentBinary(attachment);
  if (!stored) {
    return null;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(stored.file_path, destinationPath);
  return destinationPath;
};

const writeTextFile = async (filePath: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
};

const writeJsonFile = async (filePath: string, payload: unknown): Promise<void> => {
  await writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const resolveMaterializedSplit = (split: DatasetItemRecord['split']): 'train' | 'val' | 'test' => {
  if (split === 'val' || split === 'test') {
    return split;
  }
  return 'train';
};

const normalizeTrainingBoxPayload = (
  payload: Record<string, unknown>
): Array<{ x: number; y: number; width: number; height: number; label: string }> => {
  const entries = Array.isArray(payload.boxes)
    ? payload.boxes
    : Array.isArray(payload.regions)
      ? payload.regions
      : [];

  return entries
    .map((entry) => {
      const record = entry as {
        x?: unknown;
        y?: unknown;
        width?: unknown;
        height?: unknown;
        label?: unknown;
      };
      const x = toNumberOrNull(record.x);
      const y = toNumberOrNull(record.y);
      const width = toNumberOrNull(record.width);
      const height = toNumberOrNull(record.height);
      if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
        return null;
      }

      return {
        x,
        y,
        width,
        height,
        label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : 'object'
      };
    })
    .filter(
      (
        value
      ): value is { x: number; y: number; width: number; height: number; label: string } => value !== null
    );
};

const toYoloNormalizedLine = (
  box: { x: number; y: number; width: number; height: number; label: string },
  image: ImageDimensions,
  classIndex: number
): string | null => {
  if (image.width <= 0 || image.height <= 0 || classIndex < 0) {
    return null;
  }

  const centerX = (box.x + box.width / 2) / image.width;
  const centerY = (box.y + box.height / 2) / image.height;
  const normWidth = box.width / image.width;
  const normHeight = box.height / image.height;

  const values = [centerX, centerY, normWidth, normHeight].map((value) =>
    Math.min(1, Math.max(0, value))
  );

  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return `${classIndex} ${values.map((value) => value.toFixed(6)).join(' ')}`;
};

const materializeYoloDetectionDataset = async (
  dataset: DatasetRecord,
  workspaceDir: string
): Promise<Record<string, unknown>> => {
  const rootDir = path.join(workspaceDir, 'materialized-dataset', 'yolo');
  const manifestPath = path.join(rootDir, 'manifest.json');
  const datasetYamlPath = path.join(rootDir, 'dataset.yaml');
  await Promise.all([
    fs.mkdir(path.join(rootDir, 'train', 'images'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'train', 'labels'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'val', 'images'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'val', 'labels'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'test', 'images'), { recursive: true }),
    fs.mkdir(path.join(rootDir, 'test', 'labels'), { recursive: true })
  ]);
  const items = datasetItems.filter((item) => item.dataset_id === dataset.id && isTrainableDatasetItem(item));

  const classNames = uniqueStrings([
    ...dataset.label_schema.classes,
    ...items.flatMap((item) => {
      const annotation = pickTrainingAnnotationForItem(item.id);
      if (!annotation) {
        return [];
      }
      return normalizeTrainingBoxPayload(annotation.payload as Record<string, unknown>).map((box) => box.label);
    })
  ]);
  const effectiveClassNames = classNames.length > 0 ? classNames : ['object'];
  const splitCounts = {
    train: 0,
    val: 0,
    test: 0
  };
  const manifestItems: Array<Record<string, unknown>> = [];
  let copiedImageCount = 0;
  let labeledItemCount = 0;
  let missingImageCount = 0;
  let missingDimensionCount = 0;
  const baseTrainSplitCount = items.filter((item) => resolveMaterializedSplit(item.split) === 'train').length;
  const forcedTrainItemId =
    baseTrainSplitCount > 0
      ? null
      : items.find((item) => resolveMaterializedSplit(item.split) === 'val')?.id ??
        items.find((item) => resolveMaterializedSplit(item.split) === 'test')?.id ??
        items[0]?.id ??
        null;

  for (const item of items) {
    const attachment = attachments.find((entry) => entry.id === item.attachment_id);
    if (!attachment) {
      missingImageCount += 1;
      continue;
    }

    const split = forcedTrainItemId === item.id ? 'train' : resolveMaterializedSplit(item.split);
    splitCounts[split] += 1;

    const safeFilename = `${item.id}__${sanitizeFilename(attachment.filename)}`;
    const imagePath = path.join(rootDir, split, 'images', safeFilename);
    const imageCopiedPath = await copyStoredAttachmentToPath(attachment, imagePath);
    if (!imageCopiedPath) {
      missingImageCount += 1;
      manifestItems.push({
        dataset_item_id: item.id,
        attachment_id: attachment.id,
        split,
        filename: attachment.filename,
        image_path: null,
        label_path: null,
        reason: 'missing_attachment_binary'
      });
      continue;
    }

    copiedImageCount += 1;
    const imageDimensions = await readImageDimensions(imageCopiedPath);
    if (!imageDimensions) {
      missingDimensionCount += 1;
    }

    const stem = path.basename(safeFilename, path.extname(safeFilename));
    const labelPath = path.join(rootDir, split, 'labels', `${stem}.txt`);
    const annotation = pickTrainingAnnotationForItem(item.id);
    const boxes = annotation
      ? normalizeTrainingBoxPayload(annotation.payload as Record<string, unknown>)
      : [];
    const labelLines =
      imageDimensions !== null
        ? boxes
            .map((box) =>
              toYoloNormalizedLine(
                box,
                imageDimensions,
                effectiveClassNames.findIndex((label) => label === box.label)
              )
            )
            .filter((line): line is string => Boolean(line))
        : [];

    if (labelLines.length > 0) {
      labeledItemCount += 1;
    }

    await writeTextFile(labelPath, labelLines.join('\n'));
    manifestItems.push({
      dataset_item_id: item.id,
      attachment_id: attachment.id,
      split,
      filename: attachment.filename,
      image_path: imageCopiedPath,
      label_path: labelPath,
      image_size: imageDimensions,
      label_count: labelLines.length,
      annotation_id: annotation?.id ?? null,
      annotation_status: annotation?.status ?? null
    });
  }

  const yamlLines = [
    `path: ${JSON.stringify(rootDir)}`,
    'train: train/images',
    `val: ${splitCounts.val > 0 ? 'val/images' : 'train/images'}`,
    ...(splitCounts.test > 0 ? ['test: test/images'] : []),
    `names: ${JSON.stringify(effectiveClassNames)}`
  ];
  await writeTextFile(datasetYamlPath, `${yamlLines.join('\n')}\n`);
  await writeJsonFile(manifestPath, {
    format: 'yolo_detection',
    root_dir: rootDir,
    dataset_yaml: datasetYamlPath,
    class_names: effectiveClassNames,
    split_counts: splitCounts,
    copied_image_count: copiedImageCount,
    labeled_item_count: labeledItemCount,
    missing_image_count: missingImageCount,
    missing_dimension_count: missingDimensionCount,
    items: manifestItems
  });

  return {
    format: 'yolo_detection',
    root_dir: rootDir,
    manifest_path: manifestPath,
    yolo_data_yaml: datasetYamlPath,
    class_names: effectiveClassNames,
    split_counts: splitCounts,
    copied_image_count: copiedImageCount,
    labeled_item_count: labeledItemCount,
    missing_image_count: missingImageCount,
    missing_dimension_count: missingDimensionCount
  };
};

const materializeOcrDataset = async (
  dataset: DatasetRecord,
  workspaceDir: string
): Promise<Record<string, unknown>> => {
  const rootDir = path.join(workspaceDir, 'materialized-dataset', 'ocr');
  const manifestPath = path.join(rootDir, 'manifest.json');
  const items = datasetItems.filter((item) => item.dataset_id === dataset.id && item.status === 'ready');
  const splitCounts = {
    train: 0,
    val: 0,
    test: 0
  };
  const manifestItems: Array<Record<string, unknown>> = [];

  for (const item of items) {
    const attachment = attachments.find((entry) => entry.id === item.attachment_id);
    if (!attachment) {
      continue;
    }

    const split = resolveMaterializedSplit(item.split);
    splitCounts[split] += 1;
    const safeFilename = `${item.id}__${sanitizeFilename(attachment.filename)}`;
    const imagePath = path.join(rootDir, split, 'images', safeFilename);
    const copiedImagePath = await copyStoredAttachmentToPath(attachment, imagePath);
    const annotation = pickTrainingAnnotationForItem(item.id);
    const payload = (annotation?.payload ?? {}) as { lines?: unknown };
    const lines = Array.isArray(payload.lines)
      ? payload.lines
          .map((entry) => {
            const record = entry as { text?: unknown; confidence?: unknown; region_id?: unknown };
            if (typeof record.text !== 'string' || !record.text.trim()) {
              return null;
            }

            return {
              text: record.text.trim(),
              confidence: toNumberOrNull(record.confidence) ?? 0.9,
              region_id: typeof record.region_id === 'string' ? record.region_id : null
            };
          })
          .filter(
            (entry): entry is { text: string; confidence: number; region_id: string | null } =>
              entry !== null
          )
      : [];

    manifestItems.push({
      dataset_item_id: item.id,
      attachment_id: attachment.id,
      split,
      filename: attachment.filename,
      image_path: copiedImagePath,
      annotation_id: annotation?.id ?? null,
      annotation_status: annotation?.status ?? null,
      line_count: lines.length,
      lines
    });
  }

  await writeJsonFile(manifestPath, {
    format: 'ocr_manifest',
    root_dir: rootDir,
    split_counts: splitCounts,
    items: manifestItems
  });

  return {
    format: 'ocr_manifest',
    root_dir: rootDir,
    manifest_path: manifestPath,
    split_counts: splitCounts,
    item_count: manifestItems.length
  };
};

const materializeTrainingDataset = async (
  dataset: DatasetRecord,
  workspaceDir: string
): Promise<Record<string, unknown> | null> => {
  if (dataset.task_type === 'detection') {
    return materializeYoloDetectionDataset(dataset, workspaceDir);
  }

  if (dataset.task_type === 'ocr') {
    return materializeOcrDataset(dataset, workspaceDir);
  }

  return null;
};

const trainingWorkspaceRoot = path.resolve(
  process.cwd(),
  (process.env.TRAINING_WORKDIR_ROOT ?? '.data/training-jobs').trim()
);

interface TrainingRuntimeState {
  run_id: string;
  job_id: string;
  workspace_dir: string;
  config_path: string;
  summary_path: string;
  log_path: string;
  metrics_path: string;
  artifact_path: string;
  cancelled: boolean;
}

interface DatasetTrainingSummary {
  total_items: number;
  ready_items: number;
  annotated_items: number;
  approved_items: number;
  total_boxes: number;
  total_lines: number;
  label_count: number;
}

const trainingRuntimeByJobId = new Map<string, TrainingRuntimeState>();
const trainingLogLinesByJobId = new Map<string, string[]>();
const trainingArtifactAttachmentByJobId = new Map<string, string>();
const trainingWorkerDispatchAbortByJobId = new Map<string, AbortController>();
type TrainingWorkerDispatchHealth = {
  recent_failures: number;
  consecutive_failures: number;
  last_failure_at: number | null;
  last_success_at: number | null;
};
const trainingWorkerDispatchHealthById = new Map<string, TrainingWorkerDispatchHealth>();
type TrainingWorkerDatasetPackageRecord = {
  id: string;
  file_path: string;
  created_at: string;
  expires_at: string;
  authorized_worker_id: string | null;
  total_files: number;
  total_bytes: number;
};
const trainingWorkerDatasetPackageById = new Map<
  string,
  TrainingWorkerDatasetPackageRecord
>();
const trainingWorkerBootstrapTtlMs = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_BOOTSTRAP_TTL_MS ?? '1800000', 10);
  if (!Number.isFinite(parsed) || parsed < 60000) {
    return 1800000;
  }
  return Math.min(parsed, 24 * 60 * 60 * 1000);
})();
const trainingWorkerRecommendedImage = (
  process.env.TRAINING_WORKER_DOCKER_IMAGE ?? 'vistral-training-worker:local'
).trim();
const trainingMetricsMaxPointsPerJob = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_METRICS_MAX_POINTS_PER_JOB ?? '180', 10);
  if (!Number.isFinite(parsed) || parsed < 8) {
    return 180;
  }
  return Math.min(parsed, 2000);
})();
const trainingMetricsMaxTotalRows = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_METRICS_MAX_TOTAL_ROWS ?? '20000', 10);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    return 20000;
  }
  return Math.min(parsed, 200000);
})();
const trainingWorkerHeartbeatTtlMs = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_HEARTBEAT_TTL_MS ?? '45000', 10);
  if (!Number.isFinite(parsed) || parsed < 5000) {
    return 45000;
  }
  return Math.min(parsed, 10 * 60 * 1000);
})();
const trainingWorkerDispatchTimeoutMs = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_DISPATCH_TIMEOUT_MS ?? '1800000', 10);
  if (!Number.isFinite(parsed) || parsed < 5000) {
    return 1800000;
  }
  return Math.min(parsed, 2 * 60 * 60 * 1000);
})();
const trainingWorkerDispatchFallbackLocal = (() => {
  const raw = (process.env.TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL ?? '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
})();
const trainingWorkerDispatchMaxAttempts = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_DISPATCH_MAX_ATTEMPTS ?? '4', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 4;
  }
  return Math.min(parsed, 20);
})();
const trainingWorkerDispatchRetryBaseMs = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_DISPATCH_RETRY_BASE_MS ?? '350', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 350;
  }
  return Math.min(parsed, 10000);
})();
const trainingWorkerFailurePenaltyWindowMs = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_FAILURE_PENALTY_WINDOW_MS ?? '900000', 10);
  if (!Number.isFinite(parsed) || parsed < 10000) {
    return 900000;
  }
  return Math.min(parsed, 12 * 60 * 60 * 1000);
})();
const trainingWorkerFailureCooldownMs = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_FAILURE_COOLDOWN_MS ?? '120000', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 120000;
  }
  return Math.min(parsed, 2 * 60 * 60 * 1000);
})();
const trainingWorkerFailurePenaltyStep = (() => {
  const parsed = Number.parseFloat(process.env.TRAINING_WORKER_FAILURE_PENALTY_STEP ?? '0.18');
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0.18;
  }
  return Math.min(parsed, 2);
})();
const trainingWorkerFailurePenaltyCap = (() => {
  const parsed = Number.parseFloat(process.env.TRAINING_WORKER_FAILURE_PENALTY_CAP ?? '1.2');
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 1.2;
  }
  return Math.min(parsed, 5);
})();
const trainingWorkerDispatchBaseUrl = (process.env.TRAINING_WORKER_DISPATCH_BASE_URL ?? '').trim().replace(/\/+$/, '');
const trainingWorkerPackageStorageRoot = path.resolve(
  process.cwd(),
  (process.env.TRAINING_WORKER_PACKAGE_STORAGE_ROOT ?? '.data/worker-dispatch-packages').trim()
);
const trainingWorkerPackageTtlMs = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_PACKAGE_TTL_MS ?? '3600000', 10);
  if (!Number.isFinite(parsed) || parsed < 60000) {
    return 3600000;
  }
  return Math.min(parsed, 24 * 60 * 60 * 1000);
})();
const trainingWorkerInlinePackageMaxFiles = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_INLINE_PACKAGE_MAX_FILES ?? '800', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 800;
  }
  return Math.min(parsed, 5000);
})();
const trainingWorkerInlinePackageMaxBytes = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_INLINE_PACKAGE_MAX_BYTES ?? `${40 * 1024 * 1024}`, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 40 * 1024 * 1024;
  }
  return Math.min(parsed, 256 * 1024 * 1024);
})();
const trainingWorkerReferencePackageMaxFiles = (() => {
  const parsed = Number.parseInt(process.env.TRAINING_WORKER_REFERENCE_PACKAGE_MAX_FILES ?? '8000', 10);
  if (!Number.isFinite(parsed) || parsed < 20) {
    return 8000;
  }
  return Math.min(parsed, 60000);
})();
const trainingWorkerReferencePackageMaxBytes = (() => {
  const parsed = Number.parseInt(
    process.env.TRAINING_WORKER_REFERENCE_PACKAGE_MAX_BYTES ?? `${512 * 1024 * 1024}`,
    10
  );
  if (!Number.isFinite(parsed) || parsed < 10 * 1024 * 1024) {
    return 512 * 1024 * 1024;
  }
  return Math.min(parsed, 2 * 1024 * 1024 * 1024);
})();
const activeTrainingStatusesForWorkerLoad: TrainingJobRecord['status'][] = [
  'queued',
  'preparing',
  'running',
  'evaluating'
];

const normalizeWorkerStatus = (value: unknown): TrainingWorkerNodeRecord['status'] => {
  if (value === 'online' || value === 'draining') {
    return value;
  }
  return 'offline';
};

const normalizeWorkerEndpoint = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const endpoint = value.trim();
  return endpoint.length > 0 ? endpoint : null;
};

const normalizeWorkerMetadata = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key), String(item)]));
};

const normalizeWorkerCapabilities = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
};

const normalizeWorkerConcurrency = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.min(64, Math.max(1, Math.round(parsed)));
};

const normalizeWorkerDeploymentMode = (
  value: unknown
): TrainingWorkerDeploymentMode => (value === 'script' ? 'script' : 'docker');

const normalizeWorkerProfile = (value: unknown): TrainingWorkerProfile => {
  if (value === 'paddleocr' || value === 'doctr' || value === 'mixed') {
    return value;
  }
  return 'yolo';
};

const normalizeControlPlaneBaseUrl = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Control plane base URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Control plane base URL must be a full http(s) URL.');
  }
  if (!(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    throw new Error('Control plane base URL must use http or https.');
  }
  return parsed.toString().replace(/\/+$/, '');
};

const normalizeWorkerBindPort = (value: unknown): number => {
  if (value === null || value === undefined || value === '') {
    return 9090;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Worker bind port must be a valid number.');
  }
  const rounded = Math.round(parsed);
  if (rounded < 1 || rounded > 65535) {
    throw new Error('Worker bind port must be between 1 and 65535.');
  }
  return rounded;
};

const normalizeWorkerPublicHostInput = (
  hostValue: unknown,
  bindPortValue: unknown
): { workerPublicHost: string | null; workerBindPort: number } => {
  let workerBindPort = normalizeWorkerBindPort(bindPortValue);
  if (typeof hostValue !== 'string' || !hostValue.trim()) {
    return {
      workerPublicHost: null,
      workerBindPort
    };
  }

  const rawValue = hostValue.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawValue) ? rawValue : `http://${rawValue}`);
  } catch {
    throw new Error('Worker public host must be a hostname, IP, or URL reachable by the control plane.');
  }

  if (!parsed.hostname) {
    throw new Error('Worker public host must include a hostname or IP.');
  }
  if (!bindPortValue && parsed.port) {
    workerBindPort = normalizeWorkerBindPort(parsed.port);
  }

  return {
    workerPublicHost: parsed.hostname,
    workerBindPort
  };
};

const formatWorkerUrlHost = (value: string): string =>
  value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;

const buildWorkerEndpointHint = (workerPublicHost: string | null, workerBindPort: number): string | null =>
  workerPublicHost ? `http://${formatWorkerUrlHost(workerPublicHost)}:${workerBindPort}` : null;

const buildWorkerSetupUrlHint = (workerPublicHost: string | null, workerBindPort: number): string => {
  const endpoint = buildWorkerEndpointHint(workerPublicHost, workerBindPort);
  return endpoint ? `${endpoint}/setup` : `http://<worker-host>:${workerBindPort}/setup`;
};

const toWorkerNameSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'worker';

const buildWorkerProfileCapabilities = (profile: TrainingWorkerProfile): string[] => {
  if (profile === 'paddleocr') {
    return ['framework:paddleocr', 'task:ocr'];
  }
  if (profile === 'doctr') {
    return ['framework:doctr', 'task:ocr'];
  }
  if (profile === 'mixed') {
    return [
      'framework:yolo',
      'framework:paddleocr',
      'framework:doctr',
      'task:detection',
      'task:ocr'
    ];
  }
  return ['framework:yolo', 'task:detection'];
};

const buildWorkerRuntimeProfile = (profile: TrainingWorkerProfile): string =>
  profile === 'mixed' ? 'all' : profile;

const inferWorkerProfileFromCapabilities = (capabilities: string[]): TrainingWorkerProfile => {
  const normalized = capabilities.map((item) => item.trim().toLowerCase());
  const hasYolo = normalized.includes('framework:yolo');
  const hasPaddle = normalized.includes('framework:paddleocr');
  const hasDoctr = normalized.includes('framework:doctr');
  const hasDetection = normalized.includes('task:detection');
  const hasOcr = normalized.includes('task:ocr');
  const hasOcrRuntime = hasPaddle || hasDoctr || hasOcr;
  const hasDetectionRuntime = hasYolo || hasDetection;

  if (hasDetectionRuntime && hasOcrRuntime) {
    return 'mixed';
  }
  if (hasPaddle && !hasDoctr) {
    return 'paddleocr';
  }
  if (hasDoctr && !hasPaddle) {
    return 'doctr';
  }
  return 'yolo';
};

const parseWorkerPublicHostAndPortFromEndpoint = (
  endpoint: string | null
): { workerPublicHost: string | null; workerBindPort: number } => {
  if (!endpoint) {
    return { workerPublicHost: null, workerBindPort: 9090 };
  }
  try {
    const parsed = new URL(endpoint);
    const workerPublicHost = parsed.hostname?.trim() || null;
    const parsedPort = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0) {
      return { workerPublicHost, workerBindPort: parsedPort };
    }
    const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
    return { workerPublicHost, workerBindPort: defaultPort };
  } catch {
    return { workerPublicHost: null, workerBindPort: 9090 };
  }
};

const buildBootstrapTokenPreview = (token: string): string => {
  if (token.length <= 14) {
    return token;
  }
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
};

const buildWorkerAuthTokenPreview = (token: string): string => {
  if (token.length <= 16) {
    return token;
  }
  return `${token.slice(0, 9)}...${token.slice(-4)}`;
};

const issueDedicatedTrainingWorkerToken = (workerId: string): string => {
  const existing = trainingWorkerAuthTokensByWorkerId[workerId];
  if (typeof existing === 'string' && existing.trim()) {
    return existing.trim();
  }
  const issued = `vtwa_${randomBytes(16).toString('hex')}`;
  trainingWorkerAuthTokensByWorkerId[workerId] = issued;
  markAppStateDirty();
  return issued;
};

const revokeDedicatedTrainingWorkerToken = (workerId: string): void => {
  if (!trainingWorkerAuthTokensByWorkerId[workerId]) {
    return;
  }
  delete trainingWorkerAuthTokensByWorkerId[workerId];
  markAppStateDirty();
};

const getDedicatedTrainingWorkerToken = (workerId: string | null | undefined): string | null => {
  if (!workerId) {
    return null;
  }
  const token = trainingWorkerAuthTokensByWorkerId[workerId];
  return typeof token === 'string' && token.trim() ? token.trim() : null;
};

const getTrainingWorkerSharedFallbackToken = (): string | null => {
  const token = (process.env.TRAINING_WORKER_SHARED_TOKEN ?? '').trim();
  return token || null;
};

const resolveTrainingWorkerAuthMode = (workerId: string | null | undefined): 'shared' | 'dedicated' =>
  getDedicatedTrainingWorkerToken(workerId) ? 'dedicated' : 'shared';

const resolveTrainingWorkerAuthTokenPreview = (workerId: string | null | undefined): string | null => {
  const dedicated = getDedicatedTrainingWorkerToken(workerId);
  return dedicated ? buildWorkerAuthTokenPreview(dedicated) : null;
};

const applyTrainingWorkerAuthPresentation = (worker: TrainingWorkerNodeRecord): TrainingWorkerNodeRecord => ({
  ...worker,
  auth_mode: resolveTrainingWorkerAuthMode(worker.id),
  auth_token_preview: resolveTrainingWorkerAuthTokenPreview(worker.id)
});

const applyBootstrapSessionAuthPresentation = (
  session: TrainingWorkerBootstrapSessionRecord
): TrainingWorkerBootstrapSessionRecord => ({
  ...session,
  issued_auth_mode: resolveTrainingWorkerAuthMode(session.worker_id),
  issued_auth_token_preview: resolveTrainingWorkerAuthTokenPreview(session.worker_id)
});

const resolveOutboundTrainingWorkerToken = (workerId: string): string => {
  const dedicated = getDedicatedTrainingWorkerToken(workerId);
  if (dedicated) {
    return dedicated;
  }
  const shared = getTrainingWorkerSharedFallbackToken();
  if (shared) {
    return shared;
  }
  throw new Error('Training worker token is not configured.');
};

const assertTrainingWorkerHeartbeatToken = (params: {
  token: string | null | undefined;
  worker_id?: string | null;
  endpoint?: string | null;
}): void => {
  const incomingToken = params.token?.trim();
  if (!incomingToken) {
    throw new Error('Training worker token is invalid.');
  }

  const workerId = params.worker_id?.trim() ?? '';
  const endpoint = params.endpoint?.trim() ?? '';
  const dedicatedById = getDedicatedTrainingWorkerToken(workerId);
  if (dedicatedById && incomingToken === dedicatedById) {
    return;
  }

  if (endpoint) {
    const matchedByEndpoint = trainingWorkerNodes.find((worker) => worker.endpoint === endpoint) ?? null;
    const dedicatedByEndpoint = getDedicatedTrainingWorkerToken(matchedByEndpoint?.id ?? null);
    if (dedicatedByEndpoint && incomingToken === dedicatedByEndpoint) {
      return;
    }
  }

  const shared = getTrainingWorkerSharedFallbackToken();
  if (shared && incomingToken === shared) {
    return;
  }

  if (!shared && !dedicatedById) {
    throw new Error('Training worker token is not configured.');
  }
  throw new Error('Training worker token is invalid.');
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const buildTrainingWorkerCommands = (session: TrainingWorkerBootstrapSessionRecord) => {
  const envAssignments = [
    `WORKER_BOOTSTRAP_TOKEN=${shellQuote(session.pairing_token)}`,
    `WORKER_BOOTSTRAP_CONTROL_PLANE_URL=${shellQuote(session.control_plane_base_url)}`,
    `WORKER_RUNTIME_PROFILE=${shellQuote(session.worker_runtime_profile)}`,
    `WORKER_MAX_CONCURRENCY=${shellQuote(String(session.max_concurrency))}`,
    `WORKER_BIND_PORT=${shellQuote(String(session.worker_bind_port))}`
  ];
  if (session.worker_public_host) {
    envAssignments.push(`WORKER_PUBLIC_HOST=${shellQuote(session.worker_public_host)}`);
  }
  if (session.worker_endpoint_hint) {
    envAssignments.push(`WORKER_ENDPOINT=${shellQuote(session.worker_endpoint_hint)}`);
  }
  const envPrefix = envAssignments.join(' ');
  const containerName = `vistral-${toWorkerNameSlug(session.worker_name)}`;
  const dockerEnvArgs = envAssignments.map((entry) => `-e ${entry}`).join(' ');
  return {
    dockerCommand: `docker run -d --name ${containerName} -p ${session.worker_bind_port}:${session.worker_bind_port} ${dockerEnvArgs} -e WORKER_RUN_ROOT=/worker-state/runs -v vistral-worker-state:/worker-state ${trainingWorkerRecommendedImage}`,
    scriptCommand: `${envPrefix} bash training-worker/scripts/bootstrap-worker.sh && ${envPrefix} bash training-worker/scripts/run-worker-node.sh`
  };
};

const buildTrainingWorkerBootstrapBundle = (
  session: TrainingWorkerBootstrapSessionRecord
): { filename: string; content: string } => {
  const mode = session.deployment_mode;
  const safeName = toWorkerNameSlug(session.worker_name);
  const fileName = `worker-bootstrap-${safeName || session.id}.sh`;
  const content = `#!/usr/bin/env bash
set -euo pipefail

MODE="\${1:-${mode}}"
PAIRING_TOKEN=${shellQuote(session.pairing_token)}
CONTROL_PLANE_BASE_URL=${shellQuote(session.control_plane_base_url)}
RECOMMENDED_SETUP_URL=${shellQuote(session.setup_url_hint)}
DOCKER_COMMAND=${shellQuote(session.docker_command)}
SCRIPT_COMMAND=${shellQuote(session.script_command)}

echo "[vistral-worker-bootstrap] worker=${session.worker_name}"
echo "[vistral-worker-bootstrap] profile=${session.worker_profile}"
echo "[vistral-worker-bootstrap] control_plane=\${CONTROL_PLANE_BASE_URL}"
echo "[vistral-worker-bootstrap] setup_url=\${RECOMMENDED_SETUP_URL}"
echo "[vistral-worker-bootstrap] mode=\${MODE}"

if [[ "\${MODE}" == "--print" ]]; then
  echo
  echo "Pairing token: \${PAIRING_TOKEN}"
  echo "Docker command:"
  echo "\${DOCKER_COMMAND}"
  echo
  echo "Script command:"
  echo "\${SCRIPT_COMMAND}"
  exit 0
fi

if [[ "\${MODE}" == "docker" ]]; then
  echo "[vistral-worker-bootstrap] starting docker worker..."
  bash -lc "\${DOCKER_COMMAND}"
elif [[ "\${MODE}" == "script" ]]; then
  echo "[vistral-worker-bootstrap] running repo script flow..."
  bash -lc "\${SCRIPT_COMMAND}"
else
  echo "[vistral-worker-bootstrap] unsupported mode: \${MODE}" >&2
  echo "Use: $0 [docker|script|--print]" >&2
  exit 2
fi

echo
echo "[vistral-worker-bootstrap] next:"
echo "  1. Open \${RECOMMENDED_SETUP_URL}"
echo "  2. Click '使用配对码' (or paste pairing token manually if needed)"
echo "  3. Confirm worker endpoint / capabilities / run root"
echo "  4. Validate and save in the worker local setup UI"
`;
  return {
    filename: fileName,
    content
  };
};

const parseBootstrapExpiry = (session: TrainingWorkerBootstrapSessionRecord): number =>
  Date.parse(session.expires_at);

const cleanupExpiredBootstrapSessions = (nowMs = Date.now()): void => {
  let changed = false;
  trainingWorkerBootstrapSessions.forEach((session) => {
    if (session.status === 'online') {
      return;
    }
    const expiresAtMs = parseBootstrapExpiry(session);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
      if (session.status !== 'expired') {
        session.status = 'expired';
        revokeDedicatedTrainingWorkerToken(session.worker_id);
        changed = true;
      }
    }
  });
  if (changed) {
    markAppStateDirty();
  }
};

const findBootstrapSessionByPairingToken = (
  pairingToken: string
): TrainingWorkerBootstrapSessionRecord | null =>
  trainingWorkerBootstrapSessions.find((session) => session.pairing_token === pairingToken) ?? null;

const findBootstrapSessionById = (
  sessionId: string
): TrainingWorkerBootstrapSessionRecord | null =>
  trainingWorkerBootstrapSessions.find((session) => session.id === sessionId) ?? null;

const findLatestBootstrapSessionByWorkerId = (
  workerId: string
): TrainingWorkerBootstrapSessionRecord | null =>
  trainingWorkerBootstrapSessions
    .filter(
      (session) =>
        session.status !== 'expired' &&
        (session.worker_id === workerId || session.linked_worker_id === workerId)
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0] ?? null;

const resolveControlPlaneBaseUrlForWorkerReconfigure = (workerId: string): string => {
  const fromRecentSession = findLatestBootstrapSessionByWorkerId(workerId)?.control_plane_base_url;
  if (typeof fromRecentSession === 'string' && fromRecentSession.trim()) {
    return normalizeControlPlaneBaseUrl(fromRecentSession);
  }
  const fromEnv = (
    process.env.TRAINING_WORKER_DISPATCH_BASE_URL ??
    process.env.CONTROL_PLANE_BASE_URL ??
    ''
  ).trim();
  if (fromEnv) {
    return normalizeControlPlaneBaseUrl(fromEnv);
  }
  throw new Error(
    'Control plane base URL is unavailable for worker reconfigure. Create an Add Worker session first or set TRAINING_WORKER_DISPATCH_BASE_URL.'
  );
};

const buildWorkerCallbackHealthUrls = (endpoint: string): string[] => {
  const normalized = endpoint.trim().replace(/\/+$/, '');
  if (!normalized) {
    return [];
  }
  return [`${normalized}/api/worker/healthz`, `${normalized}/healthz`];
};

const workerHealthContractVersion = 'training-worker-healthz.v1';

type WorkerHealthSnapshot = {
  reported_runtime_profile: string | null;
  reported_worker_version: string | null;
  reported_contract_version: string | null;
  reported_capabilities: string[];
};

type WorkerCallbackProbeExpectation = {
  expected_runtime_profile?: string | null;
  expected_capabilities?: string[] | null;
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readStringField = (source: Record<string, unknown> | null, key: string): string | null => {
  const raw = source?.[key];
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim();
  return normalized || null;
};

const readStringArrayField = (source: Record<string, unknown> | null, key: string): string[] => {
  const raw = source?.[key];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
};

const parseWorkerHealthSnapshot = (payload: unknown): WorkerHealthSnapshot => {
  const root = asObject(payload);
  const workerNode = asObject(root?.worker) ?? asObject(root?.runtime);
  const primary = workerNode ?? root;
  const reported_runtime_profile =
    readStringField(primary, 'runtime_profile') ?? readStringField(root, 'worker_runtime_profile');
  const reported_worker_version =
    readStringField(primary, 'worker_version') ?? readStringField(root, 'worker_version');
  const reported_contract_version =
    readStringField(primary, 'contract_version') ?? readStringField(root, 'contract_version');
  const reported_capabilities = [
    ...readStringArrayField(primary, 'capabilities'),
    ...readStringArrayField(root, 'capabilities')
  ];
  const dedupedCapabilities = Array.from(new Set(reported_capabilities));
  return {
    reported_runtime_profile,
    reported_worker_version,
    reported_contract_version,
    reported_capabilities: dedupedCapabilities
  };
};

const buildCompatibilitySnapshot = (
  expected: WorkerCallbackProbeExpectation,
  reported: WorkerHealthSnapshot
): { compatibility: TrainingWorkerCompatibilitySnapshot; hard_incompatible: boolean } => {
  const expectedRuntimeProfile = expected.expected_runtime_profile?.trim() || null;
  const expectedCapabilities = Array.isArray(expected.expected_capabilities)
    ? Array.from(
        new Set(
          expected.expected_capabilities
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.trim())
        )
      )
    : [];
  const reportedCapabilities = reported.reported_capabilities;
  const missingCapabilities = expectedCapabilities.filter(
    (capability) => !reportedCapabilities.includes(capability)
  );

  const warnings: string[] = [];
  let incompatibleReason: string | null = null;

  if (
    expectedRuntimeProfile &&
    expectedRuntimeProfile !== 'all' &&
    reported.reported_runtime_profile &&
    reported.reported_runtime_profile !== expectedRuntimeProfile
  ) {
    incompatibleReason = `Runtime profile mismatch (expected ${expectedRuntimeProfile}, reported ${reported.reported_runtime_profile}).`;
  }

  if (expectedRuntimeProfile && !reported.reported_runtime_profile) {
    warnings.push('Worker health payload does not report runtime_profile; keep worker package updated.');
  }
  if (!reported.reported_contract_version) {
    warnings.push('Worker health payload does not report contract_version.');
  } else if (reported.reported_contract_version !== workerHealthContractVersion) {
    warnings.push(
      `Worker contract version ${reported.reported_contract_version} is different from expected ${workerHealthContractVersion}.`
    );
  }
  if (!reported.reported_worker_version) {
    warnings.push('Worker health payload does not report worker_version.');
  }
  if (expectedCapabilities.length > 0) {
    if (reportedCapabilities.length === 0) {
      warnings.push('Worker health payload does not report capabilities.');
    } else if (missingCapabilities.length > 0) {
      warnings.push(`Worker capabilities missing: ${missingCapabilities.join(', ')}.`);
    }
  }

  const status: TrainingWorkerCompatibilitySnapshot['status'] = incompatibleReason
    ? 'incompatible'
    : warnings.length > 0
      ? 'warning'
      : 'compatible';
  const message = incompatibleReason ?? warnings[0] ?? 'Worker callback and compatibility checks passed.';

  return {
    hard_incompatible: Boolean(incompatibleReason),
    compatibility: {
      status,
      message,
      expected_runtime_profile: expectedRuntimeProfile,
      reported_runtime_profile: reported.reported_runtime_profile,
      reported_worker_version: reported.reported_worker_version,
      reported_contract_version: reported.reported_contract_version,
      missing_capabilities: missingCapabilities
    }
  };
};

const probeWorkerCallback = async (
  endpoint: string,
  expected: WorkerCallbackProbeExpectation = {}
): Promise<{ ok: boolean; message: string; compatibility: TrainingWorkerCompatibilitySnapshot }> => {
  const unknownCompatibility: TrainingWorkerCompatibilitySnapshot = {
    status: 'unknown',
    message: 'Compatibility check has not run yet.',
    expected_runtime_profile: expected.expected_runtime_profile?.trim() || null,
    reported_runtime_profile: null,
    reported_worker_version: null,
    reported_contract_version: null,
    missing_capabilities: []
  };
  const urls = buildWorkerCallbackHealthUrls(endpoint);
  if (urls.length === 0) {
    return {
      ok: false,
      message: 'Worker endpoint is missing; callback validation cannot run.',
      compatibility: {
        ...unknownCompatibility,
        status: 'incompatible',
        message: 'Worker endpoint is missing; callback validation cannot run.'
      }
    };
  }

  let lastFailureMessage = 'Worker callback validation failed.';
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(4000)
      });
      if (response.ok) {
        const rawBody = await response.text();
        let parsedBody: unknown = null;
        if (rawBody.trim()) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            parsedBody = null;
          }
        }
        const reported = parseWorkerHealthSnapshot(parsedBody);
        const { compatibility, hard_incompatible } = buildCompatibilitySnapshot(expected, reported);
        if (hard_incompatible) {
          return {
            ok: false,
            message: `Worker callback compatibility check failed at ${url}: ${compatibility.message}`,
            compatibility
          };
        }
        return {
          ok: true,
          message: `Control plane reached worker health endpoint: ${url}`,
          compatibility
        };
      }
      lastFailureMessage = `Worker callback returned HTTP ${response.status} at ${url}`;
    } catch (error) {
      lastFailureMessage = `Worker callback probe failed at ${url}: ${(error as Error).message}`;
    }
  }

  return {
    ok: false,
    message: lastFailureMessage,
    compatibility: {
      ...unknownCompatibility,
      status: 'incompatible',
      message: lastFailureMessage
    }
  };
};

const normalizeWorkerReportedLoad = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(1, parsed));
};

const getWorkerInFlightJobs = (workerId: string): number =>
  trainingJobs.filter(
    (job) =>
      job.scheduled_worker_id === workerId &&
      activeTrainingStatusesForWorkerLoad.includes(job.status)
  ).length;

const resolveWorkerEffectiveStatus = (
  worker: TrainingWorkerNodeRecord,
  nowMs = Date.now()
): TrainingWorkerNodeRecord['status'] => {
  if (worker.status !== 'online') {
    return worker.status;
  }
  if (!worker.endpoint) {
    return worker.status;
  }
  if (!worker.last_heartbeat_at) {
    return 'offline';
  }
  const heartbeatMs = Date.parse(worker.last_heartbeat_at);
  if (!Number.isFinite(heartbeatMs)) {
    return 'offline';
  }
  return nowMs - heartbeatMs > trainingWorkerHeartbeatTtlMs ? 'offline' : 'online';
};

const computeWorkerLoadScore = (worker: TrainingWorkerNodeRecord): number => {
  const inFlight = getWorkerInFlightJobs(worker.id);
  const inFlightRatio = inFlight / Math.max(1, worker.max_concurrency);
  const reported = worker.last_reported_load ?? 0;
  return Number(Math.max(inFlightRatio, reported).toFixed(4));
};

const cleanupStaleWorkerDispatchHealth = (nowMs = Date.now()): void => {
  for (const [workerId, health] of trainingWorkerDispatchHealthById.entries()) {
    const lastSignalAt = Math.max(health.last_failure_at ?? 0, health.last_success_at ?? 0);
    if (lastSignalAt <= 0 || nowMs - lastSignalAt <= trainingWorkerFailurePenaltyWindowMs) {
      continue;
    }
    trainingWorkerDispatchHealthById.delete(workerId);
  }
};

const getWorkerDispatchHealth = (workerId: string, nowMs = Date.now()): TrainingWorkerDispatchHealth => {
  const existing = trainingWorkerDispatchHealthById.get(workerId);
  if (!existing) {
    return {
      recent_failures: 0,
      consecutive_failures: 0,
      last_failure_at: null,
      last_success_at: null
    };
  }

  if (
    existing.last_failure_at &&
    nowMs - existing.last_failure_at > trainingWorkerFailurePenaltyWindowMs &&
    existing.recent_failures > 0
  ) {
    const reset: TrainingWorkerDispatchHealth = {
      ...existing,
      recent_failures: 0
    };
    trainingWorkerDispatchHealthById.set(workerId, reset);
    return reset;
  }

  return existing;
};

const markWorkerDispatchFailure = (workerId: string, failureAtMs = Date.now()): void => {
  const previous = getWorkerDispatchHealth(workerId, failureAtMs);
  const next: TrainingWorkerDispatchHealth = {
    recent_failures: Math.min(64, previous.recent_failures + 1),
    consecutive_failures: Math.min(64, previous.consecutive_failures + 1),
    last_failure_at: failureAtMs,
    last_success_at: previous.last_success_at
  };
  trainingWorkerDispatchHealthById.set(workerId, next);
};

const markWorkerDispatchSuccess = (workerId: string, successAtMs = Date.now()): void => {
  const previous = getWorkerDispatchHealth(workerId, successAtMs);
  const next: TrainingWorkerDispatchHealth = {
    recent_failures: 0,
    consecutive_failures: 0,
    last_failure_at: previous.last_failure_at,
    last_success_at: successAtMs
  };
  trainingWorkerDispatchHealthById.set(workerId, next);
};

const computeWorkerCapabilityAffinity = (
  worker: TrainingWorkerNodeRecord,
  taskType: TaskType,
  framework: ModelFramework
): number => {
  const capabilities = worker.capabilities;
  if (capabilities.length === 0) {
    return 0;
  }
  let bonus = 0;
  if (capabilities.includes(`framework:${framework}`)) {
    bonus += 0.04;
  }
  if (capabilities.includes(`task:${taskType}`)) {
    bonus += 0.04;
  }
  return bonus;
};

const computeWorkerHealthPenalty = (workerId: string, nowMs = Date.now()): number => {
  const health = getWorkerDispatchHealth(workerId, nowMs);
  if (health.recent_failures <= 0 && health.consecutive_failures <= 0) {
    return 0;
  }

  let penalty = Math.min(
    trainingWorkerFailurePenaltyCap,
    health.recent_failures * trainingWorkerFailurePenaltyStep +
      health.consecutive_failures * trainingWorkerFailurePenaltyStep * 0.5
  );

  if (
    trainingWorkerFailureCooldownMs > 0 &&
    health.last_failure_at &&
    nowMs - health.last_failure_at <= trainingWorkerFailureCooldownMs
  ) {
    penalty += 0.5;
  }

  return Number(Math.min(trainingWorkerFailurePenaltyCap, penalty).toFixed(4));
};

const workerSupportsJob = (
  worker: TrainingWorkerNodeRecord,
  taskType: TaskType,
  framework: ModelFramework
): boolean => {
  const capabilities = worker.capabilities;
  if (capabilities.length === 0) {
    return true;
  }
  const frameworkTag = `framework:${framework}`;
  const taskTag = `task:${taskType}`;
  const hasFramework =
    capabilities.includes(frameworkTag) ||
    !capabilities.some((capability) => capability.startsWith('framework:'));
  const hasTask =
    capabilities.includes(taskTag) ||
    !capabilities.some((capability) => capability.startsWith('task:'));
  return hasFramework && hasTask;
};

type TrainingWorkerSchedulingCandidate = {
  worker: TrainingWorkerNodeRecord;
  score: number;
  load: number;
  inFlight: number;
  capabilityBonus: number;
  healthPenalty: number;
};

type TrainingWorkerSchedulingSelection = {
  execution_target: TrainingJobRecord['execution_target'];
  worker: TrainingWorkerNodeRecord | null;
  note: string;
  decision: TrainingSchedulerDecision;
};

const buildTrainingSchedulerDecision = (params: {
  trigger: string;
  attempt: number;
  executionTarget: TrainingJobRecord['execution_target'];
  selected: TrainingWorkerSchedulingCandidate | null;
  note: string;
  fallbackReason: string | null;
  excludedWorkerIds: string[];
  decidedAt: string;
}): TrainingSchedulerDecision => ({
  policy: 'load_aware_v1',
  trigger: params.trigger,
  attempt: Math.max(1, params.attempt),
  execution_target: params.executionTarget,
  selected_worker_id: params.selected?.worker.id ?? null,
  selected_worker_score: params.selected?.score ?? null,
  selected_worker_load_component: params.selected?.load ?? null,
  selected_worker_health_penalty: params.selected?.healthPenalty ?? null,
  selected_worker_capability_bonus: params.selected?.capabilityBonus ?? null,
  selected_worker_in_flight_jobs: params.selected?.inFlight ?? null,
  selected_worker_max_concurrency: params.selected?.worker.max_concurrency ?? null,
  excluded_worker_ids: params.excludedWorkerIds,
  fallback_reason: params.fallbackReason,
  note: params.note,
  decided_at: params.decidedAt
});

const trainingSchedulerDecisionHistoryLimit = 24;

const recordTrainingSchedulerDecision = (
  job: TrainingJobRecord,
  decision: TrainingSchedulerDecision
): void => {
  job.scheduler_decision = decision;
  const nextHistory = [...(job.scheduler_decision_history ?? [])];
  const previous = nextHistory.at(-1);
  const duplicateLatest =
    previous &&
    previous.decided_at === decision.decided_at &&
    previous.trigger === decision.trigger &&
    previous.attempt === decision.attempt &&
    previous.note === decision.note;
  if (!duplicateLatest) {
    nextHistory.push(decision);
  } else {
    nextHistory[nextHistory.length - 1] = decision;
  }
  if (nextHistory.length > trainingSchedulerDecisionHistoryLimit) {
    nextHistory.splice(0, nextHistory.length - trainingSchedulerDecisionHistoryLimit);
  }
  job.scheduler_decision_history = nextHistory;
};

const selectTrainingWorkerForJob = (
  taskType: TaskType,
  framework: ModelFramework,
  options?: {
    excludedWorkerIds?: ReadonlySet<string>;
    trigger?: string;
    attempt?: number;
    fallbackReason?: string | null;
  }
): TrainingWorkerSchedulingSelection => {
  const nowMs = Date.now();
  const decidedAt = now();
  cleanupStaleWorkerDispatchHealth(nowMs);
  const excludedWorkerIds = options?.excludedWorkerIds;
  const excludedWorkerIdList = excludedWorkerIds ? Array.from(excludedWorkerIds) : [];
  const candidates = trainingWorkerNodes
    .filter((worker) => worker.enabled)
    .filter((worker) => Boolean(worker.endpoint))
    .filter((worker) => !(excludedWorkerIds?.has(worker.id) ?? false))
    .filter((worker) => resolveWorkerEffectiveStatus(worker, nowMs) === 'online')
    .filter((worker) => workerSupportsJob(worker, taskType, framework))
    .filter((worker) => getWorkerInFlightJobs(worker.id) < Math.max(1, worker.max_concurrency))
    .map((worker) => ({
      worker,
      load: computeWorkerLoadScore(worker),
      inFlight: getWorkerInFlightJobs(worker.id),
      capabilityBonus: computeWorkerCapabilityAffinity(worker, taskType, framework),
      healthPenalty: computeWorkerHealthPenalty(worker.id, nowMs)
    }))
    .map((entry) => ({
      ...entry,
      score: Number(Math.max(0, entry.load + entry.healthPenalty - entry.capabilityBonus).toFixed(4))
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.inFlight !== right.inFlight) {
        return left.inFlight - right.inFlight;
      }
      return left.worker.id.localeCompare(right.worker.id);
    });

  const best = candidates[0];
  if (!best) {
    const note = 'scheduler_fallback:no_online_worker';
    return {
      execution_target: 'control_plane',
      worker: null,
      note,
      decision: buildTrainingSchedulerDecision({
        trigger: options?.trigger ?? 'schedule',
        attempt: options?.attempt ?? 1,
        executionTarget: 'control_plane',
        selected: null,
        note,
        fallbackReason: options?.fallbackReason ?? 'no_online_worker',
        excludedWorkerIds: excludedWorkerIdList,
        decidedAt
      })
    };
  }

  const note =
    `scheduler_worker:${best.worker.id};score=${best.score};load=${best.load};` +
    `penalty=${best.healthPenalty};capability_bonus=${best.capabilityBonus};` +
    `in_flight=${best.inFlight};max=${best.worker.max_concurrency}`;
  return {
    execution_target: 'worker',
    worker: best.worker,
    note,
    decision: buildTrainingSchedulerDecision({
      trigger: options?.trigger ?? 'schedule',
      attempt: options?.attempt ?? 1,
      executionTarget: 'worker',
      selected: best,
      note,
      fallbackReason: options?.fallbackReason ?? null,
      excludedWorkerIds: excludedWorkerIdList,
      decidedAt
    })
  };
};

const resolveDispatchRetryDelayMs = (attemptIndex: number): number => {
  if (trainingWorkerDispatchRetryBaseMs <= 0) {
    return 0;
  }
  const safeAttempt = Math.max(1, attemptIndex);
  const computed = trainingWorkerDispatchRetryBaseMs * 2 ** Math.max(0, safeAttempt - 1);
  return Math.min(computed, 5000);
};

const findArtifactAttachmentIdByJob = (jobId: string): string | null => {
  const inMemory = trainingArtifactAttachmentByJobId.get(jobId);
  if (inMemory) {
    return inMemory;
  }

  const viaVersion = modelVersions.find((version) => version.training_job_id === jobId)?.artifact_attachment_id;
  if (viaVersion) {
    trainingArtifactAttachmentByJobId.set(jobId, viaVersion);
    return viaVersion;
  }

  const marker = `${path.sep}${jobId}${path.sep}artifacts${path.sep}`;
  const viaStorage = attachments.find((attachment) => attachment.storage_path?.includes(marker))?.id ?? null;
  if (viaStorage) {
    trainingArtifactAttachmentByJobId.set(jobId, viaStorage);
  }
  return viaStorage;
};

class TrainingCancelledError extends Error {}

const toPositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const getTrainingRuntime = (jobId: string): TrainingRuntimeState | null => trainingRuntimeByJobId.get(jobId) ?? null;

const assertRuntimeActive = (jobId: string, runId: string): TrainingRuntimeState => {
  const runtime = getTrainingRuntime(jobId);
  if (!runtime || runtime.run_id !== runId) {
    throw new TrainingCancelledError('Training run is stale.');
  }
  if (runtime.cancelled) {
    throw new TrainingCancelledError('Training run cancelled.');
  }
  return runtime;
};

const waitWithCancelCheck = async (jobId: string, runId: string, totalMs: number): Promise<void> => {
  const slice = 120;
  let elapsed = 0;
  while (elapsed < totalMs) {
    await delay(Math.min(slice, totalMs - elapsed));
    elapsed += slice;
    assertRuntimeActive(jobId, runId);
  }
};

const appendTrainingLog = async (
  job: TrainingJobRecord,
  runtime: TrainingRuntimeState,
  message: string
): Promise<void> => {
  const line = `[${now()}] ${message}`;
  const logs = trainingLogLinesByJobId.get(job.id) ?? [];
  logs.push(line);
  if (logs.length > 240) {
    logs.splice(0, logs.length - 240);
  }
  trainingLogLinesByJobId.set(job.id, logs);
  job.log_excerpt = line;
  job.updated_at = now();
  markAppStateDirty();

  await fs.mkdir(path.dirname(runtime.log_path), { recursive: true });
  await fs.appendFile(runtime.log_path, `${line}\n`, 'utf8');
};

const buildDatasetTrainingSummary = (datasetId: string): DatasetTrainingSummary => {
  const items = datasetItems.filter((item) => item.dataset_id === datasetId);
  const readyItems = items.filter((item) => item.status === 'ready');
  const itemIds = new Set(items.map((item) => item.id));
  const itemAnnotations = annotations.filter((annotation) => itemIds.has(annotation.dataset_item_id));
  const annotatedItems = new Set(
    itemAnnotations
      .filter((annotation) => ['annotated', 'in_review', 'approved'].includes(annotation.status))
      .map((annotation) => annotation.dataset_item_id)
  );
  const approvedItems = new Set(
    itemAnnotations
      .filter((annotation) => annotation.status === 'approved')
      .map((annotation) => annotation.dataset_item_id)
  );

  let totalBoxes = 0;
  let totalLines = 0;
  const labels = new Set<string>();

  itemAnnotations.forEach((annotation) => {
    const payload = annotation.payload as {
      boxes?: Array<{ label?: string }>;
      lines?: Array<{ text?: string }>;
    };

    const boxes = Array.isArray(payload.boxes) ? payload.boxes : [];
    totalBoxes += boxes.length;
    boxes.forEach((box) => {
      if (box.label && box.label.trim()) {
        labels.add(box.label.trim());
      }
    });

    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    totalLines += lines.length;
  });

  return {
    total_items: items.length,
    ready_items: readyItems.length,
    annotated_items: annotatedItems.size,
    approved_items: approvedItems.size,
    total_boxes: totalBoxes,
    total_lines: totalLines,
    label_count: labels.size
  };
};

const buildTrainingMetrics = (
  job: TrainingJobRecord,
  summary: DatasetTrainingSummary
): Record<string, number> => {
  const readyRatio = summary.total_items > 0 ? summary.ready_items / summary.total_items : 0;
  const annotatedRatio = summary.total_items > 0 ? summary.annotated_items / summary.total_items : 0;
  const approvedRatio = summary.total_items > 0 ? summary.approved_items / summary.total_items : 0;

  if (job.task_type === 'ocr') {
    const frameworkBias = job.framework === 'paddleocr' ? 0.015 : job.framework === 'doctr' ? 0.006 : 0;
    const baseScore = clamp(
      0.45 + readyRatio * 0.18 + annotatedRatio * 0.22 + approvedRatio * 0.13 + frameworkBias,
      0.52,
      0.99
    );
    const cer = clamp(0.22 - baseScore * 0.14, 0.01, 0.35);
    const wer = clamp(0.28 - baseScore * 0.16, 0.02, 0.4);
    return {
      accuracy: Number(baseScore.toFixed(4)),
      cer: Number(cer.toFixed(4)),
      wer: Number(wer.toFixed(4))
    };
  }

  if (job.task_type === 'detection' || job.task_type === 'obb') {
    const densityFactor = clamp(summary.total_boxes / Math.max(1, summary.annotated_items), 0, 6) / 10;
    const map = clamp(0.28 + annotatedRatio * 0.36 + approvedRatio * 0.22 + densityFactor, 0.25, 0.96);
    const precision = clamp(map + 0.06, 0.3, 0.99);
    const recall = clamp(map - 0.04, 0.2, 0.95);
    return {
      map: Number(map.toFixed(4)),
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4))
    };
  }

  if (job.task_type === 'segmentation') {
    const miou = clamp(0.24 + annotatedRatio * 0.44 + approvedRatio * 0.2, 0.22, 0.93);
    const dice = clamp(miou + 0.08, 0.3, 0.97);
    return {
      miou: Number(miou.toFixed(4)),
      dice: Number(dice.toFixed(4))
    };
  }

  const accuracy = clamp(0.4 + annotatedRatio * 0.42 + approvedRatio * 0.1, 0.42, 0.97);
  const f1 = clamp(accuracy - 0.04, 0.32, 0.95);
  return {
    accuracy: Number(accuracy.toFixed(4)),
    f1: Number(f1.toFixed(4))
  };
};

const isLowerBetterMetric = (metricName: string): boolean => {
  const normalized = metricName.trim().toLowerCase();
  return (
    normalized === 'cer' ||
    normalized === 'wer' ||
    normalized.startsWith('loss') ||
    normalized.endsWith('_loss')
  );
};

const normalizeMetricSeries = (
  metricSeries?: Array<{ step: number; metrics: Record<string, number> }>
): Array<{ step: number; metrics: Record<string, number> }> => {
  if (!Array.isArray(metricSeries)) {
    return [];
  }

  const normalized = metricSeries
    .map((point) => {
      const step = Number(point.step);
      if (!Number.isFinite(step) || step < 1) {
        return null;
      }

      const metrics = Object.fromEntries(
        Object.entries(point.metrics ?? {}).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
        )
      );
      if (Object.keys(metrics).length === 0) {
        return null;
      }

      return {
        step: Math.round(step),
        metrics
      };
    })
    .filter((point): point is { step: number; metrics: Record<string, number> } => Boolean(point));

  normalized.sort((left, right) => left.step - right.step);
  return normalized;
};

const buildMetricSeriesFromSummary = (
  metrics: Record<string, number>,
  preferredSteps: number
): Array<{ step: number; metrics: Record<string, number> }> => {
  if (Object.keys(metrics).length === 0) {
    return [];
  }

  const stepCount = Math.max(1, Math.min(preferredSteps, 16));
  const series: Array<{ step: number; metrics: Record<string, number> }> = [];

  for (let index = 0; index < stepCount; index += 1) {
    const progress = stepCount === 1 ? 1 : index / (stepCount - 1);
    const metricPoint = Object.fromEntries(
      Object.entries(metrics).map(([metricName, finalValue]) => {
        const lowerBetter = isLowerBetterMetric(metricName);
        let startValue = lowerBetter ? finalValue * 1.55 + 0.08 : finalValue * 0.55;

        if (finalValue === 0) {
          startValue = lowerBetter ? 0.12 : 0.02;
        }

        const value = lowerBetter
          ? startValue - (startValue - finalValue) * progress
          : startValue + (finalValue - startValue) * progress;
        return [metricName, Number(value.toFixed(4))];
      })
    );

    series.push({
      step: index + 1,
      metrics: metricPoint
    });
  }

  return series;
};

const downsampleMetricSeries = (
  series: Array<{ step: number; metrics: Record<string, number> }>,
  maxPoints: number
): Array<{ step: number; metrics: Record<string, number> }> => {
  if (series.length <= maxPoints) {
    return series;
  }

  const selectedIndexes = new Set<number>();
  selectedIndexes.add(0);
  selectedIndexes.add(series.length - 1);

  for (let slot = 1; slot < maxPoints - 1; slot += 1) {
    const index = Math.round((slot * (series.length - 1)) / (maxPoints - 1));
    selectedIndexes.add(index);
  }

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => series[index] as { step: number; metrics: Record<string, number> });
};

const applyTrainingMetricsTotalCap = (): number => {
  if (trainingMetrics.length <= trainingMetricsMaxTotalRows) {
    return 0;
  }

  const removed = trainingMetrics.length - trainingMetricsMaxTotalRows;
  trainingMetrics.splice(trainingMetricsMaxTotalRows, removed);
  return removed;
};

const pickLatestMetrics = (
  metrics: TrainingMetricRecord[]
): Record<string, number> => {
  const latestByMetric = new Map<string, TrainingMetricRecord>();
  metrics.forEach((metric) => {
    const current = latestByMetric.get(metric.metric_name);
    if (!current) {
      latestByMetric.set(metric.metric_name, metric);
      return;
    }

    if (metric.step > current.step) {
      latestByMetric.set(metric.metric_name, metric);
      return;
    }

    if (metric.step === current.step && Date.parse(metric.recorded_at) > Date.parse(current.recorded_at)) {
      latestByMetric.set(metric.metric_name, metric);
    }
  });

  return Object.fromEntries(
    Array.from(latestByMetric.entries()).map(([metricName, metric]) => [metricName, metric.metric_value])
  );
};

const upsertTrainingArtifactAttachment = async (
  job: TrainingJobRecord,
  runtime: TrainingRuntimeState,
  metrics: Record<string, number>
): Promise<FileAttachment> => {
  let existingArtifactPayload: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(runtime.artifact_path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existingArtifactPayload = parsed as Record<string, unknown>;
    }
  } catch {
    existingArtifactPayload = {};
  }

  const artifactPayload = {
    ...existingArtifactPayload,
    job_id: job.id,
    framework: job.framework,
    task_type: job.task_type,
    base_model: job.base_model,
    generated_at: now(),
    metrics
  };
  const content = Buffer.from(JSON.stringify(artifactPayload, null, 2), 'utf8');
  await fs.mkdir(path.dirname(runtime.artifact_path), { recursive: true });
  await fs.writeFile(runtime.artifact_path, content);

  const existingId = findArtifactAttachmentIdByJob(job.id);
  const existing = existingId ? attachments.find((item) => item.id === existingId) : null;

  if (existing) {
    existing.filename = path.basename(runtime.artifact_path);
    existing.status = 'ready';
    existing.mime_type = 'application/json';
    existing.byte_size = content.byteLength;
    existing.storage_backend = 'local';
    existing.storage_path = runtime.artifact_path;
    existing.upload_error = null;
    existing.updated_at = now();

    storedAttachmentBinaryById.set(existing.id, {
      file_path: runtime.artifact_path,
      mime_type: existing.mime_type,
      byte_size: content.byteLength
    });
    return existing;
  }

  const attachment: FileAttachment = {
    id: nextId('f'),
    filename: path.basename(runtime.artifact_path),
    status: 'ready',
    owner_user_id: job.submitted_by,
    attached_to_type: 'Model',
    attached_to_id: null,
    mime_type: 'application/json',
    byte_size: content.byteLength,
    storage_backend: 'local',
    storage_path: runtime.artifact_path,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };
  attachments.unshift(attachment);
  storedAttachmentBinaryById.set(attachment.id, {
    file_path: runtime.artifact_path,
    mime_type: 'application/json',
    byte_size: content.byteLength
  });
  trainingArtifactAttachmentByJobId.set(job.id, attachment.id);
  return attachment;
};

const ensureTrainingRuntime = async (job: TrainingJobRecord): Promise<TrainingRuntimeState> => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceDir = path.join(trainingWorkspaceRoot, job.id);
  const runtime: TrainingRuntimeState = {
    run_id: runId,
    job_id: job.id,
    workspace_dir: workspaceDir,
    config_path: path.join(workspaceDir, 'job-config.json'),
    summary_path: path.join(workspaceDir, 'dataset-summary.json'),
    log_path: path.join(workspaceDir, 'train.log'),
    metrics_path: path.join(workspaceDir, 'metrics.json'),
    artifact_path: path.join(workspaceDir, 'artifacts', `${job.framework}-${job.id}.artifact.json`),
    cancelled: false
  };
  trainingRuntimeByJobId.set(job.id, runtime);
  trainingLogLinesByJobId.set(job.id, []);

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(runtime.log_path, '', 'utf8');
  return runtime;
};

type WorkerTrainDispatchResult = {
  execution_mode: 'simulated' | 'local_command';
  logPreview: string;
  logs: string[];
  metrics: Record<string, number>;
  metric_series?: Array<{ step: number; metrics: Record<string, number> }>;
  artifact_payload?: Record<string, unknown>;
  worker_run_id: string | null;
};

type WorkerInlineDatasetFile = {
  relative_path: string;
  encoding: 'base64';
  byte_size: number;
  content_base64: string;
};

type WorkerInlineDatasetPackage = {
  format: 'inline_base64_v1';
  source_root: string;
  root_relative: string;
  total_files: number;
  total_bytes: number;
  files: WorkerInlineDatasetFile[];
};

type WorkerReferencedDatasetPackage = {
  format: 'reference_json_v1';
  package_id: string;
  download_url: string;
  expires_at: string;
  root_relative: string;
  total_files: number;
  total_bytes: number;
};

type WorkerDatasetPackageForDispatch = WorkerInlineDatasetPackage | WorkerReferencedDatasetPackage;

const compactDispatchReason = (value: unknown, maxLength = 220): string => {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : value === null || value === undefined
          ? ''
          : String(value);
  const normalized = raw.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return 'unknown';
  }
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
};

const collectFilesRecursively = async (rootDir: string): Promise<string[]> => {
  const result: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  }

  result.sort((left, right) => left.localeCompare(right));
  return result;
};

const collectWorkerPackageFiles = async (
  materializedDataset: Record<string, unknown> | null
): Promise<{
  rootDir: string;
  rootRelative: string;
  files: WorkerInlineDatasetFile[];
  totalBytes: number;
}> => {
  if (!materializedDataset || typeof materializedDataset !== 'object') {
    return { rootDir: '', rootRelative: '', files: [], totalBytes: 0 };
  }

  const rootDirRaw =
    typeof materializedDataset.root_dir === 'string' && materializedDataset.root_dir.trim()
      ? materializedDataset.root_dir.trim()
      : '';
  if (!rootDirRaw) {
    return { rootDir: '', rootRelative: '', files: [], totalBytes: 0 };
  }

  const rootDir = path.resolve(rootDirRaw);
  let stat;
  try {
    stat = await fs.stat(rootDir);
  } catch {
    return { rootDir: '', rootRelative: '', files: [], totalBytes: 0 };
  }
  if (!stat.isDirectory()) {
    return { rootDir: '', rootRelative: '', files: [], totalBytes: 0 };
  }

  const rootRelative = ['materialized-dataset', path.basename(rootDir)].join('/');
  const files = await collectFilesRecursively(rootDir);
  if (files.length === 0) {
    return { rootDir, rootRelative, files: [], totalBytes: 0 };
  }
  if (files.length > trainingWorkerReferencePackageMaxFiles) {
    throw new Error(
      `dataset package file-count cap exceeded (${files.length} > ${trainingWorkerReferencePackageMaxFiles})`
    );
  }

  let totalBytes = 0;
  const packageFiles: WorkerInlineDatasetFile[] = [];
  for (const fullPath of files) {
    const relPath = path.relative(rootDir, fullPath);
    const relPosix = relPath.split(path.sep).join('/');
    const content = await fs.readFile(fullPath);
    totalBytes += content.byteLength;
    if (totalBytes > trainingWorkerReferencePackageMaxBytes) {
      throw new Error(
        `dataset package byte-size cap exceeded (${totalBytes} > ${trainingWorkerReferencePackageMaxBytes})`
      );
    }
    packageFiles.push({
      relative_path: relPosix,
      encoding: 'base64',
      byte_size: content.byteLength,
      content_base64: content.toString('base64')
    });
  }

  return {
    rootDir,
    rootRelative,
    files: packageFiles,
    totalBytes
  };
};

const cleanupExpiredWorkerDatasetPackages = async (): Promise<void> => {
  const nowMs = Date.now();
  const expired = Array.from(trainingWorkerDatasetPackageById.values()).filter(
    (item) => Date.parse(item.expires_at) <= nowMs
  );
  for (const item of expired) {
    trainingWorkerDatasetPackageById.delete(item.id);
    try {
      await fs.unlink(item.file_path);
    } catch {
      // ignore stale file cleanup errors
    }
  }
};

const registerReferencedWorkerDatasetPackage = async (params: {
  authorizedWorkerId: string;
  rootRelative: string;
  sourceRoot: string;
  files: WorkerInlineDatasetFile[];
  totalBytes: number;
}): Promise<WorkerReferencedDatasetPackage> => {
  if (!trainingWorkerDispatchBaseUrl) {
    throw new Error(
      'TRAINING_WORKER_DISPATCH_BASE_URL is required for reference dataset package dispatch mode.'
    );
  }

  await fs.mkdir(trainingWorkerPackageStorageRoot, { recursive: true });
  await cleanupExpiredWorkerDatasetPackages();

  const packageId = nextId('twpkg');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + trainingWorkerPackageTtlMs).toISOString();
  const payload: WorkerInlineDatasetPackage = {
    format: 'inline_base64_v1',
    source_root: params.sourceRoot,
    root_relative: params.rootRelative,
    total_files: params.files.length,
    total_bytes: params.totalBytes,
    files: params.files
  };
  const filePath = path.join(trainingWorkerPackageStorageRoot, `${packageId}.json`);
  await fs.writeFile(filePath, JSON.stringify(payload), 'utf8');

  trainingWorkerDatasetPackageById.set(packageId, {
    id: packageId,
    file_path: filePath,
    created_at: createdAt,
    expires_at: expiresAt,
    authorized_worker_id: params.authorizedWorkerId.trim() || null,
    total_files: params.files.length,
    total_bytes: params.totalBytes
  });

  return {
    format: 'reference_json_v1',
    package_id: packageId,
    download_url: `${trainingWorkerDispatchBaseUrl}/api/runtime/training-workers/dataset-packages/${encodeURIComponent(packageId)}`,
    expires_at: expiresAt,
    root_relative: params.rootRelative,
    total_files: params.files.length,
    total_bytes: params.totalBytes
  };
};

const releaseReferencedWorkerDatasetPackage = async (packageId: string): Promise<void> => {
  if (!packageId.trim()) {
    return;
  }
  const record = trainingWorkerDatasetPackageById.get(packageId.trim());
  if (!record) {
    return;
  }
  trainingWorkerDatasetPackageById.delete(record.id);
  try {
    await fs.unlink(record.file_path);
  } catch {
    // ignore best-effort cleanup failures
  }
};

const releaseWorkerDatasetPackageForDispatch = async (
  datasetPackage: WorkerDatasetPackageForDispatch | null
): Promise<void> => {
  if (!datasetPackage || datasetPackage.format !== 'reference_json_v1') {
    return;
  }
  await releaseReferencedWorkerDatasetPackage(datasetPackage.package_id);
};

const buildWorkerDatasetPackageForDispatch = async (
  materializedDataset: Record<string, unknown> | null,
  authorizedWorkerId: string
): Promise<WorkerDatasetPackageForDispatch | null> => {
  const packaged = await collectWorkerPackageFiles(materializedDataset);
  if (!packaged.rootDir || packaged.files.length === 0) {
    return null;
  }

  if (
    packaged.files.length <= trainingWorkerInlinePackageMaxFiles &&
    packaged.totalBytes <= trainingWorkerInlinePackageMaxBytes
  ) {
    return {
      format: 'inline_base64_v1',
      source_root: packaged.rootDir,
      root_relative: packaged.rootRelative,
      total_files: packaged.files.length,
      total_bytes: packaged.totalBytes,
      files: packaged.files
    };
  }

  return registerReferencedWorkerDatasetPackage({
    authorizedWorkerId,
    rootRelative: packaged.rootRelative,
    sourceRoot: packaged.rootDir,
    files: packaged.files,
    totalBytes: packaged.totalBytes
  });
};

const normalizeWorkerDispatchMetrics = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  );
};

const parseWorkerTrainDispatchResult = (payload: unknown): WorkerTrainDispatchResult => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Worker response is not a JSON object.');
  }
  const record = payload as Record<string, unknown>;
  const accepted = record.accepted;
  if (accepted !== true) {
    throw new Error(compactDispatchReason(record.error ?? record.message ?? 'worker rejected job'));
  }

  const mode = record.execution_mode === 'local_command' ? 'local_command' : 'simulated';
  const logs = Array.isArray(record.logs)
    ? record.logs
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
  const metrics = normalizeWorkerDispatchMetrics(record.metrics);
  const metricSeries = normalizeMetricSeries(
    Array.isArray(record.metric_series)
      ? (record.metric_series as Array<{ step: number; metrics: Record<string, number> }>)
      : undefined
  );
  const artifactPayload =
    record.artifact_payload && typeof record.artifact_payload === 'object' && !Array.isArray(record.artifact_payload)
      ? (record.artifact_payload as Record<string, unknown>)
      : undefined;
  const workerRunId =
    typeof record.worker_run_id === 'string' && record.worker_run_id.trim()
      ? record.worker_run_id.trim()
      : null;
  const logPreview =
    typeof record.log_preview === 'string' && record.log_preview.trim()
      ? record.log_preview.trim()
      : logs.at(-1) ?? 'worker execution completed';

  return {
    execution_mode: mode,
    logPreview,
    logs,
    metrics,
    metric_series: metricSeries.length > 0 ? metricSeries : undefined,
    artifact_payload: artifactPayload,
    worker_run_id: workerRunId
  };
};

const dispatchTrainingToWorker = async (params: {
  worker: TrainingWorkerNodeRecord;
  job: TrainingJobRecord;
  runtime: TrainingRuntimeState;
  summary: DatasetTrainingSummary;
  materializedDataset: Record<string, unknown> | null;
  datasetPackage: WorkerDatasetPackageForDispatch | null;
  abortSignal?: AbortSignal;
}): Promise<WorkerTrainDispatchResult> => {
  const workerEndpoint = params.worker.endpoint?.trim();
  if (!workerEndpoint) {
    throw new Error('scheduled worker endpoint is empty');
  }

  const workerToken = resolveOutboundTrainingWorkerToken(params.worker.id);

  const url = `${workerEndpoint.replace(/\/+$/, '')}/api/worker/train`;
  const payload = {
    job_id: params.job.id,
    framework: params.job.framework,
    task_type: params.job.task_type,
    dataset_id: params.job.dataset_id,
    dataset_version_id: params.job.dataset_version_id,
    base_model: params.job.base_model,
    config: params.job.config,
    dataset_summary: params.summary,
    materialized_dataset: params.materializedDataset,
    dataset_package: params.datasetPackage,
    workspace: {
      workspace_dir: params.runtime.workspace_dir,
      config_path: params.runtime.config_path,
      summary_path: params.runtime.summary_path,
      metrics_path: params.runtime.metrics_path,
      artifact_path: params.runtime.artifact_path
    },
    scheduler: {
      execution_target: params.job.execution_target,
      scheduled_worker_id: params.job.scheduled_worker_id,
      scheduler_note: params.job.scheduler_note,
      scheduler_decision: params.job.scheduler_decision
    },
    dispatched_at: now()
  };

  const requestController = new AbortController();
  const timeoutHandle = setTimeout(
    () => requestController.abort('timeout'),
    trainingWorkerDispatchTimeoutMs
  );
  const externalAbort = () => requestController.abort('cancelled_by_user');
  if (params.abortSignal) {
    if (params.abortSignal.aborted) {
      requestController.abort('cancelled_by_user');
    } else {
      params.abortSignal.addEventListener('abort', externalAbort, { once: true });
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Training-Worker-Token': workerToken
      },
      body: JSON.stringify(payload),
      signal: requestController.signal
    });

    let responseJson: unknown = null;
    try {
      responseJson = await response.json();
    } catch {
      throw new Error(`worker returned non-JSON response (status=${response.status})`);
    }

    if (!response.ok) {
      const reason =
        responseJson && typeof responseJson === 'object' && !Array.isArray(responseJson)
          ? compactDispatchReason(
              (responseJson as { error?: unknown; message?: unknown }).error ??
                (responseJson as { message?: unknown }).message ??
                `worker http status ${response.status}`
            )
          : `worker http status ${response.status}`;
      throw new Error(reason);
    }

    return parseWorkerTrainDispatchResult(responseJson);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const reason = String(requestController.signal.reason ?? '');
      if (reason === 'cancelled_by_user') {
        throw new TrainingCancelledError('Training run cancelled during worker dispatch.');
      }
      throw new Error(`worker dispatch timeout after ${trainingWorkerDispatchTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    if (params.abortSignal) {
      params.abortSignal.removeEventListener('abort', externalAbort);
    }
  }
};

const requestWorkerTrainingCancel = async (
  worker: TrainingWorkerNodeRecord,
  jobId: string
): Promise<{ acknowledged: boolean; had_running_process: boolean; message: string }> => {
  const endpoint = worker.endpoint?.trim();
  if (!endpoint) {
    return {
      acknowledged: false,
      had_running_process: false,
      message: 'worker endpoint is empty'
    };
  }

  let workerToken = '';
  try {
    workerToken = resolveOutboundTrainingWorkerToken(worker.id);
  } catch (error) {
    return {
      acknowledged: false,
      had_running_process: false,
      message: compactDispatchReason(error)
    };
  }

  const url = `${endpoint.replace(/\/+$/, '')}/api/worker/cancel`;
  const cancelTimeoutMs = Math.min(trainingWorkerDispatchTimeoutMs, 10000);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort('timeout'), cancelTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Training-Worker-Token': workerToken
      },
      body: JSON.stringify({ job_id: jobId }),
      signal: controller.signal
    });

    const payload = (await response.json().catch(() => null)) as
      | { cancelled?: unknown; had_running_process?: unknown; error?: unknown; message?: unknown }
      | null;
    if (!response.ok) {
      return {
        acknowledged: false,
        had_running_process: false,
        message: compactDispatchReason(payload?.error ?? payload?.message ?? `worker cancel http ${response.status}`)
      };
    }

    return {
      acknowledged: payload?.cancelled === true,
      had_running_process: payload?.had_running_process === true,
      message: compactDispatchReason(payload?.message ?? 'worker cancel request accepted')
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        acknowledged: false,
        had_running_process: false,
        message: `worker cancel timeout after ${cancelTimeoutMs}ms`
      };
    }
    return {
      acknowledged: false,
      had_running_process: false,
      message: compactDispatchReason(error)
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const readTrainingWorkerDatasetPackageById = async (
  packageId: string
): Promise<TrainingWorkerDatasetPackageRecord> => {
  await cleanupExpiredWorkerDatasetPackages();
  const normalizedPackageId = packageId.trim();
  if (!normalizedPackageId) {
    throw new Error('Training worker dataset package id is required.');
  }
  const record = trainingWorkerDatasetPackageById.get(normalizedPackageId);
  if (!record) {
    throw new Error('Training worker dataset package not found or expired.');
  }

  const expiresAtMs = Date.parse(record.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    trainingWorkerDatasetPackageById.delete(record.id);
    try {
      await fs.unlink(record.file_path);
    } catch {
      // ignore
    }
    throw new Error('Training worker dataset package not found or expired.');
  }

  return record;
};

const executeTrainingLifecycle = async (jobId: string): Promise<void> => {
  const job = trainingJobs.find((item) => item.id === jobId);
  if (!job) {
    return;
  }

  if (job.execution_target === 'worker' && job.scheduled_worker_id) {
    const assignedWorker = trainingWorkerNodes.find((worker) => worker.id === job.scheduled_worker_id);
    const assignedAvailable =
      assignedWorker &&
      assignedWorker.enabled &&
      Boolean(assignedWorker.endpoint) &&
      resolveWorkerEffectiveStatus(assignedWorker) === 'online' &&
      getWorkerInFlightJobs(assignedWorker.id) <= Math.max(1, assignedWorker.max_concurrency) &&
      workerSupportsJob(assignedWorker, job.task_type, job.framework);
    if (!assignedAvailable) {
      const rescheduled = selectTrainingWorkerForJob(job.task_type, job.framework, {
        trigger: 'pre_run_reschedule',
        attempt: 1,
        fallbackReason: 'assigned_worker_unavailable'
      });
      job.execution_target = rescheduled.execution_target;
      job.scheduled_worker_id = rescheduled.worker?.id ?? null;
      job.scheduler_note = `rescheduled_before_run:${rescheduled.note}`;
      recordTrainingSchedulerDecision(job, rescheduled.decision);
      job.updated_at = now();
      markAppStateDirty();
    }
  }

  const runtime = await ensureTrainingRuntime(job);
  const runId = runtime.run_id;
  const epochs = toPositiveInt(job.config.epochs, 8);

  try {
    job.status = 'preparing';
    job.updated_at = now();
    if (job.execution_target === 'worker' && job.scheduled_worker_id) {
      await appendTrainingLog(
        job,
        runtime,
        `Scheduler assigned worker ${job.scheduled_worker_id}. ${job.scheduler_note ?? ''}`.trim()
      );
    } else {
      await appendTrainingLog(
        job,
        runtime,
        `Scheduler fallback to control-plane local executor. ${job.scheduler_note ?? ''}`.trim()
      );
    }
    await appendTrainingLog(job, runtime, `Preparing local workspace for ${job.framework}.`);

    const summary = buildDatasetTrainingSummary(job.dataset_id);
    const dataset = datasets.find((item) => item.id === job.dataset_id) ?? null;
    const materializedDataset = dataset
      ? await materializeTrainingDataset(dataset, runtime.workspace_dir)
      : null;
    const configPayload = {
      job_id: job.id,
      framework: job.framework,
      task_type: job.task_type,
      dataset_id: job.dataset_id,
      dataset_version_id: job.dataset_version_id,
      base_model: job.base_model,
      config: job.config,
      materialized_dataset: materializedDataset,
      created_at: job.created_at
    };
    await writeJsonFile(runtime.config_path, configPayload);
    await writeJsonFile(runtime.summary_path, summary);
    await appendTrainingLog(
      job,
      runtime,
      `Dataset summary: items=${summary.total_items}, ready=${summary.ready_items}, annotated=${summary.annotated_items}.`
    );
    if (materializedDataset) {
      await appendTrainingLog(
        job,
        runtime,
        `Materialized dataset prepared (${String(materializedDataset.format)}): ${JSON.stringify(materializedDataset)}`
      );
    }

    const finalizeMetricsAndArtifact = async (
      metrics: Record<string, number>,
      stepBase: number,
      metricSeries?: Array<{ step: number; metrics: Record<string, number> }>
    ) => {
      const points = normalizeMetricSeries(metricSeries);
      const rawPoints = points.length > 0 ? points : buildMetricSeriesFromSummary(metrics, stepBase);
      const persistPoints = downsampleMetricSeries(rawPoints, trainingMetricsMaxPointsPerJob);
      const metricsFilePayload =
        persistPoints.length > 0
          ? {
              summary: metrics,
              metric_series: persistPoints
            }
          : metrics;
      await fs.writeFile(runtime.metrics_path, JSON.stringify(metricsFilePayload, null, 2), 'utf8');

      for (let index = trainingMetrics.length - 1; index >= 0; index -= 1) {
        if (trainingMetrics[index]?.training_job_id === job.id) {
          trainingMetrics.splice(index, 1);
        }
      }

      persistPoints.forEach((point) => {
        Object.entries(point.metrics).forEach(([metricName, metricValue]) => {
          trainingMetrics.unshift({
            id: nextId('tm'),
            training_job_id: job.id,
            metric_name: metricName,
            metric_value: metricValue,
            step: point.step,
            recorded_at: now()
          });
        });
      });

      const removedRows = applyTrainingMetricsTotalCap();
      if (rawPoints.length > persistPoints.length) {
        await appendTrainingLog(
          job,
          runtime,
          `Metric series downsampled from ${rawPoints.length} to ${persistPoints.length} points (cap=${trainingMetricsMaxPointsPerJob}).`
        );
      }
      if (removedRows > 0) {
        await appendTrainingLog(
          job,
          runtime,
          `Training metrics store trimmed by ${removedRows} rows (total cap=${trainingMetricsMaxTotalRows}).`
        );
      }

      await upsertTrainingArtifactAttachment(job, runtime, metrics);
      await appendTrainingLog(
        job,
        runtime,
        `Artifacts saved to ${runtime.artifact_path}. Metrics keys: ${Object.keys(metrics).join(', ')}.`
      );
    };

    let scheduledWorker =
      job.execution_target === 'worker' && job.scheduled_worker_id
        ? trainingWorkerNodes.find((worker) => worker.id === job.scheduled_worker_id) ?? null
        : null;
    const failedWorkerIds = new Set<string>();
    let dispatchAttemptCount = 0;
    while (scheduledWorker?.endpoint) {
      dispatchAttemptCount += 1;
      const dispatchAbortController = new AbortController();
      trainingWorkerDispatchAbortByJobId.set(job.id, dispatchAbortController);
      let datasetPackage: WorkerDatasetPackageForDispatch | null = null;
      try {
        await appendTrainingLog(
          job,
          runtime,
          `Dispatching training execution to worker ${scheduledWorker.id} (${scheduledWorker.endpoint}).`
        );
        datasetPackage = await buildWorkerDatasetPackageForDispatch(materializedDataset, scheduledWorker.id);
        if (datasetPackage) {
          if (datasetPackage.format === 'inline_base64_v1') {
            await appendTrainingLog(
              job,
              runtime,
              `Prepared inline dataset package for worker dispatch: files=${datasetPackage.total_files}, bytes=${datasetPackage.total_bytes}.`
            );
          } else {
            await appendTrainingLog(
              job,
              runtime,
              `Prepared referenced dataset package for worker dispatch: package_id=${datasetPackage.package_id}, files=${datasetPackage.total_files}, bytes=${datasetPackage.total_bytes}, expires_at=${datasetPackage.expires_at}.`
            );
          }
        }
        job.status = 'running';
        job.updated_at = now();
        markAppStateDirty();

        const workerResult = await dispatchTrainingToWorker({
          worker: scheduledWorker,
          job,
          runtime,
          summary,
          materializedDataset,
          datasetPackage,
          abortSignal: dispatchAbortController.signal
        });
        markWorkerDispatchSuccess(scheduledWorker.id);
        job.execution_mode = workerResult.execution_mode;
        job.updated_at = now();
        markAppStateDirty();
        await appendTrainingLog(job, runtime, `Worker accepted: ${workerResult.logPreview}`);
        if (workerResult.logs.length > 0) {
          for (const line of workerResult.logs.slice(-48)) {
            await appendTrainingLog(job, runtime, `worker> ${line}`);
          }
        }
        if (workerResult.artifact_payload) {
          const enrichedArtifact = {
            ...workerResult.artifact_payload,
            worker_id: scheduledWorker.id,
            worker_endpoint: scheduledWorker.endpoint,
            worker_run_id: workerResult.worker_run_id,
            dispatched_via: 'worker_api',
            received_at: now()
          };
          await fs.mkdir(path.dirname(runtime.artifact_path), { recursive: true });
          await fs.writeFile(runtime.artifact_path, JSON.stringify(enrichedArtifact, null, 2), 'utf8');
        }
        job.status = 'evaluating';
        job.updated_at = now();
        markAppStateDirty();

        const workerMetrics =
          Object.keys(workerResult.metrics).length > 0
            ? workerResult.metrics
            : buildTrainingMetrics(job, summary);
        await finalizeMetricsAndArtifact(workerMetrics, epochs, workerResult.metric_series);

        job.status = 'completed';
        job.updated_at = now();
        markAppStateDirty();
        await appendTrainingLog(job, runtime, `Training completed successfully (worker ${scheduledWorker.id}).`);
        return;
      } catch (error) {
        if (error instanceof TrainingCancelledError || getTrainingRuntime(job.id)?.cancelled) {
          throw new TrainingCancelledError('Training run cancelled during worker dispatch.');
        }
        const reason = compactDispatchReason(error);
        failedWorkerIds.add(scheduledWorker.id);
        markWorkerDispatchFailure(scheduledWorker.id);
        await appendTrainingLog(job, runtime, `Worker dispatch failed (${scheduledWorker.id}): ${reason}`);

        const canRetryAnotherWorker = dispatchAttemptCount < trainingWorkerDispatchMaxAttempts;
        if (canRetryAnotherWorker) {
          const rescheduled = selectTrainingWorkerForJob(job.task_type, job.framework, {
            excludedWorkerIds: failedWorkerIds,
            trigger: 'dispatch_redispatch',
            attempt: dispatchAttemptCount + 1,
            fallbackReason: reason
          });
          if (rescheduled.execution_target === 'worker' && rescheduled.worker?.endpoint) {
            const previousWorkerId = scheduledWorker.id;
            scheduledWorker = rescheduled.worker;
            const retryDelayMs = resolveDispatchRetryDelayMs(dispatchAttemptCount);
            job.execution_target = 'worker';
            job.scheduled_worker_id = scheduledWorker.id;
            job.scheduler_note =
              `dispatch_rescheduled:attempt=${dispatchAttemptCount};${previousWorkerId}->${rescheduled.note};reason=${reason}`;
            recordTrainingSchedulerDecision(job, rescheduled.decision);
            job.updated_at = now();
            markAppStateDirty();
            await appendTrainingLog(
              job,
              runtime,
              `Rescheduled worker dispatch from ${previousWorkerId} to ${scheduledWorker.id} (attempt ${dispatchAttemptCount + 1}/${trainingWorkerDispatchMaxAttempts}).`
            );
            if (retryDelayMs > 0) {
              await appendTrainingLog(
                job,
                runtime,
                `Waiting ${retryDelayMs}ms before worker redispatch attempt ${dispatchAttemptCount + 1}.`
              );
              await waitWithCancelCheck(job.id, runId, retryDelayMs);
            }
            continue;
          }
        }

        scheduledWorker = null;
        if (!trainingWorkerDispatchFallbackLocal) {
          throw new Error(
            `Worker dispatch failed and local fallback is disabled: ${reason}; attempts=${dispatchAttemptCount}; failed_workers=${Array.from(failedWorkerIds).join(',')}`
          );
        }
        job.execution_target = 'control_plane';
        job.scheduled_worker_id = null;
        if (dispatchAttemptCount >= trainingWorkerDispatchMaxAttempts) {
          job.scheduler_note =
            `dispatch_fallback:max_attempts_exhausted;attempts=${dispatchAttemptCount};reason=${reason}`;
          recordTrainingSchedulerDecision(job, buildTrainingSchedulerDecision({
            trigger: 'dispatch_fallback',
            attempt: dispatchAttemptCount,
            executionTarget: 'control_plane',
            selected: null,
            note: job.scheduler_note,
            fallbackReason: 'max_attempts_exhausted',
            excludedWorkerIds: Array.from(failedWorkerIds),
            decidedAt: now()
          }));
          await appendTrainingLog(
            job,
            runtime,
            `Reached worker dispatch max attempts (${trainingWorkerDispatchMaxAttempts}).`
          );
        } else {
          job.scheduler_note =
            `dispatch_fallback:no_alternative_worker;attempts=${dispatchAttemptCount};reason=${reason}`;
          recordTrainingSchedulerDecision(job, buildTrainingSchedulerDecision({
            trigger: 'dispatch_fallback',
            attempt: dispatchAttemptCount,
            executionTarget: 'control_plane',
            selected: null,
            note: job.scheduler_note,
            fallbackReason: 'no_alternative_worker',
            excludedWorkerIds: Array.from(failedWorkerIds),
            decidedAt: now()
          }));
        }
        job.updated_at = now();
        markAppStateDirty();
        await appendTrainingLog(job, runtime, 'No alternative worker available. Fallback to control-plane local execution.');
      } finally {
        await releaseWorkerDatasetPackageForDispatch(datasetPackage);
        trainingWorkerDispatchAbortByJobId.delete(job.id);
      }
    }

    const trainer = getTrainerByFramework(job.framework);
    let resolvedExecutionMode: TrainingJobRecord['execution_mode'] = 'unknown';
    let trainerLogsStreamed = false;
    const trainAccepted = await trainer.train({
      trainingJobId: job.id,
      datasetId: job.dataset_id,
      taskType: job.task_type,
      baseModel: job.base_model,
      config: job.config,
      workspaceDir: runtime.workspace_dir,
      configPath: runtime.config_path,
      summaryPath: runtime.summary_path,
      metricsPath: runtime.metrics_path,
      artifactPath: runtime.artifact_path,
      onExecutionMode: (mode) => {
        resolvedExecutionMode = mode;
        job.execution_mode = mode;
        job.updated_at = now();
        markAppStateDirty();

        if (mode === 'local_command' && job.status !== 'running') {
          job.status = 'running';
          job.updated_at = now();
          markAppStateDirty();
          void appendTrainingLog(job, runtime, `Running ${job.framework} local command executor.`);
        }
      },
      onLog: (line) => {
        trainerLogsStreamed = true;
        void appendTrainingLog(job, runtime, `trainer> ${line}`);
      }
    });
    job.execution_mode = trainAccepted.execution_mode ?? resolvedExecutionMode;
    await appendTrainingLog(job, runtime, `Trainer accepted: ${trainAccepted.logPreview}`);
    if (!trainerLogsStreamed && Array.isArray(trainAccepted.logs) && trainAccepted.logs.length > 0) {
      for (const line of trainAccepted.logs.slice(-36)) {
        await appendTrainingLog(job, runtime, `trainer> ${line}`);
      }
    }

    if (trainAccepted.execution_mode === 'local_command') {
      assertRuntimeActive(job.id, runId);
      await waitWithCancelCheck(job.id, runId, 120);

      job.status = 'evaluating';
      job.updated_at = now();
      await appendTrainingLog(job, runtime, 'Evaluating local command outputs.');
      await waitWithCancelCheck(job.id, runId, 100);

      const metrics =
        trainAccepted.metrics && Object.keys(trainAccepted.metrics).length > 0
          ? trainAccepted.metrics
          : buildTrainingMetrics(job, summary);
      await finalizeMetricsAndArtifact(metrics, epochs, trainAccepted.metric_series);

      job.status = 'completed';
      job.updated_at = now();
      await appendTrainingLog(job, runtime, 'Training completed successfully (local command).');
      return;
    }

    assertRuntimeActive(job.id, runId);
    await waitWithCancelCheck(job.id, runId, 220);

    job.status = 'running';
    job.updated_at = now();
    await appendTrainingLog(
      job,
      runtime,
      `Running ${job.framework} training loop with base model ${job.base_model}.`
    );

    const checkpoints = Math.max(3, Math.min(epochs, 8));
    for (let index = 1; index <= checkpoints; index += 1) {
      await waitWithCancelCheck(job.id, runId, 240);
      const epoch = Math.min(epochs, Math.round((epochs / checkpoints) * index));
      await appendTrainingLog(job, runtime, `Epoch ${epoch}/${epochs} finished.`);
    }

    job.status = 'evaluating';
    job.updated_at = now();
    await appendTrainingLog(job, runtime, 'Evaluating metrics on validation split.');
    await waitWithCancelCheck(job.id, runId, 200);

    const metrics = buildTrainingMetrics(job, summary);
    await finalizeMetricsAndArtifact(metrics, epochs);

    job.status = 'completed';
    job.updated_at = now();
    await appendTrainingLog(job, runtime, 'Training completed successfully.');
  } catch (error) {
    const runtimeState = getTrainingRuntime(job.id);
    if (runtimeState && runtimeState.run_id === runId && runtimeState.cancelled) {
      job.status = 'cancelled';
      job.updated_at = now();
      await appendTrainingLog(job, runtimeState, 'Training cancelled by user.');
      return;
    }

    if (error instanceof TrainingCancelledError) {
      job.status = 'cancelled';
      job.updated_at = now();
      await appendTrainingLog(job, runtime, 'Training cancelled.');
      return;
    }

    job.status = 'failed';
    job.updated_at = now();
    await appendTrainingLog(job, runtime, `Training failed: ${(error as Error).message}`);
  }
};

const scheduleTrainingLifecycle = (jobId: string): void => {
  void executeTrainingLifecycle(jobId);
};

export const resumePendingTrainingJobs = (): { resumed_job_ids: string[] } => {
  const resumableStatuses: TrainingJobRecord['status'][] = [
    'queued',
    'preparing',
    'running',
    'evaluating'
  ];
  const resumedJobIds: string[] = [];

  trainingJobs.forEach((job) => {
    if (!resumableStatuses.includes(job.status)) {
      return;
    }

    const previousStatus = job.status;
    const scheduling = selectTrainingWorkerForJob(job.task_type, job.framework, {
      trigger: 'resume',
      attempt: 1
    });
    job.status = 'queued';
    job.execution_target = scheduling.execution_target;
    job.scheduled_worker_id = scheduling.worker?.id ?? null;
    job.scheduler_note = `resume:${scheduling.note}`;
    recordTrainingSchedulerDecision(job, scheduling.decision);
    job.updated_at = now();
    job.log_excerpt = `Recovered after API restart from ${previousStatus}. Re-queued with scheduler.`;
    resumedJobIds.push(job.id);
    scheduleTrainingLifecycle(job.id);
  });

  if (resumedJobIds.length > 0) {
    markAppStateDirty();
  }

  return {
    resumed_job_ids: resumedJobIds
  };
};

const resolveTrainingLogs = async (job: TrainingJobRecord): Promise<string[]> => {
  const inMemory = trainingLogLinesByJobId.get(job.id);
  if (inMemory && inMemory.length > 0) {
    return [...inMemory];
  }

  const defaultLogPath = path.join(trainingWorkspaceRoot, job.id, 'train.log');
  try {
    const content = await fs.readFile(defaultLogPath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-240);
  } catch {
    return job.log_excerpt ? [job.log_excerpt] : [];
  }
};

const resolvePreAnnotationTarget = (
  dataset: DatasetRecord,
  currentUser: User,
  requestedModelVersionId?: string
): { model: ModelRecord; version: ModelVersionRecord } => {
  if (requestedModelVersionId?.trim()) {
    const selectedVersion = assertModelVersionAccess(requestedModelVersionId.trim(), currentUser);
    if (selectedVersion.task_type !== dataset.task_type) {
      throw new Error('Selected model version task_type does not match dataset task_type.');
    }
    const selectedModel = models.find((item) => item.id === selectedVersion.model_id);
    if (!selectedModel) {
      throw new Error('Model not found for selected model version.');
    }
    return {
      model: selectedModel,
      version: selectedVersion
    };
  }

  const candidate = getModelVersionsVisibleToUser(currentUser)
    .filter((version) => version.task_type === dataset.task_type && version.status === 'registered')
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];

  if (!candidate) {
    throw new Error('No registered model version available for this dataset task type.');
  }

  const model = models.find((item) => item.id === candidate.model_id);
  if (!model) {
    throw new Error('Model not found for selected model version.');
  }

  return {
    model,
    version: candidate
  };
};

const buildPreAnnotationPayloadFromPrediction = (
  taskType: TaskType,
  prediction: {
    boxes: Array<{ x: number; y: number; width: number; height: number; label: string; score: number }>;
    rotated_boxes: Array<{
      cx: number;
      cy: number;
      width: number;
      height: number;
      angle: number;
      label: string;
      score: number;
    }>;
    polygons: Array<{ label: string; score: number; points: Array<{ x: number; y: number }> }>;
    masks: Array<{ label: string; score: number; encoding: string }>;
    labels: Array<{ label: string; score: number }>;
    ocr: { lines: Array<{ text: string; confidence: number }>; words: Array<{ text: string; confidence: number }> };
    normalized_output: Record<string, unknown>;
  },
  meta: {
    model_version_id: string;
    framework: ModelFramework;
  }
): { payload: Record<string, unknown>; hasSignal: boolean } => {
  const source = typeof prediction.normalized_output.source === 'string'
    ? prediction.normalized_output.source
    : 'unknown';
  const commonMeta = {
    model_version_id: meta.model_version_id,
    framework: meta.framework,
    source
  };

  if (taskType === 'ocr') {
    const lines = prediction.ocr.lines.map((line, index) => ({
      id: `line-${index + 1}`,
      text: line.text,
      confidence: line.confidence,
      region_id: null
    }));
    const payload = {
      lines,
      words: prediction.ocr.words,
      pre_annotation_meta: commonMeta
    };
    return { payload, hasSignal: lines.length > 0 || prediction.ocr.words.length > 0 };
  }

  if (taskType === 'detection') {
    const payload = {
      boxes: prediction.boxes,
      pre_annotation_meta: commonMeta
    };
    return { payload, hasSignal: prediction.boxes.length > 0 };
  }

  if (taskType === 'obb') {
    const payload = {
      rotated_boxes: prediction.rotated_boxes,
      pre_annotation_meta: commonMeta
    };
    return { payload, hasSignal: prediction.rotated_boxes.length > 0 };
  }

  if (taskType === 'segmentation') {
    const payload = {
      polygons: prediction.polygons,
      masks: prediction.masks,
      pre_annotation_meta: commonMeta
    };
    return { payload, hasSignal: prediction.polygons.length > 0 || prediction.masks.length > 0 };
  }

  const payload = {
    labels: prediction.labels,
    pre_annotation_meta: commonMeta
  };
  return { payload, hasSignal: prediction.labels.length > 0 };
};

const toOptionalTrimmedString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const toOptionalBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const toOptionalInteger = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
};

const extractArtifactMetricsKeys = (payload: Record<string, unknown>): string[] => {
  const keys = new Set<string>();
  const metricsValue = payload.metrics;
  if (metricsValue && typeof metricsValue === 'object' && !Array.isArray(metricsValue)) {
    Object.entries(metricsValue).forEach(([metricName, metricValue]) => {
      if (typeof metricName === 'string' && typeof metricValue === 'number' && Number.isFinite(metricValue)) {
        keys.add(metricName);
      }
    });
  }

  if (keys.size > 0) {
    return Array.from(keys).sort((left, right) => left.localeCompare(right));
  }

  const summaryValue = payload.summary;
  if (summaryValue && typeof summaryValue === 'object' && !Array.isArray(summaryValue)) {
    Object.entries(summaryValue).forEach(([metricName, metricValue]) => {
      if (typeof metricName === 'string' && typeof metricValue === 'number' && Number.isFinite(metricValue)) {
        keys.add(metricName);
      }
    });
  }

  const metricSeriesValue = payload.metric_series;
  if (Array.isArray(metricSeriesValue)) {
    metricSeriesValue.forEach((point) => {
      if (!point || typeof point !== 'object' || Array.isArray(point)) {
        return;
      }
      const pointMetrics = (point as { metrics?: unknown }).metrics;
      if (!pointMetrics || typeof pointMetrics !== 'object' || Array.isArray(pointMetrics)) {
        return;
      }
      Object.entries(pointMetrics).forEach(([metricName, metricValue]) => {
        if (typeof metricName === 'string' && typeof metricValue === 'number' && Number.isFinite(metricValue)) {
          keys.add(metricName);
        }
      });
    });
  }

  return Array.from(keys).sort((left, right) => left.localeCompare(right));
};

const readTrainingArtifactSummary = async (
  attachment: FileAttachment
): Promise<TrainingArtifactSummary | null> => {
  if (attachment.status !== 'ready') {
    return null;
  }

  const stored = await findStoredAttachmentBinary(attachment);
  if (!stored) {
    return null;
  }

  try {
    const raw = await fs.readFile(stored.file_path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    const primaryModelPath =
      toOptionalTrimmedString(payload.primary_model_path) ??
      toOptionalTrimmedString(payload.model_path) ??
      null;

    return {
      runner: toOptionalTrimmedString(payload.runner),
      mode: toOptionalTrimmedString(payload.mode),
      fallback_reason: toOptionalTrimmedString(payload.fallback_reason),
      training_performed: toOptionalBoolean(payload.training_performed),
      primary_model_path: primaryModelPath,
      generated_at: toOptionalTrimmedString(payload.generated_at),
      sampled_items: toOptionalInteger(payload.sampled_items),
      metrics_keys: extractArtifactMetricsKeys(payload)
    };
  } catch {
    return null;
  }
};

const ensureTrainingArtifactAttachment = async (
  job: TrainingJobRecord,
  metrics: Record<string, number>
): Promise<FileAttachment> => {
  const artifactAttachmentId = findArtifactAttachmentIdByJob(job.id);
  if (artifactAttachmentId) {
    const existing = attachments.find((item) => item.id === artifactAttachmentId);
    if (existing) {
      return existing;
    }
  }

  const runtime = getTrainingRuntime(job.id) ?? {
    run_id: `legacy-${job.id}`,
    job_id: job.id,
    workspace_dir: path.join(trainingWorkspaceRoot, job.id),
    config_path: path.join(trainingWorkspaceRoot, job.id, 'job-config.json'),
    summary_path: path.join(trainingWorkspaceRoot, job.id, 'dataset-summary.json'),
    log_path: path.join(trainingWorkspaceRoot, job.id, 'train.log'),
    metrics_path: path.join(trainingWorkspaceRoot, job.id, 'metrics.json'),
    artifact_path: path.join(trainingWorkspaceRoot, job.id, 'artifacts', `${job.framework}-${job.id}.artifact.json`),
    cancelled: false
  };

  return upsertTrainingArtifactAttachment(job, runtime, metrics);
};

const resolvePrimaryModelPathFromArtifactAttachment = async (
  attachment: FileAttachment
): Promise<string | null> => {
  const stored = await findStoredAttachmentBinary(attachment);
  if (!stored) {
    return null;
  }

  const looksLikeManifest =
    attachment.mime_type === 'application/json' || attachment.filename.toLowerCase().endsWith('.json');
  if (!looksLikeManifest) {
    return stored.file_path;
  }

  try {
    const content = await fs.readFile(stored.file_path, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    const rawPrimaryPath =
      typeof payload.primary_model_path === 'string'
        ? payload.primary_model_path
        : typeof payload.model_path === 'string'
          ? payload.model_path
          : null;
    if (!rawPrimaryPath?.trim()) {
      return null;
    }

    const candidate = rawPrimaryPath.trim();
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(path.dirname(stored.file_path), candidate);
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) {
      return null;
    }

    return resolved;
  } catch {
    return null;
  }
};

const resolveModelVersionArtifactModelPath = async (
  version: ModelVersionRecord
): Promise<string | null> => {
  if (!version.artifact_attachment_id) {
    return null;
  }

  const attachment = attachments.find((item) => item.id === version.artifact_attachment_id);
  if (!attachment || attachment.status !== 'ready') {
    return null;
  }

  return resolvePrimaryModelPathFromArtifactAttachment(attachment);
};

const getModelVersionsVisibleToUser = (user: User): ModelVersionRecord[] =>
  modelVersions.filter((version) => {
    const model = models.find((item) => item.id === version.model_id);
    if (!model) {
      return false;
    }

    return (
      user.role === 'admin' ||
      model.owner_user_id === user.id ||
      model.visibility === 'workspace' ||
      model.visibility === 'public'
    );
  });

export async function register(_input: RegisterInput): Promise<User> {
  await delay();
  void _input;
  throw new Error('Public registration is disabled.');
}

export async function login(input: LoginInput): Promise<User> {
  await delay();

  const normalizedUsername = normalizeUsername(input.username);
  const matched = users.find((user) => normalizeUsername(user.username) === normalizedUsername);
  if (!matched) {
    throw new Error('Invalid username or password.');
  }
  assertUserAccountActive(matched);

  const expectedHash = userPasswordHashes[matched.id];
  if (!expectedHash || !verifyPassword(input.password.trim(), expectedHash)) {
    throw new Error('Invalid username or password.');
  }

  matched.last_login_at = now();
  logAudit('user_logged_in', 'User', matched.id, { username: matched.username }, matched.id);
  return matched;
}

export async function me(): Promise<User> {
  await delay(120);
  return findCurrentUser();
}

export async function listUsers(): Promise<User[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can list users.');
  return [...users];
}

export async function createUserByAdmin(input: CreateUserInput): Promise<User> {
  await delay();
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can provision accounts.');

  const username = input.username.trim();
  const normalizedUsername = normalizeUsername(username);
  const password = input.password.trim();
  const role = input.role;

  if (username.length < 3) {
    throw new Error('Username must be at least 3 characters.');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  if (role !== 'user' && role !== 'admin') {
    throw new Error('Role must be user or admin.');
  }

  if (users.some((user) => normalizeUsername(user.username) === normalizedUsername)) {
    throw new Error('Username already exists.');
  }

  const timestamp = now();
  const created: User = {
    id: nextId('u'),
    username,
    role,
    status: 'active',
    status_reason: null,
    capabilities: defaultCapabilitiesByRole(role),
    last_login_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };

  users.push(created);
  userPasswordHashes[created.id] = hashPassword(password);
  logAudit('user_created_by_admin', 'User', created.id, {
    username: created.username,
    role: created.role,
    created_by: currentUser.id
  });
  return created;
}

export async function changeMyPassword(input: ChangePasswordInput): Promise<{ updated: true }> {
  await delay();
  const currentUser = findCurrentUser();
  const currentPassword = input.current_password.trim();
  const newPassword = input.new_password.trim();
  const storedHash = userPasswordHashes[currentUser.id];

  if (!storedHash || !verifyPassword(currentPassword, storedHash)) {
    throw new Error('Current password is incorrect.');
  }

  if (newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  userPasswordHashes[currentUser.id] = hashPassword(newPassword);
  currentUser.updated_at = now();
  logAudit('user_password_changed', 'User', currentUser.id, {
    username: currentUser.username
  });
  return { updated: true };
}

export async function resetUserPasswordByAdmin(
  userId: string,
  input: ResetUserPasswordInput
): Promise<User> {
  await delay();
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can reset user passwords.');

  const targetUser = findUserById(userId);
  const nextPassword = input.new_password.trim();
  if (nextPassword.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  userPasswordHashes[targetUser.id] = hashPassword(nextPassword);
  targetUser.updated_at = now();
  logAudit('user_password_reset_by_admin', 'User', targetUser.id, {
    username: targetUser.username,
    reset_by: currentUser.id
  });
  return targetUser;
}

export async function updateUserStatusByAdmin(
  userId: string,
  input: UpdateUserStatusInput
): Promise<User> {
  await delay();
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can update account status.');

  const targetUser = findUserById(userId);
  if (input.status !== 'active' && input.status !== 'disabled') {
    throw new Error('Status must be active or disabled.');
  }

  if (input.status === 'disabled' && targetUser.id === currentUser.id) {
    throw new Error('Cannot disable your own account.');
  }

  if (
    input.status === 'disabled' &&
    targetUser.role === 'admin' &&
    targetUser.status === 'active' &&
    countActiveAdminUsers() <= 1
  ) {
    throw new Error('Cannot disable the last active admin account.');
  }

  const previousStatus = targetUser.status;
  const previousStatusReason = targetUser.status_reason;
  const nextStatusReason =
    input.status === 'disabled'
      ? typeof input.reason === 'string' && input.reason.trim()
        ? input.reason.trim()
        : ''
      : null;

  if (input.status === 'disabled' && !nextStatusReason) {
    throw new Error('Disable reason is required when disabling an account.');
  }

  targetUser.status = input.status;
  targetUser.status_reason = nextStatusReason;
  targetUser.updated_at = now();
  logAudit('user_status_updated_by_admin', 'User', targetUser.id, {
    username: targetUser.username,
    previous_status: previousStatus,
    next_status: targetUser.status,
    updated_by: currentUser.id,
    ...(previousStatusReason ? { previous_status_reason: previousStatusReason } : {}),
    ...(nextStatusReason ? { status_reason: nextStatusReason } : {})
  });
  return targetUser;
}

export async function listModels(): Promise<ModelRecord[]> {
  await delay();
  const currentUser = findCurrentUser();
  return models.filter(
    (model) =>
      currentUser.role === 'admin' ||
      model.visibility === 'public' ||
      model.visibility === 'workspace' ||
      model.owner_user_id === currentUser.id
  );
}

export async function listMyModels(): Promise<ModelRecord[]> {
  await delay();
  const currentUser = findCurrentUser();
  return models.filter(
    (model) => model.owner_user_id === currentUser.id || currentUser.role === 'admin'
  );
}

export async function createModelDraft(input: CreateModelDraftInput): Promise<ModelRecord> {
  await delay();
  const currentUser = findCurrentUser();

  if (!canManageModels(currentUser)) {
    throw new Error('No permission to create models.');
  }

  const created: ModelRecord = {
    id: nextId('m'),
    name: input.name,
    description: input.description,
    model_type: input.model_type,
    owner_user_id: currentUser.id,
    visibility: input.visibility,
    status: 'draft',
    metadata: {},
    created_at: now(),
    updated_at: now()
  };

  models.unshift(created);
  logAudit('model_created', 'Model', created.id, {
    owner_user_id: created.owner_user_id,
    visibility: created.visibility,
    status: created.status
  });
  return created;
}

export async function removeModelByAdmin(modelId: string): Promise<{ removed: true }> {
  await delay(120);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can delete models.');

  const modelIndex = models.findIndex((item) => item.id === modelId);
  if (modelIndex < 0) {
    throw new Error('Model not found.');
  }

  const model = models[modelIndex];
  if (!model) {
    throw new Error('Model not found.');
  }

  if (isCuratedFoundationModelName(model.name)) {
    throw new Error('Protected foundation models cannot be deleted.');
  }

  const dependentModelVersionCount = modelVersions.filter((version) => version.model_id === model.id).length;
  if (dependentModelVersionCount > 0) {
    throw new Error('Model cannot be deleted while model versions still exist.');
  }

  const dependentConversationCount = conversations.filter((conversation) => conversation.model_id === model.id).length;
  if (dependentConversationCount > 0) {
    throw new Error('Model cannot be deleted while conversations still exist.');
  }

  let removedAttachmentCount = 0;
  for (let attachmentIndex = attachments.length - 1; attachmentIndex >= 0; attachmentIndex -= 1) {
    const attachment = attachments[attachmentIndex];
    if (
      !attachment ||
      attachment.attached_to_type !== 'Model' ||
      attachment.attached_to_id !== model.id
    ) {
      continue;
    }

    attachments.splice(attachmentIndex, 1);
    await removeStoredAttachmentBinary(attachment);
    removedAttachmentCount += 1;
  }

  let removedApprovalCount = 0;
  for (let approvalIndex = approvalRequests.length - 1; approvalIndex >= 0; approvalIndex -= 1) {
    if (approvalRequests[approvalIndex]?.model_id !== model.id) {
      continue;
    }

    approvalRequests.splice(approvalIndex, 1);
    removedApprovalCount += 1;
  }

  models.splice(modelIndex, 1);
  logAudit('model_deleted_by_admin', 'Model', model.id, {
    model_name: model.name,
    owner_user_id: model.owner_user_id,
    model_type: model.model_type,
    visibility: model.visibility,
    removed_attachment_count: String(removedAttachmentCount),
    removed_approval_count: String(removedApprovalCount)
  });

  return { removed: true };
}

export async function listConversationAttachments(): Promise<FileAttachment[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  return attachments.filter(
    (item) => item.owner_user_id === currentUser.id && item.attached_to_type === 'Conversation'
  );
}

export async function uploadConversationAttachment(
  input: AttachmentUploadInput
): Promise<FileAttachment> {
  await delay(100);
  const currentUser = findCurrentUser();
  const normalized = normalizeAttachmentUploadInput(input);

  const created: FileAttachment = {
    id: nextId('f'),
    filename: normalized.filename,
    status: 'uploading',
    owner_user_id: currentUser.id,
    attached_to_type: 'Conversation',
    attached_to_id: null,
    mime_type: normalized.mime_type,
    byte_size: normalized.byte_size,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };

  attachments.unshift(created);
  if (normalized.content) {
    try {
      const stored = await storeAttachmentBinary(
        created,
        normalized.filename,
        normalized.content,
        normalized.mime_type
      );
      created.mime_type = stored.mime_type;
      created.byte_size = stored.byte_size;
      created.storage_backend = 'local';
      created.storage_path = stored.file_path;
    } catch {
      const index = attachments.findIndex((item) => item.id === created.id);
      if (index >= 0) {
        attachments.splice(index, 1);
      }
      throw new Error('Failed to persist uploaded file.');
    }
  }
  startAttachmentLifecycle(created, normalized.filename.toLowerCase().includes('fail'));
  logAudit('conversation_attachment_uploaded', 'FileAttachment', created.id, {
    filename: created.filename,
    byte_size: String(normalized.byte_size),
    mime_type: normalized.mime_type
  });
  return created;
}

export async function listInferenceInputAttachments(): Promise<FileAttachment[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  return attachments.filter(
    (item) =>
      item.owner_user_id === currentUser.id &&
      item.attached_to_type === 'InferenceRun' &&
      item.attached_to_id === null
  );
}

export async function uploadInferenceInputAttachment(
  input: AttachmentUploadInput
): Promise<FileAttachment> {
  await delay(100);
  const currentUser = findCurrentUser();
  const normalized = normalizeAttachmentUploadInput(input);

  const created: FileAttachment = {
    id: nextId('f'),
    filename: normalized.filename,
    status: 'uploading',
    owner_user_id: currentUser.id,
    attached_to_type: 'InferenceRun',
    attached_to_id: null,
    mime_type: normalized.mime_type,
    byte_size: normalized.byte_size,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };

  attachments.unshift(created);
  if (normalized.content) {
    try {
      const stored = await storeAttachmentBinary(
        created,
        normalized.filename,
        normalized.content,
        normalized.mime_type
      );
      created.mime_type = stored.mime_type;
      created.byte_size = stored.byte_size;
      created.storage_backend = 'local';
      created.storage_path = stored.file_path;
    } catch {
      const index = attachments.findIndex((item) => item.id === created.id);
      if (index >= 0) {
        attachments.splice(index, 1);
      }
      throw new Error('Failed to persist uploaded file.');
    }
  }
  startAttachmentLifecycle(created, normalized.filename.toLowerCase().includes('fail'));
  logAudit('inference_input_uploaded', 'FileAttachment', created.id, {
    filename: created.filename,
    byte_size: String(normalized.byte_size),
    mime_type: normalized.mime_type
  });
  return created;
}

export async function listConversations(): Promise<ConversationRecord[]> {
  await delay(100);
  const currentUser = findCurrentUser();

  const visible = conversations.filter(
    (conversation) => currentUser.role === 'admin' || conversation.created_by === currentUser.id
  );

  return [...visible].sort(
    (a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at)
  );
}

export async function getConversationDetail(
  conversationId: string
): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] }> {
  await delay(80);
  const currentUser = findCurrentUser();
  const conversation = assertConversationAccess(conversationId, currentUser);

  return {
    conversation,
    messages: conversationMessages(conversation.id)
  };
}

export async function renameConversation(
  conversationId: string,
  input: RenameConversationInput
): Promise<ConversationRecord> {
  await delay(90);
  const currentUser = findCurrentUser();
  const conversation = assertConversationAccess(conversationId, currentUser);
  const nextTitle = input.title.trim();

  if (nextTitle.length < 1 || nextTitle.length > 120) {
    throw new Error('Conversation title must be between 1 and 120 characters.');
  }

  conversation.title = nextTitle;
  conversation.updated_at = now();

  logAudit('conversation_renamed', 'Conversation', conversation.id, {
    title: conversation.title
  });

  return conversation;
}

export async function listModelAttachments(modelId: string): Promise<FileAttachment[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  const model = assertModelAccess(modelId, currentUser);

  if (!(currentUser.role === 'admin' || model.owner_user_id === currentUser.id)) {
    throw new Error('No permission to view this model files.');
  }

  return attachments.filter(
    (item) => item.attached_to_type === 'Model' && item.attached_to_id === modelId
  );
}

export async function uploadModelAttachment(
  modelId: string,
  input: AttachmentUploadInput
): Promise<FileAttachment> {
  await delay(100);
  const currentUser = findCurrentUser();
  const model = assertModelAccess(modelId, currentUser);
  const normalized = normalizeAttachmentUploadInput(input);

  if (!(currentUser.role === 'admin' || model.owner_user_id === currentUser.id)) {
    throw new Error('No permission to upload model files.');
  }

  const created: FileAttachment = {
    id: nextId('f'),
    filename: normalized.filename,
    status: 'uploading',
    owner_user_id: currentUser.id,
    attached_to_type: 'Model',
    attached_to_id: modelId,
    mime_type: normalized.mime_type,
    byte_size: normalized.byte_size,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };

  attachments.unshift(created);
  if (normalized.content) {
    try {
      const stored = await storeAttachmentBinary(
        created,
        normalized.filename,
        normalized.content,
        normalized.mime_type
      );
      created.mime_type = stored.mime_type;
      created.byte_size = stored.byte_size;
      created.storage_backend = 'local';
      created.storage_path = stored.file_path;
    } catch {
      const index = attachments.findIndex((item) => item.id === created.id);
      if (index >= 0) {
        attachments.splice(index, 1);
      }
      throw new Error('Failed to persist uploaded file.');
    }
  }
  startAttachmentLifecycle(created, normalized.filename.toLowerCase().includes('fail'));
  logAudit('model_attachment_uploaded', 'FileAttachment', created.id, {
    filename: created.filename,
    model_id: modelId,
    byte_size: String(normalized.byte_size),
    mime_type: normalized.mime_type
  });
  return created;
}

export async function getAttachmentContent(
  attachmentId: string
): Promise<{ filename: string; mime_type: string; byte_size: number; content: Buffer }> {
  await delay(70);
  const currentUser = findCurrentUser();
  const attachment = attachments.find((item) => item.id === attachmentId);
  if (!attachment) {
    throw new Error('Attachment not found.');
  }

  assertAttachmentReadAccess(attachment, currentUser);

  if (attachment.status !== 'ready') {
    throw new Error('Attachment content not found.');
  }

  const stored = await findStoredAttachmentBinary(attachment);
  if (!stored) {
    throw new Error('Attachment content not found.');
  }

  const content = await fs.readFile(stored.file_path);
  attachment.mime_type = stored.mime_type || attachment.mime_type || guessMimeType(attachment.filename);
  attachment.byte_size = content.byteLength;
  attachment.storage_backend = 'local';
  attachment.storage_path = stored.file_path;
  attachment.updated_at = now();
  markAppStateDirty();
  return {
    filename: attachment.filename,
    mime_type: stored.mime_type || guessMimeType(attachment.filename),
    byte_size: content.byteLength,
    content
  };
}

export async function removeAttachment(attachmentId: string): Promise<void> {
  await delay(120);
  const currentUser = findCurrentUser();
  const index = attachments.findIndex(
    (item) => item.id === attachmentId && item.owner_user_id === currentUser.id
  );
  if (index >= 0) {
    const [deleted] = attachments.splice(index, 1);
    if (deleted) {
      for (let datasetItemIndex = datasetItems.length - 1; datasetItemIndex >= 0; datasetItemIndex -= 1) {
        if (datasetItems[datasetItemIndex]?.attachment_id === deleted.id) {
          datasetItems.splice(datasetItemIndex, 1);
        }
      }
      for (const [jobId, artifactAttachmentId] of trainingArtifactAttachmentByJobId.entries()) {
        if (artifactAttachmentId === deleted.id) {
          trainingArtifactAttachmentByJobId.delete(jobId);
        }
      }
      await removeStoredAttachmentBinary(deleted);

      logAudit('attachment_deleted', 'FileAttachment', deleted.id, {
        filename: deleted.filename
      });
    }
  }
}

export async function startConversation(
  input: StartConversationInput
): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] }> {
  await delay();
  const currentUser = findCurrentUser();

  const model = assertModelAccess(input.model_id, currentUser);

  const createdConversation: ConversationRecord = {
    id: nextId('c'),
    model_id: model.id,
    title: input.initial_message.slice(0, 40) || `Conversation with ${model.name}`,
    status: 'active',
    created_by: currentUser.id,
    created_at: now(),
    updated_at: now()
  };

  conversations.unshift(createdConversation);

  const userMessage: MessageRecord = {
    id: nextId('msg'),
    conversation_id: createdConversation.id,
    sender: 'user',
    content: input.initial_message,
    attachment_ids: input.attachment_ids,
    metadata: {},
    created_at: now()
  };

  const fileNames = attachments
    .filter((item) => input.attachment_ids.includes(item.id))
    .map((item) => item.filename);

  const effectiveLlmConfig = getEffectiveConversationLlmConfig(input.llm_config);
  const actionResolution = await resolveConversationAction(
    createdConversation,
    input.initial_message,
    input.attachment_ids,
    currentUser
  );
  const assistantContent =
    actionResolution?.content ??
    (await generateAssistantReply(
      input.initial_message,
      fileNames,
      effectiveLlmConfig
    ));

  const assistantMessage: MessageRecord = {
    id: nextId('msg'),
    conversation_id: createdConversation.id,
    sender: 'assistant',
    content: assistantContent,
    attachment_ids: [],
    metadata: actionResolution?.metadata ?? {},
    created_at: now()
  };

  messages.push(userMessage, assistantMessage);

  for (const attachment of attachments) {
    if (input.attachment_ids.includes(attachment.id) && attachment.attached_to_type === 'Conversation') {
      attachment.attached_to_id = createdConversation.id;
      attachment.updated_at = now();
    }
  }

  logAudit('conversation_started', 'Conversation', createdConversation.id, {
    model_id: createdConversation.model_id
  });

  return {
    conversation: createdConversation,
    messages: conversationMessages(createdConversation.id)
  };
}

export async function sendConversationMessage(
  input: SendMessageInput
): Promise<{ messages: MessageRecord[] }> {
  await delay();
  const currentUser = findCurrentUser();
  const conversation = assertConversationAccess(input.conversation_id, currentUser);

  const userMessage: MessageRecord = {
    id: nextId('msg'),
    conversation_id: conversation.id,
    sender: 'user',
    content: input.content,
    attachment_ids: input.attachment_ids,
    metadata: {},
    created_at: now()
  };

  const fileNames = attachments
    .filter((item) => input.attachment_ids.includes(item.id))
    .map((item) => item.filename);

  const effectiveLlmConfig = getEffectiveConversationLlmConfig(input.llm_config);
  const actionResolution = await resolveConversationAction(
    conversation,
    input.content,
    input.attachment_ids,
    currentUser
  );
  const assistantContent =
    actionResolution?.content ??
    (await generateAssistantReply(
      input.content,
      fileNames,
      effectiveLlmConfig
    ));

  const assistantMessage: MessageRecord = {
    id: nextId('msg'),
    conversation_id: conversation.id,
    sender: 'assistant',
    content: assistantContent,
    attachment_ids: [],
    metadata: actionResolution?.metadata ?? {},
    created_at: now()
  };

  messages.push(userMessage, assistantMessage);
  conversation.updated_at = now();
  logAudit('conversation_message_sent', 'Conversation', conversation.id, {
    message_id: userMessage.id
  });

  return { messages: conversationMessages(conversation.id) };
}

export async function listDatasets(): Promise<DatasetRecord[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  return datasets.filter(
    (dataset) => currentUser.role === 'admin' || dataset.owner_user_id === currentUser.id
  );
}

export async function createDataset(input: CreateDatasetInput): Promise<DatasetRecord> {
  await delay(120);
  const currentUser = findCurrentUser();

  const created: DatasetRecord = {
    id: nextId('d'),
    name: input.name.trim(),
    description: input.description.trim(),
    task_type: input.task_type,
    status: 'draft',
    owner_user_id: currentUser.id,
    label_schema: {
      classes: input.label_schema.classes
    },
    metadata: {},
    created_at: now(),
    updated_at: now()
  };

  datasets.unshift(created);
  logAudit('dataset_created', 'Dataset', created.id, {
    task_type: created.task_type
  });

  return created;
}

export async function getDatasetDetail(datasetId: string): Promise<{
  dataset: DatasetRecord;
  attachments: FileAttachment[];
  items: DatasetItemRecord[];
  versions: DatasetVersionRecord[];
}> {
  await delay(100);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);

  return {
    dataset,
    attachments: attachments.filter(
      (attachment) => attachment.attached_to_type === 'Dataset' && attachment.attached_to_id === datasetId
    ),
    items: datasetItems.filter((item) => item.dataset_id === datasetId),
    versions: datasetVersions.filter((version) => version.dataset_id === datasetId)
  };
}

export async function listDatasetItems(datasetId: string): Promise<DatasetItemRecord[]> {
  await delay(100);
  const currentUser = findCurrentUser();
  assertDatasetAccess(datasetId, currentUser);
  return datasetItems.filter((item) => item.dataset_id === datasetId);
}

export async function createDatasetItem(
  datasetId: string,
  input: CreateDatasetItemInput
): Promise<DatasetItemRecord> {
  await delay(100);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);
  const requestedAttachmentId =
    typeof input.attachment_id === 'string' && input.attachment_id.trim()
      ? input.attachment_id.trim()
      : '';
  const requestedFilenameRaw =
    typeof input.filename === 'string' && input.filename.trim()
      ? input.filename.trim()
      : '';
  const requestedFilename = requestedFilenameRaw ? path.basename(requestedFilenameRaw) : '';

  if (!requestedAttachmentId && !requestedFilename) {
    throw new Error('attachment_id or filename is required to create dataset item.');
  }

  let attachment =
    requestedAttachmentId
      ? attachments.find(
          (entry) =>
            entry.id === requestedAttachmentId &&
            entry.attached_to_type === 'Dataset' &&
            entry.attached_to_id === dataset.id
        ) ?? null
      : null;
  if (!attachment && requestedAttachmentId) {
    throw new Error('Dataset attachment not found in this dataset.');
  }

  if (!attachment && requestedFilename) {
    attachment =
      findDatasetReadyAttachmentByFilename(dataset.id, requestedFilename) ??
      createDatasetReferenceAttachment(dataset, currentUser, requestedFilename);
  }

  if (!attachment) {
    throw new Error('Unable to resolve dataset item attachment.');
  }

  const result = upsertDatasetItemForAttachment(dataset, attachment, {
    split: input.split,
    status: input.status ?? attachment.status,
    metadata: input.metadata
  });

  logAudit(result.created ? 'dataset_item_created' : 'dataset_item_upserted', 'Dataset', dataset.id, {
    item_id: result.item.id,
    attachment_id: attachment.id,
    attachment_filename: attachment.filename
  });

  return result.item;
}

export async function updateDatasetItem(
  datasetId: string,
  itemId: string,
  input: UpdateDatasetItemInput
): Promise<DatasetItemRecord> {
  await delay(100);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);
  const item = findDatasetItem(dataset.id, itemId);

  const nextSplit = parseDatasetItemSplit(input.split, item.split);
  const nextStatus = parseDatasetItemStatus(input.status, item.status);
  const nextMetadata =
    input.metadata === undefined ? item.metadata : normalizeDatasetItemMetadata(input.metadata);

  const changed =
    item.split !== nextSplit ||
    item.status !== nextStatus ||
    JSON.stringify(item.metadata) !== JSON.stringify(nextMetadata);

  if (changed) {
    item.split = nextSplit;
    item.status = nextStatus;
    item.metadata = nextMetadata;
    item.updated_at = now();
  }

  logAudit('dataset_item_updated', 'Dataset', dataset.id, {
    item_id: item.id,
    split: item.split,
    status: item.status
  });

  return item;
}

export async function listDatasetAttachments(datasetId: string): Promise<FileAttachment[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  assertDatasetAccess(datasetId, currentUser);
  return attachments.filter(
    (attachment) => attachment.attached_to_type === 'Dataset' && attachment.attached_to_id === datasetId
  );
}

export async function uploadDatasetAttachment(
  datasetId: string,
  input: AttachmentUploadInput
): Promise<FileAttachment> {
  await delay(100);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);
  const normalized = normalizeAttachmentUploadInput(input);

  const attachment: FileAttachment = {
    id: nextId('f'),
    filename: normalized.filename,
    status: 'uploading',
    owner_user_id: currentUser.id,
    attached_to_type: 'Dataset',
    attached_to_id: dataset.id,
    mime_type: normalized.mime_type,
    byte_size: normalized.byte_size,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };

  attachments.unshift(attachment);

  const item: DatasetItemRecord = {
    id: nextId('di'),
    dataset_id: dataset.id,
    attachment_id: attachment.id,
    split: 'unassigned',
    status: 'uploading',
    metadata: {},
    created_at: now(),
    updated_at: now()
  };

  datasetItems.unshift(item);
  if (normalized.content) {
    try {
      const stored = await storeAttachmentBinary(
        attachment,
        normalized.filename,
        normalized.content,
        normalized.mime_type
      );
      attachment.mime_type = stored.mime_type;
      attachment.byte_size = stored.byte_size;
      attachment.storage_backend = 'local';
      attachment.storage_path = stored.file_path;
    } catch {
      const attachmentIndex = attachments.findIndex((record) => record.id === attachment.id);
      if (attachmentIndex >= 0) {
        attachments.splice(attachmentIndex, 1);
      }
      const itemIndex = datasetItems.findIndex((record) => record.id === item.id);
      if (itemIndex >= 0) {
        datasetItems.splice(itemIndex, 1);
      }
      throw new Error('Failed to persist uploaded file.');
    }
  }

  startAttachmentLifecycle(attachment, normalized.filename.toLowerCase().includes('fail'), (status) => {
    item.status = status;
    item.updated_at = now();

    if (status === 'ready') {
      dataset.status = 'ready';
      dataset.updated_at = now();
    }
  });

  logAudit('dataset_attachment_uploaded', 'Dataset', dataset.id, {
    attachment_id: attachment.id,
    filename: attachment.filename,
    byte_size: String(normalized.byte_size),
    mime_type: normalized.mime_type
  });

  return attachment;
}

export async function splitDataset(input: {
  dataset_id: string;
  train_ratio: number;
  val_ratio: number;
  test_ratio: number;
  seed: number;
}): Promise<{ split_summary: { train: number; val: number; test: number; unassigned: number } }> {
  await delay(120);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(input.dataset_id, currentUser);

  const relevantItems = sortItemsBySeed(
    datasetItems.filter((item) => item.dataset_id === dataset.id && isTrainableDatasetItem(item)),
    input.seed
  );
  if (relevantItems.length === 0) {
    return { split_summary: { train: 0, val: 0, test: 0, unassigned: 0 } };
  }

  let trainLimit = Math.floor(relevantItems.length * input.train_ratio);
  if (input.train_ratio > 0 && trainLimit === 0) {
    trainLimit = 1;
  }
  trainLimit = Math.min(trainLimit, relevantItems.length);

  let valLimit = Math.floor(relevantItems.length * input.val_ratio);
  if (trainLimit + valLimit > relevantItems.length) {
    valLimit = Math.max(0, relevantItems.length - trainLimit);
  }

  relevantItems.forEach((item, index) => {
    if (index < trainLimit) {
      item.split = 'train';
    } else if (index < trainLimit + valLimit) {
      item.split = 'val';
    } else {
      item.split = 'test';
    }
    item.updated_at = now();
  });

  dataset.updated_at = now();

  const splitSummary = computeSplitSummary(dataset.id, { trainableOnly: true });
  logAudit('dataset_split_updated', 'Dataset', dataset.id, {
    train: String(splitSummary.train),
    val: String(splitSummary.val),
    test: String(splitSummary.test),
    seed: String(input.seed)
  });

  return { split_summary: splitSummary };
}

export async function listDatasetVersions(datasetId: string): Promise<DatasetVersionRecord[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  assertDatasetAccess(datasetId, currentUser);
  return datasetVersions.filter((version) => version.dataset_id === datasetId);
}

export async function createDatasetVersion(input: {
  dataset_id: string;
  version_name?: string;
}): Promise<DatasetVersionRecord> {
  await delay(120);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(input.dataset_id, currentUser);

  const splitSummary = computeSplitSummary(dataset.id, { trainableOnly: true });
  const version: DatasetVersionRecord = {
    id: nextId('dv'),
    dataset_id: dataset.id,
    version_name: input.version_name?.trim() || `v${datasetVersions.filter((item) => item.dataset_id === dataset.id).length + 1}`,
    split_summary: splitSummary,
    item_count: datasetItems.filter((item) => item.dataset_id === dataset.id && isTrainableDatasetItem(item)).length,
    annotation_coverage: annotationCoverageForDataset(dataset.id),
    created_by: currentUser.id,
    created_at: now()
  };

  datasetVersions.unshift(version);
  logAudit('dataset_version_created', 'DatasetVersion', version.id, {
    dataset_id: dataset.id,
    version_name: version.version_name
  });

  return version;
}

export async function importDatasetAnnotations(
  datasetId: string,
  input: { format: 'yolo' | 'coco' | 'labelme' | 'ocr'; attachment_id: string }
): Promise<{ format: string; imported: number; updated: number; created_items: number; status: 'completed' }> {
  await delay(120);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);

  if (!['yolo', 'ocr', 'coco', 'labelme'].includes(input.format)) {
    throw new Error('Current implementation supports yolo/coco/labelme/ocr import formats.');
  }

  if (['yolo', 'coco', 'labelme'].includes(input.format) && ['ocr', 'classification'].includes(dataset.task_type)) {
    throw new Error('Selected import format requires detection/obb/segmentation dataset task type.');
  }

  if (input.format === 'ocr' && dataset.task_type !== 'ocr') {
    throw new Error('OCR import requires dataset task_type=ocr.');
  }

  const sourceAttachment = attachments.find(
    (attachment) =>
      attachment.id === input.attachment_id &&
      attachment.attached_to_type === 'Dataset' &&
      attachment.attached_to_id === dataset.id
  );

  if (!sourceAttachment) {
    throw new Error('Import source attachment not found in this dataset.');
  }

  if (sourceAttachment.status !== 'ready') {
    throw new Error('Import source attachment is not ready.');
  }

  const stored = await findStoredAttachmentBinary(sourceAttachment);
  if (!stored) {
    throw new Error('Import source file content is missing. Please upload a real file and retry.');
  }

  const contentBuffer = await fs.readFile(stored.file_path);
  const content = contentBuffer.toString('utf8');
  if (!content.trim()) {
    throw new Error('Import source file is empty.');
  }

  const itemByFilename = buildDatasetItemByFilenameMap(dataset.id);
  const prepared: GenericImportEntry[] = (() => {
    if (input.format === 'yolo') {
      return parseYoloImport(content, sourceAttachment.filename).map((entry) => ({
        filename: normalizeImportFilename(entry.filename),
        payload: { boxes: entry.boxes }
      }));
    }

    if (input.format === 'ocr') {
      return parseOcrImport(content, sourceAttachment.filename).map((entry) => ({
        filename: normalizeImportFilename(entry.filename),
        payload: { lines: entry.lines }
      }));
    }

    if (input.format === 'coco') {
      return parseCocoImport(content).map((entry) => ({
        filename: normalizeImportFilename(entry.filename),
        payload: { boxes: entry.boxes }
      }));
    }

    return parseLabelMeImport(content, dataset.task_type).map((entry) => ({
      filename: normalizeImportFilename(entry.filename),
      payload: entry.payload
    }));
  })();

  if (prepared.length === 0) {
    throw new Error('No valid annotation records were parsed from import file.');
  }

  let imported = 0;
  let updated = 0;
  let createdItems = 0;

  for (const entry of prepared) {
    let matchedItems = itemByFilename.get(entry.filename) ?? [];
    if (matchedItems.length === 0) {
      const resolvedFilename = entry.filename.trim();
      if (resolvedFilename) {
        const resolvedAttachment =
          findDatasetReadyAttachmentByFilename(dataset.id, resolvedFilename) ??
          createDatasetReferenceAttachment(dataset, currentUser, resolvedFilename);
        const upsertedItem = upsertDatasetItemForAttachment(dataset, resolvedAttachment, {
          split: 'unassigned',
          status: 'ready',
          metadata: {
            import_reference: 'true',
            import_source_attachment_id: sourceAttachment.id,
            import_source_format: input.format
          }
        });
        if (upsertedItem.created) {
          createdItems += 1;
        }
        if (upsertedItem.item.status === 'ready') {
          matchedItems = [upsertedItem.item];
          itemByFilename.set(entry.filename, matchedItems);
        }
      }
    }

    for (const item of matchedItems) {
      const existing = annotations.find((annotation) => annotation.dataset_item_id === item.id);
      if (!existing) {
        const created: AnnotationRecord = {
          id: nextId('ann'),
          dataset_item_id: item.id,
          task_type: dataset.task_type,
          source: 'import',
          status: 'annotated',
          payload: entry.payload,
          annotated_by: currentUser.id,
          created_at: now(),
          updated_at: now()
        };
        annotations.unshift(created);
        imported += 1;
        continue;
      }

      if (existing.status === 'approved') {
        continue;
      }

      existing.payload = entry.payload;
      existing.source = 'import';
      existing.status = 'annotated';
      existing.annotated_by = currentUser.id;
      existing.updated_at = now();
      updated += 1;
    }
  }

  logAudit('dataset_annotation_imported', 'Dataset', dataset.id, {
    format: input.format,
    imported: String(imported),
    updated: String(updated),
    created_items: String(createdItems),
    source_attachment_id: sourceAttachment.id
  });

  return {
    format: input.format,
    imported,
    updated,
    created_items: createdItems,
    status: 'completed'
  };
}

export async function exportDatasetAnnotations(
  datasetId: string,
  input: { format: 'yolo' | 'coco' | 'labelme' | 'ocr' }
): Promise<{
  format: string;
  exported: number;
  attachment_id: string;
  filename: string;
  status: 'ready';
}> {
  await delay(120);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);

  if (!['yolo', 'coco', 'labelme', 'ocr'].includes(input.format)) {
    throw new Error('Current implementation supports yolo/coco/labelme/ocr export formats.');
  }
  if (['yolo', 'coco', 'labelme'].includes(input.format) && ['ocr', 'classification'].includes(dataset.task_type)) {
    throw new Error('Selected export format requires detection/obb/segmentation dataset task type.');
  }
  if (input.format === 'ocr' && dataset.task_type !== 'ocr') {
    throw new Error('OCR export requires dataset task_type=ocr.');
  }

  const entries = listDatasetAnnotationExportEntries(dataset.id);
  const exportedAt = now();
  const filename = `annotations-${dataset.id}-${input.format}-${Date.now()}.json`;
  let exportPayload: unknown;
  let exported = 0;

  if (input.format === 'yolo') {
    const rows = buildYoloExportPayload(entries);
    exportPayload = {
      dataset_id: dataset.id,
      format: input.format,
      exported_at: exportedAt,
      items: rows
    };
    exported = rows.length;
  } else if (input.format === 'ocr') {
    const rows = buildOcrExportPayload(entries);
    exportPayload = {
      dataset_id: dataset.id,
      format: input.format,
      exported_at: exportedAt,
      items: rows
    };
    exported = rows.length;
  } else if (input.format === 'coco') {
    const cocoPayload = buildCocoExportPayload(entries);
    exportPayload = {
      dataset_id: dataset.id,
      format: input.format,
      exported_at: exportedAt,
      ...cocoPayload
    };
    exported = cocoPayload.annotations.length;
  } else {
    const rows = buildLabelMeExportPayload(entries, dataset.task_type);
    exportPayload = {
      dataset_id: dataset.id,
      format: input.format,
      exported_at: exportedAt,
      items: rows
    };
    exported = rows.length;
  }

  const exportBuffer = Buffer.from(JSON.stringify(exportPayload, null, 2), 'utf8');
  const attachment: FileAttachment = {
    id: nextId('f'),
    filename,
    status: 'uploading',
    owner_user_id: currentUser.id,
    attached_to_type: 'Dataset',
    attached_to_id: dataset.id,
    mime_type: 'application/json',
    byte_size: exportBuffer.byteLength,
    storage_backend: null,
    storage_path: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };

  attachments.unshift(attachment);
  const stored = await storeAttachmentBinary(
    attachment,
    filename,
    exportBuffer,
    'application/json'
  );
  attachment.status = 'ready';
  attachment.mime_type = stored.mime_type;
  attachment.byte_size = stored.byte_size;
  attachment.storage_backend = 'local';
  attachment.storage_path = stored.file_path;
  attachment.updated_at = now();

  logAudit('dataset_annotation_exported', 'Dataset', dataset.id, {
    format: input.format,
    exported: String(exported),
    attachment_id: attachment.id
  });

  return {
    format: input.format,
    exported,
    attachment_id: attachment.id,
    filename: attachment.filename,
    status: 'ready'
  };
}

export async function listDatasetAnnotations(datasetId: string): Promise<AnnotationWithReview[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  assertDatasetAccess(datasetId, currentUser);
  return listDatasetAnnotationsInternal(datasetId);
}

export async function upsertDatasetAnnotation(
  datasetId: string,
  input: UpsertAnnotationInput
): Promise<AnnotationWithReview> {
  await delay(120);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);
  const datasetItem = findDatasetItem(dataset.id, input.dataset_item_id);

  if (dataset.task_type !== input.task_type) {
    throw new Error('Annotation task_type does not match dataset task_type.');
  }

  const existing = annotations.find((annotation) => annotation.dataset_item_id === datasetItem.id);
  if (!existing) {
    if (!['unannotated', 'in_progress', 'annotated'].includes(input.status)) {
      throw new Error('New annotation must start from unannotated/in_progress/annotated.');
    }

    const created: AnnotationRecord = {
      id: nextId('ann'),
      dataset_item_id: datasetItem.id,
      task_type: input.task_type,
      source: input.source,
      status: input.status,
      payload: input.payload,
      annotated_by: currentUser.id,
      created_at: now(),
      updated_at: now()
    };

    annotations.unshift(created);
    logAudit('annotation_created', 'Annotation', created.id, {
      dataset_id: dataset.id,
      dataset_item_id: datasetItem.id,
      status: created.status
    });

    return {
      ...created,
      latest_review: null
    };
  }

  if (!canUpsertAnnotationStatus(existing.status, input.status)) {
    throw new Error(`Invalid annotation transition: ${existing.status} -> ${input.status}.`);
  }

  existing.status = input.status;
  existing.payload = input.payload;
  existing.source = input.source;
  existing.annotated_by = currentUser.id;
  existing.updated_at = now();

  logAudit('annotation_updated', 'Annotation', existing.id, {
    dataset_id: dataset.id,
    dataset_item_id: datasetItem.id,
    status: existing.status
  });

  return {
    ...existing,
    latest_review: latestAnnotationReview(existing.id)
  };
}

export async function submitAnnotationForReview(
  datasetId: string,
  annotationId: string
): Promise<AnnotationWithReview> {
  await delay(120);
  const currentUser = findCurrentUser();
  assertDatasetAccess(datasetId, currentUser);

  const annotation = annotations.find((item) => item.id === annotationId);
  if (!annotation) {
    throw new Error('Annotation not found.');
  }

  const datasetItem = findDatasetItem(datasetId, annotation.dataset_item_id);
  if (datasetItem.dataset_id !== datasetId) {
    throw new Error('Annotation does not belong to this dataset.');
  }

  if (!canTransitionAnnotationStatus(annotation.status, 'in_review') || annotation.status !== 'annotated') {
    throw new Error('Only annotated annotations can be submitted for review.');
  }

  annotation.status = 'in_review';
  annotation.updated_at = now();
  logAudit('annotation_submitted_review', 'Annotation', annotation.id, {
    dataset_item_id: annotation.dataset_item_id
  });

  return {
    ...annotation,
    latest_review: latestAnnotationReview(annotation.id)
  };
}

export async function reviewDatasetAnnotation(
  datasetId: string,
  annotationId: string,
  input: ReviewAnnotationInput
): Promise<AnnotationWithReview> {
  await delay(120);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);

  if (!(currentUser.role === 'admin' || dataset.owner_user_id === currentUser.id)) {
    throw new Error('No permission to review annotations for this dataset.');
  }

  const annotation = annotations.find((item) => item.id === annotationId);
  if (!annotation) {
    throw new Error('Annotation not found.');
  }

  findDatasetItem(datasetId, annotation.dataset_item_id);

  if (annotation.status !== 'in_review') {
    throw new Error('Only in_review annotation can be reviewed.');
  }

  const nextStatus = input.status === 'approved' ? 'approved' : 'rejected';
  if (!canTransitionAnnotationStatus(annotation.status, nextStatus)) {
    throw new Error(`Invalid annotation transition: ${annotation.status} -> ${nextStatus}.`);
  }

  const normalizedReviewReasonCode =
    typeof input.review_reason_code === 'string' && input.review_reason_code.trim()
      ? input.review_reason_code.trim()
      : null;

  if (normalizedReviewReasonCode && !annotationReviewReasonCodes.has(normalizedReviewReasonCode as AnnotationReviewReasonCode)) {
    throw new Error('Invalid review_reason_code.');
  }

  if (nextStatus === 'rejected' && !normalizedReviewReasonCode) {
    throw new Error('Rejected review must include review_reason_code.');
  }

  if (nextStatus === 'approved' && normalizedReviewReasonCode) {
    throw new Error('Approved review cannot include review_reason_code.');
  }

  annotation.status = nextStatus;
  annotation.updated_at = now();

  const review: AnnotationReviewRecord = {
    id: nextId('arv'),
    annotation_id: annotation.id,
    reviewer_user_id: currentUser.id,
    status: input.status,
    review_reason_code: nextStatus === 'rejected' ? (normalizedReviewReasonCode as AnnotationReviewReasonCode) : null,
    quality_score: input.quality_score ?? null,
    review_comment: input.review_comment?.trim() || null,
    created_at: now()
  };
  annotationReviews.unshift(review);

  logAudit('annotation_reviewed', 'AnnotationReview', review.id, {
    annotation_id: annotation.id,
    status: review.status,
    review_reason_code: review.review_reason_code ?? ''
  });

  return {
    ...annotation,
    latest_review: review
  };
}

export async function runDatasetPreAnnotations(
  datasetId: string,
  input: { model_version_id?: string } = {}
): Promise<{
  created: number;
  updated: number;
  annotations: AnnotationWithReview[];
}> {
  await delay(120);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);
  const preAnnotationTarget = resolvePreAnnotationTarget(
    dataset,
    currentUser,
    input.model_version_id
  );
  const trainer = getTrainerByFramework(preAnnotationTarget.version.framework);

  const items = datasetItems.filter((item) => item.dataset_id === dataset.id && item.status === 'ready');
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const attachment = attachments.find((entry) => entry.id === item.attachment_id);
    if (!attachment || attachment.status !== 'ready') {
      skipped += 1;
      continue;
    }

    const prediction = await trainer.predict({
      modelId: preAnnotationTarget.model.id,
      modelVersionId: preAnnotationTarget.version.id,
      inputAttachmentId: attachment.id,
      filename: attachment.filename,
      taskType: dataset.task_type,
      inputMimeType: attachment.mime_type,
      inputByteSize: attachment.byte_size,
      inputStoragePath: attachment.storage_path
    });

    const normalized = buildPreAnnotationPayloadFromPrediction(
      dataset.task_type,
      prediction,
      {
        model_version_id: preAnnotationTarget.version.id,
        framework: preAnnotationTarget.version.framework
      }
    );

    if (!normalized.hasSignal) {
      skipped += 1;
      continue;
    }

    const existing = annotations.find((annotation) => annotation.dataset_item_id === item.id);

    if (!existing) {
      const record: AnnotationRecord = {
        id: nextId('ann'),
        dataset_item_id: item.id,
        task_type: dataset.task_type,
        source: 'pre_annotation',
        status: 'in_progress',
        payload: normalized.payload,
        annotated_by: currentUser.id,
        created_at: now(),
        updated_at: now()
      };
      annotations.unshift(record);
      created += 1;
      continue;
    }

    if (existing.status === 'approved') {
      skipped += 1;
      continue;
    }

    existing.payload = normalized.payload;
    existing.source = 'pre_annotation';
    existing.status = 'in_progress';
    existing.annotated_by = currentUser.id;
    existing.updated_at = now();
    updated += 1;
  }

  logAudit('dataset_pre_annotation_run', 'Dataset', dataset.id, {
    model_version_id: preAnnotationTarget.version.id,
    framework: preAnnotationTarget.version.framework,
    created: String(created),
    updated: String(updated),
    skipped: String(skipped)
  });

  return {
    created,
    updated,
    annotations: listDatasetAnnotationsInternal(dataset.id)
  };
}

export async function listTrainingJobs(): Promise<TrainingJobRecord[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  return getVisibleTrainingJobsForUser(currentUser);
}

const getVisibleTrainingJobsForUser = (user: User): TrainingJobRecord[] =>
  trainingJobs.filter((job) => {
    const dataset = datasets.find((item) => item.id === job.dataset_id);
    if (!dataset) {
      return false;
    }
    return user.role === 'admin' || dataset.owner_user_id === user.id;
  });

const serializeTrainingWorker = (
  worker: TrainingWorkerNodeRecord
): TrainingWorkerNodeView => {
  const visibleWorker = applyTrainingWorkerAuthPresentation(worker);
  const nowMs = Date.now();
  const effectiveStatus = resolveWorkerEffectiveStatus(visibleWorker, nowMs);
  const inFlightJobs = getWorkerInFlightJobs(visibleWorker.id);
  const loadScore = computeWorkerLoadScore(visibleWorker);
  const healthPenalty = computeWorkerHealthPenalty(visibleWorker.id, nowMs);
  const health = getWorkerDispatchHealth(visibleWorker.id, nowMs);
  const cooldownActive =
    trainingWorkerFailureCooldownMs > 0 &&
    Boolean(health.last_failure_at) &&
    nowMs - (health.last_failure_at ?? 0) <= trainingWorkerFailureCooldownMs;
  const schedulerScore = Number(Math.max(0, loadScore + healthPenalty).toFixed(4));
  return {
    ...visibleWorker,
    effective_status: effectiveStatus,
    heartbeat_stale: visibleWorker.status === 'online' && effectiveStatus !== 'online',
    in_flight_jobs: inFlightJobs,
    load_score: loadScore,
    scheduler_score: schedulerScore,
    scheduler_load_component: loadScore,
    scheduler_health_penalty: healthPenalty,
    scheduler_capability_bonus: 0,
    dispatch_recent_failures: health.recent_failures,
    dispatch_consecutive_failures: health.consecutive_failures,
    dispatch_last_failure_at: health.last_failure_at ? new Date(health.last_failure_at).toISOString() : null,
    dispatch_last_success_at: health.last_success_at ? new Date(health.last_success_at).toISOString() : null,
    dispatch_cooldown_active: cooldownActive
  };
};

const applyBootstrapCallbackOutcome = (
  session: TrainingWorkerBootstrapSessionRecord,
  worker: TrainingWorkerNodeRecord | null,
  requestedStatus: TrainingWorkerNodeRecord['status'],
  validation: { ok: boolean; message: string; compatibility: TrainingWorkerCompatibilitySnapshot },
  endpoint: string | null
): void => {
  const checkedAt = now();
  session.claimed_at = session.claimed_at ?? checkedAt;
  session.last_seen_at = checkedAt;
  session.callback_checked_at = checkedAt;
  session.callback_validation_message = validation.message;
  session.compatibility = validation.compatibility;
  session.worker_endpoint_hint = endpoint ?? session.worker_endpoint_hint;
  if (worker) {
    session.linked_worker_id = worker.id;
    session.worker_name = worker.name.trim() || session.worker_name;
  }

  if (!validation.ok) {
    session.status = 'validation_failed';
    if (worker) {
      worker.status = 'offline';
      worker.updated_at = checkedAt;
    }
    markAppStateDirty();
    return;
  }

  if (requestedStatus === 'online') {
    session.status = 'online';
  } else {
    session.status = 'awaiting_confirmation';
    session.callback_validation_message = `Callback reachable, waiting for worker to report online status (current: ${requestedStatus}).`;
  }

  if (worker) {
    worker.status = requestedStatus;
    worker.updated_at = checkedAt;
  }
  markAppStateDirty();
};

const reconcileBootstrapSessionFromHeartbeat = async (
  worker: TrainingWorkerNodeRecord,
  requestedStatus: TrainingWorkerNodeRecord['status']
): Promise<void> => {
  cleanupExpiredBootstrapSessions();
  const session = trainingWorkerBootstrapSessions.find(
    (item) => item.worker_id === worker.id && item.status !== 'expired'
  );
  if (!session) {
    return;
  }

  const checkedAt = now();
  session.claimed_at = session.claimed_at ?? checkedAt;
  session.last_seen_at = checkedAt;
  session.linked_worker_id = worker.id;
  session.worker_name = worker.name.trim() || session.worker_name;
  session.worker_endpoint_hint = worker.endpoint ?? session.worker_endpoint_hint;

  if (!worker.endpoint) {
    session.status = 'awaiting_confirmation';
    session.callback_checked_at = checkedAt;
    session.callback_validation_message = 'Waiting for worker heartbeat to publish a callback endpoint.';
    session.compatibility = {
      status: 'unknown',
      message: 'Waiting for worker endpoint to run callback and compatibility checks.',
      expected_runtime_profile: session.worker_runtime_profile,
      reported_runtime_profile: null,
      reported_worker_version: null,
      reported_contract_version: null,
      missing_capabilities: []
    };
    worker.status = 'offline';
    worker.updated_at = checkedAt;
    markAppStateDirty();
    return;
  }

  const validation = await probeWorkerCallback(worker.endpoint, {
    expected_runtime_profile: session.worker_runtime_profile,
    expected_capabilities: session.capabilities
  });
  applyBootstrapCallbackOutcome(session, worker, requestedStatus, validation, worker.endpoint);
};

export async function listTrainingWorkerBootstrapSessionsByAdmin(): Promise<
  TrainingWorkerBootstrapSessionRecord[]
> {
  await delay(60);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can list training worker bootstrap sessions.');
  cleanupExpiredBootstrapSessions();
  return [...trainingWorkerBootstrapSessions]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((session) => applyBootstrapSessionAuthPresentation(session));
}

export async function createTrainingWorkerBootstrapSessionByAdmin(
  input: CreateTrainingWorkerBootstrapSessionInput
): Promise<TrainingWorkerBootstrapSessionRecord> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can create training worker bootstrap sessions.');

  cleanupExpiredBootstrapSessions();
  const deploymentMode = normalizeWorkerDeploymentMode(input.deployment_mode);
  const workerProfile = normalizeWorkerProfile(input.worker_profile);
  const controlPlaneBaseUrl = normalizeControlPlaneBaseUrl(input.control_plane_base_url);
  const maxConcurrency = normalizeWorkerConcurrency(input.max_concurrency);
  const requestedWorkerName =
    typeof input.worker_name === 'string' && input.worker_name.trim()
      ? input.worker_name.trim()
      : `${workerProfile}-worker-${randomBytes(2).toString('hex')}`;
  const workerNameSlug = toWorkerNameSlug(requestedWorkerName);
  const workerId = `tw-${workerNameSlug}-${randomBytes(2).toString('hex')}`;
  const pairingToken = `vtw_${randomBytes(12).toString('hex')}`;
  const workerRuntimeProfile = buildWorkerRuntimeProfile(workerProfile);
  const capabilities = buildWorkerProfileCapabilities(workerProfile);
  const dedicatedToken = issueDedicatedTrainingWorkerToken(workerId);

  const created: TrainingWorkerBootstrapSessionRecord = {
    id: nextId('twbs'),
    status: 'bootstrap_created',
    deployment_mode: deploymentMode,
    worker_profile: workerProfile,
    pairing_token: pairingToken,
    token_preview: buildBootstrapTokenPreview(pairingToken),
    control_plane_base_url: controlPlaneBaseUrl,
    worker_id: workerId,
    worker_name: requestedWorkerName,
    worker_public_host: null,
    worker_bind_port: 9090,
    worker_endpoint_hint: null,
    worker_runtime_profile: workerRuntimeProfile,
    capabilities,
    max_concurrency: maxConcurrency,
    issued_auth_mode: 'dedicated',
    issued_auth_token_preview: buildWorkerAuthTokenPreview(dedicatedToken),
    docker_command: '',
    script_command: '',
    setup_url_hint: 'http://<worker-host>:9090/setup',
    claimed_at: null,
    last_seen_at: null,
    callback_checked_at: null,
    callback_validation_message: null,
    compatibility: {
      status: 'unknown',
      message: 'Compatibility check has not run yet.',
      expected_runtime_profile: workerRuntimeProfile,
      reported_runtime_profile: null,
      reported_worker_version: null,
      reported_contract_version: null,
      missing_capabilities: []
    },
    linked_worker_id: null,
    metadata: {
      recommended_image: trainingWorkerRecommendedImage
    },
    created_at: now(),
    expires_at: new Date(Date.now() + trainingWorkerBootstrapTtlMs).toISOString()
  };

  const { workerPublicHost, workerBindPort } = normalizeWorkerPublicHostInput(
    (input as { worker_public_host?: unknown }).worker_public_host,
    (input as { worker_bind_port?: unknown }).worker_bind_port
  );
  created.worker_public_host = workerPublicHost;
  created.worker_bind_port = workerBindPort;
  created.worker_endpoint_hint = buildWorkerEndpointHint(workerPublicHost, workerBindPort);
  created.setup_url_hint = buildWorkerSetupUrlHint(workerPublicHost, workerBindPort);

  const commands = buildTrainingWorkerCommands(created);
  created.docker_command = commands.dockerCommand;
  created.script_command = commands.scriptCommand;

  trainingWorkerBootstrapSessions.unshift(created);
  markAppStateDirty();
  logAudit('training_worker_bootstrap_created', 'TrainingWorkerBootstrapSession', created.id, {
    deployment_mode: created.deployment_mode,
    worker_profile: created.worker_profile,
    worker_id: created.worker_id,
    auth_mode: created.issued_auth_mode
  });
  return applyBootstrapSessionAuthPresentation(created);
}

export async function claimTrainingWorkerBootstrapSession(
  input: ClaimTrainingWorkerBootstrapSessionInput
): Promise<ClaimTrainingWorkerBootstrapSessionResult> {
  await delay(40);
  cleanupExpiredBootstrapSessions();

  const pairingToken = input.pairing_token?.trim();
  if (!pairingToken) {
    throw new Error('Pairing token is required.');
  }

  const session = findBootstrapSessionByPairingToken(pairingToken);
  if (!session || session.status === 'expired') {
    throw new Error('Pairing token is invalid or expired.');
  }

  session.status = 'pairing';
  session.claimed_at = session.claimed_at ?? now();
  session.last_seen_at = now();
  const dedicatedToken = issueDedicatedTrainingWorkerToken(session.worker_id);
  session.issued_auth_mode = 'dedicated';
  session.issued_auth_token_preview = buildWorkerAuthTokenPreview(dedicatedToken);
  markAppStateDirty();

  return {
    bootstrap_session: applyBootstrapSessionAuthPresentation(session),
    config_defaults: {
      control_plane_base_url: session.control_plane_base_url,
      training_worker_auth_token: dedicatedToken,
      worker_id: session.worker_id,
      worker_name: session.worker_name,
      worker_endpoint: session.worker_endpoint_hint ?? '',
      worker_status: 'online',
      worker_enabled: 'true',
      worker_max_concurrency: String(session.max_concurrency),
      worker_capabilities: session.capabilities.join(','),
      heartbeat_interval_seconds: '15',
      worker_runtime_profile: session.worker_runtime_profile,
      worker_use_request_paths: 'false',
      worker_command_failure_mode: 'fallback',
      worker_disable_command: 'false'
    }
  };
}

export async function getTrainingWorkerBootstrapSessionStatus(
  input: GetTrainingWorkerBootstrapSessionStatusInput
): Promise<TrainingWorkerBootstrapSessionRecord> {
  await delay(30);
  cleanupExpiredBootstrapSessions();

  const pairingToken = input.pairing_token?.trim();
  if (!pairingToken) {
    throw new Error('Pairing token is required.');
  }

  const session = findBootstrapSessionByPairingToken(pairingToken);
  if (!session || session.status === 'expired') {
    throw new Error('Pairing token is invalid or expired.');
  }

  return applyBootstrapSessionAuthPresentation(session);
}

export async function validateTrainingWorkerBootstrapCallbackByAdmin(
  sessionId: string
): Promise<TrainingWorkerBootstrapSessionRecord> {
  await delay(40);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can validate training worker bootstrap sessions.');
  cleanupExpiredBootstrapSessions();

  const session = findBootstrapSessionById(sessionId);
  if (!session) {
    throw new Error('Training worker bootstrap session not found.');
  }
  if (session.status === 'expired') {
    throw new Error('Pairing token is invalid or expired.');
  }

  const worker =
    (session.linked_worker_id
      ? trainingWorkerNodes.find((item) => item.id === session.linked_worker_id) ?? null
      : trainingWorkerNodes.find((item) => item.id === session.worker_id) ?? null) ?? null;
  const endpoint = worker?.endpoint ?? session.worker_endpoint_hint;

  if (!endpoint) {
    session.status = 'awaiting_confirmation';
    session.callback_checked_at = now();
    session.callback_validation_message =
      'Waiting for worker callback endpoint. Start the worker and complete local /setup first.';
    session.compatibility = {
      status: 'unknown',
      message: 'Waiting for worker endpoint to run callback and compatibility checks.',
      expected_runtime_profile: session.worker_runtime_profile,
      reported_runtime_profile: null,
      reported_worker_version: null,
      reported_contract_version: null,
      missing_capabilities: []
    };
    markAppStateDirty();
    return applyBootstrapSessionAuthPresentation(session);
  }

  const requestedStatus = worker && worker.status === 'offline' ? 'online' : worker?.status ?? 'online';
  const validation = await probeWorkerCallback(endpoint, {
    expected_runtime_profile: session.worker_runtime_profile,
    expected_capabilities: session.capabilities
  });
  applyBootstrapCallbackOutcome(session, worker, requestedStatus, validation, endpoint);
  return applyBootstrapSessionAuthPresentation(session);
}

export async function activateTrainingWorkerByAdmin(
  workerId: string
): Promise<ActivateTrainingWorkerResult> {
  await delay(40);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can activate training workers.');
  cleanupExpiredBootstrapSessions();

  const worker = trainingWorkerNodes.find((item) => item.id === workerId);
  if (!worker) {
    throw new Error('Training worker not found.');
  }

  const session = findLatestBootstrapSessionByWorkerId(worker.id);
  const endpoint = worker.endpoint ?? session?.worker_endpoint_hint ?? null;
  if (!endpoint) {
    if (session) {
      session.compatibility = {
        status: 'incompatible',
        message: 'Worker endpoint is missing; callback validation cannot run.',
        expected_runtime_profile: session.worker_runtime_profile,
        reported_runtime_profile: null,
        reported_worker_version: null,
        reported_contract_version: null,
        missing_capabilities: []
      };
      session.callback_checked_at = now();
      session.callback_validation_message = 'Worker endpoint is missing; callback validation cannot run.';
      markAppStateDirty();
    }
    throw new Error('Worker endpoint is missing; callback validation cannot run.');
  }

  const checkedAt = now();
  const validation = await probeWorkerCallback(endpoint, {
    expected_runtime_profile: session?.worker_runtime_profile ?? null,
    expected_capabilities: session?.capabilities ?? worker.capabilities
  });
  if (!validation.ok) {
    worker.status = 'offline';
    worker.updated_at = checkedAt;
    if (session) {
      session.status = 'validation_failed';
      session.claimed_at = session.claimed_at ?? checkedAt;
      session.last_seen_at = checkedAt;
      session.callback_checked_at = checkedAt;
      session.callback_validation_message = validation.message;
      session.compatibility = validation.compatibility;
      session.worker_endpoint_hint = endpoint;
      session.linked_worker_id = worker.id;
      session.worker_name = worker.name.trim() || session.worker_name;
    }
    markAppStateDirty();
    throw new Error(validation.message);
  }

  const previousStatus = worker.status;
  worker.endpoint = endpoint;
  worker.status = 'online';
  worker.updated_at = checkedAt;
  if (session) {
    session.status = 'online';
    session.claimed_at = session.claimed_at ?? checkedAt;
    session.last_seen_at = checkedAt;
    session.callback_checked_at = checkedAt;
    session.callback_validation_message = `Activated by admin after callback validation: ${validation.message}`;
    session.compatibility = validation.compatibility;
    session.worker_endpoint_hint = endpoint;
    session.linked_worker_id = worker.id;
    session.worker_name = worker.name.trim() || session.worker_name;
  }
  markAppStateDirty();

  logAudit('training_worker_activated', 'TrainingWorkerNode', worker.id, {
    endpoint,
    previous_status: previousStatus
  });

  return {
    worker: serializeTrainingWorker(worker),
    bootstrap_session: session ? applyBootstrapSessionAuthPresentation(session) : null
  };
}

export async function createTrainingWorkerReconfigureSessionByAdmin(
  workerId: string
): Promise<TrainingWorkerBootstrapSessionRecord> {
  await delay(60);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can create training worker reconfigure sessions.');
  cleanupExpiredBootstrapSessions();

  const worker = trainingWorkerNodes.find((item) => item.id === workerId);
  if (!worker) {
    throw new Error('Training worker not found.');
  }

  const workerProfile = inferWorkerProfileFromCapabilities(worker.capabilities);
  const workerRuntimeProfile = buildWorkerRuntimeProfile(workerProfile);
  const maxConcurrency = normalizeWorkerConcurrency(worker.max_concurrency);
  const pairingToken = `vtw_${randomBytes(12).toString('hex')}`;
  const dedicatedToken = issueDedicatedTrainingWorkerToken(worker.id);
  const fallbackCapabilities = buildWorkerProfileCapabilities(workerProfile);
  const capabilities =
    worker.capabilities.length > 0 ? normalizeWorkerCapabilities(worker.capabilities) : fallbackCapabilities;
  const { workerPublicHost, workerBindPort } = parseWorkerPublicHostAndPortFromEndpoint(worker.endpoint);
  const endpointHint =
    worker.endpoint ??
    buildWorkerEndpointHint(workerPublicHost, workerBindPort) ??
    buildWorkerEndpointHint(null, workerBindPort);

  const created: TrainingWorkerBootstrapSessionRecord = {
    id: nextId('twbs'),
    status: 'bootstrap_created',
    deployment_mode: 'docker',
    worker_profile: workerProfile,
    pairing_token: pairingToken,
    token_preview: buildBootstrapTokenPreview(pairingToken),
    control_plane_base_url: resolveControlPlaneBaseUrlForWorkerReconfigure(worker.id),
    worker_id: worker.id,
    worker_name: worker.name,
    worker_public_host: workerPublicHost,
    worker_bind_port: workerBindPort,
    worker_endpoint_hint: endpointHint,
    worker_runtime_profile: workerRuntimeProfile,
    capabilities,
    max_concurrency: maxConcurrency,
    issued_auth_mode: 'dedicated',
    issued_auth_token_preview: buildWorkerAuthTokenPreview(dedicatedToken),
    docker_command: '',
    script_command: '',
    setup_url_hint: buildWorkerSetupUrlHint(workerPublicHost, workerBindPort),
    claimed_at: null,
    last_seen_at: null,
    callback_checked_at: null,
    callback_validation_message: `Reconfigure session created from existing worker ${worker.id}.`,
    compatibility: {
      status: 'unknown',
      message: 'Compatibility check has not run yet.',
      expected_runtime_profile: workerRuntimeProfile,
      reported_runtime_profile: null,
      reported_worker_version: null,
      reported_contract_version: null,
      missing_capabilities: []
    },
    linked_worker_id: worker.id,
    metadata: {
      recommended_image: trainingWorkerRecommendedImage,
      source: 'reconfigure'
    },
    created_at: now(),
    expires_at: new Date(Date.now() + trainingWorkerBootstrapTtlMs).toISOString()
  };

  const commands = buildTrainingWorkerCommands(created);
  created.docker_command = commands.dockerCommand;
  created.script_command = commands.scriptCommand;

  trainingWorkerBootstrapSessions.unshift(created);
  markAppStateDirty();
  logAudit('training_worker_reconfigure_session_created', 'TrainingWorkerBootstrapSession', created.id, {
    worker_id: worker.id,
    worker_profile: created.worker_profile,
    deployment_mode: created.deployment_mode
  });

  return applyBootstrapSessionAuthPresentation(created);
}

export async function downloadTrainingWorkerBootstrapBundleByAdmin(
  sessionId: string
): Promise<{ filename: string; content: string }> {
  await delay(30);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can download training worker bootstrap bundles.');
  cleanupExpiredBootstrapSessions();

  const session = findBootstrapSessionById(sessionId);
  if (!session) {
    throw new Error('Training worker bootstrap session not found.');
  }

  return buildTrainingWorkerBootstrapBundle(session);
}

export async function listTrainingWorkersByAdmin(): Promise<TrainingWorkerNodeView[]> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can list training workers.');
  return trainingWorkerNodes
    .map(serializeTrainingWorker)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function createTrainingWorkerByAdmin(
  input: CreateTrainingWorkerInput
): Promise<TrainingWorkerNodeView> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can create training workers.');

  const name = (input.name ?? '').trim();
  if (!name) {
    throw new Error('Worker name is required.');
  }

  const endpoint = normalizeWorkerEndpoint(input.endpoint);
  if (endpoint && trainingWorkerNodes.some((worker) => worker.endpoint === endpoint)) {
    throw new Error('Training worker endpoint already exists.');
  }

  const created: TrainingWorkerNodeRecord = {
    id: nextId('tw'),
    name,
    endpoint,
    status: normalizeWorkerStatus(input.status),
    enabled: input.enabled ?? true,
    max_concurrency: normalizeWorkerConcurrency(input.max_concurrency),
    last_heartbeat_at: null,
    last_reported_load: null,
    capabilities: normalizeWorkerCapabilities(input.capabilities),
    auth_mode: 'shared',
    auth_token_preview: null,
    registration_source: 'admin',
    metadata: normalizeWorkerMetadata(input.metadata),
    created_at: now(),
    updated_at: now()
  };

  trainingWorkerNodes.unshift(created);
  markAppStateDirty();
  logAudit('training_worker_created', 'TrainingWorkerNode', created.id, {
    endpoint: created.endpoint ?? '',
    status: created.status,
    max_concurrency: String(created.max_concurrency)
  });
  return serializeTrainingWorker(created);
}

export async function updateTrainingWorkerByAdmin(
  workerId: string,
  input: UpdateTrainingWorkerInput
): Promise<TrainingWorkerNodeView> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can update training workers.');

  const worker = trainingWorkerNodes.find((item) => item.id === workerId);
  if (!worker) {
    throw new Error('Training worker not found.');
  }

  if (input.name !== undefined) {
    const normalized = input.name.trim();
    if (!normalized) {
      throw new Error('Worker name cannot be empty.');
    }
    worker.name = normalized;
  }

  if (input.endpoint !== undefined) {
    const endpoint = normalizeWorkerEndpoint(input.endpoint);
    if (
      endpoint &&
      trainingWorkerNodes.some((item) => item.id !== worker.id && item.endpoint === endpoint)
    ) {
      throw new Error('Training worker endpoint already exists.');
    }
    worker.endpoint = endpoint;
  }

  if (input.status !== undefined) {
    worker.status = normalizeWorkerStatus(input.status);
  }
  if (input.enabled !== undefined) {
    worker.enabled = Boolean(input.enabled);
  }
  if (input.max_concurrency !== undefined) {
    worker.max_concurrency = normalizeWorkerConcurrency(input.max_concurrency);
  }
  if (input.capabilities !== undefined) {
    worker.capabilities = normalizeWorkerCapabilities(input.capabilities);
  }
  if (input.metadata !== undefined) {
    worker.metadata = normalizeWorkerMetadata(input.metadata);
  }
  worker.auth_mode = resolveTrainingWorkerAuthMode(worker.id);
  worker.auth_token_preview = resolveTrainingWorkerAuthTokenPreview(worker.id);

  worker.updated_at = now();
  markAppStateDirty();
  logAudit('training_worker_updated', 'TrainingWorkerNode', worker.id, {
    endpoint: worker.endpoint ?? '',
    status: worker.status,
    enabled: String(worker.enabled),
    max_concurrency: String(worker.max_concurrency)
  });
  return serializeTrainingWorker(worker);
}

export async function removeTrainingWorkerByAdmin(workerId: string): Promise<{ removed: true }> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can remove training workers.');

  const workerIndex = trainingWorkerNodes.findIndex((item) => item.id === workerId);
  if (workerIndex < 0) {
    throw new Error('Training worker not found.');
  }

  const inFlightJobs = getWorkerInFlightJobs(workerId);
  if (inFlightJobs > 0) {
    throw new Error('Cannot remove worker with in-flight training jobs.');
  }

  const [removed] = trainingWorkerNodes.splice(workerIndex, 1);
  if (removed?.id) {
    trainingWorkerDispatchHealthById.delete(removed.id);
    revokeDedicatedTrainingWorkerToken(removed.id);
  }
  markAppStateDirty();
  logAudit('training_worker_removed', 'TrainingWorkerNode', removed?.id ?? null, {
    endpoint: removed?.endpoint ?? ''
  });
  return { removed: true };
}

export async function heartbeatTrainingWorker(
  input: TrainingWorkerHeartbeatInput,
  presentedToken?: string | null
): Promise<TrainingWorkerNodeView> {
  await delay(30);
  const name = (input.name ?? '').trim();
  if (!name) {
    throw new Error('Worker name is required.');
  }

  const workerId = input.worker_id?.trim() ?? '';
  const endpoint = normalizeWorkerEndpoint(input.endpoint);
  assertTrainingWorkerHeartbeatToken({
    token: presentedToken,
    worker_id: workerId,
    endpoint
  });
  const byId = workerId ? trainingWorkerNodes.find((worker) => worker.id === workerId) : null;
  const byEndpoint = endpoint
    ? trainingWorkerNodes.find((worker) => worker.endpoint === endpoint)
    : null;
  const target = byId ?? byEndpoint;

  const nowAt = now();
  if (!target) {
    const created: TrainingWorkerNodeRecord = {
      id: workerId || nextId('tw'),
      name,
      endpoint,
      status: normalizeWorkerStatus(input.status ?? 'online'),
      enabled: input.enabled ?? true,
      max_concurrency: normalizeWorkerConcurrency(input.max_concurrency ?? 1),
      last_heartbeat_at: nowAt,
      last_reported_load: normalizeWorkerReportedLoad(input.reported_load),
      capabilities: normalizeWorkerCapabilities(input.capabilities),
      auth_mode: resolveTrainingWorkerAuthMode(workerId || null),
      auth_token_preview: resolveTrainingWorkerAuthTokenPreview(workerId || null),
      registration_source: 'heartbeat',
      metadata: normalizeWorkerMetadata(input.metadata),
      created_at: nowAt,
      updated_at: nowAt
    };
    trainingWorkerNodes.unshift(created);
    await reconcileBootstrapSessionFromHeartbeat(created, normalizeWorkerStatus(input.status ?? 'online'));
    markAppStateDirty();
    return serializeTrainingWorker(created);
  }

  target.name = name;
  target.endpoint = endpoint;
  target.status = normalizeWorkerStatus(input.status ?? target.status);
  target.enabled = input.enabled ?? target.enabled;
  target.max_concurrency = normalizeWorkerConcurrency(input.max_concurrency ?? target.max_concurrency);
  target.last_heartbeat_at = nowAt;
  target.last_reported_load = normalizeWorkerReportedLoad(input.reported_load);
  target.capabilities = normalizeWorkerCapabilities(input.capabilities ?? target.capabilities);
  target.auth_mode = resolveTrainingWorkerAuthMode(target.id);
  target.auth_token_preview = resolveTrainingWorkerAuthTokenPreview(target.id);
  target.metadata = normalizeWorkerMetadata(input.metadata ?? target.metadata);
  target.updated_at = nowAt;
  if (target.registration_source === 'seed') {
    target.registration_source = 'heartbeat';
  }
  await reconcileBootstrapSessionFromHeartbeat(target, normalizeWorkerStatus(input.status ?? target.status));
  markAppStateDirty();
  return serializeTrainingWorker(target);
}

export async function getTrainingWorkerDatasetPackageContent(
  packageId: string,
  presentedToken?: string | null
): Promise<WorkerInlineDatasetPackage> {
  await delay(10);
  const record = await readTrainingWorkerDatasetPackageById(packageId);
  assertTrainingWorkerHeartbeatToken({
    token: presentedToken,
    worker_id: record.authorized_worker_id
  });
  let payload: unknown;
  try {
    const raw = await fs.readFile(record.file_path, 'utf8');
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Training worker dataset package content is unavailable.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Training worker dataset package payload is invalid.');
  }
  const packagePayload = payload as WorkerInlineDatasetPackage;
  if (
    packagePayload.format !== 'inline_base64_v1' ||
    !Array.isArray(packagePayload.files) ||
    typeof packagePayload.root_relative !== 'string'
  ) {
    throw new Error('Training worker dataset package payload is invalid.');
  }
  return packagePayload;
}

export async function getRuntimeMetricsRetentionSummary(): Promise<{
  max_points_per_job: number;
  max_total_rows: number;
  current_total_rows: number;
  visible_job_count: number;
  jobs_with_metrics: number;
  max_rows_single_job: number;
  near_total_cap: boolean;
  top_jobs: Array<{ training_job_id: string; rows: number }>;
}> {
  await delay(80);
  const currentUser = findCurrentUser();
  const visibleJobs = getVisibleTrainingJobsForUser(currentUser);
  const visibleJobIds = new Set(visibleJobs.map((job) => job.id));
  const visibleMetrics = trainingMetrics.filter((metric) => visibleJobIds.has(metric.training_job_id));

  const rowsByJob = new Map<string, number>();
  visibleMetrics.forEach((metric) => {
    rowsByJob.set(metric.training_job_id, (rowsByJob.get(metric.training_job_id) ?? 0) + 1);
  });

  const topJobs = Array.from(rowsByJob.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([training_job_id, rows]) => ({ training_job_id, rows }));

  const maxRowsSingleJob = topJobs.length > 0 ? topJobs[0]?.rows ?? 0 : 0;

  return {
    max_points_per_job: trainingMetricsMaxPointsPerJob,
    max_total_rows: trainingMetricsMaxTotalRows,
    current_total_rows: visibleMetrics.length,
    visible_job_count: visibleJobs.length,
    jobs_with_metrics: rowsByJob.size,
    max_rows_single_job: maxRowsSingleJob,
    near_total_cap: visibleMetrics.length >= Math.floor(trainingMetricsMaxTotalRows * 0.85),
    top_jobs: topJobs
  };
}

const normalizeRuntimeMetricsRetentionSummary = (
  value: unknown
): RuntimeMetricsRetentionSummary | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const maxPointsPerJob = Number(payload.max_points_per_job);
  const maxTotalRows = Number(payload.max_total_rows);
  const currentTotalRows = Number(payload.current_total_rows);
  const visibleJobCount = Number(payload.visible_job_count);
  const jobsWithMetrics = Number(payload.jobs_with_metrics);
  const maxRowsSingleJob = Number(payload.max_rows_single_job);
  const nearTotalCap = Boolean(payload.near_total_cap);

  if (
    !Number.isFinite(maxPointsPerJob) ||
    !Number.isFinite(maxTotalRows) ||
    !Number.isFinite(currentTotalRows) ||
    !Number.isFinite(visibleJobCount) ||
    !Number.isFinite(jobsWithMetrics) ||
    !Number.isFinite(maxRowsSingleJob)
  ) {
    return null;
  }

  const topJobs = Array.isArray(payload.top_jobs)
    ? payload.top_jobs
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null;
          }
          const item = entry as Record<string, unknown>;
          const trainingJobId = typeof item.training_job_id === 'string' ? item.training_job_id : '';
          const rows = Number(item.rows);
          if (!trainingJobId || !Number.isFinite(rows)) {
            return null;
          }
          return {
            training_job_id: trainingJobId,
            rows
          };
        })
        .filter(
          (entry): entry is { training_job_id: string; rows: number } => Boolean(entry)
        )
    : [];

  return {
    max_points_per_job: maxPointsPerJob,
    max_total_rows: maxTotalRows,
    current_total_rows: currentTotalRows,
    visible_job_count: visibleJobCount,
    jobs_with_metrics: jobsWithMetrics,
    max_rows_single_job: maxRowsSingleJob,
    near_total_cap: nearTotalCap,
    top_jobs: topJobs
  };
};

export async function draftTaskFromRequirement(input: {
  description: string;
}): Promise<RequirementTaskDraft> {
  await delay(80);
  const description = input.description.trim();
  if (description.length < 4) {
    throw new Error('Requirement description is too short.');
  }

  const currentUser = findCurrentUser();
  const llmConfig = getStoredLlmConfigByUser(currentUser.id);
  const ruleDraft = buildRuleBasedTaskDraft(description);

  if (!llmConfig.enabled || !llmConfig.api_key.trim()) {
    return ruleDraft;
  }

  try {
    const llmDraft = await generateTaskDraftFromLlm(description, llmConfig);
    if (!llmDraft) {
      return ruleDraft;
    }

    return {
      ...ruleDraft,
      ...llmDraft,
      recommended_annotation_type:
        llmDraft.recommended_annotation_type || ruleDraft.recommended_annotation_type,
      annotation_type:
        llmDraft.recommended_annotation_type ||
        llmDraft.annotation_type ||
        ruleDraft.recommended_annotation_type,
      label_hints:
        llmDraft.label_hints.length > 0 ? llmDraft.label_hints : ruleDraft.label_hints,
      dataset_suggestions:
        llmDraft.dataset_suggestions.length > 0
          ? llmDraft.dataset_suggestions
          : ruleDraft.dataset_suggestions,
      evaluation_metric_suggestions:
        llmDraft.evaluation_metric_suggestions.length > 0
          ? llmDraft.evaluation_metric_suggestions
          : ruleDraft.evaluation_metric_suggestions,
      source: 'llm'
    };
  } catch {
    return ruleDraft;
  }
}

export async function createTrainingJob(input: CreateTrainingJobInput): Promise<TrainingJobRecord> {
  await delay(120);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(input.dataset_id, currentUser);
  const datasetVersionId = input.dataset_version_id?.trim() ?? '';

  if (dataset.task_type !== input.task_type) {
    throw new Error('Dataset task_type does not match training task_type.');
  }

  if (!datasetVersionId) {
    throw new Error('Dataset version is required for new training jobs.');
  }

  if (dataset.status !== 'ready') {
    throw new Error('Selected dataset must be ready before creating a training job.');
  }

  const datasetVersion = datasetVersions.find(
    (version) => version.id === datasetVersionId && version.dataset_id === dataset.id
  );
  if (!datasetVersion) {
    throw new Error('Dataset version not found for selected dataset.');
  }

  if (datasetVersion.split_summary.train <= 0) {
    throw new Error('Selected dataset version must include at least one train split item.');
  }

  if (datasetVersion.annotation_coverage <= 0) {
    throw new Error('Selected dataset version must include annotation coverage before launch.');
  }

  const trainer = getTrainerByFramework(input.framework);
  const validation = await trainer.validate_dataset({
    datasetId: dataset.id,
    taskType: input.task_type
  });

  if (!validation.valid) {
    throw new Error(validation.warnings[0] ?? 'Dataset validation failed for selected framework.');
  }

  const scheduling = selectTrainingWorkerForJob(input.task_type, input.framework, {
    trigger: 'create',
    attempt: 1
  });

  const created: TrainingJobRecord = {
    id: nextId('tj'),
    name: input.name.trim(),
    task_type: input.task_type,
    framework: input.framework,
    status: 'draft',
    dataset_id: dataset.id,
    dataset_version_id: datasetVersion.id,
    base_model: input.base_model.trim(),
    config: input.config,
    execution_mode: 'unknown',
    execution_target: scheduling.execution_target,
    scheduled_worker_id: scheduling.worker?.id ?? null,
    scheduler_note: scheduling.note,
    scheduler_decision: null,
    scheduler_decision_history: [],
    log_excerpt:
      scheduling.execution_target === 'worker'
        ? 'Queued with worker scheduling.'
        : 'Queued for control-plane local execution.',
    submitted_by: currentUser.id,
    created_at: now(),
    updated_at: now()
  };

  recordTrainingSchedulerDecision(created, scheduling.decision);

  created.status = 'queued';
  created.updated_at = now();

  trainingJobs.unshift(created);
  logAudit('training_job_created', 'TrainingJob', created.id, {
    framework: created.framework,
    task_type: created.task_type,
    dataset_version_id: created.dataset_version_id ?? '',
    execution_target: created.execution_target,
    scheduled_worker_id: created.scheduled_worker_id ?? '',
    scheduler_note: created.scheduler_note ?? '',
    scheduler_decision_trigger: created.scheduler_decision?.trigger ?? '',
    scheduler_decision_attempt: String(created.scheduler_decision?.attempt ?? '')
  });

  scheduleTrainingLifecycle(created.id);
  return created;
}

export async function getTrainingJobDetail(jobId: string): Promise<{
  job: TrainingJobRecord;
  metrics: TrainingMetricRecord[];
  logs: string[];
  artifact_attachment_id: string | null;
  artifact_summary: TrainingArtifactSummary | null;
  workspace_dir: string | null;
}> {
  await delay(100);
  const currentUser = findCurrentUser();

  const job = trainingJobs.find((item) => item.id === jobId);
  if (!job) {
    throw new Error('Training job not found.');
  }

  const dataset = assertDatasetAccess(job.dataset_id, currentUser);
  assertOwnershipOrAdmin(dataset.owner_user_id, currentUser, 'No permission to access this training job.');
  const runtime = getTrainingRuntime(job.id);
  const logs = await resolveTrainingLogs(job);
  const artifactAttachmentId = findArtifactAttachmentIdByJob(job.id);
  const artifactAttachment = artifactAttachmentId
    ? attachments.find((item) => item.id === artifactAttachmentId) ?? null
    : null;
  const artifactSummary = artifactAttachment
    ? await readTrainingArtifactSummary(artifactAttachment)
    : null;

  return {
    job,
    metrics: trainingMetrics.filter((metric) => metric.training_job_id === job.id),
    logs,
    artifact_attachment_id: artifactAttachmentId,
    artifact_summary: artifactSummary,
    workspace_dir: runtime?.workspace_dir ?? null
  };
}

const resolveTrainingJobMetricsExportContext = (
  jobId: string,
  currentUser: User
): { job: TrainingJobRecord; metrics: TrainingMetricRecord[] } => {
  const job = trainingJobs.find((item) => item.id === jobId);
  if (!job) {
    throw new Error('Training job not found.');
  }

  const dataset = assertDatasetAccess(job.dataset_id, currentUser);
  assertOwnershipOrAdmin(dataset.owner_user_id, currentUser, 'No permission to access this training job.');

  const metrics = trainingMetrics
    .filter((metric) => metric.training_job_id === job.id)
    .sort((left, right) =>
      left.step === right.step
        ? left.metric_name.localeCompare(right.metric_name)
        : left.step - right.step
    );
  return { job, metrics };
};

const buildTrainingMetricsExportPayload = (
  jobId: string,
  metrics: TrainingMetricRecord[]
): TrainingMetricsExport => {
  const metricsByName = metrics.reduce<Record<string, Array<{ step: number; value: number; recorded_at: string }>>>(
    (acc, metric) => {
      const list = acc[metric.metric_name] ?? [];
      list.push({
        step: metric.step,
        value: metric.metric_value,
        recorded_at: metric.recorded_at
      });
      acc[metric.metric_name] = list;
      return acc;
    },
    {}
  );

  return {
    job_id: jobId,
    exported_at: now(),
    total_rows: metrics.length,
    latest_metrics: pickLatestMetrics(metrics),
    metrics_by_name: metricsByName
  };
};

const toCsvCell = (value: string | number): string => {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
};

const buildTrainingMetricsCsv = (jobId: string, metrics: TrainingMetricRecord[]): string => {
  const header = ['training_job_id', 'metric_name', 'step', 'metric_value', 'recorded_at'];
  const lines = [header.join(',')];
  metrics.forEach((metric) => {
    lines.push(
      [
        toCsvCell(jobId),
        toCsvCell(metric.metric_name),
        toCsvCell(metric.step),
        toCsvCell(metric.metric_value),
        toCsvCell(metric.recorded_at)
      ].join(',')
    );
  });
  return lines.join('\n');
};

export async function exportTrainingJobMetrics(jobId: string): Promise<TrainingMetricsExport> {
  await delay(80);
  const currentUser = findCurrentUser();
  const { job, metrics } = resolveTrainingJobMetricsExportContext(jobId, currentUser);
  return buildTrainingMetricsExportPayload(job.id, metrics);
}

export async function exportTrainingJobMetricsCsv(jobId: string): Promise<{
  filename: string;
  content: string;
}> {
  await delay(60);
  const currentUser = findCurrentUser();
  const { job, metrics } = resolveTrainingJobMetricsExportContext(jobId, currentUser);
  return {
    filename: `training-metrics-${job.id}.csv`,
    content: buildTrainingMetricsCsv(job.id, metrics)
  };
}

export async function cancelTrainingJob(jobId: string): Promise<TrainingJobRecord> {
  await delay(100);
  const currentUser = findCurrentUser();

  const job = trainingJobs.find((item) => item.id === jobId);
  if (!job) {
    throw new Error('Training job not found.');
  }

  const dataset = assertDatasetAccess(job.dataset_id, currentUser);
  assertOwnershipOrAdmin(dataset.owner_user_id, currentUser, 'No permission to cancel this training job.');

  if (!['queued', 'preparing', 'running'].includes(job.status)) {
    throw new Error('Only queued/preparing/running job can be cancelled.');
  }

  const runtime = getTrainingRuntime(job.id);
  if (runtime) {
    runtime.cancelled = true;
    trainingRuntimeByJobId.set(job.id, runtime);
    await appendTrainingLog(job, runtime, 'Cancellation requested by user.');
  }

  const dispatchAbortController = trainingWorkerDispatchAbortByJobId.get(job.id);
  if (dispatchAbortController) {
    dispatchAbortController.abort('cancelled_by_user');
    trainingWorkerDispatchAbortByJobId.delete(job.id);
    if (runtime) {
      await appendTrainingLog(job, runtime, 'In-flight worker dispatch aborted by cancel request.');
    }
  }

  if (job.execution_target === 'worker' && job.scheduled_worker_id) {
    const worker = trainingWorkerNodes.find((item) => item.id === job.scheduled_worker_id) ?? null;
    if (worker?.endpoint) {
      const cancelResult = await requestWorkerTrainingCancel(worker, job.id);
      if (runtime) {
        await appendTrainingLog(
          job,
          runtime,
          `Worker cancel request: acknowledged=${cancelResult.acknowledged}; had_running_process=${cancelResult.had_running_process}; message=${cancelResult.message}`
        );
      }
    }
  }

  job.status = 'cancelled';
  job.log_excerpt = 'Cancelled by user.';
  job.updated_at = now();
  logAudit('training_job_cancelled', 'TrainingJob', job.id);
  return job;
}

export async function retryTrainingJob(jobId: string): Promise<TrainingJobRecord> {
  await delay(100);
  const currentUser = findCurrentUser();

  const job = trainingJobs.find((item) => item.id === jobId);
  if (!job) {
    throw new Error('Training job not found.');
  }

  const dataset = assertDatasetAccess(job.dataset_id, currentUser);
  assertOwnershipOrAdmin(dataset.owner_user_id, currentUser, 'No permission to retry this training job.');

  if (!['failed', 'cancelled'].includes(job.status)) {
    throw new Error('Only failed/cancelled job can be retried.');
  }

  const runtime = getTrainingRuntime(job.id);
  if (runtime) {
    runtime.cancelled = true;
    trainingRuntimeByJobId.set(job.id, runtime);
  }
  const dispatchAbortController = trainingWorkerDispatchAbortByJobId.get(job.id);
  if (dispatchAbortController) {
    dispatchAbortController.abort('cancelled_by_retry');
    trainingWorkerDispatchAbortByJobId.delete(job.id);
  }

  const scheduling = selectTrainingWorkerForJob(job.task_type, job.framework, {
    trigger: 'retry',
    attempt: 1
  });
  job.status = 'queued';
  job.execution_mode = 'unknown';
  job.execution_target = scheduling.execution_target;
  job.scheduled_worker_id = scheduling.worker?.id ?? null;
  job.scheduler_note = `retry:${scheduling.note}`;
  recordTrainingSchedulerDecision(job, scheduling.decision);
  job.log_excerpt = 'Retry requested. Re-queueing with scheduler.';
  job.updated_at = now();
  logAudit('training_job_retried', 'TrainingJob', job.id);
  scheduleTrainingLifecycle(job.id);
  return job;
}

export async function listModelVersions(): Promise<ModelVersionRecord[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  return getModelVersionsVisibleToUser(currentUser);
}

export async function getModelVersion(versionId: string): Promise<ModelVersionRecord> {
  await delay(100);
  const currentUser = findCurrentUser();
  return assertModelVersionAccess(versionId, currentUser);
}

export async function registerModelVersion(
  input: RegisterModelVersionInput
): Promise<ModelVersionRecord> {
  await delay(120);
  const currentUser = findCurrentUser();
  const model = assertModelAccess(input.model_id, currentUser);
  assertOwnershipOrAdmin(model.owner_user_id, currentUser, 'No permission to register model version.');

  const job = trainingJobs.find((item) => item.id === input.training_job_id);
  if (!job) {
    throw new Error('Training job not found.');
  }

  if (job.status !== 'completed') {
    throw new Error('Only completed training jobs can register model versions.');
  }

  if (job.execution_mode !== 'local_command') {
    throw new Error(
      `Model version registration requires execution_mode=local_command; received ${job.execution_mode}.`
    );
  }

  const metrics = trainingMetrics.filter((item) => item.training_job_id === job.id);
  const numericMetrics = pickLatestMetrics(metrics);
  const artifactAttachment = await ensureTrainingArtifactAttachment(job, numericMetrics);
  const artifactSummary = await readTrainingArtifactSummary(artifactAttachment);
  const artifactMode = toOptionalTrimmedString(artifactSummary?.mode)?.toLowerCase() ?? null;
  const artifactFallbackReason = toOptionalTrimmedString(artifactSummary?.fallback_reason);
  const artifactTrainingPerformed = artifactSummary?.training_performed ?? null;
  const localExecutionLooksNonReal =
    artifactMode === 'template' ||
    Boolean(artifactFallbackReason) ||
    artifactTrainingPerformed === false;

  if (localExecutionLooksNonReal && !allowNonRealLocalCommandModelVersionRegistration) {
    const modeLabel = artifactMode ?? 'unknown';
    const fallbackLabel = artifactFallbackReason ?? 'none';
    const trainingPerformedLabel =
      artifactTrainingPerformed === null ? 'unknown' : artifactTrainingPerformed ? 'true' : 'false';
    throw new Error(
      `Model version registration rejected for non-real local execution evidence (mode=${modeLabel}, fallback_reason=${fallbackLabel}, training_performed=${trainingPerformedLabel}). Set MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1 only for explicit non-production compatibility.`
    );
  }

  artifactAttachment.attached_to_type = 'Model';
  artifactAttachment.attached_to_id = model.id;
  artifactAttachment.updated_at = now();

  trainingArtifactAttachmentByJobId.set(job.id, artifactAttachment.id);
  const metricsSummary = Object.fromEntries(
    Object.entries(numericMetrics).map(([metricName, metricValue]) => [
      metricName,
      metricValue.toFixed(4)
    ])
  );

  const version: ModelVersionRecord = {
    id: nextId('mv'),
    model_id: model.id,
    training_job_id: job.id,
    version_name: input.version_name,
    task_type: job.task_type,
    framework: job.framework,
    status: 'registered',
    metrics_summary: metricsSummary,
    artifact_attachment_id: artifactAttachment.id,
    created_by: currentUser.id,
    created_at: now()
  };

  modelVersions.unshift(version);
  logAudit('model_version_registered', 'ModelVersion', version.id, {
    model_id: model.id,
    training_job_id: job.id
  });

  return version;
}

export async function listInferenceRuns(): Promise<InferenceRunRecord[]> {
  await delay(120);
  const currentUser = findCurrentUser();

  return inferenceRuns.filter((run) => {
    const version = modelVersions.find((item) => item.id === run.model_version_id);
    if (!version) {
      return false;
    }

    if (isFixtureModelVersionRecord(version)) {
      return false;
    }

    const inputAttachment = attachments.find((item) => item.id === run.input_attachment_id);
    if (!inputAttachment || isFixtureAttachmentFilename(inputAttachment.filename)) {
      return false;
    }

    try {
      assertModelVersionAccess(version.id, currentUser);
      return true;
    } catch {
      return false;
    }
  });
}

export async function runInference(input: RunInferenceInput): Promise<InferenceRunRecord> {
  await delay(100);
  const currentUser = findCurrentUser();
  const version = assertModelVersionAccess(input.model_version_id, currentUser);

  if (version.task_type !== input.task_type) {
    throw new Error('Requested task_type does not match selected model version task_type.');
  }

  const inputAttachment = attachments.find((attachment) => attachment.id === input.input_attachment_id);
  if (!inputAttachment) {
    throw new Error('Input attachment not found.');
  }

  assertOwnershipOrAdmin(inputAttachment.owner_user_id, currentUser, 'No permission to run inference on this file.');
  if (inputAttachment.status !== 'ready') {
    throw new Error('Input attachment must be ready before inference.');
  }

  const model = models.find((item) => item.id === version.model_id);
  if (!model) {
    throw new Error('Model not found for selected version.');
  }

  const trainer = getTrainerByFramework(version.framework);
  const modelArtifactPath = await resolveModelVersionArtifactModelPath(version);
  const prediction = await trainer.predict({
    modelId: model.id,
    modelVersionId: version.id,
    inputAttachmentId: inputAttachment.id,
    filename: inputAttachment.filename,
    taskType: input.task_type,
    inputMimeType: inputAttachment.mime_type,
    inputByteSize: inputAttachment.byte_size,
    inputStoragePath: inputAttachment.storage_path,
    modelArtifactPath
  });

  const created: InferenceRunRecord = {
    id: nextId('ir'),
    model_version_id: version.id,
    input_attachment_id: inputAttachment.id,
    task_type: input.task_type,
    framework: version.framework,
    status: 'completed',
    execution_source:
      typeof prediction.normalized_output.source === 'string'
        ? prediction.normalized_output.source
        : 'unknown',
    raw_output: prediction.raw_output,
    normalized_output: prediction,
    feedback_dataset_id: null,
    created_by: currentUser.id,
    created_at: now(),
    updated_at: now()
  };

  inferenceRuns.unshift(created);
  logAudit('inference_run_created', 'InferenceRun', created.id, {
    model_version_id: version.id,
    task_type: created.task_type
  });
  return created;
}

export async function getInferenceRun(runId: string): Promise<InferenceRunRecord> {
  await delay(100);
  const currentUser = findCurrentUser();
  const run = inferenceRuns.find((item) => item.id === runId);
  if (!run) {
    throw new Error('Inference run not found.');
  }

  assertModelVersionAccess(run.model_version_id, currentUser);
  return run;
}

export async function sendInferenceFeedback(input: InferenceFeedbackInput): Promise<InferenceRunRecord> {
  await delay(100);
  const currentUser = findCurrentUser();
  const run = inferenceRuns.find((item) => item.id === input.run_id);
  if (!run) {
    throw new Error('Inference run not found.');
  }

  assertModelVersionAccess(run.model_version_id, currentUser);
  const dataset = assertDatasetAccess(input.dataset_id, currentUser);
  if (dataset.task_type !== run.task_type) {
    throw new Error('Feedback dataset task_type must match inference run task_type.');
  }
  const reason = input.reason.trim() || 'feedback';

  run.feedback_dataset_id = dataset.id;
  run.updated_at = now();

  const existingFeedbackItem = datasetItems.find(
    (item) =>
      item.dataset_id === dataset.id &&
      typeof item.metadata.inference_run_id === 'string' &&
      item.metadata.inference_run_id === run.id
  );

  if (existingFeedbackItem) {
    existingFeedbackItem.metadata = {
      ...existingFeedbackItem.metadata,
      feedback_reason: reason,
      source_attachment_id: run.input_attachment_id
    };
    existingFeedbackItem.updated_at = now();

    logAudit('inference_feedback_sent', 'InferenceRun', run.id, {
      dataset_id: dataset.id,
      reason,
      dataset_item_id: existingFeedbackItem.id,
      dataset_attachment_id: existingFeedbackItem.attachment_id,
      item_created: 'false'
    });

    return run;
  }

  const sourceAttachment = attachments.find((item) => item.id === run.input_attachment_id);
  if (!sourceAttachment) {
    throw new Error('Inference input attachment not found.');
  }

  const datasetAttachment =
    sourceAttachment.attached_to_type === 'Dataset' && sourceAttachment.attached_to_id === dataset.id
      ? sourceAttachment
      : await cloneAttachmentToDatasetScope(sourceAttachment, dataset, currentUser);

  const upserted = upsertDatasetItemForAttachment(dataset, datasetAttachment, {
    split: 'unassigned',
    status: datasetAttachment.status,
    metadata: {
      feedback_reason: reason,
      inference_run_id: run.id,
      source_attachment_id: sourceAttachment.id
    }
  });

  if (upserted.item.status === 'ready' && dataset.status !== 'ready') {
    dataset.status = 'ready';
    dataset.updated_at = now();
  }

  logAudit('inference_feedback_sent', 'InferenceRun', run.id, {
    dataset_id: dataset.id,
    reason,
    dataset_item_id: upserted.item.id,
    dataset_attachment_id: datasetAttachment.id,
    item_created: upserted.created ? 'true' : 'false'
  });

  return run;
}

export async function getRuntimeConnectivity(
  framework?: 'paddleocr' | 'doctr' | 'yolo'
): Promise<RuntimeConnectivityRecord[]> {
  await delay(80);
  const targets = framework ? [framework] : (['paddleocr', 'doctr', 'yolo'] as const);
  const checks = await Promise.all(targets.map((item) => checkRuntimeConnectivity(item)));
  return checks;
}

export async function listApprovalRequests(): Promise<ApprovalRequest[]> {
  await delay(120);
  const currentUser = findCurrentUser();

  if (currentUser.role === 'admin') {
    return approvalRequests;
  }

  return approvalRequests.filter((item) => item.requested_by === currentUser.id);
}

export async function listAuditLogs(): Promise<AuditLogRecord[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  if (currentUser.role !== 'admin') {
    throw new Error('Only admin can view audit logs.');
  }
  return auditLogs;
}

export async function listVerificationReports(): Promise<VerificationReportRecord[]> {
  await delay(120);
  const currentUser = findCurrentUser();
  if (currentUser.role !== 'admin') {
    throw new Error('Only admin can view verification reports.');
  }

  let files: string[] = [];
  try {
    files = (await fs.readdir(verificationReportsDir))
      .filter((file) => file.startsWith('docker-verify-full-') && file.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw new Error('Failed to read verification reports directory.');
  }

  const reports: VerificationReportRecord[] = [];

  for (const filename of files) {
    const fullPath = path.join(verificationReportsDir, filename);

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      const parsed = JSON.parse(content) as {
        status?: string;
        summary?: string;
        started_at_utc?: string;
        finished_at_utc?: string;
        target?: { base_url?: string; business_username?: string; probe_username?: string };
        checks?: Array<{ name?: string; status?: string; detail?: string }>;
        entities?: Record<string, unknown>;
        runtime_metrics_retention?: unknown;
      };

      const checks: VerificationCheckRecord[] = Array.isArray(parsed.checks)
        ? parsed.checks.map((item) => ({
            name: typeof item.name === 'string' ? item.name : 'unknown',
            status: typeof item.status === 'string' ? item.status : 'unknown',
            detail: typeof item.detail === 'string' ? item.detail : ''
          }))
        : [];

      const checksFailed = checks.filter((item) => item.status !== 'passed').length;
      const normalizedStatus: VerificationReportRecord['status'] =
        parsed.status === 'passed' || parsed.status === 'failed'
          ? parsed.status
          : checksFailed > 0
            ? 'failed'
            : 'unknown';

      const entities = Object.fromEntries(
        Object.entries(parsed.entities ?? {}).map(([key, value]) => [key, String(value ?? '')])
      );

      reports.push({
        id: filename.replace(/\.json$/i, ''),
        filename,
        status: normalizedStatus,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        started_at_utc: typeof parsed.started_at_utc === 'string' ? parsed.started_at_utc : '',
        finished_at_utc: typeof parsed.finished_at_utc === 'string' ? parsed.finished_at_utc : '',
        target_base_url: parsed.target?.base_url ?? '',
        business_username: parsed.target?.business_username ?? '',
        probe_username: parsed.target?.probe_username ?? '',
        checks_total: checks.length,
        checks_failed: checksFailed,
        checks,
        entities,
        runtime_metrics_retention: normalizeRuntimeMetricsRetentionSummary(
          parsed.runtime_metrics_retention
        )
      });
    } catch {
      reports.push({
        id: filename.replace(/\.json$/i, ''),
        filename,
        status: 'unknown',
        summary: 'Report file is unreadable or invalid JSON.',
        started_at_utc: '',
        finished_at_utc: '',
        target_base_url: '',
        business_username: '',
        probe_username: '',
        checks_total: 0,
        checks_failed: 0,
        checks: [],
        entities: {},
        runtime_metrics_retention: null
      });
    }
  }

  return reports;
}

export async function approveRequest(input: { approval_id: string; notes?: string }): Promise<ApprovalRequest> {
  await delay(120);
  const currentUser = findCurrentUser();

  if (currentUser.role !== 'admin') {
    throw new Error('Only admin can approve requests.');
  }

  const request = approvalRequests.find((item) => item.id === input.approval_id);
  if (!request) {
    throw new Error('Approval request not found.');
  }

  if (request.status !== 'pending') {
    throw new Error('Only pending requests can be approved.');
  }

  request.status = 'approved';
  request.approved_by = currentUser.id;
  request.review_notes = input.notes ?? request.review_notes;
  request.reviewed_at = now();

  const model = models.find((item) => item.id === request.model_id);
  if (model) {
    model.status = 'approved';
    model.updated_at = now();
  }

  logAudit('approval_approved', 'ApprovalRequest', request.id, {
    model_id: request.model_id
  });

  return request;
}

export async function rejectRequest(input: { approval_id: string; reason: string; notes?: string }): Promise<ApprovalRequest> {
  await delay(120);
  const currentUser = findCurrentUser();

  if (currentUser.role !== 'admin') {
    throw new Error('Only admin can reject requests.');
  }

  const request = approvalRequests.find((item) => item.id === input.approval_id);
  if (!request) {
    throw new Error('Approval request not found.');
  }

  if (request.status !== 'pending') {
    throw new Error('Only pending requests can be rejected.');
  }

  request.status = 'rejected';
  request.approved_by = currentUser.id;
  request.review_notes = input.notes ? `${input.reason}\n${input.notes}` : input.reason;
  request.reviewed_at = now();

  const model = models.find((item) => item.id === request.model_id);
  if (model) {
    model.status = 'rejected';
    model.updated_at = now();
  }

  logAudit('approval_rejected', 'ApprovalRequest', request.id, {
    model_id: request.model_id
  });

  return request;
}

export async function getLlmConfig(): Promise<LlmConfigView> {
  await delay(80);
  return getCurrentUserLlmConfigView();
}

export async function saveLlmConfig(input: {
  llm_config: LlmConfig;
  keep_existing_api_key?: boolean;
}): Promise<LlmConfigView> {
  await delay(80);
  const currentUser = findCurrentUser();
  const existing = getStoredLlmConfigByUser(currentUser.id);
  const normalized = normalizeLlmConfig(input.llm_config);
  llmConfigsByUser[currentUser.id] = {
    ...normalized,
    api_key:
      input.keep_existing_api_key && !normalized.api_key.trim()
        ? existing.api_key
        : normalized.api_key
  };
  await persistLlmConfigs();
  logAudit('llm_config_saved', 'User', currentUser.id, {
    enabled: String(llmConfigsByUser[currentUser.id].enabled),
    model: llmConfigsByUser[currentUser.id].model
  });
  return getCurrentUserLlmConfigView();
}

export async function clearLlmConfig(): Promise<LlmConfigView> {
  await delay(80);
  const currentUser = findCurrentUser();
  delete llmConfigsByUser[currentUser.id];
  await persistLlmConfigs();
  logAudit('llm_config_cleared', 'User', currentUser.id);
  return getCurrentUserLlmConfigView();
}

export async function testLlmConnection(input: {
  llm_config: LlmConfig;
  use_stored_api_key?: boolean;
}): Promise<{ preview: string }> {
  await delay(80);
  const currentUser = findCurrentUser();
  const normalized = normalizeLlmConfig(input.llm_config);
  const existing = getStoredLlmConfigByUser(currentUser.id);
  const effective = {
    ...normalized,
    api_key:
      input.use_stored_api_key && !normalized.api_key.trim()
        ? existing.api_key
        : normalized.api_key
  };
  if (!effective.api_key.trim()) {
    throw new Error('Connection test requires API key input or a saved key.');
  }
  const preview = await callConfiguredLlm(
    'Please reply with one short line that confirms the connection is working.',
    [],
    effective
  );
  logAudit('llm_connection_tested', 'User', currentUser.id, {
    model: effective.model,
    used_stored_api_key: input.use_stored_api_key && !normalized.api_key.trim() ? 'true' : 'false'
  });
  return { preview };
}

export async function getRuntimeSettings(): Promise<RuntimeSettingsView> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can access runtime settings.');
  return getCurrentRuntimeSettingsView();
}

export async function saveRuntimeSettings(input: {
  runtime_config: RuntimeSettingsRecord['frameworks'];
  runtime_controls?: Partial<RuntimeSettingsRecord['controls']>;
  keep_existing_api_keys?: boolean;
}): Promise<RuntimeSettingsView> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can update runtime settings.');

  const existing = getCurrentRuntimeSettingsRecord();
  const keepExistingApiKeys = input.keep_existing_api_keys !== false;

  runtimeFrameworks.forEach((framework) => {
    const submitted = normalizeRuntimeFrameworkConfig(
      input.runtime_config?.[framework],
      emptyRuntimeFrameworkConfig
    );
    const previous = existing.frameworks[framework];
    runtimeSettings.frameworks[framework] = {
      endpoint: submitted.endpoint,
      local_train_command: submitted.local_train_command,
      local_predict_command: submitted.local_predict_command,
      api_key:
        keepExistingApiKeys && !submitted.api_key.trim() ? previous.api_key : submitted.api_key
    };
  });
  runtimeSettings.controls = normalizeRuntimeControlConfig(input.runtime_controls, existing.controls);
  runtimeSettings.active_profile_id = 'saved';
  runtimeSettings.updated_at = now();
  await persistRuntimeSettings();

  logAudit('runtime_settings_saved', 'System', 'runtime-settings', {
    keep_existing_api_keys: keepExistingApiKeys ? 'true' : 'false',
    updated_by: currentUser.id
  });
  return getCurrentRuntimeSettingsView();
}

export async function clearRuntimeSettings(): Promise<RuntimeSettingsView> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can clear runtime settings.');

  runtimeFrameworks.forEach((framework) => {
    runtimeSettings.frameworks[framework] = getEnvRuntimeFrameworkConfig(framework);
  });
  runtimeSettings.controls = getEnvRuntimeControlConfig();
  runtimeSettings.active_profile_id = null;
  runtimeSettings.updated_at = null;
  await persistRuntimeSettings();

  logAudit('runtime_settings_cleared', 'System', 'runtime-settings', {
    updated_by: currentUser.id
  });
  return getCurrentRuntimeSettingsView();
}

export async function activateRuntimeProfile(profileId: string): Promise<RuntimeSettingsView> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertAdmin(currentUser, 'Only admin can switch runtime profile.');

  const record = getCurrentRuntimeSettingsRecord();
  const target = buildRuntimeProfiles(record).find((item) => item.id === profileId.trim());
  if (!target) {
    throw new Error('Runtime profile not found.');
  }

  runtimeFrameworks.forEach((framework) => {
    runtimeSettings.frameworks[framework] = {
      ...target.frameworks[framework]
    };
  });
  runtimeSettings.controls = normalizeRuntimeControlConfig(target.controls, emptyRuntimeControlConfig);
  runtimeSettings.active_profile_id = target.id;
  runtimeSettings.updated_at = now();
  await persistRuntimeSettings();

  logAudit('runtime_profile_activated', 'System', 'runtime-settings', {
    profile_id: target.id,
    updated_by: currentUser.id
  });
  return getCurrentRuntimeSettingsView();
}

export async function submitApprovalRequest(
  input: SubmitApprovalInput
): Promise<ApprovalRequest> {
  await delay();
  const currentUser = findCurrentUser();

  const model = models.find((item) => item.id === input.model_id);
  if (!model) {
    throw new Error('Model not found.');
  }

  if (!(currentUser.role === 'admin' || model.owner_user_id === currentUser.id)) {
    throw new Error('No permission to submit approval for this model.');
  }

  const hasReadyFile = attachments.some(
    (item) => item.attached_to_type === 'Model' && item.attached_to_id === model.id && item.status === 'ready'
  );

  if (!hasReadyFile) {
    throw new Error('Upload at least one ready model file before approval submission.');
  }

  model.status = 'pending_approval';
  model.updated_at = now();
  model.metadata = {
    ...model.metadata,
    ...Object.fromEntries(
      Object.entries(input.parameter_snapshot).map(([key, value]) => [`parameter_${key}`, value])
    )
  };

  const request: ApprovalRequest = {
    id: nextId('ar'),
    model_id: model.id,
    requested_by: currentUser.id,
    approved_by: null,
    status: 'pending',
    review_notes: input.review_notes ?? null,
    requested_at: now(),
    reviewed_at: null
  };

  approvalRequests.unshift(request);
  logAudit('approval_submitted', 'ApprovalRequest', request.id, { model_id: model.id });
  return request;
}

export async function listAnnotationReviewsCount(datasetId: string): Promise<{ total: number }> {
  await delay(80);
  const currentUser = findCurrentUser();
  assertDatasetAccess(datasetId, currentUser);

  const itemIds = new Set(datasetItems.filter((item) => item.dataset_id === datasetId).map((item) => item.id));
  const annotationIds = new Set(
    annotations.filter((annotation) => itemIds.has(annotation.dataset_item_id)).map((annotation) => annotation.id)
  );

  return {
    total: annotationReviews.filter((review) => annotationIds.has(review.annotation_id)).length
  };
}
