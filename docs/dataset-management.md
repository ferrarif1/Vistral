# Dataset Management

## 1. Purpose
Define dataset lifecycle, ingestion, split/versioning, and import/export contracts required for in-platform training workflows.

## 2. Core Capabilities

### 2.1 Dataset creation and metadata
- create dataset with `name`, `description`, `task_type`
- manage label classes/category taxonomy
- ownership is resource-based (`owner_user_id`), not system role

### 2.2 File ingestion
- upload images/video/archives
- upload list must remain visible, deletable, and status-aware (`uploading`, `processing`, `ready`, `error`)
- asynchronous extraction/validation for archives

### 2.3 Sample explorer
- sample list with filters by split/status/tag
- item detail with source metadata and annotation summary

### 2.4 Split and version
- split dataset into `train` / `val` / `test`
- persist split strategy and seed
- create immutable dataset versions

### 2.5 Import formats
Must support import contracts:
- YOLO
- COCO
- LabelMe
- OCR annotation format

### 2.6 Export formats
- reserve export API contracts in this round
- implement at least metadata-ready stubs for phase progression

## 3. Dataset Status
Recommended dataset lifecycle:
- `draft`
- `ready`
- `archived`

Dataset item processing status:
- `uploading`
- `processing`
- `ready`
- `error`

## 4. Data Entities
- `Dataset`
- `DatasetItem`
- `Annotation`
- `AnnotationReview`
- `DatasetVersion`
- `FileAttachment`

## 5. Access Rules
- `user` can manage owned datasets or explicitly authorized datasets.
- `admin` can audit and govern all datasets.
- public registration never grants `admin`.

## 6. UX Baseline
- dataset list and detail pages use shared shell and unified state blocks
- dataset detail uses top stepper for ingestion/split/version flow
- advanced import parameters are collapsed by default

## 7. Phase Alignment
- Phase 1: schema + API stubs + list/detail skeleton
- Phase 2: online annotation integration
- Phase 3+: pre-annotation and quality tooling
