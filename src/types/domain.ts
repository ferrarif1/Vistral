export type Role = 'user' | 'admin';
export type AttachmentStatus = 'uploading' | 'processing' | 'ready' | 'error';

export interface User {
  id: string;
  email: string;
  username: string;
  role: Role;
  capabilities: string[];
}

export interface AttachmentItem {
  id: string;
  filename: string;
  status: AttachmentStatus;
}

export interface ModelRecord {
  id: string;
  name: string;
  description: string;
  owner_user_id: string;
  visibility: 'private' | 'workspace' | 'public';
  status: 'draft' | 'pending_approval' | 'published';
}
