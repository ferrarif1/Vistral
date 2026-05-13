#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

required_assets=(
  "public/assets/vistral-workshop/house-frame.svg"
  "public/assets/vistral-workshop/generated/sliced-clean/buildings/training-house-facade/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/buildings/gable-roof/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/buildings/roof-tile-strip/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/buildings/wooden-support-set/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/room-modules/dataset-warehouse/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/room-modules/data-processing-annotation/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/room-modules/feature-recipe/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/room-modules/model-training/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/room-modules/inference-validation/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/room-modules/model-publishing/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/room-modules/deployment-runtime/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/room-modules/feedback-repair/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/manifest.json"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/reception-command/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/dataset-warehouse/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/data-processing-annotation/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/feature-recipe/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/model-training/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/inference-validation/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/model-publishing/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/deployment-runtime/prop.png"
  "public/assets/vistral-workshop/generated/house-room-backgrounds/feedback-repair/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/characters/openclaw-crab/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/characters/dataset-keeper/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/characters/annotation-specialist/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/characters/training-engineer/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/characters/validation-examiner/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/characters/publishing-graduate/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/characters/runtime-operator/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/characters/worker-node-companion/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/furniture-equipment/dataset-shelf/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/furniture-equipment/annotation-desk/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/furniture-equipment/gpu-server-rack/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/furniture-equipment/runtime-health-monitor/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/ui-elements/hud-panel/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/ui-elements/active-room-frame/prop.png"
  "public/assets/vistral-workshop/generated/sliced-clean/ui-elements/assistant-chat-bubble/prop.png"
)

for asset in "${required_assets[@]}"; do
  test -s "$asset"
done

grep -q "pixel-workshop-skin.css" src/main.tsx
grep -q "COPY public ./public" Dockerfile
grep -q "workspace-pixel-skin" src/components/ui/WorkspacePage.tsx
grep -q "PixelRoomContextBar" src/components/ui/WorkspacePage.tsx
! grep -q "workspace-pixel-backdrop" src/components/ui/WorkspacePage.tsx
! grep -q "workspace-pixel-skin::before" src/styles/pixel-workshop-skin.css
! grep -q "workspace-pixel-skin::after" src/styles/pixel-workshop-skin.css
! awk '/workspace-pixel-skin/,/}/ { if ($0 ~ /position: fixed/) exit 1 }' src/styles/pixel-workshop-skin.css
grep -q "pixelSceneByRoute" src/components/ui/pixelRoomContextModel.ts
grep -q "workspace-pixel-route-strip" src/components/ui/WorkspacePage.tsx
grep -q "chat-pixel-room-strip" src/pages/ConversationPage.tsx
grep -q "chat-workspace-page" src/styles/pixel-workshop-skin.css
grep -q "training-workshop-page" src/styles/pixel-workshop-skin.css
grep -q "annotation-focus-header" src/styles/pixel-workshop-skin.css
grep -q "training-cockpit-shell" src/styles/pixel-workshop-skin.css
grep -q "模型训练流程" src/pages/TrainingWorkshopPage.tsx
! grep -q "后续可通过" src/pages/TrainingWorkshopPage.tsx
! grep -q "Model Training Workshop" src/pages/TrainingWorkshopPage.tsx
grep -q "app-shell--pixel-game" src/layouts/AppShell.tsx
grep -q "app-game-bottom-nav" src/layouts/AppShell.tsx
grep -q "OpenClaw 工坊助手" src/layouts/AppShell.tsx
grep -q "resolvePixelRoomContext" src/layouts/AppShell.tsx
grep -q "app-game-bottom-nav" src/styles/pixel-workshop-skin.css
grep -q "app-chat-dock-room-context" src/styles/pixel-workshop-skin.css
grep -q "100dvh" src/styles/pixel-workshop-skin.css
grep -q "grid-auto-flow: column" src/styles/pixel-workshop-skin.css
grep -q "scroll-snap-type: x proximity" src/styles/pixel-workshop-skin.css
grep -q "app-game-bottom-nav-height" src/styles/game-workshop.css
grep -q "FR-005D Pixel Workshop Visual System" docs/prd.md
grep -q "3.4B Pixel Workshop Skin" docs/ia.md
grep -q "Pixel Workshop skin branch" docs/flows.md
grep -q "Track H: Pixel Workshop Visual System" PLANS.md
grep -q "sliced-clean" PLANS.md

node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const pixelLab = readFileSync('src/pages/PixelLabPage.tsx', 'utf8');
const snapshot = readFileSync('src/features/gameWorkshopSnapshot.ts', 'utf8');
const gameCss = readFileSync('src/styles/game-workshop.css', 'utf8');
const skinCss = readFileSync('src/styles/pixel-workshop-skin.css', 'utf8');
const roomContext = readFileSync('src/components/ui/pixelRoomContextModel.ts', 'utf8');
const assistant = readFileSync('src/components/game-workshop/GameWorkshopAssistant.tsx', 'utf8');
const appShell = readFileSync('src/layouts/AppShell.tsx', 'utf8');
const roomComponent = readFileSync('src/components/game-workshop/GameWorkshopRoom.tsx', 'utf8');
const assetCatalog = readFileSync('src/features/pixelWorkshopAssets.ts', 'utf8');

const match = pixelLab.match(/const coreRoomIds: GameWorkshopRoomId\[\] = \[([\s\S]*?)\];/);
if (!match) {
  throw new Error('Pixel Lab coreRoomIds declaration missing');
}

const ids = Array.from(match[1].matchAll(/'([^']+)'/g)).map((entry) => entry[1]);
const expected = ['reception', 'datasets', 'annotation', 'recipes', 'training', 'exam', 'publish', 'runtime', 'bugs'];
if (JSON.stringify(ids) !== JSON.stringify(expected)) {
  throw new Error(`Pixel Lab central rooms drifted: ${ids.join(', ')}`);
}

if (!pixelLab.includes('房间 9')) {
  throw new Error('Pixel Lab should present the nine-room House count');
}

for (const required of ['ProgressStepper', 'game-workshop-top-stepper', 'game-workshop-bottom-workbench--prototype', '模型角色动态', '工坊时间线', '工坊资源监控', '昨日工作小记', '成员栏 / 模型角色', 'Agent 下一步', 'activeRoomChatPath']) {
  if (!pixelLab.includes(required)) {
    throw new Error(`Pixel Lab prototype alignment surface missing: ${required}`);
  }
}

const visibleCopySources = `${pixelLab}\n${snapshot}\n${assistant}\n${appShell}\n${roomContext}`;
if (/AI-native pixel workshop|白天亮色像素工坊|设计说明|视觉氛围|视觉呈现|参考图|新图|前图|七间工作屋/.test(visibleCopySources)) {
  throw new Error('Pixel Lab visible copy should stay product-facing, not implementation/design commentary');
}

for (const required of [`id: 'datasets'`, `id: 'annotation'`, `id: 'recipes'`, `id: 'training'`, `id: 'exam'`, `id: 'publish'`, `id: 'runtime'`]) {
  if (!snapshot.includes(required)) {
    throw new Error(`Workshop snapshot missing required room: ${required}`);
  }
}

for (const token of ['#07162a', '#061325', '#10243a']) {
  if (skinCss.includes(token)) {
    throw new Error(`Pixel Workshop skin still contains old dark-night token ${token}`);
  }
}

for (const required of [
  'generated/sliced-clean',
  'house-room-backgrounds',
  'reception-command/prop.png',
  'training-house-facade/prop.png',
  'gable-roof/prop.png',
  'roof-tile-strip/prop.png',
  'wooden-support-set/prop.png',
  'hud-panel/prop.png',
  'dataset-warehouse/prop.png',
  'data-processing-annotation/prop.png',
  'feature-recipe/prop.png',
  'model-training/prop.png',
  'inference-validation/prop.png',
  'model-publishing/prop.png',
  'deployment-runtime/prop.png',
  'feedback-repair/prop.png',
  'dataset-keeper/prop.png',
  'annotation-specialist/prop.png',
  'runtime-operator/prop.png',
  'active-room-frame/prop.png'
]) {
  if (!assetCatalog.includes(required)) {
    throw new Error(`sliced-clean asset is not wired through catalog: ${required}`);
  }
}

if (assetCatalog.includes('generated/sliced/')) {
  throw new Error('Pixel Workshop catalog must not use the old generated/sliced root');
}

for (const source of [pixelLab, roomComponent, gameCss]) {
  if (source.includes('generated/sliced/')) {
    throw new Error('Pixel Lab primary composition must not reference old generated/sliced assets');
  }
}

for (const required of [
  'pixelWorkshopHouseAssets.facade',
  'pixelWorkshopHouseAssets.roof',
  'pixelWorkshopHouseAssets.roofTiles',
  'game-workshop-house__building',
  'game-workshop-house__frame'
]) {
  if (!pixelLab.includes(required)) {
    throw new Error(`Pixel Lab generated building layer missing: ${required}`);
  }
}

for (const required of [
  'getPixelWorkshopRoomAsset',
  'getPixelWorkshopRoomFurnitureAsset',
  'getPixelWorkshopScenePersonaAsset',
  'game-room__furniture-asset',
  'game-room__persona-asset',
  'game-room__active-frame'
]) {
  if (!roomComponent.includes(required)) {
    throw new Error(`GameWorkshopRoom generated layer missing: ${required}`);
  }
}

for (const required of [
  'game-workshop-house__building--roof',
  'game-workshop-house__building--supports-left',
  'game-room__furniture-asset',
  'game-room__persona-asset',
  'game-room__active-frame',
  'game-workshop-top-stepper',
  'game-agent-mission',
  'game-agent-mission__progress',
  'game-agent-mission__actions',
  'game-assistant__thread',
  'game-assistant__message-row',
  'game-assistant__quick-replies',
  'game-assistant__composer'
]) {
  if (!gameCss.includes(required)) {
    throw new Error(`Pixel Lab generated-asset styling missing: ${required}`);
  }
}

if (!roomComponent.includes('getPixelWorkshopRoleAsset')) {
  throw new Error('GameWorkshopRoom should read role assets through the centralized pixel asset catalog');
}

if (!pixelLab.includes('modelRolesByRoom')) {
  throw new Error('Pixel Lab should place model-role status characters into House rooms');
}

if (pixelLab.includes('coreRooms.slice(0, 5)')) {
  throw new Error('Pixel Lab left rail must expose all nine rooms, not only a partial slice');
}

if (assistant.includes('disabled') && assistant.includes('game-assistant__composer')) {
  throw new Error('OpenClaw composer must not be a disabled fake input');
}

if (!assistant.includes('useNavigate') || !assistant.includes('/workspace/chat?')) {
  throw new Error('OpenClaw composer should hand off typed messages to the conversation workspace');
}

const pixelLabRouteIndex = roomContext.indexOf(`pathname === '/workspace/pixel-lab'`);
const genericWorkspaceIndex = roomContext.indexOf(`pathname.startsWith('/workspace')`);
if (pixelLabRouteIndex < 0 || genericWorkspaceIndex < 0 || pixelLabRouteIndex > genericWorkspaceIndex) {
  throw new Error('/workspace/pixel-lab must resolve to training house context before the generic workspace command room');
}

if (assistant.includes('game-assistant__context')) {
  throw new Error('OpenClaw assistant should not render the old stacked context card');
}
NODE

echo "pixel workshop skin contract ok"
