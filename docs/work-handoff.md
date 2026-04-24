# Work Handoff Log

Purpose:
- Record unfinished work before switching to a newly assigned task.
- Keep continuity across conversations without losing execution context.

Rules:
- Append-only; do not overwrite previous entries.
- Keep `next` list ordered by execution priority.
- Keep items concrete and verifiable.

## Entry Template
```markdown
## YYYY-MM-DD HH:mm (timezone)
- context:
- plan_md:
  - ...
- done:
  - ...
- code_changes:
  - ...
- next:
  1. ...
  2. ...
- risks:
  - ...
- verification:
  - ...
- doc_backfill:
  - ...
```

## 2026-04-17 11:39 (CST)
- context: Continue the frontend IA/UX refactor with `TrainingJobsPage` already improved; now收训练详情、模型版本、推理验证三条相关页的首屏噪音，保持“单页单主任务”一致性。
- done:
  - Confirmed `TrainingJobsPage` is already biased toward the active job and its drawer/keyboard navigation is in place.
  - Reviewed `TrainingJobDetailPage`, `ModelVersionsPage`, and `InferenceValidationPage` structure for remaining first-screen clutter.
  - Re-read product/IA/flow contracts to keep the console pages aligned with the single-primary-job rule.
- next:
  1. Trim `TrainingJobDetailPage` so run evidence is the main surface and scheduler/runtime diagnostics move deeper.
  2. Reduce `InferenceValidationPage` first-screen competition between inputs, result, runtime summary, and feedback.
  3. Keep `ModelVersionsPage` comparison/register flow legible without reintroducing duplicate summary blocks.
  4. Re-run typecheck/build after the UI pass.
- risks:
  - These pages already carry a lot of business context; aggressive consolidation could hide important evidence if we over-collapsify.
  - Translation strings are mixed across EN source keys and Chinese UI expectations, so wording changes need to stay consistent with `t()`.
- verification:
  - `npm run typecheck`
  - `npm run build`
  - Browser walkthrough on `/training/jobs/:jobId`, `/models/versions`, and `/inference/validate`

## 2026-04-03 19:00 (Asia/Shanghai)
- context: Continue realification round on existing pages/APIs; interrupted by new conversation requests.
- done:
  - Real file upload metadata + local storage path landed.
  - Real dataset import landed for `yolo`, `coco`, `labelme`, `ocr`.
  - Local single-node training executor replaced mock lifecycle and now writes real logs/metrics/artifacts.
  - Training detail page path already shows runtime logs + metrics + artifact attachment id.
  - Model version registration now binds generated artifact attachment.
  - Runtime inference bridge + fallback source marking already landed.
  - Pre-annotation now runs model prediction and writes `pre_annotation` records.
  - App-state persistence landed with restart resume for non-terminal training jobs.
- next:
  1. Replace YOLO local training simulation with real command runner (subprocess + log/metrics parse) while keeping existing APIs/UI unchanged.
  2. Upgrade PaddleOCR to at least one real path (prefer inference first, then training).
  3. Upgrade docTR to real inference first, keep minimal training adapter.
  4. Keep runtime source labeling explicit (`*_runtime`, `*_local`, `mock_fallback`) and surface in validation summary.
  5. Add smoke cases per framework real path when available.
- risks:
  - Local environment may lack Python/runtime dependencies for YOLO/PaddleOCR/docTR.
  - Framework output schema differences can break normalized mapping if not guarded.
  - Long-running process stability and cancellation behavior need extra tests.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 19:35 (Asia/Shanghai)
- context: Continue realification on existing skeleton without adding duplicate routes/pages.
- done:
  - Added framework local command adapter support in runtime layer:
    - `<FRAMEWORK>_LOCAL_TRAIN_COMMAND`
    - `<FRAMEWORK>_LOCAL_PREDICT_COMMAND`
    - `LOCAL_RUNNER_TIMEOUT_MS`
  - Training lifecycle now supports `local_command` execution mode and prefers command-generated metrics (`metrics.json`) when available.
  - Inference local path now supports command output normalization with source marker `<framework>_local_command`.
  - Added smoke test `npm run smoke:local-command` to verify YOLO local train/predict command path end-to-end.
  - Fixed restart resume smoke timing issue after introducing faster state transitions.
- next:
  1. Wire YOLO adapter to real Python runner templates in repo scripts (instead of inline shell snippets) and parse richer metrics.
  2. Add PaddleOCR real local predict command template and smoke coverage.
  3. Add docTR real local predict command template and smoke coverage.
  4. Expose current execution mode/source in runtime settings summary for easier operator diagnosis.
- risks:
  - Local command templates depend on environment-specific Python/toolchain availability.
  - Non-standard framework outputs may require stricter normalization guards.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:local-command`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 20:10 (Asia/Shanghai)
- context: Continue local-command realification without adding new pages/routes.
- done:
  - Added reusable Python local runner templates:
    - `scripts/local-runners/yolo_train_runner.py`
    - `scripts/local-runners/yolo_predict_runner.py`
    - `scripts/local-runners/paddleocr_predict_runner.py`
    - `scripts/local-runners/doctr_predict_runner.py`
  - Runtime adapter now supports `{{repo_root}}` placeholder so local commands are stable even when working directory is per-job workspace.
  - Extended `smoke:local-command`:
    - YOLO local-command training + metrics ingestion
    - YOLO local-command inference source check
    - PaddleOCR local-command inference source check
    - docTR local-command inference source check
  - Runtime settings page now shows recent inference source distribution and training execution-mode distribution.
- next:
  1. Add real framework invocation branch in runner templates when dependencies are installed (ultralytics / paddleocr / doctr), keep deterministic fallback otherwise.
  2. Add training metric series ingestion (epoch-level) and chart-friendly API payload.
  3. Expose execution mode/source directly in backend response fields (not only inferred by log excerpt).
  4. Add one-click env snippet generator for local command templates in runtime settings page.
- risks:
  - Framework dependencies may not be present in deployment environment, requiring clear fallback markers.
  - Real framework output shapes can drift between versions; normalization layer must stay strict.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:local-command`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 20:50 (Asia/Shanghai)
- context: Continue hardening local-command pipeline on existing APIs/pages.
- done:
  - Added explicit execution fields in domain and runtime records:
    - `training_jobs.execution_mode`
    - `inference_runs.execution_source`
  - Backend now persists/returns these fields directly.
  - Runtime settings summary now reads explicit fields instead of inferring mode only from log excerpts.
  - Added normalization for legacy persisted snapshots so missing fields are backfilled safely.
  - Schema contract updated for `execution_mode` and `execution_source`.
- next:
  1. Add epoch-level metric series persistence and API payload for training charts.
  2. Add dependency-aware branch in local runners (if real framework libs are installed, run real path; else deterministic template fallback).
  3. Add dedicated smoke for explicit execution fields in training/inference responses.
- risks:
  - Legacy snapshots without new fields must continue to load correctly (currently normalized, still needs long-run observation).
  - Schema file updated but no real DB migration path yet (prototype still memory+snapshot oriented).
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:local-command`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 21:10 (Asia/Shanghai)
- context: Continue realification on existing pages/APIs with no duplicate routes; close explicit execution-field validation and training metric series persistence.
- done:
  - Added dedicated smoke check `scripts/smoke-execution-fields.sh` and npm command `smoke:execution-fields`.
  - Verified explicit persistence contract end-to-end:
    - `training_jobs.execution_mode` (`local_command` / `simulated`)
    - `inference_runs.execution_source` and parity with `normalized_output.normalized_output.source`.
  - Upgraded training metric pipeline to support series data:
    - shared train result supports `metric_series`
    - runtime adapter parses both flat metrics JSON and `{summary, metric_series}` JSON
    - training lifecycle stores per-step metric points to `training_metrics`
    - metrics file now keeps `summary + metric_series` when available
  - YOLO local train runner now emits deterministic but epoch-like metric series for `map/precision/recall/loss_*`.
  - Training detail page now shows latest metrics chips plus metric timeline (step-aware), improving observability of non-mock execution.
  - `registerModelVersion` now summarizes metrics using latest step per metric (not overwritten by older step rows).
- next:
  1. Add dependency-aware real-framework branch in local runners (`ultralytics`, `paddleocr`, `doctr`) behind env switch with deterministic fallback.
  2. Add one focused smoke for runner real-branch fallback labeling (`source/meta` visible).
  3. Wire optional metric-series visualization (simple chart) in training detail page without adding new routes.
- risks:
  - Current runner series is deterministic template data; true framework-produced epoch curves still need optional real branch.
  - Training metrics may grow quickly for long jobs; retention window/aggregation policy is not defined yet.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:local-command`
  - `npm run smoke:execution-fields`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 21:45 (Asia/Shanghai)
- context: Continue from execution-field/metric-series hardening; add optional real-runner branches and fallback observability.
- done:
  - Added optional real-framework inference branch in local runners (guarded by `VISTRAL_RUNNER_ENABLE_REAL=1`):
    - `scripts/local-runners/yolo_predict_runner.py`
    - `scripts/local-runners/paddleocr_predict_runner.py`
    - `scripts/local-runners/doctr_predict_runner.py`
  - Real branch now attempts framework inference when dependencies/models are available; otherwise deterministic template fallback is preserved and reason is written into `meta.fallback_reason`.
  - Added fallback regression smoke:
    - `scripts/smoke-runner-real-fallback.sh`
    - npm script `smoke:runner-real-fallback`
  - Added env contract docs for optional real runner branch:
    - `.env.example`
    - `README.md` / `README.zh-CN.md`
    - `docs/setup.md` / `docs/setup.zh-CN.md`
- next:
  1. Add real-branch smoke variant with a true uploaded file path and configured model path (when env has dependencies).
  2. Add lightweight chart rendering for training metric series in `TrainingJobDetailPage` (retain existing route/UI shell).
  3. Add retention policy for high-volume `training_metrics` series rows.
- risks:
  - Real branch depends on runtime environment libraries (`ultralytics`, `paddleocr`, `doctr`) and model artifacts.
  - Current fallback smoke uses seeded attachments; fallback reason is currently `missing_input_path` in that scenario.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:runner-real-fallback`

## 2026-04-24 16:42 (Asia/Shanghai)
- context: Midway through a docs-first/chat-orchestration round to let saved LLM config infer the user's real goal, choose a least-user-operation lane, and continue through a `goal_orchestration` bridge path; interrupted by a new request to build a Training Cockpit / training visualization experience.
- plan_md:
  - `docs/prd.md`
  - `docs/flows.md`
  - `docs/api-contract.md`
  - `docs/data-model.md`
- done:
  - Synced core contracts for LLM goal planning and least-user-operation execution language in EN/ZH docs.
  - Partially implemented backend support in `backend/src/handlers.ts`:
    - saved-LLM goal planner prompt + payload parser
    - `goal_orchestration` bridge path skeleton
    - shared `understandVisionTaskForContext(...)` helper for conversation-driven updates
    - conversation entry now passes effective LLM config into action resolution
  - Preserved prior training-intent vs OCR-extraction fix already verified earlier in the same thread.
- code_changes:
  - `backend/src/handlers.ts`
  - `docs/prd.md`
  - `docs/prd.zh-CN.md`
  - `docs/flows.md`
  - `docs/flows.zh-CN.md`
  - `docs/api-contract.md`
  - `docs/api-contract.zh-CN.md`
  - `docs/data-model.md`
  - `docs/data-model.zh-CN.md`
- next:
  1. Finish `goal_orchestration` backend integration and resolve any type/runtime issues in `backend/src/handlers.ts`.
  2. Add targeted regression smoke with a local mock LLM endpoint for goal planning + task auto-advance.
  3. Decide whether chat UI should relabel `console_api_call(api=goal_orchestration)` as a more user-facing action card title.
  4. Run `npm run typecheck` plus the new/affected conversation smokes.
- risks:
  - The backend work is intentionally incomplete right now; switching tasks without this note would lose where the dynamic missing-field/confirmation logic stopped.
  - The planned smoke needs a local OpenAI-compatible mock endpoint because external LLM calls are not suitable for deterministic verification.
- verification:
  - Not yet re-run after the partial LLM goal-planner code landed.
  - Prior completed check before interruption: `npm run typecheck`, `npm run smoke:conversation-actions`
- doc_backfill:
  - Primary contracts were updated first; any future completion of this feature should reconcile those docs with the final backend behavior before merge.

## 2026-04-23 21:03 (Asia/Shanghai)
- context: Continue the planning/docs completion round for `PLAN_llm.md`, `PLANS.md`, and related contracts; interrupted by a new request to clean invalid/expired Docker content because the local system is lagging.
- plan_md:
  - `PLAN_llm.md`
  - `PLANS.md`
- done:
  - Re-opened the required repository guidance and contract entry points for the docs-first round.
  - Confirmed the current workspace already contains ongoing uncommitted updates across product docs, backend, frontend, and smoke scripts.
  - Identified that the next docs pass should focus on closing gaps between `PLAN_llm.md`, `PLANS.md`, `docs/flows.md`, `docs/api-contract.md`, and `docs/training-engineer-quickstart.md`.
- code_changes:
  - No new code/doc edits landed in this interrupted round before task switching.
- next:
  1. Audit `PLAN_llm.md` against `PLANS.md` and product contracts to find incomplete capability tracks and missing acceptance checks.
  2. Update the planning docs so phases, ownership, verification commands, and rollout order are consistent and directly usable by an engineer.
  3. Backfill `docs/work-handoff.md` again after the next interruption or once the docs round is completed.
- risks:
  - The worktree is already dirty in many files, so the next docs pass must avoid overwriting user or prior in-progress changes.
  - There may already be partial contract updates in `docs/flows.md` and `docs/api-contract.md`; those need careful reconciliation before any new planning language is added.
- verification:
  - `git status --short`
  - Manual cross-check of `PLAN_llm.md`, `PLANS.md`, `docs/flows.md`, `docs/api-contract.md`, and `docs/work-handoff.md`
- doc_backfill:
  - If the next round changes milestones or rollout order materially, sync `PLANS.md` together with the detailed local plan doc.
  - `npm run smoke:local-command`
  - `npm run smoke:execution-fields`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-23 21:17 (CST)
- date_time: 2026-04-23 21:17 (CST)
- context: Finish the docs-first continuation round for `PLAN_llm.md`, `PLANS.md`, and related contracts so the shipped `VisionTask` orchestration and engineer handoff path are discoverable without reading source files first.
- plan_md:
  - `PLAN_llm.md`
  - `PLANS.md`
- done:
  - Updated `README.md` and `README.zh-CN.md` so continuing engineers are directed to `PLANS.md`, `PLAN_llm.md`, and `docs/work-handoff.md` before implementation.
  - Reworked `PLANS.md` from the older phase-only view into current delivery tracks, maturity assessment, and next-step priorities.
  - Synced the primary contracts (`docs/prd.md`, `docs/ia.md`, `docs/flows.md`, `docs/data-model.md`, `docs/api-contract.md`) with the already shipped `VisionTask` list/detail/API flow and chat `Suggested next steps` behavior.
  - Expanded `docs/training-engineer-quickstart.md` so it covers both the assisted lane (`chat -> vision task -> auto advance`) and the direct console lane.
  - Added P7 completion plus the next real backlog (P8-P10) into `PLAN_llm.md`.
- code_changes:
  - Docs-only round; no frontend/backend/runtime implementation changes landed in this pass.
- next:
  1. Add a dedicated `VisionTask` closure smoke or acceptance script covering `understand -> auto-continue/auto-advance -> register-model -> feedback-dataset`.
  2. Run `plan-llm-complete` on a real remote/nightly runner, or document exact runner prerequisites/cache warmup steps if remote infra is still not ready.
  3. Run a manual mobile/narrow-screen and cross-browser UX pass for `/workspace/chat`, the right Dock, `/vision/tasks`, `/vision/tasks/:taskId`, and `/training/jobs/:jobId`.
- risks:
  - The English primary contracts are now synced, but the Chinese mirror contract docs were not fully mirrored in this round (only `README.zh-CN.md` was updated).
  - `VisionTask` is now documented as a primary capability, but it still lacks a dedicated smoke lane; neighboring chat/training checks may not catch every future regression.
  - Remote/nightly `plan-llm-complete` remains unproven outside the local environment.
- verification:
  - `rg -n '/vision/tasks|VisionTask|Suggested next steps|training-engineer-quickstart|PLAN_llm|PLANS.md' README.md README.zh-CN.md PLANS.md PLAN_llm.md docs/prd.md docs/ia.md docs/flows.md docs/data-model.md docs/api-contract.md docs/training-engineer-quickstart.md`
  - `git diff --check -- README.md README.zh-CN.md PLANS.md PLAN_llm.md docs/prd.md docs/ia.md docs/flows.md docs/data-model.md docs/api-contract.md docs/training-engineer-quickstart.md`
- doc_backfill:
  - Future UI/API changes touching `VisionTask` or chat next-step behavior should update the primary contracts first, not only `PLAN_llm.md`.

## 2026-04-03 22:10 (Asia/Shanghai)
- context: Continue realification hardening after execution-field/metric-series rollout.
- done:
  - Added `smoke:runner-real-upload` to validate real uploaded attachment path + YOLO runner fallback reason under real mode.
  - New smoke uploads a real multipart file to conversation attachments, waits for ready lifecycle, runs detection inference, and asserts:
    - `execution_source=yolo_local_command`
    - `raw_output.meta.mode=template`
    - `raw_output.meta.fallback_reason=real_predict_skipped:model_path_not_found`
  - Upgraded `TrainingJobDetailPage` with metric curve visualization (SVG cards) while keeping existing route and page structure.
  - Added chart styling in shared theme for consistent appearance.
  - Synced docs/scripts list in README/setup (EN + ZH).
- next:
  1. Add optional real-branch positive smoke (only when env has model/runtime deps) to verify `meta.mode=real` path.
  2. Add metric retention/aggregation policy to prevent long-job `training_metrics` growth.
  3. Consider adding lightweight download endpoint for training metrics JSON/artifact diagnostics from job detail page.
- risks:
  - Real positive branch still environment-dependent (`ultralytics` and model files for YOLO; PaddleOCR/docTR deps for OCR).
  - Chart currently renders raw values without smoothing/outlier treatment.
- verification:
  - `npm run typecheck`

## 2026-04-17 00:10 (CST)
- context: Continue frontend usability cleanup on settings/training surfaces; user wants the product to feel smooth and low-noise.
- done:
  - Training jobs list page now exposes KPI summary separately and removed duplicate queue stats from filter toolbar.
  - Training job detail page now keeps runtime diagnostics in one secondary panel and reduces repeated metric/status copy.
  - Account settings page moved admin create-account action out of the top header and back into the administrator tools lane.
  - Settings tabs copy now frames runtime templates as reference material instead of equal-tier navigation.
  - Current workspace builds/typecheck/lint are passing and the web container has been rebuilt.
- next:
  1. Continue trimming `RuntimeSettingsPage` first-screen noise so setup/readiness/advanced are clearly separated.
  2. Reduce `LlmSettingsPage` repeated status blocks and keep the linear flow visible.
  3. Review `WorkerSettingsPage` for any remaining duplicated capacity/paired-state summaries.
  4. Rebuild `vistral-web` again after UI edits if browser still shows cached assets.
- risks:
  - `RuntimeSettingsPage` remains the heaviest settings page and still has a lot of advanced content; needs careful simplification to avoid regressing operator workflows.
  - Browser cache can make the old assets appear even after successful rebuilds.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `DOCKER_BUILDKIT=0 docker compose build --no-cache vistral-web`
  - `docker compose up -d vistral-web`

## 2026-04-10 04:20 (Asia/Shanghai)
- context: Runtime 图形化配置进行中；被“直接验证当前是否已真正支持模型训练与验证”这一新任务打断。
- done:
  - 已先补合同文档：
    - `docs/api-contract.md` / `docs/api-contract.zh-CN.md`
    - `docs/data-model.md` / `docs/data-model.zh-CN.md`
    - 新增 `GET/POST/DELETE /settings/runtime` 约定，以及 `RuntimeSettings` 持久化语义
  - 后端已起步接入 runtime 设置持久化骨架：
    - `shared/domain.ts` 增加 runtime settings 类型
    - `backend/src/store.ts` 增加 encrypted runtime settings store 读写基础
    - `backend/src/server.ts` 已挂载 `/api/settings/runtime` 路由入口
    - `backend/src/handlers.ts` 已补 runtime settings 读写/清空 handler 基础
    - `backend/src/runtimeAdapters.ts` 已改为准备走“动态读取 runtime settings + env 兜底”
  - 前端 `RuntimeSettingsPage.tsx` 已开始接入运行时配置表单状态，但尚未收口到可用 UI。
- next:
  1. 收口 `RuntimeSettingsPage.tsx`，补全图形化表单、保存/重载/清空交互，并消除 lint/typecheck 风险。
  2. 跑 `npm run typecheck && npm run lint && npm run build`，确认 runtime 设置这条线不影响主分支可运行性。
  3. 补 runtime settings 最小 smoke（保存/读取/清空后 adapter 生效）。
  4. 若用户继续优先“真实训练闭环”，则在上述可编译前提下继续做 doctor + smoke 闭环验证。

## 2026-04-16 12:10 (CST)
- context: 从注重单页标注工作台的收口，切换到训练页 / 运行时页 / 设置页的单主任务重构，用户要求“继续直到作为使用者工程师觉得很好用很顺手”。
- done:
  - 已确认仓库合同与协作规则，读过 `README.md`、`AGENTS.md`、`.codex/config.toml`、`docs/prd.md`、`docs/ia.md`、`docs/flows.md`、`docs/data-model.md`、`docs/api-contract.md`。
  - 已开始回看 `TrainingJobsPage`、`CreateTrainingJobPage`、`TrainingJobDetailPage`、`RuntimeSettingsPage`、`AnnotationWorkspacePage` 的当前结构。
  - 已确认可复用的共享壳组件：`WorkspacePage`、`WorkspaceWorkbench`、`ConsolePage`、`SettingsTabs`。
- next:
  1. 收束 `TrainingJobsPage`，减少重复摘要噪音并保留队列主任务。
  2. 收束 `CreateTrainingJobPage`，把训练启动流程压成更线性的单主任务页。
  3. 收束 `TrainingJobDetailPage`，把证据与诊断分层，弱化首屏技术噪音。
  4. 收束 `RuntimeSettingsPage`，把 local / readiness / advanced 三层拆清楚并统一中文表达。
  5. 运行 `lint` / `typecheck` / `build` / 关键 smoke，确认重构不回退。
- risks:
  - 运行时设置页和训练详情页都比较密，容易在重构时误删现有保护信息或回退状态提示。
  - 需要保持训练/运行时与后端契约一致，避免只改前端导致配置看起来“变简单”但实际不可用。
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-16 12:35 (Asia/Shanghai)
- context: 标注工作台已按“单样本、画布优先、右侧三标签、底部固定动作条”方向完成一轮重构；被新的 Runtime 设置功能闭环问题打断，需要先切去修复 `/settings/runtime` 中“编辑不可用”的真实交互缺口。
- done:
  - 已完成标注页合同与实现对齐：
    - `docs/prd.md`
    - `docs/ia.md`
    - `docs/flows.md`
    - `docs/annotation-workflow.md`
  - 已完成标注页前端重构：
    - 轻量页头 + 当前样本上下文
    - 画布主区 + 右侧 `标注 / 预测对比 / 样本信息` Tab
    - 底部固定操作条
    - 全屏、快捷键、自动保存后提交复核、未保存切样拦截
    - 预测对比与复核上下文降级
  - 已完成基础验证：
    - `npm run typecheck`
    - `npm run lint`
    - `npm run build`
- next:
  1. 以训练/标注工程师视角继续回归标注页，检查是否还有“看得到但不能操作”的功能断点。
  2. 处理标注页剩余体验债，例如重复动作、分割编辑撤销粒度、状态反馈一致性。
  3. 若下一轮继续做标注完整性测试，补充对应文档记录与验收结论。
- risks:
  - 标注页虽已完成主重构，但仍需一轮真实使用路径回归，避免存在隐藏的交互断点。
  - 当前优先级已切到 Runtime 设置页，标注页剩余问题尚未完全闭环。
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-16 14:25 (Asia/Shanghai)
- context: 用户在 `/settings/runtime` 页面反馈“点了编辑没用，哪里都不能编辑”；本轮转为验证运行时设置页的真实功能闭环，而不是仅做视觉整理。
- done:
  - 已确认问题根因：`RuntimeSettingsPage.tsx` 中保留了 `编辑` 按钮与框架清单，但真正的编辑表单已被重构过程中移除，导致按钮只有筛选/滚动效果，没有可修改字段。
  - 已补回 Runtime 设置高级编辑区，并串起完整闭环：
    - 框架级编辑表单（默认模型、默认版本、endpoint、本地模型路径、本地训练/预测命令）
    - 本地/远端模式切换
    - 框架级 API key 输入、生成、轮换、撤销
    - 模型级 / 版本级 API key 绑定编辑
    - Python 路径、fallback 开关、已保存 key 复用开关
    - 保存、重载、清空、自动匹配 endpoint、刷新检查
  - 已补一轮 Runtime 页面中文词条，减少运行时设置页中英混排。
  - 已完成验证：
    - `npm run lint`
    - `npm run build`
    - `npm run smoke:runtime-settings-persistence`
- next:
  1. 继续以训练工程师视角巡检其它高频页，优先检查“按钮存在但未接真实动作”的断点。
  2. 回看训练任务页、训练详情页、推理验证页的动作闭环与中文一致性。
  3. 若继续做整站真用性回归，按页面记录剩余缺口与验证结果。
- risks:
  - Runtime 设置页已闭环，但全站仍未完成系统性的“真操作可用性”回归。
  - 运行时设置页新增了更多真实编辑能力，后续仍建议补一轮浏览器手测，确认不同模式切换时的文案与视觉节奏。
- verification:
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:runtime-settings-persistence`
  - `npm run smoke:runtime-settings-persistence`
  - `npm run smoke:real-closure`
- risks:
  - 当前工作区存在未收口的 runtime settings 改动，若直接跑 lint/build 可能暴露未使用状态或接口对齐问题。
  - 当前真实训练闭环是否通过，仍取决于本机 Python 依赖、权重文件、local runner、以及 worker/runtime 可达性。
- verification:
  - 建议后续先执行：
    - `npm run typecheck`
    - `npm run lint`
    - `npm run build`
  - 然后执行真实性闭环检查：
    - `npm run doctor:real-training-readiness`
    - `npm run smoke:real-closure`
    - `npm run smoke:ocr-closure`

## 2026-04-04 15:55 (Asia/Shanghai)
- context: Chat-style conversation history refinement was in progress; interrupted to prioritize mainline product closure on dataset -> annotation/review -> training workflow.
- done:
  - Desktop chat history now uses hover-only overflow actions (`rename` / `pin` / `delete`) with row-click open behavior.
  - Context menu interaction was aligned across desktop/mobile entry patterns and synced into IA/Flows docs.
  - Conversation sidebar visual polish landed without changing backend conversation contracts.
- next:
  1. Keep any remaining conversation/sidebar polish as lower priority unless a concrete UX bug is reported.
  2. Prioritize closing Phase 2 annotation/review loop from dataset detail through reviewer/rework flow.
  3. After annotation/review closure, tighten dataset-version selection and launch readiness in training-job creation.
- risks:
  - Conversation sidebar files are currently dirty in the worktree; avoid overwriting those changes while working on mainline flow pages.
  - Mainline workflow docs and implementation may still drift if reject/rework semantics are not made explicit before UI changes.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run lint`
  - `npm run build`

## 2026-04-05 10:20 (Asia/Shanghai)
- context: While tightening Phase 4 closure, the in-progress task "inference feedback must enforce dataset task-type match" was interrupted by a new request to audit historical issues and verify unfinished items.
- done:
  - Re-checked contracts and implementation around inference feedback (`POST /inference/runs/{id}/feedback`).
  - Confirmed current backend lacks task-type guard between inference run and target dataset.
  - Confirmed current inference page allows selecting any dataset without task-type filtering.
- next:
  1. Run a history-to-implementation audit against major previously reported issues (chat/sidebar/settings/auth/upload/training core flows).
  2. Patch unresolved core gaps first, including task-type-safe feedback loop.
  3. Re-run validation (`smoke` subset + `typecheck` + `lint` + `build`) and summarize still-open items.
- risks:
  - Worktree contains many unrelated in-flight edits; patches must avoid accidental regressions.
  - Some historical requests are UX-level and require browser visual verification in addition to static checks.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:runner-real-upload`
  - `npm run smoke:local-command`
  - `npm run smoke:execution-fields`
  - `npm run smoke:runner-real-fallback`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 22:35 (Asia/Shanghai)
- context: Continue realification with positive real-branch verification and metric retention hardening.
- done:
  - Added optional positive smoke for real YOLO branch:
    - `scripts/smoke-runner-real-positive.sh`
    - npm script `smoke:runner-real-positive`
    - behavior: auto-skip when model path or `ultralytics` dependency is unavailable.
  - Added real-upload smoke (already landed in prior step) and kept pass baseline.
  - Added training metric retention controls in backend lifecycle:
    - `TRAINING_METRICS_MAX_POINTS_PER_JOB` (downsample per-job series points)
    - `TRAINING_METRICS_MAX_TOTAL_ROWS` (global metrics rows cap)
    - downsample + trim logs are written into training logs for observability.
  - Updated env/docs for new controls and smoke commands.
  - Added i18n entries for metric curve labels in Chinese default UI.
- next:
  1. If real YOLO model is available, run: `REAL_YOLO_MODEL_PATH=/abs/path/to/model.pt npm run smoke:runner-real-positive` and capture result as verification artifact.
  2. Consider exposing metric retention counters in runtime settings summary for operators.
  3. Optionally add downloadable training metrics JSON endpoint from training detail flow.
- risks:
  - Positive real-branch smoke currently depends on local model file and Python dependencies, so CI/local behavior can differ.
  - Downsampling preserves trend but not every raw point; deep debugging may still require direct framework logs.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:runner-real-positive` (SKIP expected without model/deps)
  - `npm run smoke:runner-real-upload`
  - `npm run smoke:runner-real-fallback`
  - `npm run smoke:local-command`
  - `npm run smoke:execution-fields`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 23:05 (Asia/Shanghai)
- context: Continue runtime observability hardening without adding new pages/routes.
- done:
  - Added backend endpoint `GET /api/runtime/metrics-retention` for visible-scope training metric retention summary.
  - Runtime settings page now shows metric retention panel (current rows, caps, jobs with metrics, visible jobs, top job rows, near-cap warning).
  - Added training metrics retention policy in lifecycle:
    - per-job point cap (`TRAINING_METRICS_MAX_POINTS_PER_JOB`)
    - global row cap (`TRAINING_METRICS_MAX_TOTAL_ROWS`)
    - downsample/trim logs are appended into training logs.
  - Added smoke `smoke:runtime-metrics-retention` to verify:
    - retention endpoint contract values
    - per-job metric row capping behavior.
  - Added optional positive real-branch smoke (auto-skip when env deps are missing):
    - `smoke:runner-real-positive`
  - Updated API contract docs and setup/readme command lists (EN + ZH).
- next:
  1. If local YOLO model is available, run and archive `REAL_YOLO_MODEL_PATH=... npm run smoke:runner-real-positive` evidence.
  2. Expose retention summary in admin verification reports (optional) so deployment acceptance captures current cap usage.
  3. Add a lightweight endpoint to download job metrics JSON directly from training detail for troubleshooting.
- risks:
  - Real positive smoke remains environment-dependent.
  - Retention downsampling preserves trend but drops raw density; deep diagnostics may still require raw framework logs.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:runtime-metrics-retention`
  - `npm run smoke:runner-real-positive` (SKIP in current environment)
  - `npm run smoke:runner-real-upload`
  - `npm run smoke:execution-fields`
  - `npm run smoke:local-command`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 23:40 (Asia/Shanghai)
- context: Continuous implementation on existing skeleton: runtime observability + report chain + metrics export endpoint.
- done:
  - Added training metrics export API (no new page/route duplication):
    - `GET /api/training/jobs/{id}/metrics-export`
    - backend route + handler + service client + TrainingJobDetail download button.
  - Added runtime metrics retention summary into admin verification-report data chain:
    - `docker-verify-full` report now embeds `runtime_metrics_retention`
    - backend `/api/admin/verification-reports` parser maps `runtime_metrics_retention`
    - admin verification report page shows retention snapshot per report.
  - Added/updated smoke tests:
    - `smoke:training-metrics-export`
    - `smoke:runtime-metrics-retention`
    - existing runner/closure/restart/execution-field smoke all remain green.
  - Updated contracts/docs (EN + ZH):
    - API contract includes `metrics-export` endpoint and report retention field.
    - README/setup lists updated smoke commands.
- next:
  1. Add optional report-level assertion smoke that verifies `runtime_metrics_retention` is present in generated docker verify report JSON.
  2. If deployment env has YOLO real model + ultralytics, run `smoke:runner-real-positive` and persist evidence.
  3. Consider adding retention history trend to Runtime Settings (time-series summary) without introducing new route.
- risks:
  - `smoke:runner-real-positive` still depends on local model/dependency availability.
  - report retention field appears only for newly generated verify reports after script update.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:training-metrics-export`
  - `npm run smoke:runtime-metrics-retention`
  - `npm run smoke:runner-real-positive` (SKIP in current env)
  - `npm run smoke:runner-real-upload`
  - `npm run smoke:execution-fields`
  - `npm run smoke:local-command`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-03 23:55 (Asia/Shanghai)
- context: Continuous implementation after runtime-retention summary integration.
- done:
  - Added training metrics export API and frontend download action on existing Training Job Detail page:
    - `GET /api/training/jobs/{id}/metrics-export`
    - frontend button `Download Metrics JSON`.
  - Extended verification-report chain with runtime retention snapshot:
    - `scripts/docker-verify-full.sh` now writes `runtime_metrics_retention` into report JSON/Markdown.
    - backend admin report parser now maps `runtime_metrics_retention`.
    - admin verification reports page now displays retention row summary when available.
  - Added smoke tests:
    - `smoke:training-metrics-export`
    - `smoke:admin:verification-retention`
  - Updated contracts/docs and command lists (EN + ZH).
- next:
  1. Optionally add one smoke that runs full `docker-verify-full` against running Docker stack and asserts retention field end-to-end from generated report file.
  2. If YOLO real model exists, run `REAL_YOLO_MODEL_PATH=... npm run smoke:runner-real-positive` and archive result.
  3. Consider adding training metric CSV export as a companion to JSON export (same endpoint family, no new page route).
- risks:
  - `runtime_metrics_retention` appears only for reports generated after script update; historical reports may show null.
  - Positive real-runner smoke still env dependent.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:admin:verification-retention`
  - `npm run smoke:training-metrics-export`
  - `npm run smoke:runtime-metrics-retention`
  - `npm run smoke:runner-real-positive` (SKIP in current env)
  - `npm run smoke:runner-real-upload`
  - `npm run smoke:execution-fields`
  - `npm run smoke:local-command`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-04 00:10 (Asia/Shanghai)
- context: Continuous delivery; completed next planned verification-chain hardening.
- done:
  - Added configurable verification report directory in backend via `VERIFICATION_REPORTS_DIR` (default remains `.data/verify-reports`).
  - Enhanced `docker-verify-full`:
    - supports `VERIFY_SKIP_HEALTHZ=1` for API-only runs
    - embeds `runtime_metrics_retention` in report JSON/MD
    - checks `/api/runtime/metrics-retention` contract during verify step.
  - Added end-to-end consistency smoke:
    - `smoke:verify-report-retention-e2e`
    - starts API, runs `docker-verify-full`, then asserts `runtime_metrics_retention` is identical between generated report file and `/api/admin/verification-reports` response.
  - Synced docs/contracts and setup command lists (EN + ZH).
- next:
  1. Add CSV export option for training metrics (alongside JSON) using existing training detail page controls.
  2. Add optional report age check smoke path for deployment verification report freshness gating.
  3. Run positive YOLO real-branch smoke when local model path is available.
- risks:
  - Positive real-branch smoke still depends on local model/dependencies.
  - report retention metadata is present for newly generated verify reports; old reports may still be null.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:verify-report-retention-e2e`
  - `npm run smoke:admin:verification-retention`
  - `npm run smoke:training-metrics-export`
  - `npm run smoke:runtime-metrics-retention`
  - `npm run smoke:runner-real-positive` (SKIP in current env)
  - `npm run smoke:runner-real-upload`
  - `npm run smoke:execution-fields`
  - `npm run smoke:local-command`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`

## 2026-04-04 00:32 (Asia/Shanghai)
- context: Continue realification handoff; finish CSV metrics-export branch with executable smoke and regression pass.
- done:
  - Completed CSV export implementation verification and fixed frontend lint issue in filename parsing:
    - `src/services/api.ts` `Content-Disposition` filename regex cleanup.
  - Added CSV metrics export smoke:
    - new script `scripts/smoke-training-metrics-export-csv.sh`
    - new npm command `smoke:training-metrics-export-csv`
    - assertions include HTTP 200, `Content-Type: text/csv`, required CSV header columns, and metric rows bound to target `job_id`.
  - Synced smoke command docs:
    - `README.md`
    - `README.zh-CN.md`
    - `docs/setup.md`
    - `docs/setup.zh-CN.md`
    - `package.json`
  - Re-ran key smoke regression suite and all passed in current environment.
- next:
  1. Add `format=csv` UI affordance in admin/export docs for operators (explain JSON vs CSV use-cases).
  2. Optionally add lightweight server-side streaming path for very large CSV exports (keep current route signature unchanged).
  3. Continue replacing residual fallback metrics in framework adapters with more framework-native fields while preserving normalized output contract.
- risks:
  - `smoke:runner-real-positive` still depends on local model/dependency availability and currently SKIPs without model path env.
  - CSV endpoint currently returns in-memory string; very large jobs may need streaming optimization later.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:training-metrics-export-csv`
  - `npm run smoke:training-metrics-export`
  - `npm run smoke:runtime-metrics-retention`
  - `npm run smoke:admin:verification-retention`
  - `npm run smoke:verify-report-retention-e2e`
  - `npm run smoke:local-command`
  - `npm run smoke:execution-fields`
  - `npm run smoke:real-closure`
  - `npm run smoke:restart-resume`
  - `npm run smoke:runner-real-positive` (SKIP in current env)

## 2026-04-04 00:58 (Asia/Shanghai)
- context: Continue realification on existing pages/APIs; strengthen OCR training local-command path and training detail export UX.
- done:
  - Added OCR training local runners so non-YOLO framework jobs can emit framework-like metrics + series in local-command mode:
    - `scripts/local-runners/paddleocr_train_runner.py`
    - `scripts/local-runners/doctr_train_runner.py`
  - Upgraded `smoke-local-command` to verify true local-command training execution across three frameworks:
    - YOLO job must persist `execution_mode=local_command` and multi-step `map` series.
    - PaddleOCR job must persist `execution_mode=local_command` and multi-step `accuracy` series.
    - docTR job must persist `execution_mode=local_command` and multi-step `f1` series.
    - Keeps inference source checks for `yolo_local_command` / `paddleocr_local_command` / `doctr_local_command`.
  - Refined training detail export UX on existing page (`TrainingJobDetailPage`):
    - Added JSON vs CSV usage hint text.
    - Added button tooltips and mutual-disable during export to reduce accidental double-click race.
  - Synced i18n and env template:
    - `src/i18n/I18nProvider.tsx` new zh-CN strings for metrics export hints/tooltips.
    - `.env.example` now includes train-command template examples for PaddleOCR/docTR runners.
- next:
  1. Promote these OCR local train commands into one dedicated smoke for OCR-only closure (dataset->train->metrics->register->inference).
  2. Add optional runtime settings panel row to show latest framework-specific metric keys seen in recent completed jobs.
  3. Evaluate whether CSV export endpoint should switch to streaming for very large metric timelines.
- risks:
  - OCR local training metrics are deterministic synthetic runners (framework-shaped), not yet full framework native train loops.
  - Real runner positive path remains environment-dependent (`VISTRAL_RUNNER_ENABLE_REAL=1` + model/deps).
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:local-command`
  - `npm run smoke:execution-fields`
  - `npm run smoke:training-metrics-export-csv`

## 2026-04-04 01:18 (Asia/Shanghai)
- context: User-requested UI simplification for conversation composer; align to minimal input + upload plus style.
- done:
  - Simplified Conversation Workspace composer on existing page (`ConversationPage`) without adding routes:
    - removed heavy attachment-context controls from composer area (recent picker/action chips/reorder panel/quick prompts).
    - composer is now minimal: left `+` upload, center text input, right send button.
  - Kept attachment contract intact:
    - uploaded files remain visible below composer,
    - each file still shows status badge,
    - each file supports delete,
    - ready files can still be opened.
  - `ready` attachments are now auto-included for send payload by default (no manual include/exclude UI in composer).
  - Updated chat composer styles to match cleaner ChatGPT-like interaction density.
- next:
  1. If needed, add optional compact recent-file picker triggered by long-press on `+` (without restoring large panel complexity).
  2. Tune spacing/font sizes after user visual feedback on real screen (desktop + mobile).
  3. Keep monitoring attachment list density when attachment count is large.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 01:26 (Asia/Shanghai)
- context: Continue chat composer simplification after first pass; reduce attachment visual weight further while preserving attachment contract.
- done:
  - Kept minimal composer shell (`+` upload + single input + send) and further compressed attachment display:
    - replaced vertical attachment list block with compact single-line chip list.
    - each chip keeps status visibility (`StatusBadge`) and delete action (`×`), ready files remain openable.
  - Meta row now shows `Attachments total + Ready count` in one line to keep context visible without large panels.
  - Added compact CSS tokens for chip-style attachment rendering:
    - `chat-simple-attachment-list`
    - `chat-simple-attachment-item`
    - `chat-simple-attachment-open`
    - `chat-simple-attachment-delete`
- next:
  1. If user wants full ChatGPT-like minimal mode, hide chip list until first upload or collapse into one summary pill.
  2. Add optional mobile-only tighter composer height and one-line placeholder behavior.
  3. Run visual pass against user screenshots for exact spacing/radius alignment.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 01:34 (Asia/Shanghai)
- context: Continue towards ChatGPT-like minimalist composer per user request.
- done:
  - Attachment display is now collapsed by default behind one summary strip in Conversation composer.
  - Summary strip remains always visible when attachments exist and includes status counts:
    - total attachments
    - ready
    - uploading (if any)
    - processing (if any)
    - error (if any)
  - Added explicit `Show/Hide` toggle:
    - `Show` reveals compact chip list with per-file status + delete + open-for-ready.
    - `Hide` returns to minimal input-first look.
  - Auto-collapses expanded attachment list when attachments become empty.
- next:
  1. Optional: hide the summary strip too when no active uploads and only show tiny `附件 n` pill.
  2. Tune spacing/radius with screenshot-based pixel pass for stricter visual parity.
  3. Add optional animation for expand/collapse to smooth transitions.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 01:42 (Asia/Shanghai)
- context: Continue minimal composer polishing; shrink attachment summary into compact pill control.
- done:
  - Replaced attachment summary strip with compact pill-style toggle:
    - pill shows `attachments total + ready/uploading/processing/error` counters
    - action token shows `Show/Hide`
    - click toggles detail list visibility
  - Keeps attachment contract:
    - statuses visible in expanded list
    - each attachment deletable
    - ready attachment openable
  - Improved visual density with tighter rounded capsule styles for summary control.
- next:
  1. Optional: move status counters into tooltip/popover to make pill even shorter.
  2. Optional: auto-collapse after successful send to keep focus on message flow.
  3. Fine tune mobile wrapping for long status text on small widths.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 01:49 (Asia/Shanghai)
- context: Continue simplifying attachment pill to closer match user screenshot expectations.
- done:
  - Reduced attachment pill verbosity:
    - summary now shows only `Attachments n`
    - replaced long status text with tiny colored status dots (ready/uploading/processing/error)
    - replaced `Show/Hide` text token with compact chevron (`▸/▾`)
  - Preserved detailed status data via accessible title/aria-label text on pill button.
  - Expanded attachment list behavior unchanged (open/delete/status retained).
- next:
  1. Optional: hide attachment pill entirely until first attachment upload in current session.
  2. Optional: make send button icon-only with softer gray token to match screenshot even tighter.
  3. Optional: reduce composer border/shadow strength for cleaner floating feel.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 01:57 (Asia/Shanghai)
- context: Continue visual parity pass for minimal composer (closer to screenshot style).
- done:
  - Updated send button behavior/style:
    - disabled (no input) stays soft gray circle,
    - active (input present) switches to dark circle.
  - Removed always-visible composer meta row; notice row now appears only when there is a transient notice.
  - Softened composer container appearance:
    - lighter border,
    - larger radius,
    - reduced shadow strength for calmer floating look.
- next:
  1. Optional: further reduce top header density in conversation page to increase visual focus on composer.
  2. Optional: set composer width narrower on desktop (e.g., 860px) for tighter ChatGPT-like framing.
  3. Optional: add smooth textarea auto-grow to avoid manual resize affordance.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-03 20:36 (Asia/Shanghai)
- context: Continue conversation workspace UI simplification on existing route/components only, keep attachment contract intact.
- done:
  - Compressed `ConversationPage` top header into a low-noise single-row layout (model selector + mode + compact conversation summary).
  - Removed header duplicate user badge (user identity remains in left sidebar user card).
  - Simplified conversation summary content to title-only (no long ID in header line).
  - Added composer textarea auto-grow (up to 180px) for cleaner single-line default and smoother multiline expansion.
  - Tuned composer proportions for ChatGPT-like minimal style:
    - narrower composer width
    - softer border/shadow/radius
    - smaller send button and plus button
    - tighter vertical rhythm
  - Kept attachment behavior unchanged by contract:
    - always visible when present
    - status dots still shown
    - expandable detail list remains deletable/openable
- next:
  1. Continue micro-polish: tighten message-stage top spacing and empty-state typography balance for CN/EN text widths.
  2. Add small desktop/mobile spacing harmonization for attachment pill/list wrap to avoid crowding with long filenames.
  3. Run a quick visual pass on Runtime Settings / Inference Validation to ensure typography rhythm is consistent with updated conversation theme.
- risks:
  - Visual parity is improved but still manually tuned; final pixel-level parity with user reference may require one more screenshot-driven pass.
  - Header summary line may wrap earlier with very long localized strings on narrow widths.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-03 20:37 (Asia/Shanghai)
- context: Continue screenshot-aligned conversation composer polish after header simplification pass.
- done:
  - Further reduced conversation area density:
    - message stage top padding lowered
    - message and composer max widths aligned (`840px` desktop, `720px` mobile cap)
    - message scroll viewport height adjusted for better bottom-composer balance
  - Improved empty-state breathing space and text rhythm for CN/EN mixed copy.
  - Hardened attachment chip readability:
    - higher filename max width on desktop
    - full-width chip fallback on mobile
    - safer width clamp for long filenames.
- next:
  1. If needed, do one screenshot-driven pixel pass on icon sizes/weights (+ and send arrow).
  2. Add a tiny transition on attachment-list expand/collapse for smoother perceived quality.
  3. Verify visual consistency against `RuntimeSettingsPage` and `InferenceValidationPage` typography scale.
- risks:
  - Pure CSS tuning; no storybook visual baseline yet, so cross-browser spacing differences may still exist.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-03 20:40 (Asia/Shanghai)
- context: User reported repeated frontend error `Failed to execute 'json' on 'Response': Unexpected end of JSON input` across multiple pages.
- done:
  - Hardened frontend API response parsing in `src/services/api.ts`:
    - added safe envelope reader (`readApiEnvelope`) using `response.text()` + guarded `JSON.parse`
    - added normalized fallback error preview for empty/non-JSON responses
    - removed direct `response.json()` assumptions in core `request()` and `fetchCsrfToken()`
  - Hardened CSV export error branch:
    - replaced direct `response.json()` parse on non-OK with safe envelope parse + fallback message
  - Result: empty body / proxy HTML / malformed JSON now returns readable API errors instead of JSON parse exceptions.
- next:
  1. Optionally add backend-side guard logs for non-JSON error responses to speed up ops diagnostics.
  2. Optionally add a global frontend toast mapping for common transport/proxy failures.
- risks:
  - If third-party reverse proxy intermittently truncates response bodies, request may still fail (but now with readable message, no JSON parse crash).
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-03 21:03 (Asia/Shanghai)
- context: Follow-up on user-visible error `Request failed (500): empty response body` after frontend JSON parser hardening.
- done:
  - Improved frontend error wording for empty bodies in `src/services/api.ts`:
    - now explicitly hints API/proxy availability issue instead of opaque empty-body text.
  - Hardened backend external-response parsing to avoid hidden JSON parse crashes:
    - `backend/src/handlers.ts` (LLM provider error/success payload parsing now `response.text()` + safe JSON parse)
    - `backend/src/runtimeAdapters.ts` (runtime endpoint error/success payload parsing now safe and includes remote reason preview)
  - Verified conversation flow still works end-to-end.
- next:
  1. If user still sees 500 empty-body, inspect local dev process/proxy health and add startup health banner in frontend.
  2. Add backend-side structured warning logs for non-JSON upstream responses with endpoint/framework tags.
- risks:
  - Upstream reverse proxy may still return blank 500 responses under network faults; frontend now surfaces a clearer operator hint.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run smoke:conversation-context`

## 2026-04-04 16:38 (Asia/Shanghai)
- context: Historical unfinished-task audit for the recent UI cleanup / refresh-stability workstream; user asked to record remaining items and continue finishing them.
- done:
  - Reviewed current historical handoff notes plus the latest UI conversation thread.
  - Identified the highest-priority unfinished items from the recent UI-focused work:
    - refresh stability still needs a shared pass across remaining polling pages
    - `RuntimeSettingsPage` / `InferenceValidationPage` still need one visual consistency pass against the newer chat/console rhythm
    - conversation attachment pill/list still has minor wrap-density follow-up on narrow widths
  - Completed stable refresh behavior for `TrainingJobsPage` and `TrainingJobDetailPage`:
    - blocking loading only on first entry
    - later refreshes run quietly in background
    - visible state updates only when fetched data really changes
- next:
  1. Continue the same non-jumping refresh strategy on other polling-heavy pages (`DatasetDetailPage`, `AnnotationWorkspacePage`, then `InferenceValidationPage` if needed).
  2. Run one focused visual pass on `RuntimeSettingsPage` and `InferenceValidationPage` so spacing/typography match the cleaned chat + console shell.
  3. Finish the remaining attachment pill/list micro-polish for narrow layouts and long filenames in `ConversationPage`.
- risks:
  - Some pages already poll without full-screen loading flashes, so the remaining work is more about preventing useless rerenders and UI drift than fixing one obvious crash.
  - There is a large dirty worktree with many earlier feature changes; current UI stabilization work must avoid colliding with unrelated backend/runtime edits.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 16:50 (Asia/Shanghai)
- context: Continued the recorded UI stabilization queue after the historical unfinished-task audit; focused on remaining polling-heavy pages that still risked unnecessary rerenders or visual jumping.
- done:
  - Updated IA contracts in `docs/ia.md` and `docs/ia.zh-CN.md` so dataset detail, annotation workspace, and inference validation explicitly follow the same quiet-refresh rule:
    - blocking loading only on first entry
    - background refresh updates visible state only when fetched data really changes
    - manual refresh remains available
  - Completed the quiet-refresh sweep for:
    - `src/pages/DatasetDetailPage.tsx`
    - `src/pages/AnnotationWorkspacePage.tsx`
    - `src/pages/InferenceValidationPage.tsx`
  - The three pages now:
    - poll every `5000ms` instead of sub-second loops
    - compare fetched payload signatures before calling `setState`
    - keep manual refresh buttons for explicit operator control
  - `InferenceValidationPage` now uses a clean initial blocking loading state instead of rendering partial empty sections during first fetch.
- next:
  1. Run one visual consistency pass on `RuntimeSettingsPage` and `InferenceValidationPage` so spacing/typography match the refreshed chat + console shell.
  2. Finish the remaining conversation attachment pill/list micro-polish for narrow layouts and long filenames.
  3. Review secondary polling pages (`CreateModelPage`, then `ConversationPage` attachment polling) if users still report any refresh jumping.
- risks:
  - Signature-based refresh avoids most no-op rerenders, but annotation editing could still need a future dirty-draft guard if multi-user/server-side updates become frequent.
  - The worktree remains heavily modified from earlier rounds, so later UI passes still need to avoid unrelated runtime/backend files.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 16:55 (Asia/Shanghai)
- context: Continued directly into the next UI backlog item after the refresh-stability sweep; focused on aligning inference validation with the cleaned console overview layout.
- done:
  - Refined `src/pages/InferenceValidationPage.tsx` into the shared overview rhythm:
    - hero + signal cards
    - main operation lane for uploads/run/output
    - side lane for runtime diagnostics + dataset feedback
  - Kept the newly added quiet-refresh/manual-refresh behavior while improving visual hierarchy.
  - Added clearer empty-state prompts for missing model versions, ready inputs, and target datasets so the page tells the user what is missing instead of just showing empty controls.
- next:
  1. Finish the lighter parity pass on `RuntimeSettingsPage` so its section rhythm matches the refreshed inference page and the rest of the settings surface.
  2. Finish the remaining conversation attachment pill/list micro-polish for narrow layouts and long filenames.
  3. Review secondary polling pages (`CreateModelPage`, then `ConversationPage` attachment polling) if users still report any refresh jumping.
- risks:
  - `InferenceValidationPage` is now structurally closer to the shared overview shell, but final spacing/typography parity still depends on a last side-by-side pass against `RuntimeSettingsPage`.
  - The repository still has many unrelated modified files, so later UI passes must keep avoiding unrelated runtime/backend edits.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 17:01 (Asia/Shanghai)
- context: Continued the remaining UI backlog after the inference-page layout pass; focused on finishing Runtime settings parity and closing the small attachment-density tail item.
- done:
  - Refined `src/pages/RuntimeSettingsPage.tsx` to match the newer overview rhythm more closely:
    - hero now includes explicit refresh actions
    - initial loading now shows hero + blocking state instead of partially empty content
    - single-framework filter view now uses a calmer full-width diagnostics layout
    - execution summary blocks now use the shared compact record-card structure
  - Added a low-risk narrow-width polish in `src/styles/theme.css` for the chat attachment tray:
    - attachment rows now use a more stable grid layout
    - long filenames no longer squeeze action buttons as aggressively
    - small screens place the filename on its own row for cleaner wrapping
- next:
  1. Review secondary polling pages (`CreateModelPage`, then `ConversationPage` attachment polling) if users still report refresh jumping after the main sweep.
  2. If needed, run one screenshot-driven micro-polish pass on chat/composer icon sizing and spacing.
  3. Continue the lower-priority framework realification backlog.
- risks:
  - Attachment micro-polish was CSS-only and intentionally conservative; a true screenshot pass may still reveal tiny spacing issues across browsers.
  - Secondary polling pages have not yet been swept with the same signature-based refresh guard used on the main data/training/inference surfaces.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 17:05 (Asia/Shanghai)
- context: Continued the remaining refresh-stability queue after the Runtime/attachment polish pass; focused on the last secondary polling surfaces that could still cause unnecessary rerenders.
- done:
  - Updated IA contracts in `docs/ia.md` and `docs/ia.zh-CN.md` so:
    - conversation attachment tray refresh is explicitly quiet/background-only when data actually changes
    - model-create file upload step follows the same quiet background refresh rule
  - Hardened `src/pages/CreateModelPage.tsx`:
    - model-file polling slowed from `500ms` to `5000ms`
    - file list now updates only when attachment payload signature actually changes
  - Hardened `src/pages/ConversationPage.tsx`:
    - conversation attachment polling slowed from `500ms` to `5000ms`
    - attachment list now updates only when attachment payload signature actually changes
  - Result: the main refresh-stability sweep now covers training, dataset detail, annotation workspace, inference validation, model-create file polling, and conversation attachment polling.
- next:
  1. If needed, run one screenshot-driven micro-polish pass on chat/composer icon sizing and spacing.
  2. Monitor for any remaining refresh-jump reports outside the now-completed main/secondary polling sweep.
  3. Continue the lower-priority framework realification backlog.
- risks:
  - Attachment/model-file polling is now much calmer, but if operators expect sub-second status flips during upload processing, they may still want one explicit manual refresh affordance in the future.
  - This round focused on polling stability rather than deeper chat/history synchronization redesign.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 17:07 (Asia/Shanghai)
- context: Continued with the last low-risk frontend polish item after the refresh-stability sweep; focused on tightening the chat composer controls without changing behavior.
- done:
  - Refined `src/pages/ConversationPage.tsx` composer button markup so the plus/send controls use dedicated icon spans for more stable styling.
  - Polished `src/styles/theme.css` around the chat composer:
    - slightly stronger panel spacing and shadow
    - tighter plus/send button sizing and focus states
    - cleaner input padding/rhythm
    - calmer notice spacing below the composer
  - Result: the composer now reads as one more coherent control surface, while keeping the existing chat/attachment behavior unchanged.
- next:
  1. Monitor for any remaining refresh-jump reports outside the now-completed main/secondary polling sweep.
  2. If needed later, run a screenshot-driven pass on the remaining iconography/spacing details.
  3. Continue the lower-priority framework realification backlog.
- risks:
  - This pass was intentionally small and CSS-focused; only a screenshot-based review can confirm whether every icon/spacing detail is exactly where you want it.
  - No deeper chat interaction changes were made in this round.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 17:10 (Asia/Shanghai)
- context: Continued from the historical unfinished-task audit after the main UI stabilization queue; closed the pending runtime-settings summary item without expanding backend/API contracts.
- done:
  - Updated `docs/ia.md` and `docs/ia.zh-CN.md` so the Runtime settings tab contract explicitly includes framework-specific metric-key visibility from recent completed training jobs.
  - Extended `src/pages/RuntimeSettingsPage.tsx` execution watch:
    - keeps existing inference-source / execution-mode / retention summaries
    - additionally samples up to two recent completed jobs per framework
    - fetches training detail in parallel and tolerates per-job failures with partial results
    - surfaces latest artifact metric keys per framework inline, so operators do not need to jump into each training detail page
  - Added the matching Chinese UI copy in `src/i18n/I18nProvider.tsx`.
- next:
  1. Monitor for any remaining refresh-jump reports outside the now-completed main/secondary polling sweep.
  2. If more visual refinement is requested later, run a screenshot-driven pass on remaining iconography and spacing details.
  3. Continue the lower-priority framework realification backlog.
- risks:
  - The new metric-key summary intentionally samples only a small recent window per framework to avoid turning the settings page into a heavy bulk-detail loader.
  - If operators later need a broader historical metric taxonomy, that will likely deserve a dedicated backend summary endpoint instead of more frontend fan-out requests.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-04 17:32 (Asia/Shanghai)
- context: Continued the lower-priority framework realification backlog after closing the runtime-settings summary item; picked the oldest still-open OCR closure verification gap from the handoff queue.
- done:
  - Added a dedicated smoke script `scripts/smoke-ocr-closure.sh`.
  - New smoke covers one OCR-only closure on real uploaded files without adding routes:
    - create OCR dataset
    - upload OCR source file
    - import OCR annotations
    - create dataset version
    - create model drafts
    - run PaddleOCR/docTR local-command training
    - assert metrics + artifact summary presence
    - register model versions
    - upload inference input and run OCR inference for both frameworks
  - Registered the command as `npm run smoke:ocr-closure` in `package.json`.
  - Updated command docs in `README.md`, `README.zh-CN.md`, `docs/setup.md`, and `docs/setup.zh-CN.md`.
- next:
  1. Continue replacing residual fallback metrics in framework adapters/runners with more framework-native fields while preserving the normalized output contract.
  2. Evaluate whether the training metrics CSV export path should move to streaming for very large timelines while keeping the same endpoint family.
  3. If environment prerequisites are available later, run and archive positive real-branch evidence (`npm run smoke:runner-real-positive`).
- risks:
  - The new OCR closure smoke validates the local-command OCR business loop, but it still relies on deterministic framework-shaped runners unless optional real dependencies are enabled.
  - `START_API=false` mode expects the external API to already be configured with compatible local command/runtime settings; otherwise closure assertions may differ from the default self-started path.
- verification:
  - `npm run smoke:ocr-closure`

## 2026-04-05 10:18 (Asia/Shanghai)
- context: Chat workspace visual polish (sidebar/header low-noise tuning) was in progress; interrupted to prioritize mainline Phase 4 OCR/detection business-loop closure.
- done:
  - Completed the latest chat-only visual cleanup pass in `src/styles/theme.css`:
    - unified chat grayscale tokens
    - refined history row hover/active/menu-open contrast
    - reduced color noise in action cards and attachment chips
  - Rebuilt frontend after each pass and kept behavior/layout unchanged.
- next:
  1. Audit current Phase 4 closure readiness against contracts (`docs/flows.md`, `docs/api-contract.md`, `docs/data-model.md`) and existing smoke coverage.
  2. Run closure verification scripts (`npm run smoke:ocr-closure`, `npm run smoke:real-closure`) and identify remaining gaps.
  3. Implement/fix missing backend/frontend contract points required to close OCR/detection loops, then rerun verification.
- risks:
  - Existing closure scripts rely on local runner/runtime prerequisites; missing env dependencies may mask true contract gaps.
  - Repo currently has many in-flight file changes; Phase 4 fixes should avoid reverting unrelated work.
- verification:
  - `npm run build`

## 2026-04-05 09:33 (Asia/Shanghai)
- context: Continue unfinished core closure work with contract-first verification; user requested to keep moving forward after completion.
- done:
  - Re-validated current mainline closure status with executable checks instead of static assumptions:
    - `npm run typecheck`
    - `npm run lint`
    - `npm run build`
    - `npm run smoke:phase2`
    - `npm run smoke:conversation-actions`
    - `npm run smoke:real-closure`
    - `npm run smoke:ocr-closure`
    - `npm run smoke:auth-session`
    - `npm run docker:verify:full`
    - `npm run docker:up`
    - `npm run docker:healthcheck`
  - Added focused regression smoke for inference feedback task-type guard:
    - new script `scripts/smoke-inference-feedback-guard.sh`
    - new npm command `npm run smoke:inference-feedback-guard`
    - verifies mismatch dataset rejection + matching dataset success + dataset item/attachment traceability
  - Synced command docs for the new smoke entry:
    - `README.md`
    - `README.zh-CN.md`
    - `docs/setup.md`
    - `docs/setup.zh-CN.md`
- next:
  1. Run a browser visual pass on `/workspace/chat` and `/workspace/console` after this Docker rebuild to confirm sidebar/hover/account-menu style parity against latest UX requests.
  2. Keep Phase 4 closure stable by including `smoke:inference-feedback-guard` in routine pre-release smoke batches.
  3. Continue on remaining core backlog only if a concrete failing contract or user-visible regression is found.
- risks:
  - Repository remains a large dirty worktree; future patches should keep strictly scoped edits to avoid unrelated regressions.
  - Screenshot-level UX acceptance still needs manual browser confirmation even when smoke/test suites pass.
- verification:
  - `npm run smoke:inference-feedback-guard`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run docker:up`
  - `npm run docker:healthcheck`
  - `npm run docker:verify:full`

## 2026-04-05 09:34 (Asia/Shanghai)
- context: Harden deployment verification contract after adding focused inference-feedback regression smoke.
- done:
  - Upgraded `scripts/docker-verify-full.sh` step `inference feedback to dataset` to assert:
    - cross-task feedback (`detection` run -> `ocr` dataset) is explicitly rejected
    - matching-task feedback still succeeds and links the dataset
  - Re-ran `npm run docker:verify:full` after the script hardening, and full deployment verification passed.
- next:
  1. Keep this guard in deployment acceptance as a required contract check.
  2. Continue core work only from concrete failing checks or user-visible regressions.
- risks:
  - OCR closure output still reports `doctr_f1` as blank in non-strict mode output summary; closure passes because alternate OCR metric path is accepted.
  - If future runtime adapter changes affect OCR metric naming, summary printing may need harmonization for operator readability.
- verification:
  - `npm run docker:verify:full`

## 2026-04-05 09:40 (Asia/Shanghai)
- context: Continue core closure hardening after deployment verification guard update.
- done:
  - Improved OCR closure smoke output readability and metric robustness in `scripts/smoke-ocr-closure.sh`:
    - added `doctr_primary_metric_name` and `doctr_primary_metric_value` output fields
    - keeps `f1` priority and automatically falls back to `accuracy` when `f1` is absent in non-strict runtime paths
  - Tightened `scripts/docker-verify-full.sh` OCR closure step:
    - now validates both execution sources and non-empty OCR training metric values (`paddle_accuracy` + docTR primary metric)
  - Added one-command core regression suite:
    - new script `scripts/smoke-core-closure.sh`
    - new npm command `npm run smoke:core-closure`
    - sequence: `phase2` -> `conversation-actions` -> `inference-feedback-guard` -> `real-closure` -> `ocr-closure`
  - Synced command docs for the new core suite:
    - `README.md`
    - `README.zh-CN.md`
    - `docs/setup.md`
    - `docs/setup.zh-CN.md`
- next:
  1. Use `smoke:core-closure` as the default quick gate before heavy deployment checks.
  2. Keep `docker:verify:full` as release gate to retain strict inference-feedback and OCR metric assertions.
  3. Continue with remaining work only when a contract fails or a user-visible regression is confirmed.
- risks:
  - `smoke:core-closure` is intentionally serial and may take longer on resource-constrained machines.
  - OCR metric key naming can still vary with future real-runner implementations; fallback logic currently covers `f1`/`accuracy` only.
- verification:
  - `npm run smoke:ocr-closure`
  - `npm run docker:verify:full`
  - `npm run smoke:core-closure`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-05 09:44 (Asia/Shanghai)
- context: Continue core closure by hardening annotation review state-machine contract checks and error normalization.
- done:
  - Strengthened `scripts/smoke-phase2.sh` review-loop coverage:
    - added negative assertion: rejected review without `review_reason_code` must fail with `VALIDATION_ERROR`
    - added negative assertion: approved review with `review_reason_code` must fail with `VALIDATION_ERROR`
    - added second review cycle (`rework -> annotated -> in_review -> approved`) to verify transition integrity
    - kept and re-validated latest-review context persistence after rejection and rework
  - Fixed backend error normalization drift in `backend/src/apiError.ts`:
    - `cannot include` and `invalid review_reason_code` now map to `VALIDATION_ERROR` instead of falling into `INTERNAL_ERROR`
  - Synced smoke command description to reflect expanded review-state coverage:
    - `README.md`
    - `README.zh-CN.md`
- next:
  1. Keep `smoke:phase2` and `smoke:core-closure` as default core regressions before deployment verify.
  2. Continue only from concrete contract gaps or user-visible regressions.
- risks:
  - Review error assertions currently depend on exact backend message text; if wording changes, smoke script assertions may need updates.
  - Existing worktree remains heavily modified, so future patches should remain narrowly scoped.
- verification:
  - `npm run smoke:phase2`
  - `npm run smoke:core-closure`
  - `npm run docker:verify:full`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-05 09:49 (Asia/Shanghai)
- context: Continue core launch-readiness closure after review state-machine hardening.
- done:
  - Extended `scripts/smoke-phase2.sh` with explicit train-split gate regression:
    - builds a dataset version with `train_ratio=0`
    - asserts training launch is blocked with `VALIDATION_ERROR` and message `Selected dataset version must include at least one train split item.`
    - emits `no_train_gate_version_id` in script output for traceability
  - Verified that existing coverage gate (`annotation_coverage <= 0`) and new train-split gate both stay enforced in the same smoke flow.
  - Re-ran core and deployment suites:
    - `smoke:phase2`
    - `smoke:core-closure`
    - `docker:verify:full`
  - Synced `smoke:phase2` description in docs:
    - `README.md`
    - `README.zh-CN.md`
- next:
  1. Keep `smoke:phase2` as the contract guard for annotation-review + launch-readiness gates.
  2. Continue only from concrete failing contracts or user-visible regressions.
- risks:
  - Assertions currently match exact backend error text for deterministic contract checks; message text changes will require smoke updates.
  - Worktree remains broadly modified; continue narrow-scope edits to avoid accidental overlap.
- verification:
  - `npm run smoke:phase2`
  - `npm run smoke:core-closure`
  - `npm run docker:verify:full`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-05 09:58 (Asia/Shanghai)
- context: Integrate phase2 contract checks into deployment verification and harden smoke portability for external API mode.
- done:
  - Upgraded `scripts/smoke-phase2.sh` to support both local self-started API and external API verification:
    - added `BASE_URL`, `START_API`, `AUTH_USERNAME`, `AUTH_PASSWORD`, `EXPECT_RUNTIME_FALLBACK`
    - added reusable inference attachment readiness polling
    - replaced fixed seed attachment/model references (`f-1`, `f-3`, `mv-1`, `mv-2`) with dynamic model-version selection + dynamic inference uploads
    - keeps strict fallback assertions for local mode, and source-not-empty assertions for external deployment mode
  - Integrated phase2 checks into `scripts/docker-verify-full.sh` as step `10/13`:
    - now verifies annotation/review state machine and launch-readiness gates during deployment acceptance
    - report captures phase2 output ids including `no_train_gate_version_id`
  - Normalized verify step numbering to `1/13 ... 13/13`.
  - Synced deployment verification coverage notes in:
    - `README.md`
    - `README.zh-CN.md`
    - `docs/setup.md`
    - `docs/setup.zh-CN.md`
- next:
  1. Keep `docker:verify:full` as the single release acceptance gate now that it includes phase2 contracts.
  2. Continue only from concrete contract failures or user-visible regressions.
- risks:
  - External-mode assertions in `smoke-phase2` still rely on deterministic API error text for some validation cases.
  - As verification scope grows, runtime cost increases; teams may need staged pre-checks (`smoke:core-closure`) before full deployment verify.
- verification:
  - `START_API=false BASE_URL=http://127.0.0.1:8080 AUTH_USERNAME=alice AUTH_PASSWORD=mock-pass EXPECT_RUNTIME_FALLBACK=false bash scripts/smoke-phase2.sh`
  - `npm run smoke:phase2`
  - `npm run smoke:core-closure`
  - `npm run docker:verify:full`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-05 10:03 (Asia/Shanghai)
- context: Continue core deployment-gate closure by adding conversation operational action verification to full docker acceptance.
- done:
  - Refactored `scripts/smoke-conversation-actions.sh` to support both local and external API modes:
    - added `BASE_URL`, `START_API`, `AUTH_USERNAME`, `AUTH_PASSWORD`
    - added configurable training target defaults (`EXPECTED_TRAINING_DATASET_ID`, `EXPECTED_TRAINING_DATASET_VERSION_ID`)
    - kept local default behavior while enabling deployment-mode reuse
  - Integrated conversation operational action smoke into `scripts/docker-verify-full.sh`:
    - new step `6/14 conversation operational actions`
    - now asserts chat-side real backend creation loop (`dataset`, `model_draft`, `training_job`) during deployment acceptance
    - updated verify step numbering to `1/14 ... 14/14`
  - Synced docs coverage wording:
    - `README.md`
    - `README.zh-CN.md`
    - `docs/setup.md`
    - `docs/setup.zh-CN.md`
- next:
  1. Keep `docker:verify:full` as single release gate (now includes conversation actions + phase2 + closure loops).
  2. Continue from concrete failing contracts or user-visible regressions only.
- risks:
  - Conversation action smoke still defaults to seeded dataset/version for training follow-up (`d-2`/`dv-2`) unless overridden by env; environments without these seeds should pass overrides explicitly.
  - As full verify scope expands, runtime cost increases; run `smoke:core-closure` as preflight when needed.
- verification:
  - `npm run smoke:conversation-actions`
  - `START_API=false BASE_URL=http://127.0.0.1:8080 AUTH_USERNAME=alice AUTH_PASSWORD=mock-pass bash scripts/smoke-conversation-actions.sh`
  - `npm run docker:verify:full`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-05 10:07 (Asia/Shanghai)
- context: Harden conversation operational-action smoke to remove seed-id coupling and improve deployment portability.
- done:
  - Upgraded `scripts/smoke-conversation-actions.sh` training target selection:
    - removed hard default coupling to `d-2` / `dv-2`
    - auto-discovers a ready `detection` dataset when `EXPECTED_TRAINING_DATASET_ID` is not provided
    - auto-discovers a trainable dataset version (`split_summary.train > 0` and `annotation_coverage > 0`) when `EXPECTED_TRAINING_DATASET_VERSION_ID` is not provided
    - keeps explicit env override path for constrained environments
  - Extended script output with:
    - `training_dataset_id`
    - `training_dataset_version_id`
  - Tightened `scripts/docker-verify-full.sh` conversation-action step:
    - now validates these additional training target ids are present
    - report detail includes selected training dataset/version for traceability
- next:
  1. Keep conversation operational-action verification inside deployment gate without relying on fixed seed ids.
  2. Continue only on concrete contract failures or user-visible regressions.
- risks:
  - Auto-discovery logic expects at least one ready detection dataset with a trainable version in target environment.
  - If dataset availability policies become stricter later, deployment verify may need explicit override envs.
- verification:
  - `npm run smoke:conversation-actions`
  - `START_API=false BASE_URL=http://127.0.0.1:8080 AUTH_USERNAME=alice AUTH_PASSWORD=mock-pass bash scripts/smoke-conversation-actions.sh`
  - `npm run docker:verify:full`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-05 10:14 (Asia/Shanghai)
- context: Continue core deployment acceptance closure by adding account governance contract checks and removing remaining seed-coupling in verify path.
- done:
  - Added new smoke script `scripts/smoke-account-governance.sh` (supports local/external API):
    - admin creates user
    - user cannot access admin list
    - user changes own password
    - admin self-disable guard check
    - admin disables user -> disabled session becomes unauthenticated
    - disabled user cannot login
    - admin reactivates user
    - admin resets password
    - user login succeeds with reset password
  - Registered npm command:
    - `npm run smoke:account-governance`
  - Integrated account governance into `scripts/docker-verify-full.sh` as step `4/15`.
  - Kept and validated conversation operational actions step with dynamic training target IDs (no fixed `d-2`/`dv-2` dependency), now reporting selected `training_dataset_id` and `training_dataset_version_id`.
  - Updated docs command/coverage descriptions:
    - `README.md`
    - `README.zh-CN.md`
    - `docs/setup.md`
    - `docs/setup.zh-CN.md`
- next:
  1. Keep `docker:verify:full` as the single release gate (now includes auth + account governance + conversation operations + phase2 + closure loops).
  2. Continue from concrete contract failures or user-visible regressions only.
- risks:
  - Account governance smoke still asserts some exact error strings (for deterministic contract checking); wording updates may require script sync.
  - Account governance smoke creates temporary users each run; long-lived environments may need periodic data pruning.
- verification:
  - `npm run smoke:account-governance`
  - `START_API=false BASE_URL=http://127.0.0.1:8080 ADMIN_USERNAME=admin ADMIN_PASSWORD=mock-pass-admin bash scripts/smoke-account-governance.sh`
  - `npm run smoke:conversation-actions`
  - `START_API=false BASE_URL=http://127.0.0.1:8080 AUTH_USERNAME=alice AUTH_PASSWORD=mock-pass bash scripts/smoke-conversation-actions.sh`
  - `npm run docker:verify:full`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`

## 2026-04-06 08:33 (Asia/Shanghai)
- context: System cleanup and lag investigation was in progress; interrupted by request to return to unfinished full-site visual/design-system completion.
- done:
  - Verified Vistral runtime no longer had active training/inference jobs consuming workspace disk.
  - Cleaned repo-level test artifacts and deployment leftovers:
    - `.data/uploads/*`, `.data/training-jobs/*`, `.data/runtime-local-predict/*`, `.data/verify-reports/*`, `.data/dev.log`
    - old `release/` extracted folders and old tar archives (kept latest package only)
  - Pruned Docker caches/images/unused volumes and verified Docker health still passed.
  - Cleared safe developer caches (`npm`, `pip`, `playwright`, `cypress`, updater caches, Homebrew/aws cache), increasing system free space from ~60Gi to ~88Gi.
  - Confirmed major remaining disk hot spots are user content outside this repo (`~/Desktop/work` media and `~/Downloads/个人` VM images), not Vistral training tasks.
- next:
  1. Resume frontend design-system completion audit against `DESIGN.md` + `docs/ia.md` UX contracts.
  2. Patch remaining visual inconsistencies (shared primitives/tokens first, page-local style last).
  3. Re-run `typecheck/lint/build` + `docker:up` + `docker:healthcheck` and validate host-visible assets.
- risks:
  - User media/VM files are the primary remaining disk consumers; deleting them requires explicit user confirmation because they are non-cache personal assets.
  - Editor plugin host processes (Cursor/VSCode) remain a CPU hotspot and may still contribute to perceived lag during development.
- verification:
  - `npm run docker:healthcheck`
  - `docker system df -v`
  - `du -sh .data release`
  - `df -h /System/Volumes/Data`

## 2026-04-07 20:46 (Asia/Shanghai)
- context: Training worker dedicated-auth closure was in progress; interrupted by request to switch to full-page refactor using `notion/DESIGN.md`.
- done:
  - Completed dedicated per-worker auth implementation on the worker/control-plane mainline:
    - bootstrap `claim` returns `training_worker_auth_token`
    - control plane now accepts dedicated token for worker heartbeat and reference dataset package download
    - worker dispatch and cancel now prefer per-worker dedicated auth, with shared token kept as legacy fallback
    - worker-side setup/UI/scripts now prefer `TRAINING_WORKER_AUTH_TOKEN` and keep `TRAINING_WORKER_SHARED_TOKEN` as compatibility fallback
  - Updated worker deployment/onboarding docs to describe dedicated token as the default path:
    - `training-worker/README.md`
    - `docs/setup.md`
    - `docs/setup.zh-CN.md`
    - `docs/deployment.docker.md`
    - `docs/training-worker-onboarding.md`
  - Added dedicated worker auth smoke coverage:
    - new script `scripts/smoke-training-worker-dedicated-auth.sh`
    - npm command `npm run smoke:training-worker-dedicated-auth`
    - integrated into `scripts/smoke-core-closure.sh`
    - documented in `README.md` / `README.zh-CN.md`
- next:
  1. Finish integrating `smoke-training-worker-dedicated-auth` into `scripts/docker-verify-full.sh` so deployment verify covers dedicated worker auth automatically.
  2. Optionally refactor the existing worker smoke scripts to share common bootstrap/helper functions and support both `shared` and `dedicated` auth modes with less duplication.
  3. Re-run the full deployment verification gate after the above (`npm run docker:verify:full`).
- risks:
  - `scripts/docker-verify-full.sh` does not yet include the dedicated worker auth smoke, so deployment acceptance is still stronger in local/core smoke than in the full docker gate.
  - `docs/training-worker-onboarding.md` is currently untracked in git and should be reviewed together with the worker-doc updates before commit.
  - Multiple worker smoke scripts still duplicate local bootstrapping logic; future auth-mode changes may require touching several scripts unless helpers are consolidated.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `python3 -m py_compile training-worker/scripts/worker-train-api.py`
  - `npm run smoke:training-worker-package-reference`
  - `npm run smoke:training-worker-cancel`
  - `npm run smoke:training-worker-dedicated-auth`

## 2026-04-08 14:50 (Asia/Shanghai)
- context: Continued core deployment verification hardening after dedicated-auth integration; focused on seed-id portability and worker smoke maintainability.
- done:
  - Added worker smoke shared helper: `scripts/lib/smoke-training-worker-common.sh`.
  - Removed fixed `d-2/dv-2` coupling from all worker scheduler/dispatch/cancel/failover/health/reference/dedicated-auth smoke scripts by using dynamic training target resolution (`EXPECTED_TRAINING_DATASET_ID`, `EXPECTED_TRAINING_DATASET_VERSION_ID` overrides still supported).
  - Fixed `scripts/smoke-no-seed-hardcoding.sh` regex patterns so seed-id guard checks are effective.
  - Extended `scripts/docker-verify-full.sh` dedicated-auth check details and report entities to include worker/job ids, reference/cancel log counters, and selected training dataset/version ids.
- next:
  1. Optionally extract worker smoke process/bootstrap/login/CSRF helpers further to reduce remaining duplication across scripts.
  2. Add one compatibility smoke path for environments where `host.docker.internal` is unavailable (custom worker public host fallback guidance).
  3. Continue core roadmap closure from queue item 7 (`PLANS.md`): worker GUI onboarding and pairing UX.
- risks:
  - Dynamic target resolver currently requires at least one ready detection dataset with a trainable version (`split_summary.train > 0` and `annotation_coverage > 0`) in the target environment.
  - Worker smoke scripts still duplicate API/worker lifecycle bootstrapping logic; future auth/scheduler behavior changes may require multi-file sync until deeper helper extraction is done.
- verification:
  - `bash scripts/smoke-no-seed-hardcoding.sh`
  - `npm run smoke:training-worker-dedicated-auth`
  - `npm run smoke:training-worker-dispatch`
  - `npm run smoke:training-worker-package-reference`
  - `npm run docker:verify:full`

## 2026-04-12 15:20 (Asia/Shanghai)
- context: Runtime auto-configuration hardening + conversation ops bridge extension was in progress; interrupted by new request to shift focus to beginner-first product onboarding UX across the app.
- done:
  - Extended conversation console bridge to support runtime auto-config intent/action:
    - natural language intent detection for runtime auto-config
    - `/ops {"api":"auto_configure_runtime_settings","params":{"overwrite_endpoint":...}}` execution path
    - high-risk confirmation gate applied
    - runtime settings action-link surfaced in conversation action cards
  - Synced bridge contract docs:
    - `docs/api-contract.md`, `docs/api-contract.zh-CN.md`
    - `docs/flows.md`, `docs/flows.zh-CN.md`
  - Continued Runtime Settings UX simplification:
    - explicit API key copy clarifying local-only mode does not require API key
    - started/implemented a manual-required checks panel skeleton for production readiness items
  - Updated smoke bridge coverage draft in `scripts/smoke-conversation-ops-bridge.sh` for `auto_configure_runtime_settings`.
  - Validation completed so far: `npm run -s typecheck` passed.
- next:
  1. Finish beginner-first onboarding UX design and implementation plan (global IA + first-run guidance + progressive disclosure checkpoints).
  2. Complete and polish Runtime Settings manual-required checks panel wording/interaction for zero-knowledge operators.
  3. Run pending verification:
     - `npm run -s lint`
     - `npm run -s smoke:conversation-ops-bridge`
     - `npm run -s smoke:runtime-profile-activation`
     - optional: `npm run -s smoke:runtime-settings-persistence`
- risks:
  - Current worktree includes many concurrent modifications; final integration must avoid regressions from unrelated dirty-state files.
  - New runtime bridge API path is high-risk mutation; confirmation behavior and multilingual phrasing continuity must be re-verified in smoke.
  - Beginner onboarding UX spans IA/flows/frontend behavior; incomplete contract alignment may cause drift if coding starts before explicit staged plan.
- verification:
  - `npm run -s typecheck`
  - pending: `npm run -s lint`
  - pending: `npm run -s smoke:conversation-ops-bridge`
  - pending: `npm run -s smoke:runtime-profile-activation`

## 2026-04-12 17:19 (Asia/Shanghai)
- context: Beginner-first onboarding UX refinement was in progress; interrupted by a new request to add a persistent top-right help entry that can reopen current-page guidance at any time.
- done:
  - Introduced shared onboarding infrastructure:
    - `src/hooks/useDismissibleGuide.ts`
    - `src/components/onboarding/WorkspaceOnboardingCard.tsx`
  - Migrated page-level onboarding cards to the shared component across key workspace/settings pages:
    - `ProfessionalConsolePage`
    - `DatasetsPage`
    - `DatasetDetailPage`
    - `AnnotationWorkspacePage`
    - `CreateTrainingJobPage`
    - `TrainingJobsPage`
    - `ModelVersionsPage`
    - `InferenceValidationPage`
    - `LlmSettingsPage`
    - `RuntimeSettingsPage`
    - `AccountSettingsPage`
  - Synced IA/flows contract for page-level onboarding hide/reopen behavior and route-local dismiss persistence:
    - `docs/ia.md`, `docs/ia.zh-CN.md`
    - `docs/flows.md`, `docs/flows.zh-CN.md`
  - Upgraded major operational empty states to include next-step guidance and direct actions:
    - console, datasets, dataset detail, annotation, create training, training jobs, model versions, inference validation
    - models explore / my models / create model
    - training job detail
    - admin approvals / audit / verification reports
    - account directory
  - Validation completed after each UX batch:
    - `npm run -s typecheck`
    - `npm run -s lint`
- next:
  1. Add a persistent top-right help button / current-page hint entry so users can reopen onboarding from anywhere on the page, even after hiding the inline card.
  2. Update IA/flow docs for the new persistent help-entry behavior before implementation.
  3. Reuse the existing onboarding step definitions rather than duplicating page hints in each page module.
  4. Re-run `npm run -s typecheck` and `npm run -s lint` after the new help-entry implementation.
- risks:
  - Current onboarding state and step definitions live inside multiple pages; without a shared current-page help abstraction, a naive implementation could duplicate configuration or drift from inline onboarding cards.
  - Some pages outside the shared `WorkspacePage` pattern may still need special handling if the new persistent button is intended to cover the entire app, including chat/auth surfaces.
  - The worktree remains heavily modified; avoid reverting unrelated local changes while threading the new shared help entry through layout components.
- verification:
  - `npm run -s typecheck`
  - `npm run -s lint`

## 2026-04-13 11:28 (Asia/Shanghai)
- date_time: 2026-04-13 11:28 (Asia/Shanghai)
- context: Runtime settings beginner-first simplification was interrupted by an urgent annotation workspace usability/layout issue on `/datasets/:datasetId/annotate`.
- done:
  - Updated `docs/ia.md` and `docs/ia.zh-CN.md` so `/settings/runtime` now contracts around “path-first setup + expert controls collapsed by default”.
  - Refactored `src/pages/RuntimeSettingsPage.tsx` partway toward that contract:
    - top-level setup actions reduced to save/reload
    - introduced a first-screen “choose runtime setup path” panel
    - moved low-frequency maintenance and strict controls behind `AdvancedSection`
    - started collapsing per-model auth and local override controls in framework cards
  - Added corresponding beginner-first runtime copy in `src/i18n/I18nProvider.tsx`.
  - Verification completed so far:
    - `npm run -s typecheck`
    - `npm run -s build`
- next:
  1. Fix the annotation workspace layout/readability issue requested by the user.
  2. Return to `RuntimeSettingsPage.tsx` and finish runtime simplification polish.
  3. Resolve current lint warnings by wrapping helper functions in `useCallback` or simplifying dependencies.
  4. Re-run:
     - `npm run -s lint`
     - `npm run -s typecheck`
     - `npm run -s build`
     - `npm run -s docker:healthcheck`
- risks:
  - `src/pages/RuntimeSettingsPage.tsx` is mid-refactor; behavior is partially improved but not yet fully polished in browser.
  - `npm run -s lint` currently reports hook dependency warnings in `src/pages/RuntimeSettingsPage.tsx`.
  - Worktree remains heavily modified; avoid reverting unrelated local changes while fixing the annotation page.
- verification:
  - `npm run -s typecheck`
  - `npm run -s build`
  - `npm run -s lint` (warnings currently present in `src/pages/RuntimeSettingsPage.tsx`)

## 2026-04-13 14:22 (Asia/Shanghai)
- date_time: 2026-04-13 14:22 (Asia/Shanghai)
- context: Console page IA unification (models/settings/admin pages) was interrupted by a higher-priority runtime infrastructure request: make PaddleOCR local execution reproducibly available inside `vistral-api` Docker runtime (no template/fallback, no manual pip in container).
- done:
  - Continued compact console shell rollout on model domain pages:
    - `src/pages/ModelsExplorePage.tsx`
    - `src/pages/MyModelsPage.tsx`
    - `src/pages/ModelVersionsPage.tsx`
  - Continued training detail cleanup:
    - `src/pages/TrainingJobDetailPage.tsx` runtime strict status block aligned to inline alert pattern; duplicate side snapshot reduced.
  - Started settings-page shell migration:
    - `src/pages/AccountSettingsPage.tsx` (header/KPI/filter-toolbar migration in progress)
    - `src/pages/LlmSettingsPage.tsx` (header/KPI/filter-toolbar migration in progress)
  - Validation completed after this batch:
    - `npm run -s typecheck`
    - `npm run -s lint`
    - `npm run -s build`
- next:
  1. Pause UI refactor and switch to runtime infra path immediately.
  2. Audit `docker/Dockerfile.api`, `docker-compose.yml`, entrypoint/runtime defaults to confirm base image, Python version, and runner interpreter path.
  3. Migrate API runtime image to stable glibc + pinned Python (3.10/3.11) with build-time venv and PaddleOCR install.
  4. Wire runtime default python path (`/opt/vistral-venv/bin/python`) through runtime settings/defaults + local runner call chain.
  5. Rebuild and verify in-container import + runtime readiness + inference no-template fallback.
- risks:
  - Runtime stack currently appears mixed between Node app image and local Python runner expectations; interpreter path drift can break fallback guards silently.
  - PaddleOCR wheel compatibility depends on selected Python version and system libs; wrong base image can force source-build fallback and fail.
  - Worktree is heavily modified; runtime-focused changes must avoid unintentionally reverting active UI refactor files.
- verification:
  - completed: `npm run -s typecheck`
  - completed: `npm run -s lint`
  - completed: `npm run -s build`
  - pending (runtime task): docker image rebuild + in-container OCR import + runtime readiness + inference validation checks

## 2026-04-17 00:00 (Asia/Shanghai)
- date_time: 2026-04-17 00:00 (Asia/Shanghai)
- context: Continue the remaining UX cleanup pass on settings pages, with focus on making `/settings/runtime` and `/settings/llm` feel linear and non-operational.
- done:
  - Refactored `src/pages/RuntimeSettingsPage.tsx` into a clearer page structure:
    - path chooser
    - framework inventory
    - readiness summary
    - collapsed advanced runtime controls
  - Refactored `src/pages/LlmSettingsPage.tsx` into a linear setup flow:
    - preset and settings
    - connection test
    - advanced saved snapshot / danger zone
  - Kept existing APIs, routing, permissions, and i18n untouched.
  - Verified locally:
    - `npm run typecheck`
    - `npm run lint`
    - `npm run build`
- next:
  1. Rebuild and restart the frontend container so the browser picks up the new bundle.
  2. If the runtime shell still feels dense in-browser, continue with Worker / Training page polish.
  3. Confirm the settings pages no longer show the old repeated header/KPI/side-rail pattern.
- risks:
  - Docker rebuild was blocked in the current shell because the Docker daemon/socket was not reachable, so the browser may still show an older container bundle until rebuilt on a machine with Docker access.
  - Runtime remains intentionally feature-complete inside the advanced section; if this still feels heavy, the next iteration should split the manual framework editor further.
- verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `docker compose build --no-cache vistral-web` (blocked in this shell due Docker daemon/socket access)
