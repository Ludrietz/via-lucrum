/** Pure geometry helpers. No Phaser, no game concepts. */

export interface Vec2 {
  x: number;
  y: number;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Drop points that sit closer together than `minSpacing`, keeping the last. */
export function simplify(points: Vec2[], minSpacing: number): Vec2[] {
  if (points.length < 2) return points.slice();

  const out: Vec2[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (dist(points[i], out[out.length - 1]) >= minSpacing) out.push(points[i]);
  }

  const last = points[points.length - 1];
  if (dist(last, out[out.length - 1]) < minSpacing * 0.5 && out.length > 1) out.pop();
  out.push(last);
  return out;
}

/**
 * Ramer-Douglas-Peucker. Keeps only the points that actually change the shape,
 * which is what turns a grid path's stair-steps — or a wobbly drag — into a
 * handful of meaningful corners.
 */
export function simplifyRDP(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return points.slice();

  const first = points[0];
  const last = points[points.length - 1];

  let worst = 0;
  let worstIndex = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = closestPointOnPolyline([first, last], points[i]).distance;
    if (d > worst) {
      worst = d;
      worstIndex = i;
    }
  }

  if (worst <= tolerance) return [first, last];

  const left = simplifyRDP(points.slice(0, worstIndex + 1), tolerance);
  const right = simplifyRDP(points.slice(worstIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

/**
 * Catmull-Rom through every control point, which turns a coarse set of sampled
 * mouse positions into a smooth road without overshooting the drawn line.
 */
export function catmullRom(points: Vec2[], samplesPerSegment = 8): Vec2[] {
  if (points.length < 3) return points.slice();

  const out: Vec2[] = [];
  const n = points.length;

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];

    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;

      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }

  out.push(points[n - 1]);
  return out;
}

/** Walk a polyline and drop a point every `spacing` units. */
export function resamplePolyline(points: Vec2[], spacing: number): Vec2[] {
  if (points.length < 2) return points.slice();

  const cum = cumulativeLengths(points);
  const total = cum[cum.length - 1];
  const steps = Math.max(1, Math.round(total / spacing));

  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const sample = samplePolyline(points, cum, (i / steps) * total);
    out.push({ x: sample.x, y: sample.y });
  }
  return out;
}

export function polylineLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += dist(points[i], points[i + 1]);
  return total;
}

/** Cumulative arc length, one entry per point, starting at 0. */
export function cumulativeLengths(points: Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  }
  return cum;
}

export interface SampleResult extends Vec2 {
  angle: number;
}

/** Position and heading at arc-length `d` along a polyline. */
export function samplePolyline(points: Vec2[], cum: number[], d: number): SampleResult {
  const total = cum[cum.length - 1];
  const clamped = Math.max(0, Math.min(total, d));

  let i = 1;
  while (i < cum.length - 1 && cum[i] < clamped) i++;

  const segLength = cum[i] - cum[i - 1];
  const t = segLength > 0 ? (clamped - cum[i - 1]) / segLength : 0;
  const a = points[i - 1];
  const b = points[i];

  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

export interface Intersection {
  point: Vec2;
  /** Parameter along the first segment. */
  t: number;
  /** Parameter along the second segment. */
  u: number;
}

/** Proper segment/segment intersection; parallel and touching-at-a-tip return null. */
export function segmentIntersection(
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  p4: Vec2,
): Intersection | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return { point: { x: p1.x + d1x * t, y: p1.y + d1y * t }, t, u };
}

export interface ClosestPoint {
  point: Vec2;
  /** Index of the segment start. */
  index: number;
  /** Parameter within that segment. */
  t: number;
  distance: number;
}

export function closestPointOnPolyline(points: Vec2[], p: Vec2): ClosestPoint {
  let best: ClosestPoint = { point: points[0], index: 0, t: 0, distance: dist(points[0], p) };

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0;
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = dist(point, p);

    if (distance < best.distance) best = { point, index: i, t, distance };
  }

  return best;
}

/** Split a polyline at segment `index` / parameter `t` into two polylines. */
export function splitPolyline(points: Vec2[], index: number, t: number): [Vec2[], Vec2[], Vec2] {
  const cut = lerpVec(points[index], points[index + 1], t);
  const head = points.slice(0, index + 1);
  head.push(cut);
  const tail = [cut, ...points.slice(index + 1)];
  return [head, tail, cut];
}
