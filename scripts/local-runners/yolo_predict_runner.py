#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from datetime import datetime, timezone


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def ratio_from_seed(seed: int, lower: float, upper: float) -> float:
    bucket = abs(seed % 10000) / 10000.0
    return lower + (upper - lower) * bucket


def file_hash(path: str) -> bytes:
    hasher = hashlib.sha256()
    if not path:
        hasher.update(b'no-input-path')
        return hasher.digest()

    try:
        with open(path, 'rb') as fp:
            while True:
                chunk = fp.read(1024 * 1024)
                if not chunk:
                    break
                hasher.update(chunk)
    except Exception:
        hasher.update(path.encode('utf-8'))

    return hasher.digest()


def write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(payload, fp, ensure_ascii=False)


def build_template_payload(args, fallback_reason: str = '') -> dict:
    digest = file_hash(args.input_path)
    seed = int.from_bytes(digest[:4], byteorder='big', signed=False)

    width = int(ratio_from_seed(seed, 960, 1920))
    height = int(ratio_from_seed(seed >> 3, 540, 1080))

    payload = {
        'image': {
            'filename': args.filename,
            'width': width,
            'height': height,
        },
        'meta': {
            'runner': 'yolo_predict_runner',
            'task_type': args.task_type,
            'mode': 'template',
            'generated_at': datetime.now(timezone.utc).isoformat(),
        },
    }

    if fallback_reason:
        payload['meta']['fallback_reason'] = fallback_reason

    if args.task_type == 'detection':
        x = int(ratio_from_seed(seed >> 5, 40, 460))
        y = int(ratio_from_seed(seed >> 7, 40, 280))
        box_w = int(ratio_from_seed(seed >> 9, 120, 320))
        box_h = int(ratio_from_seed(seed >> 11, 80, 220))
        score = round(clamp(ratio_from_seed(seed >> 13, 0.72, 0.99), 0.0, 1.0), 4)
        payload['boxes'] = [
            {
                'x': x,
                'y': y,
                'width': box_w,
                'height': box_h,
                'label': 'detected_object',
                'score': score,
            }
        ]
    elif args.task_type == 'segmentation':
        payload['polygons'] = [
            {
                'label': 'region',
                'score': round(ratio_from_seed(seed >> 5, 0.72, 0.95), 4),
                'points': [
                    {'x': 80, 'y': 90},
                    {'x': 260, 'y': 120},
                    {'x': 240, 'y': 320},
                    {'x': 60, 'y': 300},
                ],
            }
        ]
        payload['masks'] = [
            {
                'label': 'region',
                'score': round(ratio_from_seed(seed >> 8, 0.7, 0.94), 4),
                'encoding': 'template-rle',
            }
        ]
    elif args.task_type == 'obb':
        payload['rotated_boxes'] = [
            {
                'cx': round(ratio_from_seed(seed >> 4, 220, 560), 2),
                'cy': round(ratio_from_seed(seed >> 8, 160, 420), 2),
                'width': round(ratio_from_seed(seed >> 11, 80, 240), 2),
                'height': round(ratio_from_seed(seed >> 13, 40, 140), 2),
                'angle': round(ratio_from_seed(seed >> 16, -25, 25), 2),
                'label': 'rotated_target',
                'score': round(ratio_from_seed(seed >> 18, 0.75, 0.97), 4),
            }
        ]
    else:
        payload['labels'] = [
            {'label': 'normal', 'score': round(ratio_from_seed(seed >> 5, 0.5, 0.95), 4)},
            {'label': 'abnormal', 'score': round(ratio_from_seed(seed >> 9, 0.05, 0.5), 4)},
        ]

    return payload


def try_real_predict(args):
    if os.getenv('VISTRAL_RUNNER_ENABLE_REAL', '0') != '1':
        return None, ''

    if not args.input_path or not os.path.exists(args.input_path):
        return None, 'real_predict_skipped:missing_input_path'

    model_path = (args.model_path or '').strip() or os.getenv('VISTRAL_YOLO_MODEL_PATH', '').strip()
    if not model_path:
        return None, 'real_predict_skipped:missing_model_path'
    if not os.path.exists(model_path):
        return None, 'real_predict_skipped:model_path_not_found'

    try:
        from ultralytics import YOLO  # type: ignore
    except Exception as exc:
        return None, f'real_predict_skipped:import_ultralytics_failed:{exc}'

    try:
        conf_threshold = float(os.getenv('VISTRAL_YOLO_PREDICT_CONF', '0.01'))
    except Exception:
        conf_threshold = 0.01

    try:
        max_detections = int(os.getenv('VISTRAL_YOLO_PREDICT_MAX_DET', '20'))
    except Exception:
        max_detections = 20

    conf_threshold = clamp(conf_threshold, 0.0001, 1.0)
    max_detections = max(1, min(max_detections, 200))

    try:
        model = YOLO(model_path)
        result_list = model.predict(
            source=args.input_path,
            verbose=False,
            conf=conf_threshold,
            max_det=max_detections,
        )
        if not result_list:
            return None, 'real_predict_failed:empty_results'

        result = result_list[0]
        names = getattr(result, 'names', {}) or {}
        orig_shape = getattr(result, 'orig_shape', None) or (0, 0)
        height = int(orig_shape[0]) if len(orig_shape) > 0 else 0
        width = int(orig_shape[1]) if len(orig_shape) > 1 else 0

        payload = {
            'image': {
                'filename': args.filename,
                'width': width,
                'height': height,
            },
            'meta': {
                'runner': 'yolo_predict_runner',
                'task_type': args.task_type,
                'mode': 'real',
                'model_path': model_path,
                'predict_conf': round(conf_threshold, 6),
                'max_det': max_detections,
                'generated_at': datetime.now(timezone.utc).isoformat(),
            },
        }

        if args.task_type == 'detection':
            boxes_payload = []
            boxes = getattr(result, 'boxes', None)
            if boxes is not None:
                xyxy = boxes.xyxy.tolist() if getattr(boxes, 'xyxy', None) is not None else []
                conf = boxes.conf.tolist() if getattr(boxes, 'conf', None) is not None else []
                cls_ids = boxes.cls.tolist() if getattr(boxes, 'cls', None) is not None else []
                for idx in range(min(len(xyxy), 30)):
                    x1, y1, x2, y2 = xyxy[idx]
                    class_id = int(cls_ids[idx]) if idx < len(cls_ids) else -1
                    label = names.get(class_id, str(class_id))
                    score = float(conf[idx]) if idx < len(conf) else 0.0
                    boxes_payload.append(
                        {
                            'x': round(float(x1), 2),
                            'y': round(float(y1), 2),
                            'width': round(float(x2) - float(x1), 2),
                            'height': round(float(y2) - float(y1), 2),
                            'label': str(label),
                            'score': round(clamp(score, 0.0, 1.0), 4),
                        }
                    )
            payload['boxes'] = boxes_payload
        else:
            return None, f'real_predict_skipped:task_not_implemented:{args.task_type}'

        return payload, ''
    except Exception as exc:
        return None, f'real_predict_failed:{exc}'


def main() -> int:
    parser = argparse.ArgumentParser(description='Vistral YOLO local predict template runner')
    parser.add_argument('--model-id', required=True)
    parser.add_argument('--model-version-id', required=True)
    parser.add_argument('--task-type', required=True)
    parser.add_argument('--input-path', default='')
    parser.add_argument('--filename', default='sample.jpg')
    parser.add_argument('--model-path', default='')
    parser.add_argument('--output-path', required=True)
    args = parser.parse_args()

    real_payload, reason = try_real_predict(args)
    payload = real_payload if real_payload is not None else build_template_payload(args, reason)

    write_json(args.output_path, payload)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
