# Unified Project Plan

## Project Planning Model

### How to use this plan
- `PLANS.md` is the only active roadmap and execution-plan file in this repository.
- `docs/work-handoff.md` remains the only interruption log; use it for unfinished work, not for roadmap ownership.
- Do not create new parallel `PLAN*.md` files. Add new plan rounds and milestone changes here.

### Reading order
1. `README.md`
2. `AGENTS.md`
3. core contracts in `docs/`
4. this file
5. `docs/work-handoff.md` when continuing interrupted work

### Update rules
- Update contracts first when behavior, interfaces, or flow changes.
- Keep this file focused on what matters for near-term execution.
- Historical detail that is no longer useful for active work should stay in git history and `docs/work-handoff.md`, not be copied forward here.

## Current State Snapshot

### Delivered baseline
- Conversation-first and attachment-first workspace is usable.
- `VisionTask` orchestration MVP is shipped across chat, `/vision/tasks`, and linked training flows.
- `VisionTask` now carries one backend-generated next-step recommendation and a compact decision trail so task list/detail can behave like an agent inbox instead of a blind table.
- `VisionTask` now also emits one promotion gate and one run-comparison summary so the agent can explain whether to promote, retrain, collect more data, or wait.
- `VisionTask` now also emits one evaluation suite plus champion/challenger comparison context, so gate decisions are tied to an explicit metric contract instead of ad-hoc thresholds.
- Training jobs, model registration, inference validation, feedback datasets, and worker/control-plane scheduling are all present.
- Real-execution credibility work is in place: strict-real / pure-real gates, verify reports, smoke lanes, and remote-proof helper.
- Training cockpit and right-side conversational Dock exist as secondary expert/operator surfaces.

### Main gaps
- `VisionTask` is not yet the undisputed top-level object of the training domain.
- Training recipes and expert parameter contracts are not yet explicit enough for production-grade fine-tuning work.
- Real training readiness is still split across dataset checks, runtime checks, worker checks, and artifact evidence instead of one unified gate.
- Evaluation, run comparison, and promotion gates are still weaker than mainstream training platforms.
- The overall UX still needs a more explicit OpenAI-like smoothness contract: optimistic feedback, non-jumping refresh, compact action cards, and continuous context preservation.
- `dataset_profile` needs deeper data-quality and active-learning diagnostics.
- Agent rationale is not yet modeled as a first-class, auditable planning object.
- At least one authenticated remote/nightly proof run is still missing.

### Working principle
- Vistral should evolve as an **agent-native visual model platform**, not as a traditional dashboard-heavy MLOps console.
- Default user flow should stay `goal -> dataset snapshot -> agent chooses next step`, with manual controls as secondary expert escapes.

## Unified Roadmap

### Track A: Agent-Native Goal Orchestration
- Canonical orchestration architecture: `docs/agent-training-orchestration.md` (Studio CTA alignment, three-layer runtime, `agent_decision_log` audit options).
- Promote `VisionTask` to the top-level training-domain object.
- Make `/vision/tasks` the primary operator inbox: blocked, training, and next-action-ready tasks.
- Keep `/training/jobs/new` as a slim launcher under goal/task context, not a job-first form.
- Define `TrainingRecipe` and parameter contracts so agent-recommended training plans can be inspected and overridden without guessing.
- Plan `AgentDecisionLog` so the system can explain why it recommends a next step and where confirmation is required.

### Track B: Evaluation, Comparison, and Promotion Gates
- Add first-class planning for `EvaluationSuite`, `GateResult`, and `RunComparisonSet`.
- Cover benchmark suites, regression comparisons, champion/challenger semantics, and promotion gates.
- Define task-specific primary metrics, threshold sources, and failure-to-next-action rules for OCR, detection, and segmentation.
- Move the agent from “auto-continue” toward “compare, explain, and recommend”.

### Track C: Data Loop and Active Learning
- Expand `dataset_profile` beyond trainability checks into richer quality diagnostics.
- Add long-tail, duplicate, leakage, OCR charset coverage, and badcase-clustering signals.
- Upgrade feedback datasets from passive badcase sinks into active-learning candidate pools for the next round.

### Track D: Runtime / Worker Reliability
- Continue worker/control-plane hardening: dispatch, failover, readiness, bounded retries, and cross-machine payload delivery.
- Consolidate dataset, runtime, worker, device, and artifact checks into one real-training readiness gate.
- Treat this as the execution substrate under the agent, not the primary product story.

### Track E: Training Cockpit and Operator Evidence
- Keep cockpit as an expert evidence surface, not the primary training entry.
- Continue live/demo visualization, telemetry clarity, and tuning/resource evidence where it helps operators inspect runs.

### Track F: Release Governance and Real-Execution Evidence
- Continue strict-real / pure-real / nightly / verify report discipline.
- Keep remote-proof, report retention, and recovery steps easy to rerun.
- Expand acceptance from “run finished” to “agent recommendation is grounded in real evidence”.

### Track G: Smooth AI-Native Interaction
- Make interaction quality feel conversational, fast, and continuous across chat, task, training, model, inference, and feedback surfaces.
- Standardize optimistic draft states, compact action cards, non-jumping background refresh, preserved focus/scroll/filter state, and one-click recovery paths.
- Align all core surfaces with `notion/DESIGN.md` plus the Vistral AI-native interaction addendum.

### Track H: Pixel Workshop Visual System
- Extend the Pixel Lab / Model Training Workshop visual language across all shared authenticated workspace pages.
- Keep the implementation shared-layer-first: `WorkspacePage`, `PageHeader`, cards, workbench panels, tables, forms, state feedback, and route-aware asset mapping before page-specific art.
- Centralize all generated or supplied bitmap assets in `public/assets/vistral-workshop/`.
- Preserve the real workflow contracts: the pixel skin is a coherent visual shell, not a second business workflow.
- Structural blueprint decision (2026-04-29): use `src-img/方案效果总览.png` as the interaction architecture reference for the whole authenticated platform: top game HUD, central training-house room surface, right OpenClaw assistant dock, lower timeline/model/resource/work-note panels, and bottom room navigation.
- The authenticated AppShell should behave like a pixel-game HUD: no duplicate traditional left sidebar, bottom room navigation owns primary movement, and route assets must support real panels rather than act as full-screen wallpaper.
- Generate missing room/character assets only when the shared asset pack cannot represent a route or state clearly.
- Active visual direction (2026-04-29): use the supplied bright daytime workshop reference `src-img/新工作台.png` for mood, palette, room material, and light level. Avoid returning to a dark cyber/night monitoring-room tone.
- Latest product correction (2026-04-29): follow `src-img/方案效果总览.png` for the central house structure. The central canvas is one large pixel-game House with nine rooms: reception / conversation command, dataset warehouse, data cleaning / annotation, model recipe, training, inference validation / exam, model publishing / graduation, deployment / runtime monitoring, and bug / feedback repair.
- Pixel Lab content contract: the House is the primary game desktop, not a set of independent cards. Each room must read as part of the same cutaway building, with model characters moving to rooms by state (for example: collecting study materials in the dataset warehouse, training in the training room, taking exams in inference validation).
- Side rails, bottom panels, and the assistant remain supporting surfaces for summaries, notifications, model squad, work notes, and actions; they do not replace the central House.
- Content layout stays product-operational: left rail for project/stage/model/tasks/notes, central house for the workflow, right rail for notifications/statistics/metrics, bottom workbench for model squad and flow overview, and a persistent draggable/collapsible AI assistant.
- Before further visual implementation, keep `docs/prd.md`, `docs/ia.md`, and `docs/flows.md` aligned to this nine-room bright-workshop House contract.

### Track I: Frontend Reset to Agent Training Studio
- New target frontend contract: `docs/frontend-reset.md`.
- Replace the previous authenticated visual target of traditional console pages plus global Pixel Workshop skinning with one Agent Training Studio workbench.
- Make `/workspace/console` the first migration target.
- Keep canonical routes and APIs intact during migration; route pages are deep-linked fallback surfaces until migrated into the Studio contract.
- Do not add new backend state for frontend presentation only.
- Keep AI-native hard rules intact: visible/deletable/status-aware attachments, top steppers, collapsed advanced controls, unified state feedback, and explicit confirmation for risky mutations.
- Deprecated as target direction: page-specific dashboard stacks, Pixel Lab as a primary mode switch, and route-local decorative wrappers.

## Current Priority Queue

### Active Slice: Frontend reset foundation
- Goal: document and implement the first Agent Training Studio shell for `/workspace/console`, replacing the old console/pixel-shell target as the main authenticated entry.
- Documentation first:
  - `docs/frontend-reset.md`
  - `docs/prd.md`
  - `docs/ia.md`
  - `docs/flows.md`
  - `PLANS.md`
- Implementation scope:
  - new Studio home component for `/workspace/console`
  - new shared Studio stylesheet loaded after legacy styles so the first screen no longer depends on Pixel Workshop or traditional dashboard chrome
  - top stepper for goal/data/annotation/recipe/training/validation/promotion/deployment/feedback
  - one primary next action derived from real API records
  - evidence board for datasets, jobs, model versions, inference runs, approvals, and runtime/worker signals where available
  - contextual OpenClaw handoff preserving route/query context
- Non-goals:
  - do not rewrite every route in this first slice
  - do not change API/data contracts unless implementation requires it
  - do not delete legacy pages before the Studio has equivalent workflow coverage
- Verification:
  - `npm run typecheck`
  - `npm run lint`
  - targeted smoke guard for the Studio shell
  - browser screenshot/DOM check for `/workspace/console`

### Active Slice: Local annotated folder to training validation flow
- Goal: let an engineer point Vistral at a backend-local annotated asset folder, have the platform scan images/labels, import them into the existing dataset pipeline, reserve 5 manual validation samples, create a version, and launch training without rebuilding duplicate pages.
- Reused surfaces:
  - `DatasetDetailPage` for scan/import/split/version launch context
  - `CreateTrainingJobPage` and `TrainingJobDetailPage` for training configuration, logs, metrics, and artifact evidence
  - `InferenceValidationPage` for the five held-out manual verification images after a model version is registered
- First implementation:
  - backend-local folder scan endpoint
  - YOLO detection import from `images/` + `labels/` or flat pairs
  - Pascal VOC XML import from `Annotations/*.xml` + `JPEGImages/*` for the provided escalator-defect folder shape
  - minimal OCR import recognition for future PaddleOCR/docTR expansion
  - deterministic split with `manual_validation_holdout=true` on 5 `test` items
  - one-shot import-and-train endpoint that starts the existing training lifecycle
  - finalize endpoint for completed local-folder jobs: register model version when evidence allows it and run inference over the 5 held-out manual-validation images
- Guardrails:
  - LLM may explain the plan but backend validation owns file pairing, split, and training launch
  - no new system role; `owner` remains a resource relationship
  - no duplicate routes for dataset/training/inference
  - real/fallback/template execution evidence must remain visible
- Verification:
  - add a smoke fixture for YOLO-style folder scan/import/train launch
  - run `npm run typecheck`, `npm run lint`, `npm run build`, and the new smoke command

### P0: Agent-first training-domain hardening
- Goal: make `VisionTask` the default control surface for goal-driven training work.
- Key deliverables:
  - redesign `/vision/tasks` around blocked / training / next action
  - keep training launch attached to task context by default
  - define `TrainingRecipe & Parameter Contract` before expanding training controls:
    - default recipe per `task_type + framework`
    - overrideable params with type, range, unit, default, UI control, backend validation, and runner mapping
    - recipe id/version persisted into `VisionTask.training_plan` and `TrainingJob.config`
    - annotation coverage and train/val/test split quality
    - class balance / long-tail warnings for detection, segmentation, classification
    - OCR charset coverage and text-label completeness for OCR
    - runtime dependency readiness, GPU/CPU/device availability, worker eligibility, and fallback policy
    - artifact evidence expectations for registration handoff
  - define `AgentDecisionLog` planning and contract direction before implementation
- Acceptance:
  - a new engineer can tell the system is organized around goals/tasks rather than orphaned jobs
  - next-step guidance stays explicit across chat, task detail, and training detail
  - every agent-created training plan can explain its recipe, defaults, allowed overrides, and readiness blockers
  - training launch can show one consolidated real-readiness result instead of scattered partial checks
- Risks:
  - over-automation without preserving confirmation boundaries
  - legacy job-first surfaces staying too prominent
  - exposing more params than the backend/runner actually validates or uses
  - blocking useful local experimentation with a readiness gate that is too rigid

### P1: Evaluation, comparison, and gate primitives
- Goal: give the platform enough structure to compare runs and justify promotion decisions.
- Key deliverables:
  - plan benchmark/evaluation suite objects
  - define comparison and gate semantics in roadmap/contracts
  - define `EvaluationSuite / PromotionGate Implementation Contract`:
    - OCR primary metrics: CER/WER/accuracy with threshold source and charset/text-coverage context
    - detection primary metrics: mAP/precision/recall with per-class regression visibility
    - segmentation primary metrics: mIoU/mAP-style quality summary with mask/polygon coverage context
    - champion/challenger comparison rules across linked `VisionTask` rounds
    - promotion outcomes: promote, needs review, train again, collect data, observe, or fail
    - failed-gate agent recommendation logic that chooses between parameter retry, data collection, annotation cleanup, runtime fix, or stop
  - prepare champion/challenger and regression UX direction
- Acceptance:
  - the plan clearly explains how the system decides “register now”, “train again”, or “collect more data”
  - evaluation is no longer represented only as raw training metrics
  - each supported training task has a named primary metric, threshold source, comparison basis, and failure recommendation path
  - task detail and training detail can show the same gate interpretation without duplicating logic
- Risks:
  - adding dashboard surface area without decision value
  - drifting back into traditional MLOps sprawl
  - thresholds becoming arbitrary if not tied to dataset/task context and historical champion evidence

### P2: Data diagnostics and evidence continuity
- Goal: improve data intelligence while keeping execution evidence trustworthy.
- Key deliverables:
  - expand data diagnostics and active-learning planning
  - keep cockpit positioned as evidence, not entry
  - implement smooth-interaction acceptance across high-frequency routes:
    - no polling-induced layout jumps
    - preserved active input/filter/selection state
    - compact action cards shared by chat, task detail, and training detail
    - consistent pass/warn/block readiness and gate badges
    - one primary recovery action for blocked/failed states
  - complete at least one authenticated remote/nightly proof run
- Acceptance:
  - roadmap clearly links data health, feedback mining, and next-round recommendations
  - real-execution and remote-proof tracks remain active priorities
  - the main training loop can be navigated without losing dataset/version/task/job context
- Risks:
  - product planning racing ahead of verification discipline
  - evidence work becoming secondary while UX work accelerates
  - visual polish masking weak evidence if fallback/template markers are not kept explicit

### P3: Full Pixel Workshop Skin Rollout
- Goal: make every shared workspace route feel like part of the same model-training house while keeping each page's canonical job intact.
- Key deliverables:
  - current visual rebuild slice:
    - active continuation slice (2026-04-30): compose `/workspace/pixel-lab` from `public/assets/vistral-workshop/generated/sliced-clean/` as the primary asset pack. Room modules, characters, building parts, furniture/equipment, and HUD panels should be wired through the typed asset catalog before CSS fallback art is used. The central House must visibly use generated assets rather than mostly improvised CSS construction, while preserving all existing room focus, drawer, navigation, and assistant interactions.
    - restore the prototype hierarchy from `src-img/方案效果总览.png` instead of inventing a new composition: top HUD, left overview/core-room/role legend, central 3x3 House, right OpenClaw chat/member rail, lower model/timeline/resource/work-note panels, and bottom room navigation
    - use `src-img/新工作台.png` only for bright palette/materials, not for layout replacement
    - make every visible Pixel Lab control either focus a room, open a real drawer, navigate to an existing canonical route, or be removed; no disabled fake inputs, duplicate cards, or non-product design prompts
    - left rail must expose all nine rooms and role-state context, not only the first few rooms
    - add a replaceable full-House frame asset and wire it into the central canvas so the page no longer depends only on improvised CSS roof/wall construction
    - use generated character assets for model-role states where available, with CSS fallback only when the asset is missing
    - centralize generated pixel asset paths in a typed frontend catalog before wiring more images into components
    - rebuild `/workspace/pixel-lab` central workflow from "independent room cards inside a frame" toward one continuous nine-room bright pixel-house cutaway
    - reduce card chrome inside the house, keep room click targets, status badges, and details as lightweight HUD overlays
    - keep existing routes/API state unchanged while making the central House match the original overview structure
    - screenshot-check the result after implementation and tune only visible issues found in the rendered page
  - contract correction for Pixel Lab back to the nine-room product desktop while preserving the newer bright daytime palette/material direction
  - completion slice for the bright workshop conversion:
    - add a smoke guard that prevents Pixel Lab from drifting away from the nine-room House or back to dark-night palette tokens
    - make the nine central rooms visually distinct through reusable room/device semantics rather than page-local static illustration
    - tune Chinese label width, button sizing, and room content density so text sits harmoniously inside pixel panels
    - run an in-browser visual calibration pass on `/workspace/pixel-lab`, then tune only the visible issues found in the screenshot/DOM rather than guessing from CSS alone
    - keep visible Pixel Lab copy product-facing only: do not show internal design rationale such as “bright pixel workshop” or other implementation commentary in the UI
    - make the persistent OpenClaw assistant behave like a compact social-chat window, with chronological chat bubbles and quick replies instead of stacked explanatory cards
    - stabilize the bottom room navigation against Pixel Lab and chat route scrollports: no page-edge white strip, no important room content hidden behind the fixed room bar, and mobile room navigation scrolls horizontally instead of wrapping into a second sidebar
    - current layout repair (2026-04-30): make the Pixel Lab center read as one coherent 3x3 cutaway House. Decorative roof/facade/building assets must frame the house rather than overlap room interiors; every core room remains one grid cell inside the shared house shell.
    - current professional-page repair (2026-04-30): high-frequency routes such as `/inference/validate` must keep their canonical `WorkspacePage` content fully visible inside the pixel shell. The bright sky/ground skin may decorate the outer background, but it must not clip, cover, horizontally offset, or hide the workbench, context bar, upload controls, validation result, or inspector panels.
  - shared route-aware pixel skin in `WorkspacePage`
  - authenticated AppShell pixel HUD with bottom room navigation and no visible duplicate left sidebar
  - right OpenClaw assistant dock enabled in the authenticated GameShell so every professional route can use route/query context without leaving the room
  - route work surfaces should progressively read as "inside this room" rather than traditional admin pages wrapped in a theme
  - compact room-context strip that keeps route purpose and canonical links visible without replacing the primary workflow
  - pixel-workshop treatment for `PageHeader`, shared cards, workbench panels, tables, forms, unified state feedback, and primary buttons
  - specialist-route alignment for chat, annotation full-screen mode, training cockpit, training workshop, settings, and governance surfaces
  - asset pack under `public/assets/vistral-workshop/` with supplied PNG references plus generated room fallbacks as needed
  - page-by-page pass for outliers that bypass shared primitives, especially chat, annotation full-screen mode, cockpit, admin reports, and settings
- Acceptance:
  - `/workspace/pixel-lab` renders one coherent nine-room House: reception, dataset, annotation, recipe, training, exam, publish, runtime, and bug/feedback repair
  - the primary mood is bright daytime blue-sky/warm-wood/red-roof pixel workshop, not dark blue-black cyber command center
  - opening high-frequency routes shows the same pixel-workshop atmosphere without hiding the primary action
  - no route loses stepper, attachment visibility/delete/status, advanced-collapse, or explicit confirmation behavior
  - missing assets are either generated into the asset pack or covered by CSS fallback visuals
  - `npm run typecheck`, `npm run lint`, and `npm run build` pass after each rollout slice
- Risks:
  - visual density can harm operational scan speed if all panels become equally loud
  - generated imagery can drift from the reference style if prompts are not constrained
  - global CSS overrides can accidentally affect cockpit/annotation surfaces that already have specialized layout rules

## Execution Rules
- Contracts before implementation: update `docs/prd.md`, `docs/ia.md`, `docs/flows.md`, `docs/data-model.md`, and `docs/api-contract.md` before behavior drifts.
- Shared-layer-first: reuse common interaction patterns and avoid page-specific mini-systems.
- Agent development discipline: follow `docs/agent-development-guidelines.md` for assumption surfacing, surgical changes, simplicity, and verifiable success criteria before non-trivial work.
- Keep the AI-native rules intact: visible/deletable/status-aware attachments, consistent state feedback, stepper for multi-step flows, advanced controls collapsed by default.
- `docs/work-handoff.md` is append-only and mandatory whenever active work is interrupted.

## Historical Note
- Older detailed plan files and round-by-round logs have been intentionally removed from the active plan surface.
- If older execution detail is needed, use:
  - git history for deleted `PLAN*.md` content
  - `docs/work-handoff.md` for interruption continuity
  - primary contracts in `docs/` for current truth

### Asset Pack Generation Slice - Pixel Training Platform
- First generate a master isolated asset sheet before rebuilding `/workspace/pixel-lab` into a true pixel-game scene.
- Use `src-img/新工作台.png` for palette/material/light and `src-img/方案效果总览.png` for content groups.
- Required asset groups: buildings, room modules, furniture/equipment, characters, UI elements.
- Store generation scope and slicing plan in `public/assets/vistral-workshop/generated/asset-pack-plan.md`.
- Do not generate full scenes for this slice; generate isolated PNG assets suitable for slicing and reuse.

### Pixel Lab Prototype Alignment Slice
- Priority: align `/workspace/pixel-lab` first with `src-img/方案效果总览.png` before broadening route polish.
- This slice should correct layout hierarchy rather than inventing new UI:
  - central House must start near the top of the main canvas and dominate the viewport
  - remove oversized standalone hero spacing that pushes the House down
  - keep nine rooms inside one House surface
  - restore prototype-like lower panels for model role dynamics, work timeline, resource monitoring, and work notes
  - keep the right rail as OpenClaw assistant plus task/member/status panels
  - keep all visible controls functional: room focus, drawer, route navigation, or chat handoff
- Visual style still follows the bright warm workshop direction from `src-img/新工作台.png`; structure follows `src-img/方案效果总览.png`.

### Pixel Lab Prototype Top Scene Slice
- Continue the prototype match by replacing the standalone title bar feel with a top scene strip like `src-img/方案效果总览.png`:
  - sky/platform band directly above the House
  - OpenClaw speech/callout bubble with live training/exam counts
  - small workshop tower/ground props at both sides
  - compact HUD chips for time/service/version
  - no non-product design commentary in visible copy
- Acceptance: the central stack should read as one continuous pixel workbench scene: top sky callout, main nine-room House, lower status panels.

### Active Slice: Regenerate unified 3x3 House room backgrounds
- Goal: replace the old isolated `room-modules` art with nine same-spec room-cell backgrounds that fit the single Pixel Lab House grid.
- Reason: the existing sliced room assets were generated as independent room cards with inconsistent dimensions and edge clipping, so they fight the shared house walls and make the central workshop look disjointed.
- Scope:
  - create `public/assets/vistral-workshop/generated/house-room-backgrounds/` with one PNG per room plus an atlas preview and manifest
  - keep visual palette aligned to `src-img/新工作台.png`: bright sky-era workshop, red roof context, warm wood beams, light beige plaster, readable interior lighting
  - keep content semantics aligned to `src-img/方案效果总览.png`: reception, datasets, annotation, recipes, training, exam, publish, runtime, bugs
  - wire backgrounds through `src/features/pixelWorkshopAssets.ts` instead of page-local paths
  - render the background as the full room cell layer, while keeping current foreground furniture, characters, badges, focus, drawer, and route navigation behavior
- Non-goals:
  - do not replace the whole page layout again
  - do not introduce duplicate routes or fake controls
  - do not bake readable text into room art
- Verification:
  - regenerate manifest and ensure all nine PNGs have identical dimensions
  - run `npm run smoke:pixel-workshop-skin`
  - run `npm run typecheck`, `npm run lint`, and `npm run build`
  - screenshot-check `/workspace/pixel-lab` and tune obvious visual issues

### Active Slice: Pixel Lab foreground declutter for generated room backgrounds
- Goal: after switching to unified `house-room-backgrounds`, calibrate foreground layers so the central House reads as rooms inside one building instead of duplicate background + duplicate furniture stacks.
- Scope:
  - keep generated room backgrounds as the primary room semantics
  - hide old furniture, extra device, and lamp overlays inside the core 3x3 House only
  - keep model/persona characters, active-room glow, metric strip, badges, focus/detail actions, drawer behavior, and canonical route links
  - screenshot-check `/workspace/pixel-lab` after tuning
- Verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run smoke:pixel-workshop-skin`
  - `npm run build`
