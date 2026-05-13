# Vistral Workshop Assets

This folder is the centralized asset pack for the Pixel Workshop visual system.

Provided reference-style PNG files:

- `dataset.png`
- `training.png`
- `exam.png`
- `robot.png`
- `scientist.png`
- `wizard.png`

Generated route-room SVG files:

- `command.svg` – conversation / vision task command room backdrop
- `cleaning.svg` – cleaning / annotation room backdrop
- `recipe.svg` – model recipe room backdrop
- `feedback.svg` – bug fix / badcase return room backdrop
- `models.svg` – model role / inventory room backdrop
- `publish.svg` – model graduation / approval / governance backdrop
- `runtime.svg` – runtime / worker monitoring backdrop
- `settings.svg` – account / system settings room backdrop

Usage:
- `/workspace/pixel-lab` renders the full model-training house.
- `WorkspacePage` maps professional routes to the closest workshop room and uses these images inside room cards, headers, state panels, and companions. Do not use the reference images as a full-screen wallpaper replacement for real UI.
- `/training-workshop` may still render CSS fallback rooms and characters when any PNG is missing, so the demo remains usable before the final asset pack is complete.

Rules:
- Keep generated additions in this folder.
- Do not reference images only from `src-img/`; copy approved project assets here first.
- If a room-specific raster asset is missing, use CSS/SVG fallback visuals until a matching pixel-style PNG is generated.
