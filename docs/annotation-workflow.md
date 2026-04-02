# Annotation Workflow

## 1. Purpose
Define executable annotation workflow contracts for OCR/detection/classification/segmentation tasks with a consistent status machine, review policy, and audit fields.

## 2. Task Types
- `ocr`
- `detection`
- `classification`
- `segmentation`
- `obb` (optional)

## 3. Annotation Status Machine
Required states:
- `unannotated`
- `in_progress`
- `annotated`
- `in_review`
- `approved`
- `rejected`

Allowed transitions:
1. `unannotated -> in_progress`
2. `in_progress -> annotated`
3. `annotated -> in_review`
4. `in_review -> approved`
5. `in_review -> rejected`
6. `rejected -> in_progress`

## 4. Annotation Operations

### 4.1 Creation paths
- manual online annotation
- imported annotation (YOLO/COCO/LabelMe/OCR format)
- model-based pre-annotation

### 4.2 Editable data types
- detection box (draw / move / resize)
- rotated box (OBB)
- polygon/segmentation
- OCR line/word text and confidence corrections

### 4.3 Editing controls (minimum)
- save draft
- undo
- continue edit from previous state
- explicit submit to review
- minimal canvas-style region drawing for detection/OCR region binding

## 5. Review and Audit

### 5.1 Review flow
1. annotator submits `annotated -> in_review`
2. reviewer approves or rejects
3. rejected items must include reject reason and return to `in_progress`

### 5.2 Minimum audit fields
- `annotation_id`
- `dataset_item_id`
- `task_type`
- `source` (`manual` / `import` / `pre_annotation`)
- `annotated_by`
- `reviewed_by` (nullable)
- `status`
- `quality_score` (nullable)
- `review_comment` (nullable)
- `created_at`, `updated_at`, `reviewed_at`

## 6. Pre-Annotation Workflow
1. user selects model version as pre-annotation source
2. system runs batch prediction on selected dataset items
3. predicted results are stored as editable annotation drafts (`source=pre_annotation`)
4. human annotator corrects predictions
5. corrected results enter normal review flow

## 7. Sampling and Quality Policy (baseline)
- review can run full-set or sampled mode
- sampled mode percentage is dataset-version scoped
- rejected reasons are categorized (`box_mismatch`, `label_error`, `text_error`, `missing_object`, `other`)

## 8. Phase Scope
- Phase 2 must ship minimal usable annotation + review loop for OCR and detection.
- Phase 2 implementation baseline includes:
  1. canvas-style box drawing/edit (including move/resize)
  2. OCR line editing with optional region binding
  3. minimal segmentation polygon input
  4. submit-review and approve/reject loop
- segmentation/OBB tooling can start with basic storage/contract support before advanced interaction.
