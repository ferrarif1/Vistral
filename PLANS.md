# Project Plans and Milestones

## 1. Vision

Build Vistral into an AI-native visual model engineering platform with two workspace routes:

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
- intranet rollout path is now single-entry Docker (`npm run docker:up`)
- ops automation focuses on deployment verification scripts + admin verification report governance
- admin console now includes deployment verification report visibility for operations governance
- username/password auth flow (public registration locked to `user`)
- deployment verify hardening: strict/non-strict OCR closure controls plus runtime metrics retention reporting
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
  - next closure target is reviewer queue + rejected rework visibility from dataset detail into annotation workspace

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
- Runtime settings execution watch now also surfaces latest framework-specific metric keys sampled from recent completed training jobs.
- Added dedicated OCR closure smoke to validate OCR import -> PaddleOCR/docTR local-command training -> metrics/artifact summary -> model-version register -> inference on real uploaded files.

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

## 6.1 One-Engineer Elite Execution Plan (2026-04)

Execution principle: one world-class engineer + strict scope control + measurable closure.

### Stage A (P0, now): Real-Execution Credibility
1. Build and expose platform-level “reality KPIs”:
   - training real-run coverage
   - inference real-run coverage
   - fallback/simulated trend
2. Keep non-real evidence blocked from model-version registration by default.
3. Tighten runtime profile safety UX (preview + overwrite guard + explicit activation context).

### Stage B (P1): Data Loop Throughput
1. Close annotation reviewer/rework continuity from dataset detail -> annotate queue.
2. Make dataset-version context first-class in all training/inference jumps.
3. Improve bulk metadata/tag workflows for sample triage efficiency.

### Stage C (P2): Worker Control Plane Reliability
1. Complete guided worker GUI onboarding and compatibility gates.
2. Strengthen dispatch failover observability and bounded retry diagnostics.
3. Add operator-first remediation playbooks for worker-side failures.

### Immediate Sprint (this round)
1. Land reality KPI visibility directly in Professional Console overview (main metric cards + inspector context).
2. Keep all checks green (`typecheck`, `lint`, `build`, targeted smoke).
3. Continue incremental release with contract-aligned docs and no route sprawl.

Current priority queue:

1. Refactor the full frontend against `DESIGN.md` / `notion/DESIGN.md` so all pages share one AI-native design system and layout language.
2. Execute visual-data-loop evolution track (`docs/visual-data-loop-evolution.md`):
   - Phase 1 first: dataset sample browser (grid/filter/batch), sample review workbench layout polish, and version-centered action clarity.
3. Close Phase 2 annotation workflow from dataset detail into reviewer/rework queue and persistent reject context.
4. Tighten dataset-version-backed training launch readiness after annotation/review closure.
5. Continue the lower-priority framework realification backlog:
   - dependency-aware real framework execution inside local runners
   - richer epoch-level metrics retention/export hardening
   - dependency-present smoke expansion without duplicate routes/pages
6. Continue worker rollout hardening after dedicated-auth closure:
   - keep worker smoke scripts seed-id portable (dynamic train-target resolution + guard checks)
   - optionally extract remaining bootstrap/login lifecycle helpers to further reduce duplication
   - add host override guidance/smoke for environments without `host.docker.internal`
7. Design and implement worker GUI onboarding:
   - runtime-side `Add Worker` wizard
   - Docker-first worker bootstrap and pairing flow
   - local worker setup UI + validation gates before scheduling enablement
8. Monitor for any remaining refresh-jump reports outside the now-completed main/secondary polling sweep.
9. If more visual refinement is requested later, run a screenshot-driven pass on remaining iconography and spacing details.
