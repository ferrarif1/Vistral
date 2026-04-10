# Training Worker GUI Onboarding Design

## 1. Purpose

Define how training workers become "out-of-the-box" for operators:

- one-click install or one-click start
- guided graphical configuration instead of manual env editing
- safe pairing with Vistral control plane
- built-in validation before a worker is allowed into scheduling

This document describes the target product flow and implementation shape. It is the design source for future worker onboarding work.

## 2. Goals

1. Reduce worker onboarding to a predictable operator flow.
2. Avoid manual editing of multiple shell scripts on worker nodes.
3. Make the most common deployment path Docker-first.
4. Detect integration mistakes early:
   - wrong control-plane URL
   - expired or invalid token
   - worker callback unreachable
   - wrong `WORKER_ENDPOINT` (`127.0.0.1` on remote node)
   - missing runtime dependencies
5. Keep a headless CLI fallback for servers without desktop/browser access.

## 3. Non-Goals

1. Replace existing runtime scheduling/dispatch contracts in this phase.
2. Introduce a full cluster orchestrator.
3. Require Kubernetes before a worker can be used.

## 4. North-Star Experience

### 4.1 Control Plane Side

Inside `Runtime` settings, an administrator should be able to click `Add Worker` and see a guided wizard:

1. choose deployment mode (`Docker Recommended` / `Linux Script`)
2. choose worker role/profile (`YOLO`, `PaddleOCR`, `docTR`, `Mixed`)
3. optionally prefill worker public host / IP / bind port for the target node
4. generate a short-lived pairing token
5. copy one startup command or download a worker bundle
6. watch onboarding status move from:
   - `bootstrap_created`
   - `worker_started`
   - `pairing`
   - `validation_failed` / `awaiting_confirmation`
   - `online`

### 4.2 Worker Side

After one-click startup, the worker should expose a local onboarding UI:

- example: `http://<worker-host>:9090/setup`

The UI should be a simple stepper:

1. `Welcome`
2. `Connect to Vistral`
3. `Detect Resources`
4. `Set Capabilities`
5. `Validate`
6. `Finish`

The operator should not need to manually edit `.env.worker` unless they intentionally switch to advanced mode.

### 4.3 Headless Fallback

When browser access is not convenient, the same flow must still be possible through:

- one bootstrap shell command
- one doctor command
- one run command

The graphical flow is the primary path; shell remains the fallback path.

## 5. Desired User Flow

## 5.1 Primary Flow: Docker + GUI Pairing

Actor: `admin` + `worker operator`

1. admin opens `Runtime > Workers > Add Worker`
2. admin selects worker profile, optional worker public host / IP, optional callback port, and generates a one-time pairing token
3. system shows:
   - Docker command
   - QR code / pairing code
   - expected callback port
   - prebuilt worker-local `/setup` URL when host/port are known
4. operator runs a single Docker command on machine `B/C/D/...`
5. worker container starts in `unpaired` mode and serves local setup UI
6. operator opens worker local UI and pastes pairing code (or scans QR)
7. worker calls control plane to exchange pairing token for onboarding config
8. worker runs local checks:
   - control-plane connectivity
   - callback port readiness
   - repo/runtime presence
   - disk path write access
   - optional GPU/runtime detection
9. operator confirms:
   - worker name
   - concurrency
   - capabilities
   - workspace root
   - optional advanced command overrides
10. worker runs callback validation with control plane
11. control plane marks worker `online`
12. worker enters normal heartbeat + training mode

## 5.2 Secondary Flow: Script + GUI Pairing

1. admin generates pairing token
2. operator runs `bootstrap-worker.sh`
3. bootstrap starts local setup service or prints local setup URL
4. remaining steps are the same as GUI pairing

## 5.3 Emergency Headless Flow

1. operator copies `.env.worker`
2. runs `bootstrap-worker.sh`
3. runs `worker-doctor.sh --heartbeat`
4. runs `run-worker-node.sh`

This path must remain available for SSH-only servers.

## 6. Product Surfaces

## 6.1 Vistral Runtime Settings

Add a dedicated onboarding block in admin runtime settings:

- `Add Worker` primary action
- onboarding stepper drawer/modal
- generated pairing tokens list
- pending worker registrations list
- worker validation report panel
- downloadable Docker / shell templates
- downloadable bootstrap bundle script for operator handoff

This should live alongside the existing worker registry and scheduler observability, not as a separate product area.

## 6.2 Worker Local Setup UI

The worker service should host a lightweight local web UI with:

- calm single-column layout
- top stepper
- basic vs advanced sections
- explicit pass/warn/fail checks
- copyable final config summary

Core cards:

- connection status
- hardware/runtime detection
- callback reachability
- capability selection
- final activation state

## 7. Technical Design

## 7.1 Worker Runtime Shape

Current worker process already has:

- local training API
- heartbeat loop
- env-driven configuration

Target extension:

- same worker service also exposes local setup endpoints and static onboarding UI
- saved onboarding result writes into:
  - `.env.worker` (operator-readable)
  - optional local `worker-config.json` for wizard state/cache

## 7.2 Pairing Model

Recommended model:

1. control plane generates short-lived, single-use bootstrap token
2. worker local UI exchanges token for:
   - control-plane URL
   - worker auth secret
   - optional prebuilt worker endpoint
   - heartbeat defaults
   - capability defaults
3. worker completes validation
4. control plane marks worker as paired and active

Security direction:

- avoid asking the operator to manually paste the long-lived shared token
- bootstrap-created workers now issue and use per-worker dedicated credentials by default
- keep global shared secret only as compatibility fallback for legacy/manual workers

## 7.3 Validation Stages

Validation must happen before worker becomes schedulable:

1. configuration validation
   - required fields present
   - endpoint format valid
2. local environment validation
   - writable run root
   - required binaries
   - runtime profile compatibility
3. control-plane connectivity validation
   - API reachable
   - token exchange success
4. reverse callback validation
   - control plane can reach worker endpoint
5. capability validation
   - declared capabilities align with detected runtimes

The UI should show `pass / warning / fail` for each check.
The UI should also show the latest control-plane onboarding status (`pairing`, `awaiting_confirmation`, `validation_failed`, `online`) so the operator can confirm the worker is truly schedulable.

## 7.4 Endpoint Shape

Current implementation status:
- implemented now:
  - `GET /api/admin/training-workers/bootstrap-sessions`
  - `POST /api/admin/training-workers/bootstrap-sessions`
  - `GET /api/admin/training-workers/bootstrap-sessions/{id}/bundle`
  - `POST /api/admin/training-workers/bootstrap-sessions/{id}/validate-callback`
  - `POST /api/admin/training-workers/{id}/activate`
  - `POST /api/admin/training-workers/{id}/reconfigure-session`
  - `POST /api/runtime/training-workers/bootstrap-sessions/claim`
  - `POST /api/runtime/training-workers/bootstrap-sessions/status`
  - `GET /api/local/setup/state`
  - `POST /api/local/setup/detect`
  - `POST /api/local/setup/pair`
  - `POST /api/local/setup/bootstrap-status`
  - `POST /api/local/setup/validate`
  - `POST /api/local/setup/apply`

### Control Plane

- `POST /api/admin/training-workers/bootstrap-sessions`
  - create bootstrap token + suggested startup templates
- `GET /api/admin/training-workers/bootstrap-sessions`
  - list active bootstrap sessions
- `GET /api/admin/training-workers/bootstrap-sessions/{id}/bundle`
  - download a ready-to-send worker bootstrap shell script
- `POST /api/runtime/training-workers/bootstrap-sessions/claim`
  - worker-local setup service claims bootstrap token and resolves config defaults
- `POST /api/runtime/training-workers/bootstrap-sessions/status`
  - worker-local setup service reads the latest control-plane onboarding status for the pairing token
- `POST /api/admin/training-workers/bootstrap-sessions/{id}/validate-callback`
  - control plane verifies worker endpoint reachability + compatibility signals from health payload
- `POST /api/admin/training-workers/{id}/activate`
  - final worker activation after validation
  - hard compatibility mismatch keeps worker/session in non-online state
- `POST /api/admin/training-workers/{id}/reconfigure-session`
  - create a new bootstrap session from an existing worker for upgrade/reconfigure

Compatibility snapshot notes:
- bootstrap-session responses now include `compatibility`:
  - `status`: `compatible | warning | incompatible | unknown`
  - `expected_runtime_profile` vs `reported_runtime_profile`
  - `reported_worker_version`, `reported_contract_version`
  - `missing_capabilities`
- onboarding UI should always display this snapshot so operators can decide whether they must upgrade/reconfigure before scheduling.

### Worker Local Service

- `GET /api/local/setup/state`
- `POST /api/local/setup/detect`
- `POST /api/local/setup/pair`
- `POST /api/local/setup/bootstrap-status`
- `POST /api/local/setup/validate`
- `POST /api/local/setup/apply`

## 8. UX Rules

1. Docker-first by default.
2. Advanced settings collapsed by default.
3. Every setup flow must have a top stepper.
4. Every failed validation must include a concrete operator action.
5. Localhost misconfiguration must be surfaced clearly.
6. Worker must never appear `online` until validation passes.

## 9. Error and Recovery Design

Common failure cases:

1. control plane URL unreachable
2. token expired
3. worker endpoint not reachable from control plane
4. worker host port conflict
5. missing runtime dependency
6. invalid capability declaration

Recovery pattern:

- UI keeps the operator on the same step
- failed check explains the exact field or command to fix
- retry is explicit and local
- no partial scheduling enablement before final success

## 10. Implementation Phases

### Phase A: Foundation

1. Dockerized worker image
2. worker-local setup UI shell
3. local setup endpoints
4. config write/apply loop
5. `doctor` results surfaced in UI

Current status:

- foundation is now partially implemented:
  - worker local setup UI shell (`/setup`)
  - local setup endpoints (`state` / `detect` / `validate` / `apply`)
  - Docker worker image + compose example
  - config-save + auto-heartbeat-start behavior under `run-worker-node.sh`

### Phase B: Control Plane Pairing

1. runtime-settings `Add Worker` wizard
2. bootstrap token flow
3. pending worker onboarding list
4. callback validation endpoint

### Phase C: Hardening

1. dedicated per-worker credentials as default, with shared-token fallback kept only for legacy/manual workers
2. downloadable worker bundle / QR code
3. upgrade/reconfigure flow
4. version compatibility checks

Current status:
- item 1 implemented
- item 3 implemented (admin runtime can generate reconfigure bootstrap session for existing worker)
- item 4 partially implemented (health payload compatibility snapshot + hard profile mismatch guard)

## 11. Definition of Done

The worker onboarding experience is complete when:

1. a new operator can add a worker without manually editing multiple files
2. the default path is one startup command plus a local browser wizard
3. Vistral admin can observe onboarding state from runtime settings
4. worker only becomes schedulable after validation passes
5. SSH-only environments still have a clear fallback path
