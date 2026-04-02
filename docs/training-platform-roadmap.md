# Training Platform Roadmap

## 1. Goal
Build Vistral into an in-platform engineering workflow where users can complete:
1. dataset preparation
2. online annotation and review
3. framework-specific fine-tuning
4. evaluation and model registration
5. inference validation
6. error-sample feedback loop

The current architecture keeps system roles as `user` and `admin` only. Resource ownership (for example dataset/model owner) is represented by relations and capabilities, not role enums.

## 2. Task and Framework Scope

### 2.1 Unified task scope
- `ocr`
- `detection`
- `classification`
- `segmentation`
- `obb` (optional in early phases, reserved in contracts)

### 2.2 Framework responsibilities
- `PaddleOCR`: primary OCR baseline for fine-tuning/evaluation/inference
- `docTR`: alternative OCR implementation with same platform contracts
- `YOLO`: primary detection baseline and extension base for classification/segmentation/OBB

## 3. Platform Module Map (Closed Loop)
The complete engineering loop is composed of these modules:
1. dataset management
2. online annotation
3. annotation import/export
4. pre-annotation
5. annotation review and sampling audit
6. dataset versioning
7. training job orchestration
8. training executor adapters
9. evaluation and metrics
10. model version registry
11. inference validation workspace
12. error sample feedback loop

## 4. Delivery Phases

### Phase 1: Data and Task Skeleton (current implementation target)
Deliverables:
- schema and domain types for Dataset, DatasetItem, Annotation, AnnotationReview, TrainingJob, TrainingMetric, ModelVersion, InferenceRun
- API stubs and mock handlers for dataset/training/model-version/inference domains
- page skeletons:
  - dataset list/detail
  - training job list/detail
  - model versions
  - inference validation
- unified status presentation and shell navigation

Exit criteria:
- build/lint/typecheck pass
- routes and APIs can demonstrate mock OCR + detection paths

### Phase 2: Minimal Online Annotation Loop
Deliverables:
- image-level annotation canvas (minimal)
- box annotation + OCR text annotation
- save/continue edit
- annotation status transitions
- baseline review flow (approve/reject)

Exit criteria:
- annotation status machine usable end-to-end with audit fields

### Phase 3: Model Adapters
Deliverables:
- PaddleOCR trainer/inferencer adapter
- docTR trainer/inferencer adapter
- YOLO trainer/inferencer adapter
- unified adapter registry with normalized output contract

Exit criteria:
- same API shape works across 3 frameworks

### Phase 4: Two Business Loops
Loop A (OCR fine-tune):
- dataset -> annotation/import -> train (PaddleOCR/docTR) -> evaluate -> register model version -> validate inference

Loop B (Defect detection fine-tune):
- dataset -> box annotation/import -> train (YOLO) -> evaluate -> register model version -> validate inference

Exit criteria:
- both loops runnable in platform without external tools

### Phase 5: Enhancements (recorded, may be deferred)
- pre-annotation at scale
- hard-sample feedback and active learning
- collaborative annotation
- richer evaluation visualizations
- queue/worker scaling and distributed training

## 5. Implementation Principles
- Contract first: update `flows`, `data-model`, `api-contract` before implementation drift.
- Shared layer first: use reusable state components, uploader, stepper, advanced-section pattern.
- Multi-step flows require top stepper.
- Advanced parameters are collapsed by default.
- Empty/loading/error/success presentation remains consistent across pages.
- Uploads remain visible, deletable, and status-aware.
- Start with mock closed loops, then replace internals with real executors.

## 6. Round Boundaries
This roadmap document defines sequence and contracts. Actual production training executors, distributed workers, and full model serving are intentionally phased after minimal platform closure is stable.
