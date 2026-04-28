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

## Current Priority Queue

### P0: Agent-first training-domain hardening
- Goal: make `VisionTask` the default control surface for goal-driven training work.
- Key deliverables:
  - redesign `/vision/tasks` around blocked / training / next action
  - keep training launch attached to task context by default
  - define `TrainingRecipe & Parameter Contract` before expanding training controls:
    - default recipe per `task_type + framework`
    - overrideable params with type, range, unit, default, UI control, backend validation, and runner mapping
    - recipe id/version persisted into `VisionTask.training_plan` and `TrainingJob.config`
    - normal launcher stays agent-first while expert controls remain collapsed and operator-editable
  - define `Real Training Readiness Gate` before broader real-run rollout:
    - dataset size and ready visual sample count
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
