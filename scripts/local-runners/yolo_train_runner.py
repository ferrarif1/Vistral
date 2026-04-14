#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple


def read_json(path: str) -> dict:
    if not path:
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as fp:
            parsed = json.load(fp)
            return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def to_int(value, default: int) -> int:
    try:
        parsed = int(str(value).strip())
        return parsed if parsed > 0 else default
    except Exception:
        return default


def to_float(value, default: float) -> float:
    try:
        parsed = float(str(value).strip())
        return parsed if parsed > 0 else default
    except Exception:
        return default


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def ratio_from_seed(seed: int, lower: float, upper: float) -> float:
    bucket = abs(seed % 10000) / 10000.0
    return lower + (upper - lower) * bucket


def write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)


def should_try_real() -> bool:
    normalized = os.getenv('VISTRAL_RUNNER_ENABLE_REAL', 'auto').strip().lower()
    return normalized not in {'0', 'false', 'no', 'off', 'disabled'}


def resolve_base_model(base_model: str) -> str:
    candidate = (base_model or '').strip()
    configured_model_path = (
        os.getenv('YOLO_LOCAL_MODEL_PATH', '').strip()
        or os.getenv('VISTRAL_YOLO_MODEL_PATH', '').strip()
        or os.getenv('REAL_YOLO_MODEL_PATH', '').strip()
    )

    # For catalog aliases such as "yolo11n", prefer the explicitly configured local
    # weight file so real training stays deterministic in intranet / offline setups.
    if configured_model_path and os.path.isfile(configured_model_path):
        if not candidate:
            return configured_model_path
        if os.path.sep not in candidate and not candidate.endswith('.pt') and not candidate.endswith('.yaml'):
            return configured_model_path

    if not candidate:
        return 'yolo11n.pt'
    if os.path.sep not in candidate and not candidate.endswith('.pt') and not candidate.endswith('.yaml'):
        return f'{candidate}.pt'
    return candidate


def extract_materialized_dataset(config: dict) -> dict:
    materialized = config.get('materialized_dataset')
    return materialized if isinstance(materialized, dict) else {}


def build_template_metrics(args, summary: dict, config: dict) -> Tuple[Dict, List]:
    cfg = config.get('config', {}) if isinstance(config.get('config'), dict) else {}
    epochs = to_int(cfg.get('epochs', 8), 8)

    total_items = to_int(summary.get('total_items', 0), 0)
    ready_items = to_int(summary.get('ready_items', total_items), total_items)
    annotated_items = to_int(summary.get('annotated_items', 0), 0)
    approved_items = to_int(summary.get('approved_items', 0), 0)
    total_boxes = to_int(summary.get('total_boxes', 0), 0)

    ready_ratio = (ready_items / total_items) if total_items > 0 else 0.0
    annotated_ratio = (annotated_items / total_items) if total_items > 0 else 0.0
    approved_ratio = (approved_items / total_items) if total_items > 0 else 0.0

    digest = hashlib.sha256(
        f"{args.job_id}|{args.dataset_id}|{args.base_model}|{args.task_type}|{epochs}".encode('utf-8')
    ).digest()
    seed = int.from_bytes(digest[:4], byteorder='big', signed=False)

    density = clamp(total_boxes / max(1, annotated_items), 0.0, 10.0) / 12.0
    map_score = clamp(
        0.28 + ready_ratio * 0.12 + annotated_ratio * 0.33 + approved_ratio * 0.2 + density, 0.2, 0.98
    )
    map_score = clamp(map_score + ratio_from_seed(seed, -0.03, 0.04), 0.2, 0.99)

    precision = clamp(map_score + ratio_from_seed(seed >> 4, 0.015, 0.08), 0.2, 0.995)
    recall = clamp(map_score - ratio_from_seed(seed >> 9, 0.01, 0.06), 0.15, 0.99)
    loss_box = clamp(1.08 - map_score * 0.9, 0.05, 1.2)
    loss_cls = clamp(0.96 - map_score * 0.82, 0.03, 1.1)

    metrics = {
        'map': round(map_score, 4),
        'precision': round(precision, 4),
        'recall': round(recall, 4),
        'loss_box': round(loss_box, 4),
        'loss_cls': round(loss_cls, 4),
    }

    series_steps = max(4, min(epochs, 12))
    metric_series = []
    for index in range(series_steps):
        progress = 1.0 if series_steps == 1 else index / float(series_steps - 1)

        map_step = (metrics['map'] * 0.58) + (metrics['map'] - metrics['map'] * 0.58) * progress
        precision_step = (metrics['precision'] * 0.62) + (metrics['precision'] - metrics['precision'] * 0.62) * progress
        recall_step = (metrics['recall'] * 0.57) + (metrics['recall'] - metrics['recall'] * 0.57) * progress
        loss_box_start = metrics['loss_box'] * 1.45 + 0.04
        loss_cls_start = metrics['loss_cls'] * 1.35 + 0.05
        loss_box_step = loss_box_start - (loss_box_start - metrics['loss_box']) * progress
        loss_cls_step = loss_cls_start - (loss_cls_start - metrics['loss_cls']) * progress

        metric_series.append(
            {
                'step': index + 1,
                'metrics': {
                    'map': round(clamp(map_step, 0.0, 0.9999), 4),
                    'precision': round(clamp(precision_step, 0.0, 0.9999), 4),
                    'recall': round(clamp(recall_step, 0.0, 0.9999), 4),
                    'loss_box': round(clamp(loss_box_step, 0.0001, 4.0), 4),
                    'loss_cls': round(clamp(loss_cls_step, 0.0001, 4.0), 4),
                },
            }
        )

    return metrics, metric_series


def read_csv_rows(results_csv: Path) -> List[Dict]:
    if not results_csv.is_file():
        return []

    try:
        with open(results_csv, 'r', encoding='utf-8') as fp:
            return [dict(row) for row in csv.DictReader(fp)]
    except Exception:
        return []


def read_float_from_mapping(mapping: dict, keys: List[str]) -> Optional[float]:
    for key in keys:
        if key not in mapping:
            continue
        try:
            value = float(str(mapping[key]).strip())
            if value == value:
                return value
        except Exception:
            continue
    return None


def build_metrics_from_results_rows(rows: List[Dict]) -> Tuple[Dict, List]:
    if not rows:
        return {}, []

    metric_series = []
    for index, row in enumerate(rows):
        map_value = read_float_from_mapping(row, ['metrics/mAP50-95(B)', 'metrics/mAP50-95'])
        precision = read_float_from_mapping(row, ['metrics/precision(B)', 'metrics/precision'])
        recall = read_float_from_mapping(row, ['metrics/recall(B)', 'metrics/recall'])
        loss_box = read_float_from_mapping(row, ['train/box_loss', 'val/box_loss'])
        loss_cls = read_float_from_mapping(row, ['train/cls_loss', 'val/cls_loss'])

        metrics = {}
        if map_value is not None:
            metrics['map'] = round(clamp(map_value, 0.0, 1.0), 4)
        if precision is not None:
            metrics['precision'] = round(clamp(precision, 0.0, 1.0), 4)
        if recall is not None:
            metrics['recall'] = round(clamp(recall, 0.0, 1.0), 4)
        if loss_box is not None:
            metrics['loss_box'] = round(max(0.0001, loss_box), 4)
        if loss_cls is not None:
            metrics['loss_cls'] = round(max(0.0001, loss_cls), 4)
        if metrics:
            metric_series.append({'step': index + 1, 'metrics': metrics})

    if not metric_series:
        return {}, []

    return metric_series[-1]['metrics'], metric_series


def build_metrics_from_results_dict(results_dict: dict) -> dict:
    if not isinstance(results_dict, dict):
        return {}

    metrics = {}
    map_value = read_float_from_mapping(results_dict, ['metrics/mAP50-95(B)', 'metrics/mAP50-95'])
    precision = read_float_from_mapping(results_dict, ['metrics/precision(B)', 'metrics/precision'])
    recall = read_float_from_mapping(results_dict, ['metrics/recall(B)', 'metrics/recall'])
    loss_box = read_float_from_mapping(results_dict, ['train/box_loss', 'val/box_loss'])
    loss_cls = read_float_from_mapping(results_dict, ['train/cls_loss', 'val/cls_loss'])

    if map_value is not None:
        metrics['map'] = round(clamp(map_value, 0.0, 1.0), 4)
    if precision is not None:
        metrics['precision'] = round(clamp(precision, 0.0, 1.0), 4)
    if recall is not None:
        metrics['recall'] = round(clamp(recall, 0.0, 1.0), 4)
    if loss_box is not None:
        metrics['loss_box'] = round(max(0.0001, loss_box), 4)
    if loss_cls is not None:
        metrics['loss_cls'] = round(max(0.0001, loss_cls), 4)
    return metrics


def try_real_train(args, config: dict, summary: dict):
    if not should_try_real():
        return None, ''

    if args.task_type != 'detection':
        return None, f'real_train_skipped:task_not_implemented:{args.task_type}'

    materialized = extract_materialized_dataset(config)
    data_yaml = str(materialized.get('yolo_data_yaml', '')).strip()
    copied_image_count = to_int(materialized.get('copied_image_count', 0), 0)
    labeled_item_count = to_int(materialized.get('labeled_item_count', 0), 0)
    if not data_yaml:
        return None, 'real_train_skipped:missing_yolo_data_yaml'
    if not os.path.isfile(data_yaml):
        return None, 'real_train_skipped:yolo_data_yaml_not_found'
    if copied_image_count <= 0:
        return None, 'real_train_skipped:no_materialized_images'
    if labeled_item_count <= 0:
        return None, 'real_train_skipped:no_labeled_items'

    try:
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        return None, f'real_train_skipped:import_ultralytics_failed:{exc}'

    cfg = config.get('config', {}) if isinstance(config.get('config'), dict) else {}
    epochs = to_int(cfg.get('epochs', 8), 8)
    batch_size = to_int(cfg.get('batch_size', 4), 4)
    image_size = to_int(cfg.get('image_size', 640), 640)
    learning_rate = to_float(cfg.get('learning_rate', 0.001), 0.001)
    device = (os.getenv('VISTRAL_YOLO_DEVICE', 'cpu') or 'cpu').strip()
    project_dir = Path(args.workspace_dir or os.path.dirname(args.metrics_path)) / 'ultralytics'
    run_name = 'run'
    model_source = resolve_base_model(args.base_model)

    try:
        model = YOLO(model_source)
        results = model.train(
            data=data_yaml,
            epochs=epochs,
            batch=batch_size,
            imgsz=image_size,
            lr0=learning_rate,
            project=str(project_dir),
            name=run_name,
            exist_ok=True,
            device=device,
            verbose=False,
        )

        save_dir = Path(getattr(results, 'save_dir', project_dir / run_name))
        weights_dir = save_dir / 'weights'
        best_path = weights_dir / 'best.pt'
        if not best_path.is_file():
            best_path = weights_dir / 'last.pt'
        if not best_path.is_file():
            return None, 'real_train_failed:missing_best_weight'

        artifact_model_path = Path(args.artifact_path).parent / f'{args.job_id}-best.pt'
        artifact_model_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best_path, artifact_model_path)

        results_csv = save_dir / 'results.csv'
        metrics, metric_series = build_metrics_from_results_rows(read_csv_rows(results_csv))
        if not metrics:
            metrics = build_metrics_from_results_dict(getattr(results, 'results_dict', {}) or {})
        if not metric_series and metrics:
            metric_series = [{'step': 1, 'metrics': metrics}]

        if not metrics:
            return None, 'real_train_failed:metrics_not_found'

        metrics_payload = {
            'summary': metrics,
            'metric_series': metric_series,
        }
        write_json(args.metrics_path, metrics_payload)

        artifact_payload = {
            'runner': 'yolo_train_runner',
            'mode': 'real',
            'training_performed': True,
            'job_id': args.job_id,
            'dataset_id': args.dataset_id,
            'task_type': args.task_type,
            'base_model': model_source,
            'epochs': epochs,
            'device': device,
            'data_yaml': data_yaml,
            'save_dir': str(save_dir),
            'results_csv': str(results_csv) if results_csv.is_file() else '',
            'primary_model_path': str(artifact_model_path),
            'source_model_path': str(best_path),
            'metrics': metrics,
            'metric_series': metric_series,
            'materialized_dataset': materialized,
            'generated_at': datetime.now(timezone.utc).isoformat(),
        }
        write_json(args.artifact_path, artifact_payload)

        return artifact_payload, ''
    except Exception as exc:
        return None, f'real_train_failed:{exc}'


def main() -> int:
    parser = argparse.ArgumentParser(description='Vistral YOLO local training runner')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--dataset-id', required=True)
    parser.add_argument('--task-type', required=True)
    parser.add_argument('--base-model', required=True)
    parser.add_argument('--workspace-dir', default='')
    parser.add_argument('--config-path', default='')
    parser.add_argument('--summary-path', default='')
    parser.add_argument('--metrics-path', required=True)
    parser.add_argument('--artifact-path', default='')
    args = parser.parse_args()

    summary = read_json(args.summary_path)
    config = read_json(args.config_path)
    cfg = config.get('config', {}) if isinstance(config.get('config'), dict) else {}
    epochs = to_int(cfg.get('epochs', 8), 8)

    real_payload, reason = try_real_train(args, config, summary)
    if real_payload is None:
        metrics, metric_series = build_template_metrics(args, summary, config)
        template_reason = reason if reason else 'template_mode_default'
        metrics_payload = {
            'summary': metrics,
            'metric_series': metric_series,
        }
        write_json(args.metrics_path, metrics_payload)

        if args.artifact_path:
            artifact_payload = {
                'runner': 'yolo_train_runner',
                'mode': 'template',
                'training_performed': False,
                'job_id': args.job_id,
                'dataset_id': args.dataset_id,
                'task_type': args.task_type,
                'base_model': args.base_model,
                'epochs': epochs,
                'metrics': metrics,
                'metric_series': metric_series,
                'fallback_reason': template_reason,
                'template_reason': template_reason,
                'materialized_dataset': extract_materialized_dataset(config),
                'generated_at': datetime.now(timezone.utc).isoformat(),
            }
            write_json(args.artifact_path, artifact_payload)

        print(f"[yolo-runner] workspace={args.workspace_dir}")
        print(f"[yolo-runner] metrics_path={args.metrics_path}")
        if reason:
            print(f"[yolo-runner] fallback_reason={reason}")
        print(json.dumps({'runner': 'yolo_train_runner', 'mode': 'template', 'metrics': metrics}, ensure_ascii=False))
        return 0

    print(f"[yolo-runner] workspace={args.workspace_dir}")
    print(f"[yolo-runner] metrics_path={args.metrics_path}")
    print(json.dumps({'runner': 'yolo_train_runner', 'mode': 'real', 'metrics': real_payload['metrics']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
