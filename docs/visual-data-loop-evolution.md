# Visual Data Loop Evolution (Roboflow-Inspired, Vistral-Native)

## 1. Context and Goal
Vistral should absorb high-value mechanisms from mature visual-data products (for example Roboflow) without cloning their page shape.

Target outcome:
- keep Vistral's `chat-first` entry and conversational orchestration
- strengthen professional workspace efficiency for visual dataset/model closure
- improve the loop: upload -> annotate -> review -> version -> train -> validate -> feedback

This document is the execution baseline for subsequent implementation rounds.

## 2. A) Priority Mechanisms to Migrate into Vistral

### P0 (must land first)
1. Dataset sample browser as a working surface, not a static list.
   - image grid/list switch
   - fast filters (search, split, status, queue status, class presence)
   - bulk select + bulk action for item-level operations
2. Single-sample review workbench.
   - one place to inspect image, annotation, review context, metadata, and operation actions
   - optimized for "review and fix" throughput, not plain detail viewing
3. Version-centric workflow visibility.
   - dataset version cards become first-class artifacts
   - training/export/evaluation entries always point to explicit dataset version snapshots
4. Prediction-vs-annotation comparison entry.
   - overlay controls and confidence-focused triage hints
   - easier discovery of miss/false-positive/low-confidence samples

### P1 (high impact after P0)
1. Tag/metadata operationalization.
   - metadata/tag not only displayed, but filterable and batch editable
   - metadata used for triage queues and training scope preparation
2. Queue-oriented review ergonomics.
   - "needs_work / in_review / rejected / approved" queues behave as first-class workflow lanes
   - keyboard shortcuts and queue progression remain stable during background refresh

### P2 (scale-up after core closure)
1. Saved views (filter presets) for repeated triage sessions.
2. Error pattern slices for active-learning style loops.
3. More explicit dataset lineage and compare views across versions.

## 3. B) Vistral-Fit Changes by Layer

## 3.1 Pages to update first
1. `/datasets/:datasetId`
   - add sample browser rail (filter + bulk operations + item cards)
   - strengthen version panel as operational center
2. `/datasets/:datasetId/annotate`
   - shape into sample review workbench (image/annotation/review context/metadata in one screen)
3. `/inference/validate`
   - expose clearer "send back for review" paths with dataset/task guardrails
4. `/training/jobs/new`
   - reinforce selected dataset-version visibility and reproducibility cues

## 3.2 Shared components to introduce/reuse
1. `DatasetItemBrowser` (grid/list, filter chips, batch selection)
2. `SampleReviewWorkbench` (sample + annotation + review metadata panel)
3. `DatasetVersionRail` / `VersionSnapshotCard`
4. `PredictionOverlayControls` (annotation/prediction/confidence visibility toggles)
5. `BulkActionBar` (batch split/status/tag operations)

All must reuse existing primitives (`Card`, `Panel`, `Badge`, `StatusTag`, `Workspace*`, `StateBlock`).

## 3.3 Data object evolution (contract-aligned, incremental)
1. Dataset item metadata conventions:
   - reserve metadata keys for operational filters (`tag:*`, `source`, `scenario`, `difficulty`, etc.)
2. Review context:
   - continue exposing latest review reason/comment at item scope
3. Prediction triage metadata:
   - keep storing traceable links (run id / source attachment / reason) for feedback loops

No hard reset of existing entities; evolve by additive fields and UI semantics.

## 4. C) Phased Implementation Plan

### Phase 1 (MVP structural upgrade)
1. Dataset detail:
   - sample browser filters + grid/list + batch select
   - batch split/status update based on existing item patch endpoint
2. Annotation workspace:
   - tighten review workbench information layout
   - make latest review context and queue progression more discoverable
3. Docs sync:
   - ensure PRD/IA/Flows mention browser/review/version-centered path

Reason:
- highest operator efficiency gain with minimal backend risk
- mostly interaction/layout upgrades over existing APIs

### Phase 2 (version and comparison enhancement)
1. Version panel enhancements:
   - version readiness and downstream action links (train/export/compare)
2. Prediction comparison:
   - overlay toggles, confidence threshold controls, low-confidence triage cards
3. Workflow stitching:
   - clearer handoff from inference feedback back into annotation queues

Reason:
- makes data-version reproducibility and validation loop explicit

### Phase 3 (workflow intelligence)
1. Saved filters/presets
   - first iteration landed: dataset sample browser can save/apply/delete local view presets
2. metadata/tag-driven sampling utilities
3. Error pattern slices for active-learning style loops
   - first iteration landed: dataset detail side rail now exposes quick slices (rejected reason buckets, low-confidence tags, feedback-return samples, unassigned-ready bucket) with one-click focus actions
4. compact cross-version outcome comparison blocks
   - first iteration landed: `DatasetVersionRail` now shows active-vs-previous snapshot deltas (items, coverage, split changes)

Reason:
- improves repeated team operations after core loop is stable

## 5. Guardrails
1. Not a Roboflow clone:
   - preserve Vistral's chat-first product identity and IA
2. Keep one product language:
   - conversation and console share object semantics and status vocabulary
3. Prioritize structure over feature bloat:
   - no large backend rewrites before P0/P1 interaction upgrades are stable
4. Contract-first:
   - when behavior changes, update docs contracts before/with implementation
