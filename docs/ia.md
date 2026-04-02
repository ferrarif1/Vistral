# Information Architecture

## 1. Purpose
This IA defines executable page-level structure for round-1 implementation, centered on AI-native conversation + attachment + workflow state.

## 2. Access and Role Rules
- System roles are only `user` and `admin`.
- `owner` is a resource relationship (for example `models.owner_user_id`), not a system role.
- Public registration creates only `user` accounts.
- `admin` assignment is only via seed/bootstrap or admin-only management endpoints.

## 3. Route Map (Round 1 Executable)

### 3.1 Public/Auth
- `/auth/login`
  - Purpose: login into existing account.
  - Main blocks: credential form, loading/error/success feedback.
- `/auth/register`
  - Purpose: create user account (`role` is server-assigned as `user`).
  - Main blocks: registration form, validation feedback.

### 3.2 Dual Work Entry
- `/`
  - Purpose: dual-entry launcher for two working modes.
  - Main blocks:
    - conversation workspace entry card
    - professional console entry card
    - mode-specific capability summary

### 3.3 User Workspace
- `/workspace/chat`
  - Purpose: AI-native conversation workspace.
  - Main blocks:
    - conversation timeline
    - message input composer
    - persistent attachment panel (visible, deletable, status-aware)
  - Mock round-1 flow: upload attachments -> send message -> receive mock assistant response.
- `/workspace/console`
  - Purpose: professional control-plane console.
  - Main blocks:
    - operational metrics snapshot
    - approval queue summary
    - quick actions to model workflows

### 3.4 Model Domain
- `/models/explore`
  - Purpose: discover available models.
  - Main blocks: searchable model list, status and visibility tags.
- `/models/my-models`
  - Purpose: list user-owned/authorized models.
  - Main blocks: ownership-scoped list, quick status view.
- `/models/create`
  - Purpose: model creation wizard.
  - Main blocks:
    - top stepper (required)
    - Step 1 metadata
    - Step 2 model file upload (visible status + delete)
    - Step 3 parameters (advanced collapsed by default)
    - Step 4 review + submit approval (mock)

### 3.5 Admin Domain (post round-1 focus)
- `/admin/dashboard`
- `/admin/models/pending`
- `/admin/users`
- `/admin/audit`

Admin pages are contract-defined but not fully implemented in round-1 UI scope.

## 4. Navigation Structure

### Primary Navigation (global shell)
- Dual Entry
- Conversation Workspace
- Professional Console
- Models Explore
- My Models
- Create Model
- Auth (login/register) shortcuts for mock mode

### Contextual Navigation
- Conversation: no stepper, timeline-centric interaction.
- Professional console: metric/queue/action blocks for structured operation.
- Model creation: mandatory top stepper with current step + total steps + completion state.

## 5. Page Contracts

### 5.1 Conversation Page Contract
- Attachment list must stay visible in context.
- Every attachment row must support delete.
- Attachment statuses must include at least:
  - `uploading`
  - `processing`
  - `ready`
  - `error`
- State feedback must use unified empty/loading/error/success semantics.

### 5.2 Create Model Page Contract
- Stepper is always visible at top.
- Advanced parameters are collapsed by default.
- Submission path in round-1 is mock, but transitions must be explicit:
  - draft creation
  - file uploaded
  - parameter configured
  - approval request submitted

### 5.3 State Presentation Contract
All primary pages must present consistent state blocks for:
- empty
- loading
- error
- success

## 6. Shared UI Building Blocks
- `AppShell`: global navigation + content frame
- `StateBlock`: unified state feedback
- `AttachmentUploader`: reusable upload/delete/status list
- `StepIndicator`: top workflow indicator
- `AdvancedSection`: progressive disclosure container

## 7. Responsive Baseline
- Mobile: single-column content, stacked navigation actions.
- Tablet/Desktop: shell sidebar + content panel.
- Attachment and stepper information must remain readable on all breakpoints.

## 8. Round-1 Boundary
Round-1 prioritizes mock-closed user flows:
1. attachment + conversation loop
2. model creation + approval submission loop

Real training/approval engines, edge deployment operations, and full admin operations are deferred to later phases.
