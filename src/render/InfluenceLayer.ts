import Phaser from 'phaser';
import { closestPointOnPolyline, type Vec2 } from '../sim/geometry';
import type { World } from '../sim/world';
import { type Bounds, traceContours } from './marchingSquares';
import { COLORS, DEPTH } from './theme';

/** How finely the field is sampled, in world units, before being scaled by extent. */
const TARGET_CELLS_ACROSS = 130;
const MIN_CELL = 22;
const THRESHOLD = 0.1;
/**
 * How wide the ground taken in alongside a claim is drawn. Mirrors the link
 * width in `territory.ts`, so what the player sees is what the simulation
 * actually holds.
 */
const LINK_RADIUS = 210;

const REDRAW_INTERVAL = 0.4;
const EASE_RATE = 2.2;
const WOBBLE = 8;

interface Centre {
  position: Vec2;
  radius: number;
}

/**
 * The realm: soft fill, a clear line at the edge, and one coherent shape
 * rather than a ring around every place that has people in it.
 *
 * The technique here survived the expansion redesign intact — every holding
 * contributes a smooth bump to one scalar field, and the field's threshold is
 * traced with marching squares, which is what gives the border its organic,
 * hand-drawn irregularity instead of a stack of perfect circles. What changed
 * is what feeds it. It used to be each place's *influence radius*, read off
 * its tier, so the border swelled on its own whenever the simulation had a
 * good week, and a busy road dragged it out along itself. Now it is
 * `World.territory` — the ground the civilisation has actually taken in — so
 * the border only ever moves because somebody decided it should.
 *
 * That also makes the shape stable, which the old one was not: tier is a
 * continuous, wobbling readout, so the border used to breathe in and out with
 * every fluctuation in food. Holdings change only when something is claimed
 * or a settlement changes tier, so the line stays put between real events and
 * a claim reads as a genuine, legible expansion.
 */
export class InfluenceLayer {
  private readonly gfx: Phaser.GameObjects.Graphics;
  /** Keyed by holding, so newly-claimed ground can grow in rather than pop. */
  private readonly easedRadius = new Map<string, number>();
  private redrawTimer = 0;
  private lastFingerprint = '';
  /**
   * Current camera zoom. The border is drawn in world coordinates, so a line
   * given a fixed width thins to nothing as the player zooms out — at 0.42x
   * a 2.2-unit stroke is under a pixel, and the realm's edge simply vanished
   * against the terrain. Widths below are divided by this so the line holds
   * the same apparent weight at any zoom, which is what a border on a map
   * does.
   */
  private zoom = 1;

  constructor(scene: Phaser.Scene, private readonly world: World) {
    this.gfx = scene.add.graphics().setDepth(DEPTH.influence);
  }

  update(dt: number, zoom: number): void {
    this.zoom = zoom;
    const k = 1 - Math.exp(-EASE_RATE * dt);
    for (const holding of this.world.territory.all) {
      // A holding the renderer has not seen before starts at nothing and
      // grows to its full size, so claiming somewhere is a visible event:
      // the realm reaches out and takes the ground in over a moment or two
      // rather than a new shape simply being there on the next frame.
      const current = this.easedRadius.get(holding.key) ?? 0;
      this.easedRadius.set(holding.key, current + (holding.radius - current) * k);
    }

    this.redrawTimer += dt;
    if (this.redrawTimer < REDRAW_INTERVAL) return;
    this.redrawTimer = 0;

    const fingerprint = this.fingerprint();
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.draw();
  }

  /** Coarse enough that continuous easing doesn't trigger a redraw every tick. */
  private fingerprint(): string {
    return this.world.territory.all
      .map((h) => `${h.key}:${Math.round((this.easedRadius.get(h.key) ?? 0) / 6)}`)
      .join(',') + '|' + Math.round(Math.log2(Math.max(0.05, this.zoom)) * 4);
  }

  private draw(): void {
    const g = this.gfx;
    g.clear();

    const holdings = this.world.territory.all
      .map((h) => ({ holding: h, radius: this.easedRadius.get(h.key) ?? 0 }))
      .filter((h) => h.radius > 4);
    if (holdings.length === 0) return;

    const bounds = this.boundsFor(holdings.map((h) => ({ position: h.holding.position, radius: h.radius })));
    const cell = Math.max(MIN_CELL, Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0) / TARGET_CELLS_ACROSS);

    const field = (x: number, y: number): number => {
      let sum = 0;
      for (const { holding, radius } of holdings) {
        const d = Math.hypot(x - holding.position.x, y - holding.position.y);
        if (d < radius) sum += 1 - (d / radius) ** 2;
        // The corridor taken in alongside a claim, drawn at the same fraction
        // of its final width as the holding it serves — so the realm visibly
        // reaches *out along* the link rather than the far end appearing
        // first and the middle catching up.
        if (holding.link) {
          const grown = radius / Math.max(1, holding.radius);
          const width = LINK_RADIUS * grown;
          const linkDistance = closestPointOnPolyline([holding.link, holding.position], { x, y }).distance;
          if (linkDistance < width) sum += 1 - (linkDistance / width) ** 2;
        }
      }
      return sum;
    };

    const loops = traceContours(bounds, cell, THRESHOLD, field);

    // Settled ground: a soft fill under everything, then a clearer line per loop.
    const shapedLoops = loops.map((loop) => jitterLoop(chaikin(loop, 2), WOBBLE));
    for (const loop of shapedLoops) this.fillLoop(g, loop, COLORS.influence, 0.1);
    // Dark casing first, warm line over it — the same two-pass trick the roads
    // use, and what makes the edge legible over pale fields and dark forest
    // alike rather than only over one of them.
    for (const loop of shapedLoops) this.strokeLoop(g, loop, COLORS.ink, 0.28, 3.2);
    for (const loop of shapedLoops) this.strokeLoop(g, loop, 0x8a6f3a, 0.95, 1.5);
  }

  private fillLoop(g: Phaser.GameObjects.Graphics, points: Vec2[], color: number, alpha: number): void {
    if (points.length < 3) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
    g.fillPath();
  }

  private strokeLoop(g: Phaser.GameObjects.Graphics, points: Vec2[], color: number, alpha: number, width: number): void {
    if (points.length < 3) return;
    // Width in *screen* terms, so the line neither vanishes when zoomed out
    // nor turns into a fat band when zoomed in.
    g.lineStyle(width / Math.max(0.05, this.zoom), color, alpha);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
    g.strokePath();
  }

  private boundsFor(centres: Centre[]): Bounds {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;

    for (const c of centres) {
      x0 = Math.min(x0, c.position.x - c.radius);
      y0 = Math.min(y0, c.position.y - c.radius);
      x1 = Math.max(x1, c.position.x + c.radius);
      y1 = Math.max(y1, c.position.y + c.radius);
    }

    const margin = LINK_RADIUS + 40;
    return { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
  }
}

/** Corner-cutting subdivision: a cheap way to round off the grid's stairsteps. */
function chaikin(points: Vec2[], iterations: number): Vec2[] {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const next: Vec2[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % n];
      next.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
      next.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
    }
    pts = next;
  }
  return pts;
}

/** Deterministic, position-based wobble, so the border reads as drawn rather than computed. */
function jitterLoop(points: Vec2[], strength: number): Vec2[] {
  return points.map((p) => {
    const nx = Math.sin(p.x * 0.014 + p.y * 0.021) + Math.sin(p.x * 0.037 - p.y * 0.009) * 0.6;
    const ny = Math.sin(p.x * 0.019 - p.y * 0.027) + Math.sin(p.x * 0.008 + p.y * 0.033) * 0.6;
    return { x: p.x + nx * strength * 0.4, y: p.y + ny * strength * 0.4 };
  });
}
