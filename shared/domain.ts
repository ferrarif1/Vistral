export type SystemRole = 'user' | 'admin';
export type Capability = 'manage_models' | 'global_governance';

export type ModelVisibility = 'private' | 'workspace' | 'public';
export type ModelStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'deprecated';

export type ConversationStatus = 'active' | 'completed' | 'archived';
export type MessageSender = 'user' | 'assistant' | 'system';

export type FileAttachmentStatus = 'uploading' | 'processing' | 'ready' | 'error';
export type AttachmentTargetType = 'Conversation' | 'Model';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface User {
  id: string;
  email: string;
  username: string;
  role: SystemRole;
  capabilities: Capability[];
  created_at: string;
  updated_at: string;
}

export interface ModelRecord {
  id: string;
  name: string;
  description: string;
  model_type: string;
  owner_user_id: string;
  visibility: ModelVisibility;
  status: ModelStatus;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface ConversationRecord {
  id: string;
  model_id: string;
  title: string;
  status: ConversationStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  sender: MessageSender;
  content: string;
  attachment_ids: string[];
  created_at: string;
}

export interface FileAttachment {
  id: string;
  filename: string;
  status: FileAttachmentStatus;
  owner_user_id: string;
  attached_to_type: AttachmentTargetType;
  attached_to_id: string | null;
  upload_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRequest {
  id: string;
  model_id: string;
  requested_by: string;
  approved_by: string | null;
  status: ApprovalStatus;
  review_notes: string | null;
  requested_at: string;
  reviewed_at: string | null;
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface CreateModelDraftInput {
  name: string;
  description: string;
  model_type: string;
  visibility: ModelVisibility;
}

export interface StartConversationInput {
  model_id: string;
  initial_message: string;
  attachment_ids: string[];
}

export interface SendMessageInput {
  conversation_id: string;
  content: string;
  attachment_ids: string[];
}

export interface SubmitApprovalInput {
  model_id: string;
  review_notes?: string;
  parameter_snapshot: Record<string, string>;
}
