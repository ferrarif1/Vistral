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
        lines = ['DOC-TR-LINE-001', 'INSPECTION-READY']

    width, height = infer_image_shape(args.input_path)
    if width <= 0 or height <= 0:
        width, height = 1280, 720

    payload = {
        'image': {
            'filename': args.filename,
            'width': width,
            'height': height,
        },
        'text_lines': [
            {
                'text': item,
                'confidence': round(0.86 + index * 0.025, 4),
            }
            for index, item in enumerate(lines)
        ],
        'words': [
            {
                'text': word,
                'confidence': round(0.83 + (idx % 5) * 0.025, 4),
            }
            for idx, word in enumerate(' '.join(lines).split())
        ],
        'meta': {
            'runner': 'doctr_predict_runner',
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
        from doctr.io import DocumentFile  # type: ignore
        from doctr.models import ocr_predictor  # type: ignore
    except Exception as exc:
        return None, f'real_predict_skipped:import_doctr_failed:{exc}'

    try:
        detector = os.getenv('VISTRAL_DOCTR_DET_ARCH', 'db_resnet50').strip() or 'db_resnet50'
        recognizer = os.getenv('VISTRAL_DOCTR_RECO_ARCH', 'crnn_vgg16_bn').strip() or 'crnn_vgg16_bn'
        predictor = ocr_predictor(det_arch=detector, reco_arch=recognizer, pretrained=True)
        document = DocumentFile.from_images(args.input_path)
        result = predictor(document)

        lines = []
        words = []
        pages = getattr(result, 'pages', [])
        for page in pages:
            blocks = getattr(page, 'blocks', [])
            for block in blocks:
                page_lines = getattr(block, 'lines', [])
                for line in page_lines:
                    line_words = getattr(line, 'words', [])
                    line_tokens = []
                    confidences = []
                    for word in line_words:
                        value = str(getattr(word, 'value', '')).strip()
                        confidence = float(getattr(word, 'confidence', 0.0))
                        if value:
                            line_tokens.append(value)
                            confidences.append(confidence)
                            words.append(
                                {
                                    'text': value,
                                    'confidence': round(max(0.0, min(1.0, confidence)), 4),
                                }
                            )
                    text = ' '.join(line_tokens).strip()
                    if text:
                        avg_conf = sum(confidences) / max(1, len(confidences))
                        lines.append(
                            {
                                'text': text,
                                'confidence': round(max(0.0, min(1.0, avg_conf)), 4),
                            }
                        )

        width, height = infer_image_shape(args.input_path)
        payload = {
            'image': {
                'filename': args.filename,
                'width': width if width > 0 else 1280,
                'height': height if height > 0 else 720,
            },
            'text_lines': lines,
            'words': words,
            'meta': {
                'runner': 'doctr_predict_runner',
                'mode': 'real',
                'det_arch': detector,
                'reco_arch': recognizer,
                'generated_at': datetime.now(timezone.utc).isoformat(),
            },
        }

        return payload, ''
    except Exception as exc:
        return None, f'real_predict_failed:{exc}'


def main() -> int:
    parser = argparse.ArgumentParser(description='Vistral docTR local predict template runner')
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
