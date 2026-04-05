#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

run_step() {
  local cmd="$1"
  echo "[smoke-core-closure] running: npm run ${cmd}"
  npm run "${cmd}"
}

run_step "smoke:no-seed-hardcoding"
run_step "smoke:account-governance"
run_step "smoke:phase2"
run_step "smoke:conversation-actions"
run_step "smoke:inference-feedback-guard"
run_step "smoke:real-closure"
run_step "smoke:ocr-closure"

echo "[smoke-core-closure] PASS"
