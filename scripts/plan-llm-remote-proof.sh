#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

REPORT_DIR="${PLAN_LLM_REMOTE_PROOF_REPORT_DIR:-.data/verify-reports}"
REPORT_RETAIN="${PLAN_LLM_REMOTE_PROOF_REPORT_RETAIN:-10}"
REPORT_TIMESTAMP="${PLAN_LLM_REMOTE_PROOF_TIMESTAMP:-$(date -u +%Y%m%d%H%M%S)}"
REPORT_BASENAME="${PLAN_LLM_REMOTE_PROOF_BASENAME:-plan-llm-remote-proof-${REPORT_TIMESTAMP}}"
REPORT_JSON_PATH="${REPORT_DIR}/${REPORT_BASENAME}.json"
REPORT_MD_PATH="${REPORT_DIR}/${REPORT_BASENAME}.md"
REPORT_LOG_PATH="${REPORT_DIR}/${REPORT_BASENAME}.log"
ARTIFACTS_DIR="${REPORT_DIR}/${REPORT_BASENAME}-artifacts"
STARTED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CHECKS_FILE="$(mktemp)"
REPORT_FINALIZED=false

WORKFLOW_FILE="${PLAN_LLM_REMOTE_PROOF_WORKFLOW:-plan-llm-complete.yml}"
ARTIFACT_NAME="${PLAN_LLM_REMOTE_PROOF_ARTIFACT_NAME:-plan-llm-complete-reports}"
DISCOVER_TIMEOUT_SEC="${PLAN_LLM_REMOTE_PROOF_DISCOVER_TIMEOUT_SEC:-180}"
TIMEOUT_SEC="${PLAN_LLM_REMOTE_PROOF_TIMEOUT_SEC:-5400}"
POLL_SEC="${PLAN_LLM_REMOTE_PROOF_POLL_SEC:-30}"
ALLOW_DIRTY="${PLAN_LLM_REMOTE_PROOF_ALLOW_DIRTY:-0}"
ALLOW_HEAD_MISMATCH="${PLAN_LLM_REMOTE_PROOF_ALLOW_HEAD_MISMATCH:-0}"

REPO_FULL_NAME=""
WORKFLOW_REF=""
LOCAL_HEAD=""
REMOTE_HEAD=""
FINAL_RUN_ID=""
FINAL_RUN_URL=""
FINAL_ARTIFACT_DIR=""

mkdir -p "${REPORT_DIR}"
: >"${REPORT_LOG_PATH}"

log() {
  echo "$1" | tee -a "${REPORT_LOG_PATH}"
}

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
  const match = filename.match(/^(plan-llm-remote-proof-\d{14})(-artifacts|(?:\.(json|md|log)))$/);
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
    fs.rmSync(filepath, { recursive: true, force: true });
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
    "${finished_at_utc}" \
    "${REPO_FULL_NAME}" \
    "${WORKFLOW_REF}" \
    "${LOCAL_HEAD}" \
    "${REMOTE_HEAD}" \
    "${FINAL_RUN_ID}" \
    "${FINAL_RUN_URL}" \
    "${FINAL_ARTIFACT_DIR}" <<'NODE'
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
  finishedAtUtc,
  repoFullName,
  workflowRef,
  localHead,
  remoteHead,
  runId,
  runUrl,
  artifactDir
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
  repo_full_name: repoFullName || null,
  workflow_ref: workflowRef || null,
  local_head: localHead || null,
  remote_head: remoteHead || null,
  run_id: runId || null,
  run_url: runUrl || null,
  artifact_dir: artifactDir || null,
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
  '# Plan LLM Remote Proof Report',
  '',
  `- Status: **${status}**`,
  `- Summary: ${summary}`,
  `- Repo: ${repoFullName || '(unknown)'}`,
  `- Ref: ${workflowRef || '(unknown)'}`,
  `- Local HEAD: ${localHead || '(unknown)'}`,
  `- Remote HEAD: ${remoteHead || '(unknown)'}`,
  `- Run ID: ${runId || '(not dispatched)'}`,
  `- Run URL: ${runUrl || '(not available)'}`,
  `- Artifact dir: ${artifactDir || '(not downloaded)'}`,
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
  log "[plan-llm-remote-proof] report_json=${REPORT_JSON_PATH}"
  log "[plan-llm-remote-proof] report_md=${REPORT_MD_PATH}"
  log "[plan-llm-remote-proof] report_log=${REPORT_LOG_PATH}"
}

cleanup() {
  local exit_code=$?
  if [[ "${REPORT_FINALIZED}" != "true" ]]; then
    finalize_report "failed" "plan llm remote proof interrupted or failed unexpectedly"
  fi
  rm -f "${CHECKS_FILE}"
  exit "${exit_code}"
}
trap cleanup EXIT

parse_repo_full_name() {
  local remote_url="$1"
  node - "${remote_url}" <<'NODE'
const remoteUrl = process.argv[2];
const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
if (!match) {
  process.exit(1);
}
process.stdout.write(match[1]);
NODE
}

json_select_latest_run() {
  local target_sha="$1"
  local runs_json="$2"
  RUNS_JSON="${runs_json}" node - "${target_sha}" <<'NODE'
const runs = JSON.parse(process.env.RUNS_JSON ?? '[]');
const targetSha = process.argv[2];
const run = runs
  .filter((entry) => entry.headSha === targetSha)
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
if (!run) {
  process.exit(1);
}
process.stdout.write([run.databaseId, run.url, run.status, run.conclusion ?? ''].join('\t'));
NODE
}

json_select_run_state() {
  local run_json="$1"
  RUN_JSON="${run_json}" node - <<'NODE'
const run = JSON.parse(process.env.RUN_JSON ?? '{}');
process.stdout.write([
  run.status ?? '',
  run.conclusion ?? '',
  run.url ?? '',
  run.workflowName ?? '',
  run.headSha ?? ''
].join('\t'));
NODE
}

wait_for_dispatched_run() {
  local target_sha="$1"
  local deadline=$(( $(date +%s) + DISCOVER_TIMEOUT_SEC ))
  while (( $(date +%s) <= deadline )); do
    local runs_json
    set +e
    runs_json="$(gh run list --repo "${REPO_FULL_NAME}" --workflow "${WORKFLOW_FILE}" --branch "${WORKFLOW_REF}" --event workflow_dispatch --json databaseId,status,conclusion,url,headSha,headBranch,createdAt,updatedAt,workflowName 2>>"${REPORT_LOG_PATH}")"
    local exit_code=$?
    set -e
    if [[ "${exit_code}" -eq 0 ]]; then
      local run_line=""
      set +e
      run_line="$(json_select_latest_run "${target_sha}" "${runs_json}")"
      exit_code=$?
      set -e
      if [[ "${exit_code}" -eq 0 && -n "${run_line}" ]]; then
        printf '%s\n' "${run_line}"
        return 0
      fi
    fi
    sleep "${POLL_SEC}"
  done
  return 1
}

wait_for_run_completion() {
  local run_id="$1"
  local deadline=$(( $(date +%s) + TIMEOUT_SEC ))
  while (( $(date +%s) <= deadline )); do
    local run_json
    set +e
    run_json="$(gh run view "${run_id}" --repo "${REPO_FULL_NAME}" --json databaseId,status,conclusion,url,workflowName,headSha,headBranch,createdAt,updatedAt 2>>"${REPORT_LOG_PATH}")"
    local exit_code=$?
    set -e
    if [[ "${exit_code}" -eq 0 ]]; then
      local state_line
      state_line="$(json_select_run_state "${run_json}")"
      local status conclusion url workflow_name head_sha
      IFS=$'\t' read -r status conclusion url workflow_name head_sha <<<"${state_line}"
      log "[plan-llm-remote-proof] run_id=${run_id} workflow=${workflow_name} status=${status} conclusion=${conclusion:-pending}"
      if [[ "${status}" == "completed" ]]; then
        printf '%s\n' "${state_line}"
        return 0
      fi
    fi
    sleep "${POLL_SEC}"
  done
  return 1
}

if [[ "${PLAN_LLM_REMOTE_PROOF_SELF_TEST:-false}" == "true" ]]; then
  append_check "remote proof self-test" "passed" "report generation and retention plumbing is reachable"
  finalize_report "passed" "plan llm remote proof self-test succeeded"
  log "[plan-llm-remote-proof] PASS"
  exit 0
fi

if [[ ! -f ".github/workflows/${WORKFLOW_FILE}" ]]; then
  append_check "workflow file" "failed" "missing .github/workflows/${WORKFLOW_FILE}"
  finalize_report "failed" "plan llm remote proof missing workflow file"
  exit 1
fi
append_check "workflow file" "passed" ".github/workflows/${WORKFLOW_FILE}"

REPO_FULL_NAME="$(parse_repo_full_name "$(git remote get-url origin)")"
append_check "origin remote" "passed" "${REPO_FULL_NAME}"

WORKFLOW_REF="${PLAN_LLM_REMOTE_PROOF_REF:-$(git branch --show-current)}"
if [[ -z "${WORKFLOW_REF}" ]]; then
  append_check "workflow ref" "failed" "detached HEAD without PLAN_LLM_REMOTE_PROOF_REF override"
  finalize_report "blocked" "remote proof blocked: workflow ref is unknown"
  exit 2
fi
append_check "workflow ref" "passed" "${WORKFLOW_REF}"

LOCAL_HEAD="$(git rev-parse HEAD)"
append_check "local HEAD" "passed" "${LOCAL_HEAD}"
REMOTE_TRACKING_HEAD="$(git rev-parse --verify "refs/remotes/origin/${WORKFLOW_REF}" 2>/dev/null || true)"

dirty_entries="$(git status --short)"
dirty_count="$(printf '%s\n' "${dirty_entries}" | sed '/^$/d' | wc -l | tr -d ' ')"
dirty_sample="$(printf '%s\n' "${dirty_entries}" | sed -n '1,6p' | paste -sd '; ' -)"
dirty_blocking=0

gh_auth_ok=0
if gh auth status >/dev/null 2>>"${REPORT_LOG_PATH}"; then
  gh_auth_ok=1
  append_check "gh auth status" "passed" "GitHub CLI is authenticated"
else
  append_check "gh auth status" "failed" "not authenticated; run gh auth login or export GH_TOKEN"
fi

origin_reachable=1
remote_branch_exists=1
set +e
remote_head_query="$(git ls-remote --heads origin "${WORKFLOW_REF}" 2>>"${REPORT_LOG_PATH}")"
remote_head_exit_code=$?
set -e
if [[ "${remote_head_exit_code}" -ne 0 ]]; then
  origin_reachable=0
  append_check "remote HEAD" "failed" "cannot reach origin for branch ${WORKFLOW_REF}; see report log for git ls-remote stderr"
else
  REMOTE_HEAD="$(printf '%s\n' "${remote_head_query}" | awk 'NR==1 {print $1}')"
  if [[ -z "${REMOTE_HEAD}" ]]; then
    remote_branch_exists=0
    append_check "remote HEAD" "failed" "branch ${WORKFLOW_REF} does not exist on origin yet"
  else
    append_check "remote HEAD" "passed" "${REMOTE_HEAD}"
  fi
fi

if [[ "${origin_reachable}" == "1" && "${remote_branch_exists}" == "1" ]]; then
  if [[ "${LOCAL_HEAD}" != "${REMOTE_HEAD}" && "${ALLOW_HEAD_MISMATCH}" != "1" ]]; then
    append_check "remote HEAD match" "failed" "local=${LOCAL_HEAD}; remote=${REMOTE_HEAD}; push or set PLAN_LLM_REMOTE_PROOF_ALLOW_HEAD_MISMATCH=1"
  else
    append_check "remote HEAD match" "passed" "local=${LOCAL_HEAD}; remote=${REMOTE_HEAD}"
  fi
else
  append_check "remote HEAD match" "failed" "skipped because origin is unreachable or branch is not pushed"
fi

if [[ "${dirty_count}" == "0" ]]; then
  append_check "git worktree clean" "passed" "dirty_count=0"
elif [[ "${ALLOW_DIRTY}" == "1" ]]; then
  append_check "git worktree clean" "passed" "dirty_count=${dirty_count}; override enabled; sample=${dirty_sample}"
elif [[ "${origin_reachable}" == "1" && "${remote_branch_exists}" == "1" && "${LOCAL_HEAD}" == "${REMOTE_HEAD}" ]]; then
  append_check "git worktree clean" "failed" "advisory_only=true; dirty_count=${dirty_count}; remote proof covers already-pushed HEAD ${REMOTE_HEAD}, not uncommitted changes; sample=${dirty_sample}"
elif [[ -n "${REMOTE_TRACKING_HEAD}" && "${LOCAL_HEAD}" == "${REMOTE_TRACKING_HEAD}" ]]; then
  append_check "git worktree clean" "failed" "advisory_only=true; compare_basis=refs/remotes/origin/${WORKFLOW_REF}; dirty_count=${dirty_count}; cached origin tracking ref matches local HEAD ${LOCAL_HEAD}; sample=${dirty_sample}"
else
  dirty_blocking=1
  append_check "git worktree clean" "failed" "dirty_count=${dirty_count}; sample=${dirty_sample}"
fi

blocked_reasons=()
if [[ "${dirty_blocking}" == "1" ]]; then
  blocked_reasons+=("git_worktree_dirty")
fi
if [[ "${gh_auth_ok}" != "1" ]]; then
  blocked_reasons+=("gh_auth_missing")
fi
if [[ "${origin_reachable}" != "1" ]]; then
  blocked_reasons+=("origin_unreachable")
fi
if [[ "${origin_reachable}" == "1" && "${remote_branch_exists}" != "1" ]]; then
  blocked_reasons+=("branch_not_pushed")
fi
if [[ "${origin_reachable}" == "1" && "${remote_branch_exists}" == "1" && "${LOCAL_HEAD}" != "${REMOTE_HEAD}" && "${ALLOW_HEAD_MISMATCH}" != "1" ]]; then
  blocked_reasons+=("remote_head_mismatch")
fi

if (( ${#blocked_reasons[@]} > 0 )); then
  blocked_summary="$(IFS=', '; echo "${blocked_reasons[*]}")"
  finalize_report "blocked" "remote proof blocked: ${blocked_summary}"
  log "[plan-llm-remote-proof] BLOCKED"
  exit 2
fi

log "[plan-llm-remote-proof] dispatching ${WORKFLOW_FILE} on ${REPO_FULL_NAME}@${WORKFLOW_REF}"
set +e
dispatch_output="$(gh workflow run "${WORKFLOW_FILE}" --repo "${REPO_FULL_NAME}" --ref "${WORKFLOW_REF}" 2>&1)"
dispatch_exit_code=$?
set -e
printf '%s\n' "${dispatch_output}" | tee -a "${REPORT_LOG_PATH}"
if [[ "${dispatch_exit_code}" -ne 0 ]]; then
  append_check "gh workflow run" "failed" "exit=${dispatch_exit_code}"
  finalize_report "failed" "plan llm remote proof failed to dispatch workflow"
  exit "${dispatch_exit_code}"
fi
append_check "gh workflow run" "passed" "workflow=${WORKFLOW_FILE}; ref=${WORKFLOW_REF}"

log "[plan-llm-remote-proof] waiting for dispatched run discovery"
set +e
run_line="$(wait_for_dispatched_run "${REMOTE_HEAD}")"
discover_exit_code=$?
set -e
if [[ "${discover_exit_code}" -ne 0 || -z "${run_line}" ]]; then
  append_check "discover workflow run" "failed" "timeout=${DISCOVER_TIMEOUT_SEC}s; sha=${REMOTE_HEAD}"
  finalize_report "failed" "plan llm remote proof failed to discover dispatched run"
  exit 1
fi

run_status=""
run_conclusion=""
IFS=$'\t' read -r FINAL_RUN_ID FINAL_RUN_URL run_status run_conclusion <<<"${run_line}"
append_check "discover workflow run" "passed" "run_id=${FINAL_RUN_ID}; status=${run_status}; url=${FINAL_RUN_URL}"

log "[plan-llm-remote-proof] polling run_id=${FINAL_RUN_ID}"
set +e
run_state_line="$(wait_for_run_completion "${FINAL_RUN_ID}")"
wait_exit_code=$?
set -e
if [[ "${wait_exit_code}" -ne 0 || -z "${run_state_line}" ]]; then
  append_check "wait for workflow run" "failed" "run_id=${FINAL_RUN_ID}; timeout=${TIMEOUT_SEC}s"
  finalize_report "failed" "plan llm remote proof timed out while waiting for workflow run"
  exit 1
fi

run_workflow_name=""
run_head_sha=""
IFS=$'\t' read -r run_status run_conclusion FINAL_RUN_URL run_workflow_name run_head_sha <<<"${run_state_line}"
if [[ "${run_status}" == "completed" && "${run_conclusion}" == "success" ]]; then
  append_check "wait for workflow run" "passed" "run_id=${FINAL_RUN_ID}; workflow=${run_workflow_name}; conclusion=${run_conclusion}"
else
  append_check "wait for workflow run" "failed" "run_id=${FINAL_RUN_ID}; workflow=${run_workflow_name}; conclusion=${run_conclusion:-unknown}"
fi

mkdir -p "${ARTIFACTS_DIR}"
FINAL_ARTIFACT_DIR="${ARTIFACTS_DIR}"
log "[plan-llm-remote-proof] downloading artifact ${ARTIFACT_NAME}"
set +e
gh run download "${FINAL_RUN_ID}" --repo "${REPO_FULL_NAME}" -n "${ARTIFACT_NAME}" -D "${ARTIFACTS_DIR}" 2>&1 | tee -a "${REPORT_LOG_PATH}"
download_exit_code=${PIPESTATUS[0]}
set -e
if [[ "${download_exit_code}" -ne 0 ]]; then
  append_check "download workflow artifact" "failed" "run_id=${FINAL_RUN_ID}; artifact=${ARTIFACT_NAME}; exit=${download_exit_code}"
  finalize_report "failed" "plan llm remote proof could not download workflow artifact"
  exit 1
fi
append_check "download workflow artifact" "passed" "run_id=${FINAL_RUN_ID}; artifact_dir=${ARTIFACTS_DIR}"

if [[ "${run_status}" == "completed" && "${run_conclusion}" == "success" ]]; then
  finalize_report "passed" "plan llm remote proof passed"
  log "[plan-llm-remote-proof] PASS"
  exit 0
fi

finalize_report "failed" "plan llm remote proof completed but workflow conclusion was ${run_conclusion:-unknown}"
log "[plan-llm-remote-proof] FAIL"
exit 1
