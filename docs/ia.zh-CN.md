# 信息架构（中文版）

## 1. 目标
定义 Vistral 可执行路由与页面结构，覆盖 AI-native 对话工作区与专业工程控制台双入口。

## 2. 访问规则
- 系统角色仅 `user` 与 `admin`。
- `owner` 是资源关系，不是系统角色。
- `/auth/register` 仅创建 `user`。

## 3. 路由地图

### 3.1 认证
- `/auth/login`
- `/auth/register`

### 3.2 双入口
- `/`
  - AI-native 对话工作区入口
  - 专业控制台入口

### 3.3 对话工作区
- `/workspace/chat`
  - 沉浸式 chat 壳层（左侧会话栏 + 中央时间线 + 底部浮动输入区）
  - 左侧会话栏接入后端会话历史，支持同步与点击恢复完整对话详情
  - 左侧会话历史按时间分组（Pinned/Today/Yesterday/Previous 7 Days/Older）
  - Pinned 分组支持拖拽排序
  - 会话项支持快捷菜单（桌面右键、移动端长按；打开/重命名/置顶/删除）
  - 菜单支持键盘导航（`ArrowUp/ArrowDown`、`Enter`、`Esc`）与快捷键（`O/R/P/D`）
  - 移动端长按在浏览器支持振动 API 时触发轻量震动反馈
  - 左侧会话栏支持本地隐藏/清空，并提供“恢复隐藏”入口
  - 输入区内持久附件条（状态可见 + 可删除）

### 3.4 专业控制台
- `/workspace/console`
  - 运行概览与快捷入口

### 3.5 模型域
- `/models/explore`
- `/models/my-models`
- `/models/create`（必须 stepper）
- `/models/versions`

### 3.6 数据集域
- `/datasets`
  - 列表 + 创建入口
- `/datasets/:datasetId`
  - 详情页
  - 顶部 stepper（导入/切分/版本）
  - 数据集附件始终可见/可删/有状态
- `/datasets/:datasetId/annotate`
  - 最小在线标注工作区
  - 检测框 + OCR 文本标注
  - 提交审核与通过/拒绝

### 3.7 训练域
- `/training/jobs`
  - 任务列表
- `/training/jobs/new`
  - 创建向导（必须 stepper，高级参数默认折叠）
- `/training/jobs/:jobId`
  - 状态、日志、指标详情

### 3.8 推理验证域
- `/inference/validate`
  - PaddleOCR/docTR/YOLO runtime 连通性诊断
  - 上传图片
  - 选择模型版本
  - 执行推理
  - 展示 raw + normalized 输出
  - 错样回流数据集

### 3.9 设置
- `/settings/llm`
- `/settings/runtime`

### 3.10 管理域
- `/admin/models/pending`
- `/admin/audit`
- `/admin/verification-reports`

## 4. 共享 UI 合同
- `AppShell`：统一导航与页面框架
- `StateBlock`：空态/加载/错误/成功统一块
- `AttachmentUploader`：附件可见 + 可删 + 状态展示
- `StepIndicator`：多步骤流程强制使用
- `AdvancedSection`：高级参数默认折叠

## 5. 页面交互合同

### 5.1 数据集详情页
- 顶部 stepper：`Upload -> Organize -> Version`
- 附件列表持续可见
- 切分/版本是显式动作

### 5.2 训练任务创建页
- 顶部 stepper：`Task -> Data -> Params -> Review`
- 高级参数默认折叠

### 5.3 推理验证页
- 复用上传组件与状态块
- runtime 诊断面板支持刷新与分框架状态展示
- 输出面板包含：
  - 模型元信息
  - 原始输出
  - 归一化输出
- 一键回流数据集

### 5.4 Runtime 设置页
- 支持全框架与单框架连通性检查
- 提供集成模板（环境变量、health curl、请求/响应示例）
- 高级模板区默认折叠

### 5.5 管理员验收报告页
- 支持按状态、base_url、关键词筛选
- 支持日期区间筛选与排序（最新优先/最早优先/失败优先）
- 支持快捷日期筛选（近 7 天 / 近 30 天 / 清空）
- 报告检查项明细折叠查看，降低长列表噪音
- 支持分页浏览与“按筛选结果导出 JSON”
- 默认排序优先展示失败报告，便于治理排障
- 用于发布交付前治理校验

## 6. 响应式基线
- 移动端：单列堆叠
- 桌面端：侧边导航 + 内容区
- stepper 与附件状态在各断点保持可读

## 7. 阶段边界
- Phase 1：骨架页 + mock API
- Phase 2：最小在线标注与审核闭环
- Phase 3+：真实框架适配器与训练执行器
