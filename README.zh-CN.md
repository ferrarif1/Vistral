# Vistral - AI 原生视觉模型平台（中文版）

## 概述
Vistral 是一个 AI-native 视觉模型平台，提供自然语言与附件驱动的交互方式。平台基于 RVision 能力演进，覆盖用户与管理员两类系统角色，并支持模型托管、训练、审批、发布、边缘推理与审计。

## 产品愿景
不同于传统仪表盘式产品，Vistral 采用类似 ChatGPT 的对话式交互范式，用户可通过自然语言与文件附件完成视觉模型任务。平台在保持 RVision 核心业务逻辑的同时，提供更现代和统一的体验。

## 核心能力
- 自然语言模型交互
- 附件驱动工作流（图片、文档、数据集）
- 两类系统角色管理（用户/管理员）+ 基于资源所有权的模型权限
- 模型托管与部署
- 训练流程管理
- 审批与审计流程
- 边缘推理能力
- 多步骤流程进度指示
- 高级参数默认折叠
- 上传附件状态持久可见（可见、可删、状态明确）
- 内置中英文切换（默认中文，可切换英文）

## 架构
- 前端：AI-native 对话式界面
- 后端：模型管理、推理与编排
- 基础设施：可扩展部署与边缘计算支持

## 快速开始
1. 克隆仓库；
2. 阅读 `AGENTS.md` 协作规则；
3. 阅读产品合同文档（英文原版）：
   - `docs/prd.md`
   - `docs/ia.md`
   - `docs/flows.md`
   - `docs/data-model.md`
   - `docs/api-contract.md`

   对应中文镜像版：
   - `docs/prd.zh-CN.md`
   - `docs/ia.zh-CN.md`
   - `docs/flows.zh-CN.md`
   - `docs/data-model.zh-CN.md`
   - `docs/api-contract.zh-CN.md`
4. 按 `docs/setup.md` 或 `docs/setup.zh-CN.md` 完成本地准备。

## Repository Working Model（本仓库 Codex 工作方式）
- 协作与执行规则：`AGENTS.md`
- 产品与工程合同：`docs/*`
- 可复用 skills：`.agents/skills/`
- 交付顺序：先计划，再对齐合同，再实现

## 贡献指南
提交改动前请先阅读 `docs/contributing.md` 或 `docs/contributing.zh-CN.md`。

## 开发与验证
1. `npm install`
2. `npm run dev`（同时启动 API + Web）
3. 打开 `http://127.0.0.1:5173`

认证方式（用户名密码）：
- 登录/注册统一使用 `username + password`。
- mock 种子账号：
  - `alice / mock-pass`（user）
  - `admin / mock-pass-admin`（admin）
- 普通注册只能创建 `user`，不能创建 `admin`。
- API 错误返回按合同映射状态码/错误码（例如 `INSUFFICIENT_PERMISSIONS` -> `403`）。
  - 后端采用“模式优先”归类，降低后续新增错误遗漏映射风险。

常用验证命令：
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke:phase2`（验证分割标注持久化与 YOLO/PaddleOCR/docTR runtime fallback）
- `npm run smoke:runtime-success`（通过本地 runtime mock 验证 YOLO/PaddleOCR/docTR 成功路径）
- `npm run smoke:admin:verification-reports`（验证 `/api/admin/verification-reports` 的 user/admin 权限边界）
- `npm run smoke:demo:train-data`（把 `demo_data/train` 图片导入新的 detection 数据集，并自动完成状态等待、数据切分和数据集版本创建）

当前界面能力补充：
- 会话工作区已切换为沉浸式 chat 风格布局（左侧会话栏 + 中央时间线 + 底部浮动输入区）。
- 推理验证页提供三框架 runtime 连通性诊断面板（PaddleOCR/docTR/YOLO）。
- 新增独立设置页 `/settings/runtime`，用于运行时连通性一键检查与接入模板查看。
- 新增管理员验收报告页 `/admin/verification-reports`，可直接查看部署验收脚本产出的报告摘要。
  - 支持筛选、搜索、日期区间、排序、7/30 天快捷筛选、分页、检查项折叠与按筛选导出 JSON。

## 许可证
当前基线版本尚未添加许可证文件；正式发布前请补充许可证文本。

## Docker 内网部署
1. `cp .env.example .env`（按需修改密钥）
2. `docker compose up --build -d`
3. 访问 `http://127.0.0.1:8080`
4. 健康检查 `http://127.0.0.1:8080/api/health`
5. 停止 `docker compose down`
6. 如部署机不能本地 build，可用镜像模式：`docker compose -f docker-compose.registry.yml up -d`
7. 镜像构建脚本：`npm run docker:images:build`
8. 镜像构建+推送：`npm run docker:images:build-push`
9. 离线导出镜像：`npm run docker:images:save`
10. 离线导入并启动：`npm run docker:images:load-up`
11. 部署自检：`npm run docker:healthcheck`
12. 全链路验收：`npm run docker:verify:full`
13. 发布包生成：`npm run docker:release:bundle`
14. 全链路验收会在 `.data/verify-reports/` 产出 JSON + Markdown 报告
15. 先验收再打包：`VERIFY_BASE_URL=http://127.0.0.1:8080 npm run docker:release:bundle:verified`
16. 指定验收报告打包：`VERIFY_REPORT_PATH=.data/verify-reports/<report>.json npm run docker:release:bundle`
17. 强制验收报告时效：`VERIFY_REPORT_MAX_AGE_SECONDS=1800 npm run docker:release:bundle`

容器说明：
- `vistral-web`：nginx 前端 + `/api` 反向代理
- `vistral-api`：Node 后端（会话认证、mock 流程、runtime 诊断）
