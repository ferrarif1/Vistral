# 数据模型（中文版）

## 概述
平台采用两类系统角色（`user` / `admin`）+ 所有权关系 + 能力字段来实现最小可落地权限模型。

## Owner 语义
- `owner` 是资源关系，不是 `User.role` 枚举值。
- 使用 `models.owner_user_id` 表示模型所有者。
- 使用 `user.capabilities` 表示额外能力（如 `manage_models`）。

## 核心实体

### User
- `id`
- `email`
- `username`
- `role`：`user` / `admin`
- `capabilities`：JSON 数组
- `profile_data`
- `preferences`
- `created_at` / `updated_at` / `last_login_at`
- `is_active` / `email_verified`

### Model
- `id`
- `name` / `description` / `version`
- `status`：`draft | pending_approval | approved | rejected | published | deprecated`
- `model_type`
- `file_path`
- `config` / `metadata`
- `visibility`：`private | workspace | public`
- `owner_user_id`
- `approved_by` / `approved_at` / `published_at`
- `created_at` / `updated_at` / `last_accessed_at`
- `usage_count`

### Conversation / Message / FileAttachment
- 会话与消息维持对话上下文
- 附件状态：`uploading | processing | ready | error | deleted`

### ApprovalRequest
- 审批请求主体（提交人、审核人、状态、时间戳）

### AuditLog
- 记录敏感行为与治理动作

## 索引建议
- `User.email`（unique）
- `User.username`（unique）
- `Model.owner_user_id + status`
- `Message.conversation_id + created_at`
- `AuditLog.user_id + timestamp`
