import Phaser from 'phaser';
import { cumulativeLengths, resamplePolyline, type Vec2 } from '../sim/geometry';
import type { RoadEdge } from '../sim/roadNetwork';
import type { World } from '../sim/world';
import { COLORS, DEPTH, roadWidth } from './theme';

export interface RoadPreview {
  points: Vec2[];
  valid: boolean;
  /** Where the road would attach, when the cursor is over something valid. */
  snap: Vec2 | null;
}

/** Distance between the points a road's width is measured at. */
const SAMPLE_SPACING = 15;
/** Wear moves slowly, so the widths only need refreshing a few times a second. */
const REFRESH_INTERVAL = 0.2;

interface EdgeShape {
  samples: Vec2[];
  cum: number[];
  widths: Float32Array;
}

/**
 * Draws the road network with a width that varies along each road, taken from
 * the wear packed into the ground beneath it. Where several roads run together
 * the shared corridor thickens into a highway; a spur off it stays a track.
 */
export class RoadLayer {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly previewGfx: Phaser.GameObjects.Graphics;
  private readonly highlightGfx: Phaser.GameObjects.Graphics;
  private readonly shapes = new Map<number, EdgeShape>();

  private preview: RoadPreview | null = null;
  private highlight: RoadEdge | null = null;
  private highlightDanger = false;
  private sinceRefresh = REFRESH_INTERVAL;
  private drawnVersion = -1;

  constructor(scene: Phaser.Scene, private readonly world: World) {
    this.gfx = scene.add.graphics().setDepth(DEPTH.roads);
    this.previewGfx = scene.add.graphics().setDepth(DEPTH.preview);
    this.highlightGfx = scene.add.graphics().setDepth(DEPTH.roads - 1);
  }

  setPreview(preview: RoadPreview | null): void {
    this.preview = preview;
    this.drawPreview();
  }

  /**
   * Outline the stretch under the cursor, so what an erase would take is never
   * a surprise. `danger` switches it from "you can grab this" to "this goes".
   */
  setHighlight(edge: RoadEdge | null, danger: boolean): void {
    if (this.highlight === edge && this.highlightDanger === danger) return;
    this.highlight = edge;
    this.highlightDanger = danger;
    this.drawHighlight();
  }

  update(dt: number): void {
    this.sinceRefresh += dt;

    const structural = this.drawnVersion !== this.world.network.version;
    if (!structural && this.sinceRefresh < REFRESH_INTERVAL) return;

    if (structural) {
      this.drawnVersion = this.world.network.version;
      this.forgetRemovedEdges();
    }

    this.stepWidths(this.sinceRefresh);
    this.sinceRefresh = 0;
    this.draw();
    this.drawHighlight();
  }

  /** Shapes are cached per edge; splitting or abandoning roads retires them. */
  private forgetRemovedEdges(): void {
    const live = new Set(this.world.network.edges.map((e) => e.id));
    for (const id of [...this.shapes.keys()]) {
      if (!live.has(id)) this.shapes.delete(id);
    }
  }

  private shapeFor(edge: RoadEdge): EdgeShape {
    let shape = this.shapes.get(edge.id);
    if (!shape) {
      const samples = resamplePolyline(edge.points, SAMPLE_SPACING);
      shape = {
        samples,
        cum: cumulativeLengths(samples),
        // Start at the width the ground already justifies, so a road that is
        // split in two does not visibly flinch.
        widths: Float32Array.from(samples, (p) => roadWidth(this.world.wear.at(p))),
      };
      this.shapes.set(edge.id, shape);
    }
    return shape;
  }

  private stepWidths(dt: number): void {
    const k = 1 - Math.exp(-2.5 * dt);

    for (const edge of this.world.network.edges) {
      const shape = this.shapeFor(edge);
      const target = shape.samples.map((p) => roadWidth(this.world.wear.at(p)));
      const smoothed = smooth(target);

      for (let i = 0; i < shape.widths.length; i++) {
        shape.widths[i] += (smoothed[i] - shape.widths[i]) * k;
      }
    }
  }

  private draw(): void {
    const g = this.gfx;
    g.clear();

    for (const edge of this.world.network.edges) {
      const shape = this.shapeFor(edge);
      const count = this.visibleSamples(edge, shape);
      if (count < 2) continue;

      const points = shape.samples.slice(0, count);
      const widths = Array.from(shape.widths.slice(0, count));

      this.ribbon(g, points, widths, 4, COLORS.roadCasing, 0.16);
      this.ribbon(g, points, widths, 0, COLORS.road, 0.95);
    }

    this.drawJunctions(g);
  }

  /** How much of a road has finished drawing itself in. */
  private visibleSamples(edge: RoadEdge, shape: EdgeShape): number {
    if (edge.buildProgress >= 1) return shape.samples.length;

    const target = shape.cum[shape.cum.length - 1] * Phaser.Math.Easing.Cubic.Out(edge.buildProgress);
    let count = 1;
    while (count < shape.cum.length && shape.cum[count] <= target) count++;
    return count;
  }

  /**
   * A road is filled as one ribbon: each sample offset to either side by half
   * its own width, so the outline swells and narrows with the traffic.
   */
  private ribbon(
    g: Phaser.GameObjects.Graphics,
    points: Vec2[],
    widths: number[],
    grow: number,
    color: number,
    alpha: number,
  ): void {
    const left: Phaser.Geom.Point[] = [];
    const right: Phaser.Geom.Point[] = [];

    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const half = (widths[i] + grow) / 2;
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;

      left.push(new Phaser.Geom.Point(points[i].x + nx, points[i].y + ny));
      right.push(new Phaser.Geom.Point(points[i].x - nx, points[i].y - ny));
    }

    g.fillStyle(color, alpha);
    g.fillPoints([...left, ...right.reverse()], true);

    // Rounded ends.
    g.fillCircle(points[0].x, points[0].y, (widths[0] + grow) / 2);
    const last = points.length - 1;
    g.fillCircle(points[last].x, points[last].y, (widths[last] + grow) / 2);
  }

  /** A soft marker where roads meet, sized by how busy the meeting is. */
  private drawJunctions(g: Phaser.GameObjects.Graphics): void {
    for (const node of this.world.network.nodes) {
      if (!node.isJunction || node.edges.length < 3) continue;

      const width = roadWidth(this.world.wear.at(node.position));
      g.fillStyle(COLORS.roadCasing, 0.28);
      g.fillCircle(node.position.x, node.position.y, width / 2 + 3.5);
      g.fillStyle(COLORS.road, 1);
      g.fillCircle(node.position.x, node.position.y, width / 2 + 0.5);
    }
  }

  private drawHighlight(): void {
    const g = this.highlightGfx;
    g.clear();

    const edge = this.highlight;
    if (!edge || !this.world.network.edges.includes(edge)) {
      this.highlight = null;
      return;
    }

    const shape = this.shapeFor(edge);
    const widths = Array.from(shape.widths, (w) => w + 7);
    this.ribbon(
      g,
      shape.samples,
      widths,
      0,
      this.highlightDanger ? COLORS.erase : COLORS.ink,
      this.highlightDanger ? 0.4 : 0.16,
    );
  }

  private drawPreview(): void {
    const g = this.previewGfx;
    g.clear();

    const preview = this.preview;
    if (!preview || preview.points.length < 2) return;

    const color = preview.valid ? COLORS.road : COLORS.ink;
    const alpha = preview.valid ? 0.5 : 0.18;

    g.lineStyle(6, color, alpha);
    g.beginPath();
    g.moveTo(preview.points[0].x, preview.points[0].y);
    for (const p of preview.points.slice(1)) g.lineTo(p.x, p.y);
    g.strokePath();

    if (preview.snap) {
      g.lineStyle(2, COLORS.roadCasing, 0.75);
      g.strokeCircle(preview.snap.x, preview.snap.y, 11);
    }
  }
}

/** Rolling average, so a road's edge is a curve rather than a staircase. */
function smooth(values: number[]): number[] {
  if (values.length < 3) return values;

  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const a = values[Math.max(0, i - 1)];
    const b = values[i];
    const c = values[Math.min(values.length - 1, i + 1)];
    out[i] = (a + 2 * b + c) / 4;
  }
  return out;
}
