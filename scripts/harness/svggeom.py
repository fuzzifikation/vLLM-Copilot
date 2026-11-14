"""SVG geometry core for the pill font: path parsing, flattening, rasterizing.

Pure stdlib, deterministic, no dependencies. The whole point of this module:
the owner's artwork arrives as layered flat-color SVG paths (body, belly,
spray, eye), a font glyph is a monochrome union, and vector boolean unions
are their own research field. So we rasterize each path on its own at native
viewBox resolution with the SVG default nonzero fill rule, OR the masks, and
trace the union's boundary with the machinery in build-pill-font.py. At the
viewBox's own 1024 units per pixel this loses nothing a pill can see.
"""

import math
import re
import xml.etree.ElementTree as ET

TOKEN_RE = re.compile(r'([A-Za-z])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)')
NUM_ARGS = {'L': 2, 'H': 1, 'V': 1, 'C': 6, 'S': 4, 'Q': 4, 'T': 2, 'A': 7}
FLATNESS = 0.05  # bezier subdivision tolerance in viewBox units (viewBox is 1024)


def parse_path(d):
    """SVG path data -> list of subpaths, each a list of (cmd, args) items.

    Commands: M/L/H/V/C/S/Q/T/A/Z, absolute and relative. Numbers may glue to
    command letters and to each other via sign or dot ('-5.5.5' = -5.5, 0.5).
    """
    items = []
    for m in TOKEN_RE.finditer(d):
        if m.group(1):
            items.append(m.group(1))
        else:
            items.append(float(m.group(2)))
    subpaths = []
    cur = None
    x = y = 0.0
    sx = sy = 0.0
    prev_c = None  # last cubic/quadratic control, for S/T smoothing
    prev_cmd = None
    i = 0
    cmd = None

    def new_sub():
        nonlocal cur
        if cur:
            subpaths.append(cur)
        cur = []

    while i < len(items):
        tok = items[i]
        if isinstance(tok, str):
            cmd = tok
            i += 1
            if cmd in 'Zz':
                if cur:
                    cur.append(('Z', [(x, y)]))
                new_sub()
                x, y = sx, sy
                prev_c = None
                prev_cmd = cmd
                continue
        if cmd is None:
            raise ValueError(f'path data starts with a number: {d[:40]}')
        rel = cmd.islower()
        C = cmd.upper()
        if C == 'M':
            new_sub()
            px, py = items[i], items[i + 1]
            i += 2
            x += px if rel else 0
            y += py if rel else 0
            if not rel:
                x, y = px, py
            sx, sy = x, y
            cur.append(('M', [(x, y)]))
            prev_c = None
            prev_cmd = cmd
            # implicit coordinates after M are lineto, handled by looping with C=L
            cmd = 'l' if rel else 'L'
            continue
        n = NUM_ARGS[C]
        while i < len(items) and not isinstance(items[i], str):
            a = items[i:i + n]
            if len(a) != n:
                raise ValueError(f'truncated {cmd} in path data')
            i += n
            if C == 'L':
                px, py = a
                x, y = (x + px, y + py) if rel else (px, py)
                cur.append(('L', [(x, y)]))
            elif C == 'H':
                px = a[0]
                x = x + px if rel else px
                cur.append(('L', [(x, y)]))
            elif C == 'V':
                py = a[0]
                y = y + py if rel else py
                cur.append(('L', [(x, y)]))
            elif C == 'C':
                x1, y1, x2, y2, px, py = a
                if rel:
                    x1 += x; y1 += y; x2 += x; y2 += y; px += x; py += y
                cur.append(('C', [(x, y), (x1, y1), (x2, y2), (px, py)]))
                prev_c = (x2, y2)
                x, y = px, py
            elif C == 'S':
                x2, y2, px, py = a
                if rel:
                    x2 += x; y2 += y; px += x; py += y
                if prev_cmd.upper() in ('C', 'S') and prev_c:
                    x1, y1 = 2 * x - prev_c[0], 2 * y - prev_c[1]
                else:
                    x1, y1 = x, y
                cur.append(('C', [(x, y), (x1, y1), (x2, y2), (px, py)]))
                prev_c = (x2, y2)
                x, y = px, py
            elif C == 'Q':
                x1, y1, px, py = a
                if rel:
                    x1 += x; y1 += y; px += x; py += y
                cur.append(('Q', [(x, y), (x1, y1), (px, py)]))
                prev_c = (x1, y1)
                x, y = px, py
            elif C == 'T':
                px, py = a
                if rel:
                    px += x; py += y
                if prev_cmd.upper() in ('Q', 'T') and prev_c:
                    x1, y1 = 2 * x - prev_c[0], 2 * y - prev_c[1]
                else:
                    x1, y1 = x, y
                cur.append(('Q', [(x, y), (x1, y1), (px, py)]))
                prev_c = (x1, y1)
                x, y = px, py
            elif C == 'A':
                rx, ry, rot, large, sweep, px, py = a
                if rel:
                    px += x; py += y
                cur.append(('A', [(x, y), (rx, ry, math.radians(rot), bool(large), bool(sweep), (px, py))]))
                x, y = px, py
            prev_cmd = cmd
            cmd = cmd  # repeat same command for further arg groups
        if C == 'M':
            pass
    if cur:
        subpaths.append(cur)
    return subpaths


def _cubic_flat(p0, p1, p2, p3, out, depth):
    """Recursive subdivision by control-point deviation (flatness test)."""
    # distance of p1,p2 from the p0-p3 chord, classic bezier flatness proxy
    ux = 3 * p0[0] - 4 * p1[0] + p2[0]
    uy = 3 * p0[1] - 4 * p1[1] + p2[1]
    vx = 3 * p3[0] - 4 * p2[0] + p1[0]
    vy = 3 * p3[1] - 4 * p2[1] + p1[1]
    if depth >= 12 or max(abs(ux), abs(vx), abs(uy), abs(vy)) <= 8 * FLATNESS:
        out.append(p3)
        return
    p01 = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    p12 = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    p23 = ((p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2)
    p012 = ((p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2)
    p123 = ((p12[0] + p23[0]) / 2, (p12[1] + p23[1]) / 2)
    pm = ((p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2)
    _cubic_flat(p0, p01, p012, pm, out, depth + 1)
    _cubic_flat(pm, p123, p23, p3, out, depth + 1)


def _arc_points(p0, rx, ry, rot, large, sweep, p1):
    """Sample an elliptical arc to a point list (endpoint to center, then angle steps)."""
    if rx == 0 or ry == 0:
        return [p1]
    rx, ry = abs(rx), abs(ry)
    c, s = math.cos(rot), math.sin(rot)
    x0p = c * (p0[0] - p1[0]) / 2 + s * (p0[1] - p1[1]) / 2
    y0p = -s * (p0[0] - p1[0]) / 2 + c * (p0[1] - p1[1]) / 2
    lam = (x0p / rx) ** 2 + (y0p / ry) ** 2
    if lam > 1:  # radii too small: scale up, per the SVG spec
        f = math.sqrt(lam)
        rx *= f
        ry *= f
    sign = -1 if large == sweep else 1
    num = max(0, rx * rx * ry * ry - rx * rx * y0p * y0p - ry * ry * x0p * x0p)
    den = rx * rx * y0p * y0p + ry * ry * x0p * x0p
    co = sign * math.sqrt(num / den) if den else 0.0
    cxp = co * rx * y0p / ry
    cyp = -co * ry * x0p / rx
    cx = c * cxp - s * cyp + (p0[0] + p1[0]) / 2
    cy = s * cxp + c * cyp + (p0[1] + p1[1]) / 2
    def angle(ux, uy, vx, vy):
        dot = ux * vx + uy * vy
        ln = math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
        a = math.acos(max(-1.0, min(1.0, dot / ln))) if ln else 0.0
        return a if ux * vy - uy * vx >= 0 else -a
    th1 = angle(1, 0, (x0p - cxp) / rx, (y0p - cyp) / ry)
    dth = angle((x0p - cxp) / rx, (y0p - cyp) / ry, (-x0p - cxp) / rx, (-y0p - cyp) / ry)
    if not sweep and dth > 0:
        dth -= 2 * math.pi
    elif sweep and dth < 0:
        dth += 2 * math.pi
    steps = max(2, int(abs(dth) / 0.02))  # ~1 degree: sub-pixel on r<=1024
    pts = []
    for k in range(1, steps + 1):
        th = th1 + dth * k / steps
        ex = rx * math.cos(th)
        ey = ry * math.sin(th)
        pts.append((c * ex - s * ey + cx, s * ex + c * ey + cy))
    pts[-1] = p1
    return pts


def flatten_subpath(sub):
    """(cmd, args) items -> one flat point list (line segments + sampled curves)."""
    pts = []
    for cmd, args in sub:
        if cmd == 'M':
            pts.append(args[0])
        elif cmd == 'L':
            pts.append(args[0])
        elif cmd == 'C':
            p0, p1, p2, p3 = args
            _cubic_flat(p0, p1, p2, p3, pts, 0)
        elif cmd == 'Q':
            p0, p1, p2 = args
            # exact quadratic -> cubic
            c1 = (p0[0] + 2 / 3 * (p1[0] - p0[0]), p0[1] + 2 / 3 * (p1[1] - p0[1]))
            c2 = (p2[0] + 2 / 3 * (p1[0] - p2[0]), p2[1] + 2 / 3 * (p1[1] - p2[1]))
            _cubic_flat(p0, c1, c2, p2, pts, 0)
        elif cmd == 'A':
            p0, params = args
            pts.extend(_arc_points(p0, *params))
        elif cmd == 'Z':
            pass
    return pts


def _style_map(el):
    props = {}
    for decl in (el.get('style') or '').split(';'):
        if ':' in decl:
            k, v = decl.split(':', 1)
            props[k.strip().lower()] = v.strip().lower()
    return props


def _prop(el, style, name):
    """Effective property: style beats the presentation attribute (SVG spec)."""
    v = style.get(name) or el.get(name)
    return v.strip().lower() if v else ''


def load_ink_paths(svg_path):
    """SVG file -> [(fill, [flat subpaths], stroke)]; stroke is (color, width) or None.

    Fills and strokes both count as geometry; a shape with neither is skipped.
    The effective fill is the SVG initial value, black, when absent - Inkscape
    omits the attribute and puts the real values in style="".
    """
    root = ET.parse(svg_path).getroot()
    out = []
    for el in root.iter():
        if not el.tag.endswith('}path') and el.tag != 'path':
            continue
        st = _style_map(el)
        fill = _prop(el, st, 'fill') or 'black'
        stroke_color = _prop(el, st, 'stroke') or 'none'
        stroke = None
        if stroke_color != 'none':
            try:
                width = float(_prop(el, st, 'stroke-width') or '1')
            except ValueError:
                width = 1.0
            if width > 0:
                stroke = (stroke_color, width)
        if fill == 'none' and stroke is None:
            continue
        subs = parse_path(el.get('d'))
        out.append((fill, [flatten_subpath(s) for s in subs if len(s) > 1], stroke))
    return out


def _chamfer(d, width, height):
    """Two-pass chamfer distance transform, in place (straight 2, diagonal 3)."""
    for y in range(height):
        row, prev = d[y], d[y - 1] if y else None
        for x in range(width):
            v = row[x]
            if x and row[x - 1] + 2 < v:
                v = row[x - 1] + 2
            if prev is not None:
                if prev[x] + 2 < v:
                    v = prev[x] + 2
                if x and prev[x - 1] + 3 < v:
                    v = prev[x - 1] + 3
                if x + 1 < width and prev[x + 1] + 3 < v:
                    v = prev[x + 1] + 3
            row[x] = v
    for y in range(height - 1, -1, -1):
        row, nxt = d[y], d[y + 1] if y + 1 < height else None
        for x in range(width - 1, -1, -1):
            v = row[x]
            if x + 1 < width and row[x + 1] + 2 < v:
                v = row[x + 1] + 2
            if nxt is not None:
                if nxt[x] + 2 < v:
                    v = nxt[x] + 2
                if x and nxt[x - 1] + 3 < v:
                    v = nxt[x - 1] + 3
                if x + 1 < width and nxt[x + 1] + 3 < v:
                    v = nxt[x + 1] + 3
            row[x] = v


def stroke_band_mask(subs, width, height, stroke_width):
    """Stroke of the path outlines as a byte row mask, centered on the stroke line.

    The stroked line is the boundary of the region the subpaths would fill
    (nonzero rule), widened by half the stroke width on each side - raster
    distance transform, no vector offsets.
    """
    fill = path_mask(subs, width, height)
    r = max(2, int(round(stroke_width)))  # half-pixel chamfer units -> total band = width
    big = 3 * (width + height) + 4
    d_in = [[0 if fill[y][x] else big for x in range(width)] for y in range(height)]
    d_out = [[big if fill[y][x] else 0 for x in range(width)] for y in range(height)]
    _chamfer(d_in, width, height)
    _chamfer(d_out, width, height)
    band = [bytearray(width) for _ in range(height)]
    for y in range(height):
        b, di, do_ = band[y], d_in[y], d_out[y]
        for x in range(width):
            # dilated XOR eroded: within r of the region but not deep inside it
            if (di[x] <= r) != (do_[x] > r):
                b[x] = 1
    return band


def subpath_mask(points, width, height):
    """Scanline fill of one closed flat subpath, NONZERO winding (SVG default).

    Returns a list of per-row sorted span lists [(x0, x1)] with x0 inclusive,
    x1 exclusive, evaluated at pixel centers (y + 0.5).
    """
    return subpaths_mask([points], width, height)


def subpaths_mask(subs, width, height):
    """Scanline fill of a GROUP of subpaths with one shared winding counter.

    The group matters: SVG composes the subpaths of a single <path> under one
    nonzero rule, so a reversed inner subpath is a HOLE (the whale's eye, the
    spray's negative space). Filling subpaths separately and OR-ing them,
    the obvious wrong approach, silently fills those holes.
    Returns [(row, [(x0, x1)])], x0 inclusive, x1 exclusive, pixel centers.
    """
    spans = []
    edges = []
    for points in subs:
        n = len(points)
        for i in range(n):
            x0, y0 = points[i]
            x1, y1 = points[(i + 1) % n]
            if y0 == y1:
                continue
            if y0 > y1:
                x0, y0, x1, y1 = x1, y1, x0, y0
                dirn = -1
            else:
                dirn = 1
            edges.append((y0, y1, x0, x1, dirn))
    for row in range(height):
        cy = row + 0.5
        xs = []
        for y0, y1, x0, x1, dirn in edges:
            if y0 <= cy < y1:
                t = (cy - y0) / (y1 - y0)
                xs.append((x0 + (x1 - x0) * t, dirn))
        if not xs:
            continue
        xs.sort()
        winding = 0
        row_spans = []
        span_x0 = None
        for xv, dirn in xs:
            winding += dirn
            if winding != 0 and span_x0 is None:
                span_x0 = xv
            elif winding == 0 and span_x0 is not None:
                a = int(math.ceil(span_x0 - 0.5))
                b = int(math.ceil(xv - 0.5))
                if b > a:
                    row_spans.append((max(0, a), min(width, b)))
                span_x0 = None
        if row_spans:
            spans.append((row, row_spans))
    return spans


def path_mask(subs, width, height):
    """One <path>'s fill as a byte row mask (list of bytearrays), nonzero rule."""
    mask = [bytearray(width) for _ in range(height)]
    for row, row_spans in subpaths_mask(subs, width, height):
        line = mask[row]
        for a, b in row_spans:
            for x in range(a, b):
                line[x] = 1
    return mask


def hex_rgb(color):
    c = color.strip().lstrip('#')
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
