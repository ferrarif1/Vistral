# API 合同（中文版）

## 概述
定义认证、用户、模型、会话等接口的最小可实现合同。

## 认证
原型阶段使用 Cookie Session：
- `HttpOnly` 会话 Cookie：`vistral_session`
- 变更类请求（`POST/PUT/PATCH/DELETE`）需携带 `X-CSRF-Token`

## 统一返回
成功：
```json
{ "success": true, "data": {} }
```
失败：
```json
{ "success": false, "error": { "code": "", "message": "" } }
```

## 认证接口

### POST /auth/register
注册新用户。

> 注册默认只创建 `user`，客户端不得直接创建 `admin`。
> `admin` 仅能通过种子初始化或 admin-only 后台接口授予。

请求体：
```json
{
  "username": "username",
  "password": "secure_password"
}
```

### POST /auth/login
登录并绑定会话 Cookie（用户名+密码）。

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

## 管理接口补充
- `GET /audit/logs`：审计日志（仅 admin）
- `GET /admin/verification-reports`：部署验收报告列表（仅 admin）

## 会话接口（补充）
- `GET /conversations`：会话列表
- `POST /conversations/start`：发起会话
- `POST /conversations/message`：会话追加消息
- `GET /conversations/{id}`：会话详情（含消息）
- `PATCH /conversations/{id}`：重命名会话标题（owner/admin）

说明：
- `attachment_ids` 会按客户端传入顺序保留，用作该条消息的附件上下文顺序。

`PATCH /conversations/{id}` 请求体：
```json
{
  "title": "Invoice Batch Review"
}
```

约束：
- `title` 去空格后不能为空
- 标题长度 1-120

## 文件附件接口（补充）
- `GET /files/conversation`：获取当前用户会话附件列表
- `POST /files/conversation/upload`：上传会话附件
  - 兼容 JSON 文件名模式：
    ```json
    { "filename": "sample.jpg" }
    ```
  - 推荐 `multipart/form-data`：
    - 字段名 `file`
    - 服务端落盘到 `.data/uploads/conversation`
    - 返回仍为标准 `FileAttachment` JSON 包装
- `GET /files/model/{modelId}`：模型附件列表
- `POST /files/model/{modelId}/upload`：上传模型附件
  - 兼容 JSON 文件名模式
  - 推荐 `multipart/form-data`（字段名 `file`）
- `GET /files/dataset/{datasetId}`：数据集附件列表
- `POST /files/dataset/{datasetId}/upload`：上传数据集附件
  - 兼容 JSON 文件名模式
  - 推荐 `multipart/form-data`（字段名 `file`）
- `GET /files/{id}/content`：获取 ready 附件的二进制内容（原始流，不走 JSON envelope）
- `DELETE /files/{id}`：删除附件（所有者范围内）

附件状态：
- `uploading`
- `processing`
- `ready`
- `error`

## 训练与推理接口补充（当前实现）
- 训练任务详情中的 `job` 现在显式返回 `execution_mode`：
  - `simulated`（模拟执行）
  - `local_command`（本地命令执行）
  - `unknown`
- 新增 `GET /training/jobs/{id}/metrics-export`：
  - 返回任务指标导出 JSON（`latest_metrics` + `metrics_by_name` 序列）
  - 供训练详情页下载排障
  - 支持 `?format=csv`，返回 CSV 下载（`training_job_id, metric_name, step, metric_value, recorded_at`）
- 推理结果显式返回 `execution_source`，与 `normalized_output.source` 一致，用于区分：
  - `<framework>_runtime`
  - `<framework>_local_command`
  - `<framework>_local`
  - `mock_fallback`
- 新增 `GET /runtime/metrics-retention`：
  - 返回当前用户可见训练任务范围内的指标保留摘要
  - 包含 `max_points_per_job`、`max_total_rows`、`current_total_rows`、`near_total_cap`、`top_jobs`
  - 用于运行时页面查看指标保留占用情况

### GET /admin/verification-reports 返回项
```json
{
  "id": "docker-verify-full-20260402223826",
  "filename": "docker-verify-full-20260402223826.json",
  "status": "passed",
  "summary": "full deployment verification succeeded",
  "started_at_utc": "2026-04-02T14:38:26Z",
  "finished_at_utc": "2026-04-02T14:38:31Z",
  "target_base_url": "http://127.0.0.1:8080",
  "business_username": "alice",
  "probe_username": "verify-123",
  "checks_total": 9,
  "checks_failed": 0,
  "checks": [
    {
      "name": "infrastructure health checks",
      "status": "passed",
      "detail": "health endpoints are reachable"
    }
  ],
  "runtime_metrics_retention": {
    "max_points_per_job": 180,
    "max_total_rows": 20000,
    "current_total_rows": 428,
    "visible_job_count": 12,
    "jobs_with_metrics": 9,
    "max_rows_single_job": 90,
    "near_total_cap": false,
    "top_jobs": [
      { "training_job_id": "tj-982", "rows": 90 }
    ]
  },
  "entities": {
    "model_id": "m-1",
    "approval_id": "ar-1"
  }
}
```

说明：
- 仅 `admin` 可访问；普通 `user` 请求应返回失败。
- `status` 取值：`passed` / `failed` / `unknown`。
- 普通 `user` 调用建议返回：`403 + INSUFFICIENT_PERMISSIONS`。
- 当验收报告 JSON 包含该字段时，返回项会带 `runtime_metrics_retention` 摘要。

## 错误码与状态码映射（原型已实现）
- `AUTHENTICATION_REQUIRED` -> `401`
- `INSUFFICIENT_PERMISSIONS` -> `403`
- `CSRF_VALIDATION_FAILED` -> `403`
- `RESOURCE_NOT_FOUND` -> `404`
- `VALIDATION_ERROR` -> `400`
- `INVALID_STATE_TRANSITION` -> `409`
- `INTERNAL_ERROR` -> `500`

实现说明：
- 后端优先通过错误消息模式归类（权限/资源不存在/状态迁移），由共享错误归一模块实现
- 对未命中模式的边界消息保留显式映射兜底
