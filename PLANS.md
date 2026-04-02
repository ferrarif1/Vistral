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

Acceptance:
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
- YOLO inference adapter now supports optional external runtime bridge via `YOLO_RUNTIME_ENDPOINT` with automatic mock fallback.

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
