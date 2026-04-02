# API Contract

## Overview
This document defines the API contract for the Vistral platform, specifying endpoints, request/response formats, authentication, and error handling for all services.

## Base URL
Production: `https://api.vistral.ai/v1`
Staging: `https://staging-api.vistral.ai/v1`

## Authentication
All API requests require authentication using Bearer tokens:
```
Authorization: Bearer {access_token}
```

API keys can alternatively be used in headers:
```
X-API-Key: {api_key}
```

## Common Headers
- `Content-Type: application/json`
- `Accept: application/json`
- `User-Agent: {client_identifier}`
- `X-Request-ID: {uuid}` (optional, for request tracing)

## Common Response Format
Successful responses follow this pattern:
```json
{
  "success": true,
  "data": { /* resource data */ },
  "meta": { /* pagination, timestamps, etc. */ }
}
```

Error responses follow this pattern:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": { /* optional error details */ }
  }
}
```

## Error Codes
- `AUTHENTICATION_REQUIRED`: 401 - Authentication required
- `INSUFFICIENT_PERMISSIONS`: 403 - Insufficient permissions
- `RESOURCE_NOT_FOUND`: 404 - Resource not found
- `VALIDATION_ERROR`: 422 - Request validation failed
- `RATE_LIMIT_EXCEEDED`: 429 - Rate limit exceeded
- `INTERNAL_ERROR`: 500 - Internal server error
- `SERVICE_UNAVAILABLE`: 503 - Service temporarily unavailable

## Rate Limiting
- Standard endpoints: 1000 requests/hour per API key
- File upload endpoints: 100 requests/hour per API key
- Model inference endpoints: 500 requests/hour per API key
- Custom rate limits available for enterprise accounts

---

## Authentication Endpoints

### POST /auth/login
Authenticate user and retrieve access token

**Request:**
```json
{
  "email": "user@example.com",
  "password": "secure_password"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "access_token": "jwt_token",
    "refresh_token": "refresh_token",
    "user": { /* user object */ },
    "expires_in": 3600
  }
}
```

### POST /auth/register
Register new user account

Registration creates `user` accounts only.
`admin` role assignment is restricted to backend seed/bootstrap or admin-only management endpoints.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "secure_password",
  "username": "username"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "access_token": "jwt_token",
    "user": { /* user object */ }
  }
}
```

### POST /auth/refresh
Refresh access token

**Request:**
```json
{
  "refresh_token": "refresh_token"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "access_token": "new_jwt_token",
    "expires_in": 3600
  }
}
```

---

## User Management Endpoints

### GET /users/me
Get current user profile

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "user_uuid",
    "email": "user@example.com",
    "username": "username",
    "role": "user",
    "capabilities": ["manage_models"],
    "profile_data": {},
    "preferences": {},
    "created_at": "2023-01-01T00:00:00Z",
    "last_login_at": "2023-01-02T00:00:00Z"
  }
}
```

### PUT /users/me
Update current user profile

**Request:**
```json
{
  "username": "new_username",
  "profile_data": { /* updated profile data */ },
  "preferences": { /* updated preferences */ }
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* updated user object */ }
}
```

### GET /users/{id}
Get specific user (administrative only)

**Response:**
```json
{
  "success": true,
  "data": { /* user object */ }
}
```

---


## Authorization Boundaries (Minimum v1)
- System roles are `user` and `admin` only.
- Ownership and capabilities control model-management scope:
  - `user` can read/use public models and manage owned/authorized models.
  - `admin` can review, approve, audit, and perform global governance operations.
- Ownership reference: `models.owner_user_id`.
- Capability example: `user.capabilities` contains `manage_models`.

## Model Management Endpoints

### GET /models
List available models

**Query Parameters:**
- `status`: Filter by status ('published', 'draft', etc.)
- `type`: Filter by model type
- `search`: Search term for name/description
- `limit`: Number of results (default: 20, max: 100)
- `offset`: Offset for pagination

**Response:**
```json
{
  "success": true,
  "data": [
    { /* model objects */ }
  ],
  "meta": {
    "total": 150,
    "limit": 20,
    "offset": 0,
    "has_more": true
  }
}
```

### POST /models
Create new model

**Request:**
```json
{
  "name": "My Visual Model",
  "description": "A model for image classification",
  "model_type": "classification",
  "config": { /* model configuration */ },
  "metadata": { /* additional metadata */ }
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* created model object */ }
}
```

### GET /models/{id}
Get specific model

**Response:**
```json
{
  "success": true,
  "data": { /* model object */ }
}
```

### PUT /models/{id}
Update model

**Request:**
```json
{
  "name": "Updated Model Name",
  "description": "Updated description",
  "config": { /* updated config */ }
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* updated model object */ }
}
```

### DELETE /models/{id}
Delete model (sets status to 'deprecated')

**Response:**
```json
{
  "success": true,
  "data": { /* model object with deprecated status */ }
}
```

### POST /models/{id}/upload
Upload model files

**Request:** (multipart/form-data)
- `file`: Model file
- `part_number`: For multipart uploads
- `upload_id`: For multipart uploads

**Response:**
```json
{
  "success": true,
  "data": {
    "upload_id": "upload_session_id",
    "status": "uploading|complete",
    "file_info": { /* file metadata */ }
  }
}
```

### POST /models/{id}/publish
Publish model (requires approval workflow)

**Response:**
```json
{
  "success": true,
  "data": { /* model object with pending status */ }
}
```

---

## Conversation Endpoints

### GET /conversations
List user conversations

**Query Parameters:**
- `model_id`: Filter by specific model
- `status`: Filter by status ('active', 'completed', 'archived')
- `limit`: Number of results
- `offset`: Offset for pagination

**Response:**
```json
{
  "success": true,
  "data": [
    { /* conversation objects */ }
  ],
  "meta": {
    "total": 50,
    "limit": 20,
    "offset": 0,
    "has_more": true
  }
}
```

### POST /conversations
Start new conversation

**Request:**
```json
{
  "model_id": "model_uuid",
  "initial_message": "Hello, can you analyze this image?",
  "metadata": { /* conversation metadata */ }
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* created conversation object */ }
}
```

### GET /conversations/{id}
Get specific conversation

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "conversation_uuid",
    "title": "Conversation Title",
    "model_id": "model_uuid",
    "messages": [ /* message objects */ ],
    "created_at": "2023-01-01T00:00:00Z",
    "updated_at": "2023-01-01T00:00:00Z"
  }
}
```

### DELETE /conversations/{id}
Archive conversation

**Response:**
```json
{
  "success": true,
  "data": { /* conversation object with archived status */ }
}
```

---

## Message Endpoints

### GET /conversations/{conversation_id}/messages
Get messages from conversation

**Query Parameters:**
- `limit`: Number of messages to return
- `before`: Message ID to fetch messages before
- `after`: Message ID to fetch messages after

**Response:**
```json
{
  "success": true,
  "data": [
    { /* message objects */ }
  ]
}
```

### POST /conversations/{conversation_id}/messages
Send message in conversation

**Request:**
```json
{
  "content": "What can you tell me about this image?",
  "attachments": [
    {
      "file_id": "attachment_uuid",
      "filename": "image.jpg"
    }
  ],
  "metadata": { /* message metadata */ }
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* created message object */ }
}
```

### POST /conversations/{conversation_id}/messages/{message_id}/regenerate
Regenerate model response

**Response:**
```json
{
  "success": true,
  "data": { /* regenerated message object */ }
}
```

---

## File Attachment Endpoints

### POST /files/upload
Upload file for attachment

**Request:** (multipart/form-data)
- `file`: File to upload
- `purpose`: Purpose of upload ('conversation', 'model_upload', 'dataset')

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "file_uuid",
    "filename": "original_filename.jpg",
    "file_path": "/path/to/file",
    "file_size": 1024000,
    "mime_type": "image/jpeg",
    "status": "ready",
    "metadata": { /* file metadata */ }
  }
}
```

### GET /files/{id}
Get file information

**Response:**
```json
{
  "success": true,
  "data": { /* file object */ }
}
```

### DELETE /files/{id}
Delete file

**Response:**
```json
{
  "success": true,
  "data": { /* file object with deleted status */ }
}
```

### GET /files/{id}/download
Download file

**Response:** Raw file content with appropriate Content-Type header

---

## Model Inference Endpoints

### POST /models/{id}/infer
Run inference on model

**Request:**
```json
{
  "inputs": [
    {
      "type": "image",
      "data": "base64_encoded_data_or_file_id"
    }
  ],
  "parameters": { /* inference parameters */ }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "outputs": [ /* inference results */ ],
    "metadata": {
      "inference_time": 1.234,
      "model_version": "1.0.0"
    }
  }
}
```

### POST /models/{id}/chat-infer
Run inference in chat context (for conversation integration)

**Request:**
```json
{
  "message": "Describe this image in detail",
  "context": {
    "conversation_id": "conversation_uuid",
    "previous_messages": [ /* recent message history */ ]
  },
  "attachments": [ /* file attachment IDs */ ],
  "parameters": { /* inference parameters */ }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "response": "Detailed description of the image...",
    "metadata": {
      "confidence": 0.95,
      "processing_time": 2.1
    }
  }
}
```

---

## Approval Workflow Endpoints

### GET /approvals/pending
List pending approval requests (administrative only)

**Response:**
```json
{
  "success": true,
  "data": [
    { /* approval request objects */ }
  ]
}
```

### POST /approvals/{id}/approve
Approve model request

**Request:**
```json
{
  "notes": "Model approved for publication"
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* updated approval request */ }
}
```

### POST /approvals/{id}/reject
Reject model request

**Request:**
```json
{
  "reason": "Model does not meet quality standards",
  "notes": "Please address the issues mentioned..."
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* updated approval request */ }
}
```

---

## Audit and Monitoring Endpoints

### GET /audit/logs
Get audit logs (administrative only)

**Query Parameters:**
- `user_id`: Filter by user
- `action`: Filter by action type
- `entity_type`: Filter by entity type
- `start_date`: Filter by start date
- `end_date`: Filter by end date
- `limit`: Number of results
- `offset`: Offset for pagination

**Response:**
```json
{
  "success": true,
  "data": [
    { /* audit log objects */ }
  ]
}
```

### GET /monitoring/status
Get system status

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "operational",
    "services": {
      "api": "operational",
      "inference": "operational",
      "storage": "operational"
    },
    "timestamp": "2023-01-01T00:00:00Z"
  }
}
```

---

## Webhook Endpoints

### POST /webhooks/model-status
Receive model status updates (internal use)

**Expected Payload:**
```json
{
  "model_id": "model_uuid",
  "status": "training_complete|deployment_failed|health_warning",
  "timestamp": "2023-01-01T00:00:00Z",
  "details": { /* status details */ }
}
```

## Versioning
API version is specified in the URL path (e.g., `/v1/`). Breaking changes will increment the version number. Clients should specify the version they expect to use.

## Testing
- Sandbox environment available at `https://sandbox-api.vistral.ai/v1`
- Test credentials provided for development
- Rate limits may differ in sandbox environment

