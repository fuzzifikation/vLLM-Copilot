#!/usr/bin/env python3
"""
Build the two-glyph icon font used by `contributes.icons`.

Output: resources/vllm-icon.woff2
  'vllm-v'           at U+E001  (the vLLM "V", outline derived below)
  'openrouter-glyph' at U+E002  (parsed from resources/OR-logo.svg)

The OpenRouter glyph is the official brand mark from https://openrouter.ai/brand
(the unmodified 'Volt' glyph, kept as OR-logo.svg in resources/). Its cubic
beziers are converted to TrueType quadratics with cu2qu, and contour windings
are set TrueType-style: outer contour clockwise, counter counter-clockwise.

The vLLM outline is derived from resources/vllm-icon.svg, which draws the logo
as TWO overlapping wedges:

  Left  wedge (path5, yellow): triangle (41.05,27.29) (41.05,82.60) (13.39,27.29)
        inside <g transform="matrix(1.1848812,0,0,1.1438091,-7.7219663,-6.2747532)">
        -> final points (40.93,24.94) (40.93,88.20) (8.15,24.94)

  Right wedge (path6, blue):   polygon (40.07,88.64) (65.82,88.64) (87.92,8.13) (57.61,23.53)

Mapped into a monochrome glyph from the 96x96 SVG viewBox (y-down) into a
1000-unit em (y-up) with ~100-unit side bearings, scale 10x.

Run:  python scripts/build-icon-font.py
Requires: fonttools (+ brotli for woff2)
"""

import os
import re

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
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

# ---------------------------------------------------------------------------
# OpenRouter glyph (U+E002), parsed from resources/OR-logo.svg.
# ---------------------------------------------------------------------------

OR_SVG = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'resources', 'OR-logo.svg'))


def cubic_line(p, q):
    """Straight segment p->q expressed as a degenerate cubic (c1, c2, q)."""
    c1 = (p[0] + (q[0] - p[0]) / 3.0, p[1] + (q[1] - p[1]) / 3.0)
    c2 = (p[0] + 2.0 * (q[0] - p[0]) / 3.0, p[1] + 2.0 * (q[1] - p[1]) / 3.0)
    return (c1, c2, q)


PATH_COMMANDS = set('MmLlHhVvCcSsQqTtAaZz')


def parse_svg_path(d):
    """Parse an SVG path 'd' (absolute commands, as used by OR-logo.svg).

    Returns closed rings: a list of (start, segments) where segments are
    (c1, c2, end) cubic triples; straight lines become degenerate cubics.
    """
    tokens = re.findall(r'[MmLlHhVvCcSsQqTtAaZz]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?', d)
    rings = []
    cmd = None
    start = pos = None
    segs = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in PATH_COMMANDS:
            if tok != tok.upper() and tok not in 'Zz':
                raise ValueError(f'relative path command not supported: {tok}')
            cmd = tok.upper()
            i += 1
            if cmd == 'Z':
                if not segs:
                    raise ValueError('empty subpath before Z')
                if pos != start:
                    segs.append(cubic_line(pos, start))
                rings.append((start, segs))
                segs = []
                cmd = None
            continue
        if cmd is None:
            raise ValueError('coordinates before a path command')
        values = []
        while i < len(tokens) and tokens[i] not in PATH_COMMANDS:
            values.append(float(tokens[i]))
            i += 1
        if cmd == 'M':
            if len(values) != 2:
                raise ValueError('M must be followed by exactly one pair')
            if segs:
                raise ValueError('subpath not closed before M')
            start = pos = (values[0], values[1])
        elif cmd == 'H':
            for v in values:
                end = (v, pos[1])
                segs.append(cubic_line(pos, end))
                pos = end
        elif cmd == 'V':
            for v in values:
                end = (pos[0], v)
                segs.append(cubic_line(pos, end))
                pos = end
        elif cmd == 'C':
            if len(values) % 6 != 0:
                raise ValueError('C coordinate count not a multiple of 6')
            for k in range(0, len(values), 6):
                c1 = (values[k], values[k + 1])
                c2 = (values[k + 2], values[k + 3])
                end = (values[k + 4], values[k + 5])
                segs.append((c1, c2, end))
                pos = end
        elif cmd == 'L':
            if len(values) % 2 != 0:
                raise ValueError('L coordinate count is odd')
            for k in range(0, len(values), 2):
                end = (values[k], values[k + 1])
                segs.append(cubic_line(pos, end))
                pos = end
        else:
            raise ValueError(f'unsupported path command: {cmd}')
    if segs:
        raise ValueError('path ends without Z')
    return rings


def flatten_cubic(p0, c1, c2, p1, steps=8):
    pts = []
    for k in range(1, steps + 1):
        t = k / steps
        mt = 1.0 - t
        pts.append((
            mt ** 3 * p0[0] + 3 * mt ** 2 * t * c1[0] + 3 * mt * t ** 2 * c2[0] + t ** 3 * p1[0],
            mt ** 3 * p0[1] + 3 * mt ** 2 * t * c1[1] + 3 * mt * t ** 2 * c2[1] + t ** 3 * p1[1],
        ))
    return pts


def ring_polygon(start, segs):
    poly = [start]
    pos = start
    for c1, c2, end in segs:
        poly.extend(flatten_cubic(pos, c1, c2, end))
        pos = end
    return poly


def signed_area(poly):
    n = len(poly)
    return 0.5 * sum(
        poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]
        for i in range(n)
    )


def point_in_ring(pt, poly):
    x, y = pt
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def reverse_ring(start, segs):
    pts = [start] + [s[2] for s in segs]  # pts[-1] == pts[0] (closed by parser)
    new_segs = [(c2, c1, pts[k]) for k, (c1, c2, _end) in reversed(list(enumerate(segs)))]
    return pts[0], new_segs


def build_openrouter_glyph():
    with open(OR_SVG, encoding='utf-8') as handle:
        match = re.search(r'\bd="([^"]+)"', handle.read())
    if not match:
        raise ValueError(f'no path data in {OR_SVG}')
    rings = parse_svg_path(match.group(1))
    if len(rings) != 2:
        raise ValueError(f'expected 2 subpaths (boundary + counter), got {len(rings)}')

    # Containment is affine-invariant: classify outer/counter before transforming.
    if point_in_ring(rings[0][0], ring_polygon(*rings[1])):
        rings.reverse()

    all_pts = [p for ring in rings for p in ring_polygon(*ring)]
    xs = [p[0] for p in all_pts]
    ys = [p[1] for p in all_pts]
    x_min, x_max, y_min, y_max = min(xs), max(xs), min(ys), max(ys)
    scale = 880.0 / max(x_max - x_min, y_max - y_min)
    left = (EM - (x_max - x_min) * scale) / 2.0
    bottom = (EM - (y_max - y_min) * scale) / 2.0

    def tf(pt):
        # y-down SVG -> y-up font, centered in the em like the vLLM glyph
        return (round(left + (pt[0] - x_min) * scale, 2),
                round(bottom + (y_max - pt[1]) * scale, 2))

    pen = TTGlyphPen(None)
    for index, (start, segs) in enumerate(rings):
        start = tf(start)
        segs = [(tf(c1), tf(c2), tf(end)) for c1, c2, end in segs]
        area = signed_area(ring_polygon(start, segs))
        outer = index == 0
        # TrueType (y-up): outer clockwise = negative area, counter positive.
        if (area > 0) == outer:
            start, segs = reverse_ring(start, segs)
            area = -area
        print(f"openrouter ring {index} ({'outer' if outer else 'counter'}): area={area:.0f}")
        if (area < 0) != outer:
            raise ValueError('winding fix failed')
        qpen = Cu2QuPen(pen, max_err=1.0, reverse_direction=False)
        qpen.moveTo(start)
        for c1, c2, end in segs:
            qpen.curveTo(c1, c2, end)
        qpen.closePath()
    return pen.glyph()


or_glyph = build_openrouter_glyph()

glyph_order = ['.notdef', 'vllm-v', 'openrouter-glyph']
cmap = {0xE001: 'vllm-v', 0xE002: 'openrouter-glyph'}

fb = FontBuilder(EM, isTTF=True)
fb.setupGlyphOrder(glyph_order)
fb.setupCharacterMap(cmap)
fb.setupGlyf({'.notdef': notdef_glyph, 'vllm-v': v_glyph, 'openrouter-glyph': or_glyph})
fb.setupHorizontalMetrics({
    '.notdef': (EM, 0),
    'vllm-v': (EM, 0),
    'openrouter-glyph': (EM, 0),
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

out = os.path.join(os.path.dirname(__file__), '..', 'resources', 'vllm-icon.woff2')
fb.font.flavor = 'woff2'
fb.font.save(os.path.normpath(out))
print(f"\nwrote {os.path.normpath(out)}")
