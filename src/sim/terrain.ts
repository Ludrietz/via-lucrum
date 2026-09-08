import { catmullRom, closestPointOnPolyline, type Vec2 } from './geometry';

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

/**
 * Terrain is painted with a handful of broad shapes rather than authored cell
 * by cell. The grid samples them, and the renderer draws the same shapes, so
 * what the player sees and what the pathfinder walks cannot drift apart.
 */
export type TerrainBrush =
  | { shape: 'ellipse'; type: TerrainType; x: number; y: number; rx: number; ry: number }
  | { shape: 'path'; type: TerrainType; points: Vec2[]; width: number };

export const CELL_SIZE = 32;

export class TerrainGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize = CELL_SIZE;
  readonly brushes: readonly TerrainBrush[];

  private readonly cells: TerrainType[];

  constructor(
    readonly width: number,
    readonly height: number,
    brushes: readonly TerrainBrush[],
  ) {
    this.cols = Math.ceil(width / CELL_SIZE);
    this.rows = Math.ceil(height / CELL_SIZE);
    // Smooth river courses once, so the grid samples exactly what is drawn.
    this.brushes = brushes.map((brush) =>
      brush.shape === 'path' ? { ...brush, points: catmullRom(brush.points, 6) } : brush,
    );
    this.cells = new Array(this.cols * this.rows).fill(TerrainType.Plains);

    this.paint();
  }

  private paint(): void {
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const centre = this.cellCentre(col, row);
        // Later brushes paint over earlier ones.
        for (const brush of this.brushes) {
          if (this.covers(brush, centre)) this.cells[row * this.cols + col] = brush.type;
        }
      }
    }
  }

  private covers(brush: TerrainBrush, p: Vec2): boolean {
    if (brush.shape === 'ellipse') {
      const dx = (p.x - brush.x) / brush.rx;
      const dy = (p.y - brush.y) / brush.ry;
      return dx * dx + dy * dy <= 1;
    }
    return closestPointOnPolyline(brush.points, p).distance <= brush.width / 2;
  }

  // ------------------------------------------------------------------ access

  cellCentre(col: number, row: number): Vec2 {
    return { x: (col + 0.5) * CELL_SIZE, y: (row + 0.5) * CELL_SIZE };
  }

  colAt(x: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor(x / CELL_SIZE)));
  }

  rowAt(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor(y / CELL_SIZE)));
  }

  typeAtCell(col: number, row: number): TerrainType {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return TerrainType.Water;
    return this.cells[row * this.cols + col];
  }

  typeAt(point: Vec2): TerrainType {
    return this.typeAtCell(this.colAt(point.x), this.rowAt(point.y));
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
