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
- conversation action cards with `requires_input` / confirmation / completed / failed states
- derived `Suggested next steps` chain on both the full chat page and the right Dock, with guarded `/ops retry_training_job` handoff
- model draft + file upload + approval submission flow
- admin approval queue and audit list
- dataset list/detail, annotation workspace, training jobs, model versions, inference validation, and scoped cross-page handoff links
- vision-task understanding + orchestration MVP:
  - `POST /api/vision/tasks/understand`
  - `/vision/tasks` list
  - `/vision/tasks/:taskId` detail
  - auto-continue / auto-advance / register-model / feedback-dataset loop
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
- model training engineer shortest-path guide (`docs/training-engineer-quickstart.md`)
- `plan-llm-complete` report retention + nightly/manual CI workflow baseline
- `plan-llm-complete` nightly/manual workflow now restores runtime caches, runs readiness doctor/setup warmup, and includes the dedicated `vision-task` closure lane
- local `proof:plan-llm-remote` helper can now dispatch/poll/download the GitHub workflow once the branch is pushed and GitHub auth is ready

Current maturity assessment:

- release/verification baseline: usable and repeatedly smoke-verified
- conversation-guided orchestration: usable MVP, but the primary contracts/docs must stay synced with the newer vision-task flow
- visual data loop: core loop is usable; throughput and reviewer/rework continuity remain the main evolution track
- worker control plane: usable for guided onboarding and dedicated-auth closure; reliability hardening continues

## 3. Next Delivery Phases

Legacy phase map:

- Phase 1: data/task skeleton
- Phase 2: minimal annotation loop
- Phase 3: framework adapter integration
- Phase 4: OCR + detection closed loops
- Phase 5: enhancement track

Those legacy phases are no longer the best day-to-day execution view. The active roadmap is now organized as delivery tracks that map to the current codebase and handoff reality.

### Track A: Contract Closure and Engineer Usability (current round)

Scope:

1. sync `README.md`, `PLANS.md`, `PLAN_llm.md`, `docs/prd.md`, `docs/ia.md`, `docs/flows.md`, `docs/data-model.md`, `docs/api-contract.md`, and `docs/training-engineer-quickstart.md`
2. document the shipped `vision tasks` orchestration and `Suggested next steps` chat/Dock behavior in the primary contracts
3. keep one obvious engineer path:
  - README -> plans -> contracts -> quickstart -> page/API execution

Acceptance:

- a new engineer can discover the conversation-assisted training path without reading source files
- the main contracts reference the same routes, entities, and APIs for vision-task orchestration
- handoff notes, milestone docs, and quickstart no longer disagree on current product state

Current checklist:

- [x] `README.md` / `PLAN_llm.md` / `PLANS.md` / `docs/work-handoff.md` now point to the same execution entry order
- [x] primary contracts now cover `VisionTask` routes, states, entities, and endpoints
- [x] quickstart exposes both `chat -> vision task` and direct-console engineer paths
- [x] add a dedicated acceptance lane for the `vision task` MVP (`npm run smoke:vision-task-closure`)
- [x] prove remote/nightly runner readiness or document exact prerequisites/caches

### Track B: Vision Task Closure

Scope:

1. keep the conversation -> vision task -> training -> register -> feedback loop first-class
2. keep a dedicated smoke/acceptance lane for the `vision task` MVP instead of relying only on adjacent chat/training smokes
3. make follow-up links and guarded next-step actions stable across chat, Dock, task detail, and console pages

Acceptance:

- `npm run smoke:vision-task-closure` proves: understand -> missing-requirements guard -> trainable task creation -> launch round -> register -> mine feedback dataset -> completed closure state
- `VisionTask` deep links and chat action cards stay aligned after future UI refactors

### Track C: Data Loop Throughput

Scope:

1. reviewer/rework continuity from dataset detail into annotation queue
2. stronger dataset-version context in training/inference jumps
3. higher-throughput sample browser, filters, and batch operations

Status:

- In progress with baseline shipped:
  - OCR/detection annotation and review transitions
  - box draw/move/resize + keyboard nudge/delete
  - minimal segmentation polygon canvas with vertex drag/edit
  - sample browser and bulk-governance foundation
  - phase smoke script (`npm run smoke:phase2`) validating segmentation persistence + inference fallback
  - next closure target is reviewer queue + rejected rework visibility from dataset detail into annotation workspace

### Track D: Runtime and Worker Reliability

Scope:

1. PaddleOCR adapter
2. docTR adapter
3. YOLO adapter
4. unified normalized inference output
5. worker onboarding, callback validation, and dispatch failover transparency

Early progress:

- Runtime bridge is now unified across PaddleOCR/docTR/YOLO predict path with per-framework endpoint + API key config.
- Adapter fallback policy is unified (`mock_fallback`) to keep product loop available when runtime endpoint is unavailable.
- Inference validation page now supports in-app runtime connectivity checks (`/api/runtime/connectivity`) for all three frameworks.
- Added dedicated runtime settings entry (`/settings/runtime`) for engineering diagnostics and refresh checks.
- Runtime settings now includes integration templates (env vars, health curl, request/response payload examples).
- Runtime settings execution watch now also surfaces latest framework-specific metric keys sampled from recent completed training jobs.
- Added dedicated OCR closure smoke to validate OCR import -> PaddleOCR/docTR local-command training -> metrics/artifact summary -> model-version register -> inference on real uploaded files.

### Track E: Release Governance and Real-Execution Evidence

Scope:

1. keep `strict-real` / `pure-real` / `plan-llm-complete` evidence easy to rerun and archive
2. make CI/nightly reports discoverable and portable across local + remote runner environments
3. tighten release handoff language for engineers and operators

Acceptance:

- release evidence paths are documented in one place
- report artifacts are retained and linked back into plans/handoffs
- failure cases leave enough breadcrumbs to recover without reading implementation code

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

## 6.2 Documentation Discipline (Mandatory)

All implementation rounds must follow this order:

1. Write plan first:
   - Add or update the related local `.md` file before coding.
   - Include scope, acceptance checks, and risks.
2. Implement changes:
   - Keep code edits aligned with the written plan.
3. Backfill results immediately:
   - Mark completed items in the same `.md`.
   - Record verification commands and outcomes.
4. Handoff continuity:
   - If interrupted, append a concrete entry in `docs/work-handoff.md` with next actionable steps.

Minimum documentation checklist per round:
- [ ] Plan updated in local `.md`
- [ ] Code changes completed
- [ ] Verification results written back
- [ ] Handoff updated when needed

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
1. Keep the just-landed contract/doc closure stable: future implementation changes must update the same primary docs first.
2. Keep the new dedicated acceptance lane for the vision-task MVP green and make it the default regression surface for that orchestration.
3. Keep release evidence commands and report paths green/easy to hand off.

Current priority queue:

1. Run at least one remote/nightly proof for `plan-llm-complete` with `npm run proof:plan-llm-remote` now that the workflow caches `.data/runtime-python/.venv` / `.data/runtime-models` and auto-runs readiness doctor/setup.
2. Decide whether release evidence also needs a stricter real-only companion for the `vision-task` lane, because the portable nightly baseline now already includes it.
3. Execute visual-data-loop evolution track (`docs/visual-data-loop-evolution.md`):
   - Phase 1 first: dataset sample browser (grid/filter/batch), sample review workbench layout polish, and version-centered action clarity.
4. Close Phase 2 annotation workflow from dataset detail into reviewer/rework queue and persistent reject context.
5. Tighten dataset-version-backed training launch readiness after annotation/review closure.
6. Continue worker rollout hardening after dedicated-auth closure:
   - keep worker smoke scripts seed-id portable (dynamic train-target resolution + guard checks)
   - optionally extract remaining bootstrap/login lifecycle helpers to further reduce duplication
   - add host override guidance/smoke for environments without `host.docker.internal`
7. Continue the design-system convergence pass only after the contract/doc and closed-loop acceptance gaps above are stable.
