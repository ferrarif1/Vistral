# 用户流程（中文版）

## 1. 概述
本文档定义 Vistral 当前可执行流程，覆盖 AI-native 对话入口与专业工程台入口。

## 2. Flow A：对话 + 附件闭环（已实现）
执行者：`user`

1. 进入 `/workspace/chat`
2. 从整理后的基座模型目录中选择模型，并可随时新建对话
3. 通过左侧底部账户区或折叠 rail 头像打开账户菜单，在同一弹层里切换语言并进入设置/退出登录（紧凑或移动端仍可在页头保留登录入口兜底）
4. 可按需折叠桌面侧栏以扩大会话画布，或在移动端通过页头打开/关闭侧栏抽屉
5. 点击 `+` 打开输入区附件托盘，再为当前草稿上传或选择附件
6. 已选草稿附件以标签形式显示，带状态与移除能力
7. 发送消息
8. 系统发起会话并返回助手回复（mock 或已配置 LLM）
9. 发送后附件托盘收起，已发送附件可在对应消息轮次中追溯
10. 会话栏可从后端同步历史并点击恢复完整消息时间线
11. 桌面端鼠标移入会话行后会显示紧凑的三点溢出按钮；点击三点、右键，或移动端长按都可打开快捷菜单
12. 快捷菜单把重命名/置顶/删除动作收纳起来，默认列表只保留点击整行进入会话
13. 菜单打开后可使用快捷键 `R/P/D` 快速执行对应动作
14. 用户可在 Pinned 分组内拖拽调整会话优先级
15. 用户在同一上下文中继续多轮对话

访客 / 账户分支：
1. 未登录用户打开需要登录的页面
2. 系统仅提供登录入口
3. 如果用户需要新账号，需联系管理员开通

同线程操作执行分支：
1. 用户在对话中要求执行真实配置动作（如创建数据集 / 创建模型草稿 / 创建训练任务）
2. 系统从当前轮输入与未完成的对话动作上下文中解析意图和已知字段
3. 若关键字段缺失，助手返回 `requires_input` 卡片，列出缺失字段与可选建议
3a. 对于标注/审核/训练/推理等复杂意图，`requires_input` 卡片可附带直达链接（`action_links`），便于跳转到对应工作区补齐参数
4. 对高风险变更（如 `create_*` 与控制台 bridge mutating API），字段补齐后需先显式确认（`确认执行` / `confirm execute`）
5. 用户在后续轮次给出确认口令
6. 系统仅在确认后调用后端 API 执行变更
7. 助手返回 `completed` 或 `failed` 卡片，展示结果与下一步建议
8. 高阶用户可使用 `/ops {json}` 直接走控制台桥接；普通用户自然语言也可路由到同一 bridge；高风险调用同样受确认门禁约束
8a. 当 `/ops {json}` 或自然语言 bridge 参数不完整时，必须返回 `requires_input`，并支持后续仅补缺失字段继续执行（含确认门禁续跑）
8b. Runtime 配置动作也可通过 bridge 执行（`activate_runtime_profile`、`auto_configure_runtime_settings`），两者同样必须经过显式高风险确认

附件状态：
- `uploading`
- `processing`
- `ready`
- `error`

## 2.1 Flow A1：共享导航壳层（已实现）
执行者：`user` / `admin`

1. 进入任意共享壳层路由（如 `/datasets`、`/training/jobs`、`/models/explore`）
2. 使用左侧分组导航在工作区、构建/运行流程、治理页面，以及唯一的顶层设置入口之间切换
3. 桌面端左侧栏保持固定视口高度，导航或内容区在内部滚动，而不是把整页壳层继续拉长
4. 可按需折叠低优先级导航分组，让左侧面板只保留当前更相关的工作线
5. 如需更宽内容区域，可将桌面端侧栏折叠为紧凑 rail
6. 移动端通过页头打开导航抽屉，并通过遮罩或关闭动作收起
7. 桌面端统一从左侧底部账户区或紧凑 rail 头像打开共享账号菜单，直接进入设置或退出登录；紧凑/移动视口可继续通过页头兜底
8. 在不丢失当前路由上下文与页脚控制项（如语言/会话状态）的前提下继续当前任务

说明：
- `/workspace/console` 现保持在共享应用壳层，并统一为专业工作台结构（顶部工具栏 + 中间主区 + 右侧检查器），滚动按区域拆分。

## 2.2 Flow A2：统一设置页（已实现）
执行者：`user` / `admin`

1. 从控制台左侧栏唯一的 Settings 入口进入 `/settings`
2. 默认落到 `Account` 子选项卡，并在页头清晰显示当前所在子页
3. 所有已登录用户都可通过“当前密码 + 新密码”修改自己的密码
4. 管理员可在同一 `Account` 子页开通账户，并选择新账号角色
5. 管理员可查看账号目录，并在操作前按角色、状态或关键词筛选账号
6. 管理员可直接在目录中重置其他用户密码
7. 停用账号前，管理员必须先在目录内联填写停用原因再确认
8. 已停用账号会在目录中持续展示该停用原因，并把同样原因写入审计元数据
9. 管理员可直接在目录中恢复账号；恢复后会清空此前记录的停用原因
10. 停用账号会立即终止该账号当前活跃会话，因此恢复后用户也需要重新登录
11. 系统会阻止危险操作，例如停用当前管理员会话或停用最后一个仍激活的管理员账号
12. 通过页面内部子选项卡在 `Account`、`LLM`、`Runtime`、`Runtime Templates` 与 `Workers` 之间切换，而不是在全局导航里来回寻找
13. 也可直接使用 `/settings/account`、`/settings/llm`、`/settings/runtime`、`/settings/runtime/templates` 或 `/settings/workers` 深链接打开指定子页
14. 在 `Runtime` 子页，管理员可使用一键自动配置：自动补齐空本地命令并探测候选端点（保守模式仅补空；覆盖模式可替换已有端点）
15. 当 `Runtime` 还没有 UI 保存配置时，页面首次加载会自动触发一次“保守自动配置”，进一步减少首启手工配置
16. Runtime framework 配置卡还支持“模型感知路由”：
   - 可为每个 framework 选择默认模型与可选默认模型版本
   - 可为远程端点绑定模型级密钥（`model:<model_id>` / `model_version:<model_version_id>`）
   - 本地模式不显示 API key，始终使用显式 `model_id` + `model_version_id` 调用本地命令
17. `Runtime Templates` 子页是独立 Runtime 连接模板入口：
   - 提供可复制的环境变量名与 endpoint 示例
   - 提供 health check curl、请求/响应示例骨架
   - 不承载 runtime 就绪状态机、worker 生命周期操作或 profile 激活动作
18. `Workers` 子页是独立 Worker 运维入口：
   - Worker 注册表与状态动作
   - 引导式 Add Worker 配对与回调验证
   - Worker 激活 / 重配置后续

## 2.3 Flow A3：首次使用引导（实现中）
执行者：`新用户`（对产品几乎不了解）

1. 用户首次进入 `/workspace/console`
2. 系统展示“新手引导卡片”，用通俗语言呈现主闭环路径：
   - `数据准备 -> 标注/复核 -> 训练 -> 版本注册 -> 推理验证 -> 错样回流`
3. 每个步骤提供直达入口，并展示基于真实工作区数据的完成信号
4. 用户可以先关闭引导，后续在同一入口再次打开
4a. 页面右上角应保留固定帮助入口，即使用户隐藏了内联引导卡，也能随时重新打开当前页面提示
4b. 固定帮助入口应展示当前“建议下一步”（第一个未完成步骤）及其直达动作，这样新手不需要自己从整份清单里判断下一次点击
4c. 用户首次进入带引导的页面时，固定帮助入口可自动轻量展开一次；用户关闭后，后续访问应保持安静，除非手动重新打开
4d. 在 `/workspace/console` 首页，主工作区还应同步用独立卡片展示这条“首任务”，确保即使其他仪表内容还很稀疏，用户也始终能看到一个明确的下一步动作
5. 当某一步还没有真实记录时，引导卡片与空态需要明确说明“为什么要做”和“下一步点哪里”
5a. 页面级引导卡也应支持在当前页直接隐藏/重新显示，且“步骤未完成”不能让隐藏操作失效
5b. 当内联引导处于显示状态时，默认应保持紧凑摘要（`这页做什么` + `建议下一步`），完整步骤清单仅在用户主动展开或打开固定帮助弹层时展示
6. 关键运营页面也要提供轻量级页面引导卡，并使用相同闭环语言：
   - `/models/explore`：解释如何浏览模型目录、识别就绪/风险信号，以及何时进入“我的模型”或版本页
   - `/models/my-models`：解释草稿、待审批、可用模型如何在个人工作线中推进
   - `/models/create`：解释模型草稿向导（`元数据 -> 工件上传 -> 参数 -> 提交审批`）
   - `/datasets`：解释数据准备作用，在主工作区显式展示一个首任务，并在空态时提供直达页内创建面板的动作
   - `/datasets/:datasetId`：解释上传/切分/版本进度，在主工作区同步镜像当前下一步，并展示队列与版本后续入口
   - `/datasets/:datasetId/annotate`：解释复核队列操作，在主工作区与队列空态同步镜像当前下一步，并保留“回到数据集 / 前往验证”入口
   - `/training/jobs`：解释 active 与 terminal 队列语义，在主工作区同步镜像一个当前下一步，并保留清晰的新建/详情入口
   - `/training/jobs/new`：解释版本快照训练与启动就绪门禁，并在主工作区同步镜像一个当前训练准备动作
   - `/training/jobs/:jobId`：解释如何阅读当前状态、何时出现日志/指标，以及如何回到数据集或验证工作线
   - `/models/versions`：解释训练完成证据、版本注册动作与版本血缘核查跟进，并在主工作区及版本空态/未选择空态同步镜像当前第一个未完成步骤
   - `/inference/validate`：解释验证结果与错样回流如何闭合循环，并在主工作区以及 `No Model Versions Yet`、`No Ready Inputs Yet`、`No Runs Yet` 等关键空态同步镜像当前第一个未完成步骤
   - `/admin/models/pending`：向管理员解释审批职责（`查看请求 -> 做出决定 -> 留存审计链路`）
   - `/admin/audit`：解释如何阅读治理记录、区分用户事件与系统事件，并继续进入相邻管理工作线
   - `/admin/verification-reports`：强调该页单一主任务：筛选、审查并导出部署验证报告，用于发布治理
   - `/settings/account`：解释账户首启路径（确认身份 -> 修改密码 -> 按角色治理 -> 前往下一项设置），并在主工作区及目录空态中镜像当前第一个未完成步骤
   - `/settings/llm`：解释 LLM 首启路径（预设 -> 填 key -> 启用 -> 测试 -> 回到对话），并在主工作区及关键受阻状态中镜像当前第一个未完成步骤
   - `/settings/runtime`：解释 runtime 首启路径（配置 -> 激活 profile -> 就绪检查 -> 前往验证），并在主工作区及配置/就绪空态中镜像当前第一个未完成步骤
   - `/settings/runtime/templates`：解释 Runtime 连接模板（环境变量/curl/请求响应示例）如何复制使用，并保持该页仅承载模板内容，再通过入口回到 Runtime 配置页完成真实配置
   - `/settings/workers`：解释 worker 上线路径（注册/配对 -> 回调验证 -> 激活 -> 监控容量），并保持一个明确的下一步动作

## 3. Flow B：模型草稿 -> 提交审批（已实现）
执行者：具备能力的 `user`

1. 进入 `/models/create`
2. 顶部 stepper：元数据 -> 模型文件 -> 参数 -> 复核
3. 上传模型文件（可见/可删/有状态）
4. 高级参数默认折叠
5. 提交审批（mock）

管理员审核路径：
- `/admin/models/pending` 审批通过/拒绝
- `/admin/audit` 查看审计记录
- 管理员也可在模型目录中删除符合条件的非基座模型；删除成功后会一并清理模型附件与关联审批请求，并记录审计日志
- 若模型仍被模型版本或会话引用，则删除必须被阻止，并明确提示先处理这些依赖

## 4. Flow C：数据集管理（Phase 1 骨架，已实现）
执行者：`user`

1. 进入 `/datasets`
2. 创建 `task_type` 数据集
3. 进入 `/datasets/:datasetId`
4. 上传数据集文件
5. 执行 `train/val/test` 切分
6. 创建数据集版本快照

## 4.1 Flow C1：样本浏览与批量整理（演进轨道）
执行者：`user`

1. 进入 `/datasets/:datasetId`
2. 按任务选择样本视图（`grid` / `list`）
3. 使用快速筛选（搜索、split、样本状态、队列状态、class/tag/metadata 提示）
4. metadata 筛选同时支持模糊关键词与 `key=value` 表达式（例如 `source=inference_feedback`、`feedback_reason=missing_detection`、`tag:low_confidence=true`）
5. 从筛选结果中批量选择样本
6. 在统一批量动作条中执行样本更新（如 split/status/metadata）
7. 可将当前筛选（含切片衍生筛选）保存为可复用视图，并在页面内应用/删除
8. 观察队列分布变化（`needs_work` / `in_review` / `rejected` / `approved`）
9. 带队列与样本上下文跳转到标注工作台继续处理（若来自数据集版本快照则同时保留 `version` 上下文）
10. 从数据集版本动作直达训练任务或推理验证，并保留上下文查询参数（`/training/jobs?dataset=<id>&version=<id>`、`/inference/validate?dataset=<id>&version=<id>`）

## 5. Flow D：在线标注工作流（Phase 2 最小可用）
执行者：`user`（标注），`user/admin`（具能力审核）

状态机：
- `unannotated -> in_progress -> annotated -> in_review -> approved`
- 拒绝回退：`in_review -> rejected -> in_progress`

最小动作：
- 检测框标注（绘制/移动/缩放）
- OCR 文本标注
- 分割多边形最小输入
- 保存、撤销、继续编辑
- 提交审核、通过/拒绝
- 拒绝时必须填写明确原因编码
- 返工时持续显示最近一次审核上下文

当前阶段目标：
1. 进入 `/datasets/:datasetId`
2. 查看标注摘要，并从 `needs_work` / `in_review` / `rejected` / `approved` 队列跳转
3. 进入 `/datasets/:datasetId/annotate`（可选 `?version=<dataset_version_id>`，用于在复核时保留版本上下文）
4. 直接恢复指定样本或队列上下文
5. 队列筛选（搜索/split/样本状态/metadata/低置信）会以“生效筛选标签”形式持续可见，并支持一键清空
6. metadata 快捷筛选可一键填充常见排查模式（`tag:low_confidence=true`、`inference_run_id`、高频 `feedback_reason`）
7. 编辑 OCR/检测标注
8. 保存为 `in_progress` 或 `annotated`
9. 提交 `annotated -> in_review`
10. 审核为 `approved` 或 `rejected`
11. 条目一旦进入 `in_review`，标注内容在 upsert 路径下应变为只读；后续只能通过审核接口进入 `approved` / `rejected`
12. 若为 `rejected`，必须填写 `review_reason_code`，且返工时继续展示最近审核原因与备注；当条目移回 `in_progress` 时，应保持当前样本打开并自动落到 `needs_work` 队列，之后才能继续编辑

## 5.1 Flow D1：单样本复核工作台（演进轨道）
执行者：`user`（具标注/审核能力）

1. 从队列或样本浏览器打开目标样本
2. 在同一屏查看样本预览、标注内容、元数据与最近审核上下文
3. 在可用时对比预测 overlay 与当前标注
4. 不离开当前工作台直接完成标注更新或审核决策
5. 通过快捷键或按钮推进到下一条队列样本

## 6. Flow E：训练任务流程（Phase 1 骨架，Phase 3 runtime）
执行者：`user`

1. 进入 `/training/jobs/new`
2. 顶部 stepper：
   - Step 1 任务类型 + 框架
   - Step 2 数据集 + 数据集版本快照 + 基座模型
   - Step 3 参数（高级参数默认折叠）
   - Step 4 复核 + 提交
3. 选择数据集版本快照，确认启动准备摘要（数据集状态 / 切分摘要 / 标注覆盖率）后再创建训练任务
   - 当 `split_summary.train <= 0` 或 `annotation_coverage <= 0` 时，禁止启动训练
4. 任务状态流转：
   - `draft`
   - `queued`
   - `preparing`
   - `running`
   - `evaluating`
   - `completed`（或 `failed` / `cancelled`）
5. 在 `/training/jobs/:jobId` 查看日志与指标
6. 在任务详情页可带相同数据集/版本上下文跳转到推理验证和任务列表范围视图
6a. 当已完成任务没有与其任务类型匹配的自有模型时，任务详情页应直接提供带任务类型预填的模型草稿创建入口，方便先补模型再注册版本
6b. 从已完成任务打开的模型草稿页应持续保留版本注册回流入口，方便使用同一个任务上下文返回
7. 从范围任务列表进入任务详情时，应持续保留 `dataset`、`version` 查询上下文
8. 当已完成任务准备进入版本注册时，直接打开 `/models/versions` 并预填该任务，让版本注册从这次训练结果开始
9. 版本注册仍需要选择一个自有模型，但已完成任务和建议版本名应当默认填好

## 7. Flow F：模型版本注册
执行者：`user`

1. 训练任务完成后，且 `execution_mode=local_command` 时才可注册模型版本
1a. 若产物摘要显示为非真实本地执行（`mode=template`、存在 `fallback_reason`、或 `training_performed=false`），必须阻止注册；仅在显式设置 `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1` 时可放开
2. 在 `/models/versions` 发起注册
2a. 如果已完成任务没有任何与其任务类型匹配的自有模型，注册界面应直接给出带该任务类型预填的模型草稿创建入口，而不是静默选中不相关模型
2b. 注册成功后，页面应直接给出新版本的推理验证下一步入口
3. 版本关联模型 + 数据集 + 训练任务 + 指标摘要

## 8. Flow G：推理验证 + 错误回流
执行者：`user`

1. 进入 `/inference/validate`
2. 查看 runtime 摘要（reachable/unreachable/not configured）；若需排障或改配置，跳转 `/settings/runtime`
3. 上传推理图片
4. 选择模型版本
4a. 页面同时支持通过 `?modelVersion=<id>` 直接预填模型版本，供聊天/动作链接使用；而 `?dataset=<id>&version=<id>` 仍保留为数据集版本上下文，用于反馈回流跳转
5. 执行推理
6. 查看可视化结果 + raw 输出 + normalized 输出
6a. 若 `source` 命中 `mock/template/fallback` 或 raw 中存在 fallback reason，页面必须明确提示“当前结果为回退/模板结果，不是真实 OCR 识别”
6b. 若 OCR 在回退路径中未产生文本行，页面必须提示“未识别到文本 / 本次运行未产生真实 OCR 结果”
7. 错样一键回流到任务类型匹配的数据集
8. 推理验证侧栏动作仅保留一个带上下文的标注队列直达入口，避免在验证页并行拉起训练任务域
9. 标注快捷入口额外携带 `meta=inference_run_id=<run_id>`，可在标注工作区直接预筛选当前推理运行的回流样本
10. 远程推理鉴权 key 解析顺序：
    - 先用 `model_version:<model_version_id>` 绑定密钥
    - 再用 `model:<model_id>` 绑定密钥
    - 最后回退到 framework 级 `api_key`
11. 无 Web 会话的远程客户端可直接调用 Bearer-key 公共 Runtime 接口：
    - `POST /api/runtime/public/inference`（内联 base64 输入）
    - `POST /api/runtime/public/model-package`（返回 AES-256-GCM 加密模型工件 payload）
11a. 跨机器模型下发时，worker 可通过 `POST /api/worker/models/pull-encrypted` 拉取并本地解密部署模型：
    - 接口使用 worker token 鉴权
    - worker 内部调用 `POST /api/runtime/public/model-package`（runtime bearer key）

## 9. 闭环业务 1：OCR 微调
1. 创建 OCR 数据集
2. 在线标注或导入 OCR 标注
3. 选择 `paddleocr` 或 `doctr`
4. 启动训练
5. 查看 OCR 指标（accuracy/CER/WER）
6. 注册模型版本
7. 推理验证
8. 错样回流

## 10. 闭环业务 2：检测微调
1. 创建 detection 数据集
2. 在线框标注或导入标注
3. 选择 `yolo`
4. 启动训练
5. 查看 detection 指标（mAP/precision/recall）
6. 注册模型版本
7. 推理验证
8. 错样回流

## 10.1 版本中心化闭环约束（适用于所有任务类型）
1. 样本整理与复核完成后再创建版本快照
2. 训练/导出/评估入口显式从版本快照发起
3. 推理反馈样本回流后进入下一轮样本整理与复核，再进入新版本周期

## 11. Flow H：部署验收治理
执行者：`admin`

1. 运行 `docker:verify:full` 生成验收报告（含 OCR fallback 安全守卫校验）
2. 进入 `/admin/verification-reports`
3. 通过状态/base_url/日期区间/关键词筛选报告
4. 可选使用快捷日期（近 7 天 / 近 30 天）
5. 选择排序方式（最新优先/最早优先/失败优先，默认失败优先）
6. 分页浏览并展开失败检查项明细
7. 导出筛选结果 JSON 作为验收证据
8. 依据报告做内网发布 go/no-go 决策

## 12. 统一体验约束
- 多步骤流程必须有顶部 stepper
- 高级参数默认折叠
- 对话附件在当前草稿阶段必须可见、可删、带状态，发送后仍需可追溯
- 桌面端左侧栏保持固定视口高度，并使用内部滚动
- 当侧栏内容密度过高时，次级区块应支持折叠
- 空态/加载态/错误态/成功态全站统一
- 页面风格与交互语义保持一致
- 视觉数据闭环改造优先信息架构与操作效率，不做功能堆砌，并保持 chat-first 产品定位
- 参考规划基线：`docs/visual-data-loop-evolution.zh-CN.md`
