#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

export LLM_CONFIG_SECRET="${LLM_CONFIG_SECRET:-smoke-core-closure-$(date +%s)}"

run_step() {
  local cmd="$1"
  echo "[smoke-core-closure] running: npm run ${cmd}"
  npm run "${cmd}"
}

run_step "smoke:no-seed-hardcoding"
run_step "smoke:foundation-reset"
run_step "smoke:adapter-no-placeholder"
run_step "smoke:training-template-guard"
run_step "smoke:model-version-register-gate"
run_step "smoke:account-governance"
run_step "smoke:phase2"
run_step "smoke:runtime-success"
run_step "smoke:conversation-actions"
run_step "smoke:inference-feedback-guard"
run_step "smoke:real-closure"
run_step "smoke:ocr-closure"
run_step "smoke:training-worker-dedicated-auth"

echo "[smoke-core-closure] PASS"
