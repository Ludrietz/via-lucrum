import Phaser from 'phaser';
import { resamplePolyline, type Vec2 } from '../sim/geometry';
import type { RoadEdge } from '../sim/roadNetwork';
import { TERRAIN_CHUNK_SIZE } from '../sim/terrain';
import type { World } from '../sim/world';
import { bakeRelief } from './relief';
import { DEPTH, roadClearing } from './theme';
import { createVegetationTextures, scatter, Stand } from './vegetation';

/**
 * The landscape, built one generated chunk at a time.
 *
 * There is no upfront "draw the whole map" pass — there is no whole map, only
 * whatever ground the simulation has actually uncovered (see `TerrainField`
 * and `World.uncoverGround`) — so this layer watches for newly uncovered
 * chunks and turns each one into a piece of drawn landscape the moment it
 * appears.
 *
 * ## Two layers, split by what can change
 *
 * The ground is painted once into a texture (`relief.ts`) and then left
 * alone, because everything in it follows from elevation and moisture and
 * neither of those ever changes: hills are not felled and rivers do not move.
 * The cover on top of it (`vegetation.ts`) is kept as live, individually
 * addressable trees, because that is precisely the part the simulation is
 * meant to be able to change — a settlement that grows clears the woodland it
 * grows into.
 *
 * Baking the lot would have been simpler and would have meant that clearing
 * one acre repainted a county. Baking none of it would have meant paying the
 * full cost of the landscape every frame forever, for a landscape that is
 * almost entirely static. The split gets both.
 */

interface Chunk {
  relief: Phaser.GameObjects.Image;
  stand: Stand;
  bounds: Phaser.Geom.Rectangle;
}

interface Ground {
  cx: number;
  cy: number;
  relief: Phaser.GameObjects.Image;
}

/** One felling: everything within `radius` of this point comes down. */
interface Cut {
  x: number;
  y: number;
  radius: number;
}

/**
 * The swathe one road has cut through the woods it passes through.
 *
 * `cut[i]` is how far back the trees have already been pushed at sample `i`,
 * and it only ever grows. That monotonicity is the whole design, not an
 * optimisation: wear rises and falls, and a corridor that tracked it in both
 * directions would have trees blinking back into a road every time a quiet
 * afternoon let the ruts fade. Felling is one-way in the world and it is
 * one-way here, so what the player sees is the high-water mark of how busy
 * this road has ever been — which is also the honest reading of a clearing.
 */
interface Corridor {
  samples: Vec2[];
  cut: Float32Array;
  /**
   * A per-sample multiplier on how far back the trees go, so the edge of the
   * clearing wanders instead of being ruled parallel to the road.
   *
   * A corridor of equal-radius circles down a straight road gives a treeline
   * straighter than anything else on the map, which reads as a stencil laid
   * over the wood rather than as ground that was cleared. Everywhere else the
   * boundary of a wood is where some continuous field happens to cross and
   * nobody drew it (see `scatter`); this is the cheapest way to give the one
   * boundary that *is* drawn the same manners. Taken from the sample's
   * position, so it is stable — a wobble that changed between passes would
   * ratchet the corridor out to its widest possible radius over time, since
   * the cut only ever grows.
   */
  wobble: Float32Array;
}

/** Distance between the points a corridor's width is measured at. */
const CORRIDOR_SAMPLE_SPACING = 12;
/**
 * How much a corridor has to have outgrown its last cut before it is worth
 * felling again. Below this the only effect would be to restamp chunks for a
 * change nobody can see.
 */
const CUT_STEP = 1.5;
/** Wear moves slowly, so corridors only need revisiting a few times a second. */
const CORRIDOR_INTERVAL = 0.25;
/** How far either side of its nominal width a clearing's edge is allowed to wander. */
const WOBBLE_LOW = 0.78;
const WOBBLE_SPAN = 0.44;

/**
 * A stable 0-1 value for a point on the ground, smooth enough over a few
 * samples that the treeline undulates rather than shivering tree by tree.
 */
function wobbleAt(p: Vec2): number {
  const x = p.x / 70;
  const y = p.y / 70;
  return (Math.sin(x * 1.7 + Math.cos(y * 0.9) * 2.3) * 0.5 + 0.5 + Math.sin(y * 2.1) * 0.25 + 0.25) / 1.5;
}

/**
 * Building a chunk is two separate jobs of comparable cost — painting the
 * ground, and working out where its trees stand — and uncovering is bursty: a
 * single expansion can reveal a dozen chunks at once. Doing a whole chunk in
 * one frame meant paying for both at once and dropping a frame every time the
 * realm grew.
 *
 * So each frame does one job, not one chunk, and alternates which queue it
 * takes from. Alternating rather than draining the ground first matters: under
 * sustained expansion a strict priority would starve the other queue
 * completely, and the map would fill in as bare painted ground with the woods
 * arriving minutes later. Taking turns means both queues drain at worst half
 * speed, and a chunk is never left half-built for long.
 */
export class TerrainLayer {
  private readonly chunks = new Map<string, Chunk>();
  /** Uncovered ground not yet painted, oldest first. */
  private readonly needGround: Array<{ cx: number; cy: number }> = [];
  /** Painted ground not yet planted, oldest first. */
  private readonly needTrees: Ground[] = [];
  /** Which queue had the last turn, so neither can starve the other. */
  private plantedLast = false;
  /** The swathe each road has cut through the trees, by edge id. */
  private readonly corridors = new Map<number, Corridor>();
  private sinceCorridors = CORRIDOR_INTERVAL;

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {
    createVegetationTextures(scene);
    this.update(0);
  }

  /**
   * Take on newly uncovered ground, paint some of it, and hide whatever the
   * camera can't see. Phaser skips invisible objects entirely, which is what
   * keeps an unbounded world affordable: however far the civilisation has
   * spread, only the chunks actually on screen are ever drawn.
   */
  update(dt: number): void {
    for (const chunk of this.world.drainUncoveredChunks()) this.needGround.push(chunk);

    if (this.plantedLast ? !this.paintGround() : !this.plantTrees()) {
      // Preferred queue was empty, so take the other one rather than idle.
      if (this.plantedLast) this.plantTrees();
      else this.paintGround();
    }
    this.plantedLast = !this.plantedLast;

    this.sinceCorridors += dt;
    if (this.sinceCorridors >= CORRIDOR_INTERVAL) {
      this.widenCorridors();
      this.sinceCorridors = 0;
    }

    const view = this.scene.cameras.main.worldView;
    for (const chunk of this.chunks.values()) {
      const visible = Phaser.Geom.Rectangle.Overlaps(view, chunk.bounds);
      chunk.relief.setVisible(visible);
      chunk.stand.setVisible(visible);
    }
  }

  /**
   * Clear woodland from a patch of ground — what a settlement does to the
   * trees where it is about to stand.
   *
   * Lives here rather than in `vegetation.ts` because only this layer knows
   * which chunks a patch of ground falls in, and a clearing near a chunk
   * corner has to reach into all four of them. Chunks that have not been
   * painted yet need no special handling: their trees are scattered from the
   * terrain when they are eventually built, so ground the simulation cleared
   * before anyone looked at it comes up already clear only if the *terrain*
   * says so. Clearing is presentation, and a settlement that outruns the
   * renderer is a problem worth having before this matters.
   */
  fellTrees(centre: Vec2, radius: number): number {
    return this.applyCuts([{ x: centre.x, y: centre.y, radius }]);
  }

  /**
   * Fell for a whole list of cuts at once, grouped so no chunk is restamped
   * more than once however many cuts land in it. See `Stand.fellAlong` for
   * why that grouping is the difference between a road through a wood being
   * free and being a stall.
   */
  private applyCuts(cuts: readonly Cut[]): number {
    if (cuts.length === 0) return 0;

    const size = TERRAIN_CHUNK_SIZE;
    const byChunk = new Map<string, Cut[]>();

    for (const cut of cuts) {
      for (let cy = Math.floor((cut.y - cut.radius) / size); cy <= Math.floor((cut.y + cut.radius) / size); cy++) {
        for (let cx = Math.floor((cut.x - cut.radius) / size); cx <= Math.floor((cut.x + cut.radius) / size); cx++) {
          const key = `${cx},${cy}`;
          if (!this.chunks.has(key)) continue;
          const list = byChunk.get(key);
          if (list) list.push(cut);
          else byChunk.set(key, [cut]);
        }
      }
    }

    let felled = 0;
    for (const [key, chunkCuts] of byChunk) felled += this.chunks.get(key)!.stand.fellAlong(chunkCuts);
    return felled;
  }

  /**
   * Push the trees back along every road to whatever its traffic now
   * justifies — the pass that turns a track through a wood into a cut one.
   *
   * Only the growth is acted on: a sample whose corridor is already as wide
   * as its wear calls for costs a wear lookup and a comparison, which is why
   * this can afford to walk the whole network on a timer. Once a road settles
   * down, this does nothing at all.
   */
  private widenCorridors(): void {
    const cuts: Cut[] = [];

    for (const edge of this.world.network.edges) {
      // Nothing is felled for a road still drawing itself in. The clearing
      // belongs to the finished road, and cutting it while the line is still
      // animating across the map has the trees come down ahead of the thing
      // taking them down.
      if (edge.buildProgress < 1) continue;

      const corridor = this.corridorFor(edge);
      for (let i = 0; i < corridor.samples.length; i++) {
        const point = corridor.samples[i];
        const wanted = roadClearing(this.world.traffic.wearAt(point)) * corridor.wobble[i];
        if (wanted <= corridor.cut[i] + CUT_STEP) continue;

        corridor.cut[i] = wanted;
        cuts.push({ x: point.x, y: point.y, radius: wanted });
      }
    }

    this.applyCuts(cuts);
    this.forgetRemovedCorridors();
  }

  private corridorFor(edge: RoadEdge): Corridor {
    let corridor = this.corridors.get(edge.id);
    if (!corridor) {
      const samples = resamplePolyline(edge.points, CORRIDOR_SAMPLE_SPACING);
      corridor = {
        samples,
        cut: new Float32Array(samples.length),
        wobble: Float32Array.from(samples, (p) => WOBBLE_LOW + WOBBLE_SPAN * wobbleAt(p)),
      };
      this.corridors.set(edge.id, corridor);
    }
    return corridor;
  }

  /**
   * Retire the corridors of roads that are gone.
   *
   * The clearing itself stays: the trees are down, and nothing in this game
   * grows them back. A road that is abandoned leaves its swathe behind it,
   * which is what happens to real roads and is a good deal better than the
   * alternative of a wood springing up the instant a route falls out of use.
   */
  private forgetRemovedCorridors(): void {
    if (this.corridors.size === this.world.network.edges.length) return;

    const live = new Set(this.world.network.edges.map((e) => e.id));
    for (const id of [...this.corridors.keys()]) {
      if (!live.has(id)) this.corridors.delete(id);
    }
  }

  /**
   * Cut the corridors that already exist through a chunk that has only just
   * been planted.
   *
   * Without this a road laid across ground the player had not yet uncovered
   * would grow a full wood back over itself the moment that ground was
   * revealed — the corridor pass would see its cuts already recorded as made
   * and leave the new trees standing in the road.
   */
  private cutCorridorsThrough(chunk: Chunk): void {
    const cuts: Cut[] = [];

    for (const corridor of this.corridors.values()) {
      for (let i = 0; i < corridor.samples.length; i++) {
        const radius = corridor.cut[i];
        if (radius <= 0) continue;

        const { x, y } = corridor.samples[i];
        if (x + radius < chunk.bounds.x || x - radius > chunk.bounds.right) continue;
        if (y + radius < chunk.bounds.y || y - radius > chunk.bounds.bottom) continue;
        cuts.push({ x, y, radius });
      }
    }

    chunk.stand.fellAlong(cuts);
  }

  /** Paint one chunk's ground. Returns false if there was none waiting. */
  private paintGround(): boolean {
    const next = this.needGround.shift();
    if (!next) return false;

    const { cx, cy } = next;
    if (this.chunks.has(`${cx},${cy}`)) return true;

    const { key, texelSize, bleed } = bakeRelief(this.scene, this.world.terrain, cx, cy, this.world.rivers.drawsOwnWater);
    const relief = this.scene.add
      // Offset by the bleed, so the chunk's own ground still lands exactly on
      // its own square and only the overlap spills onto its neighbours.
      .image(cx * TERRAIN_CHUNK_SIZE - bleed, cy * TERRAIN_CHUNK_SIZE - bleed, key)
      .setOrigin(0, 0)
      // The texture is deliberately coarser than the screen — the ground it
      // paints is soft-edged and has nothing in it that wants to be crisp, so
      // letting the GPU stretch it smoothly costs nothing and saves the memory
      // that painting at screen resolution would have eaten. Sharpness in this
      // map comes from the canopy and the linework on top, exactly as it does
      // on a real painted one.
      .setScale(texelSize)
      .setDepth(DEPTH.terrain);

    this.needTrees.push({ cx, cy, relief });
    return true;
  }

  /** Plant one chunk's trees. Returns false if there was none waiting. */
  private plantTrees(): boolean {
    const next = this.needTrees.shift();
    if (!next) return false;

    const { cx, cy, relief } = next;
    const originX = cx * TERRAIN_CHUNK_SIZE;
    const originY = cy * TERRAIN_CHUNK_SIZE;

    const stand = new Stand(
      this.scene,
      originX,
      originY,
      scatter(this.scene, this.world.terrain, originX, originY, TERRAIN_CHUNK_SIZE, this.world.seed),
      DEPTH.vegetation,
    );

    const chunk: Chunk = {
      relief,
      stand,
      bounds: new Phaser.Geom.Rectangle(originX, originY, TERRAIN_CHUNK_SIZE, TERRAIN_CHUNK_SIZE),
    };
    this.chunks.set(`${cx},${cy}`, chunk);
    this.cutCorridorsThrough(chunk);
    return true;
  }
}
