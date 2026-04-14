# Docker Deployment (Single Path)

This repository uses one deployment path only:
- `vistral-web` (nginx frontend + `/api` reverse proxy)
- `vistral-api` (Node backend with mock workflow + runtime bridge diagnostics)

Default bootstrap behavior (fresh Docker deploy):
- API image now uses Debian/glibc runtime (`node:20-bookworm-slim`) and builds a dedicated Python venv at `/opt/vistral-venv`.
- Runtime dependencies (`paddlepaddle==3.2.0`, `paddleocr==3.4.0`, `ultralytics==8.4.37`, `python-doctr==1.0.1`) are installed during image build (not manual post-start install).
- Docker build uses a two-phase pip install:
  - install `torch==2.5.1+cpu` and `torchvision==0.20.1+cpu` from PyTorch CPU index
  - install remaining runtime dependencies from the main Python index
- This avoids accidental CUDA package explosion and also prevents the PyTorch index from taking precedence for unrelated packages.
- API container sets `VISTRAL_PYTHON_BIN=/opt/vistral-venv/bin/python` by default, so local runner commands execute against the dependency-complete interpreter.
- API startup auto-bootstraps local runtime assets by default:
  - YOLO base weight (`yolo11n.pt`) via ModelScope when missing
  - PaddleOCR model warmup
  - docTR model warmup
- Bootstrap runs in non-blocking mode by default (`VISTRAL_RUNTIME_BOOTSTRAP_BLOCKING=0`), so API can start serving while warmup continues in background.
- Set `VISTRAL_RUNTIME_BOOTSTRAP_BLOCKING=1` if deployment policy requires warmup completion before API listen.
- Bootstrap markers are stored under `.data/runtime-models/.bootstrap-markers/` so successful warmup is not repeated every restart.
- Runtime caches are persisted under `.data/runtime-models/` (`PADDLE_HOME`, `HF_HOME`, `DOCTR_CACHE_DIR`, `ULTRALYTICS_CONFIG_DIR`), avoiding repeated model downloads on container recreate.
- For restricted-network deployments, docTR bootstrap supports cache preseed via `VISTRAL_DOCTR_PRESEEDED_MODELS_DIR` / `VISTRAL_DOCTR_PRESEEDED_MODELS_URLS` to avoid upstream download failures.
- Compose mounts host `./runtime-assets/doctr-preseed` into `/app/runtime-preseed/doctr` (read-only) by default, so operators can preseed docTR assets without entering containers.
- if external runtime endpoints are not configured yet, inference/training may still run through local template/fallback path; UI surfaces explicit fallback warnings and runtime settings guidance instead of silently presenting it as real execution.

## Prerequisites
- Docker Engine + Docker Compose

## Start
```bash
cp .env.example .env
npm run docker:up
```

`docker:up` remains the only supported run path and now adds two stability guards automatically:
- pre-pulls a reachable base image before building
- reuses a cached local base image when the registry is temporarily unreachable
- retries transient image-pull failures before fallback (`DOCKER_PULL_RETRIES`, `DOCKER_PULL_RETRY_DELAY_SECONDS`)
- forces classic `docker compose build` (`DOCKER_BUILDKIT=0`, `COMPOSE_DOCKER_CLI_BUILD=0`) to avoid local Docker Desktop `buildx activity` permission failures

Open:
- Web: `http://127.0.0.1:8080`
- API health (via nginx): `http://127.0.0.1:8080/api/health`
- nginx health: `http://127.0.0.1:8080/healthz`

Stop:
```bash
docker compose down
```

## Verify
```bash
npm run docker:healthcheck
npm run docker:verify:full
npm run smoke:admin:verification-reports
```

`docker:healthcheck` now includes runtime-executor checks inside `vistral-api`:
- confirms `VISTRAL_PYTHON_BIN` matches the expected runtime interpreter (default `/opt/vistral-venv/bin/python`)
- confirms `paddleocr`, `doctr`, and `ultralytics` are importable from that interpreter
- set `CHECK_RUNTIME_IMPORTS=0` to skip import checks for lightweight infra-only probes

`docker:verify:full` also runs:
- dataset export/import roundtrip (detection/ocr/segmentation)
- detection real-closure smoke
- dedicated OCR closure smoke
- OCR fallback guard smoke (ensures failed local OCR command returns empty OCR output with explicit fallback markers, never hardcoded business text)

OCR closure strictness:
- default deployment verify is non-strict for compatibility:
  - `npm run docker:verify:full`
- strict local-command-only OCR closure:
  - `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run smoke:ocr-closure`
  - `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run docker:verify:full`

Real-closure registration strictness:
- default deployment verify sets `REAL_CLOSURE_STRICT_REGISTRATION=false`
  - registration is still attempted first;
  - if blocked by non-real gate evidence, smoke output records `*_register_mode=blocked_gate_*` and continues with an existing registered version for downstream inference checks.
- strict registration behavior:
  - `REAL_CLOSURE_STRICT_REGISTRATION=true npm run smoke:real-closure`

`docker:verify:full` writes reports by default:
- `.data/verify-reports/docker-verify-full-<timestamp>.json`
- `.data/verify-reports/docker-verify-full-<timestamp>.md`

## Environment Variables
Set in `.env` (or CI/CD secrets):
- `LLM_CONFIG_SECRET`
- `DEFAULT_USER_ID`
- `DEFAULT_USER_PASSWORD`
- `DEFAULT_ADMIN_PASSWORD`
- `VISTRAL_PYTHON_BIN` (default `/opt/vistral-venv/bin/python` in Docker image)
- `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK` (default `True`; disables Paddle model-source connectivity pre-check to reduce startup jitter)
- `VISTRAL_AUTO_BOOTSTRAP_YOLO_MODEL` (default `1`; startup attempts to auto-download `yolo11n.pt` from ModelScope when local model path is empty/missing)
- `VISTRAL_AUTO_BOOTSTRAP_PADDLEOCR_MODELS` (default `1`; startup warms PaddleOCR local models and writes bootstrap marker)
- `VISTRAL_AUTO_BOOTSTRAP_DOCTR_MODELS` (default `1`; startup warms docTR local models and writes bootstrap marker)
- `VISTRAL_RUNTIME_BOOTSTRAP_BLOCKING` (default `0`; `1` waits warmup completion before API starts listening)
- `VISTRAL_RUNTIME_BOOTSTRAP_TIMEOUT_MS` (default `180000`; timeout budget for startup bootstrap tasks such as YOLO model auto-fetch)
- `VISTRAL_RUNTIME_MODELS_ROOT` (default `/app/.data/runtime-models`; shared root for runtime model/caches/markers)
- `PADDLE_HOME` (default `/app/.data/runtime-models/paddle-home`)
- `HF_HOME` (default `/app/.data/runtime-models/hf-home`)
- `DOCTR_CACHE_DIR` (default `/app/.data/runtime-models/doctr-cache`)
- `VISTRAL_DOCTR_PRESEEDED_MODELS_DIR` (compose default `/app/runtime-preseed/doctr`; optional directory with predownloaded docTR model artifacts copied into `DOCTR_CACHE_DIR/models` before warmup)
- `VISTRAL_DOCTR_PRESEEDED_MODELS_URLS` (optional comma-separated model artifact URLs for pre-seeding docTR cache when upstream is blocked)
- `ULTRALYTICS_CONFIG_DIR` (default `/app/.data/runtime-models/ultralytics`)
- `API_NODE_BASE_IMAGE` (default `docker.m.daocloud.io/library/node:20-bookworm-slim`)
- `API_DEBIAN_APT_MIRROR` (default `http://mirrors.tuna.tsinghua.edu.cn/debian`, can be switched to `http://deb.debian.org/debian`)
- `API_DEBIAN_APT_SECURITY_MIRROR` (default `http://mirrors.tuna.tsinghua.edu.cn/debian-security`, can be switched to `http://deb.debian.org/debian-security`)
- `API_PIP_INDEX_URL` (default `https://pypi.tuna.tsinghua.edu.cn/simple`, can be switched to `https://pypi.org/simple`)
- `API_PIP_EXTRA_INDEX_URL` (default `https://download.pytorch.org/whl/cpu`; used as default torch wheel index in Docker build)
- `API_PIP_TORCH_INDEX_URL` (optional explicit override for torch/torchvision wheel index; when empty, Docker build reuses `API_PIP_EXTRA_INDEX_URL`)
- `API_PIP_TRUSTED_HOST` (default `pypi.tuna.tsinghua.edu.cn`; leave empty for strict public PyPI verification)
- `PADDLEOCR_RUNTIME_ENDPOINT`, `PADDLEOCR_RUNTIME_API_KEY`
- `DOCTR_RUNTIME_ENDPOINT`, `DOCTR_RUNTIME_API_KEY`
- `YOLO_RUNTIME_ENDPOINT`, `YOLO_RUNTIME_API_KEY`
- `APP_STATE_BOOTSTRAP_MODE` (`minimal` recommended for fresh deployments)
- `RESET_FOUNDATION_PURGE_STORAGE` (used by `npm run data:reset:foundation`)
- `NODE_BASE_IMAGE`
- `NGINX_BASE_IMAGE`
- `VISTRAL_WEB_IMAGE`
- `VISTRAL_API_IMAGE`
- `DOCKER_PULL_RETRIES` (optional, default `3`)
- `DOCKER_PULL_RETRY_DELAY_SECONDS` (optional, default `2`)

Data hygiene recommendation before acceptance:
```bash
npm run data:reset:foundation
npm run smoke:foundation-reset
```

Fallback order when a base image env var is not set explicitly:
- `API_NODE_BASE_IMAGE`: `docker.m.daocloud.io/library/node:20-bookworm-slim` -> `node:20-bookworm-slim`
- `NODE_BASE_IMAGE`: `docker.m.daocloud.io/library/node:20-alpine` -> `node:20-alpine`
- `NGINX_BASE_IMAGE`: `docker.m.daocloud.io/library/nginx:1.27-alpine` -> `nginx:1.27-alpine`

Runtime options for verify script:
- `BASE_URL`
- `BUSINESS_USERNAME`
- `BUSINESS_PASSWORD`
- `PROBE_USERNAME`
- `PROBE_PASSWORD`
- `VERIFY_SKIP_HEALTHZ`
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND`
- `REAL_CLOSURE_STRICT_REGISTRATION`

Healthcheck-specific overrides:
- `CHECK_RUNTIME_IMPORTS` (default `1`; set `0` to skip runtime import checks)
- `RUNTIME_PYTHON_BIN` (default `/opt/vistral-venv/bin/python`; expected interpreter path inside `vistral-api`)

## Runtime Notes
- Backend session cookie is issued by same origin (`127.0.0.1:8080`) through nginx reverse proxy.
- Frontend only calls relative `/api/*`, so intranet domain replacement is straightforward.
- User authentication is username/password based.
- nginx proxy allows request bodies up to `128m` for multipart attachment upload flows.

## Training Worker Machines (B/C/D...)
Control plane remains this Docker stack on machine `A`.  
Worker-machine deployment/install assets are centralized in:

- `training-worker/README.md`
- `training-worker/.env.worker.example`
- `training-worker/scripts/install-deps.sh`
- `training-worker/scripts/worker-heartbeat.sh`
- `training-worker/scripts/worker-train-api.py`
- `training-worker/scripts/run-worker-node.sh`

Worker heartbeat contract:
- endpoint: `POST /api/runtime/training-workers/heartbeat`
- header: `X-Training-Worker-Token` (prefer per-worker `TRAINING_WORKER_AUTH_TOKEN`; shared fallback remains supported)

Worker Docker-first startup:
- worker Docker image: `docker/Dockerfile.worker`
- worker compose example: `training-worker/docker-compose.worker.yml`
- admin can generate one-time pairing commands from `Runtime > Add Worker`
- setup UI entry after container start: `http://<worker-host>:9090/setup`
- when config is incomplete, worker stays in setup mode and waits for GUI/CLI config instead of failing immediately

Worker training dispatch contract:
- endpoint: `POST {worker.endpoint}/api/worker/train`
- header: `X-Training-Worker-Token`
- control-plane fallback controls:
  - `TRAINING_WORKER_DISPATCH_TIMEOUT_MS`
  - `TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL`

Planned GUI onboarding design reference:
- `docs/training-worker-onboarding.md`
