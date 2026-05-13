# Generated Vistral Pixel Workshop Assets

This folder contains the first generated asset pack for rebuilding Vistral into a bright pixel model-training platform.

References:
- Palette/material/light: `src-img/新工作台.png`
- Content/layout: `src-img/方案效果总览.png`

Important files:
- `asset-pack-plan.md` - generation scope and workflow.
- `manifest.json` - source files and raw sheet metadata.
- `asset-catalog.json` - indexed generated assets for frontend usage.
- `qc-report.md` - quality status and review notes.

Recommended current source:
- `sliced/room-modules/*/prop.png` for the first Pixel Lab room-scene rebuild.

Do not use blindly:
- `raw-sheets/` has baked checkerboard backgrounds.
- `sliced-clean/` is experimental and currently not better than `sliced/`.
- Assets with `edge_touch: true` in `asset-catalog.json` need review or regeneration before production UI placement.
