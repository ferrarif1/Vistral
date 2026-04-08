# Vistral - AI 原生视觉模型平台（中文版）

## 概述
Vistral 是一个 AI-native 视觉模型平台，提供自然语言与附件驱动的交互方式。平台基于 RVision 能力演进，覆盖用户与管理员两类系统角色，并支持模型托管、训练、审批、发布、边缘推理与审计。

## 产品愿景
不同于传统仪表盘式产品，Vistral 采用类似 ChatGPT 的对话式交互范式，用户可通过自然语言与文件附件完成视觉模型任务。平台在保持 RVision 核心业务逻辑的同时，提供更现代和统一的体验。

## 核心能力
- 自然语言模型交互
- 附件驱动工作流（图片、文档、数据集）
- 两类系统角色管理（用户/管理员）+ 基于资源所有权的模型权限
- 模型托管与部署
- 训练流程管理
- 审批与审计流程
- 边缘推理能力
- 多步骤流程进度指示
- 高级参数默认折叠
- 对话附件采用聊天式草稿标签 + 按需附件托盘，同时保留删除与状态可见性
- 内置中英文切换（默认中文，可切换英文）

## 架构
- 前端：AI-native 对话式界面
- 后端：模型管理、推理与编排
- 基础设施：可扩展部署与边缘计算支持

## 快速开始
1. 克隆仓库；
2. 阅读 `AGENTS.md` 协作规则；
3. 阅读产品合同文档（英文原版）：
   - `docs/prd.md`
   - `docs/ia.md`
   - `docs/flows.md`
   - `docs/data-model.md`
   - `docs/api-contract.md`
   - `docs/training-worker-onboarding.md`
   - `docs/visual-data-loop-evolution.md`

   对应中文镜像版：
   - `docs/prd.zh-CN.md`
   - `docs/ia.zh-CN.md`
   - `docs/flows.zh-CN.md`
   - `docs/data-model.zh-CN.md`
   - `docs/api-contract.zh-CN.md`
   - `docs/visual-data-loop-evolution.zh-CN.md`
4. 按 `docs/deployment.docker.md` 使用唯一的 Docker 部署入口。
5. 若新任务会打断当前未完成工作，先在 `docs/work-handoff.md` 追加交接记录再切换上下文。

## Repository Working Model（本仓库 Codex 工作方式）
- 协作与执行规则：`AGENTS.md`
- 产品与工程合同：`docs/*`
- 可复用 skills：`.agents/skills/`
- 交付顺序：先计划，再对齐合同，再实现

## 贡献指南
提交改动前请先阅读 `docs/contributing.md` 或 `docs/contributing.zh-CN.md`。

## Docker 部署与验收
1. `cp .env.example .env`
2. `npm run docker:up`
3. 打开 `http://127.0.0.1:8080`
4. 执行 `npm run docker:healthcheck`
5. 执行 `npm run docker:verify:full`

像 `npm run dev`、`npm run dev:api`、`npm run dev:web` 这类源码直跑脚本仅保留给仓库维护/调试使用，不再作为正式产品入口。

训练机部署工具目录：
- 训练机侧部署/安装资源统一放在 `training-worker/`。
- 入口文档：`training-worker/README.md`
- 环境模板：`training-worker/.env.worker.example`
- 核心脚本：
  - `training-worker/scripts/bootstrap-worker.sh`
  - `training-worker/scripts/worker-doctor.sh`
  - `training-worker/scripts/install-deps.sh`
  - `training-worker/scripts/worker-heartbeat.sh`
  - `training-worker/scripts/worker-train-api.py`
  - `training-worker/scripts/run-worker-node.sh`
- 跨机器默认建议：`WORKER_USE_REQUEST_PATHS=false`，worker 只写本机 `WORKER_RUN_ROOT`。

认证方式（用户名密码）：
- 登录使用 `username + password`。
- 公开自助注册已关闭。
- mock 种子账号：
  - `alice / mock-pass`（user）
  - `admin / mock-pass-admin`（admin）
- 新账号只能由管理员在已登录的设置界面中开通。
- 所有已登录用户都可以在账户设置中修改自己的密码。
- 管理员还可在同一账户目录中重置其他用户密码、停用/恢复账号，并查看 `last_login_at`。
- API 错误返回按合同映射状态码/错误码（例如 `INSUFFICIENT_PERMISSIONS` -> `403`）。
  - 后端采用“模式优先”归类，降低后续新增错误遗漏映射风险。

常用验证命令：
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke:auth-session`（验证公开注册已关闭、管理员开通账号、停用/恢复与管理员重置密码规则，以及用户修改密码生效）
- `npm run smoke:account-governance`（验证管理员账号治理动作：开通、停用/恢复、重置密码；验证禁止自停用、停用后会话立即失效，以及用户自助修改密码）
- `npm run smoke:phase2`（验证分割标注持久化、复审状态机合同校验〔拒绝必须带 reason / 通过不能带 reason〕、返工 latest_review 上下文保持、训练发起就绪门禁〔`train split > 0`、`annotation_coverage > 0`、且 `dataset_version_id` 必须归属所选 `dataset_id`〕，以及 YOLO/PaddleOCR/docTR runtime fallback）
- `npm run smoke:attachments`（验证会话/模型/数据集附件的 multipart 上传、读取与删除闭环）
- `npm run smoke:conversation-context`（验证会话消息附件顺序与当前上下文选择顺序一致）
- `npm run smoke:conversation-actions`（验证对话可追问缺失字段，并真实创建数据集、模型草稿和训练任务）
  - 若未显式传入 `EXPECTED_TRAINING_DATASET_ID` / `EXPECTED_TRAINING_DATASET_VERSION_ID`，脚本默认自动准备一套可训练 detection 数据集版本（`AUTO_PREPARE_TRAINING_TARGET=true`）
- `npm run smoke:inference-feedback-guard`（验证 `/api/inference/runs/{id}/feedback` 对跨任务类型数据集进行拒绝，并对同任务类型数据集正确落地反馈样本）
  - 覆盖 detection 与 OCR 两条反馈闭环：跨任务类型拒绝、同任务类型成功，以及反馈样本在数据集条目/附件中的可追溯性
  - 覆盖同一 run+dataset 重复反馈的幂等语义：不重复新增数据集条目，仅更新反馈 metadata（如 `feedback_reason`）
  - 覆盖“输入附件已在目标数据集作用域”场景：应复用原附件，不额外克隆新附件
  - 覆盖反馈 metadata 完整性：校验 `inference_run_id`、`source_attachment_id`、`feedback_reason` 字段正确落在数据集条目中
  - 默认自动准备反馈目标数据集（`AUTO_PREPARE_FEEDBACK_DATASETS=true`）；也可通过 `EXPECTED_VALID_FEEDBACK_DATASET_ID` / `EXPECTED_OCR_FEEDBACK_DATASET_ID` / `EXPECTED_MISMATCH_FEEDBACK_DATASET_ID` 显式指定
- `npm run smoke:no-seed-hardcoding`（校验 smoke/verify 脚本中不存在固定种子实体 ID（如 `d-*`、`dv-*`、`mv-*`、`f-*`），保障部署模式回归的可迁移性）
- `npm run smoke:core-closure`（一键串行执行核心闭环回归：`no-seed-hardcoding` + `account-governance` + `phase2` + `conversation-actions` + `inference-feedback-guard` + `real-closure` + `ocr-closure` + `training-worker-dedicated-auth`）
- `npm run smoke:llm-settings`（验证 LLM 设置的保存、保留旧 key 编辑、重启后加密读回与清空流程）
- `npm run smoke:runtime-success`（通过本地 runtime mock 验证 YOLO/PaddleOCR/docTR 成功路径）
- `npm run smoke:admin:verification-reports`（验证 `/api/admin/verification-reports` 的 user/admin 权限边界）
- `npm run smoke:demo:train-data`（把 `demo_data/train` 图片导入新的 detection 数据集，并自动完成状态等待、数据切分和数据集版本创建）
- `npm run smoke:ocr-closure`（验证独立 OCR 闭环：OCR 导入 -> PaddleOCR/docTR 本地命令训练 -> 指标/产物摘要 -> 模型版本注册 -> 推理上传与执行）
  - 默认使用 strict 本地命令断言；若需允许 fallback，可执行 `OCR_CLOSURE_STRICT_LOCAL_COMMAND=false npm run smoke:ocr-closure`
- `npm run smoke:real-closure`（验证完整 real 闭环：需求草拟 -> 数据集上传/导入/导出 -> YOLO 训练 -> 模型版本注册 -> YOLO/PaddleOCR/docTR 推理 -> detection/OCR 反馈回流与数据集追踪）
- `npm run smoke:restart-resume`（验证 app state 持久化与 API 重启后训练任务自动恢复）
- `npm run smoke:local-command`（验证 YOLO 本地命令训练/推理适配器与真实 metrics/source 回填）
- `npm run smoke:execution-fields`（验证 `training_jobs.execution_mode` 与 `inference_runs.execution_source` 的显式持久化字段）
- `npm run smoke:runner-real-fallback`（验证 `VISTRAL_RUNNER_ENABLE_REAL=1` 且依赖不足时会回退模板输出并记录 `fallback_reason`）
- `npm run smoke:runner-real-upload`（验证真实上传文件路径下，`VISTRAL_RUNNER_ENABLE_REAL=1` 时 YOLO 回退原因为 `model_path_not_found`）
- `npm run smoke:runner-real-positive`（可选正向验证：依赖与模型就绪时，YOLO real 分支返回 `meta.mode=real`；条件不满足自动跳过）
- `npm run smoke:runtime-metrics-retention`（验证 runtime 指标保留摘要接口与单任务指标点数上限生效）
- `npm run smoke:training-metrics-export`（验证 `/api/training/jobs/{id}/metrics-export` 的指标时间线导出结构）
- `npm run smoke:training-metrics-export-csv`（验证 `/api/training/jobs/{id}/metrics-export?format=csv` 的下载头与 CSV 行内容）
- `npm run smoke:admin:verification-retention`（验证 `/api/admin/verification-reports` 返回 `runtime_metrics_retention` 字段）
- `npm run smoke:verify-report-retention-e2e`（运行 `docker-verify-full` 并校验报告文件与 admin 接口中的 `runtime_metrics_retention` 一致）
- `npm run smoke:training-worker-dispatch`（验证训练任务可调度到 worker endpoint 执行，并回传指标闭环）
- `npm run smoke:training-worker-cancel`（验证 worker 执行中的训练任务可被控制面取消并最终进入 `cancelled`）
- `npm run smoke:training-worker-dedicated-auth`（验证 bootstrap 下发 dedicated worker token 的完整链路：claim -> heartbeat -> reference package -> cancel）
  - worker smoke 额外支持 `EXPECTED_TRAINING_DATASET_ID` / `EXPECTED_TRAINING_DATASET_VERSION_ID`，未传入时会自动选择可用 detection 训练目标

原型持久化与重启行为：
- 业务状态会持久化到本地快照（默认 `.data/app-state.json`）。
- 可通过 `APP_STATE_STORE_PATH` 修改快照路径。
- 可通过 `APP_STATE_PERSIST_INTERVAL_MS` 调整落盘间隔（最小 400ms，默认 1200ms）。
- 可通过 `VERIFICATION_REPORTS_DIR` 覆盖验收报告目录。
- 训练指标保留策略：
  - `TRAINING_METRICS_MAX_POINTS_PER_JOB`（默认 `180`）
  - `TRAINING_METRICS_MAX_TOTAL_ROWS`（默认 `20000`）
- API 重启后，`queued/preparing/running/evaluating` 的训练任务会自动重新入队继续执行。
- LLM 配置仍单独加密存储在 `.data/llm-config.enc.json`。
- 可选本地命令适配：
  - `YOLO_LOCAL_TRAIN_COMMAND` / `PADDLEOCR_LOCAL_TRAIN_COMMAND` / `DOCTR_LOCAL_TRAIN_COMMAND`
  - `YOLO_LOCAL_PREDICT_COMMAND` / `PADDLEOCR_LOCAL_PREDICT_COMMAND` / `DOCTR_LOCAL_PREDICT_COMMAND`
  - 超时控制：`LOCAL_RUNNER_TIMEOUT_MS`
  - 可选真实 runner 开关：`VISTRAL_RUNNER_ENABLE_REAL=1`
  - 可选真实 runner 参数：
    - `VISTRAL_YOLO_MODEL_PATH`
    - `VISTRAL_PADDLEOCR_LANG`、`VISTRAL_PADDLEOCR_USE_GPU`
    - `VISTRAL_DOCTR_DET_ARCH`、`VISTRAL_DOCTR_RECO_ARCH`
  - 可复用 runner 模板目录：`scripts/local-runners/`
  - 模板占位符包含：`{{repo_root}}`、`{{job_id}}`、`{{dataset_id}}`、`{{task_type}}`、`{{metrics_path}}`、`{{output_path}}`
  - worker 分发相关：
    - `TRAINING_WORKER_SHARED_TOKEN`
    - `TRAINING_WORKER_HEARTBEAT_TTL_MS`
    - `TRAINING_WORKER_DISPATCH_TIMEOUT_MS`
    - `TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL`
    - `TRAINING_WORKER_INLINE_PACKAGE_MAX_FILES`
    - `TRAINING_WORKER_INLINE_PACKAGE_MAX_BYTES`

当前界面能力补充：
- 会话工作区已切换为沉浸式 chat 风格布局（左侧会话栏 + 中央时间线 + 底部浮动输入区）。
- 附件上传组件已统一支持本地文件选择；附件支持打开/图片预览，并可在会话上下文中纳入/移出。
- 会话页附件改为更接近日常对话式 LLM 的交互：当前草稿仅显示已选附件标签，完整附件托盘按需展开。
- 推理验证页提供三框架 runtime 连通性诊断面板（PaddleOCR/docTR/YOLO）。
- `/settings/llm` 已支持 ChatAnywhere 兼容写法，`Base URL` 可填写：
  - `https://api.chatanywhere.tech/v1`
  - `https://api.chatanywhere.tech/v1/chat/completions`
- 新增独立设置页 `/settings/runtime`，用于运行时连通性一键检查与接入模板查看。
- 新增管理员验收报告页 `/admin/verification-reports`，可直接查看部署验收脚本产出的报告摘要。
  - 支持筛选、搜索、日期区间、排序、7/30 天快捷筛选、分页、检查项折叠与按筛选导出 JSON。

## 许可证
当前基线版本尚未添加许可证文件；正式发布前请补充许可证文本。

## Docker 内网部署细节
1. `cp .env.example .env`（按需修改密钥）
2. `npm run docker:up`（纯 Docker 单入口，推荐）
3. 访问 `http://127.0.0.1:8080`
4. 健康检查 `http://127.0.0.1:8080/api/health`
5. 停止 `docker compose down`
6. 部署自检：`npm run docker:healthcheck`
7. 全链路验收：`npm run docker:verify:full`
   - 覆盖 auth/权限、账号治理校验、真实 multipart 附件链路、对话侧真实创建动作（数据集/模型草稿/训练任务）、审批+推理反馈、Phase2 标注复审与训练发起门禁、数据集导入导出 roundtrip（detection/ocr/segmentation）、detection real-closure、OCR closure，以及 dedicated training-worker auth 的分发/取消链路
   - 默认以 non-strict 模式执行 OCR 闭环（`OCR_CLOSURE_STRICT_LOCAL_COMMAND=false`），提高部署环境兼容性
   - 如需强校验本地命令路径，可执行 `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run docker:verify:full`
   - 若部署环境无法解析 `host.docker.internal`，可在执行前设置 `DEDICATED_AUTH_WORKER_PUBLIC_HOST`（必要时同时设置 `DEDICATED_AUTH_WORKER_BIND_HOST`）
8. 全链路验收会在 `.data/verify-reports/` 产出 JSON + Markdown 报告

容器说明：
- `vistral-web`：nginx 前端 + `/api` 反向代理
- `vistral-api`：Node 后端（会话认证、mock 流程、runtime 诊断）
