-- Round 1 schema baseline for mock-closed prototype

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  model_type TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'public')),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'rejected', 'published', 'deprecated')
  ),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users (id)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'archived')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (model_id) REFERENCES models (id),
  FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

CREATE TABLE file_attachments (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'processing', 'ready', 'error')),
  owner_user_id TEXT NOT NULL,
  attached_to_type TEXT NOT NULL CHECK (attached_to_type IN ('Conversation', 'Model')),
  attached_to_id TEXT,
  upload_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users (id)
);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  review_notes TEXT,
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (model_id) REFERENCES models (id),
  FOREIGN KEY (requested_by) REFERENCES users (id),
  FOREIGN KEY (approved_by) REFERENCES users (id)
);

CREATE INDEX idx_models_owner_status ON models (owner_user_id, status);
CREATE INDEX idx_conversations_model_status ON conversations (model_id, status);
CREATE INDEX idx_messages_conversation_created ON messages (conversation_id, created_at);
CREATE INDEX idx_file_attachments_target ON file_attachments (attached_to_type, attached_to_id);
CREATE INDEX idx_approval_requests_status_requested_at ON approval_requests (status, requested_at);
