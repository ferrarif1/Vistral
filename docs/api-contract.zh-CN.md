# API 合同（中文版）

## 概述
定义认证、用户、模型、会话等接口的最小可实现合同。

## 认证
原型阶段使用 Cookie Session：
- `HttpOnly` 会话 Cookie：`vistral_session`
- 变更类请求（`POST/PUT/PATCH/DELETE`）需携带 `X-CSRF-Token`
- 用户显式退出登录后，受保护接口会继续返回 `401`，直到再次登录

## 统一返回
成功：
```json
{ "success": true, "data": {} }
```
失败：
```json
{ "success": false, "error": { "code": "", "message": "" } }
```

校验基线：
- 请求体 JSON 语法不合法（如截断/拼接错误）时，必须返回 `400 VALIDATION_ERROR`，不能返回 `500 INTERNAL_ERROR`

## 认证接口

### POST /auth/register
兼容性保留接口。公开自助注册已关闭。

说明：
- 该接口仅用于给旧客户端返回“公开注册已关闭”的明确错误
- 新账号只能由管理员在已登录的设置/管理界面中开通

请求体：
```json
{
  "username": "username",
  "password": "secure_password"
}
```

### POST /auth/login
登录并绑定会话 Cookie（用户名+密码）。

规则：
- 被停用账号会返回明确的“账号已停用”错误，不会建立新的已认证会话
- 请求体必须是 JSON 对象，且 `username`、`password` 都必须是非空字符串；不合法返回 `400 VALIDATION_ERROR`

### POST /auth/logout
退出当前登录会话。

说明：
- 会清除当前已认证会话
- 服务端会保留匿名的“已退出”会话，因此 `/api/users/me` 等受保护接口会持续返回 `401`，直到用户再次登录

### GET /auth/csrf
获取当前会话的 CSRF token。

### GET /users/me
获取当前会话用户。

说明：
- 当当前浏览器会话已显式退出登录、不再绑定已认证用户时，返回 `401`

### POST /users/me/password
修改当前登录用户密码。

请求体：
```json
{
  "current_password": "current_password",
  "new_password": "new_password"
}
```

规则：
- 所有已认证用户都可调用
- `current_password` 必须与当前密码匹配
- `new_password` 必须满足最小密码长度规则
- 请求体必须是 JSON 对象，且 `current_password`、`new_password` 都必须是非空字符串；不合法返回 `400 VALIDATION_ERROR`

## 管理员用户管理接口

### GET /admin/users
获取用户列表（仅管理员）。

规则：
- 仅 `admin`
- 响应中不得返回密码哈希或任何敏感密钥材料
- 每个用户记录至少包含 `role`、`status`、`status_reason`、`created_at`、`updated_at` 和 `last_login_at`

### POST /admin/users
管理员开通新账号。

请求体：
```json
{
  "username": "new-user",
  "password": "secure_password",
  "role": "user"
}
```

规则：
- 仅 `admin`
- `role` 只能是 `user` 或 `admin`
- 服务端按角色自动分配默认 `capabilities`
- 重名用户名必须拒绝
- 请求体必须是 JSON 对象，且 `username`、`password` 都必须是非空字符串；不合法返回 `400 VALIDATION_ERROR`

### POST /admin/users/{id}/password-reset
管理员重置其他用户密码。

请求体：
```json
{
  "new_password": "new_password"
}
```

规则：
- 仅 `admin`
- 目标用户必须存在
- `new_password` 必须满足最小密码长度规则
- 请求体必须是 JSON 对象，且 `new_password` 必须是非空字符串；不合法返回 `400 VALIDATION_ERROR`

### POST /admin/users/{id}/status
停用或恢复账号。

请求体：
```json
{
  "status": "disabled",
  "reason": "待确认异常凭证共享风险"
}
```

规则：
- 仅 `admin`
- `status` 只能是 `active` 或 `disabled`
- 当 `status=disabled` 时，`reason` 去除首尾空白后不能为空
- 当 `status=active` 时，`reason` 会被忽略，并清空已记录的停用原因
- 系统必须拒绝停用当前管理员会话
- 系统必须拒绝停用最后一个仍为激活状态的管理员账号
- 被停用用户在恢复前不得新建认证会话，也不得继续访问受保护接口
- 停用用户时，必须立即终止该用户现有认证会话；这些会话后续应表现为已退出登录（`401`），而不是保留半失效状态
- 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`

## 权限边界（最小 v1）
- 系统角色仅 `user` / `admin`。
- `user`：可使用公开模型，且仅管理自有/被授权模型。
- `admin`：可进行审批、审计、用户管理与全局治理。
- 所有权字段：`models.owner_user_id`。
- 能力字段示例：`user.capabilities` 包含 `manage_models`。

## 模型接口（摘要）
- `GET /models` 列表
- `POST /models` 创建（需 ownership/capability 校验）
- `GET /models/{id}` 详情
- `PUT /models/{id}` 更新（仅 owner/authorized/admin）
- `DELETE /admin/models/{id}` 管理员删除符合条件的模型
- `POST /models/{id}/publish` 提交发布（进入审批）

`DELETE /admin/models/{id}` 规则：
- 仅 `admin`
- 基座/基础模型目录中的整理模型属于受保护记录，不允许删除
- 若目标模型仍被任一 `ModelVersion` 或 `Conversation` 引用，则必须阻止删除
- 删除成功后，还需一并清理模型作用域附件与关联审批请求
- 删除成功必须写入审计日志

## 管理接口补充
- `GET /audit/logs`：审计日志（仅 admin）
- `GET /admin/verification-reports`：部署验收报告列表（仅 admin）
- `POST /models/draft`：创建模型草稿
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `name` 必须是非空字符串
  - `model_type` 必须是 `ocr|detection|classification|segmentation|obb` 之一
  - `visibility` 必须是 `private|workspace|public` 之一
- `POST /approvals/submit`：提交审批请求
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `model_id` 必须是非空字符串
  - `parameter_snapshot` 可省略；缺失或格式不合法时后端会归一化为 `{}`
  - `review_notes` 若提供，必须是字符串
  - `review_notes: null` 视为类型错误，返回 `400 VALIDATION_ERROR`
- `POST /approvals/{id}/approve`：审批通过
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `notes` 可选；若提供会做去空白归一化
  - `notes` 若提供，必须是字符串
  - `notes: null` 视为类型错误，返回 `400 VALIDATION_ERROR`
- `POST /approvals/{id}/reject`：拒绝审批请求
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `reason` 必须是非空字符串
  - `notes` 若提供，必须是字符串
  - `notes: null` 视为类型错误，返回 `400 VALIDATION_ERROR`

## 会话接口（补充）
- `GET /conversations`：会话列表
- `POST /conversations/start`：发起会话
- `POST /conversations/message`：会话追加消息
- `GET /conversations/{id}`：会话详情（含消息）
- `PATCH /conversations/{id}`：重命名会话标题（owner/admin）
- `DELETE /conversations/{id}`：删除会话（owner/admin）

说明：
- `attachment_ids` 会按客户端传入顺序保留，用作该条消息的附件上下文顺序。
- `attachment_ids` 为可选字段；当缺失或格式不合法时，后端会自动归一化为 `[]`，不会因为该字段导致会话请求失败。
- 上述 `attachment_ids` 可选归一化规则同时适用于 `start` 与 `message` 两个接口。
- `start` 接口要求 `model_id` 与 `initial_message` 为非空字符串；不合法请求返回 `400 VALIDATION_ERROR`。
- `message` 接口要求 `conversation_id` 与 `content` 为非空字符串；不合法请求返回 `400 VALIDATION_ERROR`。
- 助手消息可返回可选 `metadata.conversation_action`，用于表示对话内真实操作执行状态

`PATCH /conversations/{id}` 请求体：
```json
{
  "title": "Invoice Batch Review"
}
```

约束：
- `title` 去空格后不能为空
- 标题长度 1-120
- 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`

`DELETE /conversations/{id}` 约束：
- 会话必须存在，且当前用户对该会话有可见/可操作权限
- 后端会删除该会话记录以及其下全部消息
- 同时清理绑定在该会话 id 上的会话作用域附件
- 返回结构：`{ "success": true, "data": { "deleted": true } }`

对话内真实操作补充说明：
- 助手可在同线程内解析并执行：
  - `create_dataset`
  - `create_model_draft`
  - `create_training_job`
  - `run_model_inference`（当消息含附件且命中推理意图时，自动用当前会话模型最近已注册版本执行推理）
- 当 `run_model_inference` 返回非真实来源标记（`*fallback*` / `*template*` / `*mock*` / `base_empty`）时，助手摘要必须显式提示“当前为回退/模板结果，非真实推理”，并可附带 `action_links` 引导到推理验证 / Runtime 设置页面。
- 缺关键字段时，返回 `metadata.conversation_action.status=requires_input`
- `metadata.conversation_action` 可选返回 `action_links`（`[{label, href}]`），用于前端渲染直达工作区的操作卡片
- 高风险变更操作（`create_*` 及控制台桥接中的 mutating/high-risk API）必须先显式确认；会返回 `missing_fields=["confirmation"]` + `requires_confirmation=true`
- 若 pending action metadata 已存在 `confirmation_phrase`，后续确认必须精确匹配该口令（做 trim/大小写/末尾标点归一后匹配；仅回复 yes 不算确认）
- 若 pending action 已有确认上下文，后续补参轮次应保持同一个 `confirmation_phrase`（不得在中英文口令间漂移）
- 支持高级控制台桥接：用户可通过 `/ops {json}` 在会话里直连控制台 API
  - `/ops {json}` payload 在执行前会做参数校验；缺少桥接必填参数时，返回 `requires_input` + `missing_fields`，并支持后续只补缺失字段继续执行
  - 常见自然语言意图也会路由到同一 bridge（如“查看训练任务”“导出 d-12 的 OCR 标注”“取消训练任务 tj-101”）
  - 支持 `api`：
    - 读取类：`list_datasets`、`list_models`、`list_model_versions`、`list_training_jobs`、`list_inference_runs`、`list_dataset_annotations`
    - 执行类：`run_inference`、`create_dataset_version`、`export_dataset_annotations`
    - 变更/高风险：`create_dataset`、`create_model_draft`、`create_training_job`、`register_model_version`、`submit_approval_request`、`send_inference_feedback`、`cancel_training_job`、`retry_training_job`、`upsert_dataset_annotation`、`review_dataset_annotation`、`import_dataset_annotations`、`run_dataset_pre_annotations`、`activate_runtime_profile`、`auto_configure_runtime_settings`
      - `auto_configure_runtime_settings` 参数：可选 `overwrite_endpoint`（boolean，默认 `false`）
  - `run_dataset_pre_annotations` 的 bridge 参数语义为 `dataset_id + model_version_id`（兼容 legacy `source_model_version_id`，服务端会内部归一化）
- 执行成功时，返回 `metadata.conversation_action.status=completed`
- 执行失败或用户取消时，返回 `failed` / `cancelled`

## 需求草稿接口（补充）
- `POST /task-drafts/from-requirement`：根据需求文本生成任务草稿
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `description` 必须是非空字符串

## 训练任务接口（补充）

### POST /training/jobs
创建训练任务。

请求体示例：
```json
{
  "name": "ocr-finetune-april",
  "task_type": "ocr",
  "framework": "paddleocr",
  "dataset_id": "d-1",
  "dataset_version_id": "dv-1",
  "base_model": "paddleocr-PP-OCRv4",
  "config": {
    "epochs": 20,
    "batch_size": 16,
    "learning_rate": 0.001
  }
}
```

规则：
- 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
- `name`、`dataset_id`、`dataset_version_id`、`base_model` 必须是非空字符串
- `task_type` 必须是 `ocr|detection|classification|segmentation|obb` 之一
- `framework` 必须是 `paddleocr|doctr|yolo` 之一
- 新建训练任务时，`dataset_version_id` 必填
- `dataset_version_id` 必须属于所选 `dataset_id`
- 所选数据集必须已处于 `ready`
- 所选数据集版本的 `split_summary.train` 必须大于 0，确保训练有可用训练切分（该计数按“可训练视觉样本”计算，不包含导入辅助 txt/json 文件）
- 所选数据集版本的 `annotation_coverage` 必须大于 0
- `config` 可选；后端会把非字符串基础类型值归一化为字符串后持久化

## 标注接口（补充）
- `GET /datasets/{datasetId}/annotations`：获取该数据集标注列表（每条记录附带 `latest_review`）
- `POST /datasets/{datasetId}/annotations`：创建或更新标注
- `POST /datasets/{datasetId}/annotations/{annotationId}/submit-review`：提交审核，进入 `in_review`
- `POST /datasets/{datasetId}/annotations/{annotationId}/review`：审核通过或拒绝

`POST /datasets/{datasetId}/annotations` 规则：
- 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
- `dataset_item_id` 必须是非空字符串，`task_type/source/status` 必须是合法枚举，`payload` 必须是对象
- 新建标注时，`status` 只能从 `unannotated`、`in_progress` 或 `annotated` 起步
- 只有处于草稿/可编辑状态（`unannotated`、`in_progress`、`annotated`）的记录允许通过该接口直接保存
- 条目进入 `in_review` 后，在该接口下应视为只读；审核流转必须走 `/review`
- `rejected` 记录必须先回到 `in_progress`，之后才允许继续编辑
- `approved` 记录在该接口下为只读

`POST /datasets/{datasetId}/annotations/{annotationId}/review` 请求体示例：
```json
{
  "status": "rejected",
  "review_reason_code": "polygon_issue",
  "quality_score": 0.51,
  "review_comment": "Polygon needs cleaner boundary."
}
```

规则：
- 当 `status=rejected` 时，`review_reason_code` 必填
- 允许值：`box_mismatch`、`label_error`、`text_error`、`missing_object`、`polygon_issue`、`other`
- 当 `status=approved` 时，`review_reason_code` 必须省略或为 `null`
- 返回中的 `latest_review` 会保留最近一次审核原因/备注，便于返工阶段持续展示
- 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
- `status` 只能是 `approved` 或 `rejected`，`quality_score`（若提供）必须是有限数字或 `null`

## 数据集接口（补充）
- `POST /datasets`
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `name` 必须是非空字符串，`task_type` 必须是合法任务枚举
- `POST /datasets/{id}/items`
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `attachment_id` 与 `filename` 至少提供一个
- `PATCH /datasets/{id}/items/{item_id}`
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
- `POST /datasets/{id}/split`
  - 请求体必须是 JSON 对象，且 `train_ratio/val_ratio/test_ratio/seed` 都必须是有限数字；不合法返回 `400 VALIDATION_ERROR`
- `POST /datasets/{id}/versions`
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `version_name` 若提供，必须是字符串
- `POST /datasets/{id}/import`、`POST /datasets/{id}/export`
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `format` 必须是 `yolo|coco|labelme|ocr` 之一
- `POST /datasets/{datasetId}/pre-annotations`
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `model_version_id` 若提供，必须是字符串

## 推理反馈接口（补充）

### POST /inference/runs
创建推理运行。

规则：
- 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
- `model_version_id` 与 `input_attachment_id` 必须是非空字符串
- `task_type` 必须是 `ocr|detection|classification|segmentation|obb` 之一

### POST /inference/runs/{id}/feedback
将推理错样回流到数据集。

请求体示例：
```json
{
  "dataset_id": "d-2",
  "reason": "missed_detection"
}
```

规则：
- 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
- `dataset_id` 必须是非空字符串
- `reason` 为可选字段；缺失或空字符串时后端会归一化为 `feedback`
- 服务端会将 `inference_runs.feedback_dataset_id` 绑定到目标数据集
- 目标数据集 `task_type` 必须与推理任务 `task_type` 一致，不一致时返回校验错误
- 若输入附件已属于目标数据集，则复用该附件；否则在目标数据集作用域复制附件并写入数据集条目
- 同一个 `run + dataset` 重复提交应保持幂等（更新元数据而非重复建条目）

## LLM 设置接口
- `GET /settings/llm`：获取当前用户保存的 LLM 配置视图
  - 不返回明文 API key，只返回 `has_api_key` 与 `api_key_masked`

- `POST /settings/llm`：保存或更新当前用户的 LLM 配置
  - 请求体包含：
    - `llm_config.enabled`
    - `llm_config.provider`
    - `llm_config.base_url`
    - `llm_config.api_key`
    - `llm_config.model`
    - `llm_config.temperature`
    - `keep_existing_api_key`
  - 规则：
    - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
    - `llm_config` 对象必填
    - 当 `keep_existing_api_key=true` 且 `llm_config.api_key` 为空时，服务端保留当前已加密存储的 key
    - 响应仍返回 masked 视图
    - `keep_existing_api_key` 若提供，必须是布尔值

- `DELETE /settings/llm`：清空当前用户保存的 LLM 配置

- `POST /settings/llm/test`：测试当前用户 LLM 连通性
  - 请求体支持：
    - `llm_config`
    - `use_stored_api_key`
  - 规则：
    - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
    - `llm_config` 对象必填
    - 当 `use_stored_api_key=true` 且 `llm_config.api_key` 为空时，服务端复用当前用户已保存的加密 key 做测试
    - 响应返回提供商短预览文本
    - `use_stored_api_key` 若提供，必须是布尔值

## Runtime 设置接口
- `GET /settings/runtime`：获取已保存 runtime 配置视图
  - 仅管理员可访问
  - API key 只返回掩码信息（`has_api_key`、`api_key_masked`）
  - 模型级 API key 也只返回掩码元信息（`model_api_keys_meta`）
  - `model_api_keys_meta` 同时返回该绑定 key 的策略/计数字段：
    - `expires_at`
    - `expires_status`（`none` | `healthy` | `within_7_days` | `within_3_days` | `expired`）
    - `expires_in_days`（数字或 `null`）
    - `max_calls`
    - `used_calls`
    - `remaining_calls`
    - `is_expired`
  - 返回各 framework 的 `endpoint`、`default_model_id`、`default_model_version_id`、`local_model_path`、`local_train_command`、`local_predict_command`
  - 当环境变量未设置时，`controls.python_bin` 默认按平台返回（POSIX=`python3`，Windows=`python`）
  - 当 `VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS` 未设置（默认 `true`）时，空的本地命令字段会自动填充为内置 runner 模板（`{{python_bin}} .../scripts/local-runners/*`）
  - 当存在已知本地模型候选时，空的 `local_model_path` 也可自动补齐（例如 `.data/runtime-models/yolo11n.pt`）
  - 如需保留空命令，可设置 `VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS=0`
  - 额外返回 `controls`：
    - `python_bin`
    - `disable_simulated_train_fallback`
    - `disable_inference_fallback`

- `POST /settings/runtime`：保存或更新 runtime 配置
  - 请求体包含：
    - `runtime_config.paddleocr|doctr|yolo.endpoint`
    - `runtime_config.paddleocr|doctr|yolo.api_key`
    - `runtime_config.paddleocr|doctr|yolo.default_model_id`
    - `runtime_config.paddleocr|doctr|yolo.default_model_version_id`
    - `runtime_config.paddleocr|doctr|yolo.model_api_keys`
    - `runtime_config.paddleocr|doctr|yolo.model_api_key_policies`
    - `runtime_config.paddleocr|doctr|yolo.local_model_path`
    - `runtime_config.paddleocr|doctr|yolo.local_train_command`
    - `runtime_config.paddleocr|doctr|yolo.local_predict_command`
    - `runtime_controls.python_bin`
    - `runtime_controls.disable_simulated_train_fallback`
    - `runtime_controls.disable_inference_fallback`
    - `keep_existing_api_keys`
  - 规则：
    - 仅管理员可访问
    - 当 `keep_existing_api_keys=true` 且某 framework 的 `api_key` 为空时，保留该 framework 已保存 key
    - 当 `keep_existing_api_keys=true` 且 `model_api_keys` 某绑定值为空时，保留该绑定已保存 key
    - `model_api_keys` 键格式：
      - `model:<model_id>`：模型级 key
      - `model_version:<model_version_id>`：模型版本级 key
    - `model_api_key_policies` 是可选对象，键仍为 `model:*` / `model_version:*`，值字段包括：
      - `api_key`（字符串）
      - `expires_at`（ISO 时间字符串或 `null`）
      - `max_calls`（数字或 `null`）
      - `used_calls`（非负数字）
      - `last_used_at`（ISO 时间字符串或 `null`）
    - 远程推理鉴权 key 解析顺序：`model_version` 绑定 > `model` 绑定 > framework 级 `api_key`
    - 命中模型/模型版本绑定策略后，调用前会执行硬门禁：
      - `expires_at <= now` 视为过期，直接失败
      - `used_calls >= max_calls` 视为额度耗尽，直接失败
    - 服务端会计算并返回 `model_api_keys_meta.expires_status` / `expires_in_days` 供 UI 分级预警：
      - `none`：未配置过期时间
      - `healthy`：过期时间距现在超过 7 天
      - `within_7_days`：过期时间在 4-7 天内
      - `within_3_days`：过期时间在 1-3 天内
      - `expired`：已过期
    - 命中模型/模型版本绑定且远程推理成功后，会自动递增该绑定的 `used_calls`，并更新 `last_used_at`
    - 本地模式/本地命令执行不依赖 API key，使用显式 `model_id` / `model_version_id`
    - 当 `VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS` 启用（默认）时，空的 `local_train_command` / `local_predict_command` 会自动填充为内置 runner 模板
    - `runtime_config.<framework>.local_model_path` 为可选字段，可保存 real local 分支使用的本地权重/模型资源路径（例如 YOLO 基座权重）
    - `runtime_controls.python_bin` 可覆盖内置 runner 的 Python 执行命令（`{{python_bin}}` 占位）
    - 当 `runtime_controls.python_bin` 配置为不存在的本地路径时，适配器应自动回退到可用解释器候选（`.data/runtime-python/.venv`，再到 PATH 中的 `python3/python`），而不是直接 `ENOENT` 失败
    - `runtime_controls.disable_simulated_train_fallback=true` 时，训练命令不可用将直接失败（不再 simulated 回退）
    - `runtime_controls.disable_inference_fallback=true` 时，推理命令/端点失败将直接报错（不再返回 template/fallback 结果）
    - 响应返回 masked 视图（不含明文 key）
    - 字段类型必须严格匹配：
      - `runtime_config` 与 `runtime_controls`（若提供）必须是对象
      - `keep_existing_api_keys`（若提供）必须是布尔值
      - `runtime_config.<framework>.model_api_keys`（若提供）必须是对象，且 value 必须为字符串
      - `runtime_config.<framework>.model_api_key_policies`（若提供）必须是对象
      - `runtime_config.<framework>.model_api_key_policies.<binding>.api_key`（若提供）必须是字符串
      - `runtime_config.<framework>.model_api_key_policies.<binding>.expires_at`（若提供）必须是字符串或 `null`
      - `runtime_config.<framework>.model_api_key_policies.<binding>.max_calls`（若提供）必须是数字或 `null`
      - `runtime_config.<framework>.model_api_key_policies.<binding>.used_calls`（若提供）必须是数字
      - `runtime_config.<framework>.model_api_key_policies.<binding>.last_used_at`（若提供）必须是字符串或 `null`
      - `runtime_controls.python_bin`（若提供）必须是字符串
      - `runtime_controls.disable_simulated_train_fallback` 与 `runtime_controls.disable_inference_fallback`（若提供）必须是布尔值

- `DELETE /settings/runtime`：清空 UI 保存的 runtime 配置
  - 仅管理员可访问
  - 清空后回到“环境变量兜底”模式，直到下一次 UI 保存
  - 响应返回 masked 视图

- `POST /settings/runtime/activate-profile`：一键激活 runtime profile
  - 请求体：
    - `profile_id`
  - 规则：
    - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
    - `profile_id` 必须是非空字符串
    - 仅管理员可访问

- `POST /settings/runtime/auto-configure`：自动配置 Runtime（优先减少手工设置）
  - 请求体（可选）：
    - `overwrite_endpoint`（布尔，默认 `false`）
  - 规则：
    - 仅管理员可访问
    - 若提供请求体，必须是 JSON 对象
    - `overwrite_endpoint` 若提供，必须是布尔值
    - 当 `VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS` 启用时，会自动补齐空的本地命令模板
    - 当已知本地模型候选存在时，也会自动补齐空的 `local_model_path`
    - 会按 framework 的候选端点列表探测可达性，并写入首个可达端点
    - 默认仅补齐空 endpoint；当 `overwrite_endpoint=true` 时可覆盖已有 endpoint
    - 响应返回与 `GET /settings/runtime` 相同的 masked 视图

- `POST /settings/runtime/generate-api-key`：生成 Runtime API key（用于 endpoint / model / model-version 鉴权绑定）
  - 请求体可选；若提供必须是 JSON 对象
  - 响应示例：
    ```json
    {
      "api_key": "vsk_uH2x8n6a..."
    }
    ```
  - 规则：
    - 仅管理员可访问
    - key 只在本次响应返回一次，前端应提示用户立即复制/保存
    - 该接口只负责生成 key；远端 runtime 服务仍需配置并校验同一 key，鉴权才会生效

- `POST /settings/runtime/revoke-api-key`：撤销已保存的 Runtime API key 绑定（framework 级或 model/model-version 级）
  - 请求体示例（模型版本级）：
    ```json
    {
      "framework": "yolo",
      "binding_key": "model_version:mv-yolo11n"
    }
    ```
  - 请求体示例（framework 级）：
    ```json
    {
      "framework": "yolo",
      "binding_key": "framework"
    }
    ```
  - 规则：
    - 仅管理员可访问
    - 请求体必须是 JSON 对象
    - `framework` 必填，且必须是 `paddleocr|doctr|yolo`
    - `binding_key` 可选：
      - 省略/空字符串/`framework`：撤销该 framework 的 `api_key`
      - `model:<model_id>`：撤销模型级 key
      - `model_version:<model_version_id>`：撤销模型版本级 key
    - 撤销模型/模型版本绑定时，服务端会同时删除：
      - `runtime_config.<framework>.model_api_keys[binding_key]`
      - `runtime_config.<framework>.model_api_key_policies[binding_key]`
    - 响应返回与 `GET /settings/runtime` 相同的 masked 视图

- `POST /settings/runtime/rotate-api-key`：轮换 Runtime API key 并立即持久化（管理员生命周期操作）
  - 请求体示例（模型版本级）：
    ```json
    {
      "framework": "yolo",
      "binding_key": "model_version:mv-yolo11n"
    }
    ```
  - 请求体示例（framework 级）：
    ```json
    {
      "framework": "yolo",
      "binding_key": "framework"
    }
    ```
  - 响应示例：
    ```json
    {
      "api_key": "vsk_...",
      "settings": {
        "updated_at": "2026-04-13T10:00:00.000Z"
      }
    }
    ```
  - 规则：
    - 仅管理员可访问
    - 请求体必须是 JSON 对象
    - `framework` 必填，且必须是 `paddleocr|doctr|yolo`
    - `binding_key` 可选：
      - 省略/空字符串/`framework`：轮换该 framework 的 `api_key`
      - `model:<model_id>`：轮换模型级 key
      - `model_version:<model_version_id>`：轮换模型版本级 key
    - 轮换模型/模型版本绑定时，服务端会同时更新：
      - `runtime_config.<framework>.model_api_keys[binding_key]`
      - `runtime_config.<framework>.model_api_key_policies[binding_key]`
    - 轮换模型/模型版本绑定会重置计数：
      - `used_calls=0`
      - `last_used_at=null`
    - 该绑定原有的 `expires_at` / `max_calls` 会保留
    - 新 key 只在本次响应返回一次，前端应提示用户立即同步到远端 Runtime 鉴权配置

## 文件附件接口（补充）
- `GET /files/conversation`：获取当前用户会话附件列表
- `POST /files/conversation/upload`：上传会话附件
  - 兼容 JSON 文件名模式：
    ```json
    { "filename": "sample.jpg" }
    ```
  - JSON 模式下请求体必须是对象且 `filename` 非空；不合法返回 `400 VALIDATION_ERROR`
  - 推荐 `multipart/form-data`：
    - 字段名 `file`
    - 服务端落盘到 `.data/uploads/conversation`
    - 返回仍为标准 `FileAttachment` JSON 包装
  - 说明：
    - 原型上传接口接受通用二进制文件，包含 BMP 图片及常见图片/文档格式
    - 为保持对话式上传体验顺滑，客户端应在上传前预检大文件，并将单文件控制在约 `120 MB` 以内；更大的请求可能返回 `413`
- `GET /files/model/{modelId}`：模型附件列表
- `POST /files/model/{modelId}/upload`：上传模型附件
  - 兼容 JSON 文件名模式
  - JSON 模式下请求体必须是对象且 `filename` 非空；不合法返回 `400 VALIDATION_ERROR`
  - 推荐 `multipart/form-data`（字段名 `file`）
  - 说明：
    - 单文件建议控制在约 `120 MB` 以内，避免代理/请求体大小限制触发 `413`
- `GET /files/dataset/{datasetId}`：数据集附件列表
- `POST /files/dataset/{datasetId}/upload`：上传数据集附件
  - 兼容 JSON 文件名模式
  - JSON 模式下请求体必须是对象且 `filename` 非空；不合法返回 `400 VALIDATION_ERROR`
  - 推荐 `multipart/form-data`（字段名 `file`）
  - 说明：
    - 单文件建议控制在约 `120 MB` 以内，避免代理/请求体大小限制触发 `413`
- `GET /files/{id}/content`：获取 ready 附件的二进制内容（原始流，不走 JSON envelope，按资源可读范围授权）
  - 读取规则：
    - 管理员始终可读
    - 附件所有者可读
    - 非所有者在具备所绑定资源访问权限时可读：
      - 数据集附件：有该数据集访问权限即可
      - 模型附件：有该模型访问权限即可
      - 会话附件：有该会话访问权限即可
      - 推理附件：有其关联推理运行/模型版本访问权限即可
- `DELETE /files/{id}`：删除附件（所有者范围内）

附件状态：
- `uploading`
- `processing`
- `ready`
- `error`

## 训练与推理接口补充（当前实现）
- 训练任务详情中的 `job` 现在显式返回 `execution_mode`：
  - `simulated`（模拟执行）
  - `local_command`（本地命令执行）
  - `unknown`
- 模型版本注册接口（`POST /model-versions/register`）约束：
  - 请求体必须是 JSON 对象；结构不合法返回 `400 VALIDATION_ERROR`
  - `model_id`、`training_job_id`、`version_name` 必须是非空字符串
  - 仅 `status=completed` 的训练任务可注册
  - `execution_mode=simulated|unknown` 的训练任务必须拒绝注册
  - 对 `execution_mode=local_command` 的任务，若产物摘要出现非真实证据（`mode=template`、存在 `fallback_reason`、或 `training_performed=false`）也必须拒绝注册；仅在显式设置 `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1` 时可放开
  - 对非真实本地执行产物（例如 `mode=template`），应显式携带 `fallback_reason` 与 `training_performed=false`，避免被误判为真实训练输出
- 当 `VISTRAL_RUNNER_ENABLE_REAL` 未被显式关闭（`0/false/no/off/disabled`；部署默认可保持 `auto`）时，内置本地 runner 模板会优先尝试依赖驱动的真实执行；只有依赖/模型不可用时才返回带明确 `fallback_reason` 的 template 结果
- OCR 本地训练 runner 允许在 `metrics.json` 与 `artifact_summary` 中附带额外的 OCR 风格指标键（例如 `norm_edit_distance`、`word_accuracy`），同时保持训练任务详情接口外层结构不变
- 新增 `GET /training/jobs/{id}/metrics-export`：
  - 返回任务指标导出 JSON（`latest_metrics` + `metrics_by_name` 序列）
  - 供训练详情页下载排障
  - 支持 `?format=csv`，返回 CSV 下载（`training_job_id, metric_name, step, metric_value, recorded_at`）
- 运行时适配器行为约束：
  - `evaluate()`：优先读取训练工作目录中的真实指标产物（如 `metrics.json`）；没有可评估产物时返回空指标，而不是按任务名猜测固定值。
  - `export()`：必须生成真实本地导出文件路径（可配置根目录），禁止返回伪路径（如 `/mock-artifacts/...`）。
  - `load_model()`：必须先校验模型产物存在，再返回 handle；产物缺失时应显式失败，禁止伪成功。
  - 远程推理鉴权 key 解析顺序：
    1. `runtime_config.<framework>.model_api_keys["model_version:<model_version_id>"]`
    2. `runtime_config.<framework>.model_api_keys["model:<model_id>"]`
    3. `runtime_config.<framework>.api_key`
- 推理结果显式返回 `execution_source`，用于 UI/审计中的“真实执行 vs 降级模式”展示：
  - `<framework>_runtime`
  - `<framework>_local_command`
  - `<framework>_runtime_fallback`
  - `<framework>_local_command_fallback`
  - `explicit_fallback_runtime_failed`
  - `explicit_fallback_local_command_failed`
  - `base_empty`

- template 模式标记规则：
  - 当本地 runner 返回 `raw_output.meta.mode=template` 时，即使 `source` 是 `<framework>_local_command`，前端也必须按“非真实结果”处理并提示。
  - template 模式下，后端会把 `meta.fallback_reason` 同步写入 `raw_output.local_command_fallback_reason`，便于 API 调用方统一读取回退原因字段。

- `execution_source` 归一化规则：
  - 基础来源来自已保存来源标记 / `normalized_output.source`
  - 若存在回退证据，且基础来源本身不是显式 fallback/template/mock/base-empty，后端会给 `execution_source` 追加 `_fallback` 后缀（例如 `yolo_local_command_fallback`、`paddleocr_runtime_fallback`）
  - 回退证据至少包括：显式 fallback reason 字段、`raw_output.meta.mode=template`

- OCR 回退安全规则：
  - 当本地命令或 runtime 调用失败并触发回退时，OCR 返回必须为：
    - `ocr.lines = []`
    - `ocr.words = []`
  - 不允许注入看起来像真实业务数据的默认文本。

- 通用回退安全规则：
  - 当 runtime/local command 硬失败并进入显式回退时，各任务结构化输出默认应为空数组（`boxes`、`rotated_boxes`、`polygons`、`masks`、`labels`、`ocr.lines`、`ocr.words`），除非 runtime/local command 实际返回了这些信号。

- 本地命令执行规则：
  - 优先直接执行 Python 脚本，不依赖 `bash -c`。
  - 当解析出的 `python_bin` 是路径型值但路径不存在时，后端应跳过该候选并继续尝试下一个解释器候选（`.data/runtime-python/.venv`，再到 PATH 命令），之后才允许进入显式 fallback 输出。
  - shell 回退必须跨平台（Windows 使用 `ComSpec/cmd.exe`，POSIX 使用 `${SHELL}` 或 `/bin/sh`）。
  - 支持 `VISTRAL_BASH_PATH` 覆盖 shell 路径。
  - spawn 失败信息需包含 `platform / attempted_command / shell_path`（若存在）。
- 新增 `POST /admin/training-workers/{id}/activate`：
  - 仅管理员可调用
  - 激活前会再次执行 worker 回调连通性校验
  - 会同时读取 worker `healthz` 的兼容性信号（`worker_version`、`contract_version`、`runtime_profile`、`capabilities`）
  - 校验成功后将 worker 置为 `online`，并同步更新关联 bootstrap session（若存在）
  - 若出现硬不兼容（例如 runtime profile 不匹配），激活按失败处理并保持 `validation_failed`
  - 校验失败则返回错误，并保持 worker/session 不可调度状态（`offline` / `validation_failed`）
  - bootstrap session 会返回 `compatibility` 字段，便于前端显示 `compatible | warning | incompatible | unknown`
- 新增 `POST /admin/training-workers/{id}/reconfigure-session`：
  - 仅管理员可调用
  - 基于已有 worker 生成新的引导式重配会话（bootstrap session）
  - 不会删除或替换已有 worker 记录，仅用于升级/重配流程
- 新增 `GET /runtime/metrics-retention`：
  - 返回当前用户可见训练任务范围内的指标保留摘要
  - 包含 `max_points_per_job`、`max_total_rows`、`current_total_rows`、`near_total_cap`、`top_jobs`
  - 用于运行时页面查看指标保留占用情况
- 新增 `GET /runtime/readiness`：
  - 仅管理员可访问
  - 返回 runtime 就绪度摘要（python 可执行探测、严格模式、各 framework 端点/本地命令准备度、问题列表）
  - 当端点不可用且 framework 走 bundled 本地 runner 时，后端会额外探测 Python 依赖（`paddleocr` / `doctr` / `ultralytics`），缺失时直接写入 issues
  - 当 framework 配置了 `local_model_path` 时，后端还会校验该路径是否真实存在；不存在会直接写入 issues
  - 当 YOLO 既没有可用 endpoint、也没有可解析的本地模型路径时，会给出 warning，提示 real local 训练/推理仍可能回退
  - 当端点不可用且 framework 使用自定义 local command 时，后端会探测命令可执行入口：
    - 检查命令可执行路径/命令是否可解析
    - 校验 `{{python_bin}}` 占位是否能被解析
    - train/predict 任一探测失败都会写入对应 framework 的 issues
  - `issues` 可选附带 `remediation` 字段，用于前端展示可复制的修复建议
  - `issues` 也可选附带 `remediation_command` 字段，用于前端展示可直接复制执行的命令
  - 返回会包含 `bootstrap_assets`，用于展示本地引导资源状态（例如 docTR 预置目录、期望文件与缺失文件清单）
  - `bootstrap_assets[*].expected_files` 结构：
    - `name`: 文件名
    - `present`: 文件是否存在且大小有效
    - `byte_size`: 文件字节数（缺失时为 `null`）
  - `bootstrap_assets[*].missing_files` 为缺失文件名列表，便于页面给出一键修复步骤
  - 用于 Runtime 设置页面在部署后直接展示“可运行 / 降级 / 不可运行”状态与阻塞项
  - 不返回 API key 等敏感信息
- Worker 请求体验证补充：
  - `POST /admin/training-workers/bootstrap-sessions`：请求体必须是 JSON 对象；`deployment_mode`、`worker_profile` 必须是合法枚举，`control_plane_base_url` 必填
  - `POST /admin/training-workers` / `PATCH /admin/training-workers/{id}`：请求体必须是 JSON 对象；`status`（若提供）必须是 `online|offline|draining`，`max_concurrency`（若提供）必须是有限数字，`endpoint`（若提供）必须是字符串或 `null`，`enabled`（若提供）必须是布尔，`capabilities`（若提供）必须是字符串数组，`metadata`（若提供）必须是对象
  - `POST /runtime/training-workers/heartbeat`：请求体必须是 JSON 对象；`name` 必填，`status`（若提供）必须是合法枚举，`max_concurrency` 与 `reported_load`（若提供）必须是有限数字（`reported_load` 允许 `null`），`endpoint`（若提供）必须是字符串或 `null`，`enabled`（若提供）必须是布尔，`capabilities`（若提供）必须是字符串数组，`metadata`（若提供）必须是对象

### GET /admin/verification-reports 返回项
```json
{
  "id": "docker-verify-full-20260402223826",
  "filename": "docker-verify-full-20260402223826.json",
  "status": "passed",
  "summary": "full deployment verification succeeded",
  "started_at_utc": "2026-04-02T14:38:26Z",
  "finished_at_utc": "2026-04-02T14:38:31Z",
  "target_base_url": "http://127.0.0.1:8080",
  "business_username": "alice",
  "probe_username": "verify-123",
  "checks_total": 9,
  "checks_failed": 0,
  "checks": [
    {
      "name": "infrastructure health checks",
      "status": "passed",
      "detail": "health endpoints are reachable"
    }
  ],
  "runtime_metrics_retention": {
    "max_points_per_job": 180,
    "max_total_rows": 20000,
    "current_total_rows": 428,
    "visible_job_count": 12,
    "jobs_with_metrics": 9,
    "max_rows_single_job": 90,
    "near_total_cap": false,
    "top_jobs": [
      { "training_job_id": "tj-982", "rows": 90 }
    ]
  },
  "entities": {
    "model_id": "m-1",
    "approval_id": "ar-1"
  }
}
```

说明：
- 仅 `admin` 可访问；普通 `user` 请求应返回失败。
- `status` 取值：`passed` / `failed` / `unknown`。
- 普通 `user` 调用建议返回：`403 + INSUFFICIENT_PERMISSIONS`。
- 当验收报告 JSON 包含该字段时，返回项会带 `runtime_metrics_retention` 摘要。

## 错误码与状态码映射（原型已实现）
- `AUTHENTICATION_REQUIRED` -> `401`
- `INSUFFICIENT_PERMISSIONS` -> `403`
- `CSRF_VALIDATION_FAILED` -> `403`
- `RESOURCE_NOT_FOUND` -> `404`
- `VALIDATION_ERROR` -> `400`
- `PAYLOAD_TOO_LARGE` -> `413`
- `INVALID_STATE_TRANSITION` -> `409`
- `INTERNAL_ERROR` -> `500`

实现说明：
- 后端优先通过错误消息模式归类（权限/资源不存在/状态迁移），由共享错误归一模块实现
- 对未命中模式的边界消息保留显式映射兜底
