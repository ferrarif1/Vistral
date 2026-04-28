#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

python3 - <<'PY'
from pathlib import Path
import re
import sys

required_files = [
    "src/pages/TrainingWorkshopPage.tsx",
    "src/data/workshopDemoData.ts",
    "src/components/workshop/WorkshopScene.tsx",
    "src/components/workshop/RoomLayer.tsx",
    "src/components/workshop/ModelCharacter.tsx",
    "src/components/workshop/StageTimeline.tsx",
    "src/components/workshop/WorkshopStatusPanel.tsx",
    "src/components/workshop/ModelSelector.tsx",
    "src/components/workshop/DatasetSelector.tsx",
    "src/styles/workshop.css",
    "public/assets/vistral-workshop/README.md",
]

missing_files = [path for path in required_files if not Path(path).is_file()]
if missing_files:
    print("[smoke-training-workshop-contract] missing file(s): " + ", ".join(missing_files), file=sys.stderr)
    sys.exit(1)

data_source = Path("src/data/workshopDemoData.ts").read_text(encoding="utf-8")
page_source = Path("src/pages/TrainingWorkshopPage.tsx").read_text(encoding="utf-8")
app_source = Path("src/App.tsx").read_text(encoding="utf-8")
shell_source = Path("src/layouts/AppShell.tsx").read_text(encoding="utf-8")
status_panel_source = Path("src/components/workshop/WorkshopStatusPanel.tsx").read_text(encoding="utf-8")

required_stages = [
    "idle",
    "dataset_selecting",
    "dataset_preparing",
    "labeling_or_reviewing",
    "training",
    "tuning",
    "inference_validating",
    "human_review_required",
    "publishing",
    "completed",
    "failed",
]

for stage in required_stages:
    if f"{stage}:" not in data_source and f"'{stage}'" not in data_source:
        print(f"[smoke-training-workshop-contract] missing workshop stage: {stage}", file=sys.stderr)
        sys.exit(1)

required_statuses = [
    "created",
    "queued",
    "preparing_dataset",
    "labeling",
    "reviewing",
    "running",
    "training",
    "tuning",
    "optimizing",
    "validating",
    "inferencing",
    "awaiting_review",
    "publishing",
    "approved",
    "completed",
    "failed",
    "error",
]

for status in required_statuses:
    if f"'{status}'" not in data_source:
        print(f"[smoke-training-workshop-contract] missing adapter status mapping token: {status}", file=sys.stderr)
        sys.exit(1)

if 'path="/training-workshop"' not in app_source:
    print("[smoke-training-workshop-contract] /training-workshop route missing", file=sys.stderr)
    sys.exit(1)

if "scopedNavTo('/training-workshop')" not in shell_source:
    print("[smoke-training-workshop-contract] Training Workshop nav entry missing scoped navigation", file=sys.stderr)
    sys.exit(1)

sequence_match = re.search(r"automaticDemoSequence:\s*WorkshopStageId\[\]\s*=\s*\[(.*?)\]", data_source, re.S)
if not sequence_match:
    print("[smoke-training-workshop-contract] automaticDemoSequence missing", file=sys.stderr)
    sys.exit(1)

sequence_body = sequence_match.group(1)
if "'human_review_required'" not in sequence_body:
    print("[smoke-training-workshop-contract] demo sequence must pause at human review", file=sys.stderr)
    sys.exit(1)

if "'publishing'" in sequence_body or "'completed'" in sequence_body:
    print("[smoke-training-workshop-contract] demo sequence must not bypass human review", file=sys.stderr)
    sys.exit(1)

required_page_tokens = [
    "handleAutoDemo",
    "handleStartExam",
    "handleApprovePublish",
    "handleReturnTraining",
    "handleReselectDataset",
    "buildScopedWorkshopPath",
]

for token in required_page_tokens:
    if token not in page_source:
        print(f"[smoke-training-workshop-contract] missing page behavior token: {token}", file=sys.stderr)
        sys.exit(1)

required_review_actions = ["通过并发布", "退回训练", "重新选择数据集", "重试训练"]
for label in required_review_actions:
    if label not in status_panel_source:
        print(f"[smoke-training-workshop-contract] missing review action label: {label}", file=sys.stderr)
        sys.exit(1)

print("[smoke-training-workshop-contract] PASS")
PY
