import Phaser from 'phaser';
import type { Trader } from '../sim/economy';
import { closestPointOnPolyline, type Vec2 } from '../sim/geometry';
import { WEAR_FULL } from '../sim/traffic';
import type { World } from '../sim/world';
import { type Bounds, traceContours } from './marchingSquares';
import { COLORS, DEPTH } from './theme';

/** How finely the field is sampled, in world units, before being scaled by extent. */
const TARGET_CELLS_ACROSS = 130;
const MIN_CELL = 22;
const THRESHOLD = 0.1;
/** How much of a settlement's field a busy road drags out along itself. */
const CORRIDOR_RADIUS = 90;
const CORRIDOR_WEIGHT = 0.4;
/** Ignore roads too quiet to be worth the extra field sampling. */
const CORRIDOR_MIN_WEAR = 0.35;
/** Guard against a huge network making this expensive; corridors are a flourish, not a requirement. */
const MAX_CORRIDOR_SEGMENTS = 260;

const REDRAW_INTERVAL = 0.4;
const EASE_RATE = 2.2;
const WOBBLE = 8;

interface Centre {
  position: Vec2;
  radius: number;
}

interface Corridor {
  a: Vec2;
  b: Vec2;
}

/**
 * The realm, drawn the way a map of one looks: soft fill, a clear line at
 * the edge, and one coherent shape rather than a ring around every place
 * that has people in it. Every settlement's reach is folded into a single
 * scalar field (so two nearby places blend into one region rather than a
 * pair of overlapping bubbles) and the field's threshold is traced with
 * marching squares, which is what gives the border its organic, hand-drawn
 * irregularity instead of a stack of perfect circles.
 */
export class InfluenceLayer {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly easedRadius = new Map<Trader, number>();
  private redrawTimer = 0;
  private lastFingerprint = '';

  constructor(scene: Phaser.Scene, private readonly world: World) {
    this.gfx = scene.add.graphics().setDepth(DEPTH.influence);
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-EASE_RATE * dt);
    for (const trader of this.world.traders) {
      const target = trader.influenceRadius;
      const current = this.easedRadius.get(trader) ?? target;
      this.easedRadius.set(trader, current + (target - current) * k);
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
    const radii = this.world.traders.map((t) => Math.round((this.easedRadius.get(t) ?? 0) / 6)).join(',');
    const wear = this.world.network.edges
      .filter((e) => e.isBuilt)
      .map((e) => Math.round((this.world.wearOf(e) / WEAR_FULL) * 8))
      .join(',');
    return `${radii}|${wear}`;
  }

  private draw(): void {
    const g = this.gfx;
    g.clear();

    const centres: Centre[] = this.world.traders
      .map((t) => ({ position: t.position, radius: this.easedRadius.get(t) ?? t.influenceRadius }))
      .filter((c) => c.radius > 4);
    if (centres.length === 0) return;

    const corridors = this.roadCorridors();
    const bounds = this.boundsFor(centres);
    const cell = Math.max(MIN_CELL, Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0) / TARGET_CELLS_ACROSS);

    const field = (x: number, y: number): number => {
      let sum = 0;
      for (const c of centres) {
        const d = Math.hypot(x - c.position.x, y - c.position.y);
        if (d < c.radius) sum += 1 - (d / c.radius) ** 2;
      }
      for (const corridor of corridors) {
        const d = closestPointOnPolyline([corridor.a, corridor.b], { x, y }).distance;
        if (d < CORRIDOR_RADIUS) sum += CORRIDOR_WEIGHT * (1 - (d / CORRIDOR_RADIUS) ** 2);
      }
      return sum;
    };

    const loops = traceContours(bounds, cell, THRESHOLD, field);

    // Settled ground: a soft fill under everything, then a clearer line per loop.
    const shapedLoops = loops.map((loop) => jitterLoop(chaikin(loop, 2), WOBBLE));
    for (const loop of shapedLoops) this.fillLoop(g, loop, COLORS.influence, 0.05);
    for (const loop of shapedLoops) this.strokeLoop(g, loop, COLORS.influence, 0.6);
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

  private strokeLoop(g: Phaser.GameObjects.Graphics, points: Vec2[], color: number, alpha: number): void {
    if (points.length < 3) return;
    g.lineStyle(2.2, color, alpha);
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

    const margin = CORRIDOR_RADIUS + 40;
    return { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
  }

  /** Busy roads pull the field out along themselves, not just their ends. */
  private roadCorridors(): Corridor[] {
    const out: Corridor[] = [];

    for (const edge of this.world.network.edges) {
      if (!edge.isBuilt || out.length >= MAX_CORRIDOR_SEGMENTS) break;

      const weight = this.world.wearOf(edge) / WEAR_FULL;
      if (weight < CORRIDOR_MIN_WEAR) continue;

      for (let i = 0; i < edge.points.length - 1 && out.length < MAX_CORRIDOR_SEGMENTS; i++) {
        out.push({ a: edge.points[i], b: edge.points[i + 1] });
      }
    }

    return out;
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
