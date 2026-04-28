# Agent Development Guidelines

## 1. Purpose
This document adapts the useful parts of the local `andrej-karpathy-skills-main` reference into Vistral-specific working rules.

Use it when planning, coding, reviewing, or handing off non-trivial Vistral work. It complements `AGENTS.md`; it does not replace the product contracts in `docs/prd.md`, `docs/ia.md`, `docs/flows.md`, `docs/data-model.md`, and `docs/api-contract.md`.

## 2. Core Rules

### 2.1 Think before changing contracts or code
- State assumptions before implementation when the request can be interpreted in more than one way.
- Surface product, backend, frontend, data, and runtime tradeoffs instead of silently choosing one.
- Ask only when the missing answer cannot be discovered from repository context and a wrong assumption would create contract drift.
- For Vistral, ambiguity is especially risky around:
  - `VisionTask` versus direct `TrainingJob` ownership of a workflow.
  - dataset live state versus explicit `DatasetVersion` snapshots.
  - real execution evidence versus fallback/template/simulated output.
  - user/admin role semantics versus resource ownership.

### 2.2 Keep changes simple and local
- Implement the smallest durable change that satisfies the current product contract.
- Do not add speculative frameworks, settings, worker modes, agent actions, or UI states unless the current contract needs them.
- Prefer extending existing shared surfaces before creating a new page-specific pattern.
- Do not add abstractions for single-use behavior unless they remove real duplication or match an established Vistral pattern.

### 2.3 Make surgical edits
- Every changed line should trace to the current request or to verification needed for that request.
- Do not reformat, refactor, rename, or "clean up" adjacent code that is not part of the task.
- Remove only unused imports, variables, files, or docs created by the current change.
- When unrelated dead code or drift is discovered, mention it in the handoff or final notes instead of quietly changing it.

### 2.4 Work from verifiable goals
Before implementation, convert the request into a goal with checks:

```text
Goal: [behavior or document decision that must be true]
Change surface: [contracts / backend / frontend / worker / docs]
Verification: [lint, typecheck, smoke, doc link check, or targeted inspection]
Residual risk: [what remains unproven]
```

For Vistral, weak goals such as "make the agent better" are not enough. Rewrite them into verifiable statements, for example:
- "A `VisionTask` training launch persists `dataset_id`, `dataset_version_id`, `framework`, `base_model`, `config`, and task linkage."
- "Template/fallback training artifacts cannot be registered as real model versions unless the explicit smoke-only override is enabled."
- "The training launcher keeps expert controls collapsed by default while still allowing parameter overrides."

## 3. Vistral-Specific Application

### 3.1 Contract-first implementation
If behavior, schema, flow, or API shape changes, update the contract first:
- Flow changes: `docs/flows.md`
- Data shape/status changes: `docs/data-model.md`
- Endpoint changes: `docs/api-contract.md`
- Requirement or IA changes: `docs/prd.md` and/or `docs/ia.md`
- Active execution priority: `PLANS.md`

Implementation that makes product behavior true before the contract says so is drift, even if the code works.

### 3.2 Agent-native training work
When changing training or orchestration, preserve the default lane:

```text
goal -> dataset snapshot -> agent recommendation -> explicit operator confirmation -> training evidence -> registration/feedback
```

Required checks for this lane:
- New training jobs bind an explicit `DatasetVersion`.
- Launch readiness includes dataset status, train split, and annotation coverage.
- Advanced parameters remain collapsed by default but are still operator-editable.
- Agent recommendations include enough evidence to explain why the next action is train, wait, register, collect data, or stop.
- Mutating agent actions keep explicit confirmation boundaries.
- Real/fallback/template execution evidence stays visible and cannot be silently promoted.

### 3.3 Data and model evidence discipline
Vistral should prefer inspectable evidence over confident narration:
- Dataset diagnostics should explain blockers and recommended data actions.
- Training metrics should come from runner output or persisted job artifacts, not fixed mock constants.
- Cockpit live mode may derive visual summaries, but derived/unavailable values must be labeled.
- Registration gates must inspect execution mode and artifact truthfulness markers.
- Feedback datasets must keep traceability back to inference runs and source attachments.

### 3.4 Parameter and recipe discipline
Training parameters are allowed, but they need explicit shape:
- Keep normal launch flows agent-first and compact.
- Put expert controls behind progressive disclosure.
- For each task/framework recipe, document defaults, allowed overrides, validation ranges, and runner mapping before expanding UI controls.
- Store the submitted config snapshot with the job so runs can be reproduced.
- Avoid adding a UI parameter that the backend or runner ignores.

### 3.5 Review posture
Use a review stance for non-trivial changes:
- Look first for behavioral regressions, missing contract updates, unsafe state transitions, and missing verification.
- Prefer targeted tests or smoke scripts that prove the business loop.
- If full verification is blocked, record exactly what was not run and what risk remains.

## 4. Definition of Done
A Vistral change is ready to hand off when:
- The affected contract documents match the intended behavior.
- The implementation follows the existing shared-layer and UX patterns.
- New or changed state transitions are guarded by backend validation.
- User-facing multi-step flows keep stepper, attachment, state feedback, and advanced-parameter rules.
- The smallest relevant verification command has been run, or the reason it could not run is recorded.
- Remaining risks are stated plainly with the next recommended check.
