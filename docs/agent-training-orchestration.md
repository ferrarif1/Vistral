# Agent Training Orchestration

## 1. Purpose

This document is the **architecture contract** for the model-training agent: how conversational and Studio surfaces align with durable backend objects, where deterministic rules end, and how execution stays auditable. It complements `docs/prd.md` (requirements), `docs/data-model.md` (schemas), `docs/api-contract.md` (HTTP), and `docs/frontend-reset.md` (Studio UX).

## 2. Product Principle

Vistral evolves as an **agent-native visual model platform**, not a dashboard-first MLOps console. The default narrative remains:

`user goal → dataset snapshot → VisionTask as orchestration anchor → recipe-backed plan → training execution → evidence → next recommendation`.

Manual routes (`/training/jobs/new`, datasets, cockpit) are **expert continuations**, not a competing primary workflow.

## 3. System Boundaries

| Layer | Responsibility | Must not |
|------|----------------|----------|
| **Perception** | Read real API state: `VisionModelingTask`, `Dataset`/`DatasetVersion`, `TrainingJob`, workers, runtime readiness, evaluation snapshots | Invent training outcomes or hide attachment state |
| **Policy (agent)** | Choose the next **allowed** action from contracts: `TrainingRecipe`, readiness rules, gate/comparison semantics | Bypass confirmation for high-risk mutations; skip `dataset_version_id` on new jobs |
| **Execution** | Control plane + workers + local runners: dispatch, logs, metrics, artifacts | Be equated with “the agent”; failures here are substrate issues |

The **watchdog / scheduler / worker** stack (`docs/flows.md` Flow I) is execution substrate under the agent, not the user-facing agent story.

## 4. Three-Layer Agent Runtime (logical)

1. **Refresh layer** — On read paths (e.g. `GET /vision/tasks`, task detail refresh), the backend recomputes `agent_next_action`, `evaluation_suite`, `promotion_gate`, `run_comparison`, and related fields from persisted links and job state. This is **deterministic** relative to stored data.
2. **Mutation layer** — User-confirmed or explicitly invoked actions (`POST /training/jobs`, `auto-advance`, `auto-continue`, registration handoffs) append to `agent_decision_log` and update links. Each mutation stays behind the same API guards as manual flows.
3. **Language layer** — Chat / OpenClaw explains plans, surfaces `requires_input`, and proposes confirmations. LLM output is **explanatory**; it does not replace validation or persistence owned by the backend.

## 5. Domain Anchors (canonical objects)

- **`VisionModelingTask`** — Top-level training-domain inbox object; holds `training_plan` (recipe-backed), `agent_next_action`, `agent_decision_log`, gates, and comparisons. See `docs/data-model.md` §4.3A.
- **`TrainingRecipe` + job `config` snapshot** — Every launchable plan names a recipe and persists overrides; see `docs/prd.md` FR-009 and `docs/data-model.md` training job rules.
- **`RealTrainingReadinessReport` (concept)** — One consolidated readiness view before launch; may be mirrored in task metadata or job config as documented in `docs/data-model.md`.

## 6. Agent Training Studio alignment

`/workspace/console` (Agent Training Studio) must:

- Prefer **one primary next action** derived first from **global blockers** (auth, no data, failed/active jobs where applicable), then — when those do not apply — from the **most recently updated** visible `VisionModelingTask.agent_next_action` so the Studio CTA matches backend recommendation.
- Keep **evidence** derived from real API counts and records (`docs/frontend-reset.md` §6).
- Deep-link into existing canonical routes with **preserved query context** (`vision_task`, `dataset`, `dataset_version`, etc.).

## 7. Audit trail: `agent_decision_log`

Each log entry (see `docs/data-model.md`) records at minimum: `action`, `outcome`, `summary`, `reason`, `created_at`.

Optional fields (for richer audits and future analytics; clients must tolerate absence):

- `source_layer` — `deterministic_refresh` \| `auto_advance` \| `user_confirmed` \| `llm_assist` (extensible enum; unknown values should be ignored by UI).
- `evidence_refs` — Short string tokens referencing stable ids or contract keys (e.g. `dataset_version:dv-1`, `training_job:tj-2`) so operators can correlate log lines with rows.

## 8. Change discipline

- Behavior or shape changes: update `docs/data-model.md`, `docs/api-contract.md`, and `docs/flows.md` first, then `docs/prd.md` / `docs/ia.md` when user-visible scope shifts.
- Studio-only presentation that does not invent state: `docs/frontend-reset.md` and this file.

## 9. Related documents

- `PLANS.md` — Track A/B/C execution order
- `docs/agent-development-guidelines.md` — Delivery and evidence discipline
- `docs/training-platform-roadmap.md` — Platform capabilities vs agent scope
