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

规则：
- 基座/基础模型目录中的整理模型属于受保护记录，管理员删除接口不得移除它们
- 只有当目标模型不再被任何 `ModelVersion` 或 `Conversation` 引用时，管理员删除才允许执行
- 删除成功时，还需一并移除模型作用域 `FileAttachment` 与关联 `ApprovalRequest`，并写入审计日志

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
  - `split_summary` 与 `annotation_coverage` 的训练就绪计算应基于“可训练视觉样本”（ready 图片附件），不应把导入辅助 `.txt/.json` 文件计入训练样本
- `training_jobs.execution_mode`：
  - `simulated`
  - `local_command`
  - `unknown`
- 模型版本注册约束：
  - `execution_mode=simulated|unknown` 的训练任务禁止注册模型版本
  - `execution_mode=local_command` 时，若产物摘要存在非真实证据（`mode=template`、存在 `fallback_reason`、或 `training_performed=false`）也必须拒绝注册，除非显式设置 `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1`
- 当 `VISTRAL_RUNNER_ENABLE_REAL` 未被显式关闭（`0/false/no/off/disabled`；部署默认可保持 `auto`）时，内置本地训练 runner 会优先尝试依赖驱动的真实执行或 OCR probe；依赖/模型不可用时再显式回退为 `template` 并保留 `fallback_reason`
- app 状态初始化模式可通过 `APP_STATE_BOOTSTRAP_MODE` 配置：
  - `full`（默认）：保留当前原型种子数据基线
  - `minimal`：当不存在持久化 app-state 时，仅初始化账号与基座模型，不注入数据集/训练/推理种子记录
- `inference_runs.execution_source`：
  - 保存当前推理来源标记（例如 `yolo_runtime`、`yolo_local_command`、`yolo_local_command_fallback`、`explicit_fallback_runtime_failed`、`explicit_fallback_local_command_failed`、`base_empty`）
  - 后端会基于回退证据进行归一化：
    - 已是显式 fallback/template/mock/base-empty 标记时保持原值
    - 其余来源一旦检测到回退证据（如 fallback reason、`raw_output.meta.mode=template`），会追加 `_fallback` 后缀，避免 UI 把非真实结果误判为真实执行
- template 标记规则：
  - 当 `raw_output.meta.mode=template` 时，即使 `execution_source=<framework>_local_command`，也应按非真实推理结果处理。
- OCR 回退安全约束：
  - 当 OCR 推理走回退路径时，`ocr.lines` 与 `ocr.words` 默认应为空数组；
  - 禁止在回退结果中注入业务化示例文本。
- 通用回退安全约束：
  - 当 runtime/local command 硬失败并触发显式回退时，各任务结构化输出默认应为空数组（`boxes`、`rotated_boxes`、`polygons`、`masks`、`labels`、`ocr.lines`、`ocr.words`），除非 runtime/local command 实际返回有效信号。
- 推理反馈规则：
  - `POST /inference/runs/{id}/feedback` 的目标数据集 `task_type` 必须与推理任务 `task_type` 一致
  - 不允许跨任务类型（例如 detection 结果回流到 ocr 数据集）

### RuntimeSettings（补充）
- 作用域：`设置 > Runtime` 的全局 runtime 适配器配置（管理员范围）
- 字段：
  - `updated_at`（可空；为空表示尚未通过 UI 保存覆盖）
  - `frameworks.paddleocr.endpoint`
  - `frameworks.paddleocr.api_key`（服务端密钥，不可明文返回）
  - `frameworks.paddleocr.default_model_id`（可选：该 framework 的默认模型）
  - `frameworks.paddleocr.default_model_version_id`（可选：该 framework 的默认模型版本）
  - `frameworks.paddleocr.model_api_keys`（可选：模型级远程鉴权 key 映射）
  - `frameworks.paddleocr.model_api_key_policies`（可选：模型级鉴权策略映射）
    - `api_key`
    - `expires_at`（可空 ISO 时间）
    - `max_calls`（可空整数）
    - `used_calls`（整数，服务端维护）
    - `last_used_at`（可空 ISO 时间，服务端维护）
  - `frameworks.paddleocr.local_model_path`（可选：本地模型/运行时资源路径，主要用于自托管 real local 分支）
  - `frameworks.paddleocr.local_train_command`
  - `frameworks.paddleocr.local_predict_command`
  - `frameworks.doctr.*`（同上）
  - `frameworks.yolo.*`（同上）
  - `controls.python_bin`（可选：内置本地 runner 默认 Python 可执行文件）
  - `controls.disable_simulated_train_fallback`（布尔：为 true 时训练不允许 simulated 回退）
  - `controls.disable_inference_fallback`（布尔：为 true 时推理不允许 template/fallback 输出）
- 规则：
  - runtime 适配器应在执行时动态读取配置，而不是只在进程启动时读取一次
  - 当不存在 UI 保存配置时，允许按环境变量做兜底
  - 当 runtime 的 Python 环境变量未设置时，`controls.python_bin` 默认回退为平台命令（POSIX=`python3`，Windows=`python`）
  - 一旦从 UI 保存，保存值即成为主配置来源，直到显式清空
  - 当 `VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS` 启用（默认）时，空的本地命令字段会自动填充为每个 framework 的内置 runner 模板
  - 空的 `local_model_path` 可按部署默认值自动补齐：
    - `PADDLEOCR_LOCAL_MODEL_PATH`
    - `DOCTR_LOCAL_MODEL_PATH`
    - `YOLO_LOCAL_MODEL_PATH`
    - YOLO 同时兼容旧环境变量 `VISTRAL_YOLO_MODEL_PATH` / `REAL_YOLO_MODEL_PATH`
  - 当 `.data/runtime-models/yolo11n.pt` 存在时，Runtime 设置/就绪度可直接把它视为默认本地 YOLO 权重路径，无需手工改 env
  - Runtime 自动配置接口可探测候选端点（`VISTRAL_RUNTIME_AUTO_ENDPOINT_CANDIDATES_JSON` + 内置默认列表），并为每个 framework 写入首个可达 endpoint
  - Runtime 自动配置接口也可在已知本地模型候选存在时，为空的 `local_model_path` 自动写入默认值
  - 若 `controls.python_bin` 为路径型值且路径不存在，运行时应跳过该候选并继续尝试下一个解释器候选（`.data/runtime-python/.venv`，再到 PATH 的 `python3/python`），避免因陈旧路径导致本地命令直接失败
  - 对外接口仅返回 `has_api_key` 与 `api_key_masked`，不得返回明文 key
  - 对外接口也只返回模型级密钥的掩码元信息（`model_api_keys_meta`），不得返回模型级明文 key
  - 保存时支持 `keep_existing_api_keys=true`，空 key 输入可保留已存密钥
  - `model_api_keys` 键格式：
    - `model:<model_id>`：模型级 key
    - `model_version:<model_version_id>`：模型版本级 key
  - 远程推理鉴权 key 解析顺序：`model_version` 绑定 > `model` 绑定 > framework 级 `api_key`
  - 当配置了模型级策略时，若 key 已过期（`expires_at <= now`）或额度耗尽（`used_calls >= max_calls`），远程调用应在发起前直接失败
  - 远程调用成功后应回写 `used_calls` 与 `last_used_at`
  - 本地模式/本地命令执行不依赖 API key，应始终显式传递 `model_id`/`model_version_id`

### TrainingWorkerNode（补充）
- `id`
- `name`
- `endpoint`（可空 URL，用于回调/分发）
- `status`：`online | offline | draining`
- `enabled`（bool）
- `max_concurrency`（int > 0）
- `last_heartbeat_at`（可空时间戳）
- `last_reported_load`（可空 float，范围 0..1）
- `capabilities`（JSON 数组，示例：`framework:yolo`、`task:detection`）
- `auth_mode`：`shared | dedicated`
- `auth_token_preview`（可空，掩码预览，不返回明文）
- `registration_source`：`seed | admin | heartbeat`
- `metadata`（JSON）
- `created_at` / `updated_at`

规则：
- worker 可以由管理员增删改，也可通过 heartbeat 动态注册。
- 调度优先选择 `online && enabled`，并综合 in-flight 和 `last_reported_load` 做负载评估。
- 心跳超过 TTL 视为 stale，调度时按离线处理。

### TrainingWorkerBootstrapSession（补充）
- `id`
- `status`：`bootstrap_created | pairing | validation_failed | awaiting_confirmation | online | expired`
- `deployment_mode`：`docker | script`
- `worker_profile`：`yolo | paddleocr | doctr | mixed`
- `pairing_token`
- `control_plane_base_url`
- `worker_id` / `worker_name`
- `worker_public_host`（可空）
- `worker_bind_port`（默认 `9090`）
- `worker_endpoint_hint`（可空）
- `worker_runtime_profile`
- `capabilities`
- `max_concurrency`
- `issued_auth_mode`：`shared | dedicated`
- `issued_auth_token_preview`（可空）
- `claimed_at` / `last_seen_at` / `callback_checked_at`（均可空）
- `callback_validation_message`（可空）
- `compatibility`（可空对象）：
  - `status`：`compatible | warning | incompatible | unknown`
  - `message`
  - `expected_runtime_profile`
  - `reported_runtime_profile`
  - `reported_worker_version`
  - `reported_contract_version`
  - `missing_capabilities`
- `linked_worker_id`（可空）
- `metadata`
- `created_at` / `expires_at`

规则：
- bootstrap session 是配对临时对象，不直接参与调度。
- 回调连通性和兼容性检查通过前，不得进入可调度 `online`。
- 管理员可对现有 worker 发起 `POST /admin/training-workers/{id}/reconfigure-session`，生成新的重配会话而不替换原 worker 记录。
- 若出现硬不兼容（例如 runtime profile 与期望不一致），状态应保持 `validation_failed`，对应 worker 也必须保持不可调度。
- 告警级兼容问题（例如缺失可选版本字段）可允许上线，但必须在 Runtime 配对界面清晰提示。

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
