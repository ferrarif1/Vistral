# Project Plans and Milestones

## Vision
Create an AI-native visual model platform where users interact through natural language and attachments, with a simple two-role system (`user`, `admin`) and ownership-based permissions for model-management actions.

## Role and Permission Baseline
- System roles are only:
  - `user`
  - `admin`
- `model owner` is **not** a system role.
- Ownership is a resource relationship (for example `models.owner_user_id`).
- Capability gates are lightweight and explicit (for example `user.capabilities` includes `manage_models`).
- `admin` governs global operations (approval, audit, user management, system settings, edge deployment).
- `user` manages only self-owned or explicitly authorized models.

## First-Round Code Development Plan (Round 1)
The repository is now documentation-ready and should enter first code implementation in this order:

1. **Project scaffolding**
   - Monorepo/project structure, package scripts, lint/type baseline
   - Environment configuration templates

2. **Authentication foundation**
   - Signup/login/refresh minimal flow
   - Registration defaults to `user`
   - Admin role assignment only via seed/init or admin-only backend path

3. **Frontend shared shell**
   - Global layout shell, navigation frame, state and theme baseline
   - Unified empty/loading/error/success state components

4. **Conversation page skeleton**
   - Basic chat timeline + input region
   - Session-level state persistence hooks

5. **Attachment upload status component**
   - Persistent visibility in context
   - Per-file delete action
   - Status lifecycle: uploading / processing / ready / error

6. **Model CRUD skeleton**
   - Create/list/detail/update minimal endpoints and pages
   - Ownership checks on mutating operations

7. **Initial schema and API stubs**
   - `users(role, capabilities)`
   - `models(owner_user_id, visibility, status, metadata)`
   - API stubs aligned with docs/api-contract.md

## Phase Plan

### Phase 1 (Weeks 1-2): Contract-to-Scaffold
- Deliverables:
  - Project scaffolding
  - Auth foundation
  - Shared UI shell
  - Initial schema/API stubs
- Success metrics:
  - Local dev can boot from clean clone
  - Auth roundtrip works for user signup/login
  - Shared state components used across at least one flow

### Phase 2 (Weeks 3-6): Core User Flows
- Deliverables:
  - Conversation skeleton
  - Attachment upload status component
  - Model CRUD skeleton with ownership checks
  - Basic approval queue entry path
- Success metrics:
  - User can complete conversation + attachment basic loop
  - User can create and manage own model records
  - Non-owner mutation requests are denied

### Phase 3 (Weeks 7-10): Governance and Operations
- Deliverables:
  - Admin approval workflow
  - Audit trail capture
  - Admin user-management hooks
  - Edge deployment operation stubs
- Success metrics:
  - Admin-only routes enforce privilege boundaries
  - Approval and audit records are traceable end-to-end

### Phase 4 (Weeks 11-14): Hardening and Scale
- Deliverables:
  - Performance and reliability hardening
  - Observability and operational dashboards
  - Extended tests and release readiness
- Success metrics:
  - Core SLA targets are measurable
  - Regression risk is controlled with CI checks

## Risk Mitigation
- Keep access model minimal in round 1; avoid speculative RBAC complexity.
- Enforce contract-first updates before code changes.
- Validate ownership/capability boundaries with integration tests early.
- Roll out admin-sensitive endpoints behind explicit checks and audit logs.
