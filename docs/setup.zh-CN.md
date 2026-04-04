# 本地准备指南（中文版）

## 1）前置条件
- Git
- POSIX shell 环境
- 任意编辑器/IDE
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

## 4）本地开发
```bash
npm install
npm run dev
```

打开：`http://127.0.0.1:5173`

## 5）Docker 内网部署
```bash
cp .env.example .env
docker compose up --build -d
```

打开：`http://127.0.0.1:8080`

若部署机不能本地 build 或无法访问 Docker Hub，可使用预构建镜像模式：
```bash
docker compose -f docker-compose.registry.yml up -d
```

常用部署辅助命令：
```bash
npm run docker:images:build
npm run docker:images:build-push
npm run docker:images:save
IMAGE_TAR=vistral-images-round1.tar npm run docker:images:load-up
npm run docker:healthcheck
npm run docker:verify:full
npm run docker:release:bundle
VERIFY_BASE_URL=http://127.0.0.1:8080 npm run docker:release:bundle:verified
npm run smoke:admin:verification-reports
npm run smoke:demo:train-data
npm run smoke:ocr-closure
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
`docker:release:bundle` 支持可选约束：
- `VERIFY_REPORT_PATH=<report.json|report.md>` 指定要打包的验收报告
- `VERIFY_REPORT_MAX_AGE_SECONDS=<秒>` 对报告时效做硬校验，超时即失败

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
