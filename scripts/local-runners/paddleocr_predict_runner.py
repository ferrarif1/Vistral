#!/usr/bin/env python3
import argparse
import json
import os
from datetime import datetime, timezone


def build_paddleocr_predictor(language: str, use_gpu: bool):
    from paddleocr import PaddleOCR  # type: ignore

    device = 'gpu' if use_gpu else 'cpu'
    attempts = [
        {'use_textline_orientation': True, 'lang': language, 'device': device, 'show_log': False},
        {'use_angle_cls': True, 'lang': language, 'device': device, 'show_log': False},
        {'lang': language, 'device': device, 'show_log': False},
        {'use_textline_orientation': True, 'lang': language, 'use_gpu': use_gpu, 'show_log': False},
        {'use_angle_cls': True, 'lang': language, 'use_gpu': use_gpu, 'show_log': False},
        {'use_angle_cls': True, 'lang': language, 'use_gpu': use_gpu},
        {'use_angle_cls': True, 'lang': language, 'show_log': False},
        {'lang': language, 'show_log': False},
        {'use_angle_cls': True, 'lang': language},
        {'lang': language, 'use_gpu': use_gpu},
        {'lang': language},
    ]

    last_error = None
    for kwargs in attempts:
        try:
            return PaddleOCR(**kwargs)
        except Exception as exc:  # pragma: no cover - compatibility fallback path
            last_error = exc
            continue

    if last_error is None:
        raise RuntimeError('failed_to_build_paddleocr_predictor')
    raise last_error


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


def should_try_real() -> bool:
    normalized = os.getenv('VISTRAL_RUNNER_ENABLE_REAL', 'auto').strip().lower()
    return normalized not in {'0', 'false', 'no', 'off', 'disabled'}


def infer_image_shape(path: str) -> tuple:
    if not path or not os.path.exists(path):
        return 0, 0

    try:
        from PIL import Image  # type: ignore
        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:
        return 0, 0


def extract_lines_and_words(result_raw: object):
    lines = []
    words = []

    if not isinstance(result_raw, list):
        return lines, words

    for block in result_raw:
        if isinstance(block, dict):
            rec_texts = block.get('rec_texts')
            rec_scores = block.get('rec_scores')
            if isinstance(rec_texts, list):
                for idx, value in enumerate(rec_texts):
                    text = str(value).strip()
                    if not text:
                        continue
                    score_raw = rec_scores[idx] if isinstance(rec_scores, list) and idx < len(rec_scores) else 0.5
                    try:
                        confidence = float(score_raw)
                    except Exception:
                        confidence = 0.5
                    confidence = round(max(0.0, min(1.0, confidence)), 4)
                    lines.append({'text': text, 'confidence': confidence})
                    for token in text.split():
                        words.append({'text': token, 'confidence': confidence})
            continue

        if not isinstance(block, list):
            continue
        for item in block:
            if not isinstance(item, list) or len(item) < 2:
                continue
            text_meta = item[1]
            if not isinstance(text_meta, (list, tuple)) or len(text_meta) < 2:
                continue
            text = str(text_meta[0]).strip()
            try:
                confidence = float(text_meta[1])
            except Exception:
                confidence = 0.5
            if not text:
                continue
            confidence = round(max(0.0, min(1.0, confidence)), 4)
            lines.append({'text': text, 'confidence': confidence})
            for token in text.split():
                words.append({'text': token, 'confidence': confidence})

    return lines, words


def run_paddle_predict(predictor, image_path: str):
    try:
        return predictor.ocr(image_path, cls=True)
    except TypeError as exc:
        if 'unexpected keyword argument' not in str(exc):
            raise
        if not hasattr(predictor, 'predict'):
            raise
        return predictor.predict(image_path)


def build_template_payload(args, fallback_reason: str = '') -> dict:
    lines = read_text_lines(args.input_path)
    if not lines:
        lines = ['TEMPLATE_OCR_LINE_1', 'TEMPLATE_OCR_LINE_2']

    template_reason = fallback_reason if fallback_reason else 'template_mode_default'
    normalized_fallback_reason = fallback_reason if fallback_reason else 'template_mode_default'

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
            'fallback_reason': normalized_fallback_reason,
            'template_reason': template_reason,
            'generated_at': datetime.now(timezone.utc).isoformat(),
        },
    }

    return payload


def try_real_predict(args):
    if not should_try_real():
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
        ocr = build_paddleocr_predictor(language, use_gpu)
        result = run_paddle_predict(ocr, args.input_path)
        lines, words = extract_lines_and_words(result)

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
