# 信息架构（中文版）

## 概述
Vistral 信息架构按用户域与管理员域划分：`/models/*` 为用户域能力，`/admin/*` 为管理员治理域。

## 站点结构

### 根层
- `/` 主会话界面
- `/auth` 认证
- `/admin` 管理后台
- `/models` 模型发现与管理（用户域，不是独立 owner 门户）
- `/account` 账户管理

### 会话层
- `/new` 新会话
- `/c/:conversationId` 会话详情
- `/attachments` 会话附件

### 管理层
- `/admin/dashboard`
- `/admin/models`（pending/rejected/archived）
- `/admin/users`
- `/admin/audit`
- `/admin/settings`

### 模型层（用户域）
- `/models/explore`
- `/models/my-models`（自有/被授权模型）
- `/models/create`
- `/models/:modelId`
  - `/chat`
  - `/configure`
  - `/analytics`
  - `/version-history`

## 交互要求
- 多步骤流程必须有顶部 stepper
- 高级参数默认折叠
- 空态/加载态/错误态/成功态统一
- 附件区文件可见、可删、状态可追踪
