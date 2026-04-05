# 数据模型（中文版）

## 概述
平台采用两类系统角色（`user` / `admin`）+ 所有权关系 + 能力字段来实现最小可落地权限模型。

## 访问与所有权语义
- 系统角色仅包含 `user` 与 `admin`。
- `owner` 是资源关系字段（例如 `owner_user_id`），不是角色枚举值。
- 公开自助注册已关闭。
- 新账号只能由管理员在已认证的设置/管理界面中开通。
- 敏感操作同时受角色、所有权和能力字段约束。

## Owner 语义
- `owner` 是资源关系，不是 `User.role` 枚举值。
- 使用 `models.owner_user_id` 表示模型所有者。
- 使用 `user.capabilities` 表示额外能力（如 `manage_models`）。

## 核心实体

### User
- `id`
- `username`
- `password_hash`（scrypt+salt，仅服务端存储，不返回前端）
- `role`：`user` / `admin`
- `status`：`active` / `disabled`
- `status_reason`：可空字符串；当 `status=disabled` 时必须填写，恢复账号时清空
- `capabilities`：JSON 数组
- `last_login_at`（可为空的时间戳）
- `created_at` / `updated_at`

凭据规则：
- 所有已登录用户都可通过 `current_password + new_password` 修改自己的密码
- 管理员可创建新账号，并指定角色为 `user` 或 `admin`
- 管理员可在已登录的账号目录中重置其他用户密码
- 管理员可停用或恢复账号
- 停用账号时必须提供非空管理员原因，并持久化到 `status_reason`
- 被停用账号在恢复前不得登录，也不得继续访问受保护接口
- 停用账号会立即使该账号现有认证会话失效；恢复账号不会自动恢复这些会话
- 恢复账号时会清空 `status_reason`
- 系统会阻止停用当前管理员会话，以及停用最后一个仍为激活状态的管理员账号
- 默认能力由角色决定：
  - `user` => `manage_models`
  - `admin` => `manage_models`、`global_governance`

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
- 附件状态：`uploading | processing | ready | error`
- `Message.metadata` 可选，用于承载结构化对话动作信息
- 助手消息可携带 `metadata.conversation_action`
  - `action`：`create_dataset | create_model_draft | create_training_job`
  - `status`：`requires_input | completed | failed | cancelled`
  - 记录 `missing_fields`、`collected_fields`、可选 `suggestions` 与已创建实体引用，供聊天时间线渲染紧凑执行卡片

### TrainingJob / InferenceRun（补充）
- `training_jobs.dataset_version_id`
  - 训练任务绑定的数据集版本快照
  - 仅为兼容旧数据允许为空；新建训练任务必须保存明确的 `dataset_version_id`
- 训练启动准备约束：
  - 所选数据集必须为 `ready`
  - 所选数据集版本 `split_summary.train > 0`
  - 所选数据集版本 `annotation_coverage > 0`
- `training_jobs.execution_mode`：
  - `simulated`
  - `local_command`
  - `unknown`
- `inference_runs.execution_source`：
  - 保存当前推理来源标记（例如 `yolo_runtime`、`yolo_local_command`、`mock_fallback`）
- 推理反馈规则：
  - `POST /inference/runs/{id}/feedback` 的目标数据集 `task_type` 必须与推理任务 `task_type` 一致
  - 不允许跨任务类型（例如 detection 结果回流到 ocr 数据集）

### Dataset / Annotation（补充）
- `DatasetItem`
  - `split`：`train | val | test | unassigned`
  - `status`：`uploading | processing | ready | error`
- `Annotation`
  - `source`：`manual | import | pre_annotation`
  - `status`：`unannotated | in_progress | annotated | in_review | approved | rejected`
- `AnnotationReview`
  - `status`：`approved | rejected`
  - `review_reason_code`：`box_mismatch | label_error | text_error | missing_object | polygon_issue | other | null`
  - `quality_score`：可空
  - `review_comment`：可空

规则：
- 当 `AnnotationReview.status=rejected` 时，`review_reason_code` 必填
- 当 `status=approved` 时，`review_reason_code=null`
- 标注列表/详情返回的 `latest_review` 需要持续携带最近一次审核上下文，供返工界面显示
- 只有当前仍处于可编辑状态（`unannotated`、`in_progress`、`annotated`）时，才允许通过 upsert 路径直接保存标注
- 条目一旦进入 `in_review`，后续只能通过专用审核接口进入 `approved` 或 `rejected`
- `approved` 在 upsert 路径下保持只读

### ApprovalRequest
- 审批请求主体（提交人、审核人、状态、时间戳）

### AuditLog
- 记录敏感行为与治理动作

## 索引建议
- `User.username`（unique）
- `Model.owner_user_id + status`
- `Message.conversation_id + created_at`
- `AuditLog.user_id + timestamp`
