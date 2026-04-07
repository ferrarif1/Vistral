#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP_VERIFY_REPORT_GROUPS="${KEEP_VERIFY_REPORT_GROUPS:-1}"
RUNTIME_PREDICT_CACHE_DIR="${RUNTIME_PREDICT_CACHE_DIR:-.data/runtime-local-predict}"
TRUNCATE_DEV_LOG="${TRUNCATE_DEV_LOG:-1}"

cd "${ROOT_DIR}"

echo "[cleanup-test-data] before:"
du -sh .data .data/* 2>/dev/null | sort -h || true

echo "[cleanup-test-data] pruning prototype state (KEEP_VERIFY_REPORT_GROUPS=${KEEP_VERIFY_REPORT_GROUPS})"
KEEP_VERIFY_REPORT_GROUPS="${KEEP_VERIFY_REPORT_GROUPS}" node scripts/prune-prototype-data.mjs

if [[ -d "${RUNTIME_PREDICT_CACHE_DIR}" ]]; then
  echo "[cleanup-test-data] clearing runtime predict cache: ${RUNTIME_PREDICT_CACHE_DIR}"
  find "${RUNTIME_PREDICT_CACHE_DIR}" -mindepth 1 -delete
fi

if [[ "${TRUNCATE_DEV_LOG}" == "1" && -f ".data/dev.log" ]]; then
  echo "[cleanup-test-data] truncating .data/dev.log"
  : > ".data/dev.log"
fi

echo "[cleanup-test-data] after:"
du -sh .data .data/* 2>/dev/null | sort -h || true
