import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import { TerrainType, type TerrainBrush } from '../sim/terrain';
import { SiteType } from '../sim/types';
import type { World } from '../sim/world';
import { COLORS, DEPTH } from './theme';

/** Tiny deterministic PRNG so the map looks hand-drawn but never changes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How often a cell of each type gets a glyph, and how big it draws. */
const SCATTER: Partial<Record<TerrainType, { chance: number; size: number }>> = {
  [TerrainType.Forest]: { chance: 0.5, size: 7 },
  [TerrainType.Hills]: { chance: 0.3, size: 13 },
  [TerrainType.Mountains]: { chance: 0.75, size: 20 },
};

/**
 * The landscape, drawn once at boot.
 *
 * Washes come from the same brush shapes the grid was painted from, so regions
 * read as continuous country rather than squares; the scattered glyphs on top
 * are placed cell by cell, which keeps what the player sees honest about what
 * the pathfinder actually walks.
 */
export class TerrainLayer {
  constructor(scene: Phaser.Scene, world: World) {
    const g = scene.add.graphics();
    g.setDepth(DEPTH.terrain);
    this.draw(g, world);
  }

  private draw(g: Phaser.GameObjects.Graphics, world: World): void {
    const rand = mulberry32(20260908);
    const { width: w, height: h } = world;
    const grid = world.terrain;

    g.fillStyle(COLORS.parchment, 1);
    g.fillRect(0, 0, w, h);
    this.blotches(g, rand, w, h);
    this.graticule(g, w, h);

    // Land washes first, in the order the grid was painted.
    for (const brush of grid.brushes) {
      if (brush.type === TerrainType.Water) continue;
      this.wash(g, brush);
    }

    this.fields(g, rand, world);

    for (const brush of grid.brushes) {
      if (brush.type === TerrainType.Water) this.wash(g, brush);
    }

    this.scatter(g, rand, world);
    this.border(g, w, h);
  }

  /** A soft region of colour following one brush shape. */
  private wash(g: Phaser.GameObjects.Graphics, brush: TerrainBrush): void {
    const style = {
      [TerrainType.Plains]: { color: COLORS.plains, alpha: 0.0 },
      [TerrainType.Forest]: { color: COLORS.forest, alpha: 0.1 },
      [TerrainType.Hills]: { color: COLORS.hill, alpha: 0.1 },
      [TerrainType.Mountains]: { color: COLORS.mountain, alpha: 0.16 },
      [TerrainType.Water]: { color: COLORS.water, alpha: 0.34 },
    }[brush.type];

    if (style.alpha === 0) return;

    if (brush.shape === 'ellipse') {
      // Two passes: a wide faint skirt, then the body, so edges feather.
      this.organicEllipse(g, brush, 1.16, style.color, style.alpha * 0.45);
      this.organicEllipse(g, brush, 1, style.color, style.alpha);
      return;
    }

    // Water is stroked in one pass; overlapping passes would darken the joins.
    this.strokePath(g, brush.points, brush.width + 18, style.color, style.alpha * 0.4);
    this.strokePath(g, brush.points, brush.width, style.color, style.alpha);
  }

  /**
   * The brush shape with a wobbly rim. It stays within a few percent of the
   * ellipse the grid was sampled from, but stops the map looking like it was
   * drawn with a compass.
   */
  private organicEllipse(
    g: Phaser.GameObjects.Graphics,
    brush: Extract<TerrainBrush, { shape: 'ellipse' }>,
    scale: number,
    color: number,
    alpha: number,
  ): void {
    const steps = 54;
    const points: Phaser.Geom.Point[] = [];
    const seed = brush.x * 0.013 + brush.y * 0.007;

    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const wobble =
        1 +
        Math.sin(angle * 3 + seed) * 0.05 +
        Math.sin(angle * 5 - seed * 2.3) * 0.035 +
        Math.sin(angle * 8 + seed * 0.7) * 0.02;

      points.push(
        new Phaser.Geom.Point(
          brush.x + Math.cos(angle) * brush.rx * scale * wobble,
          brush.y + Math.sin(angle) * brush.ry * scale * wobble,
        ),
      );
    }

    g.fillStyle(color, alpha);
    g.fillPoints(points, true);
  }

  private strokePath(
    g: Phaser.GameObjects.Graphics,
    points: Vec2[],
    width: number,
    color: number,
    alpha: number,
  ): void {
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
    g.strokePath();
  }

  /** Glyphs placed from the grid itself, jittered so the cells never show. */
  private scatter(g: Phaser.GameObjects.Graphics, rand: () => number, world: World): void {
    const grid = world.terrain;
    const cell = grid.cellSize;
    const sites = [world.village.position, ...world.nodes.map((n) => n.position)];

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const type = grid.typeAtCell(col, row);
        const style = SCATTER[type];
        if (!style || rand() > style.chance) continue;

        const centre = grid.cellCentre(col, row);
        const at = {
          x: centre.x + (rand() - 0.5) * cell * 1.1,
          y: centre.y + (rand() - 0.5) * cell * 1.1,
        };

        // Keep the ground clear right around the sites, so glyphs stay readable.
        if (sites.some((s) => Math.hypot(s.x - at.x, s.y - at.y) < 48)) continue;

        const size = style.size * (0.7 + rand() * 0.6);
        if (type === TerrainType.Forest) this.tree(g, at, size);
        else if (type === TerrainType.Hills) this.hill(g, at, size);
        else this.peak(g, at, size);
      }
    }
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

  /** Ploughed strips around the farms: site decoration, not terrain. */
  private fields(g: Phaser.GameObjects.Graphics, rand: () => number, world: World): void {
    for (const node of world.nodes) {
      if (node.type !== SiteType.Farm) continue;

      for (let i = 0; i < 11; i++) {
        const x = node.position.x + (rand() - 0.5) * 380;
        const y = node.position.y + (rand() - 0.5) * 240;
        if (Math.hypot(x - node.position.x, y - node.position.y) < 52) continue;
        if (world.terrain.typeAt({ x, y }) !== TerrainType.Plains) continue;

        const w = 46 + rand() * 40;
        const h = 26 + rand() * 18;
        g.fillStyle(COLORS.field, 0.16);
        g.fillRect(x - w / 2, y - h / 2, w, h);
        g.lineStyle(1.5, COLORS.field, 0.5);
        for (let s = -h / 2 + 4; s < h / 2; s += 6) {
          g.lineBetween(x - w / 2 + 3, y + s, x + w / 2 - 3, y + s);
        }
      }
    }
  }

  private blotches(
    g: Phaser.GameObjects.Graphics,
    rand: () => number,
    w: number,
    h: number,
  ): void {
    for (let i = 0; i < 60; i++) {
      g.fillStyle(rand() > 0.5 ? COLORS.parchmentDark : COLORS.parchmentLight, 0.16);
      g.fillEllipse(rand() * w, rand() * h, 260 + rand() * 560, 180 + rand() * 400);
    }
  }

  private graticule(g: Phaser.GameObjects.Graphics, w: number, h: number): void {
    g.lineStyle(1, COLORS.ink, 0.045);
    for (let x = 200; x < w; x += 200) g.lineBetween(x, 0, x, h);
    for (let y = 200; y < h; y += 200) g.lineBetween(0, y, w, y);
  }

  private border(g: Phaser.GameObjects.Graphics, w: number, h: number): void {
    g.lineStyle(3, COLORS.ink, 0.32);
    g.strokeRect(24, 24, w - 48, h - 48);
    g.lineStyle(1, COLORS.ink, 0.22);
    g.strokeRect(36, 36, w - 72, h - 72);
  }
}

