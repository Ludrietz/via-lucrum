import Phaser from 'phaser';
import { cumulativeLengths, resamplePolyline, type Vec2 } from '../sim/geometry';
import type { GraphNode, RoadEdge } from '../sim/roadNetwork';
import type { World } from '../sim/world';
import { COLORS, DEPTH, roadCasingColor, roadCasingGrow, roadColor, roadWidth } from './theme';

export interface RoadPreview {
  points: Vec2[];
  valid: boolean;
  /** Where the road would attach, when the cursor is over something valid. */
  snap: Vec2 | null;
}

/** Distance between the points a road's width is measured at. */
const SAMPLE_SPACING = 15;
/** Samples per colour band, so a road can shade from paved to bare dirt along its own length. */
const COLOR_BAND = 3;
/** Wear moves slowly, so the widths only need refreshing a few times a second. */
const REFRESH_INTERVAL = 0.2;
/** How far the whole shadow layer is faded, once, after it is drawn opaquely. */
const CASING_ALPHA = 0.4;
/**
 * How far out from a junction the roads meeting there are gathered into one
 * mouth, as a multiple of the widest road's half-width.
 */
const MOUTH_REACH = 1.7;
/**
 * Over what distance a road's end flares to meet the junction it runs into,
 * and how much of the way it goes.
 *
 * A spur joining a highway should open out as it arrives — that flare is most
 * of what makes a junction read as one road *joining* another rather than two
 * ribbons crossing. It does not go all the way: a footpath meeting a highway
 * widens at its mouth, it does not become a highway.
 */
const TAPER_REACH = 46;
const TAPER_STRENGTH = 0.55;

interface EdgeShape {
  samples: Vec2[];
  cum: number[];
  widths: Float32Array;
  /** Which samples stand over water — the stretches that are bridges. */
  wet: boolean[];
}

/** Where one road meets a junction, and how wide it is when it gets there. */
interface Mouth {
  /** Unit vector pointing away from the node, along this road. */
  dir: Vec2;
  half: number;
  left: Vec2;
  right: Vec2;
}

/** The point `distance` along a polyline, or null if it is shorter than that. */
function pointAlong(points: Vec2[], distance: number): Vec2 | null {
  let walked = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const step = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (walked + step >= distance) {
      const t = step > 0 ? (distance - walked) / step : 0;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    walked += step;
  }
  return points.length >= 2 ? points[points.length - 1] : null;
}

/**
 * Draws the road network with a width that varies along each road, taken from
 * the wear packed into the ground beneath it. Where several roads run together
 * the shared corridor thickens into a highway; a spur off it stays a track.
 */
export class RoadLayer {
  private readonly casingGfx: Phaser.GameObjects.Graphics;
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
    // The shadow under the roads is its own object, and carries its softness
    // as the *object's* alpha rather than as an alpha on each shape it draws.
    //
    // That is the difference between a network and a plaid. Translucent shapes
    // composite with each other: two roads crossing stacked their shadows and
    // came out darker at the crossing, a fan of four roads out of a village
    // came out darker still, and every junction in the game wore a bruise that
    // got worse the more important the junction was. Drawn opaquely into one
    // object and faded once, overlapping shadows are simply the same shadow —
    // which is what a shadow is.
    this.casingGfx = scene.add.graphics().setDepth(DEPTH.roads - 0.5).setAlpha(CASING_ALPHA);
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
        widths: Float32Array.from(samples, (p) => roadWidth(this.world.traffic.wearAt(p))),
        // Terrain under a finished road never changes, so this is worked out
        // once with the rest of the shape rather than per frame.
        // Two kinds of water, and the renderer has to ask both. Lakes and sea
        // are wet *cells* in the terrain raster; a river is a line with a
        // width, narrower than a cell and so invisible to `isPassable` — which
        // meant the raster alone drew a bridge over every lake and not one over
        // any river in the game. See `RiverNetwork.widthAt`.
        wet: samples.map(
          (p) => !this.world.terrain.isPassable(p) || this.world.rivers.widthAt(p) > 0,
        ),
      };
      this.shapes.set(edge.id, shape);
    }
    return shape;
  }

  private stepWidths(dt: number): void {
    const k = 1 - Math.exp(-2.5 * dt);

    for (const edge of this.world.network.edges) {
      const shape = this.shapeFor(edge);
      const target = shape.samples.map((p) => roadWidth(this.world.traffic.wearAt(p)));
      this.flareIntoJunctions(edge, shape, target);
      const smoothed = smooth(target);

      for (let i = 0; i < shape.widths.length; i++) {
        shape.widths[i] += (smoothed[i] - shape.widths[i]) * k;
      }
    }
  }

  /**
   * Open a road out where it runs into a junction.
   *
   * Without this, a spur and the highway it joins simply abut, and the join
   * reads as a narrow ribbon laid across a wide one. Roads do not do that:
   * the minor one opens out at its mouth to meet the major one, and that
   * flare is most of what tells the eye which road is joining which.
   *
   * Only ever upward, and only part of the way. A road never *narrows* to
   * meet a quieter one — a highway does not pinch because a footpath joins it
   * — and a footpath meeting a highway widens at its mouth without becoming a
   * highway, which is what `TAPER_STRENGTH` short of 1 buys.
   */
  private flareIntoJunctions(edge: RoadEdge, shape: EdgeShape, target: number[]): void {
    const total = shape.cum[shape.cum.length - 1];

    for (const [node, fromStart] of [
      [edge.a, true],
      [edge.b, false],
    ] as const) {
      if (node.edges.length < 3) continue;

      const busiest = Math.max(
        ...node.edges.map((other) => roadWidth(this.world.traffic.wearAt(other.other(node).position))),
        roadWidth(this.world.traffic.wearAt(node.position)),
      );

      for (let i = 0; i < target.length; i++) {
        const distance = fromStart ? shape.cum[i] : total - shape.cum[i];
        if (distance > TAPER_REACH) continue;

        // Eased, not linear. A linear flare starts with a corner exactly where
        // it begins, and at fifteen units between samples that corner is a
        // visible notch in the side of the road rather than an opening out.
        const t = 1 - distance / TAPER_REACH;
        const closeness = t * t * (3 - 2 * t);
        const want = Math.max(target[i], busiest);
        target[i] += (want - target[i]) * closeness * TAPER_STRENGTH;
      }
    }
  }

  /**
   * The whole network, drawn in layers rather than road by road.
   *
   * Order is the entire design here. A road is a shadow, a surface, and —
   * where roads meet — a plate that gathers their mouths into one. Drawing
   * those three per road meant each road's shadow landed on the surface of
   * whichever road was drawn before it, and each junction plate landed under
   * roads drawn after it. Every crossing came out as a lattice of dark seams
   * and every fan of roads out of a village as a splatter of overlapping
   * ribbons, which is exactly what a road network is not.
   *
   * Laid down as four sweeps over the whole network — every shadow, then
   * every surface, then the bridges, then nothing else — roads that meet
   * simply become one shape, because they are one shape.
   */
  private draw(): void {
    const casing = this.casingGfx;
    const surface = this.gfx;
    casing.clear();
    surface.clear();

    const drawable: Array<{ shape: EdgeShape; count: number }> = [];
    for (const edge of this.world.network.edges) {
      const shape = this.shapeFor(edge);
      const count = this.visibleSamples(edge, shape);
      if (count >= 2) drawable.push({ shape, count });
    }

    for (const { shape, count } of drawable) this.ribbonPass(casing, shape, count, true);
    this.drawJunctionPlates(casing, true);

    for (const { shape, count } of drawable) this.ribbonPass(surface, shape, count, false);
    this.drawJunctionPlates(surface, false);

    // Bridges last: a bridge is the one thing here that is genuinely built
    // rather than worn, and it sits on top of the road it carries.
    for (const { shape, count } of drawable) this.drawBridges(surface, shape, count);
  }

  /**
   * A road drawn in short, overlapping bands rather than one flat fill, so
   * its colour can shade continuously with wear along its own length — dirt
   * where it's barely used, gravel and then paved grey where traffic has
   * packed it down — the same way its width already does per sample. Bands
   * share their boundary sample so they sit edge to edge with no seam, and
   * only the road's true start and end get a rounded cap.
   */
  private ribbonPass(
    g: Phaser.GameObjects.Graphics,
    shape: EdgeShape,
    count: number,
    shadow: boolean,
  ): void {
    for (let start = 0; start < count - 1; start += COLOR_BAND) {
      const end = Math.min(count - 1, start + COLOR_BAND);
      const points = shape.samples.slice(start, end + 1);
      if (points.length < 2) continue;

      let wearSum = 0;
      for (const p of points) wearSum += this.world.traffic.wearAt(p);
      const wear = wearSum / points.length;

      const capStart = start === 0;
      const capEnd = end === count - 1;

      // The shadow's width is taken per sample rather than per band. Colour
      // can step between bands without anyone noticing; an outline that steps
      // leaves a visible notch in the road's silhouette at every boundary.
      const widths = shadow
        ? points.map((p, i) => shape.widths[start + i] + roadCasingGrow(this.world.traffic.wearAt(p)))
        : Array.from(shape.widths.slice(start, end + 1));

      this.ribbon(g, points, widths, shadow ? roadCasingColor(wear) : roadColor(wear), capStart, capEnd);

      if (capEnd) break;
    }
  }


  /**
   * Draw the stretches where a road stands over water.
   *
   * Worth its own pass rather than a colour change, because a bridge is the
   * one piece of infrastructure in this game that is genuinely *built* rather
   * than worn into the ground, and it should read that way: a plank deck with
   * posts at each end, drawn the way the rest of the map draws made things.
   * Without it a road simply ignores a river on screen, which is exactly the
   * reading the mechanic is trying to correct — the crossing is the expensive,
   * deliberate part of the route and the eye should go to it.
   */
  private drawBridges(g: Phaser.GameObjects.Graphics, shape: EdgeShape, count: number): void {
    let start = -1;

    for (let i = 0; i < count; i++) {
      const wet = shape.wet[i];
      if (wet && start < 0) start = i;
      if ((!wet || i === count - 1) && start >= 0) {
        // One sample either side, so the deck lands on the bank rather than
        // stopping at the waterline.
        this.bridge(g, shape, Math.max(0, start - 1), Math.min(count - 1, wet ? i : i - 1 + 1));
        start = -1;
      }
    }
  }

  /** A plank deck between two banks, with a post at each end. */
  private bridge(g: Phaser.GameObjects.Graphics, shape: EdgeShape, from: number, to: number): void {
    if (to <= from) return;
    const points = shape.samples.slice(from, to + 1);
    if (points.length < 2) return;

    // Wide enough to carry the road that crosses it, whatever that road has
    // grown to — a highway must not spill over the sides of its own bridge.
    let carried = 0;
    for (let i = from; i <= to; i++) carried = Math.max(carried, shape.widths[i]);
    const deck = Math.max(9, carried + 4);

    // The deck itself: pale timber, a little wider than the road it carries.
    const widths = points.map(() => deck);
    const posts = points.map(() => deck + 3);
    g.setAlpha(0.55);
    this.ribbon(g, points, posts, COLORS.ink, true, true);
    g.setAlpha(1);
    this.ribbon(g, points, widths, COLORS.parchmentLight, true, true);

    // Planks across it, and posts at the ends.
    g.lineStyle(1.4, COLORS.ink, 0.45);
    for (let i = 0; i < points.length; i++) {
      const previous = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const ny = dx / length;
      const half = deck / 2;
      g.beginPath();
      g.moveTo(points[i].x - nx * half, points[i].y - ny * half);
      g.lineTo(points[i].x + nx * half, points[i].y + ny * half);
      g.strokePath();
    }

    g.fillStyle(COLORS.ink, 0.7);
    for (const end of [points[0], points[points.length - 1]]) {
      g.fillCircle(end.x, end.y, 2.4);
    }
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
    color: number,
    capStart = true,
    capEnd = true,
  ): void {
    const left: Phaser.Geom.Point[] = [];
    const right: Phaser.Geom.Point[] = [];

    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const half = widths[i] / 2;
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;

      left.push(new Phaser.Geom.Point(points[i].x + nx, points[i].y + ny));
      right.push(new Phaser.Geom.Point(points[i].x - nx, points[i].y - ny));
    }

    // Opaque, always. Faintness is carried by the colour and, for the shadow,
    // by the one alpha on the whole layer — see the constructor. A per-shape
    // alpha here is what made overlapping roads brighten and crossing shadows
    // darken, and no amount of draw ordering fixes that.
    g.fillStyle(color, 1);
    g.fillPoints([...left, ...right.reverse()], true);

    // Rounded ends — only where this band is the road's true start or end;
    // an interior band boundary butts flush against its neighbour instead.
    if (capStart) g.fillCircle(points[0].x, points[0].y, widths[0] / 2);
    if (capEnd) {
      const last = points.length - 1;
      g.fillCircle(points[last].x, points[last].y, widths[last] / 2);
    }
  }

  /** A soft marker where roads meet, sized by how busy the meeting is. */
  private drawJunctionPlates(g: Phaser.GameObjects.Graphics, shadow: boolean): void {
    for (const node of this.world.network.nodes) {
      if (node.edges.length < 3) continue;

      const wear = this.world.traffic.wearAt(node.position);
      const mouths = this.mouthsAt(node, shadow);
      if (mouths.length < 3) continue;

      const reach = Math.max(...mouths.map((m) => m.half));
      const polygon: Phaser.Geom.Point[] = [];

      for (let i = 0; i < mouths.length; i++) {
        const here = mouths[i];
        const next = mouths[(i + 1) % mouths.length];

        polygon.push(new Phaser.Geom.Point(here.right.x, here.right.y));
        polygon.push(new Phaser.Geom.Point(here.left.x, here.left.y));

        // The waist between this mouth and the next one round.
        const bx = here.dir.x + next.dir.x;
        const by = here.dir.y + next.dir.y;
        const blen = Math.hypot(bx, by);
        if (blen < 1e-3) continue; // Two roads dead opposite: no crotch to close.
        const pull = Math.min(here.half, next.half) * 0.9;
        polygon.push(
          new Phaser.Geom.Point(node.position.x + (bx / blen) * pull, node.position.y + (by / blen) * pull),
        );
      }

      g.fillStyle(shadow ? roadCasingColor(wear) : roadColor(wear), 1);
      g.fillPoints(polygon, true);
      // A small disc at the centre, so an awkward set of angles can never
      // leave a pinhole where the road should be continuous.
      g.fillCircle(node.position.x, node.position.y, reach * 0.55);
    }
  }

  /**
   * For each road leaving this node: which way it goes, and where the two
   * edges of its own width sit a short way along it.
   */
  private mouthsAt(node: GraphNode, shadow: boolean): Mouth[] {
    const grow = shadow ? roadCasingGrow(this.world.traffic.wearAt(node.position)) : 0;
    const widest = Math.max(...node.edges.map((edge) => this.widthAtNode(edge, node) + grow));
    const reach = (widest / 2) * MOUTH_REACH;

    const mouths: Mouth[] = [];
    for (const edge of node.edges) {
      if (!edge.isBuilt) continue;

      const at = pointAlong(edge.pointsFrom(node), reach);
      if (!at) continue;

      const dx = at.x - node.position.x;
      const dy = at.y - node.position.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) continue;
      const dir = { x: dx / len, y: dy / len };
      const half = (this.widthAtNode(edge, node) + grow) / 2;

      mouths.push({
        dir,
        half,
        left: { x: at.x - dir.y * half, y: at.y + dir.x * half },
        right: { x: at.x + dir.y * half, y: at.y - dir.x * half },
      });
    }

    // Angular order, so walking the list walks round the junction.
    mouths.sort((a, b) => Math.atan2(a.dir.y, a.dir.x) - Math.atan2(b.dir.y, b.dir.x));
    return mouths;
  }

  /** How wide a given road is where it arrives at a given node. */
  private widthAtNode(edge: RoadEdge, node: GraphNode): number {
    const shape = this.shapes.get(edge.id);
    if (!shape || shape.widths.length === 0) return roadWidth(this.world.traffic.wearAt(node.position));
    return edge.a === node ? shape.widths[0] : shape.widths[shape.widths.length - 1];
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
    g.setAlpha(this.highlightDanger ? 0.4 : 0.16);
    this.ribbon(g, shape.samples, widths, this.highlightDanger ? COLORS.erase : COLORS.ink);
  }

  private drawPreview(): void {
    const g = this.previewGfx;
    g.clear();

    const preview = this.preview;
    if (!preview || preview.points.length < 2) return;

    const trace = () => {
      g.beginPath();
      g.moveTo(preview.points[0].x, preview.points[0].y);
      for (const p of preview.points.slice(1)) g.lineTo(p.x, p.y);
      g.strokePath();
    };

    // The line the finished road will be: pale, over its own shadow, so a
    // valid preview reads against light fields as well as dark woodland.
    if (preview.valid) {
      g.lineStyle(9, COLORS.roadCasing, 0.3);
      trace();
      g.lineStyle(5, COLORS.road, 0.85);
      trace();
    } else {
      g.lineStyle(6, COLORS.ink, 0.18);
      trace();
    }

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
