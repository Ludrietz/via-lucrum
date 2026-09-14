import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import { cellKey, type LandParcel } from '../sim/landUse';
import type { World } from '../sim/world';
import { chaikin, jitterLoop, traceContours, type Bounds } from './marchingSquares';
import { COLORS, DEPTH, RESOURCE_COLORS } from './theme';

/** How often outlines are retraced. Ground changes hands slowly; this is generous. */
const REDRAW_INTERVAL = 0.6;
/** Occupancy above which a point counts as inside. Half, since the field is a local share. */
const THRESHOLD = 0.5;
const WOBBLE = 7;

interface ParcelView {
  parcel: LandParcel;
  colour: number;
  fillAlpha: number;
  lineAlpha: number;
}

/**
 * The ground places and works actually occupy.
 *
 * This is the map finally saying something it never could: that a town is a
 * patch of country rather than a point with a name under it, and that a wood
 * is a wood rather than a pin stuck in one. It is also the only honest way to
 * show the tension the land system exists to create — you can watch a
 * village's fields creep up to a forest's cutting ground and then over it,
 * and watch that forest's panel say it is producing less.
 *
 * Drawn the same way the realm's border is, and for the same reason: a
 * contour traced through an occupancy field, corner-cut and wobbled, so held
 * ground reads as an irregular hand-drawn boundary rather than the cell grid
 * it really is. The field here is the *local share* of held cells around a
 * point, which is what rounds off single-cell spurs and lets two lobes of the
 * same parcel merge visually where they nearly touch.
 */
/**
 * How solidly a parcel reads.
 *
 * These were 0.13 and 0.16, which on this map's low-contrast ground amounts
 * to a faint wash — and the ground a place holds is not decoration. It is the
 * whole of the land system: which cells a town has taken, where a wood has
 * been built over, why a village hemmed in by four workings will never be a
 * city. All of that is decided cell by cell and was being shown at an alpha
 * the player had to go looking for.
 *
 * Raised to where the shape is legible at a glance without burying the
 * terrain under it, and the outline raised further still: the *edge* is what
 * carries the information — where one claimant stops and the next begins — so
 * it should read harder than the fill it encloses.
 */
const WORKED_FILL = 0.28;
const SETTLED_FILL = 0.32;
const PARCEL_LINE = 0.85;

export class LandUseLayer {
  private readonly worked: Phaser.GameObjects.Graphics;
  private readonly settled: Phaser.GameObjects.Graphics;
  private redrawTimer = REDRAW_INTERVAL;
  private lastFingerprint = '';
  private zoom = 1;

  constructor(scene: Phaser.Scene, private readonly world: World) {
    this.worked = scene.add.graphics().setDepth(DEPTH.workedGround);
    this.settled = scene.add.graphics().setDepth(DEPTH.settledGround);
  }

  update(dt: number, zoom: number): void {
    this.zoom = zoom;
    this.redrawTimer += dt;
    if (this.redrawTimer < REDRAW_INTERVAL) return;
    this.redrawTimer = 0;

    const fingerprint = this.fingerprint();
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.draw();
  }

  /**
   * Cell counts plus zoom. A parcel only ever changes by gaining or losing
   * cells, so its size is a complete description of whether its outline
   * needs retracing — no need to hash the cells themselves.
   */
  private fingerprint(): string {
    const parts: string[] = [Math.round(Math.log2(Math.max(0.05, this.zoom)) * 4).toString()];
    for (const node of this.world.nodes) {
      if (node.ground.isEmpty) continue;
      parts.push(`n${node.id}:${node.ground.cells.size}`);
    }
    for (const trader of this.world.traders) parts.push(`t:${trader.ground.cells.size}`);
    return parts.join(',');
  }

  private draw(): void {
    this.worked.clear();
    this.settled.clear();

    for (const node of this.world.nodes) {
      if (node.ground.isEmpty) continue;
      this.drawParcel(this.worked, {
        parcel: node.ground,
        colour: RESOURCE_COLORS[node.resource] ?? COLORS.inkSoft,
        fillAlpha: WORKED_FILL,
        lineAlpha: PARCEL_LINE,
      });
    }

    for (const trader of this.world.traders) {
      if (trader.ground.isEmpty) continue;
      this.drawParcel(this.settled, {
        parcel: trader.ground,
        colour: COLORS.settledGround,
        fillAlpha: SETTLED_FILL,
        lineAlpha: PARCEL_LINE,
      });
    }
  }

  private drawParcel(g: Phaser.GameObjects.Graphics, view: ParcelView): void {
    const { terrain } = this.world;
    const cell = terrain.cellSize;
    const box = view.parcel.bounds(terrain);
    if (!box) return;

    // One cell of margin all round, so a parcel touching its own bounding box
    // still closes rather than being clipped into an open arc.
    const bounds: Bounds = { x0: box.x0 - cell, y0: box.y0 - cell, x1: box.x1 + cell, y1: box.y1 + cell };

    const field = (x: number, y: number): number => {
      const col = terrain.colAt(x);
      const row = terrain.rowAt(y);
      let held = 0;
      for (let dr = -1; dr <= 0; dr++) {
        for (let dc = -1; dc <= 0; dc++) {
          if (view.parcel.has(cellKey(col + dc, row + dr))) held++;
        }
      }
      return held / 4;
    };

    for (const loop of traceContours(bounds, cell, THRESHOLD, field)) {
      const shaped = jitterLoop(chaikin(loop, 2), WOBBLE);
      this.fillLoop(g, shaped, view.colour, view.fillAlpha);
      this.strokeLoop(g, shaped, view.colour, view.lineAlpha);
    }
  }

  private fillLoop(g: Phaser.GameObjects.Graphics, points: Vec2[], colour: number, alpha: number): void {
    if (points.length < 3) return;
    g.fillStyle(colour, alpha);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
    g.fillPath();
  }

  private strokeLoop(g: Phaser.GameObjects.Graphics, points: Vec2[], colour: number, alpha: number): void {
    if (points.length < 3) return;
    // Width in screen terms, like the realm's border: a fixed world-space
    // stroke thins to nothing when zoomed out, which is exactly when the
    // player most wants to see the shape of who holds what.
    g.lineStyle(1.4 / Math.max(0.05, this.zoom), colour, alpha);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
    g.strokePath();
  }
}
