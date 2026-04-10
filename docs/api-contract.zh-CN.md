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

## 会话接口（补充）
- `GET /conversations`：会话列表
- `POST /conversations/start`：发起会话
- `POST /conversations/message`：会话追加消息
- `GET /conversations/{id}`：会话详情（含消息）
- `PATCH /conversations/{id}`：重命名会话标题（owner/admin）

说明：
- `attachment_ids` 会按客户端传入顺序保留，用作该条消息的附件上下文顺序。
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

对话内真实操作补充说明：
- 助手可在同线程内解析并执行：
  - `create_dataset`
  - `create_model_draft`
  - `create_training_job`
- 缺关键字段时，返回 `metadata.conversation_action.status=requires_input`
- 执行成功时，返回 `metadata.conversation_action.status=completed`
- 执行失败或用户取消时，返回 `failed` / `cancelled`

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
- 新建训练任务时，`dataset_version_id` 必填
- `dataset_version_id` 必须属于所选 `dataset_id`
- 所选数据集必须已处于 `ready`
- 所选数据集版本的 `split_summary.train` 必须大于 0，确保训练有可用训练切分（该计数按“可训练视觉样本”计算，不包含导入辅助 txt/json 文件）
- 所选数据集版本的 `annotation_coverage` 必须大于 0

## 标注接口（补充）
- `GET /datasets/{datasetId}/annotations`：获取该数据集标注列表（每条记录附带 `latest_review`）
- `POST /datasets/{datasetId}/annotations`：创建或更新标注
- `POST /datasets/{datasetId}/annotations/{annotationId}/submit-review`：提交审核，进入 `in_review`
- `POST /datasets/{datasetId}/annotations/{annotationId}/review`：审核通过或拒绝

`POST /datasets/{datasetId}/annotations` 规则：
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

## 推理反馈接口（补充）

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
    - 当 `keep_existing_api_key=true` 且 `llm_config.api_key` 为空时，服务端保留当前已加密存储的 key
    - 响应仍返回 masked 视图

- `DELETE /settings/llm`：清空当前用户保存的 LLM 配置

- `POST /settings/llm/test`：测试当前用户 LLM 连通性
  - 请求体支持：
    - `llm_config`
    - `use_stored_api_key`
  - 规则：
    - 当 `use_stored_api_key=true` 且 `llm_config.api_key` 为空时，服务端复用当前用户已保存的加密 key 做测试
    - 响应返回提供商短预览文本

## Runtime 设置接口
- `GET /settings/runtime`：获取已保存 runtime 配置视图
  - 仅管理员可访问
  - API key 只返回掩码信息（`has_api_key`、`api_key_masked`）
  - 返回各 framework 的 `endpoint`、`local_train_command`、`local_predict_command`
  - 额外返回 `controls`：
    - `python_bin`
    - `disable_simulated_train_fallback`
    - `disable_inference_fallback`

- `POST /settings/runtime`：保存或更新 runtime 配置
  - 请求体包含：
    - `runtime_config.paddleocr|doctr|yolo.endpoint`
    - `runtime_config.paddleocr|doctr|yolo.api_key`
    - `runtime_config.paddleocr|doctr|yolo.local_train_command`
    - `runtime_config.paddleocr|doctr|yolo.local_predict_command`
    - `runtime_controls.python_bin`
    - `runtime_controls.disable_simulated_train_fallback`
    - `runtime_controls.disable_inference_fallback`
    - `keep_existing_api_keys`
  - 规则：
    - 仅管理员可访问
    - 当 `keep_existing_api_keys=true` 且某 framework 的 `api_key` 为空时，保留该 framework 已保存 key
    - `runtime_controls.python_bin` 可覆盖内置 runner 的 Python 执行命令（`{{python_bin}}` 占位）
    - `runtime_controls.disable_simulated_train_fallback=true` 时，训练命令不可用将直接失败（不再 simulated 回退）
    - `runtime_controls.disable_inference_fallback=true` 时，推理命令/端点失败将直接报错（不再返回 template/fallback 结果）
    - 响应返回 masked 视图（不含明文 key）

- `DELETE /settings/runtime`：清空 UI 保存的 runtime 配置
  - 仅管理员可访问
  - 清空后回到“环境变量兜底”模式，直到下一次 UI 保存
  - 响应返回 masked 视图

## 文件附件接口（补充）
- `GET /files/conversation`：获取当前用户会话附件列表
- `POST /files/conversation/upload`：上传会话附件
  - 兼容 JSON 文件名模式：
    ```json
    { "filename": "sample.jpg" }
    ```
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
  - 推荐 `multipart/form-data`（字段名 `file`）
  - 说明：
    - 单文件建议控制在约 `120 MB` 以内，避免代理/请求体大小限制触发 `413`
- `GET /files/dataset/{datasetId}`：数据集附件列表
- `POST /files/dataset/{datasetId}/upload`：上传数据集附件
  - 兼容 JSON 文件名模式
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
  - 仅 `status=completed` 的训练任务可注册
  - `execution_mode=simulated|unknown` 的训练任务必须拒绝注册
  - 对 `execution_mode=local_command` 的任务，若产物摘要出现非真实证据（`mode=template`、存在 `fallback_reason`、或 `training_performed=false`）也必须拒绝注册；仅在显式设置 `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1` 时可放开
  - 对非真实本地执行产物（例如 `mode=template`），应显式携带 `fallback_reason` 与 `training_performed=false`，避免被误判为真实训练输出
- OCR 本地训练 runner 允许在 `metrics.json` 与 `artifact_summary` 中附带额外的 OCR 风格指标键（例如 `norm_edit_distance`、`word_accuracy`），同时保持训练任务详情接口外层结构不变
- 新增 `GET /training/jobs/{id}/metrics-export`：
  - 返回任务指标导出 JSON（`latest_metrics` + `metrics_by_name` 序列）
  - 供训练详情页下载排障
  - 支持 `?format=csv`，返回 CSV 下载（`training_job_id, metric_name, step, metric_value, recorded_at`）
- 运行时适配器行为约束：
  - `evaluate()`：优先读取训练工作目录中的真实指标产物（如 `metrics.json`）；没有可评估产物时返回空指标，而不是按任务名猜测固定值。
  - `export()`：必须生成真实本地导出文件路径（可配置根目录），禁止返回伪路径（如 `/mock-artifacts/...`）。
  - `load_model()`：必须先校验模型产物存在，再返回 handle；产物缺失时应显式失败，禁止伪成功。
- 推理结果显式返回 `execution_source`，与 `normalized_output.source` 一致，用于区分：
  - `<framework>_runtime`
  - `<framework>_local_command`
  - `explicit_fallback_runtime_failed`
  - `explicit_fallback_local_command_failed`
  - `base_empty`

- template 模式标记规则：
  - 当本地 runner 返回 `raw_output.meta.mode=template` 时，即使 `source` 是 `<framework>_local_command`，前端也必须按“非真实结果”处理并提示。
  - template 模式下，后端会把 `meta.fallback_reason` 同步写入 `raw_output.local_command_fallback_reason`，便于 API 调用方统一读取回退原因字段。

- OCR 回退安全规则：
  - 当本地命令或 runtime 调用失败并触发回退时，OCR 返回必须为：
    - `ocr.lines = []`
    - `ocr.words = []`
  - 不允许注入看起来像真实业务数据的默认文本。

- 通用回退安全规则：
  - 当 runtime/local command 硬失败并进入显式回退时，各任务结构化输出默认应为空数组（`boxes`、`rotated_boxes`、`polygons`、`masks`、`labels`、`ocr.lines`、`ocr.words`），除非 runtime/local command 实际返回了这些信号。

- 本地命令执行规则：
  - 优先直接执行 Python 脚本，不依赖 `bash -c`。
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
