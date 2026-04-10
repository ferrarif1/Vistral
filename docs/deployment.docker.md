# Docker Deployment (Single Path)

This repository uses one deployment path only:
- `vistral-web` (nginx frontend + `/api` reverse proxy)
- `vistral-api` (Node backend with mock workflow + runtime bridge diagnostics)

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
- `PADDLEOCR_RUNTIME_ENDPOINT`, `PADDLEOCR_RUNTIME_API_KEY`
- `DOCTR_RUNTIME_ENDPOINT`, `DOCTR_RUNTIME_API_KEY`
- `YOLO_RUNTIME_ENDPOINT`, `YOLO_RUNTIME_API_KEY`
- `APP_STATE_BOOTSTRAP_MODE` (`minimal` recommended for fresh deployments)
- `RESET_FOUNDATION_PURGE_STORAGE` (used by `npm run data:reset:foundation`)
- `NODE_BASE_IMAGE`
- `NGINX_BASE_IMAGE`
- `VISTRAL_WEB_IMAGE`
- `VISTRAL_API_IMAGE`

Data hygiene recommendation before acceptance:
```bash
npm run data:reset:foundation
npm run smoke:foundation-reset
```

Fallback order when a base image env var is not set explicitly:
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
