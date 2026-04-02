# Data Model

## Overview
This document defines the core data models for the Vistral platform, supporting two system roles, ownership-based permissions, model lifecycle management, conversation tracking, and audit capabilities.

## Core Entities

### Owner semantics
- `owner` is a resource relationship (e.g., `models.owner_user_id`), not a `User.role` value.
- Access control combines `role` (`user`/`admin`) and `capabilities` with ownership checks.

### User
Represents all users in the system (users and administrators)

**Attributes:**
- id (UUID, primary key)
- email (string, unique, indexed)
- username (string, unique, indexed)
- role (enum: 'user', 'admin')
- capabilities (JSON array, e.g., ['manage_models'])
- profile_data (JSON object)
- preferences (JSON object)
- created_at (timestamp)
- updated_at (timestamp)
- last_login_at (timestamp)
- is_active (boolean)
- email_verified (boolean)

**Relationships:**
- owns -> Model (one-to-many via ownership relation)
- participates_in -> Conversation (many-to-many)
- manages -> ApprovalRequest (many-to-many as admin)

### Model
Represents visual models managed in the system

**Attributes:**
- id (UUID, primary key)
- name (string)
- description (text)
- version (string)
- status (enum: 'draft', 'pending_approval', 'approved', 'rejected', 'published', 'deprecated')
- model_type (string, e.g., 'classification', 'detection', 'segmentation')
- file_path (string, path to model files)
- config (JSON object, model configuration)
- metadata (JSON object, additional metadata)
- visibility (enum: 'private', 'workspace', 'public')
- owner_user_id (UUID, foreign key to User)
- approved_by (UUID, foreign key to User, nullable)
- approved_at (timestamp, nullable)
- published_at (timestamp, nullable)
- created_at (timestamp)
- updated_at (timestamp)
- last_accessed_at (timestamp)
- usage_count (integer)
- edge_deployments (JSON array, deployment locations)

**Relationships:**
- owner_user -> User (many-to-one)
- approver -> User (many-to-one, nullable)
- conversations -> Conversation (many-to-many)
- training_datasets -> Dataset (many-to-many)
- versions -> ModelVersion (one-to-many)

### Conversation
Represents a conversation thread between user and model

**Attributes:**
- id (UUID, primary key)
- title (string, auto-generated from first message)
- participants (JSON array, user IDs)
- model_id (UUID, foreign key to Model)
- status (enum: 'active', 'completed', 'archived')
- created_at (timestamp)
- updated_at (timestamp)
- last_message_at (timestamp)
- metadata (JSON object)

**Relationships:**
- participants -> User (many-to-many)
- model -> Model (many-to-one)
- messages -> Message (one-to-many)

### Message
Represents individual messages within a conversation

**Attributes:**
- id (UUID, primary key)
- conversation_id (UUID, foreign key to Conversation)
- sender_id (UUID, foreign key to User)
- content (text)
- message_type (enum: 'user_query', 'model_response', 'system_notification', 'file_attachment')
- attachments (JSON array, file metadata)
- response_metadata (JSON object, model response details)
- created_at (timestamp)
- updated_at (timestamp)
- parent_message_id (UUID, foreign key to Message, nullable for threading)

**Relationships:**
- conversation -> Conversation (many-to-one)
- sender -> User (many-to-one)
- parent -> Message (self-referencing, nullable)

### FileAttachment
Represents files attached to conversations or model uploads

**Attributes:**
- id (UUID, primary key)
- filename (string)
- original_filename (string)
- file_path (string)
- file_size (integer, in bytes)
- mime_type (string)
- status (enum: 'uploading', 'processing', 'ready', 'error', 'deleted')
- upload_error (string, nullable)
- uploaded_by (UUID, foreign key to User)
- attached_to_type (string, polymorphic type: 'Message', 'Model')
- attached_to_id (UUID, polymorphic foreign key)
- metadata (JSON object, additional file metadata)
- created_at (timestamp)
- updated_at (timestamp)

**Relationships:**
- uploader -> User (many-to-one)
- attached_entity (polymorphic relationship to Message/Model)

### ApprovalRequest
Represents approval requests for models

**Attributes:**
- id (UUID, primary key)
- model_id (UUID, foreign key to Model)
- requested_by (UUID, foreign key to User)
- approved_by (UUID, foreign key to User, nullable)
- status (enum: 'pending', 'approved', 'rejected')
- rejection_reason (text, nullable)
- review_notes (text, nullable)
- requested_at (timestamp)
- reviewed_at (timestamp, nullable)
- expires_at (timestamp, nullable)

**Relationships:**
- model -> Model (many-to-one)
- requester -> User (many-to-one)
- reviewer -> User (many-to-one, nullable)

### Dataset
Represents training datasets used for model improvement

**Attributes:**
- id (UUID, primary key)
- name (string)
- description (text)
- file_path (string)
- size (integer, in bytes)
- format (string, e.g., 'image_folder', 'coco', 'pascal_voc')
- num_samples (integer)
- created_by (UUID, foreign key to User)
- created_at (timestamp)
- updated_at (timestamp)
- metadata (JSON object)

**Relationships:**
- creator -> User (many-to-one)
- models -> Model (many-to-many)

### AuditLog
Represents system audit logs for compliance and monitoring

**Attributes:**
- id (UUID, primary key)
- user_id (UUID, foreign key to User, nullable for system events)
- action (string, e.g., 'model_created', 'model_approved', 'conversation_started')
- entity_type (string, e.g., 'Model', 'Conversation', 'User')
- entity_id (UUID)
- old_values (JSON object, previous state)
- new_values (JSON object, new state)
- ip_address (string)
- user_agent (string)
- timestamp (timestamp)
- metadata (JSON object)

**Relationships:**
- user -> User (many-to-one, nullable)

### EdgeDeployment
Represents model deployments to edge locations

**Attributes:**
- id (UUID, primary key)
- model_id (UUID, foreign key to Model)
- location (string, edge location identifier)
- status (enum: 'deploying', 'active', 'inactive', 'error')
- deployment_config (JSON object)
- deployed_at (timestamp)
- updated_at (timestamp)
- health_status (JSON object, runtime metrics)
- last_heartbeat (timestamp)

**Relationships:**
- model -> Model (many-to-one)

## Indexes and Constraints

### Performance Indexes
- User.email (unique)
- User.username (unique)
- Model.owner_user_id + status (composite)
- Conversation.model_id + status (composite)
- Message.conversation_id + created_at (composite)
- FileAttachment.attached_to_type + attached_to_id (composite)
- AuditLog.timestamp (descending)
- AuditLog.user_id + timestamp (composite)

### Foreign Key Constraints
- All foreign key relationships enforce referential integrity
- Cascade delete for user-owned models (with soft-delete option)
- Restrict deletion of referenced entities where integrity is critical

## Data Lifecycle

### User Data
- Created during registration
- Updated through profile management
- Soft-deleted rather than hard deletion for audit purposes
- Personal data anonymization after account closure

### Model Data
- Created during model upload process
- Versioned for each update
- Lifecycle: draft → pending_approval → approved → published
- Archived when deprecated rather than deleted

### Conversation Data
- Created when first message is sent
- Maintained for user access and model training
- Automatically archived after period of inactivity
- Exportable for user data portability

### File Data
- Stored securely with access controls
- Retained during active conversation
- Cleaned up after conversation archival
- Temporary files cleaned up after processing

## Security Considerations
- All sensitive data encrypted at rest
- User passwords hashed with bcrypt/scrypt
- File uploads validated and sanitized
- Access control enforced at application layer
- Audit logging for all sensitive operations

## Scalability Considerations
- Large file attachments stored in object storage
- Conversation history partitioned by date/user
- Model binaries stored separately from metadata
- Audit logs archived to separate system after retention period
