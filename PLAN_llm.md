## 2026-04-22 计划看板（整理版）

### 当前状态（一眼看懂）
- 历史轮次中的代码型收口项已基本归档；这份文档现在主要承担“当前还能继续补什么，工程师下一步该做什么”。
- 当前结论：核心闭环已可用；2026-04-23 已完成 P0 发布前验收归档、P1 对话卡片自动执行链与训练工程师手册、P2 nightly/CI 报告固化、P3 对话建议守卫补强、P4 CI/workflow 静态守卫、P5 对话/Dock UI wiring 守卫、P6 真实浏览器点击/截图守卫、P7 主合同/路线图/quickstart 对齐、P8 vision task 专项闭环 smoke，并在本轮把 P9 的 runner prerequisite/cache warmup 口径补成可执行基线。
- 当前剩余重点已从“有没有闭环”转为“远端 nightly 是否真正跑通、`vision task` 是否还需要更严格的真实证据档、移动端/跨浏览器真实体验是否收口”。
- 阅读顺序建议：先看“2026-04-23 之后继续推进（按优先级）”，再看“已完成（核心能力）”，最后按需查“历史实施日志”。

### 未完成（按优先级）
#### P0（发布前必须完成）
- [x] 执行 `npm run smoke:plan-llm-complete` 全链路验收并归档结果（含执行时间、关键 ID、结论）。  
- [x] 执行 `npm run docker:verify:strict-real` 并把 JSON/MD 报告路径回填到本文。  
- [x] 执行 `npm run docker:verify:pure-real` 并把 JSON/MD 报告路径回填到本文。  

#### 2026-04-23 P0 验收执行计划
- scope：只执行当前 P0 发布前验收与报告归档；不改业务流程、数据结构或 API 行为，除非验收失败暴露必须修复的问题。
- impact files：`PLAN_llm.md`（回填执行时间、关键产物、报告路径、结论）；必要时补充失败修复涉及文件。
- verification：
  - `npm run smoke:plan-llm-complete`
  - `npm run docker:verify:strict-real`
  - `npm run docker:verify:pure-real`
- risks：Docker 验收依赖本机 Docker 服务、运行中容器、真实/纯真实执行依赖与本地模型缓存；若环境不满足，需要记录阻塞与下一步恢复命令。

#### 2026-04-23 P0 验收执行结果
- `npm run smoke:plan-llm-complete`：PASS，执行窗口约 `2026-04-23 08:16-08:36 CST`，耗时 `1219.1s`。关键产物：OCR closure `paddle_model_version_id=mv-505`、`doctr_model_version_id=mv-534`；runtime device access `model_version_id=mv-29195`、`request_id=pubir-29233`、`delivery_id=pubpkg-29235`；strict real-closure `model_version_id=mv-29286`、`doctr_model_version_id=mv-29345`；pure real-closure `model_version_id=mv-29409`、`doctr_model_version_id=mv-29468`。结论：核心闭环、worker dedicated auth、runtime device access、严格注册与纯真实注册链路均通过，`registration_gate_exempted=false` 保持成立。
- `npm run docker:verify:strict-real`：PASS，正式报告执行窗口 `2026-04-23T01:31:07Z-2026-04-23T01:42:32Z`。报告：`.data/verify-reports/docker-verify-full-20260423093107.json`、`.data/verify-reports/docker-verify-full-20260423093107.md`。关键 ID：`conversation_id=c-78209`、`model_id=m-78331`、`approval_id=ar-78335`、`detection_run_id=ir-78339`、`ocr_run_id=ir-78341`、`runtime_device_model_version_id=mv-78691`、`runtime_device_request_id=pubir-78765`、`runtime_device_delivery_id=pubpkg-78767`。说明：首次 strict-real 全套在 `19/19 runtime device access chain` 被 `2400s` 命令超时截断；随后单跑 runtime device access 通过，再以更长超时窗口重跑全套并生成上述正式报告。
- `npm run docker:verify:pure-real`：PASS，报告执行窗口 `2026-04-23T01:42:56Z-2026-04-23T01:48:54Z`。报告：`.data/verify-reports/docker-verify-full-20260423094256.json`、`.data/verify-reports/docker-verify-full-20260423094256.md`。关键 ID：`conversation_id=c-78787`、`model_id=m-78909`、`approval_id=ar-78913`、`detection_run_id=ir-78917`、`ocr_run_id=ir-78919`、`runtime_device_model_version_id=mv-79269`、`runtime_device_request_id=pubir-79343`、`runtime_device_delivery_id=pubpkg-79345`。结论：pure-real 档 `OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION=true` 与 `REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION=true` 均通过，OCR closure 与 real closure 的 OCR 注册证据均为 `real`。
- 总结论：`PLAN_llm.md` 当前 P0 发布前必须验收项已完成；下一轮进入 P1（对话工作台卡片自动执行链扩展、模型训练工程师最短路径手册）或 P2（接入 CI/夜间任务）前，应优先基于本结果做发布归档/审计确认。

#### P1（高优先，影响易用性与可交付）
- [x] 将“建议下一步自动执行链”从训练详情页扩展到对话工作台卡片，减少页面来回切换。  
- [x] 新增“模型训练工程师上手手册（最短路径）”：只写必要步骤与故障自救，不写泛泛介绍。  

#### 2026-04-23 P1 执行计划
- scope：
  - 将训练失败排障的“建议下一步 / 执行首条建议”体验复用到对话工作台与右侧 Dock 的 `conversation_action` 卡片。
  - 对训练任务相关卡片，支持从卡片直接触发受控 `/ops retry_training_job` 建议（例如强制 `control_plane` 重试），仍保留高风险确认门禁。
  - 新增模型训练工程师最短路径手册，只写启动、数据、训练、注册、验证、故障自救的必要步骤。
- contract/docs first：
  - `docs/flows.md`：补充对话动作卡片可直接执行建议下一步，但 mutating API 仍需确认。
  - `docs/api-contract.md`：明确 `/ops retry_training_job` 参数支持 `execution_target` / `worker_id`。
  - `README.md`：补充手册入口。
- impact files：
  - 前端：`src/pages/ConversationPage.tsx`、`src/layouts/AppShell.tsx`、共享建议推导模块与 i18n。
  - 后端：`backend/src/handlers.ts`（对话 ops retry 参数透传）。
  - 文档：`docs/training-engineer-quickstart.md`、`README.md`、`PLAN_llm.md`。
- verification：
  - `npx tsc -p tsconfig.api.json --noEmit --incremental false`
  - `npx tsc -p tsconfig.app.json --noEmit --incremental false`
  - `npm run smoke:conversation-ops-bridge`
  - `npm run smoke:navigation-context-hygiene`
- risks：对话卡片直接触发建议时不能绕过确认门禁；Dock 与完整对话页需要保持同一语义，避免形成两套排障规则。

#### 2026-04-23 P1 执行结果
- 对话工作台与右侧 Dock 已复用共享建议推导：训练相关 `conversation_action` 卡片会显示 `Suggested next steps`，可直接打开日志/Runtime/Worker 设置；当卡片可定位训练任务且适合重试时，可一键发送受控 `/ops retry_training_job`（默认 `execution_target=control_plane`），后端仍返回确认门禁，不会绕过高风险确认。
- 后端对话 ops bridge 已透传并校验 `retry_training_job` 的 `execution_target` / `worker_id`，并让 `job_id` / `training_job_id` 都能生成训练任务详情链接。
- 新增最短路径手册：`docs/training-engineer-quickstart.md`；入口已加入 `README.md` 与 `README.zh-CN.md`。
- 合同同步：`docs/flows.md` 补充对话卡片可执行建议下一步；`docs/api-contract.md` 补充 `/ops retry_training_job` 与 `POST /training/jobs/{id}/retry` 的可选调度参数。
- 验证通过：
  - `npx tsc -p tsconfig.api.json --noEmit --incremental false`
  - `npx tsc -p tsconfig.app.json --noEmit --incremental false`
  - `npm run smoke:conversation-ops-bridge`
  - `npm run smoke:navigation-context-hygiene`
  - `npm run smoke:i18n-key-hygiene`
  - `npm run build`
- 剩余风险：本轮未做浏览器截图回归；建议下一轮若继续 P2/CI 前，补一次手动 UI 巡检：完整对话页与 Dock 各确认一次 `Run top suggestion -> confirmation -> result card` 的视觉节奏。

#### P2（中优先，工程化增强）
- [x] 把 `smoke:plan-llm-complete` 接入 CI/夜间任务，生成固定命名报告并保留最近 N 次记录。  

#### 2026-04-23 P2 执行计划
- scope：
  - 增强 `scripts/smoke-plan-llm-complete.sh`，让它在本地与 CI 都生成固定前缀报告：`plan-llm-complete-<timestamp>.json/.md/.log`。
  - 增加最近 N 次报告保留策略，默认保留 10 组，可通过 `PLAN_LLM_REPORT_RETAIN` 调整。
  - 新增 nightly/manual CI workflow，执行 `npm run smoke:plan-llm-complete` 并上传报告 artifact。
- impact files：`scripts/smoke-plan-llm-complete.sh`、`package.json`（如需新增快捷脚本）、`.github/workflows/*`、`README.md` / `README.zh-CN.md`、`PLAN_llm.md`。
- verification：
  - `bash -n scripts/smoke-plan-llm-complete.sh`
  - 以轻量 retain 参数跑一次脚本语法/报告生成 dry-ish 检查（不重复长链路时至少验证报告函数语法）
  - `npm run smoke:conversation-ops-bridge`
- risks：CI 环境缺少真实训练依赖或模型缓存时，nightly 可能失败；报告仍应保留失败摘要，便于排查 runner 环境差异。

#### 2026-04-23 P2 执行结果
- `scripts/smoke-plan-llm-complete.sh` 已生成固定前缀报告：`plan-llm-complete-<timestamp>.json/.md/.log`，默认目录 `.data/verify-reports/`。
- 新增 `PLAN_LLM_REPORT_RETAIN` 保留策略，默认保留最近 10 组 `plan-llm-complete-*` 报告；新增 `PLAN_LLM_REPORT_DIR` / `PLAN_LLM_REPORT_BASENAME` / `PLAN_LLM_REPORT_SELF_TEST` 便于 CI 与本地验证。
- `package.json` 新增 `npm run smoke:plan-llm-complete:self-test`。
- 新增 `.github/workflows/plan-llm-complete.yml`：支持 `workflow_dispatch` 与 nightly cron，执行 `npm run smoke:plan-llm-complete` 并上传 JSON/MD/LOG artifacts。
- README 中补充报告路径、保留策略与 CI workflow 入口。
- 验证通过：
  - `bash -n scripts/smoke-plan-llm-complete.sh`
  - `PLAN_LLM_REPORT_RETAIN=3 npm run smoke:plan-llm-complete:self-test`
  - self-test 报告：`.data/verify-reports/plan-llm-complete-20260423021255.json`、`.data/verify-reports/plan-llm-complete-20260423021255.md`、`.data/verify-reports/plan-llm-complete-20260423021255.log`
- 剩余风险：nightly workflow 未在远端 GitHub runner 实跑；如果 runner 缺少真实训练依赖或模型缓存，报告会记录失败摘要，后续可按 CI 环境再补缓存/预热步骤。

#### P3（低中优先，收敛剩余风险）
- [x] 为对话卡片“建议下一步”补纯函数级 smoke 守卫，覆盖训练重试、日志深链、Runtime/Worker 排障链接。

#### 2026-04-23 P3 执行计划
- scope：
  - 新增轻量本地 smoke，直接验证 `deriveConversationActionNextSteps()` 与 `buildConversationActionNextStepInput()` 的关键输出。
  - 覆盖训练失败卡片的一键 `retry_training_job` 建议必须携带 `execution_target=control_plane`，并只生成 `/ops` 输入，不直接执行 mutation。
  - 覆盖训练日志深链、Runtime 依赖排障链接、Worker 可达性排障链接，避免 Dock 与完整对话页共享逻辑后发生静默漂移。
- contract/docs first：本轮不改行为、接口、数据结构或流程合同；仅增加 guard 与计划记录。
- impact files：`PLAN_llm.md`、`package.json`、`scripts/smoke-conversation-next-steps.ts`。
- verification：
  - `npm run smoke:conversation-next-steps`
  - `npx tsc -p tsconfig.app.json --noEmit --incremental false`
- risks：该 smoke 只覆盖建议推导逻辑，不能替代浏览器截图/人工 UI 巡检；远端 nightly runner 仍需后续真实执行验证。

#### 2026-04-23 P3 执行结果
- 新增 `scripts/smoke-conversation-next-steps.ts`，直接覆盖聊天动作卡片共享建议推导：失败训练任务会生成受控 `/ops retry_training_job` 输入且保留 `execution_target=control_plane`；依赖/模板类失败会指向 `/settings/runtime`；worker/heartbeat/timeout 类失败会指向 `/settings/workers`；训练任务日志深链保持 `?evidence=logs`。
- `package.json` 新增 `npm run smoke:conversation-next-steps`，用于在不启动浏览器、不触发真实 mutation 的情况下守住对话页与 Dock 共用的建议推导逻辑。
- 验证通过：
  - `npm run smoke:conversation-next-steps`
  - `npx tsc -p tsconfig.app.json --noEmit --incremental false`
- 剩余风险：仍未做浏览器截图/人工 UI 巡检，无法覆盖视觉节奏与点击后的实际渲染；nightly workflow 仍未在远端 GitHub runner 实跑。

#### P4（低中优先，CI 可用性守卫）
- [x] 为 `plan-llm-complete` nightly/manual workflow 补本地静态 smoke，验证 workflow、npm 脚本、报告 self-test 与 artifact 路径仍然对齐。

#### 2026-04-23 P4 执行计划
- scope：
  - 新增轻量本地 smoke，检查 `.github/workflows/plan-llm-complete.yml` 仍包含 `workflow_dispatch`、nightly `schedule`、Node/npm 安装、`npm run smoke:plan-llm-complete`、`always()` artifact 上传与 JSON/MD/LOG 路径。
  - 同一 smoke 以临时报告目录运行 `scripts/smoke-plan-llm-complete.sh` 的 self-test，确认 JSON/MD/LOG 报告生成和保留策略仍可用。
  - 将该 guard 暴露为 npm 命令，方便后续在 CI 或发布前检查里复用。
- contract/docs first：本轮不改业务行为、接口、数据结构或用户流程；仅补工程化验证入口与 README 命令说明。
- impact files：`PLAN_llm.md`、`package.json`、`scripts/smoke-plan-llm-ci-workflow.ts`、`README.md`、`README.zh-CN.md`。
- verification：
  - `npm run smoke:plan-llm-ci-workflow`
  - `npm run smoke:plan-llm-complete:self-test`
- risks：该 smoke 只能证明本地 workflow 配置与报告脚手架一致，不能替代远端 GitHub runner 的真实 nightly 执行。

#### 2026-04-23 P4 执行结果
- 新增 `scripts/smoke-plan-llm-ci-workflow.ts`，本地检查 `plan-llm-complete` workflow 是否保留手动/夜间触发、Node 22 + npm 安装、长链路 smoke 命令、`always()` artifact 上传、JSON/MD/LOG 报告路径、artifact 保留策略与超时窗口。
- 同一 smoke 会在临时目录运行 `scripts/smoke-plan-llm-complete.sh` 的 self-test，并断言 JSON/MD/LOG 生成、报告内容与 `PLAN_LLM_REPORT_RETAIN` 保留策略可用，不污染真实 `.data/verify-reports/`。
- `package.json` 新增 `npm run smoke:plan-llm-ci-workflow`；`README.md` / `README.zh-CN.md` 已补充本地 workflow/report wiring guard 说明。
- 验证通过：
  - `npm run smoke:plan-llm-ci-workflow`
  - `npm run smoke:plan-llm-complete:self-test`，生成 `.data/verify-reports/plan-llm-complete-20260423022449.json/.md/.log`
  - `npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution node --types node --skipLibCheck scripts/smoke-plan-llm-ci-workflow.ts`
- 剩余风险：远端 GitHub runner 仍未真实跑 nightly；浏览器截图/人工 UI 巡检仍未覆盖对话页和 Dock 的视觉节奏。

#### P5（低中优先，对话/Dock UI wiring 守卫）
- [x] 为对话页与右侧 Dock 的 `Suggested next steps` UI wiring 补本地静态 smoke，减少“只改一边页面”或“漏接 `/ops` 生成”的回归风险。

#### 2026-04-23 P5 执行计划
- scope：
  - 新增轻量本地 smoke，检查 `src/pages/ConversationPage.tsx` 与 `src/layouts/AppShell.tsx` 都导入并调用共享 `deriveConversationActionNextSteps()` / `buildConversationActionNextStepInput()`。
  - 检查完整对话页与 Dock 都渲染 `Suggested next steps` 区块，支持 href 导航与 ops 建议执行，并在发送受阻时回填 composer 输入而不是丢弃建议。
  - 检查 i18n key 与样式 class 保持存在，避免 UI 文案或样式入口静默漂移。
- contract/docs first：本轮不改变业务行为、API、数据结构或流程合同；仅补前端 wiring guard 与命令说明。
- impact files：`PLAN_llm.md`、`package.json`、`scripts/smoke-conversation-next-steps-ui-wiring.ts`、`README.md`、`README.zh-CN.md`。
- verification：
  - `npm run smoke:conversation-next-steps-ui-wiring`
  - `npm run smoke:conversation-next-steps`
  - `npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution node --types node --skipLibCheck scripts/smoke-conversation-next-steps-ui-wiring.ts`
- risks：该 smoke 仍是静态 wiring guard，不能替代真实浏览器截图/点击巡检；但能覆盖 Dock 与完整对话页是否同时接入共享建议链路。

#### 2026-04-23 P5 执行结果
- 新增 `scripts/smoke-conversation-next-steps-ui-wiring.ts`，本地静态检查完整对话页与右侧 Dock 是否同时接入共享 `conversationActionNextSteps` 推导、渲染 `Suggested next steps`、支持 href 导航与 ops 执行、并在发送受阻时回填 composer 输入。
- 同一 smoke 还检查相关 i18n key 与样式入口，降低文案/样式被误删后 UI 静默降级的风险。
- `package.json` 新增 `npm run smoke:conversation-next-steps-ui-wiring`；`README.md` / `README.zh-CN.md` 已补充该 guard 说明。
- 验证通过：
  - `npm run smoke:conversation-next-steps-ui-wiring`
  - `npm run smoke:conversation-next-steps`
  - `npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution node --types node --skipLibCheck scripts/smoke-conversation-next-steps-ui-wiring.ts`
  - `npx tsc -p tsconfig.app.json --noEmit --incremental false`
- 剩余风险：仍未执行真实浏览器截图/点击巡检；该静态 guard 不能发现视觉拥挤、按钮换行、焦点实际表现等运行时问题。远端 GitHub runner nightly 仍未实跑。

#### P6（低中优先，真实浏览器点击/截图守卫）
- [x] 为对话页与右侧 Dock 的 `Suggested next steps` 补本地 Chrome/CDP smoke，覆盖真实登录、卡片确认、建议按钮点击与截图归档。

#### 2026-04-23 P6 执行计划
- scope：
  - 使用临时 `APP_STATE_STORE_PATH` 启动源码 API + Vite，避免污染真实 `.data/app-state.json`。
  - 通过本机 Chrome DevTools Protocol 访问 `/workspace/chat`，登录 `alice`，创建临时训练任务后在对话页发送 `/ops cancel_training_job`，点击 `Confirm now`，验证完成卡片出现 `Suggested next steps`、`Retry on control-plane lane`、`Open training logs`。
  - 点击建议中的重试按钮，确认高危 `/ops retry_training_job` 仍以对话内确认门禁呈现；随后切到 `/workspace/console`，验证右侧 Dock 读取同一会话并渲染建议下一步。
- contract/docs first：本轮不改变业务行为、API、数据结构或流程合同；仅补浏览器运行时验证与命令说明。
- impact files：`PLAN_llm.md`、`package.json`、`scripts/smoke-conversation-next-steps-browser.ts`、`README.md`、`README.zh-CN.md`。
- verification：
  - `npm run smoke:conversation-next-steps-browser`
  - `npm run smoke:conversation-next-steps-ui-wiring`
  - `npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution node --types node --skipLibCheck scripts/smoke-conversation-next-steps-browser.ts`
- risks：依赖本机安装 Chrome 且 8787/5173 端口空闲；该 smoke 覆盖桌面宽屏，不替代移动端/跨浏览器视觉巡检。远端 GitHub runner nightly 仍需另行实跑。

#### 2026-04-23 P6 执行结果
- 新增 `scripts/smoke-conversation-next-steps-browser.ts`：脚本会启动临时源码 API、Vite 与本地 headless Chrome，通过 CDP 执行真实浏览器巡检；API 使用临时 `APP_STATE_STORE_PATH`，训练任务派发给脚本内 mock worker，确保取消确认稳定命中 running/dispatch 分支且不污染真实 `.data/app-state.json`。
- 浏览器巡检覆盖：登录、完整对话页发送 `/ops cancel_training_job`、点击 `Confirm now`、验证完成卡片出现 `Suggested next steps` / `Retry on control-plane lane` / `Open training logs`、点击重试建议后确认仍进入高风险确认门禁、切到 `/workspace/console` 验证右侧 Dock 读取同一会话并渲染建议下一步。
- `package.json` 新增 `npm run smoke:conversation-next-steps-browser`；`README.md` / `README.zh-CN.md` 已补充命令说明。
- 截图归档：
  - `.data/verify-reports/conversation-next-steps-browser-chat-20260423061017.png`
  - `.data/verify-reports/conversation-next-steps-browser-dock-20260423061017.png`
- 验证通过：
  - `npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution node --types node --skipLibCheck scripts/smoke-conversation-next-steps-browser.ts`
  - `npm run smoke:conversation-next-steps-ui-wiring`
  - `npm run smoke:conversation-next-steps-browser`
  - `npm run smoke:conversation-next-steps`
  - `npx tsc -p tsconfig.app.json --noEmit --incremental false`
- 剩余风险：该 smoke 依赖本机 Chrome 与固定源码端口 `8787/5173`，覆盖桌面宽屏，不替代移动端/跨浏览器视觉巡检；远端 GitHub runner nightly 仍未实跑。

### 2026-04-23 之后继续推进（按优先级）
#### P7（文档合同收口，当前轮）
- [x] 把 `vision tasks`、`Suggested next steps`、训练工程师最短路径正式写入主合同文档，而不只留在 `PLAN_llm.md` 历史日志里。  
- [x] 统一 `README.md`、`README.zh-CN.md`、`PLANS.md`、`PLAN_llm.md`、`docs/training-engineer-quickstart.md` 的阅读顺序和继续推进入口。  

#### 2026-04-23 P7 执行计划
- scope：
  - 把已经落地的 `VisionTask` MVP（理解/列表/详情/auto-continue/auto-advance/register-model/feedback-dataset）补进 `docs/prd.md`、`docs/ia.md`、`docs/flows.md`、`docs/data-model.md`、`docs/api-contract.md`。
  - 把 README 与训练工程师 quickstart 调整为“先看路线图/继续推进文档，再走 chat 或 console 入口”的工程师友好顺序。
  - 同步 `PLANS.md` 与 `PLAN_llm.md`，让“当前真实阶段”和“下一轮待办”不再只停留在旧 phase 口径。
- contract/docs first：
  - `docs/prd.md`
  - `docs/ia.md`
  - `docs/flows.md`
  - `docs/data-model.md`
  - `docs/api-contract.md`
- impact files：
  - `PLANS.md`
  - `PLAN_llm.md`
  - `README.md`
  - `README.zh-CN.md`
  - `docs/prd.md`
  - `docs/ia.md`
  - `docs/flows.md`
  - `docs/data-model.md`
  - `docs/api-contract.md`
  - `docs/training-engineer-quickstart.md`
- verification：
  - `rg -n '/vision/tasks|VisionTask|Suggested next steps|training-engineer-quickstart|PLAN_llm|PLANS.md' README.md README.zh-CN.md PLANS.md PLAN_llm.md docs/prd.md docs/ia.md docs/flows.md docs/data-model.md docs/api-contract.md docs/training-engineer-quickstart.md`
  - `git diff --check -- README.md README.zh-CN.md PLANS.md PLAN_llm.md docs/prd.md docs/ia.md docs/flows.md docs/data-model.md docs/api-contract.md docs/training-engineer-quickstart.md`
- risks：本轮主要是文档补齐，不会替代 vision task 专项 smoke、远端 nightly 实跑或移动端真实体验巡检；如果后续实现继续变化，主合同文档必须继续同步。

#### 2026-04-23 P7 执行结果
- 已把 `VisionTask` 从“历史日志里提过”提升为主合同中的正式能力：`docs/prd.md`、`docs/ia.md`、`docs/flows.md`、`docs/data-model.md`、`docs/api-contract.md` 现在都能找到同一组路由、实体、状态和 API。
- 补齐了之前仍然容易漂移的合同细节：`docs/data-model.md` 明确了 `Vision task type` 与 `VisionModelingTask` 的来源/样本附件约束，`docs/api-contract.md` 明确了对话内 `created_entity_type=VisionTask` 语义以及 `vision task` 相关接口的请求校验边界。
- `docs/training-engineer-quickstart.md` 已从“纯 console 手动路径”升级为“双入口最短路径”：既覆盖 `chat -> vision task -> auto advance`，也保留 `datasets -> training jobs` 的直接工程路径。
- `README.md` / `README.zh-CN.md` 已把 `PLANS.md`、`PLAN_llm.md`、`docs/work-handoff.md` 提到继续推进入口；`PLANS.md` 已从旧 phase 口径收敛成当前 delivery tracks，便于后续 handoff。
- 这轮补完后，新接手工程师可以按 `README -> PLANS/PLAN_llm -> contracts -> quickstart` 的顺序理解当前系统，而不需要先翻 `src/` / `backend/`。
- 验证通过：
  - `rg -n '/vision/tasks|VisionTask|Suggested next steps|training-engineer-quickstart|PLAN_llm|PLANS.md' README.md README.zh-CN.md PLANS.md PLAN_llm.md docs/prd.md docs/ia.md docs/flows.md docs/data-model.md docs/api-contract.md docs/training-engineer-quickstart.md`
  - `git diff --check -- README.md README.zh-CN.md PLANS.md PLAN_llm.md docs/prd.md docs/ia.md docs/flows.md docs/data-model.md docs/api-contract.md docs/training-engineer-quickstart.md`

#### P8（高优先，vision task 专项验收）
- [x] 新增独立的 `vision task` 闭环 smoke：`npm run smoke:vision-task-closure` 现在覆盖 `understand -> missing-requirements guard -> create trainable dataset/version -> auto-continue -> register-model -> inference -> feedback-dataset -> completed closure state`。  
- [x] 不再只依赖聊天/训练相邻 smoke 间接覆盖 `VisionTask`；`smoke:core-closure` 已把 `smoke:vision-task-closure` 纳入默认回归面。  

#### 2026-04-23 P8 执行结果
- 已新增 `scripts/smoke-vision-task-closure.sh` 与 `npm run smoke:vision-task-closure`，默认在独立临时 app-state 中自建样本/数据集/version，不依赖固定 seed id。
- 这条 smoke 的便携默认口径已显式固定：`VISTRAL_RUNNER_ENABLE_REAL=0`、`VISTRAL_DISABLE_INFERENCE_FALLBACK=0`、`MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1`，因此本机没准备真实权重/依赖时也能稳定守住主编排链。
- 这条 smoke 先验证 `requires_input` 口径，再验证可训练 `VisionTask` 的训练、注册、推理与坏例回流，最后确认 `auto-advance` 返回 `completed`。
- `README.md`、`docs/training-engineer-quickstart.md`、`PLANS.md`、`scripts/smoke-core-closure.sh` 已同步接入这条新 lane，后续回归不需要再靠邻近 smoke 间接证明 `VisionTask` 主闭环。

#### P9（高优先，远端/nightly 真实性实跑）
- [ ] 至少在一个远端 GitHub runner 或固定夜间环境真实跑通 `plan-llm-complete`，确认缓存、依赖和报告 artifact 不是只在本机成立。  
- [x] 若远端环境暂时不具备真实训练条件，需要把 runner prerequisite / cache warmup / fallback 口径写成明确恢复步骤。  

#### 2026-04-23 P9 执行计划
- scope：
  - 把 `smoke:vision-task-closure` 接入 `smoke:plan-llm-complete`，让 manual/nightly 长链路不再遗漏 `VisionTask` 专项验收。
  - 给 `.github/workflows/plan-llm-complete.yml` 增加 runtime cache、`doctor/setup` readiness 预热与失败恢复提示，降低远端 runner 首次冷启动失败率。
  - 把远端/nightly runner 的 cache path、预热命令和恢复步骤写回 `README.md`、`docs/setup.md`、`PLANS.md`，让下一位工程师不需要翻脚本源码。
  - 再补一个 `gh` helper，把“检查 pushed ref + `gh auth`、dispatch workflow、轮询 run、下载 artifact、生成 blocker/success 报告”收敛成单命令入口。
- impact files：
  - `scripts/smoke-plan-llm-complete.sh`
  - `.github/workflows/plan-llm-complete.yml`
  - `scripts/smoke-plan-llm-ci-workflow.ts`
  - `scripts/plan-llm-remote-proof.sh`
  - `README.md`
  - `docs/setup.md`
  - `PLANS.md`
  - `PLAN_llm.md`
- verification：
  - `bash -n scripts/smoke-plan-llm-complete.sh`
  - `npm run smoke:plan-llm-ci-workflow`
  - `npm run smoke:plan-llm-complete:self-test`
  - `bash -n scripts/plan-llm-remote-proof.sh`
  - `npm run proof:plan-llm-remote:self-test`
  - `npm run proof:plan-llm-remote`
  - `git diff --check -- README.md docs/setup.md PLANS.md PLAN_llm.md .github/workflows/plan-llm-complete.yml scripts/smoke-plan-llm-complete.sh scripts/smoke-plan-llm-ci-workflow.ts scripts/plan-llm-remote-proof.sh package.json`
- risks：本轮仍然不能替代一次真正的远端 GitHub runner/nightly 实跑；workflow 只能把 prerequisites/cache/warmup 固化，不能凭空替代远端依赖下载时间与网络差异。

#### 2026-04-23 P9 执行结果
- `smoke:plan-llm-complete` 现在已把 `smoke:vision-task-closure` 纳入固定执行面，因此 manual/nightly 报告不再只覆盖 OCR / worker / runtime / strict-real / pure-real，而会先守住 `VisionTask` 的完整闭环。
- `.github/workflows/plan-llm-complete.yml` 现在会缓存 `.data/runtime-python/.venv` 与 `.data/runtime-models`，并在长链路前先执行 `npm run doctor:real-training-readiness`；若未就绪，会自动尝试 `npm run setup:real-training-env` 后再复查，并把当前状态与恢复提示写进 GitHub step summary。
- `scripts/smoke-plan-llm-ci-workflow.ts` 已同步守卫这些新约束：runtime cache action、`doctor/setup` 预热、step summary，以及 `smoke:plan-llm-complete` 内必须包含 `smoke:vision-task-closure`。
- `README.md` 与 `docs/setup.md` 已把 remote/nightly runner 基线写实：缓存路径、`VISTRAL_PYTHON_BIN` / `YOLO_LOCAL_MODEL_PATH`、推荐 warmup 命令、以及 cache stale 时用 `PLAN_LLM_RUNTIME_CACHE_VERSION` 强制重建的恢复方式。
- 已新增 `scripts/plan-llm-remote-proof.sh` 与 `npm run proof:plan-llm-remote` / `npm run proof:plan-llm-remote:self-test`：helper 会检查 `origin` / 当前 ref / worktree / `gh auth`，在条件满足时 dispatch `plan-llm-complete.yml`、轮询 run、下载 `plan-llm-complete-reports` artifact，并无论成功还是阻塞都生成固定 `plan-llm-remote-proof-<timestamp>.json/.md/.log` 报告。
- `npm run proof:plan-llm-remote:self-test`：PASS，生成 `.data/verify-reports/plan-llm-remote-proof-20260423135007.json`、`.md`、`.log`，证明 helper 的报告/保留机制可用。
- `npm run proof:plan-llm-remote`：BLOCKED，生成 `.data/verify-reports/plan-llm-remote-proof-20260423135418.json`、`.md`、`.log`。这次 preflight 证明：
  - `origin/main` 可达，`remote_head=9c344f3fadfa39a28deaeb71feddb3387b059bc2`，与当前 `local_head` 一致；
  - 真正阻塞远端 dispatch 的不是 branch 未推送，而是 `git_worktree_dirty`（当前约 `81` 条改动）和 `gh_auth_missing`。
- 本轮继续把 helper 磨顺：当 `remote HEAD` 已经等于将要 dispatch 的 commit 时，dirty worktree 只作为 advisory 写入报告，不再阻塞远端 proof，因为这次 GitHub run 本来就只证明已推送的 remote commit。
- 结论：P9 里“把 prerequisite/cache warmup/fallback 口径写成明确恢复步骤”这一半已经完成，而且远端 proof 的阻塞现在被固化成机器可读报告；仍缺一次真正的远端/nightly 实跑来证明这套 workflow 在 GitHub runner 上也成立。下一步就是执行 `gh auth login`，再重跑 `npm run proof:plan-llm-remote`。

#### P10（中优先，真实使用体验收口）
- [ ] 做一次移动端/窄屏与跨浏览器巡检，重点覆盖 `/workspace/chat`、右侧 Dock、`/vision/tasks`、`/vision/tasks/:taskId`、`/training/jobs/:jobId`。  
- [ ] 把“能跑通”继续提升到“真顺手”：重点看按钮换行、长文案、状态卡节奏、深链返回路径与帮助信息是否拥挤。  

### 已完成（核心能力）
- 对话式视觉建模任务闭环（任务理解 → 数据检查 → recipe 规划 → 训练 → 验证 → 注册 → 反馈回流）已落地。  
- 训练详情页“低人工排障”链路已成型：失败上下文、关键词匹配、上下文行、URL 同步、建议动作、一键重试。  
- 严格/纯真实口径 smoke 已实跑通过（`registration_gate_exempted=false`，纯真实场景 OCR 证据为 `real`）。  
- 计划收口脚本已固化：`npm run smoke:plan-llm-complete`。  
- 远端/nightly runner 的 cache warmup 与恢复步骤已固化到 workflow + `docs/setup.md`。  
- 远端 proof helper 已固化：`npm run proof:plan-llm-remote`。  
- 主合同文档与训练工程师入口已同步到 `VisionTask` / `Suggested next steps` 新口径。  

---

## 历史实施日志（保留追溯）
> 说明：以下内容为完整执行记录与分轮次日志，默认不再作为“当前待办”来源；当前待办以“计划看板（整理版）”为准。

## Vistral 对话式自动训练闭环（OCR+检测）实施计划

### Summary
把“对话里一句需求→可用模型产物”产品化为一个统一的自动流程能力。首版覆盖 OCR+检测，默认“一键全自动”，自动完成数据准备、预标注与抽检、训练与3轮调参、阈值判定、模型注册、推理验证与反馈回流，最终给出“可用待审”的模型版本。对话消息中的控制台调用结果统一提供“详情页+列表页”双跳转，并携带上下文筛选参数。

### Key Changes
1. 新增“自动训练工作流”域模型与状态机  
- 引入 `AutoTrainRun`（建议状态：`pending/running/needs_input/completed/completed_with_warning/failed/cancelled`）。  
- 固定步骤：`dataset_prepare -> pre_annotation -> qc_sampling -> dataset_version_freeze -> train_round_1..3 -> evaluate_threshold -> register_version -> inference_validate -> feedback_loop -> handoff_pending_approval`。  
- 记录每一步输入输出对象 ID（`dataset_id/dataset_version_id/training_job_ids/model_version_id/inference_run_id/feedback_dataset_id`）和诊断信息。  
- 失败收口按你选择：3轮后未达标则“产出最佳并告警”，状态为 `completed_with_warning`，仍输出可运行模型和整改建议。

2. 自动调参与阈值策略（OCR+检测）  
- 首版默认中等预算：每任务最多 3 轮候选配置。  
- 默认阈值：OCR `accuracy>=0.80 或 f1>=0.55`；检测 `mAP50>=0.50`。  
- 每轮根据上一轮结果自动调整学习率/epoch/batch_size/warmup/weight_decay（限定在安全区间），并保留全量试验轨迹。  
- 阈值通过则提前收敛并停止后续轮次；未通过但可运行则按“最佳并告警”收口。  

3. 标注策略产品化（预标注+抽检）  
- 自动执行预标注。  
- 自动抽样质检并计算样本质量信号；低质量样本进入“人工修订队列”。  
- 数据版本冻结前必须满足训练就绪门槛（train split 与 coverage）。  
- 对话里允许用户补充样本/纠偏指令后继续同一 `AutoTrainRun`，不中断上下文。

4. 对话入口与控制台 API 编排  
- 新增自然语言意图：如“帮我训练一个识别X的模型”，生成统一 `auto_train` 动作，而不是分散的单步 API。  
- 编排器内部串行/并行调用现有能力：`create_dataset/create_dataset_version/run_dataset_pre_annotations/create_training_job/register_model_version/run_inference/send_inference_feedback`。  
- 高风险确认策略改为“单次总确认”：用户确认一次后，工作流按计划自动执行到“待审交接”。  
- 审批与设备授权保持人工边界，不自动审批/下发。

5. 对话消息可点击跳转统一升级（重点满足你的诉求）  
- `console_api_call` 返回统一“双入口动作”：`查看详情` 与 `打开列表`。  
- 所有链接必须携带上下文参数（`dataset/version/task/framework/selectedId/drawer/return_to`）并落地到正确筛选状态。  
- 统一前端链接生成优先级：对 `console_api_call` 强制以客户端 `resolveConversationActionLinks` 生成为准，避免后端静态 `action_links` 导致上下文丢失。  
- `created_entity_type + created_entity_id` 始终生成详情深链，保障“新建训练任务/数据集/版本”可一键直达。

6. 严格证据门禁能力补齐（与现有能力兼容）  
- `register_model_version` 增加 `require_pure_real_evidence?: boolean`。  
- 默认不改变现有行为；开启后 `real_probe` 不再视为通过，要求 `registration_evidence_mode=real`。  
- 工作流默认使用严格门禁、`registration_gate_exempted=false`，并在结果中显式展示 `evidence_mode/gate_status`。  
- 在 strict-real 报告中保留口径参数与实际注册证据字段，便于审计。

### Public API / Interface Changes
- `RegisterModelVersionInput` 新增 `require_pure_real_evidence?: boolean`。  
- 新增自动训练工作流 API（建议）  
1. `POST /api/workflows/auto-train`：创建并启动自动训练任务。  
2. `GET /api/workflows/auto-train/:id`：查询状态、步骤、产物和告警。  
3. `POST /api/workflows/auto-train/:id/resume`：补充输入后继续。  
4. `POST /api/workflows/auto-train/:id/cancel`：取消。  
- 对话动作元数据新增（建议）  
- `action='auto_train'`，携带步骤进度、当前阻塞项、产物对象 ID、双跳转链接数组。

### Test Plan
1. 对话一键自动化主链路  
- 输入“训练一个识别X模型 + 上传样本”，一次确认后自动执行至“可用待审”。  
- 校验产物对象齐全：训练任务、模型版本、推理运行、反馈数据集。  

2. 跳转可用性与上下文一致性  
- 每条 `console_api_call` 结果同时出现“详情+列表”按钮。  
- 点击后页面筛选与抽屉状态正确（任务类型、框架、selectedId、drawer、return_to）。  
- 覆盖 `dataset/training_job/model_version/inference_run` 四类对象。  

3. 调参与阈值  
- 3轮内达标：应提前收敛。  
- 3轮未达标：`completed_with_warning`，输出最优模型+诊断，不中断闭环对象产出。  

4. 标注与质检  
- 预标注执行成功。  
- 抽检命中低质量样本时进入人工修订队列。  
- 版本冻结前训练就绪条件不满足时阻塞并给出明确原因。  

5. 证据门禁  
- 默认模式：兼容当前 strict-real 流程，`registration_gate_exempted=false`。  
- `require_pure_real_evidence=true`：`real_probe` 必须被拒绝，错误信息与审计字段完整。  

6. 回归验证  
- `typecheck/build/smoke:navigation-context-hygiene/docker:healthcheck/docker:verify:full` 全绿。  
- 增加 `docker:verify:strict-real` 与（可选）`docker:verify:pure-real` 分档验证报告。

### Assumptions
- 首版范围锁定 OCR+检测。  
- 自动化模式为“一键全自动 + 单次总确认”。  
- 质量判定使用默认阈值与中等预算（3轮）。  
- 治理边界到“可用模型并待审”，审批与设备授权仍人工确认。  
- 若未达阈值，默认“产出最佳并告警”而不是无限重试。

---

## 2026-04-21 实施补充计划（命名去敏 + 门禁收尾）

### Summary
在不影响现有闭环可用性的前提下，完成注册门禁字段迁移收尾：前端仅暴露校准命名、后端继续兼容旧字段并补充审计事件；随后执行全套回归，确保 `docker:verify:full` 继续全绿。

### Key Changes
1. 文档与计划落地  
- 将本轮改造目标、风险边界、验收命令写入本文件，作为“先落地再实施”的执行基线。

2. 前端输入接口去除旧字段暴露  
- `src/services/api.ts` 的 `registerModelVersion` 入参类型仅保留 `allow_ocr_calibrated_registration`。  
- 前端请求体只发送新字段，不再声明 `allow_ocr_real_probe_registration`。

3. 后端兼容解析与审计增强  
- `backend/src/server.ts` 保持对旧字段兼容读取与一致性校验（避免历史调用中断）。  
- 增加解析结果标志位（旧字段是否被使用），传递到 handler。  
- `backend/src/handlers.ts` 在命中旧字段调用时写入审计事件 `model_version_register_legacy_field_used`。

4. 验证与交付  
- 执行：`npm run typecheck`、`npm run build`、`npm run smoke:model-version-register-gate`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:ocr-fallback-guard`、`npm run docker:verify:full`。  
- 产出新的 verify 报告并确认关键链路（模型注册、推理、反馈回流）不中断。

### Assumptions
- 保留后端对旧字段兼容是为了平滑迁移，不代表产品继续推荐旧口径。  
- 本轮不改动既有流程拓扑，只做命名去敏与可审计性增强。  
- 通过 `docker:verify:full` 作为最终验收门槛。

### Execution Log
- [x] 计划已落地到本地工作文档 `PLAN_llm.md`。  
- [x] 前端旧字段暴露收敛完成。  
- [x] 后端 legacy 字段审计完成。  
- [x] 全套回归通过并更新验证报告。  
- 验证报告：`.data/verify-reports/docker-verify-full-20260421011123.json`、`.data/verify-reports/docker-verify-full-20260421011123.md`。
- [x] 前端训练证据术语从 `real` 语义统一到 `standard`（`trainingExecutionInsight` + 训练/版本/控制台页面联动）。  
- [x] 关键用户提示文案改为“标准执行证据”口径，并补齐 i18n 映射。  
- [x] 本轮验证：`npm run typecheck`、`npm run build` 通过。
- [x] 会话登录提示与模型稳定版本计数文案去除 `real` 口径（`ConversationPage` / `MyModelsPage` / `ModelsExplorePage`）。  
- [x] 后端用户提示去除 `prototype/real file` 口径（`runtimeAdapters` / `handlers`）。  
- [x] 本轮验证补充：`npm run smoke:conversation-ops-bridge` 通过。
- [x] `en-US` 文案覆盖补齐：将遗留 `real/non-real/strict real/mock-default` 语句统一为 `standard/restricted/compatibility` 口径。  
- [x] 本轮验证：`npm run typecheck`、`npm run build` 通过。
- [x] 训练创建页新增“样本文件直传/拖拽 + 文件名混合输入”能力，`Smart Launch` 在无数据集时可自动建集并上传样本（本地文件 + 文件名）后继续快照准备与训练发起。  
- [x] 自动建集流程补齐可诊断等待：轮询附件就绪状态并识别失败文件名，失败时给出明确错误信息。  
- [x] 本轮验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge` 通过。
- [x] 修复 `smoke:ocr-closure` 与严格门禁断言的默认口径冲突：严格模式默认走 `OCR_CLOSURE_REQUIRE_REAL_MODE=true`，且去除脚本内硬编码 `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1`。  
- [x] `smoke:core-closure` 中 `smoke:ocr-closure` 改为显式传入严格真实执行参数，避免环境差异导致误报。  
- [x] 本轮长链路验证：`npm run smoke:ocr-closure`、`npm run smoke:runtime-device-access`、`npm run smoke:core-closure` 全部通过。  
- [x] 对话结果卡片跳转体验增强：按 `href` 去重动作按钮，避免“Open result”与快捷链接重复；`created_entity_type=Model` 时改为深链到 `My Models` 并自动选中对应模型。  
- [x] `console_api_call` 补齐模型侧默认跳转：`list_models/create_model_draft/submit_approval_request` 现在会返回可直接落地的控制台链接。  
- [x] 本轮验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge` 通过。  
- [x] 训练任务页新增“Create next run”快速入口：从现有任务一键带入 `dataset/version/task/framework/execution_target/worker` 到创建页，减少重复选择。  
- [x] 快速入口覆盖三处：任务行动作、选中任务顶部动作区、Handoff map。  
- [x] 本轮验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene` 通过。  
- [x] 训练创建页支持 `source_job` 预填：自动从来源任务带入 `dataset/version/task/framework/base_model/config/execution_target/worker`，并保留手动可改。  
- [x] 新增“来源任务预填”提示卡：支持打开来源任务详情、清除预填上下文，以及失败可诊断提示。  
- [x] 本轮验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene` 通过。  

---

## 2026-04-21 实施补充计划（多模态 LLM 视觉任务理解与训练编排 MVP）

### Summary
在现有 `对话工作台 + 专业控制台 + 训练执行 + 模型治理` 架构上，新增 MVP 级“视觉任务理解与训练编排闭环”能力：对话动作先生成结构化任务规格与数据集检查结果，再进行 recipe 规划与训练入口判定；缺项统一走 `requires_input` 卡片并可跳转“视觉建模任务详情”页。

### Key Changes
1. 共享领域对象扩展  
- 新增 `VisionTaskSpec / DatasetProfile / TrainingPlan / ValidationReport / VisionModelingTaskRecord`。  
- `ConversationActionMetadata.created_entity_type` 扩展 `VisionTask`。

2. 后端能力新增  
- 新增任务理解与编排核心函数：  
  - `generateVisionTaskSpec`（规则+可选 LLM JSON 增强）  
  - `buildDatasetProfileForVisionTask`（数据集可训练检查）  
  - `buildTrainingPlanFromRecipe`（recipe 注册映射）  
  - `buildValidationReportFromTrainingJob`（统一验证报告）  
- `create_training_job` 对话动作接入：  
  - 上传样例图识别（仅作理解，不作训练标签）  
  - 训练入口判定失败时返回 `requires_input`（含缺项）  
  - 自动创建/更新 `VisionModelingTask` 记录并产生日志跳转。  
- 新增接口：  
  - `POST /api/vision/tasks/understand`  
  - `GET /api/vision/tasks`  
  - `GET /api/vision/tasks/:id`

3. 前端能力新增  
- 新增页面：`/vision/tasks/:taskId`（`VisionModelingTaskPage`）。  
- 展示任务规格、数据集检查、训练方案、验证报告、缺失项与快捷跳转。  
- 会话页支持 `VisionTask` 深链跳转。

### Verification
- [x] `npx tsc -p tsconfig.api.json --noEmit --incremental false`  
- [x] `npx tsc -p tsconfig.app.json --noEmit --incremental false`  
- [x] `npm run smoke:conversation-ops-bridge`  
- [x] `npm run smoke:navigation-context-hygiene`

### 继续推进（持久化与闭环补齐）
- [x] `VisionModelingTask` 接入 app-state 持久化：`backend/src/store.ts` 增加读写、清洗、重建与 minimal bootstrap 清理。  
- [x] 视觉任务页增加“一键发起训练”入口（当缺失项为 0 时自动携带 dataset/version/task/framework）。  
- [x] 模型注册后自动回写关联视觉任务（`model_version_id/model_id/status/validation_report`），闭环对象链条完整。  
- [x] 本轮验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 继续推进（自动调参与困难样本回流）
- [x] 增加 3 轮模板化自动调参候选（`auto_tune_rounds_json`）与任务阈值规则（`threshold_rule_json`），随视觉任务一起沉淀。  
- [x] 验证报告改为任务阈值判定口径（按任务类型选择主指标与阈值，输出 `pass/fail/needs_review`）。  
- [x] 新增 `POST /api/vision/tasks/:id/feedback-dataset`：按推理置信度自动采样低质量结果并写入反馈数据集。  
- [x] 视觉任务详情页新增“Mine badcases”按钮与“Open feedback dataset”快捷入口，支持一键回流。  
- [x] 本轮验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 继续推进（自动续跑与一键注册）
- [x] 新增 `POST /api/vision/tasks/:id/auto-continue`：按轮次历史自动续跑下一轮，内置阈值到达停止/运行中阻塞/轮次耗尽判定。  
- [x] 新增 `POST /api/vision/tasks/:id/register-model`：训练完成后可一键注册模型版本（自动复用或创建模型草稿）。  
- [x] 视觉任务详情页新增 `Start round 1 / Run next round / Register model` 三类快捷动作，并展示轮次历史。  
- [x] 本轮验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 继续推进（一键自动推进）
- [x] 新增 `POST /api/vision/tasks/:id/auto-advance`：按当前状态自动选择下一步（补全提示/启动训练/等待训练/注册模型/困难样本回流）。  
- [x] 视觉任务页新增 `Auto advance` 按钮，单击可自动推进到当前最优下一环节，减少人工决策成本。  
- [x] 本轮验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 继续推进（对话侧 Auto-Advance + 视觉任务列表入口）
- [x] 对话 `console bridge` 新增视觉任务 API 编排能力：`list_vision_tasks/get_vision_task/auto_continue_vision_task/auto_advance_vision_task/generate_vision_task_feedback_dataset/register_vision_task_model`。  
- [x] 自然语言意图识别、缺参检测、缺参建议、字段自动补全已覆盖 `task_id/vision_task_id`，支持“自动推进 vt-xxx”等中文口令直达。  
- [x] 会话返回动作增加视觉任务深链，`vision_task_id` 字段可直接点击跳转详情页。  
- [x] 新增视觉建模任务列表页 `/vision/tasks`（含状态筛选、Open、Auto advance 快捷动作），并接入路由与侧边栏导航。  
- [x] 本轮验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 继续推进（requires_input 可执行化 + 参数自动默认）
- [x] 会话动作卡片在 `requires_input` 状态下新增“缺项直达动作链接”生成：按缺失字段自动给出可点击入口（数据集/标注台/训练创建/模型版本/视觉任务/运行时设置等）。  
- [x] `console_api_call` 缺项流程支持更强默认补全：  
  - 视觉任务 API 缺 `task_id` 时可自动选唯一任务或最近任务；  
  - `create_training_job` 缺参时优先自动补 `dataset_id/task_type/framework/dataset_version_id/base_model/name`（可从上下文、数据集与默认规则推断）。  
- [x] 对话卡片中 `auto_continue/auto_advance/register/feedback` 链接进一步完善，直接给出训练任务/模型版本/反馈数据集落点。  
- [x] 建议按钮交互增强：在 `requires_input` 状态点击 suggestion 后会自动重试发送，不再必须手动“再发一条消息”；失败时自动回退到输入框供人工编辑。  
- [x] pending 补参链路级联化：补一个关键字段后，先执行默认参数推断，再做全量缺参判定（不再仅按旧缺项列表逐项补），支持“一次建议触发多字段补齐并推进到确认/执行”。  
- [x] 会话卡片新增“一键确认执行（Confirm now）”与“一键应用首条建议（Auto apply top suggestion）”，将确认与补参从“手输短语”进一步缩短为单击动作。  
- [x] smoke 脚本适配新增自动默认策略（兼容“先缺参”与“自动补全后进确认门禁”两种路径）。  
- [x] 本轮验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 继续推进（单击补参自动过确认门禁）
- [x] 会话动作卡片新增 `Auto fill all`，在 `requires_input` 场景可批量提取可用建议并拼装补参语句，一键重试。  
- [x] 自动补参链路新增“受控自动确认”：仅当用户主动触发自动补参后，且下一步仅剩确认门禁（无其他缺项）时，系统自动发送确认短语继续执行。  
- [x] 自动确认具备边界保护：仅跟随新返回动作、仅执行一次、会话重置/登录态清空时自动撤销，不会持续后台自动触发。  
- [x] 本轮验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 工作方式固化（文档先行）
- [x] 已按要求把“任何改动与计划必须先落地本地 md，再实施、再回填”的纪律写入项目规则文档。  
- [x] 更新位置：`PLANS.md`（新增 Documentation Discipline）与 `docs/work-handoff.md`（模板新增 `plan_md/code_changes/doc_backfill` 字段）。  

### 继续推进（控制台右侧可折叠对话 Dock）
- [x] 在非沉浸式对话路由中新增右侧可折叠对话面板，布局对齐 “VSCode + Codex” 并行操作体验。  
- [x] 面板支持：会话列表、消息浏览、输入发送、打开完整对话工作区。  
- [x] 面板与控制台页面并行可用，不打断左侧专业页面手动操作。  
- [x] 响应式策略：桌面默认显示，窄屏自动隐藏（避免挤压主工作区）。  
- [x] 本轮验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run smoke:conversation-ops-bridge`、`npm run build`。

### 继续推进（Dock 动作卡片可执行化）
- [x] 在右侧 Dock 中显示 `conversation_action` 的关键状态（Needs More Info/Completed/Failed）。  
- [x] 支持在 Dock 中直接执行建议项（含 `Auto apply top suggestion`）。  
- [x] 支持在 Dock 中直接执行确认短语（`Confirm now`）。  
- [x] 保持所有动作可一键跳转到控制台目标页面（复用 `action_links`）。  
- [x] 本轮验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 继续推进（Dock 训练操作易用性 Round 2）
- [x] 增加 Dock 内模型选择器（新建会话不再固定用第一个模型）。  
- [x] 增加 Dock 内 `Auto fill all`，对 `requires_input` 缺项进行批量补参并自动重试。  
- [x] 保持 Dock 动作执行和跳转一致，不破坏现有 `Auto apply top suggestion` / `Confirm now`。  
- [x] 本轮验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:i18n-key-hygiene`、`npm run build`。

### 继续推进（Dock 附件上下文能力 Round 3）
- [x] Dock 内接入会话附件上下文（ready 文件可选中/取消）。  
- [x] 发送消息时携带所选附件 ID，不再固定空附件列表。  
- [x] 增加“一键使用全部 ready 文件/清空上下文”快捷操作。  

### 继续推进（Dock 附件体验 Round 4：状态可见 + 直达查看）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] Dock 附件区从“仅 ready”升级为“最近附件（含 uploading/processing/error/ready）”统一展示。  
- [x] 非 ready 附件显示状态徽标并禁用选择；ready 附件保持可点击选中。  
- [x] 增加“Open file”快捷入口，可从 Dock 直接打开附件内容，减少页面切换。  
- [x] 顶部统计补充 `Pending` 计数，帮助用户判断是否可立即发送。  
- [x] 新增文案补齐 i18n 映射（`Pending/Open file/Uploading/Processing/Error`），避免中文界面出现英文键名。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（Dock 附件治理 Round 5：失败清理 + 单条删除）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 增加附件统计中的 `Failed` 计数，快速定位失败文件规模。  
- [x] 增加单条附件 `Remove file` 操作（含进行中状态），便于及时清理无效上下文。  
- [x] 增加批量 `Clear failed files` 操作，减少重复点击。  
- [x] 错误附件展示失败原因（`upload_error`），减少“为什么失败”的排查成本。  
- [x] 新增文案补齐 i18n 映射（`Failed/Clear failed files/Remove file`）。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（Dock 编排效率 Round 6：页面上下文一键带入）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 从当前控制台路由与关键查询参数生成 `page context prompt`，传入右侧 Dock。  
- [x] Dock 新增 `Use page context`：将页面上下文自动注入输入框，减少手打描述。  
- [x] Dock 新增 `Ask next step`：基于页面上下文一键发问下一步操作建议。  
- [x] UI 提示当前页面上下文已就绪，保持“页面操作 + 对话编排”一体化体验。  
- [x] 新增文案补齐 i18n 映射（`Use page context/Ask next step/页面上下文引导提示`）。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（会话历史可用性修复 Round 7：遮挡 + 批量删除）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 修复历史项长标题导致三点按钮被挤压/遮挡：调整 `chat-history-item-shell/open/more` 的 flex 约束。  
- [x] 修复删除逻辑中“会话已不存在”异常导致的本地残留：将 `Conversation not found` 视为幂等删除成功。  
- [x] 批量清空历史时，对“已不存在”项执行本地清理，避免幽灵记录反复出现。  
- [x] 增加 `clear history` 并发保护与“清除中”状态，避免重复触发导致状态错乱。  
- [x] 删除会话后同步清理 pinned 顺序，避免残留置顶引用。  
- [x] 补充触屏兜底：在非 hover/coarse pointer 设备上三点菜单保持可见可点。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run build`。  

### 继续推进（真实使用体验巡检 Round 8：批量更新容错）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 数据集样本批量更新从“单条失败导致整批失败”改为 `allSettled` 容错执行。  
- [x] 支持部分失败反馈：展示“成功/失败数量”，并自动保留失败样本为选中状态，便于重试。  
- [x] 当所选样本无需变更时，给出“无需更新”明确反馈，减少误操作感。  
- [x] 补齐 i18n 文案映射（批量更新部分失败/无需更新）。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run build`。  

### 继续推进（删除链路一致性 Round 9：后端幂等收口）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 后端 `deleteConversation` 对“记录不存在”场景改为幂等成功返回，避免客户端重试时误报失败。  
- [x] 保留权限边界：会话存在但无权限时仍拒绝。  
- [x] 验证通过：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npm run build`。  
- [x] 后端 `removeModelByAdmin/removeTrainingWorkerByAdmin` 也补齐幂等删除（目标不存在时返回成功），提升多端并发与重试稳定性。  
- [x] 保留治理边界：管理员权限与在途任务阻断策略不放松。  

### 继续推进（删除交互抗抖 Round 10：防重复触发 + 选择态收敛）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] `MyModelsPage/ModelsExplorePage` 删除模型加入前端同步锁，避免高频点击触发并发删除请求。  
- [x] `WorkerSettingsPage` 删除 worker 加入前端同步锁，避免确认弹窗连点触发重复删除。  
- [x] 删除后补齐本地选择态收敛：清理失效的 `selectedWorkerId/removingWorker`，避免幽灵选中态。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:conversation-ops-bridge`、`npm run build`。  

### 继续推进（删除后上下文收敛 Round 11：列表一致性 + 过滤提示）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] `MyModelsPage/ModelsExplorePage` 删除成功后先做本地状态收敛（models/versions），即使刷新失败也不回弹幽灵项。  
- [x] 删除后的后台刷新失败与删除动作解耦：保留删除成功反馈，并继续后台刷新同步。  
- [x] `ModelsExplorePage` 增加“筛选导致列表为空”的显式告警与一键清筛选，降低“删除后页面像丢数据”的误判。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:i18n-key-hygiene`、`npm run build`。  

### 继续推进（删除反馈一致性 Round 12：成功反馈与后台同步解耦）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] `MyModelsPage/ModelsExplorePage` 新增 `background` 刷新模式：删除后后台同步失败不覆盖删除成功状态。  
- [x] 删除成功后改为触发后台温和同步提示（可重试），避免“已删成功却显示失败”造成误判。  
- [x] 补齐新增提示的 i18n 映射（中文界面不出现英文键名）。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:i18n-key-hygiene`、`npm run build`。  

### 继续推进（附件删除一致性 Round 13：本地先收敛 + 异步同步）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] `DatasetDetail/InferenceValidation/TrainingClosure/CreateModel` 的附件删除改为“本地先收敛（列表即时消失）+ 后台刷新同步”，降低误判与等待感。  
- [x] 删除后若仅后台同步失败，不再把操作判定为失败；改为温和提示“本地已生效，可刷新重试同步”。  
- [x] 清理删除后的本地选择态（如已选附件/样本），避免残留指向不存在对象。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:i18n-key-hygiene`、`npm run build`。  

### 继续推进（附件交互精细化 Round 14：单条删除独立 Loading）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] `AttachmentUploader` 从“全局 pending 锁死所有附件操作”改为“上传态与单条删除态分离”，避免误触和等待焦虑。  
- [x] 删除动作改为每条附件独立 `Deleting...` 状态，不影响其他附件查看和页面其他区域操作。  
- [x] 保持上传链路防并发保护（上传时禁用上传入口），但不再把整块附件列表统一冻结到不可理解。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:i18n-key-hygiene`、`npm run build`。  

### 继续推进（核心流程验收 Round 15：对话训练门禁脚本对齐）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 修正 `scripts/smoke-conversation-actions.sh`：对齐新版训练前置门禁（`dataset_version_id + acceptance_target + example_images`）。  
- [x] 调整脚本中的自动准备检测数据集策略，避免构造 `missing_validation_split` 的非训练态数据。  
- [x] 通过补参链路完成对话训练任务创建，并保留确认门禁兼容断言（确认消息保留示例图片附件）。  
- [x] 验证通过：`npm run smoke:conversation-actions`、`npm run smoke:core-closure`。  

### 继续推进（会话历史可用性 Round 16：长标题遮挡 + 全量清空）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 修复会话历史项布局：长标题情况下仍稳定保留右侧“更多操作”按钮可见且可点击。  
- [x] 修复“清空历史”删除范围：先拉取当前账号全量会话 ID，再执行批量删除；本地可见列表只作为兜底补集。  
- [x] 保持幂等容错：会话已不存在仍视为删除成功，不阻断批量清理。  
- [x] 验证通过：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（会话历史可用性 Round 17：批量清理接口 + 前端兜底）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 新增后端 `POST /api/conversations/clear`：按当前账号可见范围批量清理会话，返回 `deleted_ids/failed_ids`。  
- [x] 前端清空历史优先调用批量接口，失败时回退到逐条删除路径（保证兼容与鲁棒）。  
- [x] 文案与行为对齐：确认提示改为“当前账号全部会话历史”，避免“可见”口径歧义。  
- [x] 回归验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（会话历史可用性 Round 18：专项回归脚本）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 新增 `scripts/smoke-conversation-history-clear.sh`：覆盖“创建会话 -> 批量清空 -> 二次幂等清空”端到端校验。  
- [x] 增加 npm 脚本 `smoke:conversation-history-clear`，并接入 `smoke:core-closure`。  
- [x] 回归验证：`npm run smoke:conversation-history-clear`、`npm run smoke:core-closure`。  

### 继续推进（会话历史可用性 Round 19：隐藏 ID 自动收敛）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] `refreshConversations` 增加 hidden-id 自动清理：仅保留仍存在于服务端列表中的隐藏项，避免陈旧隐藏状态长期堆积。  
- [x] 清空历史成功后优化隐藏状态：全量成功时直接清空 hidden-id 与 pinned 关联残留；部分失败时保持必要隐藏项。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:conversation-history-clear`、`npm run smoke:conversation-ops-bridge`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练批量操作可用性 Round 20：并发执行 + 统计不降级）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 将训练页 `retryVisibleJobs/cancelVisibleActiveJobs` 从串行循环改为并发执行，降低批量操作等待时间。  
- [x] 保留并增强失败统计与首条错误信息展示，确保可诊断性不下降。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（数据页批量治理 Round 21：样本批量删除）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 新增后端接口 `DELETE /api/datasets/:datasetId/items/:itemId`，支持样本删除并级联清理关联标注与复核记录。  
- [x] 前端 Dataset 批量操作区新增“删除已选”按钮，支持批量删除、部分失败保留失败项选中、首条错误可诊断。  
- [x] i18n 补齐批量删除确认与结果反馈文案，保证中文界面完整可读。  
- [x] 回归验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:i18n-key-hygiene`、`npm run smoke:navigation-context-hygiene`、`npm run smoke:phase2`、`npm run build`。  

### 继续推进（数据一致性 Round 22：删除级联完整性）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] `removeDatasetItem` 增补附件级联策略：当样本删除后附件无其他引用时，自动删除附件记录与本地二进制文件。  
- [x] `removeAttachment` 增补标注级联策略：删除数据集附件导致样本移除时，同步清理关联标注与复核记录。  
- [x] 回归验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npm run smoke:phase2`、`npm run build`。  

### 继续推进（数据一致性 Round 23：删除链路专项 smoke）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 新增 `scripts/smoke-dataset-delete-consistency.sh`，覆盖两条删除链路：`删除样本` 与 `删除附件`，并校验 item/attachment/annotation 同步清理。  
- [x] 增加 npm 脚本 `smoke:dataset-delete-consistency`。  
- [x] 回归验证：`npx tsc -p tsconfig.api.json --noEmit --incremental false`、`npm run smoke:dataset-delete-consistency`、`npm run smoke:phase2`、`npm run build`。  

### 继续推进（数据一致性 Round 24：纳入主闭环验收）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 将 `smoke:dataset-delete-consistency` 接入 `scripts/smoke-core-closure.sh`，作为核心闭环固定回归项。  
- [x] 回归验证：`npm run smoke:dataset-delete-consistency`、`npm run smoke:core-closure`。  

### 继续推进（训练操作易用性 Round 25：高风险动作防误触）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 在训练页为高风险动作增加确认门禁：`取消单任务`、`重试单任务`、`批量取消`、`批量重试`。  
- [x] 保持原有成功/失败反馈与并发执行逻辑不变，仅补充确认文案和取消分支。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 26：进行中反馈与防连击）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 在训练页补充“进行中”文案反馈，明确当前正在执行的取消/重试动作。  
- [x] 操作执行期间禁用列表内触发型动作按钮，减少重复提交与竞态。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 27：操作中防切换与状态保持）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 操作执行中锁定关键切换入口（列表行切换、抽屉上一条/下一条）以减少状态漂移。  
- [x] 选择变更时仅在非 busy 状态清空“进行中”文案，避免执行中反馈被意外抹掉。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 28：最近操作摘要）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 在训练页新增“最近操作摘要”面板，记录单条/批量取消与重试的结果。  
- [x] 摘要内容至少包含：时间、动作、对象范围、成功/失败计数或关键错误。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 29：日志筛选与错误摘要复制）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 最近操作摘要支持筛选：`全部`、`仅失败`、`仅批量`。  
- [x] 对失败项提供“一键复制错误摘要”按钮，便于快速粘贴到排障沟通。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 30：日志条目直达任务详情）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 最近操作摘要支持与任务对象联动：单任务操作可一键直达对应任务详情。  
- [x] 批量操作条目至少支持直达一个代表任务（首个成功或失败任务），减少“知道失败但找不到对象”的成本。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 31：日志定位与上下文联动）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 最近操作摘要新增“定位到队列”入口：点击后自动聚焦对应任务并打开抽屉。  
- [x] 定位动作自动带入任务上下文筛选（任务类型/框架/队列阶段），降低手工筛选成本。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 32：日志高亮与自动滚动）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 日志定位动作附带来源日志 ID，并在返回训练页时高亮对应日志条目。  
- [x] 若来源日志被当前筛选隐藏，自动回退到“全部”并滚动到该日志位置。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 33：定位标记清理）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 当页面处于 `op_log` 定位态时，提供“清除定位标记”操作，恢复普通浏览状态。  
- [x] 清理动作仅移除 `op_log` 查询参数，不影响当前筛选与选中任务上下文。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 34：定位专注模式）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 当 `op_log` 存在时进入“定位专注模式”：默认仅展示该条日志，减少干扰。  
- [x] 提供“查看全部日志 / 返回定位日志”切换，便于在专注排障与全局回顾之间快速切换。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 35：日志分组与折叠浏览）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 最近操作摘要按时间分组展示（今天/昨天/更早），提升多条记录下的可读性。  
- [x] 分组支持折叠/展开，并与现有筛选（全部/失败/批量）和定位专注模式兼容。  
- [x] 定位日志仍可见且保持高亮，必要时自动展开所在分组。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 36：分组批量操作与状态记忆）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 最近操作摘要新增“全部展开/全部折叠”，降低多分组时逐组点击成本。  
- [x] 分组折叠状态持久化到本地（刷新后保留用户偏好），并兼容定位自动展开。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 37：失败快速定位）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 最近操作摘要增加失败统计提示（总条数/失败条数），帮助快速判断风险密度。  
- [x] 增加“一键定位首个失败项”按钮：自动展开所在分组并滚动到对应日志。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 38：失败日志到详情排障联动）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 训练页失败日志新增“带上下文打开日志详情”入口，跳转时携带 `evidence=logs` 与错误摘要提示。  
- [x] 任务详情页日志视图支持读取错误提示并展示匹配日志片段，降低人工翻找成本。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 39：失败上下文清理与视图回切）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 任务详情日志视图新增“清除失败上下文”动作，仅移除 `error_hint` 参数。  
- [x] 失败上下文卡片新增“回到概览”动作，帮助从排障态快速切回常规视图。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 40：匹配日志逐条跳读）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 失败上下文面板支持“上一条/下一条命中日志”切换，并显示当前位置（x / n）。  
- [x] 当前命中项在匹配列表中高亮，提升长日志排障时的扫描效率。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 41：命中项与完整日志联动）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 失败上下文面板新增“在完整日志中查看”动作：自动展开到命中行所在区域并滚动到日志块。  
- [x] 增加“命中上下文（前后若干行）”预览，帮助快速判断前后因果。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 42：匹配关键词可编辑重试）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 任务详情失败上下文面板新增“匹配关键词”输入框，支持直接微调关键词重跑匹配。  
- [x] 支持一键恢复为原始失败摘要关键词，减少误改后手工回填成本。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 43：匹配关键词 URL 同步）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 任务详情页将“匹配关键词”同步到 URL 查询参数，刷新后保留当前排障状态。  
- [x] 支持分享链接复现同一关键词匹配视图，清空关键词时自动移除对应参数。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 44：排障包一键复制）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 任务详情失败上下文面板新增“复制排障包”按钮，自动打包关键词、命中行、上下文片段与当前链接。  
- [x] 增加复制成功/失败反馈，减少人工整理与沟通往返。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 45：建议下一步自动化）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 任务详情失败上下文面板新增“建议下一步”自动分析（基于关键词/命中日志），减少人工判断。  
- [x] 建议项支持一键动作（打开运行时设置/打开 worker 设置/切换 control-plane 重试/刷新详情）。  
- [x] 复制排障包自动附带“建议下一步”清单，便于跨人协作直接执行。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 46：建议动作一键执行与回显）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 失败上下文面板新增“执行首条建议”入口，减少逐条点选操作。  
- [x] 建议卡片动作统一走执行器，并在当前页回显执行结果（成功/失败/处理中）。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 47：建议执行后自动重试）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 当首条建议为 `control-plane` 重试时，新增“一键应用并立即重试”入口，减少二次点击。  
- [x] 自动重试结果在当前页回显，并与现有 busy 状态联动防止重复触发。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（训练操作易用性 Round 48：首条建议自动链式执行）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] “执行首条建议”自动识别可链式场景（control-plane 建议 + 可重试），直接执行“应用并重试”。  
- [x] 自动重试成功后自动切换到日志视图，减少用户回到日志页的额外操作。  
- [x] 回归验证：`npx tsc -p tsconfig.app.json --noEmit --incremental false`、`npm run smoke:navigation-context-hygiene`、`npm run build`。  

### 继续推进（计划完成度验收 Round 49：闭环与严格口径复核）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 核心闭环复核：`smoke:ocr-closure`、`smoke:training-worker-dedicated-auth`、`smoke:runtime-device-access` 全部通过。  
- [x] 严格真实口径复核：`REAL_CLOSURE_STRICT_REGISTRATION=true + REAL_CLOSURE_REQUIRE_REAL_MODE=true` 通过，且 `registration_gate_exempted=false`。  
- [x] 纯真实注册口径复核：`REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION=true` 通过，且 OCR 注册证据为 `real`。  
- [x] 关键产物链路复核：训练任务、模型版本、推理运行、反馈数据集四类对象均持续产出。  

### 继续推进（计划收口 Round 50：一键验收脚本固化）
- [x] 计划先落地到本地 `PLAN_llm.md`，再实施、再回填。  
- [x] 新增 `scripts/smoke-plan-llm-complete.sh`，串联执行计划收口所需关键验收项。  
- [x] `package.json` 增加 `npm run smoke:plan-llm-complete` 快捷入口，降低人工逐条执行成本。  
- [x] 轻量校验通过：脚本语法与关键导航 smoke 可用。  
