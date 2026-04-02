import * as handlers from '../../backend/src/handlers';
import type {
  CreateModelDraftInput,
  LoginInput,
  RegisterInput,
  SendMessageInput,
  StartConversationInput,
  SubmitApprovalInput
} from '../../shared/domain';

export const api = {
  register: (input: RegisterInput) => handlers.register(input),
  login: (input: LoginInput) => handlers.login(input),
  me: () => handlers.me(),

  listModels: () => handlers.listModels(),
  listMyModels: () => handlers.listMyModels(),
  createModelDraft: (input: CreateModelDraftInput) => handlers.createModelDraft(input),

  listConversationAttachments: () => handlers.listConversationAttachments(),
  uploadConversationAttachment: (filename: string) => handlers.uploadConversationAttachment(filename),
  listModelAttachments: (modelId: string) => handlers.listModelAttachments(modelId),
  uploadModelAttachment: (modelId: string, filename: string) => handlers.uploadModelAttachment(modelId, filename),
  removeAttachment: (attachmentId: string) => handlers.removeAttachment(attachmentId),

  startConversation: (input: StartConversationInput) => handlers.startConversation(input),
  sendConversationMessage: (input: SendMessageInput) => handlers.sendConversationMessage(input),
  listApprovalRequests: () => handlers.listApprovalRequests(),

  submitApprovalRequest: (input: SubmitApprovalInput) => handlers.submitApprovalRequest(input)
};
