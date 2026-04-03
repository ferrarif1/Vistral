#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VISTRAL_WEB_IMAGE="${VISTRAL_WEB_IMAGE:-vistral-web:round1}"
VISTRAL_API_IMAGE="${VISTRAL_API_IMAGE:-vistral-api:round1}"
NODE_BASE_IMAGE="${NODE_BASE_IMAGE:-node:20-alpine}"
NGINX_BASE_IMAGE="${NGINX_BASE_IMAGE:-nginx:1.27-alpine}"
PUSH_IMAGES="${PUSH_IMAGES:-false}"

echo "[docker-build-images] Building API image: ${VISTRAL_API_IMAGE}"
docker build \
  -f docker/Dockerfile.api \
  --build-arg NODE_BASE_IMAGE="${NODE_BASE_IMAGE}" \
  -t "${VISTRAL_API_IMAGE}" \
  .

echo "[docker-build-images] Building WEB image: ${VISTRAL_WEB_IMAGE}"
docker build \
  --build-arg NODE_BASE_IMAGE="${NODE_BASE_IMAGE}" \
  --build-arg NGINX_BASE_IMAGE="${NGINX_BASE_IMAGE}" \
  -t "${VISTRAL_WEB_IMAGE}" \
  .

if [[ "${PUSH_IMAGES}" == "true" ]]; then
  echo "[docker-build-images] Pushing API image: ${VISTRAL_API_IMAGE}"
  docker push "${VISTRAL_API_IMAGE}"

  echo "[docker-build-images] Pushing WEB image: ${VISTRAL_WEB_IMAGE}"
  docker push "${VISTRAL_WEB_IMAGE}"
fi

echo "[docker-build-images] DONE"
echo "  VISTRAL_API_IMAGE=${VISTRAL_API_IMAGE}"
echo "  VISTRAL_WEB_IMAGE=${VISTRAL_WEB_IMAGE}"
