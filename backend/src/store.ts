import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth';
import {
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
  TrainingJobRecord,
  TrainingMetricRecord,
  TrainingExecutionMode,
  User
} from '../../shared/domain';

const now = () => new Date().toISOString();

const llmConfigDataFile = path.resolve(process.cwd(), '.data', 'llm-config.enc.json');
const appStateDataFile = path.resolve(
  process.cwd(),
  (process.env.APP_STATE_STORE_PATH ?? '.data/app-state.json').trim()
);
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
  trainingMetrics: TrainingMetricRecord[];
  modelVersions: ModelVersionRecord[];
  inferenceRuns: InferenceRunRecord[];
  approvalRequests: ApprovalRequest[];
  auditLogs: AuditLogRecord[];
}

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
    status: 'draft',
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
      lines: [{ text: 'Invoice No. 2026-0402', confidence: 0.99 }]
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

let appStateDirty = false;
let appStatePersistPromise: Promise<void> | null = null;

const replaceArray = <T>(target: T[], incoming: T[]): void => {
  target.splice(0, target.length, ...incoming);
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

const normalizeTrainingJob = (entry: TrainingJobRecord): TrainingJobRecord => ({
  ...entry,
  execution_mode: normalizeTrainingExecutionMode(entry.execution_mode)
});

const normalizeInferenceRun = (entry: InferenceRunRecord): InferenceRunRecord => ({
  ...entry,
  execution_source:
    typeof entry.execution_source === 'string' && entry.execution_source.trim()
      ? entry.execution_source
      : typeof entry.normalized_output?.normalized_output?.source === 'string' &&
          entry.normalized_output.normalized_output.source.trim()
        ? entry.normalized_output.normalized_output.source
        : 'unknown'
});

const sanitizeAppStatePayload = (
  payload: Partial<AppStatePayload>
): { payload: Partial<AppStatePayload>; changed: boolean } => {
  const sourceUsers = Array.isArray(payload.users) ? payload.users : [];
  const sourceModels = Array.isArray(payload.models) ? payload.models : [];
  const sourceDatasets = Array.isArray(payload.datasets) ? payload.datasets : [];
  const sourceDatasetVersions = Array.isArray(payload.datasetVersions) ? payload.datasetVersions : [];
  const sourceTrainingJobs = Array.isArray(payload.trainingJobs) ? payload.trainingJobs : [];
  const sourceModelVersions = Array.isArray(payload.modelVersions) ? payload.modelVersions : [];
  const sourceConversations = Array.isArray(payload.conversations) ? payload.conversations : [];
  const sourceInferenceRuns = Array.isArray(payload.inferenceRuns) ? payload.inferenceRuns : [];
  const sourceAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const sourceDatasetItems = Array.isArray(payload.datasetItems) ? payload.datasetItems : [];
  const sourceAnnotations = Array.isArray(payload.annotations) ? payload.annotations : [];
  const sourceAnnotationReviews = Array.isArray(payload.annotationReviews)
    ? payload.annotationReviews
    : [];
  const sourceMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const sourceApprovalRequests = Array.isArray(payload.approvalRequests)
    ? payload.approvalRequests
    : [];
  const sourceTrainingMetrics = Array.isArray(payload.trainingMetrics) ? payload.trainingMetrics : [];
  const sourceAuditLogs = Array.isArray(payload.auditLogs) ? payload.auditLogs : [];
  const normalizedUsers = sourceUsers.map(normalizeUser);

  const keptModels = sourceModels.filter((model) => !isFixtureModelRecord(model));
  const keptModelIds = new Set(keptModels.map((model) => model.id));

  const keptDatasets = sourceDatasets.filter((dataset) => !isFixtureDatasetRecord(dataset));
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
      return !attachment.attached_to_id || keptModelIds.has(attachment.attached_to_id);
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
      replaceArray(annotationReviews, state.annotationReviews);
    }
    if (Array.isArray(state.datasetVersions)) {
      replaceArray(datasetVersions, state.datasetVersions);
    }
    if (Array.isArray(state.trainingJobs)) {
      replaceArray(trainingJobs, state.trainingJobs.map(normalizeTrainingJob));
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

export const persistLlmConfigs = async (): Promise<void> => {
  const serialized = JSON.stringify(llmConfigsByUser);
  const encrypted = encryptText(serialized);

  await fs.mkdir(path.dirname(llmConfigDataFile), { recursive: true });
  await fs.writeFile(llmConfigDataFile, JSON.stringify(encrypted), 'utf8');
};
