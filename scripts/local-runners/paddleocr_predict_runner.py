#!/usr/bin/env python3
import argparse
import json
import os
from datetime import datetime, timezone


def read_text_lines(path: str) -> list:
    if not path:
        return []

    try:
        with open(path, 'r', encoding='utf-8') as fp:
            return [line.strip() for line in fp.readlines() if line.strip()][:5]
    except Exception:
        return []


def write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(payload, fp, ensure_ascii=False)


def infer_image_shape(path: str) -> tuple:
    if not path or not os.path.exists(path):
        return 0, 0
    try:
        from PIL import Image  # type: ignore
        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:
        return 0, 0


def build_template_payload(args, fallback_reason: str = '') -> dict:
    lines = read_text_lines(args.input_path)
    if not lines:
        lines = ['TRAIN-0189', 'CAR-DOOR-OK']

    width, height = infer_image_shape(args.input_path)
    if width <= 0 or height <= 0:
        width, height = 1280, 720

    payload = {
        'image': {
            'filename': args.filename,
            'width': width,
            'height': height,
        },
        'ocr': {
            'lines': [
                {
                    'text': item,
                    'confidence': round(0.88 + index * 0.02, 4),
                }
                for index, item in enumerate(lines)
            ],
            'words': [
                {
                    'text': word,
                    'confidence': round(0.84 + (idx % 4) * 0.03, 4),
                }
                for idx, word in enumerate(' '.join(lines).split())
            ],
        },
        'meta': {
            'runner': 'paddleocr_predict_runner',
            'mode': 'template',
            'generated_at': datetime.now(timezone.utc).isoformat(),
        },
    }

    if fallback_reason:
        payload['meta']['fallback_reason'] = fallback_reason

    return payload


def try_real_predict(args):
    if os.getenv('VISTRAL_RUNNER_ENABLE_REAL', '0') != '1':
        return None, ''

    if not args.input_path or not os.path.exists(args.input_path):
        return None, 'real_predict_skipped:missing_input_path'

    try:
        from paddleocr import PaddleOCR  # type: ignore
    except Exception as exc:
        return None, f'real_predict_skipped:import_paddleocr_failed:{exc}'

    try:
        language = os.getenv('VISTRAL_PADDLEOCR_LANG', 'ch').strip() or 'ch'
        use_gpu = os.getenv('VISTRAL_PADDLEOCR_USE_GPU', '0').strip() == '1'
        ocr = PaddleOCR(use_angle_cls=True, lang=language, show_log=False, use_gpu=use_gpu)
        result = ocr.ocr(args.input_path, cls=True)
        lines = []
        words = []
        if isinstance(result, list):
            for block in result:
                if not isinstance(block, list):
                    continue
                for item in block:
                    if not isinstance(item, list) or len(item) < 2:
                        continue
                    text_meta = item[1]
                    if not isinstance(text_meta, (list, tuple)) or len(text_meta) < 2:
                        continue
                    text = str(text_meta[0]).strip()
                    confidence = float(text_meta[1])
                    if not text:
                        continue
                    lines.append({'text': text, 'confidence': round(max(0.0, min(1.0, confidence)), 4)})
                    for token in text.split():
                        words.append({'text': token, 'confidence': round(max(0.0, min(1.0, confidence)), 4)})

        width, height = infer_image_shape(args.input_path)
        payload = {
            'image': {
                'filename': args.filename,
                'width': width if width > 0 else 1280,
                'height': height if height > 0 else 720,
            },
            'ocr': {
                'lines': lines,
                'words': words,
            },
            'meta': {
                'runner': 'paddleocr_predict_runner',
                'mode': 'real',
                'language': language,
                'use_gpu': use_gpu,
                'generated_at': datetime.now(timezone.utc).isoformat(),
            },
        }

        return payload, ''
    except Exception as exc:
        return None, f'real_predict_failed:{exc}'


def main() -> int:
    parser = argparse.ArgumentParser(description='Vistral PaddleOCR local predict template runner')
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
