# Project Plans and Milestones

## 1. Vision

Build Vistral into an AI-native visual model engineering platform with dual entry:

- conversational workspace for rapid interaction
- professional console for dataset/annotation/training/model lifecycle operations

The system roles remain only `user` and `admin`; ownership is modeled as resource relation/capability.

## 2. Current Baseline

Already available:

- shared app shell and unified UI state blocks
- conversation + attachment + mock response loop
- model draft + file upload + approval submission flow
- admin approval queue and audit list
- BYO LLM settings (prototype)
- dockerized intranet baseline (`vistral-web` + `vistral-api`)
- intranet rollout modes: local build + registry image mode + offline image import path
- ops automation: release bundle packaging + full deployment verification scripts + report-included bundle handoff
- admin console now includes deployment verification report visibility for operations governance
- username/password auth flow (public registration locked to `user`)
- release bundle hardening: verify target precheck + report pinning (`VERIFY_REPORT_PATH`) + optional freshness gate (`VERIFY_REPORT_MAX_AGE_SECONDS`)
- admin verification reports page now supports filter/search + collapsible check details for operations review
- permission smoke script for admin verification reports endpoint (`npm run smoke:admin:verification-reports`)
- API error semantics hardened: core handlers now map to contract codes/status (`401/403/404/409/500`)
- admin verification reports page now supports pagination + filtered JSON export for governance evidence
- API error mapping now uses pattern-first classification with explicit fallback mappings
- admin verification reports page now supports date-range filter and ordering controls
- API error normalization moved into shared backend module (`backend/src/apiError.ts`) to reduce drift
- admin verification reports page now supports quick date presets (7/30 days) and defaults to failed-first ordering
- conversation workspace refreshed to immersive chat-style shell with persistent attachment strip in composer context
- local command adapter bridge added for framework train/predict paths (environment-driven, page/API contract unchanged)

## 3. Next Delivery Phases

### Phase 1: Data and Task Skeleton (current round)

Scope:

1. schema and domain types for dataset/annotation/training/model-version/inference
2. API stubs + mock handlers
3. skeleton pages:
  - dataset list/detail
  - training jobs list/detail
  - model versions
  - inference validation
4. contract and docs alignment

Acceptance:j x

- build/lint/typecheck pass
- mock OCR and detection paths can be demonstrated end-to-end

### Phase 2: Minimal Annotation Loop

Scope:

1. image annotation workspace
2. box + OCR text annotation
3. save/continue edit
4. review status transitions and rejection loop

Status:

- In progress with baseline shipped:
  - OCR/detection annotation and review transitions
  - box draw/move/resize + keyboard nudge/delete
  - minimal segmentation polygon canvas with vertex drag/edit
  - phase smoke script (`npm run smoke:phase2`) validating segmentation persistence + inference fallback

### Phase 3: Framework Adapter Integration

Scope:

1. PaddleOCR adapter
2. docTR adapter
3. YOLO adapter
4. unified normalized inference output

Early progress:

- Runtime bridge is now unified across PaddleOCR/docTR/YOLO predict path with per-framework endpoint + API key config.
- Adapter fallback policy is unified (`mock_fallback`) to keep product loop available when runtime endpoint is unavailable.
- Inference validation page now supports in-app runtime connectivity checks (`/api/runtime/connectivity`) for all three frameworks.
- Added dedicated runtime settings entry (`/settings/runtime`) for engineering diagnostics and refresh checks.
- Runtime settings now includes integration templates (env vars, health curl, request/response payload examples).

### Phase 4: Two Closed Business Loops

Loop A (OCR): dataset -> annotation/import -> train -> evaluate -> register -> validate -> feedback

Loop B (Detection): dataset -> annotation/import -> train -> evaluate -> register -> validate -> feedback

### Phase 5: Enhancement Track

- pre-annotation at scale
- difficult-sample mining and active learning
- collaborative annotation
- worker queue scaling and distributed training

## 4. Hard Execution Rules

- do not stop at landing-only updates
- shared layer first, then feature pages
- multi-step flows require top stepper
- advanced parameters default collapsed
- uploads remain visible/deletable/status-aware
- empty/loading/error/success states must stay consistent
- register cannot create admin accounts

## 5. Risks and Mitigation

- Risk: contract drift across docs and code
  - Mitigation: update flows/data-model/api-contract before behavior changes
- Risk: framework-specific branching
  - Mitigation: enforce unified adapter interface
- Risk: UI inconsistency across new modules
  - Mitigation: reuse shared components and parity review

## 6. Interruption Continuation Queue

When work is interrupted by a new conversation task, append handoff details in `docs/work-handoff.md` first, then continue from this queue.

Current priority queue:

1. Enable dependency-aware real framework execution inside local runners (ultralytics / paddleocr / doctr) with deterministic fallback retained
2. Add richer epoch-level metrics persistence + API payload for training detail visualization
3. Expose explicit execution mode/source fields in APIs (training + inference) to reduce frontend inference from logs
4. Expand framework-specific smoke coverage for dependency-present path without creating duplicate routes/pages

