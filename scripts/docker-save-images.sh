#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VISTRAL_WEB_IMAGE="${VISTRAL_WEB_IMAGE:-vistral-web:round1}"
VISTRAL_API_IMAGE="${VISTRAL_API_IMAGE:-vistral-api:round1}"
OUTPUT_TAR="${OUTPUT_TAR:-vistral-images-round1.tar}"

docker image inspect "${VISTRAL_WEB_IMAGE}" >/dev/null
docker image inspect "${VISTRAL_API_IMAGE}" >/dev/null

echo "[docker-save-images] Saving images to ${OUTPUT_TAR}"
docker save "${VISTRAL_WEB_IMAGE}" "${VISTRAL_API_IMAGE}" -o "${OUTPUT_TAR}"

echo "[docker-save-images] DONE"
echo "  output=${OUTPUT_TAR}"
echo "  includes=${VISTRAL_WEB_IMAGE},${VISTRAL_API_IMAGE}"
