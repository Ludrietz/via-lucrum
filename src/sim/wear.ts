import { cumulativeLengths, type Vec2 } from './geometry';

/**
 * Wear is stored per patch of ground, not per road.
 *
 * That is what lets a corridor emerge: two roads drawn alongside each other
 * pack down the same earth and thicken together, and a spur that leaves a
 * trunk only wears the ground past the fork. It also keeps the data bounded by
 * the size of the map rather than by how much road the player has drawn — one
 * float per 48px patch, and only patches anyone has actually walked on are
 * kept, so a busy network is a few hundred numbers rather than a record per
 * road segment.
 */
export const WEAR_CELL = 48;

/** Deposited into each patch a completed delivery passes through. */
export const WEAR_PER_TRIP = 0.35;
/** A freshly cleared road starts faintly worn, then has to earn its keep. */
export const WEAR_ON_BUILD = 0.8;
/** Fraction lost per second; roughly a 35 second half-life. */
export const WEAR_DECAY = 0.02;
/** Below this a patch is treated as untouched ground again. */
export const WEAR_EPSILON = 0.02;
/** Wear at which a road is as packed down as it gets. */
export const WEAR_FULL = 4.5;

export class WearField {
  readonly cols: number;
  readonly rows: number;

  private readonly cells: Float32Array;
  /** Indices with any wear at all, so decay never sweeps the whole map. */
  private readonly worn = new Set<number>();

  constructor(width: number, height: number) {
    this.cols = Math.ceil(width / WEAR_CELL);
    this.rows = Math.ceil(height / WEAR_CELL);
    this.cells = new Float32Array(this.cols * this.rows);
  }

  /** How many patches are currently holding any wear. */
  get touchedPatches(): number {
    return this.worn.size;
  }

  /** Lay wear along a walked path, once per patch it passes through. */
  deposit(points: Vec2[], amount: number): void {
    const visited = new Set<number>();

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (WEAR_CELL / 2)));

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        visited.add(this.indexAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
      }
    }

    for (const index of visited) {
      this.cells[index] += amount;
      this.worn.add(index);
    }
  }

  /** Bilinear sample, so a road's width changes smoothly rather than in steps. */
  at(point: Vec2): number {
    const gx = point.x / WEAR_CELL - 0.5;
    const gy = point.y / WEAR_CELL - 0.5;
    const col = Math.floor(gx);
    const row = Math.floor(gy);
    const fx = gx - col;
    const fy = gy - row;

    return (
      this.cellAt(col, row) * (1 - fx) * (1 - fy) +
      this.cellAt(col + 1, row) * fx * (1 - fy) +
      this.cellAt(col, row + 1) * (1 - fx) * fy +
      this.cellAt(col + 1, row + 1) * fx * fy
    );
  }

  /** Mean wear along a path, which is how worn a whole road reads. */
  along(points: Vec2[]): number {
    if (points.length === 0) return 0;
    let total = 0;
    for (const p of points) total += this.at(p);
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
    const margin = Math.min(WEAR_CELL, total / 3);

    let weakest = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (cum[i] < margin || cum[i] > total - margin) continue;
      weakest = Math.min(weakest, this.at(points[i]));
    }

    return Number.isFinite(weakest) ? weakest : this.along(points);
  }

  decay(dt: number): void {
    const factor = Math.exp(-WEAR_DECAY * dt);

    for (const index of this.worn) {
      const next = this.cells[index] * factor;
      if (next < WEAR_EPSILON) {
        this.cells[index] = 0;
        this.worn.delete(index);
      } else {
        this.cells[index] = next;
      }
    }
  }

  private cellAt(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return 0;
    return this.cells[row * this.cols + col];
  }

  private indexAt(x: number, y: number): number {
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor(x / WEAR_CELL)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor(y / WEAR_CELL)));
    return row * this.cols + col;
  }
}
