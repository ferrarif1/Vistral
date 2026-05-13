# Vistral Pixel Training Platform Asset Pack Plan

Date: 2026-04-29

## Source References
- Palette / material / light: `src-img/新工作台.png`
  - daytime blue sky
  - red clay roof tiles
  - warm wood beams
  - light beige plaster walls
  - dark teal HUD panels
  - blue active glow
  - green success states
  - orange warning markers
- Content / information architecture: `src-img/方案效果总览.png`
  - left project and stage rail
  - central model training house
  - right tasks, statistics, and OpenClaw chat
  - bottom model squad and workflow overview
  - rooms for datasets, processing/annotation, feature recipe, training, validation/exam, publishing, runtime, feedback context

## Generation Workflow
This follows `.agents/skills/agent-sprite-forge-main`:
- Use `generate2dsprite` for transparent isolated sprites, prop packs, UI widgets, and characters.
- Use `generate2dmap` rules for building / room-module packs, but output isolated transparent modules instead of full scenes.
- Use solid `#FF00FF` background only when the image will later be chroma-key processed.
- Prefer transparent background directly for this first visual asset sheet, because the UI needs isolated PNG assets.
- No full scenes, no screenshots, no labels, no text baked into assets unless the prop itself is a signplate shape without readable text.

## First Master Sheet Scope
Generate one master transparent PNG sheet with five horizontal groups, each containing isolated game-development assets:

1. Buildings, 8 variations
   - main training house facade pieces
   - roof caps and roof tiles
   - wall/window segments
   - door and porch modules
   - chimney, awning, wooden supports

2. Room modules, 8 variations
   - dataset warehouse
   - data processing / annotation room
   - feature engineering recipe room
   - model training room
   - inference validation / exam room
   - model publishing room
   - deployment/runtime room
   - feedback / repair corner

3. Furniture and equipment, 10 variations
   - dataset shelves and crates
   - annotation desk and monitor
   - token/vector blackboard
   - GPU server rack
   - validation desk
   - package/version table
   - runtime monitor rack
   - lamps, plants, toolboxes, notification board

4. Characters, 8 variations
   - OpenClaw crab assistant
   - robot model role
   - dataset keeper
   - annotation specialist
   - recipe wizard
   - training engineer
   - validation examiner
   - runtime operator / repair worker

5. UI elements, 10 variations
   - dark teal HUD panel
   - sidebar card
   - bottom navigation button
   - active blue room frame
   - success badge
   - warning badge
   - error badge
   - progress bar
   - chat bubble pair
   - icon buttons for settings, help, upload, send

## Output Rules
- PNG, transparent background.
- Isolated assets only; no full scene composition.
- Consistent pixel scale, outline weight, palette, and lighting.
- Each object has generous transparent padding.
- No readable text baked into assets.
- Designed to be sliced into individual files in a follow-up processing step.

## Generated Outputs

Generated source folder:
- `/Users/zhangyuanyi/.codex/generated_images/019d4d09-7ef5-7471-a494-4c94dfb27795`

Project asset outputs:
- `raw-sheets/` - first pass visual-reference sheets; RGB with baked checkerboard, not production alpha.
- `raw-magenta-sheets/` - second pass solid `#FF00FF` sheets, preferred source for cleanup.
- `alpha-sheets/` - chroma-keyed RGBA sheets.
- `sliced/` - first automatic single-asset slices.
- `sliced-clean/` - experimental stronger edge-clean slices; not preferred because QC did not improve.
- `manifest.json` - generation source manifest.
- `asset-catalog.json` - front-end oriented asset index.
- `qc-report.md` - quality report and recommended usage.

## Current QC Decision

- Use `sliced/room-modules/*/prop.png` first. This category produced 8/8 clean slices and best matches the target central-room rebuild.
- Do not blindly wire all generated assets. Check `asset-catalog.json` and `qc-report.md`; assets with `edge_touch: true` should be reviewed or regenerated in smaller packs.
- Next asset pass should regenerate buildings, characters, furniture, and UI in smaller `2x2` packs or one-by-one prompts for better margins.

## Unified House Room Background Pass

Date: 2026-04-30

Reason:
- The first `room-modules` slices are useful as concept props, but they were generated as independent room cards.
- Their dimensions, crop bounds, and edge-touch behavior make them unsuitable as backgrounds inside the single 3x3 Pixel Lab House.

New output:
- `house-room-backgrounds/atlas.png`
- `house-room-backgrounds/manifest.json`
- `house-room-backgrounds/<room>/prop.png`

Contract:
- nine same-size PNG assets, `384x256`
- shared wall, floor, ceiling, and cutaway baseline
- no standalone outer frame; shared House CSS owns room borders and roof/facade
- no readable baked text
- bright daytime workshop palette from `src-img/新工作台.png`
- room semantics from `src-img/方案效果总览.png`

Frontend usage:
- Use `house-room-backgrounds` as the full-cell room background layer.
- Keep `sliced-clean/furniture-equipment` and `sliced-clean/characters` as foreground overlays.
- Keep old `sliced-clean/room-modules` available as historical concept art, but do not use it as the primary central House background.

