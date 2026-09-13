import type { Vec2 } from '../sim/geometry';

interface Segment {
  a: Vec2;
  b: Vec2;
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Trace the contour(s) of a scalar field at `threshold`, over a regular grid.
 * Used to turn a pile of overlapping influence circles into the outline of
 * one merged, organic-looking territory instead of a stack of circles.
 *
 * Standard marching squares: sample a grid, decide which of the 16 corner
 * patterns each cell matches, and stitch the resulting edge segments into
 * closed loops. The two saddle cases (a single ambiguous diagonal) are
 * resolved the same way every time, which is a small, harmless simplification
 * for ground meant to look hand-drawn rather than mathematically exact.
 */
export function traceContours(
  bounds: Bounds,
  cell: number,
  threshold: number,
  sample: (x: number, y: number) => number,
): Vec2[][] {
  const cols = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / cell));
  const rows = Math.max(1, Math.ceil((bounds.y1 - bounds.y0) / cell));
  const stride = cols + 1;
  const values = new Float32Array(stride * (rows + 1));

  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      values[j * stride + i] = sample(bounds.x0 + i * cell, bounds.y0 + j * cell);
    }
  }

  const segments: Segment[] = [];
  const lerp = (p0: number, p1: number, v0: number, v1: number): number => {
    const t = (threshold - v0) / (v1 - v0 || 1e-6);
    return p0 + (p1 - p0) * Math.max(0, Math.min(1, t));
  };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x0 = bounds.x0 + i * cell;
      const x1 = x0 + cell;
      const y0 = bounds.y0 + j * cell;
      const y1 = y0 + cell;

      const v00 = values[j * stride + i];
      const v10 = values[j * stride + i + 1];
      const v11 = values[(j + 1) * stride + i + 1];
      const v01 = values[(j + 1) * stride + i];

      let index = 0;
      if (v00 >= threshold) index |= 1;
      if (v10 >= threshold) index |= 2;
      if (v11 >= threshold) index |= 4;
      if (v01 >= threshold) index |= 8;
      if (index === 0 || index === 15) continue;

      const top: Vec2 = { x: lerp(x0, x1, v00, v10), y: y0 };
      const right: Vec2 = { x: x1, y: lerp(y0, y1, v10, v11) };
      const bottom: Vec2 = { x: lerp(x0, x1, v01, v11), y: y1 };
      const left: Vec2 = { x: x0, y: lerp(y0, y1, v00, v01) };

      switch (index) {
        case 1:
        case 14:
          segments.push({ a: left, b: top });
          break;
        case 2:
        case 13:
          segments.push({ a: top, b: right });
          break;
        case 3:
        case 12:
          segments.push({ a: left, b: right });
          break;
        case 4:
        case 11:
          segments.push({ a: right, b: bottom });
          break;
        case 6:
        case 9:
          segments.push({ a: top, b: bottom });
          break;
        case 7:
        case 8:
          segments.push({ a: bottom, b: left });
          break;
        case 5:
          segments.push({ a: left, b: top }, { a: right, b: bottom });
          break;
        case 10:
          segments.push({ a: top, b: right }, { a: bottom, b: left });
          break;
      }
    }
  }

  return stitch(segments);
}

/** Walk the (mostly degree-2) segment graph into closed loops. */
function stitch(segments: Segment[]): Vec2[][] {
  const key = (p: Vec2): string => `${Math.round(p.x * 4)}:${Math.round(p.y * 4)}`;
  const points = new Map<string, Vec2>();
  const neighbors = new Map<string, string[]>();

  for (const { a, b } of segments) {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) continue;
    if (!points.has(ka)) points.set(ka, a);
    if (!points.has(kb)) points.set(kb, b);
    (neighbors.get(ka) ?? neighbors.set(ka, []).get(ka)!).push(kb);
    (neighbors.get(kb) ?? neighbors.set(kb, []).get(kb)!).push(ka);
  }

  const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const usedEdges = new Set<string>();
  const loops: Vec2[][] = [];

  for (const [startKey, list] of neighbors) {
    for (const firstNeighbor of list) {
      const startEdge = edgeKey(startKey, firstNeighbor);
      if (usedEdges.has(startEdge)) continue;
      usedEdges.add(startEdge);

      const loop: Vec2[] = [points.get(startKey)!];
      let cur = firstNeighbor;
      let guard = 0;

      while (cur !== startKey && guard++ < 20000) {
        loop.push(points.get(cur)!);
        const options = neighbors.get(cur) ?? [];
        const next = options.find((n) => !usedEdges.has(edgeKey(cur, n)));
        if (next === undefined) break;
        usedEdges.add(edgeKey(cur, next));
        cur = next;
      }

      if (cur === startKey && loop.length >= 3) loops.push(loop);
    }
  }

  return loops;
}

/**
 * Corner-cutting subdivision: a cheap way to round off the grid's stairsteps.
 *
 * Lives beside the tracer rather than in whichever layer needed it first,
 * because everything that traces a contour out of a cell grid needs the same
 * two passes afterwards to stop looking like a cell grid — the realm's border
 * did, and every parcel of held ground does too (see `LandUseLayer`).
 */
export function chaikin(points: Vec2[], iterations: number): Vec2[] {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const next: Vec2[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % n];
      next.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
      next.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
    }
    pts = next;
  }
  return pts;
}

/** Deterministic, position-based wobble, so an outline reads as drawn rather than computed. */
export function jitterLoop(points: Vec2[], strength: number): Vec2[] {
  return points.map((p) => {
    const nx = Math.sin(p.x * 0.014 + p.y * 0.021) + Math.sin(p.x * 0.037 - p.y * 0.009) * 0.6;
    const ny = Math.sin(p.x * 0.019 - p.y * 0.027) + Math.sin(p.x * 0.008 + p.y * 0.033) * 0.6;
    return { x: p.x + nx * strength * 0.4, y: p.y + ny * strength * 0.4 };
  });
}
