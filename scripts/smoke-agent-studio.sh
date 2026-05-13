#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

test -s docs/frontend-reset.md

grep -q "Agent Training Studio" docs/frontend-reset.md
grep -q "FR-018 Frontend Reset: Agent Training Studio" docs/prd.md
grep -q "3.3B Agent Training Studio" docs/ia.md
grep -q "Flow J: Agent Training Studio Home" docs/flows.md
grep -q "Track I: Frontend Reset to Agent Training Studio" PLANS.md

grep -q "AgentTrainingStudioPage" src/App.tsx
grep -q "/workspace/console" src/App.tsx
grep -q "isAgentStudioRoute" src/layouts/AppShell.tsx
grep -q "agent-studio-route-shell" src/layouts/AppShell.tsx
grep -q "agent-studio.css" src/main.tsx

node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const page = readFileSync('src/pages/AgentTrainingStudioPage.tsx', 'utf8');
const css = readFileSync('src/styles/agent-studio.css', 'utf8');
const shell = readFileSync('src/layouts/AppShell.tsx', 'utf8');
const taskList = readFileSync('src/pages/VisionModelingTasksPage.tsx', 'utf8');
const taskDetail = readFileSync('src/pages/VisionModelingTaskPage.tsx', 'utf8');
const trainingDetail = readFileSync('src/pages/TrainingJobDetailPage.tsx', 'utf8');
const runtimeSettings = readFileSync('src/pages/RuntimeSettingsPage.tsx', 'utf8');

for (const required of [
  'ProgressStepper',
  'studioSteps',
  'resolveMission',
  'Agent Training Studio',
  'agent-studio-page',
  'agent-studio-evidence-board',
  'agent-studio-delivery-card',
  'runtime.agent_delivery',
  'api.prepareRealTrainingRuntimeSettings',
  '问 OpenClaw',
  'api.listDatasets',
  'api.listTrainingJobs',
  'api.listModelVersions',
  'api.listInferenceRuns',
  'api.listVisionTasks'
]) {
  if (!page.includes(required)) {
    throw new Error(`Agent Studio page missing required token: ${required}`);
  }
}

for (const required of [
  '.agent-studio-page',
  '.agent-studio-mission-bar',
  '.agent-studio-flow-rail',
  '.agent-studio-stepper',
  '.agent-studio-delivery-card',
  '.agent-studio-evidence-board',
  '.agent-studio-context-panel'
]) {
  if (!css.includes(required)) {
    throw new Error(`Agent Studio CSS missing required selector: ${required}`);
  }
}

const consoleRouteIndex = shell.indexOf('isAgentStudioRoute');
const pixelRouteIndex = shell.indexOf('isImmersiveWorkspace || isPixelLabRoute');
if (consoleRouteIndex < 0 || pixelRouteIndex < 0 || consoleRouteIndex > pixelRouteIndex) {
  throw new Error('/workspace/console must bypass the legacy pixel shell before the pixel route branch');
}

if (page.includes('game-workshop') || page.includes('pixel-workshop')) {
  throw new Error('Agent Studio home must not depend on the old Pixel Workshop UI classes');
}

for (const [name, source] of [
  ['VisionModelingTasksPage', taskList],
  ['VisionModelingTaskPage', taskDetail],
  ['TrainingJobDetailPage', trainingDetail]
]) {
  if (!source.includes('deliver_model: true')) {
    throw new Error(`${name} Continue as agent action must use delivery mode`);
  }
  if (!source.includes('Deliver model with agent')) {
    throw new Error(`${name} primary agent action should use delivery-oriented copy`);
  }
}

if (!page.includes("qs.set('agent_action', 'fix_runtime')")) {
  throw new Error('Agent Studio fix_runtime CTA must deep-link to Runtime readiness handoff');
}

if (!page.includes("snapshot.user.role === 'admin'")) {
  throw new Error('Agent Studio inline real-runtime prepare action must stay admin-gated');
}

for (const required of [
  'runtimeReadiness.agent_delivery',
  'runtimeReadiness.real_training_doctor',
  'Agent delivery readiness',
  'Real training doctor',
  'The training agent stopped here because a publishable model needs real evidence.',
  'Prepare real runtime',
  'prepareRealTrainingRuntimeSettings',
  'Copy agent commands'
]) {
  if (!runtimeSettings.includes(required)) {
    throw new Error(`Runtime Settings missing agent delivery readiness UI token: ${required}`);
  }
}
NODE

echo "agent studio contract ok"
