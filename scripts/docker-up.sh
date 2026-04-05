#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# Keep a single Docker-first workflow by default.
NODE_BASE_IMAGE="${NODE_BASE_IMAGE:-docker.m.daocloud.io/library/node:20-alpine}"
NGINX_BASE_IMAGE="${NGINX_BASE_IMAGE:-docker.m.daocloud.io/library/nginx:1.27-alpine}"
VISTRAL_API_IMAGE="${VISTRAL_API_IMAGE:-vistral-api:round1}"
VISTRAL_WEB_IMAGE="${VISTRAL_WEB_IMAGE:-vistral-web:round1}"

echo "[docker-up] starting pure docker stack build + up"
echo "  NODE_BASE_IMAGE=${NODE_BASE_IMAGE}"
echo "  NGINX_BASE_IMAGE=${NGINX_BASE_IMAGE}"
echo "  VISTRAL_API_IMAGE=${VISTRAL_API_IMAGE}"
echo "  VISTRAL_WEB_IMAGE=${VISTRAL_WEB_IMAGE}"

NODE_BASE_IMAGE="${NODE_BASE_IMAGE}" \
NGINX_BASE_IMAGE="${NGINX_BASE_IMAGE}" \
VISTRAL_API_IMAGE="${VISTRAL_API_IMAGE}" \
VISTRAL_WEB_IMAGE="${VISTRAL_WEB_IMAGE}" \
docker compose up --build -d

echo "[docker-up] done"
echo "  chat_url=http://localhost:8080/workspace/chat"
