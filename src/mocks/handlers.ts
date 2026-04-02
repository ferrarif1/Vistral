import { mockAttachments, mockModels, mockUsers } from './db';
import type { AttachmentItem, ModelRecord, User } from '../types/domain';

const delay = (ms = 250) => new Promise((r) => setTimeout(r, ms));

let currentUser: User = mockUsers[0];

export async function register(input: { email: string; password: string; username: string; role?: string }): Promise<User> {
  await delay();
  if (input.role && input.role === 'admin') {
    throw new Error('Registration cannot create admin users.');
  }
  const created: User = {
    id: `u-${mockUsers.length + 1}`,
    email: input.email,
    username: input.username,
    role: 'user',
    capabilities: []
  };
  mockUsers.push(created);
  currentUser = created;
  return created;
}

export async function login(input: { email: string; password: string }): Promise<User> {
  await delay();
  const user = mockUsers.find((u) => u.email === input.email);
  if (!user) throw new Error('User not found in mock environment.');
  currentUser = user;
  return user;
}

export async function me(): Promise<User> {
  await delay(120);
  return currentUser;
}

export async function listModels(): Promise<ModelRecord[]> {
  await delay();
  return mockModels;
}

export async function listMyModels(): Promise<ModelRecord[]> {
  await delay();
  return mockModels.filter(
    (m) => m.owner_user_id === currentUser.id || currentUser.role === 'admin'
  );
}

export async function createModel(payload: Pick<ModelRecord, 'name' | 'description' | 'visibility'>): Promise<ModelRecord> {
  await delay();
  if (!(currentUser.role === 'admin' || currentUser.capabilities.includes('manage_models'))) {
    throw new Error('No permission to create models.');
  }
  const created: ModelRecord = {
    id: `m-${mockModels.length + 1}`,
    name: payload.name,
    description: payload.description,
    visibility: payload.visibility,
    owner_user_id: currentUser.id,
    status: 'draft'
  };
  mockModels.push(created);
  return created;
}

export async function listAttachments(): Promise<AttachmentItem[]> {
  await delay(100);
  return [...mockAttachments];
}

export async function uploadAttachment(filename: string): Promise<AttachmentItem> {
  const uploaded: AttachmentItem = { id: `a-${Date.now()}`, filename, status: 'uploading' };
  mockAttachments.unshift(uploaded);
  await delay(300);
  uploaded.status = 'processing';
  await delay(300);
  uploaded.status = 'ready';
  return uploaded;
}

export async function removeAttachment(id: string): Promise<void> {
  await delay(120);
  const idx = mockAttachments.findIndex((x) => x.id === id);
  if (idx >= 0) mockAttachments.splice(idx, 1);
}
