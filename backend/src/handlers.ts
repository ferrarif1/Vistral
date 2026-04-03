import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
  trainingJobs,
  trainingMetrics,
  userPasswordHashes,
  users
} from './store';
import { hashPassword, verifyPassword } from './auth';
import { checkRuntimeConnectivity, getTrainerByFramework } from './runtimeAdapters';
import type {
  AnnotationRecord,
  AnnotationReviewRecord,
  AnnotationWithReview,
  AnnotationStatus,
  ApprovalRequest,
  AuditLogRecord,
  ConversationRecord,
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
  LoginInput,
  MessageRecord,
  ModelRecord,
  ModelVersionRecord,
  RequirementTaskDraft,
  RegisterInput,
  RenameConversationInput,
  RegisterModelVersionInput,
  ReviewAnnotationInput,
  RuntimeConnectivityRecord,
  RuntimeMetricsRetentionSummary,
  RunInferenceInput,
  SendMessageInput,
  StartConversationInput,
  SubmitApprovalInput,
  TrainingMetricsExport,
  TaskType,
  ModelFramework,
  TrainingJobRecord,
  TrainingMetricRecord,
  UpsertAnnotationInput,
  VerificationCheckRecord,
  VerificationReportRecord,
  User
} from '../../shared/domain';

const delay = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const normalizeUsername = (value: string) => value.trim().toLowerCase();
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
  return found;
};

export const runAsUser = async <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  actorStore.run({ userId }, fn);

const canManageModels = (user: User) =>
  user.role === 'admin' || user.capabilities.includes('manage_models');

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

const buildRuleBasedTaskDraft = (description: string): RequirementTaskDraft => {
  const normalized = description.toLowerCase();
  const has = (...keywords: string[]) => keywords.some((keyword) => normalized.includes(keyword));

  if (has('ocr', '识别', '文字', '文本', '车号', '编号', 'read text', 'text line')) {
    return {
      task_type: 'ocr',
      recommended_framework: 'paddleocr',
      annotation_type: 'ocr_text',
      label_hints: ['text_line', 'serial_number', 'region'],
      dataset_suggestions: ['采集不同光照与角度的车体编号样本', '保留高分辨率原图，标注文本行与关键字段'],
      rationale: '需求描述以文字识别为核心，优先 OCR 任务与 PaddleOCR 基线。',
      source: 'rule'
    };
  }

  if (has('旋转', 'obb', 'oriented', '倾斜框')) {
    return {
      task_type: 'obb',
      recommended_framework: 'yolo',
      annotation_type: 'rotated_bbox',
      label_hints: ['target', 'defect', 'component'],
      dataset_suggestions: ['优先标注旋转框并覆盖不同方位', '补充密集目标场景样本'],
      rationale: '需求强调旋转目标，采用 YOLO OBB 路线更直接。',
      source: 'rule'
    };
  }

  if (has('分割', '轮廓', 'mask', 'segmentation')) {
    return {
      task_type: 'segmentation',
      recommended_framework: 'yolo',
      annotation_type: 'polygon',
      label_hints: ['defect_region', 'background'],
      dataset_suggestions: ['优先清晰边界样本', '保持多边形点位精度并覆盖复杂背景'],
      rationale: '需求指向像素级区域识别，建议分割任务。',
      source: 'rule'
    };
  }

  if (has('分类', '是否', '判断', 'classif', 'normal vs abnormal', '开闭')) {
    return {
      task_type: 'classification',
      recommended_framework: 'yolo',
      annotation_type: 'classification',
      label_hints: ['open', 'closed', 'normal', 'abnormal'],
      dataset_suggestions: ['正负样本比例保持平衡', '覆盖同一部件的不同拍摄距离与角度'],
      rationale: '需求更像状态判断，采用分类任务更轻量。',
      source: 'rule'
    };
  }

  return {
    task_type: 'detection',
    recommended_framework: 'yolo',
    annotation_type: 'bbox',
    label_hints: ['defect', 'scratch', 'component'],
    dataset_suggestions: ['先做目标框标注并建立统一标签定义', '样本覆盖白天/夜晚/运动模糊等场景'],
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
    if (!parsed.task_type || !parsed.recommended_framework || !parsed.annotation_type) {
      return null;
    }

    return {
      task_type: parsed.task_type,
      recommended_framework: parsed.recommended_framework,
      annotation_type: parsed.annotation_type,
      label_hints: Array.isArray(parsed.label_hints)
        ? parsed.label_hints.map((item) => String(item)).filter(Boolean)
        : [],
      dataset_suggestions: Array.isArray(parsed.dataset_suggestions)
        ? parsed.dataset_suggestions.map((item) => String(item)).filter(Boolean)
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
      '字段：task_type, recommended_framework, annotation_type, label_hints, dataset_suggestions, rationale。',
      "task_type 只能是: ocr, detection, classification, segmentation, obb。",
      "recommended_framework 只能是: paddleocr, doctr, yolo。",
      "annotation_type 只能是: ocr_text, bbox, rotated_bbox, polygon, classification。",
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

const annotationCoverageForDataset = (datasetId: string): number => {
  const items = datasetItems.filter((item) => item.dataset_id === datasetId);
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

const computeSplitSummary = (datasetId: string) => {
  const items = datasetItems.filter((item) => item.dataset_id === datasetId);
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
  const artifactPayload = {
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

const executeTrainingLifecycle = async (jobId: string): Promise<void> => {
  const job = trainingJobs.find((item) => item.id === jobId);
  if (!job) {
    return;
  }

  const runtime = await ensureTrainingRuntime(job);
  const runId = runtime.run_id;
  const epochs = toPositiveInt(job.config.epochs, 8);

  try {
    job.status = 'preparing';
    job.updated_at = now();
    await appendTrainingLog(job, runtime, `Preparing local workspace for ${job.framework}.`);

    const summary = buildDatasetTrainingSummary(job.dataset_id);
    const configPayload = {
      job_id: job.id,
      framework: job.framework,
      task_type: job.task_type,
      dataset_id: job.dataset_id,
      dataset_version_id: job.dataset_version_id,
      base_model: job.base_model,
      config: job.config,
      created_at: job.created_at
    };
    await fs.writeFile(runtime.config_path, JSON.stringify(configPayload, null, 2), 'utf8');
    await fs.writeFile(runtime.summary_path, JSON.stringify(summary, null, 2), 'utf8');
    await appendTrainingLog(
      job,
      runtime,
      `Dataset summary: items=${summary.total_items}, ready=${summary.ready_items}, annotated=${summary.annotated_items}.`
    );

    const trainer = getTrainerByFramework(job.framework);
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
      artifactPath: runtime.artifact_path
    });
    job.execution_mode = trainAccepted.execution_mode ?? 'unknown';
    await appendTrainingLog(job, runtime, `Trainer accepted: ${trainAccepted.logPreview}`);
    if (Array.isArray(trainAccepted.logs) && trainAccepted.logs.length > 0) {
      for (const line of trainAccepted.logs.slice(-36)) {
        await appendTrainingLog(job, runtime, `trainer> ${line}`);
      }
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

    if (trainAccepted.execution_mode === 'local_command') {
      assertRuntimeActive(job.id, runId);
      job.status = 'running';
      job.updated_at = now();
      await appendTrainingLog(job, runtime, `Running ${job.framework} local command executor.`);
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
    job.status = 'queued';
    job.updated_at = now();
    job.log_excerpt = `Recovered after API restart from ${previousStatus}. Re-queued local executor.`;
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

export async function register(input: RegisterInput): Promise<User> {
  await delay();

  const username = input.username.trim();
  const normalizedUsername = normalizeUsername(username);
  const password = input.password.trim();

  if (username.length < 3) {
    throw new Error('Username must be at least 3 characters.');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  if (users.some((user) => normalizeUsername(user.username) === normalizedUsername)) {
    throw new Error('Username already exists.');
  }

  const created: User = {
    id: nextId('u'),
    username,
    role: 'user',
    capabilities: [],
    created_at: now(),
    updated_at: now()
  };

  users.push(created);
  userPasswordHashes[created.id] = hashPassword(password);
  logAudit(
    'user_registered',
    'User',
    created.id,
    { username: created.username, role: created.role },
    created.id
  );
  return created;
}

export async function login(input: LoginInput): Promise<User> {
  await delay();

  const normalizedUsername = normalizeUsername(input.username);
  const matched = users.find((user) => normalizeUsername(user.username) === normalizedUsername);
  if (!matched) {
    throw new Error('Invalid username or password.');
  }

  const expectedHash = userPasswordHashes[matched.id];
  if (!expectedHash || !verifyPassword(input.password.trim(), expectedHash)) {
    throw new Error('Invalid username or password.');
  }

  logAudit('user_logged_in', 'User', matched.id, { username: matched.username }, matched.id);
  return matched;
}

export async function me(): Promise<User> {
  await delay(120);
  return findCurrentUser();
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

  if (!(currentUser.role === 'admin' || attachment.owner_user_id === currentUser.id)) {
    throw new Error('No permission to access this attachment.');
  }

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
      const datasetItemIndex = datasetItems.findIndex((item) => item.attachment_id === deleted.id);
      if (datasetItemIndex >= 0) {
        datasetItems.splice(datasetItemIndex, 1);
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
    created_at: now()
  };

  const fileNames = attachments
    .filter((item) => input.attachment_ids.includes(item.id))
    .map((item) => item.filename);

  const effectiveLlmConfig = getEffectiveConversationLlmConfig(input.llm_config);
  const assistantContent = await generateAssistantReply(
    input.initial_message,
    fileNames,
    effectiveLlmConfig
  );

  const assistantMessage: MessageRecord = {
    id: nextId('msg'),
    conversation_id: createdConversation.id,
    sender: 'assistant',
    content: assistantContent,
    attachment_ids: [],
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
    created_at: now()
  };

  const fileNames = attachments
    .filter((item) => input.attachment_ids.includes(item.id))
    .map((item) => item.filename);

  const effectiveLlmConfig = getEffectiveConversationLlmConfig(input.llm_config);
  const assistantContent = await generateAssistantReply(
    input.content,
    fileNames,
    effectiveLlmConfig
  );

  const assistantMessage: MessageRecord = {
    id: nextId('msg'),
    conversation_id: conversation.id,
    sender: 'assistant',
    content: assistantContent,
    attachment_ids: [],
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

  const relevantItems = datasetItems.filter((item) => item.dataset_id === dataset.id);
  if (relevantItems.length === 0) {
    return { split_summary: { train: 0, val: 0, test: 0, unassigned: 0 } };
  }

  const trainLimit = Math.floor(relevantItems.length * input.train_ratio);
  const valLimit = Math.floor(relevantItems.length * input.val_ratio);

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

  const splitSummary = computeSplitSummary(dataset.id);
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

  const splitSummary = computeSplitSummary(dataset.id);
  const version: DatasetVersionRecord = {
    id: nextId('dv'),
    dataset_id: dataset.id,
    version_name: input.version_name?.trim() || `v${datasetVersions.filter((item) => item.dataset_id === dataset.id).length + 1}`,
    split_summary: splitSummary,
    item_count: datasetItems.filter((item) => item.dataset_id === dataset.id).length,
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
): Promise<{ format: string; imported: number; updated: number; status: 'completed' }> {
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

  for (const entry of prepared) {
    const matchedItems = itemByFilename.get(entry.filename) ?? [];
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
    source_attachment_id: sourceAttachment.id
  });

  return {
    format: input.format,
    imported,
    updated,
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

  const exported = listDatasetAnnotationsInternal(dataset.id).length;
  const filename = `annotations-${dataset.id}-${input.format}-${Date.now()}.json`;
  const exportPayload = {
    dataset_id: dataset.id,
    format: input.format,
    exported_at: now(),
    annotations: listDatasetAnnotationsInternal(dataset.id).map((annotation) => ({
      dataset_item_id: annotation.dataset_item_id,
      task_type: annotation.task_type,
      status: annotation.status,
      payload: annotation.payload
    }))
  };
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

  if (!canTransitionAnnotationStatus(existing.status, input.status)) {
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

  annotation.status = nextStatus;
  annotation.updated_at = now();

  const review: AnnotationReviewRecord = {
    id: nextId('arv'),
    annotation_id: annotation.id,
    reviewer_user_id: currentUser.id,
    status: input.status,
    quality_score: input.quality_score ?? null,
    review_comment: input.review_comment ?? null,
    created_at: now()
  };
  annotationReviews.unshift(review);

  logAudit('annotation_reviewed', 'AnnotationReview', review.id, {
    annotation_id: annotation.id,
    status: review.status
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

  if (dataset.task_type !== input.task_type) {
    throw new Error('Dataset task_type does not match training task_type.');
  }

  const trainer = getTrainerByFramework(input.framework);
  const validation = await trainer.validate_dataset({
    datasetId: dataset.id,
    taskType: input.task_type
  });

  if (!validation.valid) {
    throw new Error(validation.warnings[0] ?? 'Dataset validation failed for selected framework.');
  }

  const created: TrainingJobRecord = {
    id: nextId('tj'),
    name: input.name.trim(),
    task_type: input.task_type,
    framework: input.framework,
    status: 'draft',
    dataset_id: dataset.id,
    dataset_version_id: input.dataset_version_id ?? null,
    base_model: input.base_model.trim(),
    config: input.config,
    execution_mode: 'unknown',
    log_excerpt: 'Queued for local training execution.',
    submitted_by: currentUser.id,
    created_at: now(),
    updated_at: now()
  };

  created.status = 'queued';
  created.updated_at = now();

  trainingJobs.unshift(created);
  logAudit('training_job_created', 'TrainingJob', created.id, {
    framework: created.framework,
    task_type: created.task_type
  });

  scheduleTrainingLifecycle(created.id);
  return created;
}

export async function getTrainingJobDetail(jobId: string): Promise<{
  job: TrainingJobRecord;
  metrics: TrainingMetricRecord[];
  logs: string[];
  artifact_attachment_id: string | null;
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

  return {
    job,
    metrics: trainingMetrics.filter((metric) => metric.training_job_id === job.id),
    logs,
    artifact_attachment_id: artifactAttachmentId,
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

  job.status = 'queued';
  job.execution_mode = 'unknown';
  job.log_excerpt = 'Retry requested. Re-queueing local executor.';
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

  const metrics = trainingMetrics.filter((item) => item.training_job_id === job.id);
  const numericMetrics = pickLatestMetrics(metrics);
  const artifactAttachment = await ensureTrainingArtifactAttachment(job, numericMetrics);
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
  const prediction = await trainer.predict({
    modelId: model.id,
    modelVersionId: version.id,
    inputAttachmentId: inputAttachment.id,
    filename: inputAttachment.filename,
    taskType: input.task_type,
    inputMimeType: inputAttachment.mime_type,
    inputByteSize: inputAttachment.byte_size,
    inputStoragePath: inputAttachment.storage_path
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

  run.feedback_dataset_id = dataset.id;
  run.updated_at = now();

  const attachment = attachments.find((item) => item.id === run.input_attachment_id);
  if (attachment) {
    const existing = datasetItems.find(
      (item) => item.dataset_id === dataset.id && item.attachment_id === attachment.id
    );

    if (!existing) {
      datasetItems.unshift({
        id: nextId('di'),
        dataset_id: dataset.id,
        attachment_id: attachment.id,
        split: 'unassigned',
        status: attachment.status,
        metadata: {
          feedback_reason: input.reason,
          inference_run_id: run.id
        },
        created_at: now(),
        updated_at: now()
      });
    }
  }

  logAudit('inference_feedback_sent', 'InferenceRun', run.id, {
    dataset_id: dataset.id,
    reason: input.reason
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

export async function testLlmConnection(input: { llm_config: LlmConfig }): Promise<{ preview: string }> {
  await delay(80);
  const normalized = normalizeLlmConfig(input.llm_config);
  const preview = await callConfiguredLlm(
    'Please reply with one short line that confirms the connection is working.',
    [],
    normalized
  );
  logAudit('llm_connection_tested', 'User', findCurrentUser().id, { model: normalized.model });
  return { preview };
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
