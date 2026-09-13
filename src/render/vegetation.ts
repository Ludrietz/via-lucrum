import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import type { TerrainSource } from '../sim/source';
import {
  FOREST_MOISTURE_THRESHOLD,
  HILLS_LEVEL,
  MOUNTAIN_LEVEL,
  WATER_LEVEL,
  woodlandScore,
} from '../sim/terrain';
import { readSmooth } from './field';

/**
 * Woodland, drawn as trees rather than as green paint.
 *
 * Every tree here is a separate thing with a position, and that is the point.
 * Woodland is the one part of the landscape the simulation is meant to be
 * able to change — a settlement that grows clears the ground it grows onto, a
 * lumber camp thins the stand around it — and a felled wood has to be able to
 * *look* felled. Baking the canopy into the relief texture would have made
 * clearing a single acre mean repainting a whole chunk, so the map splits in
 * two: ground is baked and permanent, cover is live and removable.
 *
 * The cost of that is thousands of sprites on screen. It is paid with a
 * `Blitter`, which stamps any number of copies of one texture in a single
 * batched draw. A chunk of dense forest is one draw call, not two thousand.
 *
 * ## Why one atlas of fixed sizes
 *
 * A `Bob` — a Blitter's stamp — is deliberately minimal: it has a position, a
 * frame and a tint, and no transform of its own. That rules out scaling trees
 * individually, so size variation is baked instead, as a few discrete frames
 * per species. Three sizes turns out to be plenty; nobody reads a map and
 * notices that no tree is 7% larger than another.
 */

const ATLAS = 'veg:atlas';

const BROADLEAF_VARIANTS = 4;
const CONIFER_VARIANTS = 2;

/**
 * Displayed height of each size step, in world units.
 *
 * These are what set the *scale* the map reads at, and they are the most
 * sensitive numbers in this file. Trees that are too large turn a forest into
 * a few dozen cabbages; too small and a dense wood reads as texture noise and
 * you lose the sense that anything is growing there.
 */
const SIZE_STEPS = [13, 17, 22];

/**
 * Frames are drawn at this multiple of their displayed size and then scaled
 * back down, which buys the canopy that much zoom before it goes soft — worth
 * having, since the camera goes to 2.2x.
 *
 * The scaling has to happen on a `Container` wrapped round the Blitter, not
 * on the Blitter itself. A Blitter's renderer batches its bobs straight from
 * `blitter.x + bob.x` at raw frame size and never looks at its own transform,
 * so `blitter.setScale()` is silently ignored — trees came out at double size
 * and double spacing, spilling a chunk's worth of woodland out over the
 * neighbouring lake. A parent Container's matrix *is* applied, so that is
 * where the scale goes.
 */
const SUPERSAMPLE = 2;

/** Average spacing between candidate trees, in world units. */
const SPACING = 15;

/**
 * How far past the classifier's forest/plains line the wood has to be before
 * it stands at full thickness.
 *
 * This is the width of the treeline, in units of `woodlandScore`. Zero would
 * give a wood that stops dead at exactly the line the classifier draws — the
 * same hard edge as before, just at sub-cell resolution. Given a band, trees
 * instead thin out across it, and the eye stops being able to find the line
 * at all.
 */
const TREELINE_FADE = 0.22;

/**
 * How far *outside* the wood stray cover still appears. Hedgerow, thicket,
 * the odd self-seeded tree in a pasture — the things that stop open ground
 * from reading as a mown lawn, and that make the wood look like it is
 * spreading rather than fenced.
 */
const FRINGE_REACH = 0.3;

/**
 * The band of `forestDensity` over which a stand goes from sparse to closed.
 * Measured off the actual distribution the generator produces, which runs
 * roughly 0.05 to 0.7 on land and never reaches 1 — so normalising against
 * 0..1 would have made every wood look thin.
 */
const DENSITY_FLOOR = 0.2;
const DENSITY_CEILING = 0.62;

/** Thickest a closed canopy gets, as a fraction of candidate slots filled. */
const MAX_COVERAGE = 0.94;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------- atlas

interface FrameSpec {
  name: string;
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number) => void;
  seed: number;
}

function frameSpecs(): FrameSpec[] {
  const specs: FrameSpec[] = [];

  for (let v = 0; v < BROADLEAF_VARIANTS; v++) {
    for (let s = 0; s < SIZE_STEPS.length; s++) {
      const h = SIZE_STEPS[s] * SUPERSAMPLE;
      specs.push({ name: `b${v}s${s}`, width: Math.round(h * 1.05), height: h, draw: drawBroadleaf, seed: 0x1eaf + v });
    }
  }
  for (let v = 0; v < CONIFER_VARIANTS; v++) {
    for (let s = 0; s < SIZE_STEPS.length; s++) {
      const h = SIZE_STEPS[s] * SUPERSAMPLE * 1.15;
      specs.push({ name: `c${v}s${s}`, width: Math.round(h * 0.72), height: Math.round(h), draw: drawConifer, seed: 0xc0fe + v });
    }
  }
  for (let s = 0; s < SIZE_STEPS.length; s++) {
    const h = SIZE_STEPS[s] * SUPERSAMPLE * 0.55;
    specs.push({ name: `s0s${s}`, width: Math.round(h * 1.8), height: Math.round(h), draw: drawScrub, seed: 0x5c2b });
  }

  return specs;
}

/**
 * Draw the canopy set once per run, into one canvas texture.
 *
 * Generated rather than authored because there is no art pipeline on this
 * project yet, and a few lobes with a light side and a shadow side is most of
 * what a tree on a map at this scale actually is. Everything is lit from the
 * north-west so the canopy agrees with the hillshade under it — a stand of
 * trees lit from a different direction than the hill it grows on is the kind
 * of mismatch nobody can name but everybody sees. When drawn assets arrive,
 * this is the only part of the file that has to change.
 */
export function createVegetationTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists(ATLAS)) return;

  const specs = frameSpecs();
  const pad = 2;
  const width = specs.reduce((sum, s) => sum + s.width + pad, pad);
  const height = Math.max(...specs.map((s) => s.height)) + pad * 2;

  const texture = scene.textures.createCanvas(ATLAS, width, height)!;
  const ctx = texture.context;

  let x = pad;
  for (const spec of specs) {
    ctx.save();
    ctx.translate(x, pad);
    spec.draw(ctx, spec.width, spec.height, mulberry32(spec.seed));
    ctx.restore();
    texture.add(spec.name, 0, x, pad, spec.width, spec.height);
    x += spec.width + pad;
  }

  texture.refresh();
}

/**
 * A round canopy built from overlapping lobes. One circle reads as a dot;
 * four offset lobes read as foliage, and that is the whole difference.
 */
function drawBroadleaf(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number): void {
  const cx = w / 2;
  const r = h * 0.34;
  const cy = h - r * 1.15;

  // Deliberately wider than the crown above it. A wood has to read as a mass
  // at map zoom, not as a field of separate lollipops, and the usual way to
  // paint that — a dark green wash under the whole stand — is exactly the
  // thing that cannot be allowed here: it would be baked ground, and it would
  // survive the trees being felled, leaving a shadow of a wood that is no
  // longer there. Carrying the floor on the trees themselves means a cleared
  // wood clears completely, with nothing left to tidy up.
  ctx.fillStyle = 'rgba(44,58,36,0.5)';
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.22, h - r * 0.22, r * 1.25, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(70,46,30,0.9)';
  ctx.lineWidth = Math.max(1, h * 0.05);
  ctx.beginPath();
  ctx.moveTo(cx, h - r * 0.2);
  ctx.lineTo(cx, cy);
  ctx.stroke();

  ctx.fillStyle = '#3f5733';
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + rand() * 0.9;
    const dist = r * (0.26 + rand() * 0.3);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist * 0.75, r * (0.62 + rand() * 0.22), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(124,145,82,0.65)';
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.arc(cx - r * (0.22 + rand() * 0.18), cy - r * (0.32 + rand() * 0.2), r * (0.3 + rand() * 0.14), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawConifer(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number): void {
  const cx = w / 2;
  const base = h * 0.92;
  const top = h * 0.04;
  const halfWidth = w * (0.4 + rand() * 0.08);

  ctx.fillStyle = 'rgba(44,58,36,0.48)';
  ctx.beginPath();
  ctx.ellipse(cx + halfWidth * 0.25, base - halfWidth * 0.15, halfWidth * 1.2, halfWidth * 0.46, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(70,46,30,0.9)';
  ctx.lineWidth = Math.max(1, h * 0.045);
  ctx.beginPath();
  ctx.moveTo(cx, base);
  ctx.lineTo(cx, base - h * 0.25);
  ctx.stroke();

  // Three stacked skirts, each narrower than the one below it.
  for (let tier = 0; tier < 3; tier++) {
    const t = tier / 3;
    const y0 = base - h * 0.08 - (base - top) * t;
    const y1 = y0 - (base - top) * 0.46;
    const half = halfWidth * (1 - t * 0.5);

    ctx.fillStyle = tier === 2 ? '#40583a' : '#35492f';
    ctx.beginPath();
    ctx.moveTo(cx, y1);
    ctx.lineTo(cx - half, y0);
    ctx.lineTo(cx + half, y0);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(115,136,78,0.42)';
    ctx.beginPath();
    ctx.moveTo(cx, y1);
    ctx.lineTo(cx - half, y0);
    ctx.lineTo(cx - half * 0.15, y0);
    ctx.closePath();
    ctx.fill();
  }
}

/** Low cover for ground that is wooded but not woodland — hedge, gorse, thicket. */
function drawScrub(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number): void {
  ctx.fillStyle = 'rgba(94,108,64,0.75)';
  for (let i = 0; i < 3; i++) {
    const r = h * (0.4 + rand() * 0.28);
    ctx.beginPath();
    ctx.arc(w * (0.25 + i * 0.25) + (rand() - 0.5) * w * 0.1, h - r * 0.75, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------------ scatter

export interface Placement {
  /** Where the trunk meets the ground, in world units. */
  x: number;
  y: number;
  frame: string;
  width: number;
  height: number;
}

/** Frame dimensions, looked up once so scatter doesn't touch the texture manager per tree. */
function frameSizes(scene: Phaser.Scene): Map<string, { width: number; height: number }> {
  const texture = scene.textures.get(ATLAS);
  const sizes = new Map<string, { width: number; height: number }>();
  for (const name of texture.getFrameNames()) {
    const frame = texture.get(name);
    sizes.set(name, { width: frame.width, height: frame.height });
  }
  return sizes;
}

let cachedSizes: Map<string, { width: number; height: number }> | null = null;

/**
 * Where the trees of one patch of ground stand.
 *
 * A jittered grid rather than true Poisson-disc sampling: the jitter is
 * enough to destroy any visible lattice, and unlike Poisson it is stateless,
 * so a patch's trees follow from its coordinates alone and come out identical
 * every time. That determinism is what lets a chunk be thrown away when it
 * scrolls far out of view and rebuilt later unchanged.
 *
 * Acceptance is driven by `forestDensity`, which is continuous, so the edge of
 * a wood is not a line — it is where trees simply get sparse enough to stop.
 * Nothing anywhere decides where a forest "ends", which is why the boundary
 * wanders the way a real treeline does instead of tracing a cell edge.
 */
export function scatter(
  scene: Phaser.Scene,
  terrain: TerrainSource,
  originX: number,
  originY: number,
  size: number,
  seed: number,
): Placement[] {
  cachedSizes ??= frameSizes(scene);
  const sizes = cachedSizes;

  const rand = mulberry32((Math.imul(originX, 374_761_393) ^ Math.imul(originY, 668_265_263) ^ seed) >>> 0);
  const steps = Math.ceil(size / SPACING);
  const out: Placement[] = [];

  const push = (at: Vec2, frame: string): void => {
    const dims = sizes.get(frame)!;
    out.push({ x: at.x, y: at.y, frame, width: dims.width, height: dims.height });
  };

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const ramp = (lo: number, hi: number, v: number): number => {
    const t = clamp01((v - lo) / (hi - lo || 1e-6));
    return t * t * (3 - 2 * t);
  };

  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const at: Vec2 = {
        x: originX + (i + 0.5 + (rand() - 0.5) * 0.9) * SPACING,
        y: originY + (j + 0.5 + (rand() - 0.5) * 0.9) * SPACING,
      };
      // Drawn unconditionally, before anything can `continue`, so the random
      // stream advances identically whether or not this candidate survives.
      // Otherwise one rejected tree would shift every tree after it and the
      // scatter would stop being reproducible.
      const roll = rand();
      const pick = rand();
      const sizeRoll = rand();

      const ground = readSmooth(terrain, at.x, at.y);
      if (ground.elevation < WATER_LEVEL) continue;

      // The same question the classifier asks, asked at this tree's exact
      // position rather than at the middle of its cell. Above the threshold
      // is woodland; how far above is how deep into it we are.
      const margin = woodlandScore(ground.moisture, ground.temperature) - FOREST_MOISTURE_THRESHOLD;
      if (margin < -FRINGE_REACH) continue;

      // Thick canopy needs both: ground the classifier calls forest, and
      // ground fertile and damp enough to actually carry a stand. Density
      // alone was what put woods on the plains — it says how wooded ground
      // *could* be, not that it is a wood.
      const thickness = ramp(DENSITY_FLOOR, DENSITY_CEILING, ground.forestDensity);
      const inside = ramp(0, TREELINE_FADE, margin);
      const coverage = inside * thickness * MAX_COVERAGE;

      const step = Math.min(SIZE_STEPS.length - 1, Math.floor(sizeRoll * 3));

      if (roll > coverage) {
        // Outside the canopy, or in a gap in it. Scrub gets a thin second
        // chance, strongest just outside the treeline and petering out from
        // there, which is what gives a wood a ragged fringe instead of a hem.
        const fringe = (1 - inside * 0.7) * ramp(-FRINGE_REACH, TREELINE_FADE, margin) * thickness;
        if (roll > coverage + fringe * 0.22) continue;
        push(at, `s0s${step}`);
        continue;
      }

      // Bare rock carries scrub at most, whatever the moisture says.
      if (ground.elevation > MOUNTAIN_LEVEL) {
        push(at, `s0s${Math.min(1, step)}`);
        continue;
      }

      const conifer = ground.elevation > HILLS_LEVEL - 0.05 || ground.temperature < 0.32;
      const variant = Math.floor(pick * (conifer ? CONIFER_VARIANTS : BROADLEAF_VARIANTS));
      push(at, conifer ? `c${variant}s${step}` : `b${variant}s${step}`);
    }
  }


  // Painter's order: a tree lower down the map is nearer the viewer and has to
  // overlap the one behind it, or a dense stand reads as a flat pattern rather
  // than a canopy.
  out.sort((a, b) => a.y - b.y);
  return out;
}

// -------------------------------------------------------------------- stand

/**
 * One chunk's worth of woodland: the trees that stand there, and the batch
 * that draws them.
 *
 * The placements are the truth and the Blitter is only a view of them, which
 * is what makes felling cheap and honest — `fell` removes trees from the list
 * and restamps, and nothing outside has to know how the drawing works.
 */
export class Stand {
  private readonly root: Phaser.GameObjects.Container;
  private readonly blitter: Phaser.GameObjects.Blitter;
  private placements: Placement[];

  constructor(
    scene: Phaser.Scene,
    private readonly originX: number,
    private readonly originY: number,
    placements: Placement[],
    depth: number,
  ) {
    this.placements = placements;
    // The Blitter sits at the container's own origin and works entirely in
    // supersampled local units; the container carries the world position, the
    // scale and the depth. See `SUPERSAMPLE`.
    this.blitter = scene.make.blitter({ x: 0, y: 0, key: ATLAS }, false);
    this.root = scene.add
      .container(originX, originY, [this.blitter])
      .setScale(1 / SUPERSAMPLE)
      .setDepth(depth);
    this.stamp();
  }

  get count(): number {
    return this.placements.length;
  }

  setVisible(visible: boolean): void {
    this.root.setVisible(visible);
  }

  destroy(): void {
    this.root.destroy();
  }

  /**
   * Fell every tree within `radius` of a point. Returns how many fell, so a
   * caller can tell whether anything actually changed — restamping a chunk
   * nothing happened in is the one cost worth avoiding here, since a growing
   * settlement will ask this of its neighbours constantly.
   */
  fell(centre: Vec2, radius: number): number {
    const r2 = radius * radius;
    const kept = this.placements.filter((p) => {
      const dx = p.x - centre.x;
      const dy = p.y - centre.y;
      return dx * dx + dy * dy > r2;
    });

    const felled = this.placements.length - kept.length;
    if (felled === 0) return 0;

    this.placements = kept;
    this.stamp();
    return felled;
  }

  /**
   * Bob coordinates are local to the Blitter and in supersampled units, and a
   * frame is stamped from its top-left corner — so each tree is offset half
   * its width left and its full height up, which puts the point it was
   * scattered at under the base of its trunk rather than in the middle of its
   * canopy. Getting that wrong makes trees float uphill of where they grow.
   */
  private stamp(): void {
    this.blitter.clear();
    for (const p of this.placements) {
      this.blitter.create(
        (p.x - this.originX) * SUPERSAMPLE - p.width / 2,
        (p.y - this.originY) * SUPERSAMPLE - p.height,
        p.frame,
      );
    }
  }
}
