#!/usr/bin/env python3
"""Generate aligned Pixel Lab room-cell backgrounds for the unified 3x3 house."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/assets/vistral-workshop/generated/house-room-backgrounds'
SIZE = (384, 256)

ROOMS = [
    ('reception', 'reception-command'),
    ('datasets', 'dataset-warehouse'),
    ('annotation', 'data-processing-annotation'),
    ('recipes', 'feature-recipe'),
    ('training', 'model-training'),
    ('exam', 'inference-validation'),
    ('publish', 'model-publishing'),
    ('runtime', 'deployment-runtime'),
    ('bugs', 'feedback-repair'),
]

PALETTE = {
    'wall': (244, 211, 166, 255),
    'wall_light': (255, 236, 194, 255),
    'wall_shadow': (215, 166, 108, 255),
    'wood': (132, 82, 45, 255),
    'wood_dark': (80, 47, 31, 255),
    'wood_light': (177, 112, 58, 255),
    'floor': (191, 132, 72, 255),
    'floor_light': (220, 160, 91, 255),
    'ink': (55, 37, 25, 255),
    'teal': (34, 76, 73, 255),
    'teal_dark': (25, 52, 55, 255),
    'blue': (44, 151, 232, 255),
    'green': (74, 179, 92, 255),
    'orange': (217, 138, 46, 255),
    'red': (196, 76, 54, 255),
    'purple': (123, 82, 166, 255),
    'paper': (255, 239, 198, 255),
    'metal': (76, 87, 91, 255),
    'metal_light': (126, 145, 145, 255),
    'screen': (45, 99, 93, 255),
}

ACCENTS = {
    'reception': PALETTE['blue'],
    'datasets': PALETTE['green'],
    'annotation': PALETTE['orange'],
    'recipes': PALETTE['purple'],
    'training': PALETTE['green'],
    'exam': PALETTE['blue'],
    'publish': (226, 166, 54, 255),
    'runtime': (58, 157, 129, 255),
    'bugs': PALETTE['red'],
}


def rect(draw: ImageDraw.ImageDraw, box, fill, outline=None, width=1):
    draw.rectangle([int(v) for v in box], fill=fill, outline=outline, width=width)


def line(draw: ImageDraw.ImageDraw, points, fill, width=1):
    draw.line([(int(x), int(y)) for x, y in points], fill=fill, width=width)


def draw_base(room_id: str) -> Image.Image:
    img = Image.new('RGBA', SIZE, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w, h = SIZE
    accent = ACCENTS[room_id]

    # Shared wall and floor baseline. This is intentionally identical in every room.
    rect(d, (0, 0, w, 170), PALETTE['wall'])
    rect(d, (0, 0, w, 30), PALETTE['wall_light'])
    for x in range(0, w, 32):
        line(d, [(x, 0), (x + 18, 170)], (232, 188, 132, 90), 1)
    for y in range(38, 164, 34):
        line(d, [(0, y), (w, y + 5)], (255, 244, 210, 70), 1)

    # Ceiling beam, back rail, and floor, with no heavy outer frame so the shared House grid owns borders.
    rect(d, (0, 0, w, 12), PALETTE['wood_dark'])
    for x in range(8, w, 28):
        rect(d, (x, 2, x + 14, 8), PALETTE['wood_light'])
    rect(d, (0, 162, w, 175), PALETTE['wood_dark'])
    rect(d, (0, 175, w, h), PALETTE['floor'])
    for y in range(184, h, 22):
        line(d, [(0, y), (w, y - 8)], (145, 86, 45, 160), 2)
    for x in range(-40, w + 60, 56):
        line(d, [(x, h), (x + 70, 175)], (154, 93, 49, 120), 2)
    rect(d, (0, h - 10, w, h), PALETTE['wood_dark'])

    # Small accent plaque without readable text.
    rect(d, (20, 22, 104, 48), PALETTE['wood_dark'])
    rect(d, (26, 27, 98, 43), accent)
    for x in range(34, 88, 12):
        rect(d, (x, 32, x + 7, 38), (255, 240, 191, 210))

    # Shared light.
    line(d, [(w // 2, 10), (w // 2, 38)], PALETTE['wood_dark'], 3)
    rect(d, (w // 2 - 18, 38, w // 2 + 18, 48), PALETTE['wood_dark'])
    rect(d, (w // 2 - 13, 48, w // 2 + 13, 64), (255, 213, 104, 235))
    rect(d, (w // 2 - 19, 64, w // 2 + 19, 68), (169, 103, 53, 255))

    return img


def draw_screen(d, x, y, w=74, h=46, accent=None):
    accent = accent or PALETTE['green']
    rect(d, (x, y, x + w, y + h), PALETTE['teal_dark'], PALETTE['wood_dark'], 3)
    rect(d, (x + 7, y + 7, x + w - 7, y + h - 11), PALETTE['screen'])
    for i in range(3):
        line(d, [(x + 15, y + 17 + i * 7), (x + w - 17, y + 13 + i * 7)], accent, 2)
    rect(d, (x + w // 2 - 7, y + h, x + w // 2 + 7, y + h + 13), PALETTE['metal'])
    rect(d, (x + w // 2 - 22, y + h + 13, x + w // 2 + 22, y + h + 18), PALETTE['metal_light'])


def draw_crate(d, x, y, w=36, h=28, fill=None):
    fill = fill or (172, 106, 52, 255)
    rect(d, (x, y, x + w, y + h), fill, PALETTE['wood_dark'], 2)
    line(d, [(x + 5, y + 4), (x + w - 5, y + h - 5)], PALETTE['wood_dark'], 1)
    line(d, [(x + w - 5, y + 4), (x + 5, y + h - 5)], PALETTE['wood_dark'], 1)


def draw_shelf(d, x, y, w=102, h=86):
    rect(d, (x, y, x + w, y + h), (111, 65, 37, 255), PALETTE['wood_dark'], 3)
    for yy in (y + 25, y + 52):
        rect(d, (x + 3, yy, x + w - 3, yy + 5), PALETTE['wood_dark'])
    for i in range(8):
        bx = x + 8 + (i % 4) * 22
        by = y + 8 + (i // 4) * 30
        rect(d, (bx, by, bx + 13, by + 17), [(66, 129, 89, 255), (45, 107, 170, 255), (215, 138, 52, 255), (139, 93, 169, 255)][i % 4])


def draw_server(d, x, y, w=52, h=92):
    rect(d, (x, y, x + w, y + h), (41, 48, 52, 255), PALETTE['wood_dark'], 3)
    for i in range(5):
        yy = y + 9 + i * 16
        rect(d, (x + 7, yy, x + w - 7, yy + 9), (29, 36, 39, 255), (81, 95, 96, 255), 1)
        rect(d, (x + 12, yy + 3, x + 17, yy + 6), PALETTE['green'])
        rect(d, (x + w - 16, yy + 3, x + w - 10, yy + 6), PALETTE['orange'])


def draw_plants(d, x, y):
    rect(d, (x, y + 24, x + 24, y + 42), (152, 88, 47, 255), PALETTE['wood_dark'], 2)
    for dx, dy, col in [(-5, 10, (58, 153, 84, 255)), (4, 1, (71, 178, 91, 255)), (13, 10, (45, 131, 74, 255)), (5, 14, (87, 188, 100, 255))]:
        rect(d, (x + dx, y + dy, x + dx + 14, y + dy + 18), col)


def room_reception(d):
    rect(d, (96, 118, 250, 176), (139, 81, 43, 255), PALETTE['wood_dark'], 3)
    rect(d, (116, 86, 224, 128), (166, 97, 48, 255), PALETTE['wood_dark'], 3)
    draw_screen(d, 38, 92, 62, 42, PALETTE['blue'])
    rect(d, (264, 70, 346, 130), PALETTE['paper'], PALETTE['wood_dark'], 3)
    for i in range(4):
        rect(d, (276, 82 + i * 11, 334, 87 + i * 11), (94, 137, 151, 255))
    draw_plants(d, 298, 132)


def room_datasets(d):
    draw_shelf(d, 22, 62, 128, 104)
    for x, y in [(170, 130), (212, 137), (255, 124), (302, 143)]:
        draw_crate(d, x, y, 38, 30)
    rect(d, (220, 54, 342, 108), PALETTE['teal_dark'], PALETTE['wood_dark'], 3)
    for i, col in enumerate([PALETTE['green'], PALETTE['blue'], PALETTE['orange']]):
        rect(d, (235 + i * 34, 68, 258 + i * 34, 92), col, PALETTE['wood_dark'], 2)


def room_annotation(d):
    draw_screen(d, 198, 74, 92, 58, PALETTE['orange'])
    rect(d, (42, 84, 150, 146), PALETTE['paper'], PALETTE['wood_dark'], 3)
    for i, col in enumerate([PALETTE['green'], PALETTE['orange'], PALETTE['blue'], PALETTE['red']]):
        rect(d, (57, 96 + i * 11, 68, 104 + i * 11), col)
        rect(d, (77, 98 + i * 11, 132, 102 + i * 11), (121, 86, 62, 255))
    rect(d, (176, 152, 318, 182), (137, 82, 45, 255), PALETTE['wood_dark'], 3)
    draw_crate(d, 306, 138, 34, 28, (63, 117, 174, 255))


def room_recipes(d):
    rect(d, (72, 58, 306, 137), (40, 85, 70, 255), PALETTE['wood_dark'], 4)
    for i in range(4):
        y = 76 + i * 14
        rect(d, (94, y, 130, y + 6), (231, 223, 172, 255))
        rect(d, (152, y, 182, y + 6), PALETTE['blue'])
        rect(d, (204, y, 250, y + 6), PALETTE['green'])
        line(d, [(136, y + 3), (146, y + 3)], PALETTE['paper'], 2)
        line(d, [(188, y + 3), (198, y + 3)], PALETTE['paper'], 2)
    rect(d, (42, 142, 120, 179), (112, 66, 40, 255), PALETTE['wood_dark'], 2)
    rect(d, (274, 120, 334, 178), (73, 52, 84, 255), PALETTE['wood_dark'], 3)
    rect(d, (287, 83, 318, 119), (66, 183, 211, 210), PALETTE['wood_dark'], 2)


def room_training(d):
    draw_server(d, 30, 82, 62, 96)
    draw_screen(d, 124, 72, 104, 58, PALETTE['green'])
    draw_screen(d, 244, 84, 84, 50, PALETTE['blue'])
    rect(d, (116, 150, 334, 184), (133, 78, 43, 255), PALETTE['wood_dark'], 3)
    rect(d, (136, 141, 292, 151), PALETTE['teal_dark'], PALETTE['wood_dark'], 2)
    rect(d, (142, 144, 236, 148), PALETTE['green'])


def room_exam(d):
    rect(d, (44, 76, 140, 156), PALETTE['paper'], PALETTE['wood_dark'], 3)
    for i in range(3):
        rect(d, (60, 92 + i * 18, 75, 107 + i * 18), [PALETTE['green'], PALETTE['orange'], PALETTE['blue']][i], PALETTE['wood_dark'], 1)
        rect(d, (84, 96 + i * 18, 122, 102 + i * 18), (100, 81, 64, 255))
    draw_screen(d, 176, 72, 106, 58, PALETTE['blue'])
    rect(d, (154, 150, 330, 184), (132, 79, 45, 255), PALETTE['wood_dark'], 3)
    rect(d, (294, 76, 338, 134), PALETTE['teal_dark'], PALETTE['wood_dark'], 2)
    rect(d, (304, 88, 328, 122), (92, 149, 190, 255))


def room_publish(d):
    draw_shelf(d, 34, 72, 94, 90)
    rect(d, (176, 78, 292, 158), (204, 145, 64, 255), PALETTE['wood_dark'], 4)
    rect(d, (192, 96, 276, 136), (236, 181, 82, 255), PALETTE['wood_dark'], 2)
    rect(d, (210, 112, 258, 122), (92, 61, 42, 255))
    rect(d, (152, 158, 324, 185), (131, 78, 43, 255), PALETTE['wood_dark'], 3)
    rect(d, (308, 58, 344, 112), PALETTE['teal_dark'], PALETTE['wood_dark'], 2)
    for i in range(3):
        rect(d, (315, 68 + i * 12, 337, 73 + i * 12), [PALETTE['green'], PALETTE['orange'], PALETTE['blue']][i])


def room_runtime(d):
    draw_server(d, 34, 80, 58, 102)
    draw_server(d, 284, 80, 58, 102)
    draw_screen(d, 122, 76, 118, 64, PALETTE['green'])
    rect(d, (114, 154, 252, 184), (127, 77, 44, 255), PALETTE['wood_dark'], 3)
    for i, col in enumerate([PALETTE['green'], PALETTE['green'], PALETTE['orange']]):
        rect(d, (136, 92 + i * 13, 146, 101 + i * 13), col)
        rect(d, (156, 94 + i * 13, 218, 99 + i * 13), (116, 169, 142, 255))


def room_bugs(d):
    rect(d, (46, 76, 142, 154), (120, 70, 42, 255), PALETTE['wood_dark'], 3)
    for i in range(7):
        draw_crate(d, 56 + (i % 3) * 27, 88 + (i // 3) * 24, 22, 17, (158, 92, 48, 255))
    rect(d, (184, 78, 318, 143), PALETTE['teal_dark'], PALETTE['wood_dark'], 3)
    for i, col in enumerate([PALETTE['red'], PALETTE['orange'], PALETTE['green']]):
        rect(d, (200, 94 + i * 14, 213, 104 + i * 14), col)
        rect(d, (224, 96 + i * 14, 296, 101 + i * 14), (137, 118, 86, 255))
    rect(d, (174, 152, 332, 184), (130, 77, 43, 255), PALETTE['wood_dark'], 3)
    rect(d, (296, 144, 342, 178), (184, 91, 46, 255), PALETTE['wood_dark'], 2)


DRAWERS = {
    'reception': room_reception,
    'datasets': room_datasets,
    'annotation': room_annotation,
    'recipes': room_recipes,
    'training': room_training,
    'exam': room_exam,
    'publish': room_publish,
    'runtime': room_runtime,
    'bugs': room_bugs,
}


def pixelate(img: Image.Image) -> Image.Image:
    # Keep hard pixel edges while still outputting a modern UI-sized PNG.
    small = img.resize((SIZE[0] // 2, SIZE[1] // 2), Image.Resampling.NEAREST)
    return small.resize(SIZE, Image.Resampling.NEAREST)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        'generated_by': 'scripts/generate-house-room-backgrounds.py',
        'style_reference': 'src-img/新工作台.png',
        'layout_reference': 'src-img/方案效果总览.png',
        'output_size': list(SIZE),
        'rules': [
            'same dimensions for all nine rooms',
            'same wall/floor baseline and cutaway perspective',
            'no individual outer room frame',
            'no readable baked text',
            'full-cell backgrounds for the unified Pixel Lab House grid'
        ],
        'rooms': []
    }

    atlas = Image.new('RGBA', (SIZE[0] * 3, SIZE[1] * 3), (0, 0, 0, 0))
    for index, (room_id, slug) in enumerate(ROOMS):
        img = draw_base(room_id)
        DRAWERS[room_id](ImageDraw.Draw(img))
        img = pixelate(img)
        room_dir = OUT / slug
        room_dir.mkdir(parents=True, exist_ok=True)
        out_file = room_dir / 'prop.png'
        img.save(out_file)
        atlas.alpha_composite(img, ((index % 3) * SIZE[0], (index // 3) * SIZE[1]))
        manifest['rooms'].append({
            'id': room_id,
            'label': slug,
            'image': str(out_file.relative_to(ROOT)),
            'size': list(SIZE),
            'grid': [index // 3, index % 3],
            'edge_touch': False,
            'status': 'accepted'
        })

    atlas.save(OUT / 'atlas.png')
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
