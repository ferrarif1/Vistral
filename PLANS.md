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
- Evaluation, run comparison, and promotion gates are still weaker than mainstream training platforms.
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
- Plan `AgentDecisionLog` so the system can explain why it recommends a next step and where confirmation is required.

### Track B: Evaluation, Comparison, and Promotion Gates
- Add first-class planning for `EvaluationSuite`, `GateResult`, and `RunComparisonSet`.
- Cover benchmark suites, regression comparisons, champion/challenger semantics, and promotion gates.
- Move the agent from “auto-continue” toward “compare, explain, and recommend”.

### Track C: Data Loop and Active Learning
- Expand `dataset_profile` beyond trainability checks into richer quality diagnostics.
- Add long-tail, duplicate, leakage, OCR charset coverage, and badcase-clustering signals.
- Upgrade feedback datasets from passive badcase sinks into active-learning candidate pools for the next round.

### Track D: Runtime / Worker Reliability
- Continue worker/control-plane hardening: dispatch, failover, readiness, bounded retries, and cross-machine payload delivery.
- Treat this as the execution substrate under the agent, not the primary product story.

### Track E: Training Cockpit and Operator Evidence
- Keep cockpit as an expert evidence surface, not the primary training entry.
- Continue live/demo visualization, telemetry clarity, and tuning/resource evidence where it helps operators inspect runs.

### Track F: Release Governance and Real-Execution Evidence
- Continue strict-real / pure-real / nightly / verify report discipline.
- Keep remote-proof, report retention, and recovery steps easy to rerun.
- Expand acceptance from “run finished” to “agent recommendation is grounded in real evidence”.

## Current Priority Queue

### P0: Agent-first training-domain hardening
- Goal: make `VisionTask` the default control surface for goal-driven training work.
- Key deliverables:
  - redesign `/vision/tasks` around blocked / training / next action
  - keep training launch attached to task context by default
  - define `AgentDecisionLog` planning and contract direction before implementation
- Acceptance:
  - a new engineer can tell the system is organized around goals/tasks rather than orphaned jobs
  - next-step guidance stays explicit across chat, task detail, and training detail
- Risks:
  - over-automation without preserving confirmation boundaries
  - legacy job-first surfaces staying too prominent

### P1: Evaluation, comparison, and gate primitives
- Goal: give the platform enough structure to compare runs and justify promotion decisions.
- Key deliverables:
  - plan benchmark/evaluation suite objects
  - define comparison and gate semantics in roadmap/contracts
  - prepare champion/challenger and regression UX direction
- Acceptance:
  - the plan clearly explains how the system decides “register now”, “train again”, or “collect more data”
  - evaluation is no longer represented only as raw training metrics
- Risks:
  - adding dashboard surface area without decision value
  - drifting back into traditional MLOps sprawl

### P2: Data diagnostics and evidence continuity
- Goal: improve data intelligence while keeping execution evidence trustworthy.
- Key deliverables:
  - expand data diagnostics and active-learning planning
  - keep cockpit positioned as evidence, not entry
  - complete at least one authenticated remote/nightly proof run
- Acceptance:
  - roadmap clearly links data health, feedback mining, and next-round recommendations
  - real-execution and remote-proof tracks remain active priorities
- Risks:
  - product planning racing ahead of verification discipline
  - evidence work becoming secondary while UX work accelerates

## Execution Rules
- Contracts before implementation: update `docs/prd.md`, `docs/ia.md`, `docs/flows.md`, `docs/data-model.md`, and `docs/api-contract.md` before behavior drifts.
- Shared-layer-first: reuse common interaction patterns and avoid page-specific mini-systems.
- Keep the AI-native rules intact: visible/deletable/status-aware attachments, consistent state feedback, stepper for multi-step flows, advanced controls collapsed by default.
- `docs/work-handoff.md` is append-only and mandatory whenever active work is interrupted.

## Historical Note
- Older detailed plan files and round-by-round logs have been intentionally removed from the active plan surface.
- If older execution detail is needed, use:
  - git history for deleted `PLAN*.md` content
  - `docs/work-handoff.md` for interruption continuity
  - primary contracts in `docs/` for current truth
