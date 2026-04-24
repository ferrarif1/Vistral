#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

assert_conversation_scoped_filters() {
  python3 - <<'PY'
from pathlib import Path
import re
import sys

source = Path("src/pages/ConversationPage.tsx").read_text(encoding="utf-8")

def assert_block(path_literal: str) -> None:
    escaped_path = re.escape(path_literal)
    block_pattern = re.compile(
        rf"const\s+\w+\s*=\s*buildPath\('{escaped_path}',\s*\{{(.*?)\}}\s*\);",
        re.DOTALL,
    )
    match = block_pattern.search(source)
    if not match:
        print(
            f"[smoke-navigation-context-hygiene] missing buildPath block for {path_literal}",
            file=sys.stderr,
        )
        sys.exit(1)

    block = match.group(1)
    required_tokens = ("task_filter:", "framework_filter:")
    missing = [token for token in required_tokens if token not in block]
    if missing:
        print(
            f"[smoke-navigation-context-hygiene] {path_literal} is missing scoped filter keys: {', '.join(missing)}",
            file=sys.stderr,
        )
        sys.exit(1)

assert_block("/training/jobs")
assert_block("/models/versions")
PY
}

assert_deeplink_focus_recovery_contract() {
  python3 - <<'PY'
from pathlib import Path
import sys

checks = [
    (
        "src/pages/TrainingJobsPage.tsx",
        ["preferredJobFilterRecoveryAppliedRef", "Adjusted filters to show the requested job"],
    ),
    (
        "src/pages/ModelVersionsPage.tsx",
        ["selectedVersionFilterRecoveryAppliedRef", "Adjusted filters to show the requested version"],
    ),
    (
        "src/pages/InferenceValidationPage.tsx",
        ["runVersionSyncAppliedRef", "Synced model version to match run"],
    ),
    (
        "src/pages/TrainingClosurePage.tsx",
        ["clearRequestedDatasetPath", "Requested dataset context not found"],
    ),
    (
        "src/pages/ProfessionalConsolePage.tsx",
        ["clearRequestedContextPath", "Requested dataset context not found"],
    ),
    (
        "src/pages/DatasetsPage.tsx",
        ["preferredDatasetFilterRecoveryAppliedRef", "Adjusted filters to show the requested dataset"],
    ),
    (
        "src/pages/CreateTrainingJobPage.tsx",
        ["preferredTaskFrameworkRecoveryAppliedRef", "Adjusted launch context to match available training data and runtime options."],
    ),
    (
        "src/pages/TrainingJobDetailPage.tsx",
        ["scopedContextSyncAppliedRef", "Synced scoped context to match job"],
    ),
    (
        "src/pages/MyModelsPage.tsx",
        ["preferredModelFilterRecoveryAppliedRef", "Adjusted filters to show the requested model"],
    ),
]

for file_path, tokens in checks:
    source = Path(file_path).read_text(encoding="utf-8")
    missing = [token for token in tokens if token not in source]
    if missing:
        print(
            f"[smoke-navigation-context-hygiene] {file_path} missing deeplink recovery contract token(s): {', '.join(missing)}",
            file=sys.stderr,
        )
        sys.exit(1)
PY
}

OBJECT_LITERAL_TO_MATCHES="$(
  rg -n "to:\\s*['\"]/[^\"']*['\"]" src/pages src/components src/layouts \
    --glob '!src/components/settings/SettingsTabs.tsx' || true
)"
JSX_LITERAL_TO_MATCHES="$(rg -n "to=\\s*['\"]/[^\"']*['\"]" src/pages src/components src/layouts || true)"
NAVIGATE_LITERAL_MATCHES="$(rg -n "navigate\\(\\s*['\"]/[^\"']*['\"]" src/pages src/components src/layouts || true)"

FILTERED_NAVIGATE_LITERAL_MATCHES=''
if [[ -n "${NAVIGATE_LITERAL_MATCHES}" ]]; then
  FILTERED_NAVIGATE_LITERAL_MATCHES="$(
    printf '%s\n' "${NAVIGATE_LITERAL_MATCHES}" \
      | grep -Ev "src/pages/ConversationPage.tsx:.*navigate\\('/',[[:space:]]*\\{[[:space:]]*replace:[[:space:]]*true[[:space:]]*\\}\\);" \
      | grep -Ev "src/layouts/AppShell.tsx:.*navigate\\('/',[[:space:]]*\\{[[:space:]]*replace:[[:space:]]*true[[:space:]]*\\}\\);" \
      || true
  )"
fi

if [[ -n "${OBJECT_LITERAL_TO_MATCHES}" || -n "${JSX_LITERAL_TO_MATCHES}" || -n "${FILTERED_NAVIGATE_LITERAL_MATCHES}" ]]; then
  echo "[smoke-navigation-context-hygiene] found navigation literals that may bypass scoped context."
  if [[ -n "${OBJECT_LITERAL_TO_MATCHES}" ]]; then
    echo
    echo "[object-literal to: '/...']"
    echo "${OBJECT_LITERAL_TO_MATCHES}"
  fi
  if [[ -n "${JSX_LITERAL_TO_MATCHES}" ]]; then
    echo
    echo "[jsx-literal to='/...']"
    echo "${JSX_LITERAL_TO_MATCHES}"
  fi
  if [[ -n "${FILTERED_NAVIGATE_LITERAL_MATCHES}" ]]; then
    echo
    echo "[navigate('/...')]"
    echo "${FILTERED_NAVIGATE_LITERAL_MATCHES}"
  fi
  exit 1
fi

assert_conversation_scoped_filters
assert_deeplink_focus_recovery_contract

echo "[smoke-navigation-context-hygiene] PASS"
