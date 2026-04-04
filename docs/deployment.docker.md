# Docker Deployment (Round 1)

This repository now runs as a full-stack Docker deployment for intranet environments:
- `vistral-web` (nginx frontend + `/api` reverse proxy)
- `vistral-api` (Node backend with mock workflow + runtime bridge diagnostics)

## Prerequisites
- Docker Engine + Docker Compose

## Mode A: Local build and run
```bash
cp .env.example .env
docker compose up --build -d
```

If Docker Hub is slow or blocked on the build host, update `.env` before build:
```bash
NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-alpine
NGINX_BASE_IMAGE=docker.m.daocloud.io/library/nginx:1.27-alpine
docker compose up --build -d
```

Open:
- Web: `http://127.0.0.1:8080`
- API health (via nginx): `http://127.0.0.1:8080/api/health`
- nginx health: `http://127.0.0.1:8080/healthz`

Stop:
```bash
docker compose down
```

## Mode B: Internal registry deployment (no local build)
Use this mode when deployment nodes cannot access Docker Hub directly.

1) Build and push images in a connected build environment:
```bash
VISTRAL_WEB_IMAGE=registry.local/vistral/vistral-web:round1 \
VISTRAL_API_IMAGE=registry.local/vistral/vistral-api:round1 \
npm run docker:images:build-push
```

2) Set image refs in `.env` on deployment host:
```bash
VISTRAL_WEB_IMAGE=registry.local/vistral/vistral-web:round1
VISTRAL_API_IMAGE=registry.local/vistral/vistral-api:round1
```

You can also start from `.env.registry.example`.

3) Run registry compose:
```bash
docker compose -f docker-compose.registry.yml up -d
```

You can also run:
```bash
npm run docker:up:registry
```

Stop:
```bash
docker compose -f docker-compose.registry.yml down
```

## Mode C: Air-gapped offline import
If deployment host has no registry access:

1) On connected host, export images:
```bash
VISTRAL_WEB_IMAGE=registry.local/vistral/vistral-web:round1 \
VISTRAL_API_IMAGE=registry.local/vistral/vistral-api:round1 \
OUTPUT_TAR=vistral-images-round1.tar \
npm run docker:images:save
```

2) Transfer tar file to offline host and import:
```bash
IMAGE_TAR=vistral-images-round1.tar npm run docker:images:load-up
```

3) Set `VISTRAL_WEB_IMAGE` / `VISTRAL_API_IMAGE` in `.env` and run:
```bash
docker compose -f docker-compose.registry.yml up -d
```

## Mode D: Release bundle handoff (recommended for Ops transfer)
Generate a delivery bundle on build machine:
```bash
npm run docker:release:bundle
```

Run verification first and include fresh reports:
```bash
VERIFY_BASE_URL=http://127.0.0.1:8080 npm run docker:release:bundle:verified
```

Output includes:
- `vistral-images.tar`
- compose files and env examples
- deployment doc copy
- ops scripts (`docker-load-and-up.sh`, `docker-healthcheck.sh`, `docker-verify-full.sh`, `smoke-dataset-export-roundtrip.sh`, `smoke-real-closure.sh`)
- versioned `RELEASE_NOTES.md`
- `manifest.json`
- `SHA256SUMS.txt`
- packaged archive `release/<bundle>.tar.gz`

Optional:
- skip image rebuild if already built: `SKIP_BUILD=true npm run docker:release:bundle`
- pin a specific verify report file (json/md): `VERIFY_REPORT_PATH=.data/verify-reports/docker-verify-full-20260402-223826.json npm run docker:release:bundle`
- enforce report freshness (seconds): `VERIFY_REPORT_MAX_AGE_SECONDS=1800 npm run docker:release:bundle`
- override verify precheck timeout (seconds): `VERIFY_PRECHECK_TIMEOUT_SECONDS=8 npm run docker:release:bundle:verified`

## Environment variables
Set in `.env` (or CI/CD secrets):
- `LLM_CONFIG_SECRET`
- `DEFAULT_USER_ID`
- `DEFAULT_USER_PASSWORD`
- `DEFAULT_ADMIN_PASSWORD`
- `PADDLEOCR_RUNTIME_ENDPOINT`, `PADDLEOCR_RUNTIME_API_KEY`
- `DOCTR_RUNTIME_ENDPOINT`, `DOCTR_RUNTIME_API_KEY`
- `YOLO_RUNTIME_ENDPOINT`, `YOLO_RUNTIME_API_KEY`
- `NODE_BASE_IMAGE` (build mode only, default `node:20-alpine`)
- `NGINX_BASE_IMAGE` (build mode only, default `nginx:1.27-alpine`)
- `VISTRAL_WEB_IMAGE`
- `VISTRAL_API_IMAGE`

Release/verify script options (shell env at run time):
- `VERIFY_BASE_URL`
- `VERIFY_REPORT_DIR`
- `VERIFY_REPORT_PATH`
- `VERIFY_REPORT_MAX_AGE_SECONDS`
- `VERIFY_PRECHECK_TIMEOUT_SECONDS`
- `RUN_VERIFY_FULL`

## Automation scripts
- `scripts/docker-build-images.sh`: build API/WEB images; optional push with `PUSH_IMAGES=true`
- `scripts/docker-save-images.sh`: export images to tar for offline transfer
- `scripts/docker-load-and-up.sh`: optional `docker load` then compose up
- `scripts/docker-healthcheck.sh`: verify `/healthz`, `/api/health`, username/password auth, and wrong-password rejection
- `scripts/docker-verify-full.sh`: end-to-end verification (auth + negative auth check + real multipart attachments + conversation + model approval + runtime + inference + feedback + dataset export/import roundtrip + real closure smoke with YOLO/PaddleOCR/docTR)
- `scripts/smoke-dataset-export-roundtrip.sh`: dataset export/import roundtrip check (detection yolo/coco/labelme + ocr + segmentation labelme polygon)
- `scripts/smoke-real-closure.sh`: full-loop smoke check (task draft + upload/import/export + YOLO train/register/infer/feedback + PaddleOCR infer + docTR train/register/infer)
- `scripts/docker-release-bundle.sh`: produce release bundle with checksums and manifest
- `scripts/smoke-admin-verification-reports.sh`: verify admin-only permission boundary for `/api/admin/verification-reports`

Quick verify commands:
```bash
npm run docker:healthcheck
npm run docker:verify:full
npm run smoke:admin:verification-reports
```

`docker:verify:full` generates report artifacts by default:
- `.data/verify-reports/docker-verify-full-<timestamp>.json`
- `.data/verify-reports/docker-verify-full-<timestamp>.md`

`docker:release:bundle` includes verify report files when available.
- default: picks latest report from `.data/verify-reports/`
- override: `VERIFY_REPORT_PATH=<path-to-json-or-md>`
- optional freshness gate: `VERIFY_REPORT_MAX_AGE_SECONDS=<seconds>`

If your seeded business password is customized:
```bash
BUSINESS_PASSWORD=<your-password> npm run docker:verify:full
```

## Runtime notes
- Backend session cookie is issued by same origin (`127.0.0.1:8080`) through nginx reverse proxy.
- Frontend only calls relative `/api/*`, so intranet domain replacement is straightforward.
- User authentication is username/password based; public registration always creates `user` only.
- Docker nginx proxy allows request bodies up to `128m` for multipart attachment upload flows.
