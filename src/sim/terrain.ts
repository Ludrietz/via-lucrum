import type { Vec2 } from './geometry';
import { NoiseField } from './noise';

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
const WATER_LEVEL = -0.34;
const HILLS_LEVEL = 0.2;
const MOUNTAIN_LEVEL = 0.52;
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
const FOREST_MOISTURE_THRESHOLD = 0.05;

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

    let type: TerrainType;
    if (elevation < WATER_LEVEL) type = TerrainType.Water;
    else if (elevation > MOUNTAIN_LEVEL) type = TerrainType.Mountains;
    else if (elevation > HILLS_LEVEL) type = TerrainType.Hills;
    else {
      const forestScore = (moisture - 0.5) * 1.5 + (0.5 - temperature) * 0.3 + detail * 0.1;
      type = forestScore > FOREST_MOISTURE_THRESHOLD ? TerrainType.Forest : TerrainType.Plains;
    }

    // Continuous characteristics, independent of `type` — see the class doc
    // comment. These deliberately keep varying even inside a single terrain
    // type, so e.g. two Hills cells can differ in how forested they are.
    const aboveWater = smooth01(elevation, WATER_LEVEL, WATER_LEVEL + 0.18);
    const forestDensity = clamp01(moisture * 0.8 + (1 - temperature) * 0.1 - Math.max(0, elevation) * 0.5) * aboveWater;
    const rockiness = clamp01(smooth01(elevation, HILLS_LEVEL - 0.25, MOUNTAIN_LEVEL) * 0.85 + (1 - moisture) * 0.25);
    const fertility = clamp01(moisture * 0.6 + temperature * 0.25 + (1 - Math.abs(elevation)) * 0.25) * aboveWater;
    const wetness = clamp01(moisture * 0.7 + (1 - aboveWater) * 0.6);

    return { type, elevation, moisture, temperature, fertility, forestDensity, rockiness, wetness };
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
 * The terrain the rest of the game actually queries. Backed by
 * `TerrainSampler` (pure noise, no state) plus a cache of generated chunks —
 * every query lazily generates and caches whatever chunk it lands in, so
 * pathfinding, rendering and resource placement can all ask about any point
 * without caring whether "the world" has been made that big yet. There is no
 * upfront pass over a fixed-size array the way the old brush-painted grid
 * had: the sampler works in world coordinates from -infinity to infinity,
 * and only the chunks something actually asked about ever get computed or
 * held in memory.
 */
export class TerrainField {
  readonly cellSize = CELL_SIZE;
  readonly sampler: TerrainSampler;

  private readonly chunks = new Map<string, TerrainChunk>();
  private readonly cellsPerChunk = TERRAIN_CHUNK_SIZE / CELL_SIZE;
  /** Chunks computed since the last `drainNewChunks` — what the renderer hasn't drawn yet. */
  private freshChunks: Array<{ cx: number; cy: number }> = [];

  constructor(seed: number) {
    this.sampler = new TerrainSampler(seed);
  }

  /**
   * Chunks generated since the last call, for whoever is responsible for
   * turning generated data into something drawn (see `TerrainLayer`) — the
   * same one-shot drain shape `World.drainEvents` already uses elsewhere.
   * Terrain generation itself has no idea rendering exists; this is the one
   * seam between the two, kept as small as possible.
   */
  drainNewChunks(): Array<{ cx: number; cy: number }> {
    const out = this.freshChunks;
    this.freshChunks = [];
    return out;
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
    this.freshChunks.push({ cx, cy });
    return chunk;
  }

  /** Make sure every chunk overlapping this world-space rectangle is generated and cached. */
  ensureGenerated(x0: number, y0: number, x1: number, y1: number): void {
    const size = TERRAIN_CHUNK_SIZE;
    const cx0 = Math.floor(x0 / size);
    const cx1 = Math.floor(x1 / size);
    const cy0 = Math.floor(y0 / size);
    const cy1 = Math.floor(y1 / size);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) this.getChunk(cx, cy);
    }
  }

  colAt(x: number): number {
    return Math.floor(x / CELL_SIZE);
  }

  rowAt(y: number): number {
    return Math.floor(y / CELL_SIZE);
  }

  cellCentre(col: number, row: number): Vec2 {
    return { x: (col + 0.5) * CELL_SIZE, y: (row + 0.5) * CELL_SIZE };
  }

  sampleAtCell(col: number, row: number): TerrainSample {
    const { cx, cy, lx, ly } = this.chunkAt(col, row);
    const chunk = this.getChunk(cx, cy);
    return chunk.samples[ly * this.cellsPerChunk + lx];
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

  isPassable(point: Vec2): boolean {
    return Number.isFinite(this.costAt(point));
  }

  /** How hard a finished road is to walk, averaged over its length. */
  averageCost(points: Vec2[]): number {
    if (points.length === 0) return 1;
    let total = 0;
    for (const p of points) total += this.costAt(p);
    return total / points.length;
  }

  /** True if a drawn line would have to cross water. There are no bridges. */
  crossesImpassable(points: Vec2[]): boolean {
    for (let i = 0; i < points.length - 1; i++) {
      const steps = Math.ceil(
        Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y) / (CELL_SIZE / 2),
      );
      for (let s = 0; s <= steps; s++) {
        const t = steps === 0 ? 0 : s / steps;
        const at = {
          x: points[i].x + (points[i + 1].x - points[i].x) * t,
          y: points[i].y + (points[i + 1].y - points[i].y) * t,
        };
        if (!this.isPassable(at)) return true;
      }
    }
    return false;
  }
}
