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

# Confirm host-facing index matches the freshly started web container index.
extract_asset_hashes() {
  local html="$1"
  local script_hash
  local style_hash
  script_hash="$(printf '%s' "${html}" | sed -n "s#.*src=\"/assets/\\([^\"]*\\)\".*#\\1#p" | head -n 1)"
  style_hash="$(printf '%s' "${html}" | sed -n "s#.*href=\"/assets/\\([^\"]*\\)\".*#\\1#p" | head -n 1)"
  printf '%s|%s' "${script_hash}" "${style_hash}"
}

container_index_html="$(docker exec vistral-web sh -lc "cat /usr/share/nginx/html/index.html" 2>/dev/null || true)"
container_hashes="$(extract_asset_hashes "${container_index_html}")"

if [ -n "${container_hashes}" ] && [ "${container_hashes}" != "|" ]; then
  sync_ok="false"
  for _ in $(seq 1 15); do
    host_index_html="$(curl -fsS -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' http://127.0.0.1:8080/ 2>/dev/null || true)"
    host_hashes="$(extract_asset_hashes "${host_index_html}")"

    if [ "${host_hashes}" = "${container_hashes}" ]; then
      sync_ok="true"
      break
    fi

    sleep 1
  done

  if [ "${sync_ok}" = "true" ]; then
    echo "[docker-up] web asset sync check passed (${container_hashes})"
  else
    echo "[docker-up] warning: host index hashes (${host_hashes}) differ from container (${container_hashes})"
    echo "[docker-up] tip: hard refresh browser (Cmd+Shift+R) and retry in a few seconds"
  fi
fi

echo "[docker-up] done"
echo "  chat_url=http://localhost:8080/workspace/chat"
