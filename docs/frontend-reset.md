# Frontend Reset Contract

## 1. Decision

Vistral's authenticated product UI is being reset around one new experience:

**Agent Training Studio**: an agent-native, evidence-first workbench for visual model training, validation, promotion, deployment, and feedback loops.

This replaces the previous mix of traditional console pages, Pixel Workshop skinning, and page-by-page decorative wrappers as the target frontend direction.

## 2. Product Goals

- Orchestration architecture (agent vs execution vs audit): `docs/agent-training-orchestration.md`.
- Make the agent workflow obvious: objective, current stage, evidence, recommended action, and confirmation boundary are always visible.
- Keep canonical business workflows intact: dataset import/versioning, annotation, training, inference validation, model registration, runtime, workers, and audit still use the existing API and permission model.
- Reduce dashboard sprawl: one primary operator job per screen; related domains appear as evidence or links, not embedded full workflows.
- Preserve AI-native hard requirements:
  - attachments are visible, deletable, and status-aware
  - multi-step workflows have a top stepper with current step, total steps, and completion hints
  - advanced parameters are collapsed by default
  - empty, loading, error, and success states use one shared semantic language
  - high-risk mutations remain explicitly confirmed

## 3. Deprecated Frontend Direction

The following are no longer the target experience:

- Page-specific dashboard layouts that rely on large stacked cards.
- The Pixel Workshop skin as a global authenticated product shell.
- Pixel Lab as a separate primary mode competing with the professional workflow.
- Route-by-route visual decoration that changes the skin without changing the workflow structure.
- Any visible implementation/design commentary in product UI.

Existing pages may remain temporarily as implementation fallbacks during migration, but new work should not extend their visual language.

## 4. New Information Architecture

The authenticated app shell becomes a three-zone Agent Studio:

1. **Mission Bar**
   - current user and role
   - active objective
   - runtime/worker/readiness status
   - global search/context chips when scoped ids are present

2. **Agent Flow Rail**
   - goal
   - data
   - annotation
   - recipe
   - training
   - validation
   - promotion
   - deployment
   - feedback

3. **Workbench**
   - one central task surface
   - top stepper for the active flow
   - evidence board
   - primary action
   - secondary repair/diagnostic actions
   - OpenClaw panel as contextual assistant, not a competing chat app

An optional **Evidence Dock** may appear below or beside the workbench for attachments, artifacts, logs, metrics, and reports when the route needs it.

## 5. Route Migration

### Phase 1: Shell and Console
- `/workspace/console` becomes the new Agent Training Studio home.
- `/workspace/pixel-lab` is no longer the target primary experience. It may redirect or be demoted to a lab-only route after the new Studio is stable.
- Existing canonical routes remain available from the Studio as workflow deep links.

### Phase 2: Core Workflows
- `/vision/tasks`
- `/datasets`
- `/datasets/:datasetId`
- `/datasets/:datasetId/annotate`
- `/training/jobs/new`
- `/training/jobs/:jobId`
- `/inference/validate`
- `/models/versions`

Each route should migrate to the Agent Studio shell contract before adding new visual features.

### Phase 3: Governance and Runtime
- `/settings/runtime`
- `/settings/workers`
- `/admin/models/pending`
- `/admin/audit`
- `/admin/verification-reports`

Admin/runtime pages stay dense and operational, but use the same state, stepper, action, and evidence language.

## 6. Studio Home Requirements

The first screen after login must be a usable workbench, not a landing page.

It must show:

- one recommended next action
- the current agent stage
- top stepper for the training loop
- live counts for datasets, jobs, model versions, inference runs, and pending governance items
- runtime/worker readiness summary when available
- evidence cards tied to real records
- visible paths to chat, dataset import, training launch, validation, model versions, runtime, and workers
- loading, error, and auth-required states via shared state blocks

## 7. Visual System

- Calm professional workbench, not game UI.
- Dense but readable operator layout.
- Neutral canvas, restrained borders, one primary blue, semantic success/warn/danger accents.
- Cards are for repeated records, modals, and framed tools only.
- Avoid nested cards, decorative orbs, large hero marketing sections, and one-note dark/purple palettes.
- Typography is compact and stable; text must not overlap or resize layout unpredictably.

## 8. Implementation Rules

- Update contracts before implementing changed behavior.
- Prefer shared layout primitives over page-local CSS.
- Keep old pages as fallback only when migration is incomplete.
- Do not add backend state solely for the new frontend unless `docs/data-model.md` and `docs/api-contract.md` are updated first.
- Treat browser screenshots/DOM probes as required evidence for major shell changes.

## 9. Acceptance Criteria

Phase 1 is acceptable when:

- `/workspace/console` renders the new Agent Training Studio home.
- The old Pixel Workshop global shell is not the primary authenticated visual language.
- The Studio home uses a top stepper and one primary next action.
- The Studio home derives visible counts/evidence from real API records.
- The Studio home keeps OpenClaw/contextual chat available without hiding the primary workflow.
- `npm run typecheck`, `npm run lint`, and a targeted frontend smoke pass.
- A browser screenshot/DOM check confirms no major clipping or overflow at desktop viewport.
