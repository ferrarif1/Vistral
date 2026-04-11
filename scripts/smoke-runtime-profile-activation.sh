#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-runtime-profile-activation] jq is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8800}"
BASE_URL="http://${API_HOST}:${API_PORT}"

RUNTIME_PROFILES_JSON='[
  {
    "id": "edge-lab",
    "label": "Edge Lab Profile",
    "description": "Smoke profile for runtime activation.",
    "frameworks": {
      "paddleocr": {
        "endpoint": "http://127.0.0.1:9901/predict",
        "api_key": "edge-lab-key"
      },
      "doctr": {
        "endpoint": "http://127.0.0.1:9902/predict"
      },
      "yolo": {
        "endpoint": "http://127.0.0.1:9903/predict"
      }
    },
    "controls": {
      "python_bin": "/opt/edge-lab/python",
      "disable_simulated_train_fallback": true,
      "disable_inference_fallback": true
    }
  }
]'

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_FILE" "$API_LOG"
}
trap cleanup EXIT

VISTRAL_RUNTIME_PROFILES_JSON="$RUNTIME_PROFILES_JSON" API_PORT="$API_PORT" npm run dev:api >"$API_LOG" 2>&1 &
API_PID=$!

for _ in $(seq 1 80); do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-runtime-profile-activation] API failed to start"
  cat "$API_LOG"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-runtime-profile-activation] failed to get csrf token"
  echo "$csrf_payload"
  exit 1
fi

login_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"username":"admin","password":"mock-pass-admin"}' \
  "${BASE_URL}/api/auth/login")"
login_success="$(echo "$login_payload" | jq -r '.success // false')"
if [[ "$login_success" != "true" ]]; then
  echo "[smoke-runtime-profile-activation] admin login failed"
  echo "$login_payload"
  exit 1
fi

csrf_after_login_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_after_login_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-runtime-profile-activation] failed to refresh csrf token after login"
  echo "$csrf_after_login_payload"
  exit 1
fi

runtime_before="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/settings/runtime")"
profiles_count="$(echo "$runtime_before" | jq -r '.data.available_profiles | length')"
edge_profile_source="$(echo "$runtime_before" | jq -r '.data.available_profiles[] | select(.id=="edge-lab") | .source // empty')"
if [[ "$profiles_count" -lt 2 || -z "$edge_profile_source" ]]; then
  echo "[smoke-runtime-profile-activation] expected saved + env profiles in runtime settings view"
  echo "$runtime_before"
  exit 1
fi

activate_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"profile_id":"edge-lab"}' \
  "${BASE_URL}/api/settings/runtime/activate-profile")"

active_profile="$(echo "$activate_payload" | jq -r '.data.active_profile_id // empty')"
active_endpoint="$(echo "$activate_payload" | jq -r '.data.frameworks.paddleocr.endpoint // empty')"
active_has_key="$(echo "$activate_payload" | jq -r '.data.frameworks.paddleocr.has_api_key // false')"
active_python_bin="$(echo "$activate_payload" | jq -r '.data.controls.python_bin // empty')"
active_disable_simulated_fallback="$(echo "$activate_payload" | jq -r '.data.controls.disable_simulated_train_fallback // false')"
active_disable_inference_fallback="$(echo "$activate_payload" | jq -r '.data.controls.disable_inference_fallback // false')"
if [[ "$active_profile" != "edge-lab" ]]; then
  echo "[smoke-runtime-profile-activation] expected active profile edge-lab"
  echo "$activate_payload"
  exit 1
fi
if [[ "$active_endpoint" != "http://127.0.0.1:9901/predict" || "$active_has_key" != "true" ]]; then
  echo "[smoke-runtime-profile-activation] expected activated profile configs reflected in runtime view"
  echo "$activate_payload"
  exit 1
fi
if [[ "$active_python_bin" != "/opt/edge-lab/python" || "$active_disable_simulated_fallback" != "true" || "$active_disable_inference_fallback" != "true" ]]; then
  echo "[smoke-runtime-profile-activation] expected activated profile controls reflected in runtime view"
  echo "$activate_payload"
  exit 1
fi

echo "[smoke-runtime-profile-activation] PASS"
