import type {
  ApprovalRequest,
  ConversationRecord,
  FileAttachment,
  MessageRecord,
  ModelRecord,
  User
} from '../../shared/domain';

const now = () => new Date().toISOString();

export const users: User[] = [
  {
    id: 'u-1',
    email: 'user@vistral.dev',
    username: 'alice',
    role: 'user',
    capabilities: ['manage_models'],
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'u-2',
    email: 'admin@vistral.dev',
    username: 'admin',
    role: 'admin',
    capabilities: ['manage_models', 'global_governance'],
    created_at: now(),
    updated_at: now()
  }
];

export const models: ModelRecord[] = [
  {
    id: 'm-1',
    name: 'Road Damage Detector',
    description: 'Detects road cracks from photos.',
    model_type: 'detection',
    owner_user_id: 'u-1',
    visibility: 'workspace',
    status: 'published',
    metadata: { framework: 'onnx' },
    created_at: now(),
    updated_at: now()
  },
  {
    id: 'm-2',
    name: 'Factory PPE Checker',
    description: 'Checks PPE compliance in factory floor images.',
    model_type: 'classification',
    owner_user_id: 'u-2',
    visibility: 'private',
    status: 'draft',
    metadata: { framework: 'pytorch' },
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
    upload_error: null,
    created_at: now(),
    updated_at: now()
  }
];

export const approvalRequests: ApprovalRequest[] = [];
