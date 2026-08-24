#!/usr/bin/env python3
"""
Build the single-glyph vLLM "V" icon font used by `contributes.icons`.

Output: resources/vllm-icon.woff2  (glyph 'vllm-v' at U+E001)

The outline is derived from resources/vllm-icon.svg, which draws the logo as
TWO overlapping wedges:

  Left  wedge (path5, yellow): triangle (41.05,27.29) (41.05,82.60) (13.39,27.29)
        inside <g transform="matrix(1.1848812,0,0,1.1438091,-7.7219663,-6.2747532)">
        -> final points (40.93,24.94) (40.93,88.20) (8.15,24.94)

  Right wedge (path6, blue):   polygon (40.07,88.64) (65.82,88.64) (87.92,8.13) (57.61,23.53)

Mapped into a monochrome glyph from the 96x96 SVG viewBox (y-down) into a
1000-unit em (y-up) with ~100-unit side bearings, scale 10x.

Run:  python temp/build-vllm-icon-font.py
Requires: fonttools (+ brotli for woff2)
"""

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

EM = 1000
SCALE = 10.0

SVG_LEFT_TRIANGLE = [
    (40.93, 24.94),
    (40.93, 88.21),
    (8.15, 24.94),
]
SVG_RIGHT_WEDGE = [
    (40.07, 88.64),
    (65.82, 88.64),
    (87.92, 8.13),
    (57.61, 23.53),
]
SVG_STROKE_WIDTH = 1.62273


def line_intersection(first_line, second_line):
    first_point, first_direction = first_line
    second_point, second_direction = second_line
    determinant = first_direction[0] * second_direction[1] - first_direction[1] * second_direction[0]
    if abs(determinant) < 1e-9:
        raise ValueError('Cannot offset parallel polygon edges')
    delta = (second_point[0] - first_point[0], second_point[1] - first_point[1])
    distance = (delta[0] * second_direction[1] - delta[1] * second_direction[0]) / determinant
    return (
        first_point[0] + distance * first_direction[0],
        first_point[1] + distance * first_direction[1],
    )


def offset_polygon(points, distance):
    lines = []
    for index, start in enumerate(points):
        end = points[(index + 1) % len(points)]
        direction = (end[0] - start[0], end[1] - start[1])
        length = (direction[0] ** 2 + direction[1] ** 2) ** 0.5
        left_normal = (-direction[1] / length, direction[0] / length)
        offset_start = (
            start[0] + left_normal[0] * distance,
            start[1] + left_normal[1] * distance,
        )
        lines.append((offset_start, direction))

    return [
        line_intersection(lines[(index - 1) % len(lines)], lines[index])
        for index in range(len(lines))
    ]


left_half_stroke = SVG_STROKE_WIDTH / 2
left_outer = offset_polygon(SVG_LEFT_TRIANGLE, -left_half_stroke)
left_inner = list(reversed(offset_polygon(SVG_LEFT_TRIANGLE, left_half_stroke)))

# The outer and reversed inner contours leave the left triangle hollow.
SVG_CONTOURS = [left_outer, left_inner, SVG_RIGHT_WEDGE]

all_points = [point for contour in SVG_CONTOURS for point in contour]
xs = [p[0] for p in all_points]
ys = [p[1] for p in all_points]
x_min, x_max = min(xs), max(xs)
y_min, y_max = min(ys), max(ys)

# side bearings ~ half of the leftover em space
left = (EM - (x_max - x_min) * SCALE) / 2.0
bottom = (EM - (y_max - y_min) * SCALE) / 2.0


def to_font(x, y):
    # y-down SVG -> y-up font
    return (round(left + (x - x_min) * SCALE, 2), round(bottom + (y_max - y) * SCALE, 2))


print("font outline (y-up, em=1000):")
pen = TTGlyphPen(None)
for contour in SVG_CONTOURS:
    font_points = [to_font(x, y) for x, y in contour]
    print(f"  {font_points}")
    pen.moveTo(font_points[0])
    for point in font_points[1:]:
        pen.lineTo(point)
    pen.closePath()
v_glyph = pen.glyph()

# minimal .notdef (empty is fine; we never reference it)
pen_notdef = TTGlyphPen(None)
notdef_glyph = pen_notdef.glyph()

glyph_order = ['.notdef', 'vllm-v']
cmap = {0xE001: 'vllm-v'}

fb = FontBuilder(EM, isTTF=True)
fb.setupGlyphOrder(glyph_order)
fb.setupCharacterMap(cmap)
fb.setupGlyf({'vllm-v': v_glyph, '.notdef': notdef_glyph})
fb.setupHorizontalMetrics({
    '.notdef': (EM, 0),
    'vllm-v': (EM, 0),
})
fb.setupHorizontalHeader(ascent=EM, descent=0)
fb.setupNameTable({
    'familyName': 'vLLM-Copilot Model Icon',
    'styleName': 'Regular',
    'uniqueFontIdentifier': 'vllm-copilot model icon',
    'fullName': 'vLLM-Copilot Model Icon',
    'psName': 'vllm-copilot-model-icon',
    'version': '1.0',
})
fb.setupOS2(sTypoAscender=EM, sTypoDescender=0, usWinAscent=EM, usWinDescent=0)
fb.setupPost()

import os
out = os.path.join(os.path.dirname(__file__), '..', 'resources', 'vllm-icon.woff2')
fb.font.flavor = 'woff2'
fb.font.save(os.path.normpath(out))
print(f"\nwrote {os.path.normpath(out)}")
