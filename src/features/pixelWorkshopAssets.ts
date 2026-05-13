import type { GameWorkshopRoomId } from './gameWorkshopSnapshot';

const generatedRoot = '/assets/vistral-workshop/generated/sliced-clean';
const houseRoomRoot = '/assets/vistral-workshop/generated/house-room-backgrounds';

export const pixelWorkshopHouseAssets = {
  frame: '/assets/vistral-workshop/house-frame.svg',
  facade: `${generatedRoot}/buildings/training-house-facade/prop.png`,
  roof: `${generatedRoot}/buildings/gable-roof/prop.png`,
  roofTiles: `${generatedRoot}/buildings/roof-tile-strip/prop.png`,
  ridge: `${generatedRoot}/buildings/roof-ridge-cap/prop.png`,
  supports: `${generatedRoot}/buildings/wooden-support-set/prop.png`,
  window: `${generatedRoot}/buildings/wall-window-module/prop.png`,
  porch: `${generatedRoot}/buildings/arched-door-porch/prop.png`,
  chimney: `${generatedRoot}/buildings/brick-chimney/prop.png`,
  awning: `${generatedRoot}/buildings/side-awning/prop.png`,
  planter: `${generatedRoot}/buildings/balcony-planter/prop.png`
} as const;

export const pixelWorkshopRoomAssets: Partial<Record<GameWorkshopRoomId, string>> = {
  reception: `${houseRoomRoot}/reception-command/prop.png`,
  datasets: `${houseRoomRoot}/dataset-warehouse/prop.png`,
  annotation: `${houseRoomRoot}/data-processing-annotation/prop.png`,
  recipes: `${houseRoomRoot}/feature-recipe/prop.png`,
  training: `${houseRoomRoot}/model-training/prop.png`,
  exam: `${houseRoomRoot}/inference-validation/prop.png`,
  publish: `${houseRoomRoot}/model-publishing/prop.png`,
  runtime: `${houseRoomRoot}/deployment-runtime/prop.png`,
  bugs: `${houseRoomRoot}/feedback-repair/prop.png`
};

export const pixelWorkshopCharacterAssets = {
  openClaw: `${generatedRoot}/characters/openclaw-crab/prop.png`,
  assistant: `${generatedRoot}/characters/openclaw-crab/prop.png`,
  robot: `${generatedRoot}/characters/robot-model/prop.png`,
  warehouse: `${generatedRoot}/characters/dataset-keeper/prop.png`,
  annotator: `${generatedRoot}/characters/annotation-specialist/prop.png`,
  trainer: `${generatedRoot}/characters/training-engineer/prop.png`,
  examiner: `${generatedRoot}/characters/validation-examiner/prop.png`,
  graduate: `${generatedRoot}/characters/publishing-graduate/prop.png`,
  operator: `${generatedRoot}/characters/runtime-operator/prop.png`,
  engineer: `${generatedRoot}/characters/training-engineer/prop.png`,
  exam: `${generatedRoot}/characters/validation-examiner/prop.png`,
  recipe: `${generatedRoot}/characters/recipe-wizard/prop.png`,
  publish: `${generatedRoot}/characters/publishing-graduate/prop.png`,
  repair: `${generatedRoot}/characters/worker-node-companion/prop.png`
} as const;

export const pixelWorkshopFurnitureAssets = {
  datasets: `${generatedRoot}/furniture-equipment/dataset-shelf/prop.png`,
  annotation: `${generatedRoot}/furniture-equipment/annotation-desk/prop.png`,
  recipes: `${generatedRoot}/furniture-equipment/token-vector-blackboard/prop.png`,
  training: `${generatedRoot}/furniture-equipment/gpu-server-rack/prop.png`,
  exam: `${generatedRoot}/furniture-equipment/validation-desk/prop.png`,
  publish: `${generatedRoot}/furniture-equipment/package-version-table/prop.png`,
  runtime: `${generatedRoot}/furniture-equipment/runtime-health-monitor/prop.png`,
  bugs: `${generatedRoot}/furniture-equipment/toolbox-cables/prop.png`,
  reception: `${generatedRoot}/furniture-equipment/notification-board/prop.png`,
  lamp: `${generatedRoot}/furniture-equipment/hanging-lamp/prop.png`,
  plant: `${generatedRoot}/furniture-equipment/potted-plant/prop.png`,
  dataCrates: `${generatedRoot}/furniture-equipment/data-crates/prop.png`,
  trainingMonitor: `${generatedRoot}/furniture-equipment/training-loss-monitor/prop.png`,
  workerNode: `${generatedRoot}/furniture-equipment/worker-node-server/prop.png`,
  activeGlow: `${generatedRoot}/furniture-equipment/active-glow-corners/prop.png`
} as const;

export const pixelWorkshopUiAssets = {
  hudPanel: `${generatedRoot}/ui-elements/hud-panel/prop.png`,
  sidebarCard: `${generatedRoot}/ui-elements/sidebar-card/prop.png`,
  verticalRailPanel: `${generatedRoot}/ui-elements/vertical-rail-panel/prop.png`,
  bottomNavButton: `${generatedRoot}/ui-elements/bottom-nav-button/prop.png`,
  bottomNavButtonActive: `${generatedRoot}/ui-elements/bottom-nav-button-active/prop.png`,
  activeRoomFrame: `${generatedRoot}/ui-elements/active-room-frame/prop.png`,
  assistantBubble: `${generatedRoot}/ui-elements/assistant-chat-bubble/prop.png`,
  userBubble: `${generatedRoot}/ui-elements/user-chat-bubble/prop.png`,
  notificationBubble: `${generatedRoot}/ui-elements/notification-bubble/prop.png`,
  workNotePaper: `${generatedRoot}/ui-elements/work-note-paper/prop.png`,
  progressEmpty: `${generatedRoot}/ui-elements/progress-empty/prop.png`,
  progressFilled: `${generatedRoot}/ui-elements/progress-filled/prop.png`
} as const;

const scenePersonaAssetMap = {
  assistant: pixelWorkshopCharacterAssets.openClaw,
  warehouse: pixelWorkshopCharacterAssets.warehouse,
  annotator: pixelWorkshopCharacterAssets.annotator,
  recipe: pixelWorkshopCharacterAssets.recipe,
  trainer: pixelWorkshopCharacterAssets.trainer,
  examiner: pixelWorkshopCharacterAssets.examiner,
  graduate: pixelWorkshopCharacterAssets.graduate,
  operator: pixelWorkshopCharacterAssets.operator,
  repair: pixelWorkshopCharacterAssets.repair
} as const;

export const getPixelWorkshopRoomAsset = (roomId: GameWorkshopRoomId): string | undefined =>
  pixelWorkshopRoomAssets[roomId];

export const getPixelWorkshopRoleAsset = (persona: keyof typeof pixelWorkshopCharacterAssets): string =>
  pixelWorkshopCharacterAssets[persona];

export const getPixelWorkshopRoomFurnitureAsset = (roomId: GameWorkshopRoomId): string =>
  pixelWorkshopFurnitureAssets[roomId];

export const getPixelWorkshopScenePersonaAsset = (persona: keyof typeof scenePersonaAssetMap): string =>
  scenePersonaAssetMap[persona];
