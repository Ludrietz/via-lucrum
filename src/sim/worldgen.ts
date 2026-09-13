import type { Vec2 } from './geometry';
import { hashRandom, NoiseField } from './noise';
import {
  makeGeneratedNode,
  MIN_NODE_DISTANCE,
  RAW_RESOURCES,
  type GeneratedNode,
  type NodeSource,
  type NodeSummary,
  type RawResource,
} from './source';
import { isWalkableTo, TerrainField, TerrainType, walkableCellsFrom, type TerrainSample } from './terrain';
import { ResourceType } from './types';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * How strongly each raw good wants to appear on a given kind of ground —
 * point 10/11 of the brief. Weighted probabilities, not guarantees: a forest
 * is *likely* to grow wood, not required to, and every terrain type has at
 * least a trickle of everything so an unlucky roll never leaves a region
 * with literally nothing viable. Each weight is a base for the type plus a
 * contribution from the *continuous* characteristics (`TerrainSample`), so
 * two cells of the same type can still favour different resources — a rocky
 * hill leans iron, a mossy one leans wood.
 */
export function resourceWeights(sample: TerrainSample): Record<RawResource, number> {
  const w: Record<RawResource, number> = {
    [ResourceType.Wood]: 0.03,
    [ResourceType.Stone]: 0.03,
    [ResourceType.Iron]: 0.02,
    [ResourceType.Food]: 0.03,
  };

  switch (sample.type) {
    case TerrainType.Forest:
      w[ResourceType.Wood] += 0.55 + sample.forestDensity * 0.4;
      w[ResourceType.Food] += 0.1 + sample.fertility * 0.22; // game and berries
      w[ResourceType.Stone] += 0.04 + sample.rockiness * 0.18;
      break;
    case TerrainType.Plains:
      w[ResourceType.Food] += 0.5 + sample.fertility * 0.4;
      w[ResourceType.Wood] += sample.forestDensity * 0.35;
      // Fieldstone. Lowland stone used to be a rounding error, which read as
      // realistic until you notice stone is what *both* a forest and a farm
      // need shipped in to level up (`nodeLevel.ts`): a plains-heavy start
      // with no stone in reach can't grow its nodes, so it can't grow the
      // settlements around them, so its influence never widens and it never
      // reaches the stone. Common enough to find, never as rich as hills.
      w[ResourceType.Stone] += 0.06 + sample.rockiness * 0.18;
      break;
    case TerrainType.Hills:
      w[ResourceType.Stone] += 0.35 + sample.rockiness * 0.3;
      w[ResourceType.Iron] += 0.18 + sample.rockiness * 0.22;
      w[ResourceType.Wood] += sample.forestDensity * 0.3;
      w[ResourceType.Food] += sample.fertility * 0.2;
      break;
    case TerrainType.Mountains:
      w[ResourceType.Stone] += 0.45 + sample.rockiness * 0.25;
      w[ResourceType.Iron] += 0.35 + sample.rockiness * 0.3;
      w[ResourceType.Food] = 0.01;
      w[ResourceType.Wood] = 0.01;
      break;
    case TerrainType.Water:
      // Fish: an economic Food source that happens to come from water rather
      // than a farm, exactly like the brief asks for — the category is
      // Food, the geography behind it varies.
      w[ResourceType.Food] += 0.6;
      w[ResourceType.Wood] = 0;
      w[ResourceType.Stone] = 0;
      w[ResourceType.Iron] = 0;
      break;
  }

  return w;
}

/** How generally resource-rich this ground is, all raw goods combined — used by the debug overlay and by deposit density. */
export function totalResourceWeight(sample: TerrainSample): number {
  return Object.values(resourceWeights(sample)).reduce((sum, w) => sum + w, 0);
}

/**
 * Corrects what the *ground* alone would produce into what the *game* needs.
 * Terrain weights answer "what could plausibly be here", and left alone they
 * hand back roughly the terrain distribution itself: lowland plains are the
 * commonest ground by far and plains overwhelmingly roll food, which in
 * practice meant eight farms and two woodlots within reach of the opening
 * village — a civilisation drowning in grain, its sawmill fully staffed and
 * permanently out of timber, its development frozen, and (because influence
 * is downstream of development) nothing new ever revealed again. These
 * scale the *choice* between plausible options without ever making an
 * implausible one possible: a plains deposit still can't roll iron, it just
 * no longer crowds out timber and stone everywhere else. Food is damped
 * because farmland is the default ground; iron is boosted hardest because
 * it should be the thing worth crossing a map for.
 */
const RESOURCE_BALANCE: Record<RawResource, number> = {
  [ResourceType.Food]: 0.4,
  // Timber is the second necessity, not a luxury: every resident burns and
  // builds with it (`DEMAND_PER_CAPITA_PER_MIN` puts it at three fifths of
  // food), it is what a quarry and a mine need shipped in to grow, it is the
  // sawmill's input, and housing is made of it. It was nonetheless the
  // *rarest* thing on the map after iron — seventeen percent of sites — while
  // stone, which a resident gets through at a fifth the rate, took thirty-one
  // percent. The consequence was not subtle: with population gated on
  // necessities, the whole civilisation topped out at thirty residents
  // against a food supply that could have fed eighty, and every industry sat
  // permanently starved because no timber was ever spare.
  [ResourceType.Wood]: 2.2,
  // Stone stays weighted above what the ground alone would give it — it is
  // the upgrade material for both forests and farms, and the masonry's input,
  // so a map with none plays deadlocked — but not above the good the economy
  // actually eats. Generation that ignores what a resource is *for* produces
  // a world that looks plausible and plays stuck; so does generation that
  // over-corrects for one shortage and creates another.
  [ResourceType.Stone]: 1.7,
  [ResourceType.Iron]: 1.6,
};

function pickWeighted(weights: Record<RawResource, number>, roll: number): RawResource {
  let total = 0;
  for (const r of RAW_RESOURCES) total += weights[r] * RESOURCE_BALANCE[r];
  let cursor = roll * total;
  for (const r of RAW_RESOURCES) {
    const weight = weights[r] * RESOURCE_BALANCE[r];
    if (cursor < weight) return r;
    cursor -= weight;
  }
  return RAW_RESOURCES[RAW_RESOURCES.length - 1];
}

// ---------------------------------------------------------------- placement

/**
 * Resources come in *deposits*, not one-per-cell. This is the spacing of the
 * lattice that decides where a deposit might be — and it is deliberately
 * enormous compared to the size of a node, because the lattice is not
 * supposed to be legible in the result. Most cells hold nothing at all; the
 * ones that do scatter a small group of sites around a wandering centre. The
 * previous version put at most one node per 260-unit cell at up to 60%
 * occupancy, which is a lattice you can read straight off the map: nodes at
 * suspiciously regular intervals in every direction, dozens of them within
 * the first influence ring, and no reason to ever go anywhere. This produces
 * the opposite: a handful of sites near the start, long genuinely empty
 * stretches, and distant clusters worth building toward.
 */
const CLUSTER_CELL_SIZE = 1300;
/** How far a deposit's centre wanders inside its own cell, as a fraction of it — enough that the lattice never shows. */
const CLUSTER_JITTER = 0.72;
/** Base odds an eligible cell holds a deposit at all, before ground and region scale it. */
const CLUSTER_CHANCE = 0.72;
const CLUSTER_SIZE_MIN = 2;
const CLUSTER_SIZE_MAX = 5;
/** How far a deposit's sites spread from its centre — a tight vein or a broad woodland. */
const CLUSTER_SPREAD_MIN = 130;
const CLUSTER_SPREAD_MAX = 460;
/**
 * How often a site in a deposit takes the deposit's own trade rather than
 * whatever the ground directly under it happens to favour. High, so a
 * deposit reads as "the iron hills" rather than a random assortment, but
 * short of total — a woodland with a berry patch in it is exactly the kind
 * of texture this is for.
 */
const CLUSTER_DOMINANCE = 0.7;
/** Below this total weight the ground is too barren (or too deep) for anything to take hold. */
const MIN_TOTAL_WEIGHT = 0.18;

/** Where the starting-area guarantee looks for food and wood — inside the opening influence ring. */
const NEAR_RINGS: readonly number[] = [300, 430, 560, 700, 850];
/** ...and where it looks for stone: out in the country, needing a grown village or a settlement to reach. */
const FAR_RINGS: readonly number[] = [1500, 1850, 2200];
/** Stone anywhere inside this counts as "the seed already provided some". */
const FAR_REACH = 2600;

/** How far apart village-site candidates are tried, and how far the search may wander. */
const SITE_SEARCH_STEP = 160;
const SITE_SEARCH_LIMIT = 3200;
/**
 * How much of the ground within the opening reach has to be dry land a
 * villager could actually walk to. Well under half: a coastal village with
 * the sea on one side is a fine, characterful start — a raft in the middle
 * of a lake is not.
 */
const MIN_WALKABLE_SHARE = 0.45;
/** How far a site rolled onto water may be nudged to find a shore, in terrain cells. */
const SHORE_SEARCH_CELLS = 3;

const SALT_CLUSTER_X = 11;
const SALT_CLUSTER_Y = 12;
const SALT_CLUSTER_EXISTS = 13;
const SALT_CLUSTER_PICK = 14;
const SALT_CLUSTER_SIZE = 15;
const SALT_NODE_ANGLE = 40;
const SALT_NODE_RADIUS = 80;
const SALT_NODE_PICK = 120;
const SALT_NODE_RICH = 160;
const SALT_DEPOSITS = 6;

/**
 * Broad "this country is rich / this country is barren" variation, well
 * above the scale of any single deposit. Without it, deposit odds depend
 * only on the ground directly underneath, which spreads them evenly across
 * every forest and every hill on the map; with it, whole regions can be
 * worth crossing to and whole regions can be worth nothing, which is what
 * gives expansion a direction.
 */
const DEPOSIT_CONFIG = { wavelength: 5200, octaves: 3, gain: 0.5, lacunarity: 2.0 };

interface RawNode {
  position: Vec2;
  resource: RawResource;
  richness: number;
}

/**
 * The generator. Owns nothing but a seed, a terrain sampler and a deposit
 * field — placement is worked out fresh from world coordinates every time,
 * cached only so repeated queries over the same ground don't redo the noise.
 * Two `WorldGenerator`s built from the same seed produce byte-identical
 * worlds; that is the whole point of a seed.
 */
export class WorldGenerator implements NodeSource {
  readonly terrain: TerrainField;
  private readonly deposits: NoiseField;
  private readonly clusterCache = new Map<string, RawNode[]>();
  private readonly decidedClusters = new Set<string>();
  private readonly usedNames = new Set<string>();
  private nextNodeId = 1;

  constructor(readonly seed: number) {
    this.terrain = new TerrainField(seed);
    this.deposits = new NoiseField(seed, SALT_DEPOSITS, DEPOSIT_CONFIG);
  }

  // ---------------------------------------------------------------- deposits

  /**
   * Every site a deposit cell holds, worked out purely from the seed and the
   * cell's coordinates. Pure and cached: a neighbouring cell can ask about
   * this one (for spacing) without that cell having been "generated" in any
   * sense, which is what keeps deposits identical regardless of which
   * direction the civilisation happened to expand from.
   */
  private rawCluster(cx: number, cy: number): RawNode[] {
    const key = `${cx},${cy}`;
    const cached = this.clusterCache.get(key);
    if (cached) return cached;

    const nodes: RawNode[] = [];
    const jx = hashRandom(this.seed, SALT_CLUSTER_X, cx, cy);
    const jy = hashRandom(this.seed, SALT_CLUSTER_Y, cx, cy);
    const centre: Vec2 = {
      x: (cx + 0.5 + (jx - 0.5) * CLUSTER_JITTER) * CLUSTER_CELL_SIZE,
      y: (cy + 0.5 + (jy - 0.5) * CLUSTER_JITTER) * CLUSTER_CELL_SIZE,
    };

    const sample = this.terrain.sampleAt(centre);
    const weights = resourceWeights(sample);
    const total = RAW_RESOURCES.reduce((sum, r) => sum + weights[r], 0);

    if (total >= MIN_TOTAL_WEIGHT) {
      const ground = clamp01(total / 1.2);
      const region = 0.3 + this.deposits.sample01(centre.x, centre.y) * 1.35;
      const chance = Math.min(0.95, CLUSTER_CHANCE * ground * region);

      if (hashRandom(this.seed, SALT_CLUSTER_EXISTS, cx, cy) <= chance) {
        const dominant = pickWeighted(weights, hashRandom(this.seed, SALT_CLUSTER_PICK, cx, cy));
        const sizeRoll = hashRandom(this.seed, SALT_CLUSTER_SIZE, cx, cy);
        const count = CLUSTER_SIZE_MIN + Math.floor(sizeRoll * (CLUSTER_SIZE_MAX - CLUSTER_SIZE_MIN + 1));
        // A deposit holding more sites sprawls wider, so a big one doesn't
        // just become a denser knot on the same footprint.
        const spread = CLUSTER_SPREAD_MIN + sizeRoll * (CLUSTER_SPREAD_MAX - CLUSTER_SPREAD_MIN);

        for (let i = 0; i < count; i++) {
          const angle = hashRandom(this.seed, SALT_NODE_ANGLE + i, cx, cy) * Math.PI * 2;
          // Square-rooted so sites spread evenly over the disc instead of
          // bunching around the centre.
          const radius = Math.sqrt(hashRandom(this.seed, SALT_NODE_RADIUS + i, cx, cy)) * spread;
          const rolled: Vec2 = {
            x: centre.x + Math.cos(angle) * radius,
            y: centre.y + Math.sin(angle) * radius,
          };
          // A fishery is a genuinely good idea — food whose geography is a
          // lake rather than a field — but it was being placed *in* the
          // water, and a road cannot cross water, so every one of them was a
          // site the player could see, could never connect, and could never
          // do anything about. Beach it: the camp stands on the shore and
          // works the water beside it, which is both what a fishing village
          // actually looks like and something a road can reach.
          const position = this.ashore(rolled);
          if (!position) continue;

          // The ground *under this specific site*, not the deposit's centre:
          // a woodland that spills onto a lake shouldn't put a timber camp
          // in the water.
          const localWeights = resourceWeights(this.terrain.sampleAt(position));
          const localTotal = RAW_RESOURCES.reduce((sum, r) => sum + localWeights[r], 0);
          if (localTotal < MIN_TOTAL_WEIGHT) continue;

          const pickRoll = hashRandom(this.seed, SALT_NODE_PICK + i, cx, cy);
          const keepsTrade = pickRoll < CLUSTER_DOMINANCE && localWeights[dominant] > 0.05;
          const resource = keepsTrade ? dominant : pickWeighted(localWeights, pickRoll);

          if (nodes.some((n) => Math.hypot(n.position.x - position.x, n.position.y - position.y) < MIN_NODE_DISTANCE)) {
            continue;
          }

          // Skewed toward common: squaring a uniform roll biases it low, so
          // a genuinely rich deposit stays the rare find it should be.
          const richness = 0.7 + hashRandom(this.seed, SALT_NODE_RICH + i, cx, cy) ** 1.6;
          nodes.push({ position, resource, richness });
        }
      }
    }

    this.clusterCache.set(key, nodes);
    return nodes;
  }

  /**
   * Spacing across deposit boundaries. Only *earlier* cells (row-major) are
   * consulted, which makes the rule a total order rather than a mutual
   * standoff: two sites too close together always resolve the same way, and
   * never both drop out, no matter which cell was materialised first.
   */
  private survivesNeighbours(node: RawNode, cx: number, cy: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ox = cx + dx;
        const oy = cy + dy;
        const earlier = oy < cy || (oy === cy && ox < cx);
        if (!earlier) continue;

        for (const other of this.rawCluster(ox, oy)) {
          const d = Math.hypot(other.position.x - node.position.x, other.position.y - node.position.y);
          if (d < MIN_NODE_DISTANCE) return false;
        }
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- naming

  private nameFor(resource: RawResource): string {
    const pool = NODE_NAME_POOLS[resource];
    for (const name of pool) {
      if (!this.usedNames.has(name)) {
        this.usedNames.add(name);
        return name;
      }
    }
    const fallback = `${NODE_NAME_FALLBACK[resource]} ${this.nextNodeId}`;
    this.usedNames.add(fallback);
    return fallback;
  }

  private materialize(node: RawNode): GeneratedNode {
    return makeGeneratedNode(
      this.nextNodeId++,
      this.nameFor(node.resource),
      node.resource,
      node.position.x,
      node.position.y,
      node.richness,
    );
  }

  // ------------------------------------------------------------------ public

  /**
   * Decide every not-yet-decided deposit cell overlapping this world-space
   * rectangle, returning whatever sites came out of it. Each cell is only
   * ever decided once, so calling this again for overlapping ground — two
   * settlements whose reach overlaps, the same frontier re-checked a few
   * seconds later — is a cheap no-op for anything already settled.
   */
  ensureNodesGenerated(x0: number, y0: number, x1: number, y1: number): GeneratedNode[] {
    const cx0 = Math.floor(x0 / CLUSTER_CELL_SIZE);
    const cx1 = Math.floor(x1 / CLUSTER_CELL_SIZE);
    const cy0 = Math.floor(y0 / CLUSTER_CELL_SIZE);
    const cy1 = Math.floor(y1 / CLUSTER_CELL_SIZE);

    const created: GeneratedNode[] = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx},${cy}`;
        if (this.decidedClusters.has(key)) continue;
        this.decidedClusters.add(key);

        for (const node of this.rawCluster(cx, cy)) {
          if (!this.survivesNeighbours(node, cx, cy)) continue;
          created.push(this.materialize(node));
        }
      }
    }
    return created;
  }

  /**
   * The same spot if it is dry, the nearest dry ground if it is not, or null
   * if this is open water rather than a shoreline. Deterministic (a fixed
   * outward ring scan), so it cannot make placement depend on generation
   * order — the one property every seed guarantee rests on.
   */
  private ashore(point: Vec2): Vec2 | null {
    if (this.terrain.sampleAt(point).type !== TerrainType.Water) return point;

    const step = this.terrain.cellSize;
    for (let ring = 1; ring <= SHORE_SEARCH_CELLS; ring++) {
      for (let i = 0; i < ring * 8; i++) {
        const angle = (i / (ring * 8)) * Math.PI * 2;
        const candidate = {
          x: point.x + Math.cos(angle) * ring * step,
          y: point.y + Math.sin(angle) * ring * step,
        };
        if (this.terrain.sampleAt(candidate).type !== TerrainType.Water) return candidate;
      }
    }
    return null;
  }

  /**
   * Where the first village can actually stand.
   *
   * The world is generated before anyone asks whether it is habitable, and
   * `map.ts` hands over the geometric centre of the play area — which is a
   * coordinate, not a decision. Roughly one seed in ten put that coordinate
   * in open water: the village floated on a lake, every road out of it
   * failed `crossesImpassable` on its very first sample, and the game ended
   * on day 10 having never accepted a single input. Another one in six put
   * a *starting farm* in water (see `forcePlacement`, which used to exempt
   * food from the water check outright), which is the same dead end wearing
   * a friendlier face.
   *
   * This is not "the world bending to be nice" — the ground is exactly what
   * the noise made it, and a seed is still free to be poor, cramped or
   * awkward. It is siting: people found villages on land they can walk out
   * of, so the search is for the nearest such land, and the answer stays a
   * pure function of the seed.
   */
  habitableSite(requested: Vec2, reach: number): Vec2 {
    if (this.isViableSite(requested, reach)) return { ...requested };

    // Outward in rings, so the village lands as close to the requested spot
    // as the ground allows rather than wherever a scan happens to sweep first.
    for (let radius = SITE_SEARCH_STEP; radius <= SITE_SEARCH_LIMIT; radius += SITE_SEARCH_STEP) {
      const steps = Math.max(8, Math.round((2 * Math.PI * radius) / SITE_SEARCH_STEP));
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        const candidate = {
          x: requested.x + Math.cos(angle) * radius,
          y: requested.y + Math.sin(angle) * radius,
        };
        if (this.isViableSite(candidate, reach)) return candidate;
      }
    }

    return { ...requested };
  }

  /**
   * Land a village could work out of: dry, walkable ground with enough
   * connected dry ground around it to hold an economy. "Connected" is the
   * part that matters — a sandbar with open water on all sides passes a
   * naive "is this cell dry" test and still strands everyone on it.
   */
  private isViableSite(point: Vec2, reach: number): boolean {
    const sample = this.terrain.sampleAt(point);
    if (sample.type === TerrainType.Water || sample.type === TerrainType.Mountains) return false;

    const reachable = walkableCellsFrom(this.terrain, point, reach);
    const disc = Math.PI * (reach / this.terrain.cellSize) ** 2;
    return reachable.size >= disc * MIN_WALKABLE_SHARE;
  }

  /**
   * The one sanctioned exception to "the world is what it is": a freshly
   * founded village has to have a fighting chance regardless of what the
   * dice rolled nearby. If the ordinary placement above didn't put a food
   * source and a wood source within reasonable road-building distance of
   * `centre`, force one in at the best-looking spot a small local search can
   * find. Stone and iron are deliberately *not* guaranteed — having to go
   * looking for them is the expansion loop, not a failure of generation.
   */
  ensureStartingResources(
    centre: Vec2,
    existing: readonly NodeSummary[],
    reach: number,
  ): GeneratedNode[] {
    const created: GeneratedNode[] = [];
    // A guaranteed resource is only a guarantee if a road can get to it.
    // Placement used to check the ground under the site and nothing else, so
    // a farm across a bay counted toward the quota and stopped the search —
    // the village then starved beside a food source it could see and could
    // never reach. Walkability from the village is the honest test.
    const walkable = walkableCellsFrom(this.terrain, centre, FAR_REACH);
    const reachableOnFoot = (point: Vec2): boolean =>
      isWalkableTo(this.terrain, centre, FAR_REACH, walkable, point);
    // Food and wood have to be within the opening influence ring — those two
    // are what the first few minutes actually run on. *Two* food, not one:
    // population is throughput-limited by food, and a single level-one farm
    // supports around a dozen people, which is under the headcount the
    // village needs to climb its next tier — so a one-farm start caps its
    // own population, never grows its reach, and sits there forever. A seed
    // is allowed to be poor; it isn't allowed to be arithmetically incapable
    // of the first rung.
    //
    // Stone only has to be somewhere in the wider country: it gates node
    // investment (a forest and a farm both level up on shipped-in stone) and
    // the masonry, so a seed with none anywhere near is a dead end rather
    // than a hard game — but it sits far enough out to still need reaching
    // for, which is the whole expansion loop. Iron is deliberately never
    // guaranteed at all.
    const requirements: Array<{ resource: RawResource; count: number; reach: number; rings: readonly number[] }> = [
      { resource: ResourceType.Food, count: 2, reach, rings: NEAR_RINGS },
      { resource: ResourceType.Wood, count: 1, reach, rings: NEAR_RINGS },
      { resource: ResourceType.Stone, count: 1, reach: FAR_REACH, rings: FAR_RINGS },
    ];

    for (const { resource, count, reach: within, rings } of requirements) {
      const have = existing.filter(
        (n) =>
          n.resource === resource &&
          Math.hypot(n.x - centre.x, n.y - centre.y) <= within &&
          reachableOnFoot({ x: n.x, y: n.y }),
      ).length;

      for (let i = have; i < count; i++) {
        const forced = this.forcePlacement(resource, centre, [...existing, ...created], rings, reachableOnFoot);
        if (!forced) break;
        created.push(forced);
      }
    }

    return created;
  }

  /** A small radial search for the best ground for `resource` at the given distances, ignoring the usual deposit roll. */
  private forcePlacement(
    resource: RawResource,
    centre: Vec2,
    avoid: readonly { x: number; y: number }[],
    rings: readonly number[],
    reachableOnFoot: (point: Vec2) => boolean,
  ): GeneratedNode | null {
    let best: { position: Vec2; weight: number; richness: number } | null = null;

    for (const radius of rings) {
      const steps = 12;
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2 + radius * 0.001;
        const position = { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };

        if (avoid.some((n) => Math.hypot(n.x - position.x, n.y - position.y) < MIN_NODE_DISTANCE)) continue;

        // Water is out for *everything*, food included. Food used to be
        // exempted here — presumably the idea was fishing — but nothing in
        // the game can work a site it cannot lay a road to, so an exempted
        // farm was simply a farm nobody could ever reach, placed by the very
        // routine whose job is to guarantee a workable start.
        const sample = this.terrain.sampleAt(position);
        if (sample.type === TerrainType.Water) continue;
        if (!reachableOnFoot(position)) continue;
        const weight = resourceWeights(sample)[resource];
        if (!best || weight > best.weight) {
          best = { position, weight, richness: 0.85 + weight * 0.3 };
        }
      }
      // Good enough to stop looking further out once something reasonable turns up.
      if (best && best.weight > 0.35) break;
    }

    if (!best) return null;
    return makeGeneratedNode(
      this.nextNodeId++,
      this.nameFor(resource),
      resource,
      best.position.x,
      best.position.y,
      best.richness,
    );
  }
}

// -------------------------------------------------------------------- names

const NODE_NAME_POOLS: Record<RawResource, readonly string[]> = {
  [ResourceType.Wood]: [
    'Ashwood', 'Thornbrake', 'Farhollow', 'Highwood', 'Frostpine', 'Silverwood',
    'Oakmere', 'Bramblewick', 'Elderglade', 'Pinehollow',
  ],
  [ResourceType.Stone]: [
    'Oakhollow', 'Marrowdale', 'Stormquarry', 'Farstone', 'Cragstone', 'Slateford',
    'Greystone', 'Rockmere', 'Cairnfell', 'Quarryhold',
  ],
  [ResourceType.Iron]: [
    'Redcliff', 'Deepvein', 'Emberhold', 'Blackrock', 'Cinderpeak', 'Eastvein',
    'Ironmoor', 'Darkvein', 'Stonefall', 'Grimhollow',
  ],
  [ResourceType.Food]: [
    'Longacre', 'Millbrook', 'Sunfield', 'Greenmere', 'Windmere', 'Goldmarsh',
    'Farreach', 'Barleyfield', 'Wheatholm', 'Fisher’s Reach',
  ],
};

const NODE_NAME_FALLBACK: Record<RawResource, string> = {
  [ResourceType.Wood]: 'Woodland',
  [ResourceType.Stone]: 'Quarry',
  [ResourceType.Iron]: 'Mine',
  [ResourceType.Food]: 'Farm',
};
