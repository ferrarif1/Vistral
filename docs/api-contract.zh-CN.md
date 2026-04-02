# API 合同（中文版）

## 概述
定义认证、用户、模型、会话等接口的最小可实现合同。

## 认证
使用 Bearer Token：
- `Authorization: Bearer {access_token}`

## 统一返回
成功：
```json
{ "success": true, "data": {}, "meta": {} }
```
失败：
```json
{ "success": false, "error": { "code": "", "message": "", "details": {} } }
```

## 认证接口

### POST /auth/register
注册新用户。

> 注册默认只创建 `user`，客户端不得直接创建 `admin`。
> `admin` 仅能通过种子初始化或 admin-only 后台接口授予。

请求体：
```json
{
  "email": "user@example.com",
  "password": "secure_password",
  "username": "username"
}
```

### POST /auth/login
登录并返回访问令牌。

### POST /auth/refresh
刷新访问令牌。

## 权限边界（最小 v1）
- 系统角色仅 `user` / `admin`。
- `user`：可使用公开模型，且仅管理自有/被授权模型。
- `admin`：可进行审批、审计、用户管理与全局治理。
- 所有权字段：`models.owner_user_id`。
- 能力字段示例：`user.capabilities` 包含 `manage_models`。

## 模型接口（摘要）
- `GET /models` 列表
- `POST /models` 创建（需 ownership/capability 校验）
- `GET /models/{id}` 详情
- `PUT /models/{id}` 更新（仅 owner/authorized/admin）
- `DELETE /models/{id}` 弃用（仅 owner/authorized/admin）
- `POST /models/{id}/publish` 提交发布（进入审批）
