# Training Worker Deployment Kit

This directory contains deployment/install assets for training worker machines (`B/C/D/...`) in a control-plane topology:

- machine `A`: Vistral control plane (`/api`)
- machines `B/C/D/...`: training workers that report heartbeat/load and accept scheduling

Use this folder as the single worker-side entry instead of searching through root scripts.

Product-side GUI onboarding design reference:

- `docs/training-worker-onboarding.md`

## Quick Start: 开箱即用最短路径

目标是把 worker 收敛成一条固定路径：

1. 准备一份 `training-worker/.env.worker`
2. 跑一次 bootstrap / doctor
3. 启动 `run-worker-node.sh`

最少只需要确认这 3 个配置：

- `CONTROL_PLANE_BASE_URL`
- `TRAINING_WORKER_AUTH_TOKEN`（或兼容回退用的 `TRAINING_WORKER_SHARED_TOKEN`）
- `WORKER_ID`

如果 worker 和 control plane 不在同一台机器，还必须把：

- `WORKER_ENDPOINT`

改成控制面可访问到的 worker IP 或域名，不能保留 `127.0.0.1`。

推荐直接这样开始：

```bash
cp training-worker/.env.worker.example training-worker/.env.worker
```

然后执行一键 bootstrap：

```bash
CONTROL_PLANE_BASE_URL=http://10.0.0.10:8080 \
TRAINING_WORKER_AUTH_TOKEN=replace-with-issued-token \
WORKER_ID=tw-gpu-b \
WORKER_PUBLIC_HOST=10.0.0.22 \
WORKER_CAPABILITIES=framework:yolo,task:detection \
bash training-worker/scripts/bootstrap-worker.sh
```

bootstrap 会做这些事：

- 自动创建或补齐 `.env.worker`
- 安装 Python 依赖和 worker venv
- 在已具备完整 worker 配置时跑一次本地自检；如果是 pairing-first 启动，会先跳过严格 doctor，等 `/setup` 完成配对后再验证
- 告诉你下一步如何验证 heartbeat 与正式启动

验证 heartbeat：

```bash
bash training-worker/scripts/worker-doctor.sh --heartbeat
```

正式启动：

```bash
bash training-worker/scripts/run-worker-node.sh
```

这个启动脚本现在会：

- 自动优先使用 `WORKER_VENV_DIR` 里的 Python
- 总是先启动 worker API，让 `/setup` 页面立即可用
- 如果配置还不完整，会停留在 setup mode，等待你在 GUI 或 CLI 中补全
- 配置一旦变成有效状态，会自动启动 heartbeat loop
- 默认在 heartbeat 启动前先跑一遍 doctor
- 任一进程异常退出时整体退出，避免“表面活着、实际半死”的状态

## Quick Start: Docker + GUI

如果你想要最接近“开箱即用”的路径，直接用 worker Docker compose：

```bash
docker compose -f training-worker/docker-compose.worker.yml up -d --build
```

启动后打开：

- `http://<worker-host>:9090/setup`

这条路径的行为是：

- 容器先进入本地 setup 模式
- 你在图形界面里填写 Vistral 控制面地址、worker token、worker 标识、能力声明
- 点验证后会检查控制面连通、endpoint 合法性、heartbeat 探测、运行目录可写性
- `/setup` 页面会继续显示并轮询控制面的 bootstrap session 状态，让你直接看到当前是 `pairing`、`awaiting_confirmation`、`validation_failed` 还是 `online`
- 保存成功后，如果当前由 `run-worker-node.sh` 监督，heartbeat 会自动拉起

可选预填环境变量：

- `CONTROL_PLANE_BASE_URL`
- `TRAINING_WORKER_AUTH_TOKEN`
- `TRAINING_WORKER_SHARED_TOKEN`
- `WORKER_ID`
- `WORKER_NAME`
- `WORKER_ENDPOINT`
- `WORKER_BIND_PORT`
- `WORKER_CAPABILITIES`
- `WORKER_MAX_CONCURRENCY`
- `WORKER_RUNTIME_PROFILE`

例如：

```bash
CONTROL_PLANE_BASE_URL=http://10.0.0.10:8080 \
WORKER_BIND_PORT=9090 \
WORKER_ENDPOINT=http://10.0.0.22:9090 \
docker compose -f training-worker/docker-compose.worker.yml up -d --build
```

如果从控制面 `Runtime > Add Worker` 生成 bootstrap session：

- 建议直接把 worker 的公网 IP / 域名和绑定端口填进去
- 控制面生成的 Docker command / script command / bundle 会自动带上这些值
- worker 本地 `/setup` 页面会默认回填正确的 endpoint，减少手工改配置

## Folder Structure

- `training-worker/.env.worker.example`: worker environment template
- `training-worker/requirements.txt`: base python dependencies for worker helpers
- `training-worker/scripts/bootstrap-worker.sh`: one-command bootstrap for env + deps + doctor
- `training-worker/scripts/worker-doctor.sh`: preflight checks for env/deps/network/heartbeat
- `training-worker/scripts/install-deps.sh`: worker dependency bootstrap script
- `training-worker/scripts/worker-heartbeat.sh`: worker heartbeat loop to control plane
- `training-worker/scripts/worker-train-api.py`: worker-side training execution API service
- `training-worker/scripts/run-worker-node.sh`: start worker API + heartbeat loop together

## 1) Prerequisites

- Linux server (recommended for worker nodes)
- `bash`, `curl`, `python3`, `python3-venv`
- Network access from worker -> control-plane API

Optional for GPU workers:
- NVIDIA driver + CUDA runtime
- framework-specific dependencies (YOLO/PaddleOCR/docTR)

## 2) Configure Worker Env

```bash
cp training-worker/.env.worker.example training-worker/.env.worker
```

Minimum required fields in `training-worker/.env.worker`:

- `CONTROL_PLANE_BASE_URL` (for example `http://10.0.0.10:8080`)
- `TRAINING_WORKER_AUTH_TOKEN` (preferred dedicated token issued by bootstrap pairing)
- `WORKER_ID` (stable unique id, for example `tw-gpu-b`)

Compatibility fallback:

- `TRAINING_WORKER_SHARED_TOKEN` (legacy/manual workers can still reuse control-plane shared token)

Recommended fields:

- `WORKER_NAME`
- `WORKER_ENDPOINT`
- `WORKER_MAX_CONCURRENCY`
- `WORKER_CAPABILITIES`
- `WORKER_RUN_DOCTOR_ON_START=true`

OOTB recommendation:

- local single-machine debug can keep `WORKER_ENDPOINT=http://127.0.0.1:9090`
- real cross-machine deployment must set `WORKER_ENDPOINT=http://<worker-ip>:9090`
- if you use the bootstrap script, passing `WORKER_PUBLIC_HOST=<worker-ip>` is the easiest way to stamp the correct endpoint

Useful one-liner:

```bash
CONTROL_PLANE_BASE_URL=http://10.0.0.10:8080 \
TRAINING_WORKER_AUTH_TOKEN=replace-with-issued-token \
WORKER_ID=tw-gpu-b \
WORKER_PUBLIC_HOST=10.0.0.22 \
bash training-worker/scripts/bootstrap-worker.sh
```

## 3) Install Worker Dependencies

```bash
bash training-worker/scripts/install-deps.sh
```

Optional profiles:

```bash
WORKER_RUNTIME_PROFILE=yolo bash training-worker/scripts/install-deps.sh
WORKER_RUNTIME_PROFILE=paddleocr bash training-worker/scripts/install-deps.sh
WORKER_RUNTIME_PROFILE=doctr bash training-worker/scripts/install-deps.sh
WORKER_RUNTIME_PROFILE=all bash training-worker/scripts/install-deps.sh
```

If you want the simplest path, prefer:

```bash
bash training-worker/scripts/bootstrap-worker.sh
```

because it installs deps and then runs doctor immediately.

## 3.1) Doctor / Self-check

Run local preflight checks:

```bash
bash training-worker/scripts/worker-doctor.sh
```

Run heartbeat probe against control plane:

```bash
bash training-worker/scripts/worker-doctor.sh --heartbeat
```

Doctor checks:

- required env vars
- local Python / curl availability
- worker venv and Python deps
- control-plane reachability
- localhost endpoint mistakes in cross-machine topology
- optional one-shot heartbeat registration

## 4) Start Heartbeat Loop

```bash
bash training-worker/scripts/worker-heartbeat.sh
```

One-shot check:

```bash
bash training-worker/scripts/worker-heartbeat.sh --once
```

The script calls:

- `POST /api/runtime/training-workers/heartbeat`

with header:

- `X-Training-Worker-Token: <TRAINING_WORKER_AUTH_TOKEN>`

## 5) Start Worker Training API

```bash
python3 training-worker/scripts/worker-train-api.py
```

Default endpoint:
- `POST http://<worker-host>:9090/api/worker/train`
- `POST http://<worker-host>:9090/api/worker/cancel`
- `POST http://<worker-host>:9090/api/worker/models/pull-encrypted`
- `GET  http://<worker-host>:9090/healthz`
- `GET  http://<worker-host>:9090/setup`
- `GET  http://<worker-host>:9090/api/local/setup/state`
- `POST http://<worker-host>:9090/api/local/setup/pair`

`/healthz` compatibility payload:
- returns `worker.worker_version`, `worker.contract_version`, `worker.runtime_profile`, `worker.capabilities`
- control plane uses these fields during callback validation / activation to mark `compatible | warning | incompatible`
- when runtime profile is hard-mismatched with onboarding expectation, activation will be rejected until reconfigured

Auth:
- request header `X-Training-Worker-Token`
- token should use `TRAINING_WORKER_AUTH_TOKEN`; legacy shared fallback remains accepted

Local setup UI notes:

- worker 服务自己提供 setup 页面，不依赖主站前端打包
- 推荐主线：先在控制面 `Runtime > Add Worker` 生成一次性 pairing token，再启动 worker 并打开本地 `/setup`
- 管理员也可以直接下载 bootstrap bundle 脚本，把它发给训练机操作人执行
- setup 页面支持：
  - pairing token 领取控制面默认配置
  - 当前配置读取
  - hostname / IP / 建议 endpoint 自动检测
  - 配置验证
  - 持久化写入本地 env 文件
- 控制面在收到 heartbeat 后会主动回调 worker 健康端点；只有回调验证通过，worker 才会进入可调度 `online`

Path safety (important for cross-machine deployment):
- worker defaults to `WORKER_USE_REQUEST_PATHS=false`
- this means worker ignores control-plane absolute workspace paths and writes only under local `WORKER_RUN_ROOT`
- enable `WORKER_USE_REQUEST_PATHS=true` only when control plane and worker share the same filesystem namespace
- when dispatch payload uses `dataset_package.format=reference_json_v1`, worker downloads package JSON from control plane using:
  - `CONTROL_PLANE_BASE_URL`
  - `TRAINING_WORKER_AUTH_TOKEN`（或 legacy shared fallback）
  - `WORKER_PACKAGE_DOWNLOAD_TIMEOUT_SECONDS`

Encrypted model pull/deploy:
- worker can pull encrypted model package from control plane public runtime API and decrypt locally:
  - `POST /api/worker/models/pull-encrypted`
- required request/body or env:
  - `model_version_id`
  - `runtime_api_key` or `WORKER_RUNTIME_PUBLIC_API_KEY`
  - `encryption_key` or `WORKER_MODEL_DELIVERY_ENCRYPTION_KEY` (fallback to `MODEL_DELIVERY_ENCRYPTION_KEY`)
- optional env:
  - `WORKER_RUNTIME_PUBLIC_BASE_URL` (fallback is `${CONTROL_PLANE_BASE_URL}/api/runtime/public`)
  - `WORKER_MODEL_STORE_ROOT` (default under worker run root)
  - `WORKER_MODEL_PACKAGE_DOWNLOAD_TIMEOUT_SECONDS`
- response includes deployed local model path + `deployment.json` metadata (delivery id/framework/task_type/sha256)

## 6) Start API + Heartbeat Together (recommended)

```bash
bash training-worker/scripts/run-worker-node.sh
```

This is the typical worker-machine process entry.

Current startup behavior:

- auto-picks `${WORKER_VENV_DIR}/bin/python` when available
- always starts worker API first so `/setup` is available immediately
- if config is incomplete, stays in setup mode and keeps waiting for GUI/CLI configuration
- once required config becomes valid, starts heartbeat loop automatically
- runs doctor before heartbeat startup by default (`WORKER_RUN_DOCTOR_ON_START=true`)
- exits the whole process when one side fails, which is safer for `systemd` / supervisor restarts

## 7) Verify from Control Plane

After heartbeat succeeds, verify in admin API:

```bash
curl -sS "$CONTROL_PLANE_BASE_URL/api/admin/training-workers" \
  -H "Cookie: vistral_session=<admin-session-cookie>"
```

Or check worker list in Runtime settings page (admin).

For a healthy worker, you should see:

- `status=online`
- non-stale heartbeat
- expected `capabilities`
- `endpoint` matching the actual worker machine address

## 8) Integration Note (Current Phase)

Control plane now dispatches scheduled worker jobs to:

- `POST {worker.endpoint}/api/worker/train`

Dispatch success:
- worker returns logs/metrics/metric-series/artifact summary
- control plane writes them into existing training job runtime outputs
- control plane can include either:
  - inline dataset package (`inline_base64_v1`)
  - referenced package metadata (`reference_json_v1`) with download url to control-plane package endpoint
- worker reconstructs files under local workspace and rewrites materialized dataset paths to local root

Dispatch failure:
- if fallback policy is enabled (`TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL=1`), job falls back to control-plane local execution
- reason is recorded in scheduler/log context

Cancel behavior:
- control plane can call worker `POST /api/worker/cancel` when user cancels a worker-running job
- worker will terminate in-flight local command process when possible and acknowledge cancel state

For training command templates used by the control plane, see:

- `scripts/local-runners/`

## 9) Optional systemd Unit

Create `/etc/systemd/system/vistral-worker-heartbeat.service`:

```ini
[Unit]
Description=Vistral Worker Heartbeat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/Vistral
EnvironmentFile=/opt/Vistral/training-worker/.env.worker
ExecStart=/bin/bash /opt/Vistral/training-worker/scripts/run-worker-node.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vistral-worker-heartbeat.service
```

## 10) Recommended OOTB Standard

If you want worker deployment to feel truly "开箱即用", keep these conventions fixed across all worker nodes:

1. One env file only: `training-worker/.env.worker`
2. One bootstrap command only: `bash training-worker/scripts/bootstrap-worker.sh`
3. One start command only: `bash training-worker/scripts/run-worker-node.sh`
4. One health/self-check command only: `bash training-worker/scripts/worker-doctor.sh --heartbeat`

That way new nodes `B/C/D/...` can be added with the same muscle memory instead of each machine using a different path.
