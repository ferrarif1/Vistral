import {
  approvalRequests,
  attachments,
  conversations,
  messages,
  models,
  users
} from './store';
import type {
  ApprovalRequest,
  ConversationRecord,
  CreateModelDraftInput,
  FileAttachment,
  LoginInput,
  MessageRecord,
  ModelRecord,
  RegisterInput,
  SendMessageInput,
  StartConversationInput,
  SubmitApprovalInput,
  User
} from '../../shared/domain';

const delay = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

let idSeed = 200;
let currentUserId = 'u-1';

const nextId = (prefix: string) => `${prefix}-${idSeed++}`;

const findCurrentUser = (): User => {
  const found = users.find((user) => user.id === currentUserId);
  if (!found) {
    throw new Error('Current user not found in mock store.');
  }
  return found;
};

const canManageModels = (user: User) =>
  user.role === 'admin' || user.capabilities.includes('manage_models');

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

const startAttachmentLifecycle = (attachment: FileAttachment, shouldFail: boolean) => {
  setTimeout(() => {
    attachment.status = 'processing';
    attachment.updated_at = now();
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
  }, 1000);
};

const buildAssistantReply = (content: string, fileNames: string[]) => {
  const attachmentPart =
    fileNames.length > 0 ? `I reviewed ${fileNames.join(', ')}.` : 'No attachments were provided.';
  return `Mock analysis complete. ${attachmentPart} Key point from your request: "${content.slice(0, 80)}".`;
};

const conversationMessages = (conversationId: string): MessageRecord[] =>
  messages.filter((item) => item.conversation_id === conversationId);

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
  currentUserId = created.id;
  return created;
}

export async function login(input: LoginInput): Promise<User> {
  await delay();

  const matched = users.find((user) => user.email.toLowerCase() === input.email.toLowerCase());
  if (!matched) {
    throw new Error('User not found in mock environment.');
  }

  currentUserId = matched.id;
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
  return created;
}

export async function removeAttachment(attachmentId: string): Promise<void> {
  await delay(120);
  const currentUser = findCurrentUser();
  const index = attachments.findIndex(
    (item) => item.id === attachmentId && item.owner_user_id === currentUser.id
  );
  if (index >= 0) {
    attachments.splice(index, 1);
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

  const assistantMessage: MessageRecord = {
    id: nextId('msg'),
    conversation_id: createdConversation.id,
    sender: 'assistant',
    content: buildAssistantReply(input.initial_message, fileNames),
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

  const assistantMessage: MessageRecord = {
    id: nextId('msg'),
    conversation_id: conversation.id,
    sender: 'assistant',
    content: buildAssistantReply(input.content, fileNames),
    attachment_ids: [],
    created_at: now()
  };

  messages.push(userMessage, assistantMessage);
  conversation.updated_at = now();

  return { messages: conversationMessages(conversation.id) };
}

export async function listApprovalRequests(): Promise<ApprovalRequest[]> {
  await delay(120);
  const currentUser = findCurrentUser();

  if (currentUser.role === 'admin') {
    return approvalRequests;
  }

  return approvalRequests.filter((item) => item.requested_by === currentUser.id);
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
  return request;
}
