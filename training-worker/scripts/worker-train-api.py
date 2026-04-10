#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
WORKER_ROOT = SCRIPT_DIR.parent
DEFAULT_WORKER_ENV_FILE = WORKER_ROOT / ".env.worker"
SETUP_UI_FILE = WORKER_ROOT / "ui" / "setup.html"
LAST_SETUP_VALIDATION: dict[str, Any] | None = None
LAST_REMOTE_BOOTSTRAP_STATUS: dict[str, Any] | None = None
LAST_REMOTE_BOOTSTRAP_STATUS_ERROR: str | None = None
WORKER_HEALTH_CONTRACT_VERSION = "training-worker-healthz.v1"

SETUP_FIELD_TO_ENV = {
    "control_plane_base_url": "CONTROL_PLANE_BASE_URL",
    "training_worker_auth_token": "TRAINING_WORKER_AUTH_TOKEN",
    "worker_id": "WORKER_ID",
    "worker_name": "WORKER_NAME",
    "worker_endpoint": "WORKER_ENDPOINT",
    "worker_status": "WORKER_STATUS",
    "worker_enabled": "WORKER_ENABLED",
    "worker_max_concurrency": "WORKER_MAX_CONCURRENCY",
    "worker_capabilities": "WORKER_CAPABILITIES",
    "heartbeat_interval_seconds": "HEARTBEAT_INTERVAL_SECONDS",
    "worker_runtime_profile": "WORKER_RUNTIME_PROFILE",
    "worker_repo_root": "WORKER_REPO_ROOT",
    "worker_run_root": "WORKER_RUN_ROOT",
    "worker_use_request_paths": "WORKER_USE_REQUEST_PATHS",
    "worker_command_failure_mode": "WORKER_COMMAND_FAILURE_MODE",
    "worker_disable_command": "WORKER_DISABLE_COMMAND",
}

SETUP_FIELD_DEFAULTS = {
    "control_plane_base_url": "",
    "training_worker_auth_token": "",
    "worker_id": "",
    "worker_name": "",
    "worker_endpoint": "",
    "worker_status": "online",
    "worker_enabled": "true",
    "worker_max_concurrency": "1",
    "worker_capabilities": "",
    "heartbeat_interval_seconds": "15",
    "worker_runtime_profile": "base",
    "worker_repo_root": "",
    "worker_run_root": "",
    "worker_use_request_paths": "false",
    "worker_command_failure_mode": "fallback",
    "worker_disable_command": "false",
}

RUNNING_PROCESSES: dict[str, subprocess.Popen[str]] = {}
CANCELLED_JOB_IDS: set[str] = set()
PROCESS_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def compact_text(value: Any, limit: int = 240) -> str:
    text = str(value).strip()
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit]


def as_positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(str(value).strip())
        if parsed > 0:
            return parsed
    except Exception:
        pass
    return default


def as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    return default


def resolve_worker_env_file() -> Path:
    configured = os.getenv("WORKER_ENV_FILE", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return DEFAULT_WORKER_ENV_FILE.resolve()


def unquote_env_value(value: str) -> str:
    if len(value) >= 2 and ((value[0] == value[-1] == "'") or (value[0] == value[-1] == '"')):
        return value[1:-1]
    return value


def read_env_file_map(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    result: dict[str, str] = {}
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            result[key.strip()] = unquote_env_value(value.strip())
    except Exception:
        return {}
    return result


def load_persisted_env_into_process() -> None:
    for key, value in read_env_file_map(resolve_worker_env_file()).items():
        if key not in os.environ or not os.environ.get(key, "").strip():
            os.environ[key] = value


def resolve_worker_auth_token_from_env_map(env_map: dict[str, str]) -> str:
    auth_token = env_map.get("TRAINING_WORKER_AUTH_TOKEN", "").strip()
    if auth_token:
        return auth_token
    return env_map.get("TRAINING_WORKER_SHARED_TOKEN", "").strip()


def resolve_worker_auth_token_from_env() -> str:
    return (
        os.getenv("TRAINING_WORKER_AUTH_TOKEN", "").strip()
        or os.getenv("TRAINING_WORKER_SHARED_TOKEN", "").strip()
    )


def quote_env_value(value: str) -> str:
    escaped = value.replace("'", "'\"'\"'")
    return f"'{escaped}'"


def load_setup_config(include_secret: bool = False) -> tuple[dict[str, str], bool]:
    env_map = read_env_file_map(resolve_worker_env_file())
    config: dict[str, str] = {}
    has_auth_token = False
    for field, env_key in SETUP_FIELD_TO_ENV.items():
        if field == "training_worker_auth_token":
            value = resolve_worker_auth_token_from_env_map(env_map) or resolve_worker_auth_token_from_env()
            has_auth_token = bool(value)
            config[field] = value if include_secret else ""
        else:
            value = env_map.get(env_key, os.getenv(env_key, SETUP_FIELD_DEFAULTS.get(field, ""))).strip()
            config[field] = value
    return config, has_auth_token


def load_bootstrap_prefill() -> dict[str, Any]:
    pairing_token = os.getenv("WORKER_BOOTSTRAP_TOKEN", "").strip()
    control_plane_base_url = (
        os.getenv("WORKER_BOOTSTRAP_CONTROL_PLANE_URL", "").strip()
        or os.getenv("CONTROL_PLANE_BASE_URL", "").strip()
    )
    runtime_profile = os.getenv("WORKER_RUNTIME_PROFILE", "").strip()
    return {
        "available": bool(pairing_token),
        "control_plane_base_url": control_plane_base_url,
        "worker_runtime_profile": runtime_profile,
    }


def sanitize_hostname_token(value: str) -> str:
    lowered = value.strip().lower()
    if not lowered:
        return "worker"
    collapsed = "".join(ch if ch.isalnum() else "-" for ch in lowered)
    while "--" in collapsed:
        collapsed = collapsed.replace("--", "-")
    return collapsed.strip("-") or "worker"


def guess_local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip:
                return ip
    except Exception:
        pass
    try:
        hostname = socket.gethostname()
        resolved = socket.gethostbyname(hostname)
        if resolved:
            return resolved
    except Exception:
        pass
    return "127.0.0.1"


def build_detected_setup_values(config: dict[str, str] | None = None) -> dict[str, Any]:
    current = config or {}
    hostname = socket.gethostname() or "worker"
    local_ip = guess_local_ip()
    bind_port = as_positive_int(os.getenv("WORKER_BIND_PORT", "9090"), 9090)
    worker_id = current.get("worker_id", "").strip() or f"tw-{sanitize_hostname_token(hostname)}"
    worker_name = current.get("worker_name", "").strip() or f"training-worker-{sanitize_hostname_token(hostname)}"
    suggested_endpoint = current.get("worker_endpoint", "").strip()
    if not suggested_endpoint or "127.0.0.1" in suggested_endpoint or "localhost" in suggested_endpoint:
        suggested_endpoint = f"http://{local_ip}:{bind_port}"
    repo_root = current.get("worker_repo_root", "").strip() or str(
        Path(os.getenv("WORKER_REPO_ROOT", str(WORKER_ROOT.parent))).resolve()
    )
    run_root = current.get("worker_run_root", "").strip() or str(
        Path(os.getenv("WORKER_RUN_ROOT", str(WORKER_ROOT.parent / ".data" / "worker-jobs"))).resolve()
    )
    return {
        "hostname": hostname,
        "local_ip": local_ip,
        "suggested_worker_id": worker_id,
        "suggested_worker_name": worker_name,
        "suggested_worker_endpoint": suggested_endpoint,
        "worker_repo_root": repo_root,
        "worker_run_root": run_root,
        "env_file": str(resolve_worker_env_file()),
    }


def merge_setup_config(raw_config: dict[str, Any] | None) -> tuple[dict[str, str], bool]:
    current_config, has_existing_auth_token = load_setup_config(include_secret=True)
    merged = {**SETUP_FIELD_DEFAULTS, **current_config}
    incoming = dict(raw_config) if isinstance(raw_config, dict) else {}
    if "training_worker_auth_token" not in incoming and "training_worker_shared_token" in incoming:
        incoming["training_worker_auth_token"] = incoming["training_worker_shared_token"]
    for field in SETUP_FIELD_TO_ENV:
        raw_value = incoming.get(field)
        if raw_value is None:
            continue
        value = str(raw_value).strip()
        if field == "training_worker_auth_token" and not value and has_existing_auth_token:
            continue
        merged[field] = value
    return merged, has_existing_auth_token


def make_validation_check(label: str, status: str, detail: str) -> dict[str, str]:
    return {
        "label": label,
        "status": status,
        "detail": detail,
    }


def is_local_host(host: str) -> bool:
    normalized = host.strip().lower()
    return normalized in ("", "localhost", "127.0.0.1", "0.0.0.0")


def probe_control_plane(url: str) -> tuple[bool, str]:
    try:
        request = urllib.request.Request(f"{url.rstrip('/')}/api/auth/csrf", method="GET")
        with urllib.request.urlopen(request, timeout=8) as response:
            if 200 <= response.status < 300:
                return True, "control plane reachable"
            return False, f"unexpected status {response.status}"
    except Exception as exc:
        return False, compact_text(exc, 180)


def send_setup_heartbeat_probe(config: dict[str, str]) -> tuple[bool, str]:
    url = config.get("control_plane_base_url", "").strip().rstrip("/")
    token = config.get("training_worker_auth_token", "").strip()
    worker_id = config.get("worker_id", "").strip()
    if not url or not token or not worker_id:
        return False, "missing control plane url / token / worker id"
    payload = {
        "worker_id": worker_id,
        "name": config.get("worker_name", "").strip() or worker_id,
        "endpoint": config.get("worker_endpoint", "").strip(),
        "status": config.get("worker_status", "").strip() or "online",
        "enabled": as_bool(config.get("worker_enabled"), True),
        "max_concurrency": as_positive_int(config.get("worker_max_concurrency"), 1),
        "reported_load": 0.0,
        "capabilities": [
            item.strip()
            for item in config.get("worker_capabilities", "").split(",")
            if item.strip()
        ],
        "metadata": {
            "source": "worker-setup-ui",
            "host": socket.gethostname() or "worker",
        },
    }
    request = urllib.request.Request(
        f"{url}/api/runtime/training-workers/heartbeat",
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Training-Worker-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
            parsed = json.loads(body)
            if isinstance(parsed, dict) and parsed.get("success") is True:
                return True, "heartbeat probe accepted by control plane"
            return False, compact_text(parsed, 180)
    except Exception as exc:
        return False, compact_text(exc, 180)


def claim_bootstrap_session(pairing_token: str, control_plane_base_url: str) -> dict[str, Any]:
    normalized_url = control_plane_base_url.strip().rstrip("/")
    if not pairing_token.strip():
        raise ValueError("pairing token is required")
    if not normalized_url:
        raise ValueError("control plane base url is required")
    request = urllib.request.Request(
        f"{normalized_url}/api/runtime/training-workers/bootstrap-sessions/claim",
        method="POST",
        data=json.dumps({"pairing_token": pairing_token.strip()}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
            parsed = json.loads(body)
            if not isinstance(parsed, dict) or parsed.get("success") is not True:
                raise RuntimeError(compact_text(parsed, 180) or "pairing claim failed")
            data = parsed.get("data")
            if not isinstance(data, dict):
                raise RuntimeError("pairing claim returned invalid payload")
            return data
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            detail = str(exc)
        raise RuntimeError(compact_text(detail or exc, 180)) from exc
    except Exception as exc:
        raise RuntimeError(compact_text(exc, 180)) from exc


def get_bootstrap_session_status(pairing_token: str, control_plane_base_url: str) -> dict[str, Any]:
    normalized_url = control_plane_base_url.strip().rstrip("/")
    if not pairing_token.strip():
        raise ValueError("pairing token is required")
    if not normalized_url:
        raise ValueError("control plane base url is required")
    request = urllib.request.Request(
        f"{normalized_url}/api/runtime/training-workers/bootstrap-sessions/status",
        method="POST",
        data=json.dumps({"pairing_token": pairing_token.strip()}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
            parsed = json.loads(body)
            if not isinstance(parsed, dict) or parsed.get("success") is not True:
                raise RuntimeError(compact_text(parsed, 180) or "bootstrap status request failed")
            data = parsed.get("data")
            if not isinstance(data, dict):
                raise RuntimeError("bootstrap status returned invalid payload")
            return data
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            detail = str(exc)
        raise RuntimeError(compact_text(detail or exc, 180)) from exc
    except Exception as exc:
        raise RuntimeError(compact_text(exc, 180)) from exc


def validate_setup_config(config: dict[str, str]) -> dict[str, Any]:
    checks: list[dict[str, str]] = []

    control_plane_base_url = config.get("control_plane_base_url", "").strip()
    auth_token = config.get("training_worker_auth_token", "").strip()
    worker_id = config.get("worker_id", "").strip()
    worker_endpoint = config.get("worker_endpoint", "").strip()
    worker_repo_root = config.get("worker_repo_root", "").strip() or build_detected_setup_values(config)["worker_repo_root"]
    worker_run_root = config.get("worker_run_root", "").strip() or build_detected_setup_values(config)["worker_run_root"]
    parsed_cp = urllib.parse.urlparse(control_plane_base_url) if control_plane_base_url else None
    parsed_endpoint = urllib.parse.urlparse(worker_endpoint) if worker_endpoint else None

    checks.append(
        make_validation_check(
            "Required fields",
            "pass" if control_plane_base_url and auth_token and worker_id else "fail",
            "control_plane_base_url / training_worker_auth_token / worker_id are required.",
        )
    )

    if control_plane_base_url and parsed_cp and parsed_cp.scheme in ("http", "https") and parsed_cp.netloc:
        checks.append(make_validation_check("Control plane URL format", "pass", control_plane_base_url))
    else:
        checks.append(make_validation_check("Control plane URL format", "fail", "Use a full http(s) URL, for example http://10.0.0.10:8080"))

    if worker_endpoint and parsed_endpoint and parsed_endpoint.scheme in ("http", "https") and parsed_endpoint.netloc:
        checks.append(make_validation_check("Worker endpoint format", "pass", worker_endpoint))
    else:
        checks.append(make_validation_check("Worker endpoint format", "fail", "Worker endpoint must be a full URL reachable from control plane."))

    if control_plane_base_url and worker_endpoint and parsed_cp and parsed_endpoint:
        cp_host = parsed_cp.hostname or ""
        endpoint_host = parsed_endpoint.hostname or ""
        if not is_local_host(cp_host) and is_local_host(endpoint_host):
            checks.append(
                make_validation_check(
                    "Remote callback safety",
                    "fail",
                    "Control plane is remote, but worker endpoint is localhost. Replace WORKER_ENDPOINT with worker IP/domain.",
                )
            )
        else:
            checks.append(make_validation_check("Remote callback safety", "pass", "Worker endpoint is suitable for callback dispatch."))

    repo_root_path = Path(worker_repo_root).expanduser()
    checks.append(
        make_validation_check(
            "Repo root",
            "pass" if repo_root_path.exists() else "fail",
            f"{repo_root_path}",
        )
    )

    run_root_path = Path(worker_run_root).expanduser()
    try:
        run_root_path.mkdir(parents=True, exist_ok=True)
        probe_file = run_root_path / ".worker-write-check"
        probe_file.write_text("ok", encoding="utf-8")
        probe_file.unlink(missing_ok=True)
        checks.append(make_validation_check("Run root write access", "pass", f"{run_root_path} writable"))
    except Exception as exc:
        checks.append(make_validation_check("Run root write access", "fail", compact_text(exc, 180)))

    if control_plane_base_url:
        ok, detail = probe_control_plane(control_plane_base_url)
        checks.append(make_validation_check("Control plane reachability", "pass" if ok else "fail", detail))

    if control_plane_base_url and auth_token and worker_id and worker_endpoint:
        ok, detail = send_setup_heartbeat_probe(config)
        checks.append(make_validation_check("Heartbeat probe", "pass" if ok else "fail", detail))
    else:
        checks.append(make_validation_check("Heartbeat probe", "warn", "Skipped until URL / token / worker_id / worker_endpoint are complete."))

    valid = not any(check["status"] == "fail" for check in checks)
    return {
        "valid": valid,
        "checks": checks,
    }


def persist_setup_config(config: dict[str, str]) -> Path:
    env_file = resolve_worker_env_file()
    env_file.parent.mkdir(parents=True, exist_ok=True)
    existing_map = read_env_file_map(env_file)
    for field, env_key in SETUP_FIELD_TO_ENV.items():
        existing_map[env_key] = config.get(field, "").strip()

    ordered_keys = [SETUP_FIELD_TO_ENV[field] for field in SETUP_FIELD_TO_ENV]
    remaining_keys = sorted(key for key in existing_map if key not in ordered_keys)
    lines = [f"{key}={quote_env_value(existing_map.get(key, ''))}" for key in ordered_keys + remaining_keys]
    env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    for field, env_key in SETUP_FIELD_TO_ENV.items():
        os.environ[env_key] = config.get(field, "").strip()

    return env_file


def build_setup_state() -> dict[str, Any]:
    config, has_auth_token = load_setup_config(include_secret=False)
    bootstrap = load_bootstrap_prefill()
    env_map = read_env_file_map(resolve_worker_env_file())
    config_ready = bool(
        (env_map.get("CONTROL_PLANE_BASE_URL", os.getenv("CONTROL_PLANE_BASE_URL", "")).strip())
        and (resolve_worker_auth_token_from_env_map(env_map) or resolve_worker_auth_token_from_env())
        and (config.get("worker_id", "").strip())
    )
    return {
        "setup_status": "configured" if config_ready else "unconfigured",
        "env_file": str(resolve_worker_env_file()),
        "local_health": "api_online",
        "config_ready": config_ready,
        "has_worker_auth_token": has_auth_token,
        "config": config,
        "detected": build_detected_setup_values(config),
        "bootstrap": bootstrap,
        "remote_bootstrap_status": LAST_REMOTE_BOOTSTRAP_STATUS,
        "remote_bootstrap_status_error": LAST_REMOTE_BOOTSTRAP_STATUS_ERROR,
        "last_validation": LAST_SETUP_VALIDATION,
    }


def parse_worker_capabilities(raw_value: str) -> list[str]:
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def build_worker_health_payload() -> dict[str, Any]:
    config, _ = load_setup_config(include_secret=False)
    runtime_profile_raw = (
        config.get("worker_runtime_profile", "").strip()
        or os.getenv("WORKER_RUNTIME_PROFILE", "").strip()
    )
    runtime_profile = "" if runtime_profile_raw.lower() in ("", "base") else runtime_profile_raw
    capabilities_raw = (
        config.get("worker_capabilities", "").strip()
        or os.getenv("WORKER_CAPABILITIES", "").strip()
    )
    worker_version = os.getenv("VISTRAL_TRAINING_WORKER_VERSION", "0.1.0").strip() or "0.1.0"
    return {
        "ok": True,
        "service": "training-worker-api",
        "time": now_iso(),
        "worker": {
            "worker_id": config.get("worker_id", "").strip() or os.getenv("WORKER_ID", "").strip(),
            "worker_name": config.get("worker_name", "").strip() or os.getenv("WORKER_NAME", "").strip(),
            "runtime_profile": runtime_profile,
            "capabilities": parse_worker_capabilities(capabilities_raw),
            "worker_version": worker_version,
            "contract_version": WORKER_HEALTH_CONTRACT_VERSION,
        },
    }


def normalize_metrics(metrics: Any) -> dict[str, float]:
    if not isinstance(metrics, dict):
        return {}
    out: dict[str, float] = {}
    for key, value in metrics.items():
        if not isinstance(key, str):
            continue
        try:
            num = float(value)
        except Exception:
            continue
        if num != num:  # NaN
            continue
        out[key] = round(num, 6)
    return out


def normalize_metric_series(series: Any) -> list[dict[str, Any]]:
    if not isinstance(series, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in series:
        if not isinstance(item, dict):
            continue
        step_raw = item.get("step")
        try:
            step = int(step_raw)
        except Exception:
            continue
        if step < 1:
            continue
        metrics = normalize_metrics(item.get("metrics"))
        if not metrics:
            continue
        normalized.append({"step": step, "metrics": metrics})
    normalized.sort(key=lambda x: x["step"])
    return normalized


def build_deterministic_metrics(task_type: str, framework: str) -> dict[str, float]:
    if task_type == "ocr":
        acc = 0.82 if framework == "paddleocr" else 0.79
        return {"accuracy": round(acc, 4), "cer": 0.11, "wer": 0.15}
    if task_type in ("detection", "obb"):
        return {"map": 0.64, "precision": 0.71, "recall": 0.62}
    if task_type == "segmentation":
        return {"miou": 0.58, "dice": 0.66}
    return {"accuracy": 0.73, "f1": 0.69}


def build_metric_series(metrics: dict[str, float], points: int = 6) -> list[dict[str, Any]]:
    points = max(2, min(points, 16))
    series: list[dict[str, Any]] = []
    for i in range(points):
        p = i / (points - 1)
        metric_point: dict[str, float] = {}
        for name, final_value in metrics.items():
            lower_better = name in ("cer", "wer") or name.startswith("loss") or name.endswith("_loss")
            start = final_value * (1.45 if lower_better else 0.6)
            if final_value == 0:
                start = 0.12 if lower_better else 0.02
            value = start - (start - final_value) * p if lower_better else start + (final_value - start) * p
            metric_point[name] = round(value, 6)
        series.append({"step": i + 1, "metrics": metric_point})
    return series


def render_template(template: str, values: dict[str, str]) -> str:
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace(f"{{{{{key}}}}}", value)
    return rendered


def resolve_command_template(framework: str, repo_root: str) -> str:
    override_framework = os.getenv(f"WORKER_{framework.upper()}_TRAIN_COMMAND", "").strip()
    if override_framework:
        return override_framework
    override_generic = os.getenv("WORKER_LOCAL_TRAIN_COMMAND", "").strip()
    if override_generic:
        return override_generic

    templates = {
        "yolo": (
            "python3 {{repo_root}}/scripts/local-runners/yolo_train_runner.py "
            "--job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} "
            "--base-model {{base_model}} --workspace-dir {{workspace_dir}} "
            "--config-path {{config_path}} --summary-path {{summary_path}} "
            "--metrics-path {{metrics_path}} --artifact-path {{artifact_path}}"
        ),
        "paddleocr": (
            "python3 {{repo_root}}/scripts/local-runners/paddleocr_train_runner.py "
            "--job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} "
            "--base-model {{base_model}} --workspace-dir {{workspace_dir}} "
            "--config-path {{config_path}} --summary-path {{summary_path}} "
            "--metrics-path {{metrics_path}} --artifact-path {{artifact_path}}"
        ),
        "doctr": (
            "python3 {{repo_root}}/scripts/local-runners/doctr_train_runner.py "
            "--job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} "
            "--base-model {{base_model}} --workspace-dir {{workspace_dir}} "
            "--config-path {{config_path}} --summary-path {{summary_path}} "
            "--metrics-path {{metrics_path}} --artifact-path {{artifact_path}}"
        ),
    }
    return templates.get(framework, templates["yolo"])


def read_metrics_bundle(metrics_path: Path) -> tuple[dict[str, float], list[dict[str, Any]]]:
    if not metrics_path.exists():
        return {}, []
    try:
        payload = json.loads(metrics_path.read_text(encoding="utf-8"))
    except Exception:
        return {}, []

    if isinstance(payload, dict):
        summary = normalize_metrics(payload.get("summary"))
        series = normalize_metric_series(payload.get("metric_series"))
        if summary or series:
            if not summary and series:
                summary = normalize_metrics(series[-1].get("metrics"))
            return summary, series
        plain = normalize_metrics(payload)
        return plain, []
    return {}, []


def mark_job_cancelled(job_id: str) -> bool:
    had_running = False
    with PROCESS_LOCK:
        CANCELLED_JOB_IDS.add(job_id)
        process = RUNNING_PROCESSES.get(job_id)
        if process and process.poll() is None:
            had_running = True
            try:
                process.terminate()
            except Exception:
                pass
    return had_running


def is_job_cancelled(job_id: str, consume: bool = False) -> bool:
    with PROCESS_LOCK:
        cancelled = job_id in CANCELLED_JOB_IDS
        if cancelled and consume:
            CANCELLED_JOB_IDS.discard(job_id)
        return cancelled


def is_safe_relative_path(value: str) -> bool:
    candidate = Path(value)
    if candidate.is_absolute():
        return False
    if ".." in candidate.parts:
        return False
    return True


def rewrite_materialized_paths(value: Any, source_root: str | None, target_root: str) -> Any:
    if isinstance(value, dict):
        return {key: rewrite_materialized_paths(item, source_root, target_root) for key, item in value.items()}
    if isinstance(value, list):
        return [rewrite_materialized_paths(item, source_root, target_root) for item in value]
    if isinstance(value, str) and source_root:
        normalized_source = source_root.rstrip("/\\")
        if normalized_source and value.startswith(normalized_source):
            rel = value[len(normalized_source):].lstrip("/\\")
            return str(Path(target_root) / rel)
    return value


def resolve_dataset_package_for_worker(payload: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    package_raw = payload.get("dataset_package")
    if not isinstance(package_raw, dict):
        return None, None

    package_format = str(package_raw.get("format", "inline_base64_v1")).strip().lower() or "inline_base64_v1"
    if package_format == "inline_base64_v1":
        return package_raw, {"requested_format": "inline_base64_v1"}

    if package_format != "reference_json_v1":
        raise ValueError(f"dataset_package format not supported: {package_format}")

    token = resolve_worker_auth_token_from_env()
    if not token:
        raise ValueError("TRAINING_WORKER_AUTH_TOKEN is required for reference dataset package download")

    download_url_raw = str(package_raw.get("download_url", "")).strip()
    if not download_url_raw:
        raise ValueError("dataset_package.download_url is required for reference package")

    parsed = urllib.parse.urlparse(download_url_raw)
    resolved_url = download_url_raw
    if not parsed.scheme or not parsed.netloc:
        control_plane_base = os.getenv("CONTROL_PLANE_BASE_URL", "").strip().rstrip("/")
        if not control_plane_base:
            raise ValueError(
                "CONTROL_PLANE_BASE_URL is required when dataset_package.download_url is relative"
            )
        resolved_url = urllib.parse.urljoin(f"{control_plane_base}/", download_url_raw.lstrip("/"))

    timeout_seconds = as_positive_int(
        os.getenv("WORKER_PACKAGE_DOWNLOAD_TIMEOUT_SECONDS", "30"),
        30,
    )
    request = urllib.request.Request(
        resolved_url,
        method="GET",
        headers={
            "X-Training-Worker-Token": token,
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        message = ""
        try:
            message = exc.read().decode("utf-8").strip()
        except Exception:
            message = ""
        if message:
            raise ValueError(
                f"dataset package download failed (status={exc.code}): {compact_text(message, 220)}"
            ) from exc
        raise ValueError(f"dataset package download failed (status={exc.code})") from exc
    except Exception as exc:
        raise ValueError(f"dataset package download failed: {compact_text(exc, 220)}") from exc

    try:
        parsed_body = json.loads(body)
    except Exception as exc:
        raise ValueError("dataset package download returned invalid JSON payload") from exc

    resolved_payload: Any = parsed_body
    if isinstance(parsed_body, dict) and "success" in parsed_body:
        if parsed_body.get("success") is not True:
            error_part = parsed_body.get("error")
            if isinstance(error_part, dict):
                message = compact_text(error_part.get("message"), 220)
            else:
                message = compact_text(parsed_body.get("message"), 220)
            if not message:
                message = "dataset package endpoint returned error response"
            raise ValueError(message)
        resolved_payload = parsed_body.get("data")

    if not isinstance(resolved_payload, dict):
        raise ValueError("dataset package download did not return a JSON object")
    if str(resolved_payload.get("format", "")).strip().lower() != "inline_base64_v1":
        raise ValueError("dataset package download returned unsupported format")
    if not isinstance(resolved_payload.get("files"), list):
        raise ValueError("dataset package download payload.files must be an array")

    return resolved_payload, {
        "requested_format": "reference_json_v1",
        "resolved_download_url": resolved_url,
        "package_id": compact_text(package_raw.get("package_id"), 120),
        "expires_at": compact_text(package_raw.get("expires_at"), 120),
    }


def apply_inline_dataset_package(payload: dict[str, Any], workspace_dir: Path) -> tuple[dict[str, Any], dict[str, Any] | None]:
    materialized_raw = payload.get("materialized_dataset")
    materialized = materialized_raw if isinstance(materialized_raw, dict) else {}
    package_raw, package_meta = resolve_dataset_package_for_worker(payload)
    if not isinstance(package_raw, dict):
        return materialized, None

    files = package_raw.get("files")
    if not isinstance(files, list):
        raise ValueError("dataset_package.files must be an array")

    root_relative = str(package_raw.get("root_relative", "materialized-dataset")).strip() or "materialized-dataset"
    if not is_safe_relative_path(root_relative):
        raise ValueError("dataset_package.root_relative is unsafe")

    target_root = (workspace_dir / root_relative).resolve()
    target_root.mkdir(parents=True, exist_ok=True)
    extracted_files = 0
    extracted_bytes = 0

    for item in files:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("relative_path", "")).strip()
        if not rel:
            continue
        if not is_safe_relative_path(rel):
            raise ValueError(f"dataset_package relative_path is unsafe: {rel}")
        encoding = str(item.get("encoding", "base64")).strip().lower()
        if encoding != "base64":
            raise ValueError(f"dataset_package encoding not supported: {encoding}")
        content_b64 = item.get("content_base64")
        if not isinstance(content_b64, str):
            raise ValueError(f"dataset_package file content is invalid: {rel}")
        try:
            content = base64.b64decode(content_b64.encode("utf-8"), validate=True)
        except Exception as exc:
            raise ValueError(f"dataset_package file decode failed: {rel}: {exc}") from exc

        dest = (target_root / rel).resolve()
        if not str(dest).startswith(str(target_root)):
            raise ValueError(f"dataset_package path traversal blocked: {rel}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        extracted_files += 1
        extracted_bytes += len(content)

    source_root = str(package_raw.get("source_root", "")).strip() or None
    local_materialized = rewrite_materialized_paths(materialized, source_root, str(target_root))
    if isinstance(local_materialized, dict):
        local_materialized["root_dir"] = str(target_root)

    return local_materialized if isinstance(local_materialized, dict) else {}, {
        "requested_format": (package_meta or {}).get("requested_format", "inline_base64_v1"),
        "resolved_format": str(package_raw.get("format", "inline_base64_v1")),
        "resolved_download_url": (package_meta or {}).get("resolved_download_url"),
        "package_id": (package_meta or {}).get("package_id"),
        "expires_at": (package_meta or {}).get("expires_at"),
        "root_dir": str(target_root),
        "source_root": source_root,
        "extracted_files": extracted_files,
        "extracted_bytes": extracted_bytes,
    }


def run_training(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    job_id = compact_text(payload.get("job_id"), 120)
    framework = compact_text(payload.get("framework"), 32)
    task_type = compact_text(payload.get("task_type"), 32)
    dataset_id = compact_text(payload.get("dataset_id"), 120)
    base_model = compact_text(payload.get("base_model"), 120)
    config = payload.get("config", {})
    if not isinstance(config, dict):
        config = {}

    if not job_id or not framework or not task_type:
        return 400, {"accepted": False, "error": "job_id/framework/task_type are required."}

    script_dir = Path(__file__).resolve().parent
    repo_root = Path(os.getenv("WORKER_REPO_ROOT", str(script_dir.parent.parent))).resolve()
    run_root = Path(os.getenv("WORKER_RUN_ROOT", str(repo_root / ".data" / "worker-jobs"))).resolve()
    run_root.mkdir(parents=True, exist_ok=True)
    workspace = payload.get("workspace")
    workspace_dir = run_root / job_id
    workspace_dir.mkdir(parents=True, exist_ok=True)
    use_request_paths = as_bool(os.getenv("WORKER_USE_REQUEST_PATHS"), False)
    try:
        local_materialized_dataset, inline_package_meta = apply_inline_dataset_package(payload, workspace_dir)
    except ValueError as exc:
        return 400, {"accepted": False, "error": str(exc)}

    if use_request_paths and isinstance(workspace, dict):
        config_path = Path(str(workspace.get("config_path", workspace_dir / "job-config.json")))
        summary_path = Path(str(workspace.get("summary_path", workspace_dir / "dataset-summary.json")))
        metrics_path = Path(str(workspace.get("metrics_path", workspace_dir / "metrics.json")))
        artifact_path = Path(
            str(workspace.get("artifact_path", workspace_dir / "artifacts" / f"{framework}-{job_id}.artifact.json"))
        )
    else:
        config_path = workspace_dir / "job-config.json"
        summary_path = workspace_dir / "dataset-summary.json"
        metrics_path = workspace_dir / "metrics.json"
        artifact_path = workspace_dir / "artifacts" / f"{framework}-{job_id}.artifact.json"

    config_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.parent.mkdir(parents=True, exist_ok=True)

    config_path.write_text(
        json.dumps(
            {
                "job_id": job_id,
                "framework": framework,
                "task_type": task_type,
                "dataset_id": dataset_id,
                "base_model": base_model,
                "config": config,
                "materialized_dataset": local_materialized_dataset,
                "dataset_package_meta": inline_package_meta,
                "workspace_mode": "request_paths" if use_request_paths else "worker_local_paths",
                "received_at": now_iso(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    summary = payload.get("dataset_summary", {})
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    command_template = resolve_command_template(framework, str(repo_root))
    template_values: dict[str, str] = {
        "repo_root": str(repo_root),
        "job_id": job_id,
        "dataset_id": dataset_id,
        "task_type": task_type,
        "base_model": base_model,
        "workspace_dir": str(workspace_dir),
        "config_path": str(config_path),
        "summary_path": str(summary_path),
        "metrics_path": str(metrics_path),
        "artifact_path": str(artifact_path),
    }
    for key, value in config.items():
        safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in str(key).strip())
        if safe:
            template_values[f"config_{safe}"] = str(value)
    command = render_template(command_template, template_values)

    timeout_ms = as_positive_int(os.getenv("WORKER_LOCAL_RUN_TIMEOUT_MS", "1800000"), 1800000)
    timeout_sec = timeout_ms / 1000.0
    failure_mode = os.getenv("WORKER_COMMAND_FAILURE_MODE", "fallback").strip().lower()
    disable_command = os.getenv("WORKER_DISABLE_COMMAND", "0").strip().lower() in ("1", "true", "yes")

    logs: list[str] = []
    execution_mode = "simulated"
    fallback_reason: str | None = None
    worker_run_id = f"wr-{uuid.uuid4().hex[:10]}"
    start_ts = time.time()

    if is_job_cancelled(job_id, consume=True):
        return 499, {"accepted": False, "error": "job cancelled before execution"}

    if not disable_command:
        try:
            process = subprocess.Popen(
                command,
                shell=True,
                cwd=str(workspace_dir),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            with PROCESS_LOCK:
                RUNNING_PROCESSES[job_id] = process

            try:
                stdout, stderr = process.communicate(timeout=timeout_sec)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
                fallback_reason = f"command_timeout_{timeout_ms}ms"
                if failure_mode == "strict":
                    return 500, {"accepted": False, "error": f"worker command timeout after {timeout_ms}ms"}
            finally:
                with PROCESS_LOCK:
                    RUNNING_PROCESSES.pop(job_id, None)

            if is_job_cancelled(job_id, consume=True):
                return 499, {"accepted": False, "error": "job cancelled"}

            command_output = (stdout or "") + ("\n" + stderr if stderr else "")
            logs.extend([line.strip() for line in command_output.splitlines() if line.strip()])
            if process.returncode == 0:
                execution_mode = "local_command"
            else:
                fallback_reason = f"command_exit_{process.returncode}"
                if failure_mode == "strict":
                    return 500, {
                        "accepted": False,
                        "error": f"worker command failed with exit code {process.returncode}",
                        "logs": logs[-40:],
                    }
        except Exception as exc:  # pragma: no cover
            fallback_reason = compact_text(f"command_error:{exc}", 180)
            if failure_mode == "strict":
                return 500, {"accepted": False, "error": f"worker command error: {exc}"}
    else:
        fallback_reason = "command_disabled"

    metrics, metric_series = read_metrics_bundle(metrics_path)
    if not metrics:
        metrics = build_deterministic_metrics(task_type, framework)
    if not metric_series:
        metric_series = build_metric_series(metrics, points=6)

    artifact_payload = {
        "runner": "training-worker-api",
        "mode": "real" if execution_mode == "local_command" else "template",
        "fallback_reason": fallback_reason,
        "training_performed": execution_mode == "local_command",
        "generated_at": now_iso(),
        "worker_run_id": worker_run_id,
        "worker_name": os.getenv("WORKER_NAME", "worker"),
        "framework": framework,
        "task_type": task_type,
        "job_id": job_id,
        "metrics": metrics,
        "metric_series": metric_series,
        "dataset_package_meta": inline_package_meta,
        "duration_ms": int((time.time() - start_ts) * 1000),
    }
    artifact_path.write_text(json.dumps(artifact_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    if not logs:
        logs.append("worker train finished")
    log_preview = logs[-1]
    if fallback_reason:
        logs.append(f"fallback_reason={fallback_reason}")

    return 200, {
        "accepted": True,
        "execution_mode": execution_mode,
        "log_preview": log_preview,
        "logs": logs[-80:],
        "metrics": metrics,
        "metric_series": metric_series,
        "artifact_payload": artifact_payload,
        "worker_run_id": worker_run_id,
    }


class WorkerHandler(BaseHTTPRequestHandler):
    server_version = "VistralWorker/0.1"

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_html(self, status: int, body: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        payload = json.loads(raw.decode("utf-8"))
        return payload if isinstance(payload, dict) else {}

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/", "/setup"):
            if not SETUP_UI_FILE.is_file():
                self._write_html(500, "<h1>setup ui missing</h1>")
                return
            self._write_html(200, SETUP_UI_FILE.read_text(encoding="utf-8"))
            return

        if self.path in ("/healthz", "/api/worker/healthz"):
            self._write_json(200, build_worker_health_payload())
            return

        if self.path == "/api/local/setup/state":
            self._write_json(200, build_setup_state())
            return

        self._write_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        global LAST_SETUP_VALIDATION

        if self.path in (
            "/api/local/setup/detect",
            "/api/local/setup/pair",
            "/api/local/setup/bootstrap-status",
            "/api/local/setup/validate",
            "/api/local/setup/apply",
        ):
            try:
                body = self._read_json_body()
            except Exception:
                self._write_json(400, {"ok": False, "error": "invalid json payload"})
                return

            if self.path == "/api/local/setup/pair":
                pairing_token = str(body.get("pairing_token") or os.getenv("WORKER_BOOTSTRAP_TOKEN", "")).strip()
                current_config, _ = load_setup_config(include_secret=True)
                bootstrap = load_bootstrap_prefill()
                control_plane_base_url = (
                    str(body.get("control_plane_base_url") or "").strip()
                    or current_config.get("control_plane_base_url", "").strip()
                    or str(bootstrap.get("control_plane_base_url") or "").strip()
                )
                try:
                    claim_result = claim_bootstrap_session(pairing_token, control_plane_base_url)
                except Exception as exc:
                    self._write_json(400, {"ok": False, "error": compact_text(exc, 220)})
                    return

                config_defaults = claim_result.get("config_defaults")
                merged_config, _ = merge_setup_config(
                    config_defaults if isinstance(config_defaults, dict) else None
                )
                if not merged_config.get("worker_repo_root", "").strip():
                    merged_config["worker_repo_root"] = build_detected_setup_values(merged_config)[
                        "worker_repo_root"
                    ]
                if not merged_config.get("worker_run_root", "").strip():
                    merged_config["worker_run_root"] = build_detected_setup_values(merged_config)[
                        "worker_run_root"
                    ]
                global LAST_REMOTE_BOOTSTRAP_STATUS
                global LAST_REMOTE_BOOTSTRAP_STATUS_ERROR
                bootstrap_session = claim_result.get("bootstrap_session")
                LAST_REMOTE_BOOTSTRAP_STATUS = bootstrap_session if isinstance(bootstrap_session, dict) else None
                LAST_REMOTE_BOOTSTRAP_STATUS_ERROR = None
                self._write_json(
                    200,
                    {
                        "ok": True,
                        "paired": True,
                        "bootstrap_session": bootstrap_session,
                        "config": merged_config,
                        "detected": build_detected_setup_values(merged_config),
                    },
                )
                return

            if self.path == "/api/local/setup/bootstrap-status":
                pairing_token = str(body.get("pairing_token") or os.getenv("WORKER_BOOTSTRAP_TOKEN", "")).strip()
                current_config, _ = load_setup_config(include_secret=True)
                bootstrap = load_bootstrap_prefill()
                control_plane_base_url = (
                    str(body.get("control_plane_base_url") or "").strip()
                    or current_config.get("control_plane_base_url", "").strip()
                    or str(bootstrap.get("control_plane_base_url") or "").strip()
                )
                try:
                    remote_status = get_bootstrap_session_status(pairing_token, control_plane_base_url)
                except Exception as exc:
                    LAST_REMOTE_BOOTSTRAP_STATUS_ERROR = compact_text(exc, 220)
                    self._write_json(
                        400,
                        {
                            "ok": False,
                            "error": LAST_REMOTE_BOOTSTRAP_STATUS_ERROR,
                            "remote_bootstrap_status": LAST_REMOTE_BOOTSTRAP_STATUS,
                        },
                    )
                    return

                LAST_REMOTE_BOOTSTRAP_STATUS = remote_status
                LAST_REMOTE_BOOTSTRAP_STATUS_ERROR = None
                self._write_json(
                    200,
                    {
                        "ok": True,
                        "remote_bootstrap_status": remote_status,
                    },
                )
                return

            incoming = body.get("config")
            merged_config, _ = merge_setup_config(incoming if isinstance(incoming, dict) else None)

            if self.path == "/api/local/setup/detect":
                self._write_json(
                    200,
                    {
                        "ok": True,
                        "detected": build_detected_setup_values(merged_config),
                    },
                )
                return

            validation = validate_setup_config(merged_config)
            LAST_SETUP_VALIDATION = validation

            if self.path == "/api/local/setup/validate":
                self._write_json(200, validation)
                return

            env_file = persist_setup_config(merged_config)
            self._write_json(
                200,
                {
                    "applied": True,
                    "env_file": str(env_file),
                    "validation": validation,
                    "setup_state": build_setup_state(),
                },
            )
            return

        if self.path not in ("/api/worker/train", "/api/worker/cancel"):
            self._write_json(404, {"ok": False, "error": "not_found"})
            return

        worker_auth_token = resolve_worker_auth_token_from_env()
        if not worker_auth_token:
            self._write_json(500, {"accepted": False, "error": "TRAINING_WORKER_AUTH_TOKEN is not configured."})
            return

        header_token = self.headers.get("X-Training-Worker-Token", "").strip()
        if not header_token or header_token != worker_auth_token:
            self._write_json(401, {"accepted": False, "error": "invalid training worker token"})
            return

        try:
            body = self._read_json_body()
        except Exception:
            self._write_json(400, {"accepted": False, "error": "invalid json payload"})
            return

        if self.path == "/api/worker/cancel":
            job_id = compact_text(body.get("job_id"), 120)
            if not job_id:
                self._write_json(400, {"cancelled": False, "error": "job_id is required"})
                return
            had_running = mark_job_cancelled(job_id)
            self._write_json(
                200,
                {
                    "cancelled": True,
                    "job_id": job_id,
                    "had_running_process": had_running,
                    "message": "cancel request recorded",
                },
            )
            return

        status, result = run_training(body)
        self._write_json(status, result)


def main() -> None:
    load_persisted_env_into_process()
    host = os.getenv("WORKER_BIND_HOST", "0.0.0.0").strip() or "0.0.0.0"
    port = as_positive_int(os.getenv("WORKER_BIND_PORT", "9090"), 9090)
    server = ThreadingHTTPServer((host, port), WorkerHandler)
    print(f"[worker-train-api] listening on http://{host}:{port}", flush=True)
    print(f"[worker-train-api] setup ui at http://{host}:{port}/setup", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
