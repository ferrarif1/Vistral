# Docker Deployment (Round 1)

This repository can be deployed as a single Docker image for intranet migration.

## Why this helps for intranet deployment
- Standardized runtime (Nginx static hosting)
- Portable image artifact for private registries
- Minimal host dependencies (Docker/Podman only)

## Build and run
```bash
docker build -t vistral-web:round1 .
docker run --rm -p 8080:80 vistral-web:round1
```

Then open: `http://localhost:8080`

Health endpoint: `http://localhost:8080/healthz`

## Docker Compose
```bash
docker compose up --build -d
```

## Notes
- Current round is frontend + mock handlers only.
- When backend is added, recommend splitting into:
  - `vistral-web` (frontend)
  - `vistral-api` (backend)
  - optional `postgres` service
