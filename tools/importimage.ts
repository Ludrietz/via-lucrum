import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { PACK_FORMAT, RAW16_SCALE, type PackFile, type PackNodeSpec, type PackRiverSpec, WATER_SIGNAL_STEP } from '../src/sim/pack';
import { MIN_NODE_DISTANCE, type RawResource } from '../src/sim/source';
import { METRES_PER_UNIT } from '../src/sim/scale';
import { WATER_LEVEL } from '../src/sim/terrain';
import { ResourceType } from '../src/sim/types';
import { decodePng, encodePng } from './png';
import { traceRivers } from './riverTrace';

/**
 * Turn a drawn map into a map pack.
 *
 *   node tools/.build/importimage.mjs --image kuttenberg_region.png \
 *     --span 12 --out kcd-kuttenberg --name Kuttenberg --check
 *
 * The sibling of `importmap.ts`, and deliberately not a variant of it: that
 * one reads measurements of a real place, this one reads a *picture* of one.
 * They meet at the pack format and nowhere else, which is the whole reason
 * the format holds physical readings rather than anything game-shaped — see
 * the note at the top of `pack.ts`.
 *
 * ## Why this is possible at all
 *
 * A drawn map of this kind is flat-lit and colour-coded by land use rather
 * than shaded for realism, which makes it closer to a thematic map than to a
 * photograph: woodland is one colour, ploughland another, water another.
 * That is exactly the classification an importer needs, already done by the
 * artist. What it costs is everything that colour cannot carry.
 *
 * ## What it cannot read, and what is done instead
 *
 * **Elevation.** There is none in the image — the hill shading in this kind
 * of art is stylistic, and reading height out of it would mostly recover how
 * dark the tree stipple is. So relief is *synthesised* from the map's own
 * drainage and cover (see `synthesiseRelief`), which produces ground that
 * agrees with the picture rather than contradicting it. It is not a survey
 * and this file will not pretend it is; the pack records it as such.
 *
 * **Minerals.** A quarry and a wheatfield are both just ground. Timber and
 * food come out of the cover honestly; stone and iron have to be placed by
 * hand with `--sites`, and the run says so plainly if they are missing.
 *
 * ## The vignette
 *
 * Maps like this are printed with a heavy darkening toward the edges and an
 * overall sepia wash, which wrecks any classification by brightness — deep
 * forest in the middle of the map is the same shade as open ground at the
 * corner. Both are removed by fitting a smooth illumination model per colour
 * channel (`fitVignette`) and dividing it out. The model has seven terms
 * against millions of pixels, so it can follow the lighting and cannot
 * possibly follow a forest.
 */

// --------------------------------------------------------------- parameters

/** World units per terrain cell — matches the procedural world. */
const CELL_SIZE_DEFAULT = 32;

/**
 * Sim elevation for open water, and for the lowest land — set just either
 * side of the waterline. See `WATER_SIGNAL_STEP` for why the gap is small,
 * and what a large one did to the shoreline.
 */
const WATER_ELEVATION = WATER_LEVEL - WATER_SIGNAL_STEP;
const LAND_FLOOR = WATER_LEVEL + WATER_SIGNAL_STEP;
/**
 * Sim elevation the highest synthesised ground reaches. Set below the
 * mountain threshold (0.52) on purpose: this is drawn Bohemian farmland with
 * wooded ridges in it, and a mountain on this map would be a fiction the
 * picture does not support.
 */
const LAND_CEILING = 0.45;
/** Where the game starts calling ground 'hills' — mirrors HILLS_LEVEL in terrain.ts. */
const HILLS_LEVEL = 0.2;

type Cover = 'water' | 'river' | 'forest' | 'field' | 'open' | 'town' | 'road';

/**
 * Moisture per cover class — the same translation `importmap.ts` performs on
 * OSM land use, for the same reason. Colour becomes a physical reading and
 * `classifyTerrain` still decides what is a forest and what is a hill.
 */
const COVER_MOISTURE: Record<Cover, number> = {
  water: 1.0,
  // Only reached under `--rivers fordable`: wet ground rather than water.
  // Damp enough to be the most fertile land on the map, dry enough that the
  // classifier still calls it open country and a road ignores it entirely.
  river: 0.52,
  forest: 0.78,
  field: 0.4,
  open: 0.36,
  // A town sits on worked, trodden ground; a road likewise. Neither is a
  // terrain type in this game, so both read as ordinary open country.
  town: 0.34,
  road: 0.34,
};

/** A single temperature for a region this small — a few hundred metres of relief is not a climate. */
const TEMPERATURE = 0.5;

/**
 * How much of a cell has to be blue before the cell counts as water at all,
 * and how much before it counts as a broad one.
 *
 * These streams are drawn about ten metres wide against cells tens of metres
 * across, so almost nothing on this map fills a cell with water. If the bar
 * were set where an area class needs it, the map would have no rivers on it
 * at all. `RIVER_SHARE` is therefore low, and the two together only matter
 * for telling a stream from a millpond — both are water now, and both are
 * crossable by bridge.
 */
const WATER_SHARE = 0.55;
const RIVER_SHARE = 0.05;
/** Built-up ground is an area, not a line, so it needs a real share of the cell. */
const TOWN_SHARE = 0.25;

const DISTRICT_SIZE = 1000;
const MAX_NODES_DEFAULT = 120;

// --------------------------------------------------------------------- args

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const imagePath = arg('image', 'kuttenberg_region.png');
const spanKm = Number(arg('span', '12'));
const outId = arg('out', 'kcd-kuttenberg');
const outName = arg('name', 'Kuttenberg');
const cellSize = Number(arg('cell', String(CELL_SIZE_DEFAULT)));
const metresPerUnit = Number(arg('metres-per-unit', String(METRES_PER_UNIT)));
const maxNodes = Number(arg('max-nodes', String(MAX_NODES_DEFAULT)));
const extraSitesPath = arg('sites', '');
const villageArg = arg('village', '');
const seed = Number(arg('seed', '1'));
const startingPopulation = Number(arg('population', '5'));
const hillsShare = Number(arg('hills', '0.18'));
/**
 * What to do with watercourses too narrow to fill a cell.
 *
 * 'water' is now the default, because roads can bridge (see `BRIDGE_COST`).
 * A river is a real feature again: visible, dear to cross, and a genuine
 * argument about where a road should run rather than a wall.
 *
 * Before bridges existed this default was the other way round, and had to be:
 * every stream was a barrier no road could ever cross, and marking them water
 * cut Kuttenberg off from its own fields six hundred metres away. The cost
 * then was that the map lost its rivers as a *visible* feature entirely,
 * since a passable watercourse could only be drawn as ordinary ground.
 * 'fordable' keeps that older behaviour for a map where water should shape
 * the ground without ever obstructing it.
 */
const riversAs = arg('rivers', 'water') === 'fordable' ? 'river' : 'water';

/**
 * Widest water that leaves as geometry rather than staying in the raster,
 * in cells. See `TraceOptions.maxRasterWidth`.
 *
 * Three cells — a little under two hundred metres here. Below that the ground
 * bake cannot draw a shape, only a smudge; above it the raster is the better
 * home and a ribbon would be the wrong description anyway.
 */
const RIVER_MAX_CELLS = Number(arg('river-max-cells', '6'));
const RIVER_MAX_RASTER = (RIVER_MAX_CELLS * metresPerCell) / (spanKm * 1000 / IW);

/**
 * Smallest traced feature kept, in square pixels of water. See
 * `TraceOptions.minArea` — area rather than length, so that dropping
 * thinning artefacts does not also drop every pond.
 */
const RIVER_MIN_AREA = Number(arg('river-min-area', '60'));

/**
 * How far apart two water pixels may be and still be taken as one stroke, in
 * pixels. See `TraceOptions.close` — a colour test on a hand-drawn map
 * returns a dotted line, not a continuous one.
 */
const RIVER_CLOSE = Number(arg('river-close', '2'));

/** Smallest blob kept. Below this it is a fleck that passed the colour test, not water. */
const RIVER_MIN_BLOB = Number(arg('river-min-blob', '6'));

/**
 * Furthest a missing stretch of watercourse will be bridged, in pixels. See
 * `TraceOptions.maxGap` — this is sized against what hides a river on the
 * drawing, which is mostly a stand of trees.
 */
const RIVER_MAX_GAP = Number(arg('river-max-gap', '18'));

/** How closely the traced width is followed. See `keepWidthChanges`. */
const RIVER_WIDTH_TOLERANCE = Number(arg('river-width-tolerance', '1.5'));

/** Longest thinning whisker pruned off before tracing. See `TraceOptions.spur`. */
const RIVER_SPUR = Number(arg('river-spur', '10'));
const wantCheck = process.argv.includes('--check');

// ------------------------------------------------------------------- image

const png = decodePng(new Uint8Array(readFileSync(imagePath)));
const { width: IW, height: IH, pixels } = png;

/**
 * A smooth model of the page's own lighting: a quadratic surface plus a
 * fourth-order radial term, fitted to the log of one channel by least
 * squares. Seven coefficients over half a million samples can express "dark
 * at the edges, warm in the middle" and cannot express "there is a wood
 * here", which is precisely the distinction wanted.
 */
function fitVignette(channel: number): (x: number, y: number) => number {
  const terms = (u: number, v: number) => {
    const r2 = u * u + v * v;
    return [1, u, v, u * u, v * v, u * v, r2 * r2];
  };
  const N = 7;
  const A = Array.from({ length: N }, () => new Float64Array(N));
  const rhs = new Float64Array(N);

  for (let y = 0; y < IH; y += 5) {
    for (let x = 0; x < IW; x += 5) {
      const value = pixels[(y * IW + x) * 4 + channel] / 255;
      if (value <= 0.01) continue;
      const t = terms(x / IW - 0.5, y / IH - 0.5);
      const l = Math.log(value);
      for (let i = 0; i < N; i++) {
        rhs[i] += t[i] * l;
        for (let j = 0; j < N; j++) A[i][j] += t[i] * t[j];
      }
    }
  }

  const M = A.map((row, i) => Float64Array.from([...row, rhs[i]]));
  for (let c = 0; c < N; c++) {
    let piv = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k];
    }
  }
  const k = Array.from({ length: N }, (_, i) => M[i][N] / M[i][i]);
  return (x, y) => Math.exp(terms(x / IW - 0.5, y / IH - 0.5).reduce((s, v, i) => s + v * k[i], 0));
}

const vignette = [fitVignette(0), fitVignette(1), fitVignette(2)];

/** One pixel with the page lighting divided out. Roughly 1.0 is "average ground". */
function corrected(x: number, y: number): [number, number, number] {
  const i = (y * IW + x) * 4;
  return [
    pixels[i] / 255 / vignette[0](x, y),
    pixels[i + 1] / 255 / vignette[1](x, y),
    pixels[i + 2] / 255 / vignette[2](x, y),
  ];
}

/** How strongly the page is darkened here, 1 at the brightest point. */
let vignettePeak = 0;
for (let y = 0; y < IH; y += 16) {
  for (let x = 0; x < IW; x += 16) {
    vignettePeak = Math.max(vignettePeak, (vignette[0](x, y) + vignette[1](x, y) + vignette[2](x, y)) / 3);
  }
}
const lit = (x: number, y: number) =>
  (vignette[0](x, y) + vignette[1](x, y) + vignette[2](x, y)) / 3 / vignettePeak;

/**
 * What one pixel is.
 *
 * Thresholds are on the corrected image and were read off samples taken at
 * known places on the map rather than guessed — the town, a river, a strip
 * field, the middle of a wood. Water is the fussiest: a road edge and a
 * slate roof both go blue-ish once the sepia is removed, so water has to be
 * *strongly* blue and not bright, or every field boundary becomes a stream.
 */
function classifyPixel(x: number, y: number): Cover {
  const [r, g, b] = corrected(x, y);
  const v = (r + g + b) / 3;
  const blue = b - g;
  const red = r - g;

  // Water and built-up ground both go blue once the sepia is divided out —
  // a slate roof and a river are the same hue to this test. What separates
  // them is red: the town has tile and brick in it and comes out warm-blue
  // (r-g positive), while water is cold-blue (r-g negative). Missing that
  // put Kuttenberg itself in the 'field' class and founded the village in
  // the wrong place entirely.
  // Water has to be *cold* blue and not bright. Dropping the brightness cap
  // turned every road on the map into a river: a cream road line against
  // olive ground leaves blue-ish edge pixels, and at a sixth of a cell that
  // was enough to flood the whole network.
  if (blue > 0.22 && red < -0.02 && v < 1.28) return 'water';
  if (blue > 0.15 && red >= 0.03) return 'town';
  if (v > 1.36) return 'road';
  if (v > 1.13) return 'field';
  if (v < 1.00) return 'forest';
  return 'open';
}

// ------------------------------------------------------------------ raster

const spanMetres = spanKm * 1000;
const metresPerCell = metresPerUnit * cellSize;
const cols = Math.max(1, Math.round(spanMetres / metresPerCell));
const rows = Math.max(1, Math.round((spanMetres * (IH / IW)) / metresPerCell));
const width = cols * cellSize;
const height = rows * cellSize;

/**
 * One cover class per cell, by majority vote over every pixel that falls in
 * it. Voting rather than point-sampling is what turns a speckled per-pixel
 * guess into a usable map: a cell here is twenty-odd pixels on a side, so a
 * road crossing a field loses the vote and the field survives, which is the
 * right answer at this resolution.
 */
/**
 * Watercourses, pulled out as lines before anything is voted into cells.
 *
 * This has to happen at the picture's own resolution and not the raster's,
 * because that is the only place the information exists: the drawing renders
 * its rivers at a median of five metres, and a cell here is sixty-four. Vote
 * first and the width is gone for good — every watercourse becomes at best
 * one cell across, and then two once it has been dilated to stop roads
 * slipping through its diagonal corners.
 *
 * So the rivers leave as geometry (see `riverTrace.ts` and `RiverNetwork`),
 * and the ground they ran over is handed to the vote as `river` — wet
 * ground, not water. That is what it actually is now: the water is the line,
 * and what is left underneath is a damp valley floor a road may cross, with
 * the bridge priced off the river's real width instead of off how many wet
 * cells a line happened to clip.
 */
const worldPerPixel = width / IW;
const pixelWater = new Uint8Array(IW * IH);
for (let y = 0; y < IH; y++) {
  for (let x = 0; x < IW; x++) {
    if (classifyPixel(x, y) === 'water') pixelWater[y * IW + x] = 1;
  }
}

const traced = traceRivers(pixelWater, IW, IH, {
  maxRasterWidth: RIVER_MAX_RASTER,
  // A tolerance of about a cell: finer only preserves the thinning's own
  // staircase, which is an artefact of the algorithm rather than a meander
  // the artist drew.
  tolerance: metresPerCell / metresPerUnit / cellSize + 3,
  minArea: RIVER_MIN_AREA,
  close: RIVER_CLOSE,
  minComponentPixels: RIVER_MIN_BLOB,
  widthTolerance: RIVER_WIDTH_TOLERANCE,
  maxGap: RIVER_MAX_GAP,
  spur: RIVER_SPUR,
});

const rivers: PackRiverSpec[] = traced.rivers.map((r) => ({
  points: r.points.map((q) => ({ x: q.x * worldPerPixel, y: q.y * worldPerPixel })),
  widths: r.widths.map((wd) => wd * worldPerPixel),
}));


const cover = new Array<Cover>(cols * rows);
const litness = new Float32Array(cols * rows);
{
  const pxPerCellX = IW / cols;
  const pxPerCellY = IH / rows;
  const tally = new Map<Cover, number>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tally.clear();
      const x0 = Math.floor(col * pxPerCellX);
      const x1 = Math.min(IW, Math.floor((col + 1) * pxPerCellX));
      const y0 = Math.floor(row * pxPerCellY);
      const y1 = Math.min(IH, Math.floor((row + 1) * pxPerCellY));
      const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 20));

      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const raw = classifyPixel(x, y);
          // Water that has already left as a line is no longer water here.
          const cls: Cover = raw === 'water' && traced.riverPixels[y * IW + x] ? 'river' : raw;
          tally.set(cls, (tally.get(cls) ?? 0) + 1);
        }
      }

      // A plain majority is right for areas and wrong for lines. A river is
      // two pixels wide and a cell is twenty-odd across, so water never wins
      // a vote and the first run of this importer produced a map with no
      // water on it at all — on a region whose every village sits on a
      // stream. Linear features get a much lower bar: if a useful fraction of
      // the cell is water, the cell is water, because that is what a road
      // trying to cross it will actually meet.
      let votes = 0;
      for (const n of tally.values()) votes += n;
      let best: Cover = 'open';
      let bestN = -1;
      for (const [cls, n] of tally) {
        if (n > bestN) {
          best = cls;
          bestN = n;
        }
      }
      const wet = (tally.get('water') ?? 0) / votes;
      if (wet > WATER_SHARE) best = 'water';
      else if (wet > RIVER_SHARE) best = riversAs;
      else if ((tally.get('town') ?? 0) / votes > TOWN_SHARE) best = 'town';
      const i = row * cols + col;
      litness[i] = lit(Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2));
      // Out past the lit area of the page there is very little signal left to
      // correct, and what the art shows there is uniformly wooded country.
      // Taking it as woodland is both what the picture says and a better
      // border for the realm than a ring of misclassified open ground.
      cover[i] = litness[i] < 0.74 ? 'forest' : best;
    }
  }
}

// `thickenWater()` is deliberately not called any more, and the function is
// gone with it. Its entire job was to widen one-cell watercourses to two, so
// that a diagonal river could not be threaded by a road passing between two
// cells that touch only at a corner. No watercourse reaches the raster now —
// they are lines, and a line is crossed or it is not — so the problem it
// solved cannot arise, and the hundred-and-twenty-eight-metre floor it cost
// goes with it. What is left in the raster is lakes and ponds, which are
// areal, and which a raster holds correctly at any width they actually have.

// ---------------------------------------------------------------- elevation

/**
 * Relief the map does not contain, invented so as not to contradict what it
 * does contain.
 *
 * Two things the picture genuinely tells us about height, because both are
 * consequences of it: water runs in the low ground, and in this country the
 * ploughland is on the valley floors while the woods are left on the higher,
 * poorer, steeper ground. So ground rises with distance from a watercourse
 * and with how wooded its neighbourhood is, and the result is a landscape
 * whose valleys follow the drawn rivers and whose ridges sit under the drawn
 * forests.
 *
 * This is synthesis, not measurement, and the pack's `source` line says so.
 * What it buys is terrain cost that varies in the places the map implies it
 * should, which is most of what relief is *for* in this simulation — a road
 * that prefers the valley is the whole point.
 */
function synthesiseRelief(): Float32Array {
  const n = cols * rows;

  // Distance to the nearest water, in cells, by multi-source BFS.
  const distance = new Float32Array(n).fill(Infinity);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (cover[i] === 'water' || cover[i] === 'river') {
      distance[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const col = i % cols;
    const row = (i / cols) | 0;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const j = nr * cols + nc;
      if (distance[j] !== Infinity) continue;
      distance[j] = distance[i] + 1;
      queue.push(j);
    }
  }
  // A map with no water at all still needs somewhere to be low.
  let maxDistance = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(distance[i])) maxDistance = Math.max(maxDistance, distance[i]);
  if (maxDistance === 0) maxDistance = 1;

  // How wooded the neighbourhood is, which is the other half of the signal.
  const wooded = new Float32Array(n);
  for (let i = 0; i < n; i++) wooded[i] = cover[i] === 'forest' ? 1 : 0;
  const woodedSmooth = blur(wooded, 6);

  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const valley = Math.min(1, (Number.isFinite(distance[i]) ? distance[i] : maxDistance) / (maxDistance * 0.55));
    raw[i] = 0.55 * valley + 0.45 * woodedSmooth[i];
  }

  // Smoothed generously: hillsides, not a per-cell scatter of bumps.
  const smooth = blur(raw, 4);

  // Land the *share* of hills rather than letting it fall out of the shape of
  // the histogram. Stretching min-to-max across the band put 52% of this map
  // in the hills, because two thirds of it is wooded and wooded ground scores
  // high here — a region of gentle Bohemian farmland came out as a mountain
  // range. Mapping by percentile states the intent directly: the top
  // `hillsShare` of the ground is hill country, whatever the distribution
  // underneath happens to look like.
  const ranked = Array.from(smooth).sort((a, b) => a - b);
  const at = (p: number) => ranked[Math.min(ranked.length - 1, Math.max(0, Math.floor(ranked.length * p)))];
  const lo = at(0.02);
  const hillsStart = at(1 - hillsShare);
  const hi = at(0.995);

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (cover[i] === 'water') {
      out[i] = WATER_ELEVATION;
      continue;
    }
    const v = smooth[i];
    // Two straight segments meeting exactly on the hills threshold (0.2), so
    // the share above it is the share asked for.
    out[i] =
      v <= hillsStart
        ? LAND_FLOOR + ((v - lo) / Math.max(1e-6, hillsStart - lo)) * (HILLS_LEVEL - LAND_FLOOR)
        : HILLS_LEVEL + ((v - hillsStart) / Math.max(1e-6, hi - hillsStart)) * (LAND_CEILING - HILLS_LEVEL);
    out[i] = Math.max(LAND_FLOOR, Math.min(LAND_CEILING, out[i]));
  }
  return out;
}

/** Separable box blur over the cell grid. */
function blur(src: Float32Array, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let s = 0;
      let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const c = col + d;
        if (c < 0 || c >= cols) continue;
        s += src[row * cols + c];
        n++;
      }
      tmp[row * cols + col] = s / n;
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let s = 0;
      let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const r = row + d;
        if (r < 0 || r >= rows) continue;
        s += tmp[r * cols + col];
        n++;
      }
      out[row * cols + col] = s / n;
    }
  }
  return out;
}

// -------------------------------------------------------------------- sites

interface Blob {
  cells: number[];
  cx: number;
  cy: number;
}

/** Connected runs of one cover class, so a wood becomes one woodlot and not four hundred. */
/**
 * Site candidates on a lattice, scored by how much of the class surrounds
 * each point.
 *
 * Connected components are the obvious approach and they fail badly here: two
 * thirds of this map is woodland and almost all of it is one connected
 * region, so "one site per blob" produced eleven woodlots for a map that is
 * nothing but trees. What matters is not how many separate woods there are,
 * it is where a woodcutter could usefully stand — and that is a question
 * about the ground within walking distance of a point, not about topology.
 *
 * So: walk a lattice at roughly the minimum spacing between sites, keep the
 * points that sit in the class, and score each by how much of that class lies
 * around it. A clearing in the middle of a forest scores low, the heart of a
 * wood scores high, and the selection below sorts on that.
 */
function patchCandidates(wanted: Cover, resource: RawResource, density: number): Candidate[] {
  const spacing = Math.max(2, Math.round(MIN_NODE_DISTANCE / cellSize));
  const radius = spacing;
  const out: Candidate[] = [];

  for (let row = spacing; row < rows - spacing; row += spacing) {
    for (let col = spacing; col < cols - spacing; col += spacing) {
      if (cover[row * cols + col] !== wanted) continue;
      let same = 0;
      let seen = 0;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          seen++;
          if (cover[r * cols + c] === wanted) same++;
        }
      }
      if (same < seen * density) continue;
      out.push({
        resource,
        x: (col + 0.5) * cellSize,
        y: (row + 0.5) * cellSize,
        area: same,
        name: null,
      });
    }
  }
  return out;
}

function blobsOf(wanted: Cover, minCells: number): Blob[] {
  const seen = new Uint8Array(cols * rows);
  const found: Blob[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (seen[start] || cover[start] !== wanted) continue;
    const cells: number[] = [];
    const queue = [start];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      cells.push(i);
      const col = i % cols;
      const row = (i / cols) | 0;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const j = nr * cols + nc;
        if (seen[j] || cover[j] !== wanted) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
    if (cells.length < minCells) continue;
    let sx = 0;
    let sy = 0;
    for (const i of cells) {
      sx += (i % cols) + 0.5;
      sy += ((i / cols) | 0) + 0.5;
    }
    found.push({ cells, cx: (sx / cells.length) * cellSize, cy: (sy / cells.length) * cellSize });
  }
  return found;
}

/** Richness from how much of the class lies around the site, on the same curve `importmap.ts` uses. */
function richnessFor(cells: number): number {
  const hectares = (cells * metresPerCell * metresPerCell) / 10_000;
  return Math.max(0.7, Math.min(1.7, 0.7 + Math.cbrt(hectares / 40)));
}

interface Candidate {
  resource: RawResource;
  x: number;
  y: number;
  area: number;
  name: string | null;
}

// ---------------------------------------------------------------------- run

const NAME_FALLBACK: Record<RawResource, string> = {
  [ResourceType.Wood]: 'Woodland',
  [ResourceType.Stone]: 'Quarry',
  [ResourceType.Iron]: 'Mine',
  [ResourceType.Food]: 'Fields',
};

function main(): void {
  console.log(`=== importing ${outName} from ${imagePath} ===`);
  console.log(
    `image ${IW}x${IH}px  span ${spanKm}km  grid ${cols}x${rows} cells @ ${cellSize}u ` +
      `(${metresPerCell}m per cell, ${metresPerUnit}m per unit)`,
  );

  const counts: Record<string, number> = {};
  for (const c of cover) counts[c] = (counts[c] ?? 0) + 1;
  const total = cols * rows;
  console.log(
    'cover:    ' +
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${((n / total) * 100).toFixed(1)}%`)
        .join('  '),
  );

  const elevation = synthesiseRelief();

  // --- readings -------------------------------------------------------
  const raw = new Int16Array(cols * rows * 3);
  const bands = { water: 0, plains: 0, forest: 0, hills: 0, mountains: 0 };
  for (let i = 0; i < cols * rows; i++) {
    const e = elevation[i];
    const m = COVER_MOISTURE[cover[i]];
    raw[i * 3] = Math.round(e * RAW16_SCALE);
    raw[i * 3 + 1] = Math.round(m * RAW16_SCALE);
    raw[i * 3 + 2] = Math.round(TEMPERATURE * RAW16_SCALE);

    if (e < -0.34) bands.water++;
    else if (e > 0.52) bands.mountains++;
    else if (e > 0.2) bands.hills++;
    else if ((m - 0.5) * 1.5 + (0.5 - TEMPERATURE) * 0.3 > 0.05) bands.forest++;
    else bands.plains++;
  }
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  console.log(
    `ground:   water ${pct(bands.water)}  plains ${pct(bands.plains)}  forest ${pct(bands.forest)}  ` +
      `hills ${pct(bands.hills)}  mountains ${pct(bands.mountains)}`,
  );

  // --- village --------------------------------------------------------
  const towns = blobsOf('town', 3).sort((a, b) => b.cells.length - a.cells.length);
  let village: { name: string; x: number; y: number };
  if (villageArg) {
    const [fx, fy] = villageArg.split(',').map(Number);
    village = { name: outName, x: Math.round(fx * width), y: Math.round(fy * height) };
  } else if (towns.length > 0) {
    village = { name: outName, x: Math.round(towns[0].cx), y: Math.round(towns[0].cy) };
  } else {
    village = { name: outName, x: Math.round(width / 2), y: Math.round(height / 2) };
  }
  console.log(
    `village:  ${village.name} at (${village.x}, ${village.y}) — ` +
      `${((village.x / width) * 100).toFixed(0)}% across, ${((village.y / height) * 100).toFixed(0)}% down` +
      `${villageArg ? ' (given)' : ` (largest of ${towns.length} built-up areas)`}`,
  );

  // --- candidates -----------------------------------------------------
  const candidates: Candidate[] = [
    // Woodland is the map's background and comes in slabs; ploughland is
    // drawn as narrow strips radiating from a village and never fills a
    // neighbourhood the way a forest does. One density threshold for both
    // found fifty-five woodlots and eight farms on a map whose whole
    // economic point is its fields.
    ...patchCandidates('forest', ResourceType.Wood, 0.45),
    ...patchCandidates('field', ResourceType.Food, 0.16),
  ];
  if (extraSitesPath) {
    const extras = JSON.parse(readFileSync(extraSitesPath, 'utf8')) as Array<{
      name: string;
      resource: RawResource;
      /** Fractions of the image, so hand-placed sites survive a change of scale. */
      fx: number;
      fy: number;
      richness?: number;
    }>;
    for (const e of extras) {
      candidates.push({
        resource: e.resource,
        x: e.fx * width,
        y: e.fy * height,
        // Hand-placed sites jump the queue: an author who put a mine somewhere
        // meant it, and it must not lose its place to a large wood.
        area: Number.POSITIVE_INFINITY,
        name: e.name,
      });
    }
    console.log(`sites:    ${extras.length} hand-placed from ${extraSitesPath}`);
  }

  // --- selection (by trade, then by district — see `importmap.ts`) -----
  const districtsX = Math.max(1, Math.ceil(width / DISTRICT_SIZE));
  const districtOf = (c: Candidate) =>
    Math.floor(c.y / DISTRICT_SIZE) * districtsX + Math.floor(c.x / DISTRICT_SIZE);

  const buckets = new Map<RawResource, Map<number, Candidate[]>>();
  for (const c of candidates) {
    if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
    const col = Math.floor(c.x / cellSize);
    const row = Math.floor(c.y / cellSize);
    if (cover[row * cols + col] === 'water') continue;
    const byDistrict = buckets.get(c.resource) ?? new Map<number, Candidate[]>();
    const list = byDistrict.get(districtOf(c)) ?? [];
    list.push(c);
    byDistrict.set(districtOf(c), list);
    buckets.set(c.resource, byDistrict);
  }
  for (const byDistrict of buckets.values()) for (const list of byDistrict.values()) list.sort((a, b) => b.area - a.area);

  const nodes: PackNodeSpec[] = [];
  const used = new Set<string>();
  const placed: Record<string, number> = {};
  const trades = [...buckets.keys()];
  const cursor = new Map<RawResource, number>();

  while (nodes.length < maxNodes) {
    let any = false;
    for (const resource of trades) {
      if (nodes.length >= maxNodes) break;
      const byDistrict = buckets.get(resource)!;
      const districts = [...byDistrict.keys()];
      if (districts.length === 0) continue;

      let done = false;
      for (let step = 0; step < districts.length && !done; step++) {
        const at = ((cursor.get(resource) ?? 0) + step) % districts.length;
        const list = byDistrict.get(districts[at])!;
        while (list.length > 0) {
          const c = list.shift()!;
          if (Math.hypot(c.x - village.x, c.y - village.y) < MIN_NODE_DISTANCE) continue;
          if (nodes.some((n) => Math.hypot(n.x - c.x, n.y - c.y) < MIN_NODE_DISTANCE)) continue;

          placed[resource] = (placed[resource] ?? 0) + 1;
          let name = c.name ?? `${NAME_FALLBACK[resource]} ${placed[resource]}`;
          while (used.has(name)) name = `${name} ${placed[resource]}`;
          used.add(name);

          nodes.push({
            name,
            resource,
            x: Math.round(c.x),
            y: Math.round(c.y),
            richness: Number(
              (Number.isFinite(c.area) ? richnessFor(c.area) : 1.1).toFixed(2),
            ),
          });
          cursor.set(resource, at + 1);
          done = true;
          any = true;
          break;
        }
      }
    }
    if (!any) break;
  }

  console.log(
    `sites:    ${nodes.length} — ` +
      Object.entries(placed)
        .map(([r, n]) => `${r}=${n}`)
        .join(' '),
  );
  for (const needed of [ResourceType.Stone, ResourceType.Iron]) {
    if (!placed[needed]) {
      console.log(
        `  ! no ${needed} anywhere on this map. A drawn map cannot show what is under the ground; ` +
          `place some by hand and pass --sites (see the README).`,
      );
    }
  }

  // --- write ----------------------------------------------------------
  const binName = `${outId}.bin`;
  const file: PackFile = {
    format: PACK_FORMAT,
    name: outName,
    source:
      `Land cover, water and settlements read from the drawn map "${imagePath}" ` +
      `(${IW}x${IH}px, taken as ${spanKm}km across). ` +
      `Relief is SYNTHESISED from that map's drainage and woodland, not surveyed — see tools/importimage.ts. ` +
      `Imported ${new Date().toISOString().slice(0, 10)}.`,
    cellSize,
    metresPerUnit,
    seed,
    startingPopulation,
    village,
    terrain: { encoding: 'raw16', cols, rows, data: binName },
    rivers,
    nodes,
  };

  mkdirSync('public/maps', { recursive: true });
  writeFileSync(`public/maps/${binName}`, Buffer.from(raw.buffer));
  writeFileSync(`public/maps/${outId}.json`, `${JSON.stringify(file, null, 2)}\n`);

  if (wantCheck) writeCheckImage();

  console.log('');
  console.log(`water:     ${rivers.length} watercourses traced; areal water left in the raster`);
  console.log(`wrote public/maps/${outId}.json and public/maps/${binName}`);
  console.log(`play it with  ?pack=${outId}   or  --pack ${outId}`);
}

/**
 * A picture of what the importer believes it read, at cell resolution.
 *
 * Worth its twenty lines: no amount of staring at percentages tells you
 * whether the forests landed in the right places, and one look at this
 * against the original answers it immediately.
 */
function writeCheckImage(): void {
  const PALETTE: Record<Cover, [number, number, number]> = {
    water: [30, 70, 200],
    river: [90, 160, 235],
    road: [245, 245, 240],
    town: [200, 70, 55],
    field: [235, 205, 95],
    forest: [30, 85, 45],
    open: [155, 200, 115],
  };
  const zoom = 3;
  const w = cols * zoom;
  const h = rows * zoom;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = PALETTE[cover[((y / zoom) | 0) * cols + ((x / zoom) | 0)]];
      const o = (y * w + x) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  mkdirSync('tools/.build', { recursive: true });
  writeFileSync(`tools/.build/${outId}-cover.png`, encodePng(w, h, out));
  console.log(`check:    tools/.build/${outId}-cover.png`);
}

main();
