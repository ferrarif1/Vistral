# 本地准备指南（中文版）

## 1）前置条件
- Git
- POSIX shell 环境
- 任意编辑器/IDE
- Docker Engine + Docker Compose

仅在仓库维护/调试时才需要：
- Node.js 20+
- npm 10+

## 2）克隆仓库
```bash
git clone <your-fork-or-origin-url>
cd Vistral
```

## 3）编码前阅读顺序
1. `README.md`
2. `AGENTS.md`
3. `.codex/config.toml`
4. `docs/prd.md`
5. `docs/ia.md`
6. `docs/flows.md`
7. `docs/data-model.md`
8. `docs/api-contract.md`

## 4）唯一正式入口：Docker
```bash
cp .env.example .env
npm run docker:up
```

打开：`http://127.0.0.1:8080`

推荐验收：
```bash
npm run docker:healthcheck
npm run docker:verify:full
```

训练机（B/C/D...）部署与安装相关资源已统一放在：
- `training-worker/README.md`
- `training-worker/.env.worker.example`
- `training-worker/scripts/install-deps.sh`
- `training-worker/scripts/worker-heartbeat.sh`
- `training-worker/scripts/worker-train-api.py`
- `training-worker/scripts/run-worker-node.sh`
- 跨机器部署建议保持 `WORKER_USE_REQUEST_PATHS=false`，让 worker 仅使用本机 `WORKER_RUN_ROOT`

## 5）可选源码维护模式
这条路线仅保留给仓库维护和调试使用，不再作为正式产品入口。

```bash
npm install
npm run dev
```

打开：`http://127.0.0.1:5173`

常用部署辅助命令：
```bash
npm run docker:healthcheck
npm run docker:verify:full
npm run data:cleanup-test
npm run data:reset:foundation
npm run smoke:foundation-reset
npm run smoke:adapter-no-placeholder
npm run smoke:training-template-guard
npm run smoke:account-governance
npm run smoke:admin:verification-reports
npm run smoke:conversation-actions
npm run smoke:demo:train-data
npm run smoke:ocr-closure
npm run smoke:inference-feedback-guard
npm run smoke:no-seed-hardcoding
npm run smoke:core-closure
npm run smoke:restart-resume
npm run smoke:local-command
npm run smoke:execution-fields
npm run smoke:runner-real-fallback
npm run smoke:runner-real-upload
npm run smoke:runner-real-positive
npm run smoke:runtime-metrics-retention
npm run smoke:ocr-fallback-guard
npm run smoke:training-metrics-export
npm run smoke:training-metrics-export-csv
npm run smoke:training-worker-scheduler
npm run smoke:training-worker-dispatch
npm run smoke:training-worker-cancel
npm run smoke:admin:verification-retention
npm run smoke:verify-report-retention-e2e
```

`smoke:conversation-actions` 可用环境变量：
- `EXPECTED_TRAINING_DATASET_ID`
- `EXPECTED_TRAINING_DATASET_VERSION_ID`
- `AUTO_PREPARE_TRAINING_TARGET`（默认 `true`）

worker 调度/派发/取消/故障转移/引用包/dedicated-auth smoke 可用环境变量：
- `EXPECTED_TRAINING_DATASET_ID`
- `EXPECTED_TRAINING_DATASET_VERSION_ID`
  - 未显式传入时，脚本会自动选择一个可用 detection 数据集及可训练版本（`split_summary.train > 0` 且 `annotation_coverage > 0`）

`smoke:inference-feedback-guard` 可用环境变量：
- `EXPECTED_VALID_FEEDBACK_DATASET_ID`
- `EXPECTED_OCR_FEEDBACK_DATASET_ID`
- `EXPECTED_MISMATCH_FEEDBACK_DATASET_ID`
- `AUTO_PREPARE_FEEDBACK_DATASETS`（默认 `true`）

可选正向 real-runner 验证：
- `YOLO_LOCAL_MODEL_PATH=/abs/path/to/yolo.pt npm run smoke:runner-real-positive`
- 为稳定的 PaddleOCR 本地运行环境，建议依赖组合：
  - `python3 -m pip install --extra-index-url https://download.pytorch.org/whl/cpu "numpy==1.26.4" "paddlepaddle==3.2.0" "paddleocr==3.4.0" "torch==2.5.1+cpu" "torchvision==0.20.1+cpu" "ultralytics==8.4.37" "python-doctr==1.0.1"`
- 当模型文件或 `ultralytics` 依赖缺失时，该脚本会自动跳过。

与持久化相关的原型环境变量：
- `UPLOAD_STORAGE_ROOT`（默认 `.data/uploads`）
- `TRAINING_WORKDIR_ROOT`（默认 `.data/training-jobs`）
- `APP_STATE_STORE_PATH`（默认 `.data/app-state.json`）
- `APP_STATE_PERSIST_INTERVAL_MS`（默认 `1200`，最小 `400`）
- `APP_STATE_BOOTSTRAP_MODE`（`full` 默认 | `minimal`）
  - `minimal` 仅在 `APP_STATE_STORE_PATH` 不存在、首次初始化时生效
  - 已有状态文件如需清理测试/种子运行数据，请执行 `npm run data:reset:foundation`（保留账号与基座模型）
- `RESET_FOUNDATION_PURGE_STORAGE`（`data:reset:foundation` 默认 `1`）
  - `1`：重置状态并清理本地运行时存储目录
  - `0`：仅重置状态，不清理本地文件
- `VERIFICATION_REPORTS_DIR`（默认 `.data/verify-reports`）
- `TRAINING_METRICS_MAX_POINTS_PER_JOB`（默认 `180`）
- `TRAINING_METRICS_MAX_TOTAL_ROWS`（默认 `20000`）
- `YOLO_LOCAL_TRAIN_COMMAND` / `PADDLEOCR_LOCAL_TRAIN_COMMAND` / `DOCTR_LOCAL_TRAIN_COMMAND`
- `YOLO_LOCAL_PREDICT_COMMAND` / `PADDLEOCR_LOCAL_PREDICT_COMMAND` / `DOCTR_LOCAL_PREDICT_COMMAND`
- `VISTRAL_PYTHON_BIN`（可选，用于覆盖内置本地 runner 的 Python 可执行文件；Docker 默认 `/opt/vistral-venv/bin/python`，其余场景回退顺序：`PYTHON_BIN`，再按平台默认 `python3`/`python`）
- `API_DEBIAN_APT_MIRROR`（API 镜像构建时 apt 源，默认 `http://mirrors.tuna.tsinghua.edu.cn/debian`）
- `API_DEBIAN_APT_SECURITY_MIRROR`（API 镜像构建时 apt security 源，默认 `http://mirrors.tuna.tsinghua.edu.cn/debian-security`）
- `API_PIP_INDEX_URL`（API 镜像构建时 Python 包源，默认 `https://pypi.tuna.tsinghua.edu.cn/simple`）
- `API_PIP_EXTRA_INDEX_URL`（默认 `https://download.pytorch.org/whl/cpu`；Docker 构建时作为 torch wheel 默认源）
- `API_PIP_TORCH_INDEX_URL`（可选：显式覆盖 torch/torchvision wheel 源；留空时复用 `API_PIP_EXTRA_INDEX_URL`）
- `API_PIP_TRUSTED_HOST`（配合 `API_PIP_INDEX_URL` 的 trusted host，默认 `pypi.tuna.tsinghua.edu.cn`）
- `LOCAL_RUNNER_TIMEOUT_MS`（默认 `1800000`）
- `VISTRAL_AUTO_BOOTSTRAP_YOLO_MODEL`（默认 `1`；API 启动时会在本地 YOLO 模型缺失时通过 ModelScope 自动拉取 `yolo11n.pt`）
- `VISTRAL_AUTO_BOOTSTRAP_PADDLEOCR_MODELS`（默认 `1`；API 启动时自动预热 PaddleOCR 模型并写入 bootstrap 标记）
- `VISTRAL_AUTO_BOOTSTRAP_DOCTR_MODELS`（默认 `1`；API 启动时自动预热 docTR 模型并写入 bootstrap 标记）
- `VISTRAL_RUNTIME_BOOTSTRAP_BLOCKING`（默认 `0`；设为 `1` 时，API 会等待引导任务完成后再开始监听）
- `VISTRAL_RUNTIME_BOOTSTRAP_TIMEOUT_MS`（默认 `180000`；启动阶段 Runtime 自动引导任务超时时间）
- `VISTRAL_RUNTIME_MODELS_ROOT`（默认 `.data/runtime-models`；运行时模型/缓存/bootstrap 标记根目录）
- `PADDLE_HOME`（默认 `.data/runtime-models/paddle-home`；Paddle 缓存目录，建议持久化）
- `HF_HOME`（默认 `.data/runtime-models/hf-home`；HuggingFace 缓存目录，建议持久化）
- `DOCTR_CACHE_DIR`（默认 `.data/runtime-models/doctr-cache`；docTR 缓存目录，建议持久化）
- `VISTRAL_DOCTR_PRESEEDED_MODELS_DIR`（默认 `.data/runtime-models/doctr-preseed`；可选，本地预置 docTR 模型目录，启动时会复制到 `DOCTR_CACHE_DIR/models`）
- `VISTRAL_DOCTR_PRESEEDED_MODELS_URLS`（可选，逗号分隔模型文件 URL；用于受限网络下预置 docTR 缓存）
- `ULTRALYTICS_CONFIG_DIR`（默认 `.data/runtime-models/ultralytics`；Ultralytics 配置/缓存目录，建议持久化）
- `VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK`（设为 `1` 时，本地 train runner 命令缺失/不可用将直接失败，不再回退 simulated）
- `VISTRAL_DISABLE_INFERENCE_FALLBACK`（设为 `1` 时，runtime/local predict 若会返回 template/fallback 输出则直接失败）
- `VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS`（默认 `1`；在 Runtime 设置/就绪度里自动把空的本地命令字段补成内置模板）
- `VISTRAL_RUNTIME_AUTO_ENDPOINT_CANDIDATES_JSON`（可选 JSON 对象；用于覆盖/补充 Runtime 自动配置端点探测候选，例如 `{"yolo":["http://10.0.0.5:9394/predict"]}`）
- `VISTRAL_RUNNER_ENABLE_REAL`（默认 `auto`；内置本地 runner 会尝试真实执行，除非显式设为 `0/false/no/off/disabled` 关闭）
- `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK`（默认 `True`；关闭 Paddle 模型源连通性预检查，减少运行时抖动）
- `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND`（默认 `0`；为 `0` 时，模型版本注册会拒绝带模板/回退/非真实产物证据的本地命令训练任务）
- `PADDLEOCR_LOCAL_MODEL_PATH`
- `DOCTR_LOCAL_MODEL_PATH`
- `YOLO_LOCAL_MODEL_PATH`（推荐；YOLO 仍兼容旧环境变量 `VISTRAL_YOLO_MODEL_PATH` / `REAL_YOLO_MODEL_PATH`）
- `VISTRAL_PADDLEOCR_LANG` / `VISTRAL_PADDLEOCR_USE_GPU`
- `VISTRAL_DOCTR_DET_ARCH` / `VISTRAL_DOCTR_RECO_ARCH`
- `TRAINING_WORKER_AUTH_TOKEN`（`/api/runtime/training-workers/heartbeat` 首选鉴权令牌；保留 shared fallback 兼容旧 worker）
- `TRAINING_WORKER_HEARTBEAT_TTL_MS`（默认 `45000`，调度时判定 worker 心跳过期阈值）
- `TRAINING_WORKER_DISPATCH_TIMEOUT_MS`（默认 `1800000`，控制面到 worker 训练请求超时）
- `TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL`（默认 `1`，worker 分发失败时是否回退本地执行）
- `TRAINING_WORKER_INLINE_PACKAGE_MAX_FILES`（默认 `800`，下发给 worker 的内联数据包文件数上限）
- `TRAINING_WORKER_INLINE_PACKAGE_MAX_BYTES`（默认 `41943040`，下发给 worker 的内联数据包总字节上限）
- 本地命令模板脚本目录：`scripts/local-runners/`
- 占位符示例：`{{python_bin}}`、`{{repo_root}}`、`{{job_id}}`、`{{dataset_id}}`、`{{task_type}}`、`{{metrics_path}}`、`{{output_path}}`

如果部署环境无法访问 `doctr-static.mindee.com`：
- 可把预下载的 docTR 模型文件（默认架构对应：`db_resnet50-79bd7d70.pt`、`vgg16_bn_r-d108c19c.pt`）放到 `VISTRAL_DOCTR_PRESEEDED_MODELS_DIR`，或
- 配置 `VISTRAL_DOCTR_PRESEEDED_MODELS_URLS` 指向可访问镜像地址。
启动 bootstrap 会先把这些文件复制到 `DOCTR_CACHE_DIR/models`，再执行 docTR 预热。

Docker compose 快捷方式：
- 默认会把宿主机目录 `./runtime-assets/doctr-preseed` 只读挂载到容器 `/app/runtime-preseed/doctr`。
- 可先执行 `npm run setup:doctr-preseed`，自动检查/下载预置文件到该目录。

`docker:verify:full` 会在 `.data/verify-reports/` 生成验收报告。
并会校验账号治理、对话侧真实创建动作、Phase2 标注复审与训练发起门禁（含 `dataset_version_id` 必须归属所选 `dataset_id`）、数据集导入导出 roundtrip（detection/ocr/segmentation）、dedicated training-worker auth 分发/取消链路、OCR fallback 安全守卫（回退时不得出现误导性默认业务文本），以及 YOLO/PaddleOCR/docTR real closure。
默认以 non-strict 模式执行 OCR 闭环（`OCR_CLOSURE_STRICT_LOCAL_COMMAND=false`），便于部署环境在本地命令不可用时容忍 simulated fallback。
real closure 同时以“注册门禁兼容模式”执行（`REAL_CLOSURE_STRICT_REGISTRATION=false`）：
- 仍会先尝试注册模型版本；
- 若被非真实产物门禁拒绝（`execution_mode` 不匹配，或模板/回退证据），会在输出里记录 `*_register_mode=blocked_gate_*`，并复用已有已注册版本继续做下游推理校验。
这样可以在不放宽生产门禁的前提下，减少部署验收在依赖不完整环境中的误报失败。
若部署环境无法解析 `host.docker.internal`，请在执行全链路验收前设置 `DEDICATED_AUTH_WORKER_PUBLIC_HOST`（必要时同时设置 `DEDICATED_AUTH_WORKER_BIND_HOST`）。

如需 strict OCR 闭环校验，可执行：
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run smoke:ocr-closure`
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run docker:verify:full`

如需 strict real-closure 注册校验，可执行：
- `REAL_CLOSURE_STRICT_REGISTRATION=true npm run smoke:real-closure`

real-closure 其他常用参数：
- `PYTHON_BIN=/path/to/python npm run smoke:real-closure`（覆盖 Python 运行时；默认优先 `.data/runtime-python/.venv/bin/python`）
- `REAL_CLOSURE_GENERATE_TEXT_SAMPLE=false npm run smoke:real-closure`（关闭内置 OCR 文本样本图生成）
- `REAL_CLOSURE_REQUIRE_REAL_MODE=true npm run smoke:real-closure`（强制非 template / 非 fallback OCR 证据，并自动启用 `VISTRAL_RUNNER_ENABLE_REAL=1`）
- `REAL_CLOSURE_YOLO_WAIT_POLLS=360 REAL_CLOSURE_YOLO_WAIT_SLEEP_SEC=0.3 npm run smoke:real-closure`（调整 YOLO 训练等待窗口）
- `REAL_CLOSURE_DOCTR_WAIT_POLLS=720 REAL_CLOSURE_DOCTR_WAIT_SLEEP_SEC=0.3 npm run smoke:real-closure`（调整 docTR 训练等待窗口）

## 6）最小基线检查
文档改动至少执行：
```bash
rg "docs/setup.md|docs/contributing.md" README.md
```

并手动确认你修改到的链接都指向仓库内真实路径。

代码改动至少执行：
```bash
npm run typecheck
npm run lint
npm run build
```

## 7）Demo 数据集导入（列车图片）
可直接使用 `demo_data/train` 本地图片快速构建 detection 数据集（mock）：
```bash
npm run smoke:demo:train-data
```

可选参数：
- `MAX_FILES=120 npm run smoke:demo:train-data` 限制导入文件数量（`0` 表示导入全部）
- `START_API=false BASE_URL=http://127.0.0.1:8080 npm run smoke:demo:train-data` 复用已启动 API
