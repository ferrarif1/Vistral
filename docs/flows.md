# User Flows

## 1. Overview
This document defines executable flows for Vistral's AI-native conversation entry and professional engineering loop.

## 2. Flow A: Conversation + Attachment Loop (implemented)
Actor: `user`

1. open `/workspace/chat`
2. choose a model from the curated foundation catalog and optionally start a new chat session from sidebar
3. use the lightweight header to switch language; on desktop, open settings or logout from the sidebar footer / compact rail account menu, while compact/mobile layouts may still expose auth entry in the header
4. optionally collapse the desktop sidebar for a wider canvas, or open/close the mobile sidebar drawer from the header
5. click `+` to open the composer attachment tray, then upload or pick attachments for the current draft
6. selected draft attachments appear as chips with status + remove controls beside the composer
7. send message
8. system starts conversation and returns assistant reply (mock or configured LLM)
9. attachment tray collapses after send; sent attachments remain traceable in the corresponding message turn
10. sidebar conversation history can be synced from backend and opened to restore full message timeline
11. user can use desktop right-click or mobile long-press on history item for open/rename/pin/delete quick actions
12. when context menu is open, keyboard shortcuts `O/R/P/D` execute corresponding actions quickly
13. user can drag within pinned group to reorder priority chats
14. user continues messaging with attachments in context

Guest/access branch:
1. unauthenticated user opens a login-required surface
2. system offers login entry only
3. if the user needs a new account, they must ask an administrator to provision it

Operational branch inside the same flow:
1. user asks the assistant to perform a real setup action (for example create dataset / create model draft / create training job)
2. system parses intent and available fields from current turn plus pending conversation action context
3. if critical fields are missing, assistant responds with a compact `requires_input` card that lists missing fields and optional suggestions
4. user provides only the missing details in follow-up turn
5. system calls the corresponding backend API once required inputs are complete
6. assistant returns a `completed` or `failed` action card with created entity summary and next-step guidance

Attachment states:
- `uploading`
- `processing`
- `ready`
- `error`

## 2.1 Flow A1: Shared Navigation Shell (implemented)
Actor: `user` / `admin`

1. open any non-chat route (for example `/workspace/console`, `/datasets`, `/training/jobs`)
2. use the grouped left sidebar to jump between workspaces, build/run flows, governance pages, and the single top-level settings entry
3. desktop left sidebars keep a fixed viewport height, while nav/content blocks scroll internally instead of stretching the page shell
4. optionally collapse lower-priority desktop navigation groups to keep the left panel focused on the current work lane
5. optionally collapse the desktop sidebar into a compact rail when the page needs more horizontal room
6. on mobile, open the navigation drawer from the header and dismiss it by tapping the overlay or close action
7. on desktop, open the shared account menu from the sidebar footer or compact rail avatar to reach settings or logout without leaving the current work lane; compact/mobile layouts may still use the header as fallback
8. continue the current task without losing active route context or footer controls such as language/session status

## 2.2 Flow A2: Settings Surface (implemented)
Actor: `user` / `admin`

1. open `/settings` from the single settings item in the console sidebar
2. land on the default `Account` tab, with the active sub-tab visible inside the page header
3. all authenticated users can change password by entering current password plus a new password
4. administrators can also create accounts from the same `Account` tab and choose the new account role
5. administrators can review the account directory, inspect role/status/last-login fields, and filter the list before acting
6. administrators can reset another user's password directly from the directory
7. disabling an account requires an explicit reason entered inline in the directory before confirmation
8. disabled rows continue to show the stored disable reason for later review, and the same reason is written into audit metadata
9. administrators can reactivate an account directly from the directory; reactivation clears the stored disable reason
10. disabling an account immediately terminates that account's active sessions, so the disabled user must log in again after reactivation
11. safety guards block disabling the current admin session or the last active admin account
12. switch between `Account`, `LLM`, and `Runtime` using internal sub-tabs instead of separate top-level navigation items
13. optionally use `/settings/account`, `/settings/llm`, or `/settings/runtime` deep links to open a specific tab directly

## 3. Flow B: Model Draft -> Approval Submission (implemented)
Actor: `user` with capability

1. open `/models/create`
2. stepper flow: metadata -> model file -> parameters -> review
3. upload model files (visible/deletable/status-aware)
4. advanced parameters collapsed by default
5. submit approval request (mock)

Admin review path:
- `/admin/models/pending` approve/reject
- `/admin/audit` observe audit records

## 4. Flow C: Dataset Management (Phase 1 skeleton, implemented)
Actor: `user`

1. open `/datasets`
2. create dataset with `task_type`
3. open `/datasets/:datasetId`
4. upload dataset files
5. run split operation (`train/val/test`)
6. create dataset version snapshot

## 5. Flow D: Annotation Workflow (Phase 2 minimum, implementing now)
Actor: `user` (annotator), `user/admin` (reviewer by capability)

Status machine:
- `unannotated -> in_progress -> annotated -> in_review -> approved`
- rejection: `in_review -> rejected -> in_progress`

Minimum actions:
- detection box annotation (draw/move/resize)
- OCR text annotation
- segmentation polygon input (minimal)
- save, undo, continue edit
- submit to review
- approve/reject with comment

Current phase target:
1. open `/datasets/:datasetId/annotate`
2. select dataset item
3. edit OCR/detection payload
4. save as `in_progress`/`annotated`
5. submit `annotated -> in_review`
6. review as `approved` or `rejected`

## 6. Flow E: Training Job Workflow (Phase 1 skeleton, Phase 3 runtime)
Actor: `user`

1. open `/training/jobs/new`
2. stepper flow:
   - Step 1 task + framework
   - Step 2 dataset + base model
   - Step 3 parameters (advanced collapsed)
   - Step 4 review + submit
3. create training job
4. job transitions through:
   - `draft`
   - `queued`
   - `preparing`
   - `running`
   - `evaluating`
   - `completed` (or `failed` / `cancelled`)
5. view logs and metrics in `/training/jobs/:jobId`

## 7. Flow F: Model Version Registration
Actor: `user`

1. completed training job becomes registerable
2. register model version in `/models/versions`
3. model version is linked to model + dataset + training job + metrics

## 8. Flow G: Inference Validation + Feedback Loop
Actor: `user`

1. open `/inference/validate`
2. run runtime connectivity check (PaddleOCR/docTR/YOLO) and confirm framework status
3. upload inference image
4. select model version
5. run inference
6. inspect visualized predictions + raw output + normalized output
7. if failure sample, click feedback action to send sample to dataset
8. system records `feedback_dataset_id`, ensures a dataset-scoped attachment exists in target dataset, and upserts a traceable dataset item for next-round annotation/training

## 9. Closed Business Loop 1: OCR Fine-tune
1. create OCR dataset
2. annotate/import OCR labels
3. choose `paddleocr` or `doctr`
4. run training
5. evaluate OCR metrics (accuracy/CER/WER)
6. register model version
7. validate inference
8. feedback errors to dataset

## 10. Closed Business Loop 2: Detection Fine-tune
1. create detection dataset
2. annotate/import boxes
3. choose `yolo`
4. run training
5. evaluate detection metrics (mAP/precision/recall)
6. register model version
7. validate inference
8. feedback errors to dataset

## 11. Flow H: Deployment Verification Governance
Actor: `admin`

1. run `docker:verify:full` to generate report files
2. open `/admin/verification-reports`
3. filter by status/base url/date range or search by filename/business user
4. optionally apply quick range preset (last 7 days / last 30 days)
5. apply report ordering (latest/oldest/failed-first; default failed-first)
6. paginate and inspect failed checks in report detail panel
7. export filtered reports as JSON for release evidence
8. decide go/no-go for intranet rollout handoff
9. run `docker:release:bundle` with:
   - optional `VERIFY_REPORT_PATH` to pin report
   - optional `VERIFY_REPORT_MAX_AGE_SECONDS` to enforce report freshness

## 12. Unified UX Constraints
- multi-step flows must have top stepper
- advanced params default to collapsed
- upload files must remain visible + deletable + status-aware
- desktop left sidebars keep fixed viewport height and use internal scrolling
- secondary sidebar blocks should collapse when density becomes distracting
- all pages use consistent empty/loading/error/success state blocks
- style and interaction semantics stay consistent across modules
