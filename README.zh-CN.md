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
4. 按 `docs/setup.md` 完成本地准备。

## Repository Working Model（本仓库 Codex 工作方式）
- 协作与执行规则：`AGENTS.md`
- 产品与工程合同：`docs/*`
- 可复用 skills：`.agents/skills/`
- 交付顺序：先计划，再对齐合同，再实现

## 贡献指南
提交改动前请先阅读 `docs/contributing.md`。

## 许可证
当前基线版本尚未添加许可证文件；正式发布前请补充许可证文本。
