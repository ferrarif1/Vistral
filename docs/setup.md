# Setup Guide

## 1) Prerequisites
- Git
- A POSIX shell environment
- Your preferred editor/IDE
- Node.js 20+
- npm 10+

## 2) Clone
```bash
git clone <your-fork-or-origin-url>
cd Vistral
```

## 3) Read Before Coding
Follow this order before making changes:
1. `README.md`
2. `AGENTS.md`
3. `.codex/config.toml`
4. `docs/prd.md`
5. `docs/ia.md`
6. `docs/flows.md`
7. `docs/data-model.md`
8. `docs/api-contract.md`

## 4) Local development
```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## 5) Docker deployment (intranet-ready)
```bash
cp .env.example .env
docker compose up --build -d
```

Open `http://127.0.0.1:8080`.

If deployment host cannot build/pull from Docker Hub, use prebuilt registry images:
```bash
docker compose -f docker-compose.registry.yml up -d
```

Useful deployment helpers:
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
```

`docker:verify:full` writes audit-style reports to `.data/verify-reports/`.
`docker:release:bundle` accepts optional gates:
- `VERIFY_REPORT_PATH=<report.json|report.md>` include specific report files
- `VERIFY_REPORT_MAX_AGE_SECONDS=<seconds>` fail if selected report is too old

## 6) Baseline Validation
For docs-focused changes, run at least:
```bash
rg "docs/setup.md|docs/contributing.md" README.md
```

Then manually verify any links you touched are valid repository paths.

For code changes, run:
```bash
npm run typecheck
npm run lint
npm run build
```

## 7) Demo Dataset Import (train images)
Use local images under `demo_data/train` to quickly build a detection dataset in mock mode:
```bash
npm run smoke:demo:train-data
```

Optional controls:
- `MAX_FILES=120 npm run smoke:demo:train-data` limit uploaded files (0 means all files)
- `START_API=false BASE_URL=http://127.0.0.1:8080 npm run smoke:demo:train-data` reuse an already running API
