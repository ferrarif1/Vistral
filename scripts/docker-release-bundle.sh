#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TIMESTAMP_UTC="$(date -u +%Y%m%d-%H%M%S)"
APP_VERSION="${APP_VERSION:-$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));process.stdout.write(String(p.version||"0.0.0"));')}"
RELEASE_NAME="${RELEASE_NAME:-vistral-v${APP_VERSION}-${TIMESTAMP_UTC}}"
RELEASE_DIR="${RELEASE_DIR:-release/${RELEASE_NAME}}"
PACKAGE_TAR="${PACKAGE_TAR:-${RELEASE_DIR}.tar.gz}"
SKIP_BUILD="${SKIP_BUILD:-false}"
RUN_VERIFY_FULL="${RUN_VERIFY_FULL:-false}"
INCLUDE_VERIFY_REPORTS="${INCLUDE_VERIFY_REPORTS:-true}"
VERIFY_BASE_URL="${VERIFY_BASE_URL:-http://127.0.0.1:8080}"
VERIFY_REPORT_DIR="${VERIFY_REPORT_DIR:-.data/verify-reports}"
VERIFY_REPORT_PATH="${VERIFY_REPORT_PATH:-}"
VERIFY_REPORT_MAX_AGE_SECONDS="${VERIFY_REPORT_MAX_AGE_SECONDS:-0}"
VERIFY_PRECHECK_TIMEOUT_SECONDS="${VERIFY_PRECHECK_TIMEOUT_SECONDS:-5}"

VISTRAL_WEB_IMAGE="${VISTRAL_WEB_IMAGE:-vistral-web:round1}"
VISTRAL_API_IMAGE="${VISTRAL_API_IMAGE:-vistral-api:round1}"
NODE_BASE_IMAGE="${NODE_BASE_IMAGE:-node:20-alpine}"
NGINX_BASE_IMAGE="${NGINX_BASE_IMAGE:-nginx:1.27-alpine}"

file_age_seconds() {
  local target_file="$1"
  node -e '
const fs = require("fs");
const target = process.argv[1];
const stat = fs.statSync(target);
const ageSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
process.stdout.write(String(ageSeconds));
' "${target_file}"
}

resolve_verify_report_path() {
  local raw_path="$1"

  if [[ -f "${raw_path}" ]]; then
    echo "${raw_path}"
    return 0
  fi

  if [[ -f "${VERIFY_REPORT_DIR}/${raw_path}" ]]; then
    echo "${VERIFY_REPORT_DIR}/${raw_path}"
    return 0
  fi

  return 1
}

if [[ -e "${RELEASE_DIR}" ]]; then
  echo "[docker-release-bundle] release dir already exists: ${RELEASE_DIR}"
  echo "Set RELEASE_NAME/RELEASE_DIR to a new value."
  exit 1
fi

if [[ "${RUN_VERIFY_FULL}" == "true" ]]; then
  echo "[docker-release-bundle] probing verify target before full verification"
  if ! curl -fsS --max-time "${VERIFY_PRECHECK_TIMEOUT_SECONDS}" "${VERIFY_BASE_URL}/healthz" >/dev/null; then
    echo "[docker-release-bundle] verify target is unreachable: ${VERIFY_BASE_URL}/healthz"
    exit 1
  fi

  if ! curl -fsS --max-time "${VERIFY_PRECHECK_TIMEOUT_SECONDS}" "${VERIFY_BASE_URL}/api/health" >/dev/null; then
    echo "[docker-release-bundle] verify target is unreachable: ${VERIFY_BASE_URL}/api/health"
    exit 1
  fi

  echo "[docker-release-bundle] running full verification before packaging"
  BASE_URL="${VERIFY_BASE_URL}" \
  REPORT_DIR="${VERIFY_REPORT_DIR}" \
  REPORT_BASENAME="docker-verify-full-${TIMESTAMP_UTC}" \
  bash scripts/docker-verify-full.sh
fi

if [[ "${SKIP_BUILD}" != "true" ]]; then
  echo "[docker-release-bundle] building images before packaging"
  VISTRAL_WEB_IMAGE="${VISTRAL_WEB_IMAGE}" \
  VISTRAL_API_IMAGE="${VISTRAL_API_IMAGE}" \
  NODE_BASE_IMAGE="${NODE_BASE_IMAGE}" \
  NGINX_BASE_IMAGE="${NGINX_BASE_IMAGE}" \
  bash scripts/docker-build-images.sh
fi

mkdir -p "${RELEASE_DIR}"

echo "[docker-release-bundle] exporting images"
VISTRAL_WEB_IMAGE="${VISTRAL_WEB_IMAGE}" \
VISTRAL_API_IMAGE="${VISTRAL_API_IMAGE}" \
OUTPUT_TAR="${RELEASE_DIR}/vistral-images.tar" \
bash scripts/docker-save-images.sh

mkdir -p "${RELEASE_DIR}/docs" "${RELEASE_DIR}/scripts"

cp docker-compose.yml "${RELEASE_DIR}/docker-compose.yml"
cp docker-compose.registry.yml "${RELEASE_DIR}/docker-compose.registry.yml"
cp .env.example "${RELEASE_DIR}/.env.example"
cp .env.registry.example "${RELEASE_DIR}/.env.registry.example"
cp docs/deployment.docker.md "${RELEASE_DIR}/docs/deployment.docker.md"
cp scripts/docker-load-and-up.sh "${RELEASE_DIR}/scripts/docker-load-and-up.sh"
cp scripts/docker-healthcheck.sh "${RELEASE_DIR}/scripts/docker-healthcheck.sh"
cp scripts/docker-verify-full.sh "${RELEASE_DIR}/scripts/docker-verify-full.sh"
cp scripts/smoke-dataset-export-roundtrip.sh "${RELEASE_DIR}/scripts/smoke-dataset-export-roundtrip.sh"
cp scripts/smoke-real-closure.sh "${RELEASE_DIR}/scripts/smoke-real-closure.sh"
chmod +x "${RELEASE_DIR}/scripts/"*.sh

VERIFY_JSON_DEST=''
VERIFY_MD_DEST=''
VERIFY_REPORT_INCLUDED='false'
VERIFY_REPORT_SOURCE=''
VERIFY_REPORT_AGE_SECONDS=''
if [[ "${INCLUDE_VERIFY_REPORTS}" == "true" ]]; then
  selected_verify_json=''
  selected_verify_md=''

  if [[ -n "${VERIFY_REPORT_PATH}" ]]; then
    resolved_verify_path="$(resolve_verify_report_path "${VERIFY_REPORT_PATH}" || true)"
    if [[ -z "${resolved_verify_path}" ]]; then
      echo "[docker-release-bundle] verify report path not found: ${VERIFY_REPORT_PATH}"
      exit 1
    fi

    VERIFY_REPORT_SOURCE="${resolved_verify_path}"
    case "${resolved_verify_path}" in
      *.json)
        selected_verify_json="${resolved_verify_path}"
        paired_md="${resolved_verify_path%.json}.md"
        if [[ -f "${paired_md}" ]]; then
          selected_verify_md="${paired_md}"
        fi
        ;;
      *.md)
        selected_verify_md="${resolved_verify_path}"
        paired_json="${resolved_verify_path%.md}.json"
        if [[ -f "${paired_json}" ]]; then
          selected_verify_json="${paired_json}"
        fi
        ;;
      *)
        echo "[docker-release-bundle] VERIFY_REPORT_PATH must point to a .json or .md report file"
        exit 1
        ;;
    esac
  elif [[ -d "${VERIFY_REPORT_DIR}" ]]; then
    selected_verify_json="$(ls -1t "${VERIFY_REPORT_DIR}"/docker-verify-full-*.json 2>/dev/null | head -n 1 || true)"
    selected_verify_md="$(ls -1t "${VERIFY_REPORT_DIR}"/docker-verify-full-*.md 2>/dev/null | head -n 1 || true)"
    VERIFY_REPORT_SOURCE="${selected_verify_json:-${selected_verify_md:-}}"

    if [[ -n "${selected_verify_json}" ]]; then
      paired_md="${selected_verify_json%.json}.md"
      if [[ -f "${paired_md}" ]]; then
        selected_verify_md="${paired_md}"
      fi
    elif [[ -n "${selected_verify_md}" ]]; then
      paired_json="${selected_verify_md%.md}.json"
      if [[ -f "${paired_json}" ]]; then
        selected_verify_json="${paired_json}"
      fi
    fi
  fi

  if [[ "${VERIFY_REPORT_MAX_AGE_SECONDS}" != "0" && -n "${VERIFY_REPORT_SOURCE}" ]]; then
    if ! [[ "${VERIFY_REPORT_MAX_AGE_SECONDS}" =~ ^[0-9]+$ ]]; then
      echo "[docker-release-bundle] VERIFY_REPORT_MAX_AGE_SECONDS must be an integer >= 0"
      exit 1
    fi

    VERIFY_REPORT_AGE_SECONDS="$(file_age_seconds "${VERIFY_REPORT_SOURCE}")"
    if (( VERIFY_REPORT_AGE_SECONDS > VERIFY_REPORT_MAX_AGE_SECONDS )); then
      echo "[docker-release-bundle] verify report is too old (${VERIFY_REPORT_AGE_SECONDS}s > ${VERIFY_REPORT_MAX_AGE_SECONDS}s): ${VERIFY_REPORT_SOURCE}"
      exit 1
    fi
  fi

  if [[ -n "${selected_verify_json}" && -f "${selected_verify_json}" ]]; then
    mkdir -p "${RELEASE_DIR}/verification"
    VERIFY_JSON_DEST="${RELEASE_DIR}/verification/$(basename "${selected_verify_json}")"
    cp "${selected_verify_json}" "${VERIFY_JSON_DEST}"
    VERIFY_REPORT_INCLUDED='true'
  fi

  if [[ -n "${selected_verify_md}" && -f "${selected_verify_md}" ]]; then
    mkdir -p "${RELEASE_DIR}/verification"
    VERIFY_MD_DEST="${RELEASE_DIR}/verification/$(basename "${selected_verify_md}")"
    cp "${selected_verify_md}" "${VERIFY_MD_DEST}"
    VERIFY_REPORT_INCLUDED='true'
  fi
fi

GIT_COMMIT="unknown"
GIT_BRANCH="unknown"
WORKTREE_DIRTY="unknown"
RECENT_COMMITS_MD="- unavailable"
if command -v git >/dev/null 2>&1; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
      WORKTREE_DIRTY="true"
    else
      WORKTREE_DIRTY="false"
    fi

    RECENT_COMMITS_MD="$(git log --pretty='- %h %s' -n 10 2>/dev/null || true)"
    if [[ -z "${RECENT_COMMITS_MD}" ]]; then
      RECENT_COMMITS_MD='- unavailable'
    fi
  fi
fi

CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VERIFY_JSON_FILE=''
VERIFY_MD_FILE=''
if [[ -n "${VERIFY_JSON_DEST}" ]]; then
  VERIFY_JSON_FILE="verification/$(basename "${VERIFY_JSON_DEST}")"
fi
if [[ -n "${VERIFY_MD_DEST}" ]]; then
  VERIFY_MD_FILE="verification/$(basename "${VERIFY_MD_DEST}")"
fi

cat > "${RELEASE_DIR}/RELEASE_NOTES.md" <<MD
# Vistral Release Notes

- Release Name: ${RELEASE_NAME}
- App Version: ${APP_VERSION}
- Created At (UTC): ${CREATED_AT}
- Git Branch: ${GIT_BRANCH}
- Git Commit: ${GIT_COMMIT}
- Worktree Dirty During Packaging: ${WORKTREE_DIRTY}

## Images
- Web: \`${VISTRAL_WEB_IMAGE}\`
- API: \`${VISTRAL_API_IMAGE}\`

## Verification Reports
- Included: ${VERIFY_REPORT_INCLUDED}
- JSON: ${VERIFY_JSON_FILE:-not included}
- Markdown: ${VERIFY_MD_FILE:-not included}
- Source: ${VERIFY_REPORT_SOURCE:-auto/latest}
- Max Age Seconds: ${VERIFY_REPORT_MAX_AGE_SECONDS}
- Resolved Age Seconds: ${VERIFY_REPORT_AGE_SECONDS:-n/a}

## Included Assets
- vistral-images.tar
- docker-compose.yml
- docker-compose.registry.yml
- .env.example
- .env.registry.example
- docs/deployment.docker.md
- scripts/docker-load-and-up.sh
- scripts/docker-healthcheck.sh
- scripts/docker-verify-full.sh
- scripts/smoke-dataset-export-roundtrip.sh
- scripts/smoke-real-closure.sh
- RELEASE_NOTES.md
- manifest.json
- SHA256SUMS.txt

## Deployment Quick Start (offline/inner-network)
1. Extract package.
2. Load images and start stack: \`IMAGE_TAR=vistral-images.tar bash scripts/docker-load-and-up.sh\`
3. Basic health check: \`bash scripts/docker-healthcheck.sh\`
4. Full E2E verification: \`bash scripts/docker-verify-full.sh\`

## Recent Commits
${RECENT_COMMITS_MD}
MD

cat > "${RELEASE_DIR}/manifest.json" <<JSON
{
  "name": "${RELEASE_NAME}",
  "app_version": "${APP_VERSION}",
  "created_at_utc": "${CREATED_AT}",
  "git": {
    "branch": "${GIT_BRANCH}",
    "commit": "${GIT_COMMIT}",
    "worktree_dirty": "${WORKTREE_DIRTY}"
  },
  "images": {
    "web": "${VISTRAL_WEB_IMAGE}",
    "api": "${VISTRAL_API_IMAGE}"
  },
  "verification_reports": {
    "included": "${VERIFY_REPORT_INCLUDED}",
    "json": "${VERIFY_JSON_FILE}",
    "markdown": "${VERIFY_MD_FILE}",
    "source": "${VERIFY_REPORT_SOURCE}",
    "max_age_seconds": "${VERIFY_REPORT_MAX_AGE_SECONDS}",
    "resolved_age_seconds": "${VERIFY_REPORT_AGE_SECONDS}"
  },
  "files": [
    "vistral-images.tar",
    "docker-compose.yml",
    "docker-compose.registry.yml",
    ".env.example",
    ".env.registry.example",
    "docs/deployment.docker.md",
    "scripts/docker-load-and-up.sh",
    "scripts/docker-healthcheck.sh",
    "scripts/docker-verify-full.sh",
    "scripts/smoke-dataset-export-roundtrip.sh",
    "scripts/smoke-real-closure.sh",
    "RELEASE_NOTES.md",
    "manifest.json",
    "SHA256SUMS.txt"
  ]
}
JSON

checksum_files=(
  vistral-images.tar
  docker-compose.yml
  docker-compose.registry.yml
  .env.example
  .env.registry.example
  docs/deployment.docker.md
  scripts/docker-load-and-up.sh
  scripts/docker-healthcheck.sh
  scripts/docker-verify-full.sh
  scripts/smoke-dataset-export-roundtrip.sh
  scripts/smoke-real-closure.sh
  RELEASE_NOTES.md
  manifest.json
)

if [[ -n "${VERIFY_JSON_FILE}" ]]; then
  checksum_files+=("${VERIFY_JSON_FILE}")
fi
if [[ -n "${VERIFY_MD_FILE}" ]]; then
  checksum_files+=("${VERIFY_MD_FILE}")
fi

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "${RELEASE_DIR}" && \
    sha256sum "${checksum_files[@]}" > SHA256SUMS.txt
  )
elif command -v shasum >/dev/null 2>&1; then
  (
    cd "${RELEASE_DIR}" && \
    shasum -a 256 "${checksum_files[@]}" > SHA256SUMS.txt
  )
else
  echo "[docker-release-bundle] warning: no sha256sum/shasum found, SHA256SUMS.txt not generated"
fi

mkdir -p "$(dirname "${PACKAGE_TAR}")"
tar -czf "${PACKAGE_TAR}" -C "$(dirname "${RELEASE_DIR}")" "$(basename "${RELEASE_DIR}")"

echo "[docker-release-bundle] DONE"
echo "  app_version=${APP_VERSION}"
echo "  release_dir=${RELEASE_DIR}"
echo "  package_tar=${PACKAGE_TAR}"
echo "  verify_report_included=${VERIFY_REPORT_INCLUDED}"
if [[ -n "${VERIFY_REPORT_SOURCE}" ]]; then
  echo "  verify_report_source=${VERIFY_REPORT_SOURCE}"
fi
if [[ -n "${VERIFY_REPORT_AGE_SECONDS}" ]]; then
  echo "  verify_report_age_seconds=${VERIFY_REPORT_AGE_SECONDS}"
fi
if [[ -n "${VERIFY_JSON_FILE}" ]]; then
  echo "  verify_json=${VERIFY_JSON_FILE}"
fi
if [[ -n "${VERIFY_MD_FILE}" ]]; then
  echo "  verify_md=${VERIFY_MD_FILE}"
fi
