import type { Vec2 } from './geometry';
import { NoiseField } from './noise';
import type { TerrainSource } from './source';

export enum TerrainType {
  Plains = 'plains',
  Forest = 'forest',
  Hills = 'hills',
  Mountains = 'mountains',
  Water = 'water',
}

/**
 * What it costs a villager to cover ground here, relative to open plains.
 * Every terrain number in the game lives in this file; nothing else hardcodes
 * them. A road inherits the cost of the ground it was drawn across, and that
 * is what makes one way round the network cheaper than another.
 *
 * Later, road upgrades will discount these per stretch rather than change the
 * table: a graded road through hills should cost less than the bare hillside.
 */
export const TERRAIN_COSTS: Record<TerrainType, number> = {
  [TerrainType.Plains]: 1.0,
  [TerrainType.Forest]: 1.4,
  [TerrainType.Hills]: 2.0,
  [TerrainType.Mountains]: 3.2,
  [TerrainType.Water]: Infinity,
};

/**
 * What a bridge costs to cross, in the same units as `TERRAIN_COSTS`.
 *
 * Water stays `Infinity` in that table and always should: nothing can stand,
 * live, farm or be founded on a river. A bridge is not a kind of ground, it
 * is a way over ground that has none — so it lives here, as the one answer to
 * "what does water cost a *road*", and nothing that asks about places ever
 * sees it.
 *
 * Dearer than mountains. A timber bridge is the most expensive stretch of
 * road a medieval realm ever builds per yard, it is the first thing a flood
 * takes, and a laden cart crosses it slowly. Roads should cross rivers where
 * they must and go round where they can, which is exactly what a crossing
 * this dear produces — and it is why real towns grew at the fords.
 */
export const BRIDGE_COST = 4.5;

/**
 * The longest unbroken stretch of water a road may span, in world units.
 *
 * This is what keeps a bridge a bridge. Without it, "roads may cross water"
 * immediately means "roads may run down the middle of a lake", which is
 * absurd and also removes every interesting thing water does to a network.
 * With it, the rule reads the way it should: you may cross a river, and you
 * may not cross a sea.
 *
 * 120 units is about four terrain cells at the usual size — roughly 500m at
 * the scale this game is built at (`scale.ts`), which sounds enormous until
 * you remember the Charles Bridge is 516m and the one at Avignon was longer.
 * Medieval Europe built bridges at this scale, rarely and at great expense,
 * and that is the right feel: a crossing of a major river should be a
 * landmark, not a detail.
 */
export const MAX_BRIDGE_SPAN = 120;

export const TERRAIN_LABELS: Record<TerrainType, string> = {
  [TerrainType.Plains]: 'PLAINS',
  [TerrainType.Forest]: 'FOREST',
  [TerrainType.Hills]: 'HILLS',
  [TerrainType.Mountains]: 'MOUNTAINS',
  [TerrainType.Water]: 'WATER',
};

export const CELL_SIZE = 32;
/** World units per generated chunk — 32 cells on a side. */
export const TERRAIN_CHUNK_SIZE = CELL_SIZE * 32;

/**
 * Everything about a point worth knowing, not just which bucket it falls
 * into. `type` is what pathfinding and rendering key off — it has to stay a
 * small, finite set for the cost table above to make sense — but a forest
 * cell and a hill cell can each be more or less fertile, forested, rocky or
 * wet than another cell of the same type. Resource generation reads these
 * continuous values, not just `type`, which is what lets "a forest can be
 * fertile" and "a hill can be forested" both be true at once instead of one
 * label excluding every other property.
 */
export interface TerrainSample {
  type: TerrainType;
  /** Roughly -1 (seabed) to 1 (peak). What everything else is derived from. */
  elevation: number;
  /** 0 (arid) to 1 (sodden). */
  moisture: number;
  /** 0 (cold) to 1 (warm) — a broad climate band, not a daily reading. */
  temperature: number;
  /** 0 to 1: how good this ground is for growing things. */
  fertility: number;
  /** 0 to 1: how wooded this ground is, independent of whether `type` says "Forest". */
  forestDensity: number;
  /** 0 to 1: how much bare stone is underfoot. */
  rockiness: number;
  /** 0 to 1: dampness — high near water and in wet lowlands. */
  wetness: number;
}

// ------------------------------------------------------------------ layers

/**
 * Wavelengths are in world units. Elevation is the broadest — it is what
 * actually carves out large-scale geography (a mountain range spanning a real
 * fraction of the map, not a hill-sized bump) — moisture a little tighter so
 * forest/plains regions read as sub-regions of that geography rather than
 * exactly tracing it, temperature broader still (a climate band, not a
 * weather system), and detail deliberately short so region *edges* are
 * irregular without the regions themselves losing coherence.
 */
const ELEVATION_CONFIG = { wavelength: 2600, octaves: 5, gain: 0.52, lacunarity: 2.05 };
const MOISTURE_CONFIG = { wavelength: 2000, octaves: 4, gain: 0.5, lacunarity: 2.1 };
const TEMPERATURE_CONFIG = { wavelength: 4200, octaves: 3, gain: 0.5, lacunarity: 2.0 };
const DETAIL_CONFIG = { wavelength: 260, octaves: 2, gain: 0.5, lacunarity: 2.2 };

const SALT_ELEVATION = 1;
const SALT_MOISTURE = 2;
const SALT_TEMPERATURE = 3;
const SALT_DETAIL = 4;

/** Elevation below this is open water — a lake or the sea, whichever the shape reads as. */
export const WATER_LEVEL = -0.34;
export const HILLS_LEVEL = 0.2;
export const MOUNTAIN_LEVEL = 0.52;
/**
 * Forest vs. plains is not a second elevation band — it is the same lowland
 * split two ways by how wet it is. `forestScore` below is built entirely out
 * of terms recentred on zero (moisture and temperature relative to their own
 * midpoints, not their raw 0-1 values), specifically so its mean sits at
 * zero and this threshold is a real, legible bias rather than an arbitrary
 * number fighting the rest of the formula's scale. Set just above zero so,
 * averaged over the whole moisture field, a bit more of the lowlands reads
 * as plains than forest — open ground for roads and farms is meant to be
 * the common case, not the exception.
 */
export const FOREST_MOISTURE_THRESHOLD = 0.05;

/**
 * How strongly this ground wants to be woodland, as a continuous number
 * either side of `FOREST_MOISTURE_THRESHOLD`.
 *
 * Pulled out of the classifier so that it can be asked the question at a
 * finer grain than a cell. The classifier has to answer in buckets — a cell
 * is forest or it is plains, because a road has to be priced — but a renderer
 * drawing individual trees needs to know where the treeline runs *between*
 * two cells, and a settlement deciding what to clear needs the same. Having
 * them each re-derive it from moisture would be three subtly different
 * treelines; having one of them read `type` instead would put the treeline
 * back on the cell lattice, which is exactly what we are trying to be rid of.
 *
 * So: one definition, sampled at whatever resolution the caller needs. The
 * sign of `score - FOREST_MOISTURE_THRESHOLD` is the classifier's answer, and
 * the magnitude is how far from the edge of the wood you are.
 */
export function woodlandScore(moisture: number, temperature: number, detail = 0): number {
  return (moisture - 0.5) * 1.5 + (0.5 - temperature) * 0.3 + detail * 0.1;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const smooth01 = (v: number, lo: number, hi: number): number => clamp01((v - lo) / (hi - lo || 1e-6));

/**
 * The four independent fields terrain is built from, plus the classifier
 * that turns them into a `TerrainSample`. Kept separate from `TerrainField`
 * below so "what does the ground look like here" never depends on whether a
 * chunk happens to be generated yet — the same seed always answers the same
 * way at the same point, which is the one property everything else (seamless
 * chunk borders, reproducible seeds, resource placement peeking at
 * neighbouring ground) is built on.
 */
export class TerrainSampler {
  private readonly elevation: NoiseField;
  private readonly moisture: NoiseField;
  private readonly temperature: NoiseField;
  private readonly detail: NoiseField;

  constructor(readonly seed: number) {
    this.elevation = new NoiseField(seed, SALT_ELEVATION, ELEVATION_CONFIG);
    this.moisture = new NoiseField(seed, SALT_MOISTURE, MOISTURE_CONFIG);
    this.temperature = new NoiseField(seed, SALT_TEMPERATURE, TEMPERATURE_CONFIG);
    this.detail = new NoiseField(seed, SALT_DETAIL, DETAIL_CONFIG);
  }

  sampleAt(x: number, y: number): TerrainSample {
    const detail = this.detail.sample(x, y);
    // Detail is folded into elevation and moisture *before* anything is
    // thresholded, not applied as a separate speckle on top — that is what
    // makes region edges irregular (a ragged coastline, a forest edge that
    // wanders) rather than a clean iso-line with noise sprinkled over it.
    const elevation = clamp01((this.elevation.sample(x, y) + detail * 0.12 + 1) / 2) * 2 - 1;
    const moisture = clamp01(this.moisture.sample01(x, y) + detail * 0.08);
    const temperature = this.temperature.sample01(x, y);
    return classifyTerrain(elevation, moisture, temperature, detail);
  }
}

/**
 * Ground truth: the one place that decides what a set of physical readings
 * *means* in this game.
 *
 * This used to live inside `TerrainSampler`, which was fine while noise was
 * the only thing that could produce a reading. It is pulled out because it
 * must not be: an imported map (`pack.ts`) supplies elevation, moisture and
 * temperature measured off a real place, and it has to arrive at a hill by
 * exactly the same reasoning noise does, or the two kinds of world quietly
 * become two different games. Every balance lesson this project has learned
 * on procedural maps is only transferable if this function is shared.
 *
 * Which is also why an imported map is *not* allowed to state terrain types
 * directly, however tempting that is when you have real land-cover data to
 * hand. Stating "this cell is forest" would bypass everything below it —
 * fertility, rockiness, forest density, wetness are all derived here, and a
 * declared forest with no moisture behind it would be a forest that grows
 * nothing, sits on the wrong soil and prices roads wrong. An importer's job
 * is to translate real land cover *into* these three readings and let this
 * function have the last word.
 *
 * `detail` is the procedural generator's short-wavelength roughness, which
 * only it has; it nudges the forest/plains split so that boundary wanders
 * instead of tracing a clean iso-line. An imported map passes nothing and
 * gets zero, because its own readings already carry whatever local variation
 * the real ground has.
 */
export function classifyTerrain(
  elevation: number,
  moisture: number,
  temperature: number,
  detail = 0,
): TerrainSample {
  let type: TerrainType;
  if (elevation < WATER_LEVEL) type = TerrainType.Water;
  else if (elevation > MOUNTAIN_LEVEL) type = TerrainType.Mountains;
  else if (elevation > HILLS_LEVEL) type = TerrainType.Hills;
  else {
    type = woodlandScore(moisture, temperature, detail) > FOREST_MOISTURE_THRESHOLD ? TerrainType.Forest : TerrainType.Plains;
  }

  // Continuous characteristics, independent of `type` — see `TerrainSample`.
  // These deliberately keep varying even inside a single terrain type, so
  // e.g. two Hills cells can differ in how forested they are.
  const aboveWater = smooth01(elevation, WATER_LEVEL, WATER_LEVEL + 0.18);
  const forestDensity = clamp01(moisture * 0.8 + (1 - temperature) * 0.1 - Math.max(0, elevation) * 0.5) * aboveWater;
  const rockiness = clamp01(smooth01(elevation, HILLS_LEVEL - 0.25, MOUNTAIN_LEVEL) * 0.85 + (1 - moisture) * 0.25);
  const fertility = clamp01(moisture * 0.6 + temperature * 0.25 + (1 - Math.abs(elevation)) * 0.25) * aboveWater;
  const wetness = clamp01(moisture * 0.7 + (1 - aboveWater) * 0.6);

  return { type, elevation, moisture, temperature, fertility, forestDensity, rockiness, wetness };
}

// -------------------------------------------------------------------- grid

/**
 * Everything a `TerrainSource` can work out for itself once it can answer
 * one question — "what is in this cell?" — on a regular grid.
 *
 * Both kinds of world are grids of cells, and every derived answer below
 * (what a road costs, whether a line crosses water, which cell a point falls
 * in) is the same arithmetic in each. Having each implementation write its
 * own copy would be two places for "what does a hill cost to cross" to live,
 * and they would drift the first time one of them was tuned. Subclasses
 * supply `cellSize` and `sampleAtCell` and inherit the rest.
 */
export abstract class GridTerrain implements TerrainSource {
  abstract readonly cellSize: number;

  /** What is in this cell. The one thing a terrain source has to answer for itself. */
  abstract sampleAtCell(col: number, row: number): TerrainSample;

  /**
   * A hint that a rectangle is about to be queried in bulk, nothing more.
   * Sources that hold their whole map already have nothing to do here, so
   * doing nothing is the correct default — see `TerrainSource`.
   */
  ensureGenerated(_x0: number, _y0: number, _x1: number, _y1: number): void {}

  colAt(x: number): number {
    return Math.floor(x / this.cellSize);
  }

  rowAt(y: number): number {
    return Math.floor(y / this.cellSize);
  }

  cellCentre(col: number, row: number): Vec2 {
    return { x: (col + 0.5) * this.cellSize, y: (row + 0.5) * this.cellSize };
  }

  sampleAt(point: Vec2): TerrainSample {
    return this.sampleAtCell(this.colAt(point.x), this.rowAt(point.y));
  }

  typeAtCell(col: number, row: number): TerrainType {
    return this.sampleAtCell(col, row).type;
  }

  typeAt(point: Vec2): TerrainType {
    return this.sampleAt(point).type;
  }

  costAt(point: Vec2): number {
    return TERRAIN_COSTS[this.typeAt(point)];
  }

  /**
   * Whether something could stand, live or work here. Water is still no, and
   * always will be — a bridge is a way *across* water, not a place.
   */
  isPassable(point: Vec2): boolean {
    return Number.isFinite(this.costAt(point));
  }

  /**
   * What this ground costs a *road*, which is not the same question as what it
   * costs a settlement. Water is infinite for anything that has to occupy it
   * and merely expensive for something that spans it — see `BRIDGE_COST`.
   */
  roadCostAt(point: Vec2): number {
    const cost = this.costAt(point);
    return Number.isFinite(cost) ? cost : BRIDGE_COST;
  }

  /** How hard a finished road is to walk, averaged over its length. */
  averageCost(points: Vec2[]): number {
    if (points.length === 0) return 1;
    let total = 0;
    for (const p of points) total += this.roadCostAt(p);
    return total / points.length;
  }

  /**
   * The longest unbroken stretch of water this line crosses, in world units.
   *
   * The number that decides whether a road is a bridge or a folly. A road may
   * *span* water — that is what a bridge is — but it may not run along it, and
   * the difference between the two is entirely a matter of how far the water
   * goes on. One test answers both: measure the longest continuous run, and
   * let the caller compare it against what can actually be bridged.
   *
   * Returns 0 for a line that never touches water.
   */
  longestWaterSpan(points: Vec2[]): number {
    let longest = 0;
    let current = 0;

    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1].x - points[i].x;
      const dy = points[i + 1].y - points[i].y;
      const length = Math.hypot(dx, dy);
      const steps = Math.ceil(length / (this.cellSize / 2));
      const stride = steps === 0 ? 0 : length / steps;

      for (let s = 0; s <= steps; s++) {
        const t = steps === 0 ? 0 : s / steps;
        const at = { x: points[i].x + dx * t, y: points[i].y + dy * t };
        if (this.isPassable(at)) {
          current = 0;
          continue;
        }
        current += stride;
        if (current > longest) longest = current;
      }
    }

    return longest;
  }

  /**
   * Whether a road could be laid along this line — over water as well as
   * across it, so long as every crossing is one a bridge could actually make.
   */
  canCarryRoad(points: Vec2[]): boolean {
    return this.longestWaterSpan(points) <= MAX_BRIDGE_SPAN;
  }
}

// ------------------------------------------------------------------- field

interface TerrainChunk {
  samples: TerrainSample[];
}

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/**
 * Procedurally generated terrain. Backed by `TerrainSampler` (pure noise, no
 * state) plus a cache of generated chunks — every query lazily generates and
 * caches whatever chunk it lands in, so pathfinding, rendering and resource
 * placement can all ask about any point without caring whether "the world"
 * has been made that big yet. There is no upfront pass over a fixed-size
 * array the way the old brush-painted grid had: the sampler works in world
 * coordinates from -infinity to infinity, and only the chunks something
 * actually asked about ever get computed or held in memory.
 */
export class TerrainField extends GridTerrain {
  readonly cellSize = CELL_SIZE;
  readonly sampler: TerrainSampler;

  private readonly chunks = new Map<string, TerrainChunk>();
  private readonly cellsPerChunk = TERRAIN_CHUNK_SIZE / CELL_SIZE;

  constructor(seed: number) {
    super();
    this.sampler = new TerrainSampler(seed);
  }

  private chunkAt(col: number, row: number): { cx: number; cy: number; lx: number; ly: number } {
    const cx = Math.floor(col / this.cellsPerChunk);
    const cy = Math.floor(row / this.cellsPerChunk);
    return { cx, cy, lx: col - cx * this.cellsPerChunk, ly: row - cy * this.cellsPerChunk };
  }

  private getChunk(cx: number, cy: number): TerrainChunk {
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (chunk) return chunk;

    const samples: TerrainSample[] = new Array(this.cellsPerChunk * this.cellsPerChunk);
    const originCol = cx * this.cellsPerChunk;
    const originRow = cy * this.cellsPerChunk;
    for (let ly = 0; ly < this.cellsPerChunk; ly++) {
      for (let lx = 0; lx < this.cellsPerChunk; lx++) {
        const worldX = (originCol + lx + 0.5) * CELL_SIZE;
        const worldY = (originRow + ly + 0.5) * CELL_SIZE;
        samples[ly * this.cellsPerChunk + lx] = this.sampler.sampleAt(worldX, worldY);
      }
    }

    chunk = { samples };
    this.chunks.set(key, chunk);
    return chunk;
  }

  /** Make sure every chunk overlapping this world-space rectangle is generated and cached. */
  override ensureGenerated(x0: number, y0: number, x1: number, y1: number): void {
    const size = TERRAIN_CHUNK_SIZE;
    const cx0 = Math.floor(x0 / size);
    const cx1 = Math.floor(x1 / size);
    const cy0 = Math.floor(y0 / size);
    const cy1 = Math.floor(y1 / size);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) this.getChunk(cx, cy);
    }
  }

  sampleAtCell(col: number, row: number): TerrainSample {
    const { cx, cy, lx, ly } = this.chunkAt(col, row);
    const chunk = this.getChunk(cx, cy);
    return chunk.samples[ly * this.cellsPerChunk + lx];
  }
}

// ------------------------------------------------------------------- reach

/**
 * Every cell that can be got to from `origin` out to `reach`, on foot or —
 * if `maxWaterRun` allows it — over a bridge.
 *
 * Two questions used to share this function and they turn out not to be the
 * same one. "Is there enough connected dry land here to found a village on?"
 * is about *ground*, and a bridge is irrelevant to it — a hamlet on a sandbar
 * is still a hamlet on a sandbar. "Can a road get from the village to that
 * wood?" is about *routing*, and since roads learned to bridge, the answer
 * changed. Conflating them meant an authored map was refused for putting a
 * farm across a stream a road could now trivially cross.
 *
 * So the difference is one parameter, and it defaults to the stricter
 * reading. `maxWaterRun` is how many consecutive water cells may be crossed
 * in one go; zero means none, which is exactly the old behaviour, which is
 * what the procedural generator still wants.
 *
 * The returned set holds packed cell keys relative to `origin`, meaningful
 * only to `isWalkableTo` below.
 */
export function walkableCellsFrom(
  terrain: TerrainSource,
  origin: Vec2,
  reach: number,
  maxWaterRun = 0,
): Set<number> {
  const size = terrain.cellSize;
  const originCol = terrain.colAt(origin.x);
  const originRow = terrain.rowAt(origin.y);
  const span = Math.ceil(reach / size);
  const seen = new Set<number>();
  const key = (col: number, row: number) => (col - originCol + span) * (span * 2 + 3) + (row - originRow + span);

  if (terrain.typeAtCell(originCol, originRow) === TerrainType.Water) return seen;

  // Each entry carries how much water has been crossed to get here without
  // touching land, because that — not the cell alone — is what decides
  // whether the next water cell is still part of one bridgeable crossing.
  const best = new Map<number, number>();
  const queue: Array<[number, number, number]> = [[originCol, originRow, 0]];
  seen.add(key(originCol, originRow));
  best.set(key(originCol, originRow), 0);

  while (queue.length > 0) {
    const [col, row, run] = queue.pop()!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = col + dc;
      const nr = row + dr;
      if (Math.abs(nc - originCol) > span || Math.abs(nr - originRow) > span) continue;

      const wet = terrain.typeAtCell(nc, nr) === TerrainType.Water;
      const nextRun = wet ? run + 1 : 0;
      if (wet && nextRun > maxWaterRun) continue;

      const k = key(nc, nr);
      // Revisit a cell only when this route reached it across less water, so
      // a crossing that arrives with budget to spare is not shut out by an
      // earlier one that arrived exhausted.
      const previous = best.get(k);
      if (previous !== undefined && previous <= nextRun) continue;
      best.set(k, nextRun);
      seen.add(k);
      queue.push([nc, nr, nextRun]);
    }
  }

  return seen;
}

/**
 * Whether a point is in a set `walkableCellsFrom` returned for the same
 * origin and reach. Anything outside the searched square is not, by
 * definition — the flood fill never looked there.
 */
export function isWalkableTo(
  terrain: TerrainSource,
  origin: Vec2,
  reach: number,
  walkable: ReadonlySet<number>,
  point: Vec2,
): boolean {
  const span = Math.ceil(reach / terrain.cellSize);
  const originCol = terrain.colAt(origin.x);
  const originRow = terrain.rowAt(origin.y);
  const col = terrain.colAt(point.x);
  const row = terrain.rowAt(point.y);
  if (Math.abs(col - originCol) > span || Math.abs(row - originRow) > span) return false;
  return walkable.has((col - originCol + span) * (span * 2 + 3) + (row - originRow + span));
}
