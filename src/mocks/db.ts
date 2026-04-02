import type { AttachmentItem, ModelRecord, User } from '../types/domain';

export const mockUsers: User[] = [
  {
    id: 'u-1',
    email: 'user@vistral.dev',
    username: 'alice',
    role: 'user',
    capabilities: ['manage_models']
  },
  {
    id: 'u-2',
    email: 'admin@vistral.dev',
    username: 'admin',
    role: 'admin',
    capabilities: ['manage_models', 'global_governance']
  }
];

export const mockModels: ModelRecord[] = [
  {
    id: 'm-1',
    name: 'Road Damage Detector',
    description: 'Detects road cracks from photos.',
    owner_user_id: 'u-1',
    visibility: 'workspace',
    status: 'published'
  },
  {
    id: 'm-2',
    name: 'Factory PPE Checker',
    description: 'Checks PPE compliance in factory floor images.',
    owner_user_id: 'u-2',
    visibility: 'private',
    status: 'draft'
  }
];

export const mockAttachments: AttachmentItem[] = [
  { id: 'a-1', filename: 'inspection-01.jpg', status: 'ready' },
  { id: 'a-2', filename: 'notes.pdf', status: 'processing' }
];
