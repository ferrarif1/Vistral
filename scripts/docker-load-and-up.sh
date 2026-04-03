#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE_TAR="${IMAGE_TAR:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.registry.yml}"

if [[ -n "${IMAGE_TAR}" ]]; then
  if [[ ! -f "${IMAGE_TAR}" ]]; then
    echo "[docker-load-and-up] IMAGE_TAR not found: ${IMAGE_TAR}"
    exit 1
  fi

  echo "[docker-load-and-up] Loading image tar: ${IMAGE_TAR}"
  docker load -i "${IMAGE_TAR}"
fi

echo "[docker-load-and-up] Starting stack with ${COMPOSE_FILE}"
docker compose -f "${COMPOSE_FILE}" up -d

echo "[docker-load-and-up] DONE"
