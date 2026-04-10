# Runtime Placeholder Gap List

Last updated: 2026-04-10

This list tracks behaviors that can look "real" in UI/API but are still template/simulated/fallback execution.

## Scope and Criteria
- Only include gaps similar to the OCR fallback incident (fixed sample output, deterministic fake output, or simulated data that can be mistaken for real runtime/training results).
- Exclude explicit docs/examples that are clearly labeled as examples and never shown as real run output.

## Current Gap Inventory

| Priority | Area | Current Behavior | Risk | Status |
| --- | --- | --- | --- | --- |
| P0 | OCR local/template predict (docTR) | Template mode now uses explicit placeholder lines (`TEMPLATE_OCR_LINE_1/2`) and always emits `meta.fallback_reason` + `meta.template_reason`. | Can be misread as real OCR output. | Closed (2026-04-09) |
| P0 | Inference fallback output (non-OCR) | Hard-failure fallback now returns empty structured heads instead of synthetic detection/segmentation/classification placeholders. | Can be mistaken for real predictions. | Closed (2026-04-09) |
| P0 | Inference warning surface | UI warning logic now also checks `raw_output.meta.mode=template` (not only `source`/fallback reason fields). | Template outputs may look "successful" without strong warning. | Closed (2026-04-09) |
| P0 | Local deterministic pseudo-inferencer path (`<framework>_local`) | Retired fallback path that previously could synthesize seeded boxes/labels/text-like output when local command template was missing. Missing-command branch now returns explicit empty fallback (`explicit_fallback_local_command_failed`). | Seeded pseudo output could be mistaken for real runtime result. | Closed (2026-04-09) |
| P1 | Local command tokenization for empty args | Fixed command tokenizer to preserve quoted empty arguments (for example `--model-path ''`), preventing runner argparse failures that silently downgraded to fallback. | Runtime could appear flaky and over-trigger fallback even when bundled runner was available. | Closed (2026-04-09) |
| P1 | Predict fallback regression coverage | `smoke:adapter-no-placeholder` now also verifies predict-path hard failures (OCR + detection) return `explicit_fallback_local_command_failed` with empty structured payloads and explicit fallback reasons. | Future refactors could reintroduce pseudo predictions in failure paths. | Closed (2026-04-09) |
| P1 | Training execution authenticity surface | Training queue/detail now distinguishes `real` vs `template/simulated/unknown` execution with explicit warning blocks for terminal jobs lacking real-training evidence. | Operators may publish versions trained via template/simulated fallback without noticing. | Closed (2026-04-09) |
| P0 | Model version registration authenticity gate | `POST /model-versions/register` now rejects `local_command` jobs when artifact summary indicates non-real execution evidence (`mode=template`, explicit `fallback_reason`, or `training_performed=false`), unless `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1` is explicitly set. | Template/fallback training outputs could be promoted as production model versions. | Closed (2026-04-10) |
| P0 | YOLO local/template predict payload realism | YOLO template predict runner now emits explicit empty structured outputs (`boxes/rotated_boxes/polygons/masks/labels=[]`) plus `meta.template_payload=empty_structured_output`; no deterministic pseudo detections/classifications are generated. | Template runner outputs could be mistaken for real visual detections. | Closed (2026-04-10) |
| P1 | Local-command template fallback reason consistency | For local-command template runs, backend now mirrors `raw_output.meta.fallback_reason` into `raw_output.local_command_fallback_reason` so scripts/UI can consume a single canonical fallback-reason field. | Mixed fallback-reason fields could cause false-negative fallback detection in automation. | Closed (2026-04-10) |
| P1 | Local train template artifact reason consistency | Bundled local train runners (`yolo/paddleocr/doctr`) now always emit explicit template artifact evidence (`mode=template`, `fallback_reason=template_mode_default|<reason>`, `template_reason`, `training_performed=false`) when real execution is not available. | Template training artifacts without explicit reason may be misread as successful real training outputs. | Closed (2026-04-10) |
| P1 | Adapter `evaluate()` | Adapter now resolves metrics from file-backed runtime artifacts (`metrics.json` / artifact manifest metrics), and returns empty metrics when unavailable. | Fake metrics may look real. | Closed (2026-04-09) |
| P1 | Adapter `export()` | Adapter now writes a real local export artifact/manifest under `MODEL_EXPORT_ROOT` (default `.data/model-exports`). | False sense of completed export. | Closed (2026-04-09) |
| P1 | Adapter `load_model()` | Adapter now validates artifact existence (explicit path or exported artifact) and errors when missing. | False sense of successful model load. | Closed (2026-04-09) |
| P2 | Seeded prototype records | Added `APP_STATE_BOOTSTRAP_MODE=minimal` for first bootstrap and `npm run data:reset:foundation` to rewrite existing app-state to account + curated foundation-model baseline. | Users may treat seed rows as executed runtime records. | Closed (2026-04-09) |

## Closure Rules
- Any fallback/template result must be explicit in both payload and UI.
- Hard failure fallback must prefer empty structured output over synthetic business-like payloads.
- Adapter methods (`evaluate/export/load_model`) must either use real file-backed artifacts or return explicit empty/failure semantics; no fake success paths.

## Suggested Verification
- `npm run smoke:ocr-fallback-guard`
- `npm run smoke:core-closure`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
