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
npm run smoke:training-metrics-export
npm run smoke:training-metrics-export-csv
npm run smoke:admin:verification-retention
npm run smoke:verify-report-retention-e2e
```

`smoke:conversation-actions` 可用环境变量：
- `EXPECTED_TRAINING_DATASET_ID`
- `EXPECTED_TRAINING_DATASET_VERSION_ID`
- `AUTO_PREPARE_TRAINING_TARGET`（默认 `true`）

`smoke:inference-feedback-guard` 可用环境变量：
- `EXPECTED_VALID_FEEDBACK_DATASET_ID`
- `EXPECTED_OCR_FEEDBACK_DATASET_ID`
- `EXPECTED_MISMATCH_FEEDBACK_DATASET_ID`
- `AUTO_PREPARE_FEEDBACK_DATASETS`（默认 `true`）

可选正向 real-runner 验证：
- `REAL_YOLO_MODEL_PATH=/abs/path/to/yolo.pt npm run smoke:runner-real-positive`
- 当模型文件或 `ultralytics` 依赖缺失时，该脚本会自动跳过。

与持久化相关的原型环境变量：
- `UPLOAD_STORAGE_ROOT`（默认 `.data/uploads`）
- `TRAINING_WORKDIR_ROOT`（默认 `.data/training-jobs`）
- `APP_STATE_STORE_PATH`（默认 `.data/app-state.json`）
- `APP_STATE_PERSIST_INTERVAL_MS`（默认 `1200`，最小 `400`）
- `VERIFICATION_REPORTS_DIR`（默认 `.data/verify-reports`）
- `TRAINING_METRICS_MAX_POINTS_PER_JOB`（默认 `180`）
- `TRAINING_METRICS_MAX_TOTAL_ROWS`（默认 `20000`）
- `YOLO_LOCAL_TRAIN_COMMAND` / `PADDLEOCR_LOCAL_TRAIN_COMMAND` / `DOCTR_LOCAL_TRAIN_COMMAND`
- `YOLO_LOCAL_PREDICT_COMMAND` / `PADDLEOCR_LOCAL_PREDICT_COMMAND` / `DOCTR_LOCAL_PREDICT_COMMAND`
- `LOCAL_RUNNER_TIMEOUT_MS`（默认 `1800000`）
- `VISTRAL_RUNNER_ENABLE_REAL`（设为 `1` 时尝试本地 runner 的真实框架分支）
- `VISTRAL_YOLO_MODEL_PATH`
- `VISTRAL_PADDLEOCR_LANG` / `VISTRAL_PADDLEOCR_USE_GPU`
- `VISTRAL_DOCTR_DET_ARCH` / `VISTRAL_DOCTR_RECO_ARCH`
- 本地命令模板脚本目录：`scripts/local-runners/`
- 占位符示例：`{{repo_root}}`、`{{job_id}}`、`{{dataset_id}}`、`{{task_type}}`、`{{metrics_path}}`、`{{output_path}}`

`docker:verify:full` 会在 `.data/verify-reports/` 生成验收报告。
并会校验账号治理、对话侧真实创建动作、Phase2 标注复审与训练发起门禁（含 `dataset_version_id` 必须归属所选 `dataset_id`）、数据集导入导出 roundtrip（detection/ocr/segmentation），以及 YOLO/PaddleOCR/docTR real closure。
默认以 non-strict 模式执行 OCR 闭环（`OCR_CLOSURE_STRICT_LOCAL_COMMAND=false`），便于部署环境在本地命令不可用时容忍 simulated fallback。

如需 strict OCR 闭环校验，可执行：
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run smoke:ocr-closure`
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run docker:verify:full`

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
