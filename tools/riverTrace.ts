/**
 * Pulling watercourses out of a picture, as lines.
 *
 * A drawn map records a river the way a pen does: a stroke one to three
 * pixels wide, wandering for thousands. Every importer before this one turned
 * that into "which cells are wet", which at sixty-four metres to the cell
 * meant a five-metre brook became a hundred-and-twenty-eight-metre channel —
 * and had to, because a one-cell watercourse running diagonally is a chain of
 * cells touching only at their corners, which nothing in the game can walk
 * along or be stopped by.
 *
 * This keeps the stroke as a stroke. The mask is thinned to a one-pixel
 * centreline, the centreline is traced into paths, and each point carries how
 * wide the water was there — which is measured, not assumed, because the
 * distance transform already knows. Out comes a river at its real width, at
 * the resolution the drawing was made at rather than the resolution the
 * simulation happens to store ground in.
 *
 * Nothing here knows about world units, cells or packs. It takes a bitmap and
 * returns polylines in pixels.
 */

export interface TracedRiver {
  /** Centreline, in pixels. */
  points: Array<{ x: number; y: number }>;
  /** Water width at each point, in pixels, one per point. */
  widths: number[];
}

export interface TraceResult {
  rivers: TracedRiver[];
  /**
   * One byte per pixel: 1 where the water belongs to a traced river.
   *
   * Handed back so the caller can stop treating those pixels as water in
   * whatever raster it is also building. They are not dry — a river bottom is
   * the wettest ground there is — but they are no longer *water*, because the
   * water is now the line instead.
   */
  riverPixels: Uint8Array;
}

export interface TraceOptions {
  /**
   * Widest water, in pixels, that leaves as geometry instead of staying in
   * the raster.
   *
   * The criterion is deliberately not "is this a river". That question sounds
   * like the right one and is unanswerable at the edges — a millpond on a
   * stream is both — and it produced exactly the seam it was meant to avoid:
   * watercourses left as crisp geometry while the ponds they ran through
   * stayed in the raster as blurred blobs, so water changed substance
   * wherever the two met.
   *
   * The question that actually matters is whether the raster can hold the
   * thing. Below a couple of cells it cannot: the shape is smeared across too
   * few texels to read, and the ground bake's shore rim swells over the whole
   * of it. Above that the raster is fine and geometry would be the worse
   * choice, since a genuine lake is an area and a ribbon is a poor way to
   * describe one. So the split is by what each representation can represent,
   * and water of every shape below the line is drawn by one renderer with one
   * palette.
   */
  maxRasterWidth: number;
  /**
   * How far a traced line may stray from the pixels it came from, in pixels,
   * when it is simplified. Keeps a river's meanders while dropping the
   * staircase the thinning leaves behind.
   */
  tolerance: number;
  /**
   * Smallest traced feature kept, as square pixels of water surface.
   *
   * Area rather than length, because length alone cannot tell the two things
   * that need telling apart. Thinning leaves short stubs, and a pond's
   * centreline is also short — so a length cut-off that removed the stubs
   * removed every pond on the map with them, and the water simply disappeared
   * where it was widest. A stub is short *and* a couple of pixels wide; a
   * pond is short and thirty. Multiplying the two separates them cleanly and
   * needs no second threshold.
   */
  minArea: number;
  /**
   * How many times to close the mask before thinning, in pixels.
   *
   * Needed because a classifier does not return the stroke the artist drew —
   * it returns the pixels that passed a colour test, and on a textured,
   * hand-drawn map that is a *dotted* subset of the line. Traced raw, the
   * Kuttenberg map's watercourses came out as six thousand fragments
   * averaging under two pixels each: not a drainage network, a spray of
   * confetti, because thinning cannot connect what was never connected and a
   * clump of speckle is all junction and no path.
   *
   * Closing — dilate, then erode — joins dots that are within a pixel or two
   * of each other and leaves the stroke's width very nearly as it was. It is
   * recovering the line the drawing actually has, not inventing one.
   */
  close: number;
  /** Discard blobs smaller than this before tracing — flecks that passed the colour test. */
  minComponentPixels: number;
  /** How far a drawn width may depart from the traced one before a point is kept, in pixels. See `keepWidthChanges`. */
  widthTolerance: number;
  /**
   * Furthest two separate bodies of water will be joined across, in pixels.
   *
   * The drawing this is read from is a picture, not a survey, and things in
   * front of a river hide it: a stand of trees drawn over a brook leaves a
   * stretch of it simply missing. The colour test cannot recover what the
   * artist painted over, so the mask arrives with holes in watercourses that
   * plainly have none — and every hole becomes two separate rivers with a gap
   * between them, which is wrong on the map and wrong in the simulation,
   * where a road can walk through the gap without crossing anything.
   *
   * Closing the mask (`close`) only reaches a pixel or two, which is right for
   * a dotted line and useless against a tree. Raising it far enough to bridge
   * a tree would weld every parallel feature on the map together and inflate
   * every width. So gaps are bridged *selectively* instead: only between
   * pieces that are genuinely separate, only across the shortest path between
   * them, only once per pair, and only at the width of the water either side.
   * What is put back is a channel the size of the one that went missing.
   */
  maxGap: number;
  /**
   * Longest dead-end branch pruned off the skeleton before tracing, in pixels.
   *
   * Thinning a stroke that is even slightly ragged grows whiskers: a one-pixel
   * bump on the bank becomes a two-pixel branch off the centreline. They are
   * invisible in the result and ruinous to it, because every whisker roots at
   * a *junction*, and tracing cuts paths at junctions. On the Kuttenberg map
   * that capped the longest watercourse at five hundred metres no matter how
   * aggressively the mask was closed first — the gaps were never the problem,
   * the whiskers were. Pruning them first is what lets a river come out as one
   * river, and leaves the junctions that remain meaning what they should: a
   * confluence.
   */
  spur: number;
}

/** Grow the mask by one pixel in all eight directions, `times` over. */
function dilate(mask: Uint8Array, w: number, h: number, times: number): Uint8Array {
  let out = mask;
  for (let pass = 0; pass < times; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!out[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) next[ny * w + nx] = 1;
          }
        }
      }
    }
    out = next;
  }
  return out;
}

/** The inverse: shrink by one pixel, `times` over. */
function erode(mask: Uint8Array, w: number, h: number, times: number): Uint8Array {
  let out = mask;
  for (let pass = 0; pass < times; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let solid = 1;
        for (let dy = -1; dy <= 1 && solid; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !out[ny * w + nx]) {
              solid = 0;
              break;
            }
          }
        }
        next[y * w + x] = solid;
      }
    }
    out = next;
  }
  return out;
}

/** Chamfer 3-4 distance to the nearest dry pixel, in pixel units. */
function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const FAR = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? FAR : 0;

  const relax = (i: number, j: number, cost: number): void => {
    const v = d[j] + cost;
    if (v < d[i]) d[i] = v;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      if (x > 0) relax(i, i - 1, 3);
      if (y > 0) relax(i, i - w, 3);
      if (x > 0 && y > 0) relax(i, i - w - 1, 4);
      if (x + 1 < w && y > 0) relax(i, i - w + 1, 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      if (x + 1 < w) relax(i, i + 1, 3);
      if (y + 1 < h) relax(i, i + w, 3);
      if (x + 1 < w && y + 1 < h) relax(i, i + w + 1, 4);
      if (x > 0 && y + 1 < h) relax(i, i + w - 1, 4);
    }
  }

  // The chamfer works in thirds of a pixel so its diagonal step can be an
  // integer; divide back out so callers get pixels.
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/** Zhang-Suen thinning: erode to a one-pixel skeleton without breaking it apart. */
function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const img = mask.slice();
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);

  let changed = true;
  const doomed: number[] = [];

  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      doomed.length = 0;

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!img[y * w + x]) continue;

          const p = [
            at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1),
            at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1),
          ];
          const filled = p.reduce((s, v) => s + v, 0);
          if (filled < 2 || filled > 6) continue;

          let transitions = 0;
          for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) transitions++;
          if (transitions !== 1) continue;

          // The two passes differ only in which pair of corners they protect,
          // which is what keeps the skeleton from being eaten from one side.
          if (pass === 0) {
            if (p[0] * p[2] * p[4] !== 0) continue;
            if (p[2] * p[4] * p[6] !== 0) continue;
          } else {
            if (p[0] * p[2] * p[6] !== 0) continue;
            if (p[0] * p[4] * p[6] !== 0) continue;
          }

          doomed.push(y * w + x);
        }
      }

      for (const i of doomed) img[i] = 0;
      if (doomed.length > 0) changed = true;
    }
  }

  return img;
}

/**
 * Strip dead-end branches shorter than `maxSpur` from a skeleton, repeatedly,
 * since removing one whisker can expose another behind it.
 */
function prune(skeleton: Uint8Array, w: number, h: number, maxSpur: number): Uint8Array {
  if (maxSpur <= 0) return skeleton;
  const img = skeleton.slice();

  const neighbours = (i: number): number[] => {
    const x = i % w;
    const y = (i - x) / w;
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (img[j]) out.push(j);
      }
    }
    return out;
  };

  for (let pass = 0; pass < 8; pass++) {
    const doomed: number[] = [];

    for (let i = 0; i < w * h; i++) {
      if (!img[i] || neighbours(i).length !== 1) continue;

      // Walk inward from the tip until the line forks or ends.
      const branch = [i];
      let current = neighbours(i)[0];
      let previous = i;
      while (branch.length <= maxSpur) {
        const onward = neighbours(current).filter((n) => n !== previous);
        if (onward.length !== 1) break;
        branch.push(current);
        previous = current;
        current = onward[0];
      }

      // Only a branch that actually met a fork is a spur. One that ran out of
      // line is a short river, and deleting it would delete the map's brooks.
      if (branch.length <= maxSpur && neighbours(current).length > 2) doomed.push(...branch);
    }

    if (doomed.length === 0) break;
    for (const i of doomed) img[i] = 0;
  }

  return img;
}

/** Flood fill labels, 8-connected — a river that steps diagonally is still one river. */
function label(mask: Uint8Array, w: number, h: number): { ids: Int32Array; count: number } {
  const ids = new Int32Array(w * h).fill(-1);
  let count = 0;
  const stack: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || ids[start] >= 0) continue;
    const id = count++;
    ids[start] = id;
    stack.push(start);

    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!mask[j] || ids[j] >= 0) continue;
          ids[j] = id;
          stack.push(j);
        }
      }
    }
  }

  return { ids, count };
}

/** Douglas-Peucker, keeping the meanders and dropping the pixel staircase. */
function simplify(points: Array<{ x: number; y: number }>, tolerance: number): number[] {
  if (points.length <= 2) return points.map((_, i) => i);

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;

    const ax = points[a].x;
    const ay = points[a].y;
    const dx = points[b].x - ax;
    const dy = points[b].y - ay;
    const span = Math.hypot(dx, dy) || 1e-9;

    let worst = -1;
    let worstAt = -1;
    for (let i = a + 1; i < b; i++) {
      const away = Math.abs((points[i].x - ax) * dy - (points[i].y - ay) * dx) / span;
      if (away > worst) {
        worst = away;
        worstAt = i;
      }
    }

    if (worst > tolerance) {
      keep[worstAt] = 1;
      stack.push([a, worstAt], [worstAt, b]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Walk a skeleton into paths, following the straightest way on at every step.
 *
 * The obvious rule — run along pixels that have exactly two neighbours, stop
 * where they do not — is wrong here, and wrong in a way that is invisible
 * until you measure it. Thinning leaves staircases: where a line steps
 * sideways, the corner pixel has three eight-connected neighbours and reads as
 * a junction even though the line plainly carries straight on. On the
 * Kuttenberg map that put a false junction every few pixels, so no traced
 * watercourse ever exceeded five hundred metres however the mask was cleaned
 * up first. The tell was that the figure did not move at all across six very
 * different settings: an invariant like that is a cap in the code, not a fact
 * about the ground.
 *
 * So the walk carries a heading and always takes the unused neighbour that
 * turns least. A staircase corner continues, because straight on is straight
 * on. A real confluence continues along the straighter of the two branches
 * and leaves the other to be walked as its own river, which is the same
 * answer a cartographer gives and a great deal better than cutting all three
 * into stubs. Only a turn sharper than a right angle ends a path, because
 * that is no longer a continuation of anything.
 */
function walk(
  skeleton: Uint8Array,
  ids: Int32Array,
  componentId: number,
  w: number,
  h: number,
): Array<Array<{ x: number; y: number }>> {
  const neighbours = (i: number): number[] => {
    const x = i % w;
    const y = (i - x) / w;
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (skeleton[j] && ids[j] === componentId) out.push(j);
      }
    }
    return out;
  };

  const pixels: number[] = [];
  for (let i = 0; i < w * h; i++) if (skeleton[i] && ids[i] === componentId) pixels.push(i);

  const used = new Set<string>();
  const edge = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const paths: Array<Array<{ x: number; y: number }>> = [];

  const at = (i: number): { x: number; y: number } => ({ x: (i % w) + 0.5, y: ((i - (i % w)) / w) + 0.5 });

  const from = (origin: number): void => {
    for (const first of neighbours(origin)) {
      if (used.has(edge(origin, first))) continue;
      used.add(edge(origin, first));

      const path = [origin, first];
      let previous = origin;
      let current = first;

      for (;;) {
        const a = at(previous);
        const b = at(current);
        const heading = Math.atan2(b.y - a.y, b.x - a.x);

        let best = -1;
        let bestTurn = Infinity;
        for (const next of neighbours(current)) {
          if (used.has(edge(current, next))) continue;
          const c = at(next);
          const course = Math.atan2(c.y - b.y, c.x - b.x);
          let turn = Math.abs(course - heading);
          if (turn > Math.PI) turn = 2 * Math.PI - turn;
          if (turn < bestTurn) {
            bestTurn = turn;
            best = next;
          }
        }

        if (best < 0 || bestTurn > Math.PI / 2) break;
        used.add(edge(current, best));
        path.push(best);
        previous = current;
        current = best;
      }

      paths.push(path.map(at));
    }
  };

  // Tips first, so a watercourse is walked from one of its ends and comes out
  // whole; whatever is left over is interior or loop and gets walked after.
  for (const i of pixels) if (neighbours(i).length === 1) from(i);
  for (const i of pixels) if (neighbours(i).some((n) => !used.has(edge(i, n)))) from(i);

  return paths;
}

/**
 * Reconnect bodies of water that the picture only appears to separate.
 *
 * A multi-source flood from every water pixel at once, each carrying the
 * component it came from. Where two floods meet, the water either side is as
 * close as it ever gets, and the distance they have travelled is the width of
 * the gap — so one pass over the image finds the shortest crossing between
 * every pair of components, rather than the pairwise search that question
 * usually invites.
 *
 * The crossings are then taken shortest-first, and each is filled in only if
 * it joins two pieces not already joined by a shorter one. That keeps a chain
 * of fragments along one stream being stitched end to end, instead of every
 * fragment being wired to every other.
 */
function bridgeGaps(mask: Uint8Array, w: number, h: number, maxGap: number, width: Float32Array): Uint8Array {
  if (maxGap <= 0) return mask;

  const { ids } = label(mask, w, h);
  const owner = new Int32Array(w * h).fill(-1);
  const source = new Int32Array(w * h).fill(-1);
  const reach = new Float32Array(w * h).fill(Infinity);

  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    owner[i] = ids[i];
    source[i] = i;
    reach[i] = 0;
    frontier.push(i);
  }

  interface Span { gap: number; from: number; to: number; a: number; b: number }
  const best = new Map<string, Span>();

  while (frontier.length > 0) {
    const next: number[] = [];

    for (const i of frontier) {
      const x = i % w;
      const y = (i - x) / w;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;

          if (owner[j] === -1) {
            const step = reach[i] + (dx === 0 || dy === 0 ? 1 : Math.SQRT2);
            if (step > maxGap) continue;
            owner[j] = owner[i];
            source[j] = source[i];
            reach[j] = step;
            next.push(j);
            continue;
          }

          if (owner[j] === owner[i]) continue;

          // Two floods have met: the water behind each is as close as it gets.
          const gap = reach[i] + reach[j];
          if (gap > maxGap) continue;
          const key = owner[i] < owner[j] ? `${owner[i]}:${owner[j]}` : `${owner[j]}:${owner[i]}`;
          const held = best.get(key);
          if (!held || gap < held.gap) {
            best.set(key, { gap, from: source[i], to: source[j], a: owner[i], b: owner[j] });
          }
        }
      }
    }

    frontier = next;
  }

  // Union-find, so a stream broken into five pieces is stitched into one line
  // rather than into a mesh of every piece against every other.
  const parent = new Int32Array(w * h).fill(-1);
  const find = (v: number): number => {
    let root = v;
    while (parent[root] >= 0) root = parent[root];
    while (parent[v] >= 0) {
      const up = parent[v];
      parent[v] = root;
      v = up;
    }
    return root;
  };

  const bridged = mask.slice();
  for (const span of [...best.values()].sort((x, y) => x.gap - y.gap)) {
    const ra = find(span.a);
    const rb = find(span.b);
    if (ra === rb) continue;
    parent[ra] = rb;

    // At the width of the water it is joining, never wider: a bridge that
    // widens the stream would be visible as a bulge exactly where the artist
    // drew nothing at all.
    const across = Math.max(1, Math.min(width[span.from], width[span.to]) / 2);
    stroke(bridged, w, h, span.from, span.to, across);
  }

  return bridged;
}

/** Lay a band of mask down between two pixels. */
function stroke(mask: Uint8Array, w: number, h: number, from: number, to: number, radius: number): void {
  const ax = from % w;
  const ay = (from - ax) / w;
  const bx = to % w;
  const by = (to - bx) / w;
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
  const span = Math.ceil(radius);

  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const cx = Math.round(ax + (bx - ax) * t);
    const cy = Math.round(ay + (by - ay) * t);
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        if (Math.hypot(dx, dy) > radius) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        mask[ny * w + nx] = 1;
      }
    }
  }
}

/**
 * Add back the points a geometric simplification threw away but the *width*
 * needed.
 *
 * Douglas-Peucker measures how far a point strays from the line between its
 * neighbours, and a watercourse running dead straight through a pond strays
 * not at all — so the whole pond collapsed to its two endpoints and the river
 * came out the same width all the way through, with the pond simply gone. The
 * shape was right and the thing the shape was carrying was lost.
 *
 * So the same test is run again over the width profile: wherever the recorded
 * width departs from what interpolating between two kept points would predict,
 * the offending point is kept as well. A pond on a stream survives as a bulge,
 * which is what melds the two into one piece of water instead of a line
 * arriving at a blob.
 */
function keepWidthChanges(widths: number[], kept: number[], tolerance: number): number[] {
  const keep = new Set(kept);
  const stack: Array<[number, number]> = [];
  for (let i = 0; i + 1 < kept.length; i++) stack.push([kept[i], kept[i + 1]]);

  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;

    let worst = -1;
    let worstAt = -1;
    for (let i = a + 1; i < b; i++) {
      const predicted = widths[a] + ((widths[b] - widths[a]) * (i - a)) / (b - a);
      const away = Math.abs(widths[i] - predicted);
      if (away > worst) {
        worst = away;
        worstAt = i;
      }
    }

    if (worst > tolerance) {
      keep.add(worstAt);
      stack.push([a, worstAt], [worstAt, b]);
    }
  }

  return [...keep].sort((x, y) => x - y);
}

export function traceRivers(
  raw: Uint8Array,
  w: number,
  h: number,
  options: TraceOptions,
): TraceResult {
  // Close first, then drop what is still too small to be anything. Both
  // happen before the distance transform, so a river's measured width is the
  // width of the recovered stroke rather than of the dots it arrived as.
  const closed = options.close > 0
    ? erode(dilate(raw, w, h, options.close), w, h, options.close)
    : raw;

  const speckle = label(closed, w, h);
  const size = new Int32Array(speckle.count);
  for (let i = 0; i < w * h; i++) if (closed[i]) size[speckle.ids[i]]++;

  const kept = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (closed[i] && size[speckle.ids[i]] >= options.minComponentPixels) kept[i] = 1;
  }

  // Bridging needs to know how wide the water is either side of a gap, so the
  // distance transform is taken before and then retaken after — the bridged
  // mask is a different shape and the widths the rivers are measured at have
  // to come from it, not from the holed version.
  const water = bridgeGaps(kept, w, h, options.maxGap, distanceTransform(kept, w, h));
  const distance = distanceTransform(water, w, h);
  const skeleton = prune(thin(water, w, h), w, h, options.spur);
  const { ids, count } = label(water, w, h);

  const widest = new Float64Array(count);
  for (let i = 0; i < w * h; i++) {
    if (!water[i]) continue;
    const across = distance[i] * 2;
    if (across > widest[ids[i]]) widest[ids[i]] = across;
  }

  const rivers: TracedRiver[] = [];
  const riverPixels = new Uint8Array(w * h);

  for (let id = 0; id < count; id++) {
    // Too wide to describe as a line: it keeps its cells and is drawn from
    // them. See the note on `maxRasterWidth`.
    if (widest[id] > options.maxRasterWidth) continue;

    const emitted: TracedRiver[] = [];

    for (const path of walk(skeleton, ids, id, w, h)) {
      if (path.length < 2) continue;

      let surface = 0;
      for (const q of path) {
        const px = Math.min(w - 1, Math.max(0, Math.floor(q.x)));
        const py = Math.min(h - 1, Math.max(0, Math.floor(q.y)));
        surface += distance[py * w + px] * 2;
      }
      if (surface < options.minArea) continue;

      // Twice the distance to dry ground is the width of the water, which is
      // the measurement the drawing actually contains — far better than
      // assuming a width, and the reason a river here widens towards its
      // mouth the way the picture shows it doing.
      const along = path.map((q) => {
        const px = Math.min(w - 1, Math.max(0, Math.floor(q.x)));
        const py = Math.min(h - 1, Math.max(0, Math.floor(q.y)));
        return Math.max(1, distance[py * w + px] * 2);
      });

      const kept = keepWidthChanges(along, simplify(path, options.tolerance), options.widthTolerance);
      emitted.push({ points: kept.map((i) => path[i]), widths: kept.map((i) => along[i]) });
    }

    // Water too round to have a centreline is areal, whatever its size — and
    // that, rather than any threshold, is the honest test. A first attempt
    // gave such a component a two-point stub at its own width instead, and a
    // two-point ribbon is a rectangle, so every pond on the map drew as a
    // hard blue box: a ribbon describes a line, and forcing an area into one
    // is the same category error that put rivers in the cell raster, run
    // backwards. So it falls through to an outline, which is what it is.
    if (emitted.length === 0) continue;

    rivers.push(...emitted);
    for (let i = 0; i < w * h; i++) if (water[i] && ids[i] === id) riverPixels[i] = 1;
  }

  return { rivers, riverPixels };
}
