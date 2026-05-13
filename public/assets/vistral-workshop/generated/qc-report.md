# Vistral Pixel Asset Pack QC Report

Date: 2026-04-29

## Summary

- Generated source references: `src-img/新工作台.png` for visual palette, `src-img/方案效果总览.png` for content organization.
- First transparent prompt pass produced RGB files with a baked checkerboard background; kept under `raw-sheets/` for visual reference only.
- Second pass produced solid `#FF00FF` sheets under `raw-magenta-sheets/`, suitable for chroma-key cleanup.
- Chroma-key alpha sheets are stored under `alpha-sheets/`.
- Automatic single-asset slices are stored under `sliced/`.
- `sliced-clean/` was tested with stronger edge cleanup, but did not improve QC; keep it as an experiment, not the preferred source.

## Category QC

### buildings
- accepted: 10
- clean edge: 2
- edge touch: 8
- needs review/regeneration: training-house-facade, roof-ridge-cap, roof-tile-strip, gable-roof, wooden-support-set, arched-door-porch, brick-chimney, balcony-planter

### room-modules
- accepted: 8
- clean edge: 8
- edge touch: 0

### furniture-equipment
- accepted: 16
- clean edge: 3
- edge touch: 13
- needs review/regeneration: dataset-shelf, data-crates, annotation-desk, checklist-board, token-vector-blackboard, gpu-server-rack, training-loss-monitor, validation-desk, package-version-table, potted-plant, toolbox-cables, notification-board, active-glow-corners

### characters
- accepted: 10
- clean edge: 3
- edge touch: 7
- needs review/regeneration: openclaw-crab, robot-model, dataset-keeper, annotation-specialist, recipe-wizard, publishing-graduate, runtime-operator

### ui-elements
- accepted: 20
- clean edge: 0
- edge touch: 20
- needs review/regeneration: hud-panel, sidebar-card, vertical-rail-panel, bottom-nav-button, bottom-nav-button-active, icon-button, primary-button, secondary-button, active-room-frame, success-badge, warning-badge, error-badge, neutral-pill, progress-empty, progress-filled, notification-bubble, work-note-paper, assistant-chat-bubble, user-chat-bubble, icon-button-set

## Recommended Usage

- Use `alpha-sheets/room-modules.png` or `sliced/room-modules/*/prop.png` first for the true Pixel Lab room rebuild.
- Use `sliced/characters/openclaw-crab/prop.png` and `sliced/characters/robot-model/prop.png` for early OpenClaw/model-role replacement after visual review.
- Do not wire all `sliced/` assets blindly; assets with `edge_touch: true` should be manually reviewed or regenerated with more margin.
- Next production step: regenerate buildings, characters, furniture, and UI as smaller 2x2 or one-by-one packs to reduce edge-touch and improve slice quality.

