import type { Vec2 } from './geometry';
import { hashRandom, NoiseField } from './noise';
import { TerrainField, TerrainType, type TerrainSample } from './terrain';
import { ResourceType, SiteType } from './types';

/**
 * A resource node the way generation produces it — everything `ResourceNode`
 * needs to be constructed, plus nothing else. `World` is what turns these
 * into real `ResourceNode` instances and decides when they become visible;
 * generation only ever decides *where* and *what*.
 */
export interface GeneratedNode {
  id: number;
  name: string;
  type: SiteType;
  resource: ResourceType;
  x: number;
  y: number;
  productionInterval: number;
  capacity: number;
}

/** The only resources a raw site can actually produce — processed goods come from industries, never from the ground. */
type RawResource = ResourceType.Wood | ResourceType.Stone | ResourceType.Iron | ResourceType.Food;
const RAW_RESOURCES: readonly RawResource[] = [
  ResourceType.Wood,
  ResourceType.Stone,
  ResourceType.Iron,
  ResourceType.Food,
];

const SITE_TYPE_FOR: Record<RawResource, SiteType> = {
  [ResourceType.Wood]: SiteType.Forest,
  [ResourceType.Stone]: SiteType.Quarry,
  [ResourceType.Iron]: SiteType.Mine,
  [ResourceType.Food]: SiteType.Farm,
};

/** Seconds one worker needs for a single unit, before richness or node level have any say. */
const BASE_PRODUCTION_INTERVAL: Record<RawResource, number> = {
  [ResourceType.Wood]: 6,
  [ResourceType.Stone]: 8,
  [ResourceType.Iron]: 10,
  [ResourceType.Food]: 6,
};

const BASE_CAPACITY = 8;

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
  [ResourceType.Wood]: 1.0,
  // Stone is weighted well above what the ground alone would give it because
  // the *economy* leans on it hardest: it's the upgrade material for both
  // forests and farms, and the masonry's input. Generation that ignores what
  // a resource is actually used for produces a world that looks plausible
  // and plays deadlocked.
  [ResourceType.Stone]: 2.2,
  [ResourceType.Iron]: 2.2,
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
/** Two sites never sit closer than this, inside a deposit or across two of them. */
const MIN_NODE_DISTANCE = 165;
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
export class WorldGenerator {
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
          const position: Vec2 = {
            x: centre.x + Math.cos(angle) * radius,
            y: centre.y + Math.sin(angle) * radius,
          };

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
    return {
      id: this.nextNodeId++,
      name: this.nameFor(node.resource),
      type: SITE_TYPE_FOR[node.resource],
      resource: node.resource,
      x: node.position.x,
      y: node.position.y,
      productionInterval: BASE_PRODUCTION_INTERVAL[node.resource] / node.richness,
      capacity: Math.round(BASE_CAPACITY * (0.8 + node.richness * 0.3)),
    };
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
    existing: readonly { resource: ResourceType; x: number; y: number }[],
    reach: number,
  ): GeneratedNode[] {
    const created: GeneratedNode[] = [];
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
        (n) => n.resource === resource && Math.hypot(n.x - centre.x, n.y - centre.y) <= within,
      ).length;

      for (let i = have; i < count; i++) {
        const forced = this.forcePlacement(resource, centre, [...existing, ...created], rings);
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
  ): GeneratedNode | null {
    let best: { position: Vec2; weight: number; richness: number } | null = null;

    for (const radius of rings) {
      const steps = 12;
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2 + radius * 0.001;
        const position = { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };

        if (avoid.some((n) => Math.hypot(n.x - position.x, n.y - position.y) < MIN_NODE_DISTANCE)) continue;

        const sample = this.terrain.sampleAt(position);
        if (sample.type === TerrainType.Water && resource !== ResourceType.Food) continue;
        const weight = resourceWeights(sample)[resource];
        if (!best || weight > best.weight) {
          best = { position, weight, richness: 0.85 + weight * 0.3 };
        }
      }
      // Good enough to stop looking further out once something reasonable turns up.
      if (best && best.weight > 0.35) break;
    }

    if (!best) return null;
    return {
      id: this.nextNodeId++,
      name: this.nameFor(resource),
      type: SITE_TYPE_FOR[resource],
      resource,
      x: best.position.x,
      y: best.position.y,
      productionInterval: BASE_PRODUCTION_INTERVAL[resource] / best.richness,
      capacity: Math.round(BASE_CAPACITY * (0.8 + best.richness * 0.3)),
    };
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
