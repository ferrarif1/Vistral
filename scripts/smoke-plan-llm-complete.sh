#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

REPORT_DIR="${PLAN_LLM_REPORT_DIR:-.data/verify-reports}"
REPORT_RETAIN="${PLAN_LLM_REPORT_RETAIN:-10}"
REPORT_TIMESTAMP="${PLAN_LLM_REPORT_TIMESTAMP:-$(date -u +%Y%m%d%H%M%S)}"
REPORT_BASENAME="${PLAN_LLM_REPORT_BASENAME:-plan-llm-complete-${REPORT_TIMESTAMP}}"
REPORT_JSON_PATH="${REPORT_DIR}/${REPORT_BASENAME}.json"
REPORT_MD_PATH="${REPORT_DIR}/${REPORT_BASENAME}.md"
REPORT_LOG_PATH="${REPORT_DIR}/${REPORT_BASENAME}.log"
STARTED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CHECKS_FILE="$(mktemp)"
REPORT_FINALIZED=false

mkdir -p "${REPORT_DIR}"
: >"${REPORT_LOG_PATH}"

append_check() {
  local name="$1"
  local status="$2"
  local detail="$3"
  node - "${CHECKS_FILE}" "${name}" "${status}" "${detail}" <<'NODE'
const fs = require('node:fs');
const [file, name, status, detail] = process.argv.slice(2);
fs.appendFileSync(file, `${JSON.stringify({ name, status, detail })}\n`);
NODE
}

prune_old_reports() {
  node - "${REPORT_DIR}" "${REPORT_RETAIN}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [dir, retainRaw] = process.argv.slice(2);
const retain = Math.max(1, Number.parseInt(retainRaw, 10) || 10);
const groups = new Map();
for (const filename of fs.readdirSync(dir)) {
  const match = filename.match(/^(plan-llm-complete-\d{14})\.(json|md|log)$/);
  if (!match) continue;
  const filepath = path.join(dir, filename);
  const stat = fs.statSync(filepath);
  const current = groups.get(match[1]) ?? { basename: match[1], mtimeMs: 0, files: [] };
  current.mtimeMs = Math.max(current.mtimeMs, stat.mtimeMs);
  current.files.push(filepath);
  groups.set(match[1], current);
}
const stale = [...groups.values()]
  .sort((a, b) => b.mtimeMs - a.mtimeMs)
  .slice(retain);
for (const group of stale) {
  for (const filepath of group.files) {
    fs.rmSync(filepath, { force: true });
  }
}
NODE
}

finalize_report() {
  local status="$1"
  local summary="$2"
  local finished_at_utc
  finished_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node - \
    "${REPORT_JSON_PATH}" \
    "${REPORT_MD_PATH}" \
    "${CHECKS_FILE}" \
    "${REPORT_LOG_PATH}" \
    "${REPORT_BASENAME}" \
    "${status}" \
    "${summary}" \
    "${STARTED_AT_UTC}" \
    "${finished_at_utc}" <<'NODE'
const fs = require('node:fs');
const [
  reportJsonPath,
  reportMdPath,
  checksFile,
  reportLogPath,
  basename,
  status,
  summary,
  startedAtUtc,
  finishedAtUtc
] = process.argv.slice(2);
const checks = fs.existsSync(checksFile)
  ? fs.readFileSync(checksFile, 'utf8').split(/\n+/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const checksFailed = checks.filter((check) => check.status !== 'passed').length;
const report = {
  id: basename,
  filename: `${basename}.json`,
  status,
  summary,
  started_at_utc: startedAtUtc,
  finished_at_utc: finishedAtUtc,
  checks_total: checks.length,
  checks_failed: checksFailed,
  checks,
  log_path: reportLogPath
};
fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
const rows = checks.map((check) => {
  const detail = String(check.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  return `| ${check.name} | ${check.status} | ${detail} |`;
});
const markdown = [
  '# Plan LLM Complete Report',
  '',
  `- Status: **${status}**`,
  `- Summary: ${summary}`,
  `- Started (UTC): ${startedAtUtc}`,
  `- Finished (UTC): ${finishedAtUtc}`,
  `- Log: ${reportLogPath}`,
  '',
  '## Checks',
  '| Check | Status | Detail |',
  '| --- | --- | --- |',
  ...rows
].join('\n');
fs.writeFileSync(reportMdPath, `${markdown}\n`);
NODE
  prune_old_reports
  REPORT_FINALIZED=true
  echo "[smoke-plan-llm-complete] report_json=${REPORT_JSON_PATH}" | tee -a "${REPORT_LOG_PATH}"
  echo "[smoke-plan-llm-complete] report_md=${REPORT_MD_PATH}" | tee -a "${REPORT_LOG_PATH}"
  echo "[smoke-plan-llm-complete] report_log=${REPORT_LOG_PATH}" | tee -a "${REPORT_LOG_PATH}"
}

cleanup() {
  local exit_code=$?
  if [[ "${REPORT_FINALIZED}" != "true" ]]; then
    finalize_report "failed" "plan llm complete smoke interrupted or failed"
  fi
  rm -f "${CHECKS_FILE}"
  exit "${exit_code}"
}
trap cleanup EXIT

run_step() {
  local cmd="$1"
  echo "[smoke-plan-llm-complete] running: npm run ${cmd}" | tee -a "${REPORT_LOG_PATH}"
  set +e
  npm run "${cmd}" 2>&1 | tee -a "${REPORT_LOG_PATH}"
  local exit_code=${PIPESTATUS[0]}
  set -e
  if [[ "${exit_code}" -ne 0 ]]; then
    append_check "npm run ${cmd}" "failed" "exit=${exit_code}"
    finalize_report "failed" "plan llm complete smoke failed at npm run ${cmd}"
    exit "${exit_code}"
  fi
  append_check "npm run ${cmd}" "passed" "exit=0"
}

run_step_with_env() {
  local cmd="$1"
  shift
  echo "[smoke-plan-llm-complete] running: npm run ${cmd} (with scoped env overrides)" | tee -a "${REPORT_LOG_PATH}"
  set +e
  env "$@" npm run "${cmd}" 2>&1 | tee -a "${REPORT_LOG_PATH}"
  local exit_code=${PIPESTATUS[0]}
  set -e
  if [[ "${exit_code}" -ne 0 ]]; then
    append_check "npm run ${cmd}" "failed" "exit=${exit_code}; env_overrides=$*"
    finalize_report "failed" "plan llm complete smoke failed at npm run ${cmd}"
    exit "${exit_code}"
  fi
  append_check "npm run ${cmd}" "passed" "exit=0; env_overrides=$*"
}

if [[ "${PLAN_LLM_REPORT_SELF_TEST:-false}" == "true" ]]; then
  append_check "report writer self-test" "passed" "report generation and retention plumbing is reachable"
  finalize_report "passed" "plan llm complete report self-test succeeded"
  echo "[smoke-plan-llm-complete] PASS"
  exit 0
fi

run_step "smoke:vision-task-closure"
run_step "smoke:ocr-closure"
run_step "smoke:training-worker-dedicated-auth"
run_step "smoke:runtime-device-access"

run_step_with_env "smoke:real-closure" \
  REAL_CLOSURE_STRICT_REGISTRATION=true \
  REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION=false \
  REAL_CLOSURE_REQUIRE_REAL_MODE=true \
  REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION=false \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=0

run_step_with_env "smoke:real-closure" \
  REAL_CLOSURE_STRICT_REGISTRATION=true \
  REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION=false \
  REAL_CLOSURE_REQUIRE_REAL_MODE=true \
  REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION=true \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=0

finalize_report "passed" "plan llm complete smoke passed"
echo "[smoke-plan-llm-complete] PASS"
