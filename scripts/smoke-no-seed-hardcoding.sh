#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

shopt -s nullglob
TARGETS=(scripts/smoke-*.sh scripts/docker-verify-full.sh)
shopt -u nullglob

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "[smoke-no-seed-hardcoding] no target scripts found."
  exit 1
fi

PATTERN_ENTITY_ID='\\b(m|d|dv|mv|f|u|tj|c|ar)-[0-9]+\\b'
PATTERN_REQUEST_PAYLOAD='"model_id"\\s*:\\s*"m-|"model_version_id"\\s*:\\s*"mv-|"dataset_id"\\s*:\\s*"d-|"dataset_version_id"\\s*:\\s*"dv-|"input_attachment_id"\\s*:\\s*"f-'

entity_matches="$(rg -n "${PATTERN_ENTITY_ID}" "${TARGETS[@]}" || true)"
payload_matches="$(rg -n "${PATTERN_REQUEST_PAYLOAD}" "${TARGETS[@]}" || true)"

if [[ -n "${entity_matches}" || -n "${payload_matches}" ]]; then
  echo "[smoke-no-seed-hardcoding] found hardcoded seed ids in smoke/verify scripts."
  if [[ -n "${entity_matches}" ]]; then
    echo
    echo "[entity-id matches]"
    echo "${entity_matches}"
  fi
  if [[ -n "${payload_matches}" ]]; then
    echo
    echo "[request-payload matches]"
    echo "${payload_matches}"
  fi
  exit 1
fi

echo "[smoke-no-seed-hardcoding] PASS"
