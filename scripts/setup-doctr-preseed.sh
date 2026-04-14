#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

TARGET_DIR="${DOCTR_PRESEED_TARGET_DIR:-${ROOT_DIR}/runtime-assets/doctr-preseed}"
URLS_RAW="${VISTRAL_DOCTR_PRESEEDED_MODELS_URLS:-}"
EXPECTED_FILES_RAW="${VISTRAL_DOCTR_EXPECTED_MODEL_FILES:-db_resnet50-79bd7d70.pt,vgg16_bn_r-d108c19c.pt}"

mkdir -p "${TARGET_DIR}"

echo "[setup-doctr-preseed] target_dir=${TARGET_DIR}"

IFS=',' read -r -a EXPECTED_FILES <<< "${EXPECTED_FILES_RAW}"
IFS=',' read -r -a PRESEED_URLS <<< "${URLS_RAW}"

downloaded=0
for url in "${PRESEED_URLS[@]}"; do
  trimmed="$(echo "${url}" | xargs)"
  if [[ -z "${trimmed}" ]]; then
    continue
  fi
  filename="$(basename "${trimmed%%\?*}")"
  if [[ -z "${filename}" ]]; then
    echo "[setup-doctr-preseed] skip invalid url (no filename): ${trimmed}"
    continue
  fi
  target_file="${TARGET_DIR}/${filename}"
  if [[ -f "${target_file}" ]] && [[ "$(wc -c < "${target_file}")" -gt 1024 ]]; then
    echo "[setup-doctr-preseed] already exists, skip: ${filename}"
    continue
  fi
  temp_file="${target_file}.part"
  echo "[setup-doctr-preseed] downloading: ${trimmed}"
  curl -fL --retry 3 --connect-timeout 10 --max-time 300 "${trimmed}" -o "${temp_file}"
  if [[ ! -f "${temp_file}" ]] || [[ "$(wc -c < "${temp_file}")" -le 1024 ]]; then
    rm -f "${temp_file}"
    echo "[setup-doctr-preseed] download failed or file too small: ${trimmed}" >&2
    exit 1
  fi
  mv "${temp_file}" "${target_file}"
  downloaded=$((downloaded + 1))
done

missing=0
for expected in "${EXPECTED_FILES[@]}"; do
  file="$(echo "${expected}" | xargs)"
  if [[ -z "${file}" ]]; then
    continue
  fi
  path="${TARGET_DIR}/${file}"
  if [[ -f "${path}" ]] && [[ "$(wc -c < "${path}")" -gt 1024 ]]; then
    echo "[setup-doctr-preseed] ok: ${file}"
  else
    echo "[setup-doctr-preseed] missing: ${file}"
    missing=$((missing + 1))
  fi
done

echo "[setup-doctr-preseed] downloaded_count=${downloaded}"
if [[ "${missing}" -gt 0 ]]; then
  cat <<EOF
[setup-doctr-preseed] next:
  1. Put missing files into ${TARGET_DIR}
  2. Rebuild/restart API:
     docker compose up -d --build vistral-api
  3. Verify readiness:
     npm run smoke:runtime-success
EOF
  exit 2
fi

cat <<EOF
[setup-doctr-preseed] PASS
  docker-compose mount path:
    ${TARGET_DIR} -> /app/runtime-preseed/doctr (read-only)
  next:
    docker compose up -d --build vistral-api
EOF
