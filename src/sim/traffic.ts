import { cumulativeLengths, type Vec2 } from './geometry';
import { ResourceType } from './types';

/**
 * What the ground remembers.
 *
 * This was the wear field, and it still does that job: every delivery packs
 * down each patch it crosses, roads read their width back out of it, and
 * unwalked ground recovers. It now also remembers *what* went past, which is
 * what lets a place develop a character — a patch that has seen nothing but
 * timber for days is a different proposition from a busy crossroads.
 *
 * Keeping both in one grid matters: settlements emerge at places, not at road
 * objects, and a place needs its traffic, its goods and its road quality
 * together. Storage stays bounded by the size of the map rather than by how
 * much road exists, and only patches somebody has actually used are tracked.
 */
export const PATCH_SIZE = 48;

/** Packed into each patch a completed delivery passes through. */
export const WEAR_PER_TRIP = 0.35;
/** A freshly cleared road starts faintly worn, then has to earn its keep. */
export const WEAR_ON_BUILD = 0.8;
/** Fraction of wear lost per second; roughly a 35 second half-life. */
export const WEAR_DECAY = 0.02;
/** Below this a patch is treated as untouched ground again. */
export const WEAR_EPSILON = 0.02;
/** Wear at which a road is as packed down as it gets. */
export const WEAR_FULL = 4.5;

/**
 * Goods fade slower than ruts do. A route's economic character should outlive
 * a quiet afternoon, or nowhere would ever settle.
 */
export const GOODS_DECAY = 0.008;
export const GOODS_EPSILON = 0.05;

export const TRACKED_GOODS: readonly ResourceType[] = [
  ResourceType.Wood,
  ResourceType.Iron,
  ResourceType.Stone,
  ResourceType.Food,
];

export type GoodsTally = Record<ResourceType, number>;

function emptyTally(): GoodsTally {
  return {
    [ResourceType.Wood]: 0,
    [ResourceType.Iron]: 0,
    [ResourceType.Stone]: 0,
    [ResourceType.Food]: 0,
  };
}

export class TrafficField {
  readonly cols: number;
  readonly rows: number;
  readonly patchSize = PATCH_SIZE;

  private readonly wear: Float32Array;
  private readonly goods: Record<ResourceType, Float32Array>;
  /** Patches holding anything at all, so decay never sweeps the whole map. */
  private readonly touched = new Set<number>();

  constructor(width: number, height: number) {
    this.cols = Math.ceil(width / PATCH_SIZE);
    this.rows = Math.ceil(height / PATCH_SIZE);

    const size = this.cols * this.rows;
    this.wear = new Float32Array(size);
    this.goods = {
      [ResourceType.Wood]: new Float32Array(size),
      [ResourceType.Iron]: new Float32Array(size),
      [ResourceType.Stone]: new Float32Array(size),
      [ResourceType.Food]: new Float32Array(size),
    };
  }

  get touchedPatches(): number {
    return this.touched.size;
  }

  /** Every patch that has seen traffic, for the systems that scan for sites. */
  get activePatches(): Iterable<number> {
    return this.touched;
  }

  patchCentre(index: number): Vec2 {
    const col = index % this.cols;
    const row = Math.floor(index / this.cols);
    return { x: (col + 0.5) * PATCH_SIZE, y: (row + 0.5) * PATCH_SIZE };
  }

  indexAt(point: Vec2): number {
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor(point.x / PATCH_SIZE)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor(point.y / PATCH_SIZE)));
    return row * this.cols + col;
  }

  // ------------------------------------------------------------------ writing

  /**
   * Record a journey. `wear` packs the ground down; `resource`/`amount` note
   * what was carried, when anything was.
   */
  deposit(points: Vec2[], wear: number, resource: ResourceType | null = null, amount = 0): void {
    const visited = new Set<number>();

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (PATCH_SIZE / 2)));

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        visited.add(this.indexAt({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
      }
    }

    for (const index of visited) {
      this.wear[index] += wear;
      if (resource && amount > 0) this.goods[resource][index] += amount;
      this.touched.add(index);
    }
  }

  decay(dt: number): void {
    const wearFactor = Math.exp(-WEAR_DECAY * dt);
    const goodsFactor = Math.exp(-GOODS_DECAY * dt);

    for (const index of this.touched) {
      this.wear[index] *= wearFactor;
      if (this.wear[index] < WEAR_EPSILON) this.wear[index] = 0;

      let anyGoods = false;
      for (const resource of TRACKED_GOODS) {
        const next = this.goods[resource][index] * goodsFactor;
        this.goods[resource][index] = next < GOODS_EPSILON ? 0 : next;
        if (this.goods[resource][index] > 0) anyGoods = true;
      }

      if (this.wear[index] === 0 && !anyGoods) this.touched.delete(index);
    }
  }

  // ------------------------------------------------------------------ reading

  /** Bilinear sample, so a road's width changes smoothly rather than in steps. */
  wearAt(point: Vec2): number {
    const gx = point.x / PATCH_SIZE - 0.5;
    const gy = point.y / PATCH_SIZE - 0.5;
    const col = Math.floor(gx);
    const row = Math.floor(gy);
    const fx = gx - col;
    const fy = gy - row;

    return (
      this.wearCell(col, row) * (1 - fx) * (1 - fy) +
      this.wearCell(col + 1, row) * fx * (1 - fy) +
      this.wearCell(col, row + 1) * (1 - fx) * fy +
      this.wearCell(col + 1, row + 1) * fx * fy
    );
  }

  /** Mean wear along a path, which is how worn a whole road reads. */
  wearAlong(points: Vec2[]): number {
    if (points.length === 0) return 0;
    let total = 0;
    for (const p of points) total += this.wearAt(p);
    return total / points.length;
  }

  /**
   * The most faded stretch of a path, ignoring the ends.
   *
   * Averages are no use for deciding a road is abandoned: wherever it meets
   * another road it shares that patch of ground, so its ends stay worn however
   * dead the middle is. A road is gone when any part of it has gone.
   */
  weakestAlong(points: Vec2[]): number {
    if (points.length === 0) return 0;

    const cum = cumulativeLengths(points);
    const total = cum[cum.length - 1];
    const margin = Math.min(PATCH_SIZE, total / 3);

    let weakest = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (cum[i] < margin || cum[i] > total - margin) continue;
      weakest = Math.min(weakest, this.wearAt(points[i]));
    }

    return Number.isFinite(weakest) ? weakest : this.wearAlong(points);
  }

  /** What has been carried through a patch, by kind. */
  goodsAt(point: Vec2): GoodsTally {
    return this.goodsAtIndex(this.indexAt(point));
  }

  goodsAtIndex(index: number): GoodsTally {
    const tally = emptyTally();
    for (const resource of TRACKED_GOODS) tally[resource] = this.goods[resource][index];
    return tally;
  }

  /** Everything carried through a patch, regardless of kind. */
  totalGoodsAtIndex(index: number): number {
    let total = 0;
    for (const resource of TRACKED_GOODS) total += this.goods[resource][index];
    return total;
  }

  wearAtIndex(index: number): number {
    return this.wear[index];
  }

  private wearCell(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return 0;
    return this.wear[row * this.cols + col];
  }
}

/** The good that dominates a tally, and how strongly, from 0 to 1. */
export function dominantGood(tally: GoodsTally): {
  resource: ResourceType | null;
  share: number;
  total: number;
} {
  let total = 0;
  let best: ResourceType | null = null;
  let bestAmount = 0;

  for (const resource of TRACKED_GOODS) {
    const amount = tally[resource];
    total += amount;
    if (amount > bestAmount) {
      bestAmount = amount;
      best = resource;
    }
  }

  return { resource: total > 0 ? best : null, share: total > 0 ? bestAmount / total : 0, total };
}
