import type { Vec2 } from './geometry';
import { RiverNetwork } from './river';
import { packViability, type MapPack, type PackNodeSpec } from './pack';
import {
  makeGeneratedNode,
  type GeneratedNode,
  type NodeSource,
  type NodeSummary,
} from './source';
import { classifyTerrain, GridTerrain, TerrainType, type TerrainSample } from './terrain';
import { STARTING_RESOURCE_REACH, type WorldConfig } from './world';

/**
 * The ground of an authored map.
 *
 * Two differences from procedural terrain, and both of them matter more than
 * they look:
 *
 * **It is finite.** Noise answers any coordinate from -infinity out; a
 * survey of a real place answers inside its own rectangle and nowhere else.
 * Rather than let that be a silent `undefined`, everything off the edge is
 * deep water — impassable, so no road can be drawn off the map, no route can
 * be found round the outside of it, and no settlement can be sited past the
 * border. The alternative (open, walkable void) would let the player build
 * out into ground nothing has ever described, which is a bug factory.
 *
 * A real import should still bake a natural border into the data — a ridge,
 * a coast, a river — because "the sea, abruptly, in a straight line" is an
 * honest failure mode but an ugly one. This is the backstop, not the plan.
 *
 * **It is already decided.** There is nothing to generate, so
 * `ensureGenerated` inherits `GridTerrain`'s no-op. Samples are still
 * classified lazily and cached, for the same reason `TerrainField` generates
 * chunks lazily: a map covering real ground has hundreds of thousands of
 * cells and a game may only ever ask about a fraction of them.
 */
export class RasterTerrain extends GridTerrain {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;

  private readonly pack: MapPack;
  private readonly cache: Array<TerrainSample | undefined>;

  constructor(pack: MapPack) {
    super();
    this.pack = pack;
    this.cellSize = pack.cellSize;
    this.cols = pack.cols;
    this.rows = pack.rows;
    this.cache = new Array(pack.cols * pack.rows);
  }

  sampleAtCell(col: number, row: number): TerrainSample {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return OFF_MAP;

    const index = row * this.cols + col;
    const cached = this.cache[index];
    if (cached) return cached;

    // The same classifier the noise sampler runs through, on readings that
    // came off a real place instead of out of a hash. That sharing is the
    // entire reason this class is thirty lines and not three hundred — see
    // `classifyTerrain`.
    const r = this.pack.raster;
    const sample = classifyTerrain(r.elevation[index], r.moisture[index], r.temperature[index]);
    this.cache[index] = sample;
    return sample;
  }
}

/**
 * Past the edge of the surveyed rectangle. Water because water is already
 * impassable everywhere in this game, so nothing needed a new rule to handle
 * it — a road refuses to cross it, routing will not path through it, and
 * settlement siting scores it zero. Adding an "off-map" terrain type instead
 * would have meant touching the cost table, the labels, the renderer and
 * settlement suitability to express something the game already knows how to
 * say.
 */
const OFF_MAP: TerrainSample = Object.freeze({
  type: TerrainType.Water,
  elevation: -1,
  moisture: 1,
  temperature: 0.5,
  fertility: 0,
  forestDensity: 0,
  rockiness: 0,
  wetness: 1,
});

/**
 * The sites of an authored map.
 *
 * Where `WorldGenerator` decides what is buried where, this only remembers
 * what somebody wrote down. The contract that takes real work is the one
 * `NodeSource` insists on: each node handed out exactly once, ever, across
 * every overlapping call. A flat scan with an emitted flag is enough — an
 * authored map holds hundreds of sites, not the unbounded lattice procedural
 * generation walks, and a spatial index here would be machinery earning
 * nothing.
 */
export class PackNodes implements NodeSource {
  readonly terrain: RasterTerrain;
  readonly rivers: RiverNetwork;

  private readonly specs: PackNodeSpec[];
  private readonly emitted: boolean[];
  private nextId = 1;

  constructor(readonly pack: MapPack) {
    this.terrain = new RasterTerrain(pack);
    this.rivers = new RiverNetwork(pack.rivers);
    this.specs = pack.nodes;
    this.emitted = new Array(pack.nodes.length).fill(false);
  }

  ensureNodesGenerated(x0: number, y0: number, x1: number, y1: number): GeneratedNode[] {
    const created: GeneratedNode[] = [];
    for (let i = 0; i < this.specs.length; i++) {
      if (this.emitted[i]) continue;
      const spec = this.specs[i];
      if (spec.x < x0 || spec.x > x1 || spec.y < y0 || spec.y > y1) continue;
      this.emitted[i] = true;
      created.push(
        makeGeneratedNode(this.nextId++, spec.name, spec.resource, spec.x, spec.y, spec.richness ?? 1),
      );
    }
    return created;
  }

  /**
   * The authored answer, verbatim. Procedural generation searches for
   * habitable ground because a coordinate picked off the middle of the play
   * area is a guess; an author who placed a village on a real river crossing
   * was not guessing, and nudging them "somewhere better" would move the map
   * away from the place it is meant to be. Whether the spot is actually
   * viable is checked once, loudly, at load — see `packViability`.
   */
  habitableSite(requested: Vec2): Vec2 {
    return { ...requested };
  }

  /**
   * Nothing. An authored map's starting resources are the ones the author
   * placed, and conjuring a farm the survey does not show would make the map
   * a suggestion rather than a record. `loadMapPack` refuses an unviable
   * pack outright instead, which is the same protection moved to the only
   * place it can honestly live.
   */
  ensureStartingResources(_centre: Vec2, _existing: readonly NodeSummary[], _reach: number): GeneratedNode[] {
    return [];
  }
}

/**
 * Turn a parsed pack into something `World` can be built from, refusing it if
 * the map cannot be played.
 *
 * `reach` is how far the opening village is expected to be able to reach for
 * food and timber. It defaults to the same number the procedural start
 * guarantee uses, so an authored map is held to exactly the standard a
 * generated one is held to rather than a friendlier one of its own.
 */
export function packWorldConfig(pack: MapPack, reach = STARTING_RESOURCE_REACH): WorldConfig {
  const source = new PackNodes(pack);
  const problems = packViability(pack, source.terrain, reach);
  if (problems.length > 0) {
    throw new Error(`map pack "${pack.name}" cannot be played:\n  ${problems.join('\n  ')}`);
  }

  return {
    width: pack.width,
    height: pack.height,
    village: pack.village,
    startingPopulation: pack.startingPopulation,
    seed: pack.seed,
    source,
    // An authored map has edges and was laid out on purpose: show all of it.
    revealAll: true,
  };
}
