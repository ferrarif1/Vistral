import { AsyncLocalStorage } from 'node:async_hooks';
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
  messages,
  models,
  modelVersions,
  persistLlmConfigs,
  trainingJobs,
  trainingMetrics,
  users
} from './store';
import { getTrainerByFramework } from './runtimeAdapters';
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
  RegisterInput,
  RegisterModelVersionInput,
  ReviewAnnotationInput,
  RunInferenceInput,
  SendMessageInput,
  StartConversationInput,
  SubmitApprovalInput,
  TrainingJobRecord,
  TrainingMetricRecord,
  UpsertAnnotationInput,
  User
} from '../../shared/domain';

const delay = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

let idSeed = 400;
const currentUserId = process.env.DEFAULT_USER_ID ?? 'u-1';
const actorStore = new AsyncLocalStorage<{ userId: string }>();

const defaultLlmConfig: LlmConfig = {
  enabled: false,
  provider: 'chatanywhere',
  base_url: process.env.VITE_DEFAULT_LLM_BASE_URL ?? 'https://api.chatanywhere.tech',
  api_key: '',
  model: process.env.VITE_DEFAULT_LLM_MODEL ?? 'gpt-3.5-turbo',
  temperature: 0.2
};

const nextId = (prefix: string) => `${prefix}-${idSeed++}`;

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
    onStatusChange?.(attachment.status);
  }, 1000);
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

const toCompletionEndpoint = (baseUrl: string) =>
  `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

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
    throw new Error(`LLM provider request failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const output = payload.choices?.[0]?.message?.content?.trim();
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

const buildMockPreAnnotationPayload = (taskType: DatasetRecord['task_type'], index: number) => {
  if (taskType === 'ocr') {
    return {
      lines: [
        {
          text: `pre-annotated line ${index + 1}`,
          confidence: 0.74
        }
      ]
    };
  }

  if (taskType === 'detection') {
    return {
      boxes: [{ x: 120 + index * 10, y: 90, width: 160, height: 100, label: 'defect', score: 0.71 }]
    };
  }

  return {
    labels: [{ label: 'pre-annotation', score: 0.68 }]
  };
};

const scheduleTrainingLifecycle = (jobId: string): void => {
  const run = async () => {
    await delay(220);
    const job = trainingJobs.find((item) => item.id === jobId);
    if (!job || job.status === 'cancelled' || job.status === 'failed') {
      return;
    }

    job.status = 'preparing';
    job.log_excerpt = `Preparing runtime for ${job.framework}.`;
    job.updated_at = now();

    await delay(260);
    const runningJob = trainingJobs.find((item) => item.id === jobId);
    if (!runningJob || runningJob.status === 'cancelled' || runningJob.status === 'failed') {
      return;
    }

    runningJob.status = 'running';
    runningJob.log_excerpt = `Running ${runningJob.framework} fine-tuning with base ${runningJob.base_model}.`;
    runningJob.updated_at = now();

    const trainer = getTrainerByFramework(runningJob.framework);
    const evaluateResult = await trainer.evaluate({ trainingJobId: runningJob.id });

    await delay(220);
    const evaluatingJob = trainingJobs.find((item) => item.id === jobId);
    if (!evaluatingJob || evaluatingJob.status === 'cancelled' || evaluatingJob.status === 'failed') {
      return;
    }

    evaluatingJob.status = 'evaluating';
    evaluatingJob.log_excerpt = 'Evaluating metrics...';
    evaluatingJob.updated_at = now();

    Object.entries(evaluateResult.metrics).forEach(([metricName, metricValue], index) => {
      const metric: TrainingMetricRecord = {
        id: nextId('tm'),
        training_job_id: evaluatingJob.id,
        metric_name: metricName,
        metric_value: metricValue,
        step: 1 + index,
        recorded_at: now()
      };
      trainingMetrics.unshift(metric);
    });

    await delay(220);
    const completedJob = trainingJobs.find((item) => item.id === jobId);
    if (!completedJob || completedJob.status === 'cancelled' || completedJob.status === 'failed') {
      return;
    }

    completedJob.status = 'completed';
    completedJob.log_excerpt = 'Training completed successfully (mock lifecycle).';
    completedJob.updated_at = now();
  };

  void run();
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

  if (users.some((user) => user.email.toLowerCase() === input.email.toLowerCase())) {
    throw new Error('Email already exists.');
  }

  const created: User = {
    id: nextId('u'),
    email: input.email,
    username: input.username,
    role: 'user',
    capabilities: [],
    created_at: now(),
    updated_at: now()
  };

  users.push(created);
  logAudit(
    'user_registered',
    'User',
    created.id,
    { email: created.email, role: created.role },
    created.id
  );
  return created;
}

export async function login(input: LoginInput): Promise<User> {
  await delay();

  const matched = users.find((user) => user.email.toLowerCase() === input.email.toLowerCase());
  if (!matched) {
    throw new Error('User not found in mock environment.');
  }

  logAudit('user_logged_in', 'User', matched.id, { email: matched.email }, matched.id);
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

export async function uploadConversationAttachment(filename: string): Promise<FileAttachment> {
  await delay(100);
  const currentUser = findCurrentUser();

  const created: FileAttachment = {
    id: nextId('f'),
    filename,
    status: 'uploading',
    owner_user_id: currentUser.id,
    attached_to_type: 'Conversation',
    attached_to_id: null,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };

  attachments.unshift(created);
  startAttachmentLifecycle(created, filename.toLowerCase().includes('fail'));
  logAudit('conversation_attachment_uploaded', 'FileAttachment', created.id, {
    filename: created.filename
  });
  return created;
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

export async function uploadModelAttachment(modelId: string, filename: string): Promise<FileAttachment> {
  await delay(100);
  const currentUser = findCurrentUser();
  const model = assertModelAccess(modelId, currentUser);

  if (!(currentUser.role === 'admin' || model.owner_user_id === currentUser.id)) {
    throw new Error('No permission to upload model files.');
  }

  const created: FileAttachment = {
    id: nextId('f'),
    filename,
    status: 'uploading',
    owner_user_id: currentUser.id,
    attached_to_type: 'Model',
    attached_to_id: modelId,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };

  attachments.unshift(created);
  startAttachmentLifecycle(created, filename.toLowerCase().includes('fail'));
  logAudit('model_attachment_uploaded', 'FileAttachment', created.id, {
    filename: created.filename,
    model_id: modelId
  });
  return created;
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

  const conversation = conversations.find((item) => item.id === input.conversation_id);
  if (!conversation) {
    throw new Error('Conversation not found.');
  }

  if (!(currentUser.role === 'admin' || conversation.created_by === currentUser.id)) {
    throw new Error('No permission to message in this conversation.');
  }

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

export async function uploadDatasetAttachment(datasetId: string, filename: string): Promise<FileAttachment> {
  await delay(100);
  const currentUser = findCurrentUser();
  const dataset = assertDatasetAccess(datasetId, currentUser);

  const attachment: FileAttachment = {
    id: nextId('f'),
    filename,
    status: 'uploading',
    owner_user_id: currentUser.id,
    attached_to_type: 'Dataset',
    attached_to_id: dataset.id,
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

  startAttachmentLifecycle(attachment, filename.toLowerCase().includes('fail'), (status) => {
    item.status = status;
    item.updated_at = now();

    if (status === 'ready') {
      dataset.status = 'ready';
      dataset.updated_at = now();
    }
  });

  logAudit('dataset_attachment_uploaded', 'Dataset', dataset.id, {
    attachment_id: attachment.id,
    filename: attachment.filename
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

  const sourceAttachment = attachments.find(
    (attachment) =>
      attachment.id === input.attachment_id &&
      attachment.attached_to_type === 'Dataset' &&
      attachment.attached_to_id === dataset.id
  );

  if (!sourceAttachment) {
    throw new Error('Import source attachment not found in this dataset.');
  }

  const readyItems = datasetItems.filter(
    (item) => item.dataset_id === dataset.id && item.status === 'ready'
  );

  let imported = 0;
  let updated = 0;

  readyItems.forEach((item, index) => {
    const existing = annotations.find((annotation) => annotation.dataset_item_id === item.id);
    const payload = buildMockPreAnnotationPayload(dataset.task_type, index);

    if (!existing) {
      const created: AnnotationRecord = {
        id: nextId('ann'),
        dataset_item_id: item.id,
        task_type: dataset.task_type,
        source: 'import',
        status: 'annotated',
        payload,
        annotated_by: currentUser.id,
        created_at: now(),
        updated_at: now()
      };
      annotations.unshift(created);
      imported += 1;
      return;
    }

    if (existing.status === 'approved') {
      return;
    }

    existing.payload = payload;
    existing.source = 'import';
    existing.status = 'annotated';
    existing.annotated_by = currentUser.id;
    existing.updated_at = now();
    updated += 1;
  });

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
  const attachment: FileAttachment = {
    id: nextId('f'),
    filename,
    status: 'ready',
    owner_user_id: currentUser.id,
    attached_to_type: 'Dataset',
    attached_to_id: dataset.id,
    upload_error: null,
    created_at: now(),
    updated_at: now()
  };

  attachments.unshift(attachment);

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

  const items = datasetItems.filter((item) => item.dataset_id === dataset.id && item.status === 'ready');
  let created = 0;
  let updated = 0;

  items.forEach((item, index) => {
    const existing = annotations.find((annotation) => annotation.dataset_item_id === item.id);
    const payload = buildMockPreAnnotationPayload(dataset.task_type, index);

    if (!existing) {
      const record: AnnotationRecord = {
        id: nextId('ann'),
        dataset_item_id: item.id,
        task_type: dataset.task_type,
        source: 'pre_annotation',
        status: 'in_progress',
        payload,
        annotated_by: currentUser.id,
        created_at: now(),
        updated_at: now()
      };
      annotations.unshift(record);
      created += 1;
      return;
    }

    if (existing.status === 'approved') {
      return;
    }

    existing.payload = payload;
    existing.source = 'pre_annotation';
    existing.status = 'in_progress';
    existing.annotated_by = currentUser.id;
    existing.updated_at = now();
    updated += 1;
  });

  logAudit('dataset_pre_annotation_run', 'Dataset', dataset.id, {
    model_version_id: input.model_version_id ?? 'mock',
    created: String(created),
    updated: String(updated)
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

  return trainingJobs.filter((job) => {
    const dataset = datasets.find((item) => item.id === job.dataset_id);
    if (!dataset) {
      return false;
    }

    return currentUser.role === 'admin' || dataset.owner_user_id === currentUser.id;
  });
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
    log_excerpt: 'Draft created.',
    submitted_by: currentUser.id,
    created_at: now(),
    updated_at: now()
  };

  const trainAccepted = await trainer.train({
    trainingJobId: created.id,
    datasetId: created.dataset_id,
    baseModel: created.base_model,
    config: created.config
  });

  created.status = 'queued';
  created.log_excerpt = trainAccepted.logPreview;
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
}> {
  await delay(100);
  const currentUser = findCurrentUser();

  const job = trainingJobs.find((item) => item.id === jobId);
  if (!job) {
    throw new Error('Training job not found.');
  }

  const dataset = assertDatasetAccess(job.dataset_id, currentUser);
  assertOwnershipOrAdmin(dataset.owner_user_id, currentUser, 'No permission to access this training job.');

  return {
    job,
    metrics: trainingMetrics.filter((metric) => metric.training_job_id === job.id)
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

  job.status = 'queued';
  job.log_excerpt = 'Retry requested.';
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
  const metricsSummary = Object.fromEntries(
    metrics.map((item) => [item.metric_name, item.metric_value.toFixed(4)])
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
    artifact_attachment_id: null,
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
    taskType: input.task_type
  });

  const created: InferenceRunRecord = {
    id: nextId('ir'),
    model_version_id: version.id,
    input_attachment_id: inputAttachment.id,
    task_type: input.task_type,
    framework: version.framework,
    status: 'completed',
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
