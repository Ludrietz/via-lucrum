import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import type { River } from '../sim/river';
import type { World } from '../sim/world';
import { catmullRom } from './field';
import { readSmooth } from './field';
import { bankTone, mixHex, WATER } from './land';
import { traceContours } from './marchingSquares';
import { WATER_LEVEL } from '../sim/terrain';
import { DEPTH } from './theme';
import { WaveOverlay } from './waterPattern';

/**
 * Watercourses, drawn as water in the landscape rather than as lines over it.
 *
 * A river here is finally the width it actually is — five metres at its head,
 * forty at the town — because it is stored as a line carrying its own width
 * (see `RiverNetwork`) instead of as a stripe of terrain cells that could
 * never be narrower than two of them.
 *
 * ## Why this is not a stroked path
 *
 * The obvious drawing of a polyline is to stroke it, and the first version
 * did: one flat blue line with a darker line under it for the bank. It was
 * the right width and it looked stuck on, for three reasons that are worth
 * separating because only one of them is about colour.
 *
 * A stroke has a hard edge. Every other boundary on this map is blended —
 * the coastline is antialiased against distance, region colours cross over
 * wide bands, the canopy fades out — so a crisp outline is the one thing on
 * screen that announces it was drawn by a different hand. Water is given the
 * same treatment as everything else here: a pale shore rim fading outward,
 * the way the ground bake already paints a lake edge.
 *
 * A stroke has the geometry of its data. The traced centreline is a handful
 * of points with corners between them, and stroking it draws exactly those
 * corners; a river does not have corners. The centreline is resampled through
 * the same Catmull-Rom used to reconstruct the terrain surface, so what gets
 * drawn is the smooth curve the points were samples *of*.
 *
 * And a stroke of varying width has to be built segment by segment, which
 * leaves a seam at every joint the moment it is drawn at anything but full
 * alpha. Filling a ribbon — one polygon per river, built from the centreline
 * and its half-widths — has no joints in it at all, which is what makes the
 * soft rim possible.
 */

/** Thinnest the water may draw, in screen pixels — the width of the pen. */
const MIN_SCREEN_WIDTH = 1.4;

/**
 * How far the shore rim reaches past the water, in screen pixels.
 *
 * In screen pixels rather than world units on purpose. This is a drawing
 * convention, not a feature of the ground — it is the pen easing off, and it
 * should look the same at every zoom rather than swelling into a sandbank
 * when the map is pulled back.
 */
const RIM_SCREEN_WIDTH = 2.2;

/**
 * Curve samples per traced segment.
 *
 * Three, not because the frame needs it — it does not, and that is worth
 * recording. This was lowered from six on the theory that the ribbons' forty
 * thousand vertices were what made this layer cost fifty milliseconds a frame.
 * Halving them changed the figure not at all: a Phaser `Graphics` re-walks its
 * whole command list every frame, and the cost is in the eight hundred
 * separate fill commands, not in the vertices inside them. See the note on
 * `draw`.
 *
 * It stays at three because three is where the curve stops visibly having
 * corners in it — the traced points are already dense enough to carry the
 * shape — and there is no reason to spend twice the geometry for a smoothness
 * nobody can find.
 */
const SMOOTHING = 3;

/**
 * Narrowest water that carries ripple hatching, in world units.
 *
 * A cartographer does not hatch a brook; a brook is drawn as a line, and the
 * hatching starts once there is enough water to put a mark inside. Doing the
 * same here is not only more faithful, it is the difference between a river
 * that reads as water and one that reads as serrated — a wave whose amplitude
 * is most of the channel's width wriggles from bank to bank and turns a
 * thirteen-metre stream into a saw blade.
 *
 * It also cuts the work: narrow watercourses are most of the map's water by
 * count, and every one left out is one fewer shape in the stencil.
 */
const RIPPLE_MIN_WIDTH = 11;

/** Redraw only when the zoom has actually moved enough to change a width. */
const ZOOM_EPSILON = 0.002;

interface Body {
  /** Shore outline, and the same outline shrunk for each inner band. */
  rings: Vec2[][];
  bands: number[];
}

interface Course {
  points: Vec2[];
  halfWidths: number[];
  /** The broadest this watercourse gets, in world units — see `RIPPLE_MIN_WIDTH`. */
  widest: number;
  /** Opaque band colours for this watercourse, outermost first. See `bankTone`. */
  bands: number[];
}

export class RiverLayer {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly waves: WaveOverlay;
  private readonly courses: Course[];
  private readonly bodies: Body[];
  private drawnAtZoom = -1;

  constructor(scene: Phaser.Scene, world: World) {
    this.courses = world.rivers.rivers.map((river) => resample(river, world));
    // Gated on the same flag the ground bake reads, and it has to be: exactly
    // one of the two draws the water, and if this traced while the bake was
    // also painting, every lake would be drawn twice. A procedural world says
    // no here — its water is elevation below a line, which the bake already
    // paints seamlessly across an endless map, and tracing it would mean
    // walking a forty-thousand-unit square at load and generating every chunk
    // of terrain in it to do so. Measured at 463 bodies and the whole world
    // generated before the first frame.
    this.bodies = world.rivers.drawsOwnWater
      ? traceWaterBodies(world).map((points) => shrinkRings(points, world))
      : [];
    this.gfx = scene.add.graphics().setDepth(DEPTH.rivers);
    this.waves = new WaveOverlay(scene, DEPTH.waterPattern);
  }

  update(camera: Phaser.Cameras.Scene2D.Camera): void {
    if (this.courses.length === 0 && this.bodies.length === 0) return;

    // The ripples have to follow the camera every frame, even when the water
    // itself has not been redrawn — they are a window onto a fixed sheet of
    // pattern, and the window moves whenever the view does.
    this.waves.update(camera);

    if (Math.abs(camera.zoom - this.drawnAtZoom) < ZOOM_EPSILON) return;
    this.drawnAtZoom = camera.zoom;
    this.draw(camera.zoom);
  }

  /**
   * Rebuild the water, which happens only when the zoom changes.
   *
   * "Only when the zoom changes" is about the *command list*, not about what
   * the frame costs. Phaser walks a `Graphics` object's whole command list and
   * re-triangulates every filled shape on every single frame, so the eight
   * hundred fills below — ninety-odd pieces of water in four bands each — are
   * paid for sixty times a second whether anything moved or not. Measured on
   * the Kuttenberg map, that is fifty-seven milliseconds a frame, against ten
   * for the entire rest of the scene.
   *
   * That is the layer's real performance problem and it is not fixed here.
   * Fixing it means not re-triangulating: either caching the triangles and
   * submitting them as a mesh, or culling to the view and dropping detail at
   * low zoom. Both are more than this pass, and neither is served by shaving
   * vertices — the cost scales with the number of fills, not their size.
   */
  private draw(zoom: number): void {
    this.gfx.clear();

    const scale = 1 / Math.max(zoom, 0.001);
    const floor = (MIN_SCREEN_WIDTH * scale) / 2;
    const rim = RIM_SCREEN_WIDTH * scale;

    // Outward in, and every pass opaque.
    //
    // These used to be translucent, which gave a lovely soft rim and a dark
    // bruise at every confluence: where two watercourses overlap, a
    // semi-transparent band is composited twice and comes out twice as
    // strong. Alpha has to be applied to the *union* of the water, and there
    // is no cheap way to union these polygons — so instead nothing is
    // translucent, and each band is given a colour that already accounts for
    // the ground beneath it (`bankTone`). Painting an opaque colour over
    // itself changes nothing, so a confluence, a crossing, or a river running
    // into a pond all come out exactly the shade of a single stretch.
    // Each band is a fraction of the water's own width plus a fixed outset,
    // so the channel down the middle stays proportional on a brook and on a
    // river instead of being a constant inset that swallows the one and
    // vanishes on the other.
    const bands: Array<{ scale: number; grow: number }> = [
      { scale: 1, grow: rim },
      { scale: 1, grow: rim * 0.55 },
      { scale: 1, grow: 0 },
      { scale: 0.5, grow: 0 },
    ];

    // Band 2 is the water itself; the two before it are bank and the one
    // after is the deeper channel inside it. The ripples show through exactly
    // that band, which is why it is collected here rather than recomputed.
    const wet: Vec2[][] = [];

    for (let band = 0; band < bands.length; band++) {
      // Bodies and watercourses in the same pass and the same bands, which is
      // the whole point: a stream running into a pond is one colour crossing
      // one outline, not a line of one substance meeting a blob of another.
      for (const body of this.bodies) {
        const ring = body.rings[band];
        if (ring.length < 3) continue;
        this.gfx.fillStyle(body.bands[band], 1);
        this.gfx.fillPoints(ring, true);
        if (band === 2) wet.push(ring);
      }

      for (const course of this.courses) {
        const ribbon = outline(course, floor, bands[band]);
        if (ribbon.length < 3) continue;
        this.gfx.fillStyle(course.bands[band], 1);
        this.gfx.fillPoints(ribbon, true);
        if (band === 2 && course.widest >= RIPPLE_MIN_WIDTH) wet.push(ribbon);
      }
    }

    this.waves.setShapes(wet);
  }
}

/**
 * How finely the shore is traced, in world units. Fine enough that a pond a
 * couple of cells across still comes out as a curve.
 */
const SHORE_TRACE_STEP = 8;

/** Discard traced loops smaller than this many world units across — sampling noise, not ponds. */
const MIN_BODY_SPAN = 12;

/**
 * The outlines of every body of water on the map, traced from the terrain
 * itself rather than carried in the map file.
 *
 * The shape is already in the raster, so a second copy of it in the pack
 * would be a second thing to keep in step — and an earlier attempt to write
 * one at import time produced degenerate loops that drew as blue shards.
 * Tracing here instead uses the contour tracer the influence borders already
 * use, over the same bicubic reconstruction the ground bake shades with, so
 * the shoreline drawn is by construction the shoreline the bake would have
 * painted, and there is only ever one description of where the water is.
 *
 * Traced once, over the whole map, at load. That is only affordable because a
 * pack is finite; a procedural world has no rivers and so never gets here,
 * and if one ever does this will have to become per-chunk with the seam
 * problem that implies.
 */
function traceWaterBodies(world: World): Vec2[][] {
  // Positive inside the water, so the contour at zero is the waterline.
  const wetness = (x: number, y: number): number => WATER_LEVEL - readSmooth(world.terrain, x, y).elevation;

  const loops = traceContours(
    { x0: 0, y0: 0, x1: world.width, y1: world.height },
    SHORE_TRACE_STEP,
    0,
    wetness,
  );

  return loops.filter((loop) => {
    if (loop.length < 3) return false;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const q of loop) {
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    return Math.max(maxX - minX, maxY - minY) >= MIN_BODY_SPAN;
  });
}

/**
 * Bands for an areal body: the shore outline, then the same outline stepped
 * inward for each inner band.
 *
 * Inset by moving every vertex along its own inward normal, which is crude —
 * it will cross itself on a shape narrow enough — and entirely sufficient
 * here, where the steps are a couple of screen pixels and the shapes are
 * ponds. The rim bands are what make a pond meet the ground the same way a
 * river does; without them a filled outline is a flat blue shape, which is
 * precisely the "drawn on" look this layer exists to avoid.
 */
function shrinkRings(outlinePoints: Vec2[], world: World): Body {
  const middle = outlinePoints[Math.floor(outlinePoints.length / 2)] ?? { x: 0, y: 0 };
  const ground = readSmooth(world.terrain, middle.x, middle.y);
  const bands = [
    bankTone(ground.elevation, ground.moisture, 0),
    bankTone(ground.elevation, ground.moisture, 0.55),
    WATER.shallow,
    mixHex(WATER.shallow, WATER.deep, 0.3),
  ];

  const centre = outlinePoints.reduce(
    (acc, q) => ({ x: acc.x + q.x / outlinePoints.length, y: acc.y + q.y / outlinePoints.length }),
    { x: 0, y: 0 },
  );

  // Fractions of the way from the shore towards the middle, band by band.
  const insets = [0, 0.1, 0.2, 0.5];
  const rings = insets.map((inset) =>
    outlinePoints.map((q) => ({
      x: q.x + (centre.x - q.x) * inset,
      y: q.y + (centre.y - q.y) * inset,
    })),
  );

  return { rings, bands };
}

/**
 * Resample a traced centreline into a smooth curve, carrying the widths
 * through the same interpolation so a river widens gradually instead of in
 * steps at the points it happened to be sampled at.
 */
function resample(river: River, world: World): Course {
  const source = river.points;
  // Sampled once, at the middle of the watercourse: the bands are opaque, so
  // they cannot vary along its length without showing a seam, and a rim two
  // screen pixels wide has no room to say anything subtler anyway.
  const middle = source[Math.floor(source.length / 2)] ?? { x: 0, y: 0 };
  const ground = readSmooth(world.terrain, middle.x, middle.y);
  const bands = [
    bankTone(ground.elevation, ground.moisture, 0),
    bankTone(ground.elevation, ground.moisture, 0.55),
    WATER.shallow,
    // Not `WATER.deep` itself: that is the colour of open water metres down,
    // and a brook painted with it reads as a crevasse. Just far enough
    // towards it that the middle of the channel is visibly the deepest part.
    mixHex(WATER.shallow, WATER.deep, 0.3),
  ];

  if (source.length < 2) {
    const halves = river.widths.map((w) => w / 2);
    return { points: [...source], halfWidths: halves, bands, widest: Math.max(0, ...halves) * 2 };
  }

  const at = (i: number): Vec2 => source[Math.max(0, Math.min(source.length - 1, i))];
  const widthAt = (i: number): number => river.widths[Math.max(0, Math.min(river.widths.length - 1, i))];

  const points: Vec2[] = [];
  const halfWidths: number[] = [];

  for (let i = 0; i + 1 < source.length; i++) {
    for (let step = 0; step < SMOOTHING; step++) {
      const t = step / SMOOTHING;
      points.push({
        x: catmullRom(at(i - 1).x, at(i).x, at(i + 1).x, at(i + 2).x, t),
        y: catmullRom(at(i - 1).y, at(i).y, at(i + 1).y, at(i + 2).y, t),
      });
      halfWidths.push(
        catmullRom(widthAt(i - 1), widthAt(i), widthAt(i + 1), widthAt(i + 2), t) / 2,
      );
    }
  }

  points.push(at(source.length - 1));
  halfWidths.push(widthAt(source.length - 1) / 2);
  return { points, halfWidths, bands, widest: Math.max(...halfWidths) * 2 };
}

/**
 * The outline of the water as one closed polygon: down one bank and back up
 * the other.
 *
 * `band` scales the water's own half-width and then adds a fixed outset,
 * which is how every band is built without recomputing the curve. `floor` is
 * the minimum half-width, so a brook too narrow to see is still drawn at the
 * width of the pen.
 */
function outline(course: Course, floor: number, band: { scale: number; grow: number }): Vec2[] {
  const { points, halfWidths } = course;
  if (points.length < 2) return [];

  const half = (i: number): number => Math.max(floor * band.scale, halfWidths[i] * band.scale + band.grow);

  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const heading: number[] = [];

  for (let i = 0; i < points.length; i++) {
    const before = points[Math.max(0, i - 1)];
    const after = points[Math.min(points.length - 1, i + 1)];
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    // Normal to the direction of flow. Averaging the neighbours' direction
    // rather than one segment's keeps the banks parallel round a bend.
    const nx = -dy / length;
    const ny = dx / length;
    heading.push(Math.atan2(dy, dx));

    left.push({ x: points[i].x + nx * half(i), y: points[i].y + ny * half(i) });
    right.push({ x: points[i].x - nx * half(i), y: points[i].y - ny * half(i) });
  }

  const last = points.length - 1;
  return [
    ...left,
    ...cap(points[last], half(last), heading[last]),
    ...right.reverse(),
    ...cap(points[0], half(0), heading[0] + Math.PI),
  ];
}

/** Points per end cap. Six is past the point where an eye finds the corners. */
const CAP_SEGMENTS = 7;

/**
 * A half-circle closing off one end of the ribbon, bulging outward along
 * `facing`.
 *
 * Not a nicety. A skeleton stops short of the water it describes — thinning a
 * pond down to its centreline leaves a stub a radius shy of the bank at each
 * end — so the ends have to be pushed back out or the water is cut off before
 * it finishes. Pushing them out *flat* is worse than leaving them: a round
 * pond whose centreline is two points then draws as a rectangle, which was
 * the single most obviously drawn-on thing on the map. Rounding them puts the
 * pond back as a pond and softens every river's end into the bargain.
 */
function cap(centre: Vec2, radius: number, facing: number): Vec2[] {
  const arc: Vec2[] = [];
  for (let i = 1; i < CAP_SEGMENTS; i++) {
    const angle = facing - Math.PI / 2 + (Math.PI * i) / CAP_SEGMENTS;
    arc.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
  }
  return arc;
}
