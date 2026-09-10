import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import { CELL_SIZE, TERRAIN_CHUNK_SIZE, TerrainType } from '../sim/terrain';
import type { World } from '../sim/world';
import { COLORS, DEPTH } from './theme';

/** Tiny deterministic PRNG so a chunk's scatter looks hand-drawn but never changes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELLS_PER_CHUNK = TERRAIN_CHUNK_SIZE / CELL_SIZE;

const TERRAIN_FILL: Record<TerrainType, { color: number; alpha: number }> = {
  [TerrainType.Plains]: { color: COLORS.plains, alpha: 0.14 },
  [TerrainType.Forest]: { color: COLORS.forest, alpha: 0.24 },
  [TerrainType.Hills]: { color: COLORS.hill, alpha: 0.26 },
  [TerrainType.Mountains]: { color: COLORS.mountain, alpha: 0.34 },
  [TerrainType.Water]: { color: COLORS.water, alpha: 0.4 },
};

/** How often a cell of each type gets a scatter glyph, and how big it draws. */
const SCATTER: Partial<Record<TerrainType, { chance: number; size: number }>> = {
  [TerrainType.Forest]: { chance: 0.5, size: 7 },
  [TerrainType.Hills]: { chance: 0.3, size: 13 },
  [TerrainType.Mountains]: { chance: 0.75, size: 20 },
};

interface ChunkView {
  gfx: Phaser.GameObjects.Graphics;
  bounds: Phaser.Geom.Rectangle;
}

/**
 * The landscape, built one generated chunk at a time. There is no upfront
 * "draw the whole map" pass any more — there is no whole map, only whatever
 * ground the simulation has actually generated (see `TerrainField` and
 * `WorldGenerator`) — so this layer just watches for newly generated chunks
 * every frame and turns each one into its own small piece of drawn terrain
 * the moment it appears, then leaves it alone forever after.
 */
export class TerrainLayer {
  private readonly chunks = new Map<string, ChunkView>();

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {
    this.sync();
  }

  /**
   * Pick up any chunks generated since last frame, and hide whatever the
   * camera can't see. Phaser skips invisible objects entirely, which is what
   * keeps an unbounded world affordable: however far the civilisation has
   * spread, only the handful of chunks actually on screen are ever drawn.
   */
  update(): void {
    this.sync();

    const view = this.scene.cameras.main.worldView;
    for (const chunk of this.chunks.values()) {
      chunk.gfx.setVisible(Phaser.Geom.Rectangle.Overlaps(view, chunk.bounds));
    }
  }

  private sync(): void {
    for (const { cx, cy } of this.world.terrain.drainNewChunks()) this.buildChunk(cx, cy);
  }

  private buildChunk(cx: number, cy: number): void {
    const key = `${cx},${cy}`;
    if (this.chunks.has(key)) return;

    const originCol = cx * CELLS_PER_CHUNK;
    const originRow = cy * CELLS_PER_CHUNK;
    const originX = originCol * CELL_SIZE;
    const originY = originRow * CELL_SIZE;

    const gfx = this.scene.add.graphics().setDepth(DEPTH.terrain);
    // Seeded off the chunk's own coordinates and the world seed, so scatter
    // is stable forever but never repeats identically chunk to chunk.
    const rand = mulberry32((cx * 928_371 + cy * 1_299_721 + this.world.seed * 7) >>> 0);

    gfx.fillStyle(COLORS.parchment, 1);
    gfx.fillRect(originX, originY, TERRAIN_CHUNK_SIZE, TERRAIN_CHUNK_SIZE);

    for (let ly = 0; ly < CELLS_PER_CHUNK; ly++) {
      for (let lx = 0; lx < CELLS_PER_CHUNK; lx++) {
        const sample = this.world.terrain.sampleAtCell(originCol + lx, originRow + ly);
        const worldX = originX + lx * CELL_SIZE;
        const worldY = originY + ly * CELL_SIZE;

        const fill = TERRAIN_FILL[sample.type];
        gfx.fillStyle(fill.color, fill.alpha);
        gfx.fillRect(worldX, worldY, CELL_SIZE + 0.6, CELL_SIZE + 0.6);

        const scatter = SCATTER[sample.type];
        if (!scatter || rand() > scatter.chance) continue;

        const at: Vec2 = {
          x: worldX + CELL_SIZE / 2 + (rand() - 0.5) * CELL_SIZE * 0.8,
          y: worldY + CELL_SIZE / 2 + (rand() - 0.5) * CELL_SIZE * 0.8,
        };
        const size = scatter.size * (0.7 + rand() * 0.6);
        if (sample.type === TerrainType.Forest) this.tree(gfx, at, size);
        else if (sample.type === TerrainType.Hills) this.hill(gfx, at, size);
        else this.peak(gfx, at, size);
      }
    }

    this.faintGrid(gfx, originX, originY);

    this.chunks.set(key, {
      gfx,
      bounds: new Phaser.Geom.Rectangle(originX, originY, TERRAIN_CHUNK_SIZE, TERRAIN_CHUNK_SIZE),
    });
  }

  private tree(g: Phaser.GameObjects.Graphics, at: Vec2, s: number): void {
    g.fillStyle(COLORS.forest, 0.34);
    g.fillTriangle(at.x, at.y - s * 1.5, at.x - s * 0.72, at.y + s * 0.6, at.x + s * 0.72, at.y + s * 0.6);
    g.fillStyle(COLORS.hill, 0.34);
    g.fillRect(at.x - 1, at.y + s * 0.5, 2, s * 0.45);
  }

  private hill(g: Phaser.GameObjects.Graphics, at: Vec2, s: number): void {
    g.lineStyle(2.4, COLORS.hill, 0.45);
    g.beginPath();
    g.moveTo(at.x - s, at.y + s * 0.4);
    g.lineTo(at.x, at.y - s * 0.45);
    g.lineTo(at.x + s, at.y + s * 0.4);
    g.strokePath();
  }

  /** A peak with a hatched shadow face, the way old maps mark high ground. */
  private peak(g: Phaser.GameObjects.Graphics, at: Vec2, s: number): void {
    g.fillStyle(COLORS.parchmentLight, 0.55);
    g.fillTriangle(at.x, at.y - s, at.x - s * 0.85, at.y + s * 0.55, at.x + s * 0.85, at.y + s * 0.55);

    g.fillStyle(COLORS.mountain, 0.5);
    g.fillTriangle(at.x, at.y - s, at.x + s * 0.85, at.y + s * 0.55, at.x + s * 0.1, at.y + s * 0.55);

    g.lineStyle(2, COLORS.mountain, 0.8);
    g.beginPath();
    g.moveTo(at.x - s * 0.85, at.y + s * 0.55);
    g.lineTo(at.x, at.y - s);
    g.lineTo(at.x + s * 0.85, at.y + s * 0.55);
    g.strokePath();
  }

  /** A whisper of a border round the chunk, so the eye has something to read besides colour changes. */
  private faintGrid(g: Phaser.GameObjects.Graphics, x: number, y: number): void {
    g.lineStyle(1, COLORS.ink, 0.03);
    g.strokeRect(x, y, TERRAIN_CHUNK_SIZE, TERRAIN_CHUNK_SIZE);
  }
}
