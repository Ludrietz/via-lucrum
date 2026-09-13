import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import { TERRAIN_CHUNK_SIZE } from '../sim/terrain';
import type { World } from '../sim/world';
import { bakeRelief } from './relief';
import { DEPTH } from './theme';
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

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {
    createVegetationTextures(scene);
    this.update();
  }

  /**
   * Take on newly uncovered ground, paint some of it, and hide whatever the
   * camera can't see. Phaser skips invisible objects entirely, which is what
   * keeps an unbounded world affordable: however far the civilisation has
   * spread, only the chunks actually on screen are ever drawn.
   */
  update(): void {
    for (const chunk of this.world.drainUncoveredChunks()) this.needGround.push(chunk);

    if (this.plantedLast ? !this.paintGround() : !this.plantTrees()) {
      // Preferred queue was empty, so take the other one rather than idle.
      if (this.plantedLast) this.plantTrees();
      else this.paintGround();
    }
    this.plantedLast = !this.plantedLast;

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
    const size = TERRAIN_CHUNK_SIZE;
    let felled = 0;

    for (let cy = Math.floor((centre.y - radius) / size); cy <= Math.floor((centre.y + radius) / size); cy++) {
      for (let cx = Math.floor((centre.x - radius) / size); cx <= Math.floor((centre.x + radius) / size); cx++) {
        felled += this.chunks.get(`${cx},${cy}`)?.stand.fell(centre, radius) ?? 0;
      }
    }

    return felled;
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

    this.chunks.set(`${cx},${cy}`, {
      relief,
      stand,
      bounds: new Phaser.Geom.Rectangle(originX, originY, TERRAIN_CHUNK_SIZE, TERRAIN_CHUNK_SIZE),
    });
    return true;
  }
}
