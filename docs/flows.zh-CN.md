# 用户流程（中文版）

## 1. 概述
本文档定义 Vistral 当前可执行流程，覆盖 AI-native 对话入口与专业工程台入口。

## 2. Flow A：对话 + 附件闭环（已实现）
执行者：`user`

1. 进入 `/workspace/chat`
2. 在左侧会话栏选择模型并可随时新建对话
3. 在底部附件条上传附件（列表始终可见、可删、带状态）
4. 发送消息
5. 系统发起会话并返回助手回复（mock 或已配置 LLM）
6. 会话栏可从后端同步历史并点击恢复完整消息时间线
7. 用户可通过桌面右键或移动端长按菜单执行打开/重命名/置顶/删除快捷操作
8. 菜单打开后可使用快捷键 `O/R/P/D` 快速执行对应动作
9. 用户可在 Pinned 分组内拖拽调整会话优先级
10. 用户在同一上下文中继续多轮对话

附件状态：
- `uploading`
- `processing`
- `ready`
- `error`

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

## 4. Flow C：数据集管理（Phase 1 骨架，已实现）
执行者：`user`

1. 进入 `/datasets`
2. 创建 `task_type` 数据集
3. 进入 `/datasets/:datasetId`
4. 上传数据集文件
5. 执行 `train/val/test` 切分
6. 创建数据集版本快照

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

当前阶段目标：
1. 进入 `/datasets/:datasetId/annotate`
2. 选择数据样本
3. 编辑 OCR/检测标注
4. 保存为 `in_progress` 或 `annotated`
5. 提交 `annotated -> in_review`
6. 审核为 `approved` 或 `rejected`

## 6. Flow E：训练任务流程（Phase 1 骨架，Phase 3 runtime）
执行者：`user`

1. 进入 `/training/jobs/new`
2. 顶部 stepper：
   - Step 1 任务类型 + 框架
   - Step 2 数据集 + 基座模型
   - Step 3 参数（高级参数默认折叠）
   - Step 4 复核 + 提交
3. 创建训练任务
4. 任务状态流转：
   - `draft`
   - `queued`
   - `preparing`
   - `running`
   - `evaluating`
   - `completed`（或 `failed` / `cancelled`）
5. 在 `/training/jobs/:jobId` 查看日志与指标

## 7. Flow F：模型版本注册
执行者：`user`

1. 训练任务完成后可注册模型版本
2. 在 `/models/versions` 发起注册
3. 版本关联模型 + 数据集 + 训练任务 + 指标摘要

## 8. Flow G：推理验证 + 错误回流
执行者：`user`

1. 进入 `/inference/validate`
2. 执行 PaddleOCR/docTR/YOLO runtime 连通性检查
3. 上传推理图片
4. 选择模型版本
5. 执行推理
6. 查看可视化结果 + raw 输出 + normalized 输出
7. 错样一键回流数据集

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

## 11. Flow H：部署验收治理
执行者：`admin`

1. 运行 `docker:verify:full` 生成验收报告
2. 进入 `/admin/verification-reports`
3. 通过状态/base_url/日期区间/关键词筛选报告
4. 可选使用快捷日期（近 7 天 / 近 30 天）
5. 选择排序方式（最新优先/最早优先/失败优先，默认失败优先）
6. 分页浏览并展开失败检查项明细
7. 导出筛选结果 JSON 作为验收证据
8. 依据报告做内网发布 go/no-go 决策
9. 执行 `docker:release:bundle` 打包交付：
   - 可用 `VERIFY_REPORT_PATH` 固定某份报告
   - 可用 `VERIFY_REPORT_MAX_AGE_SECONDS` 强制报告时效

## 12. 统一体验约束
- 多步骤流程必须有顶部 stepper
- 高级参数默认折叠
- 上传附件必须可见、可删、带状态
- 空态/加载态/错误态/成功态全站统一
- 页面风格与交互语义保持一致
