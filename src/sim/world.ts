import {
  BASE_VALUE,
  consume,
  decayExcessStorage,
  decayThroughput,
  decayWealthIncome,
  DEMAND_PER_CAPITA_PER_MIN,
  easePopulation,
  recordWealth,
  sustainablePopulationAcross,
  type Trader,
} from './economy';
import { advanceConstruction, realmDemand } from './construction';
import { syncDevelopment } from './development';
import { dist, type Vec2 } from './geometry';
import { housingCapacity } from './housing';
import type { Industry } from './industry';
import {
  hinterlandRadius,
  roomScore,
  LandRegistry,
  settledAreaFor,
  surveyGround,
  urbanityFor,
  type LandContext,
} from './landUse';
import { MIN_GROUND_QUALITY, ResourceNode } from './resourceNode';
import {
  JUNCTION_GRAB_DISTANCE,
  RoadNetwork,
  type Anchor,
  type RoadEdge,
  type GraphNode,
  type Route,
  type RouteTree,
  type Site,
} from './roadNetwork';
import { HOURS_PER_DAY } from './scale';
import type { NodeSource, TerrainSource } from './source';
import { NO_RIVERS, type RiverNetwork } from './river';
import { TERRAIN_CHUNK_SIZE } from './terrain';
import { dominantGood, TrafficField, WEAR_ON_BUILD, wearEffort, wearOfLoad } from './traffic';
import { WorldGenerator } from './worldgen';
import { CLAIM_RADIUS, Territory } from './territory';
import { CLAIM_HORIZON, isSurveyed, ROAD_HORIZON, sampleAlong, surveySource, TIER_HORIZON, type SurveySource } from './survey';
import {
  capacityRatePerMin,
  FRONTIER_REACH,
  FRONTIER_SEARCH_LIMIT,
  selectFrontier,
  type CapacityBreakdown,
  type FrontierCandidate,
} from './expansion';
import { Settlement, stageFor, tradeFor, type Trade } from './settlement';
import {
  SettlementSystem,
  SETTLEMENT_TUNING,
  type Candidate,
  type Origin,
  type SettlementContext,
} from './settlementSystem';
import { IndustrySystem, MigrationSystem, nearestTrader, TransportSystem, WorkforceSystem, type SimContext } from './systems';
import { Tier, tierIndex } from './tier';
import { NodeState, ResourceType, VillagerRole, type WorldEvent } from './types';
import { Village } from './village';
import { Villager } from './villager';
import { WorkerDeliverySystem } from './workerDelivery';

/**
 * In-game hours a drawn road takes to finish drawing itself in. A flourish,
 * not a construction time, so it is set to read as about a second of real
 * time at 1x speed — see `REAL_SECONDS_PER_HOUR` in `scale.ts`.
 */
const ROAD_BUILD_TIME = 0.1;
/**
 * In-game hours per simulation second. One, and kept at one: simulation time
 * is reckoned in hours throughout, and how fast the wall clock feeds it is
 * decided in one place outside the model — `REAL_SECONDS_PER_HOUR`, applied
 * in `GameScene`. Two clocks in two files is how a clock drifts.
 */
const HOURS_PER_SECOND = 1;
/** Seconds between the village's population actually gaining or losing someone. */
const POPULATION_STEP_INTERVAL = 9;
/** Mean wear below which an unused road has faded back into the landscape. */
const ABANDON_BELOW = 0.12;
/**
 * How much less patient the wilderness is than the realm. A road across
 * country nobody holds has to be several times busier to justify itself —
 * see `World.abandonThreshold`.
 */
const OUTSIDE_ABANDON_FACTOR = 3.5;
/** How often cached routes get re-priced against current wear, not just a structural change. */
const WEAR_REFRESH_INTERVAL = 4;
/** Seconds between sweeps for roads nobody is keeping up. */
const PRUNE_INTERVAL = 2;
/** How far a guaranteed early food/wood source is allowed to be forced into place — see `NodeSource.ensureStartingResources`. */
export const STARTING_RESOURCE_REACH = 850;
/**
 * How far past everything the realm holds — and past the frontier it is
 * currently being offered — the world is generated.
 *
 * Not the camera: panning around a map is looking, not expanding, and a world
 * that materialised wherever someone happened to scroll would generate ground
 * the civilisation has no claim on and may never reach. What decides the
 * world's extent is what the civilisation has actually taken in, plus enough
 * beyond it to hold up the next set of opportunities — an offer must never be
 * made over ground that has not been decided yet.
 */
const GENERATION_MARGIN = 1200;
/** How often the generation frontier is re-checked. Chunk decisions are cached, so a miss here just means a short delay, not wasted work. */
const GENERATION_CHECK_INTERVAL = 3;
/**
 * Seconds (this world's "hours" are 1:1 with real seconds — see
 * `HOURS_PER_SECOND`) the founding population is propped up regardless of
 * what's actually being delivered — see `updatePopulation`'s
 * `foundingGraceRemaining`. Matches `stockFoundingReserves`'s reserve: the
 * same two minutes that reserve was sized to cover.
 */
const FOUNDING_GRACE_SECONDS = 120;

/**
 * How often ground gets laid out, and how many cells any one claimant may
 * take in a pass — see `landUse.ts`.
 *
 * Slow on purpose. A parcel is not a shape recomputed from a radius; it is
 * ground being cleared, walled and ploughed, and it should read that way on
 * the map: a town visibly creeps up its valley over a day or two rather than
 * arriving at its full extent the tick its population ticks over. At these
 * numbers a claimant takes six cells a second, so a hamlet lays out its first
 * fifty-odd cells in about nine seconds and a mature works its two hundred in
 * half a minute — both comfortably slower than the population or level change
 * that asked for them.
 *
 * It is also what keeps this cheap. A parcel that already holds what it wants
 * does no work at all, so the steady state — which is nearly all of the time —
 * costs nothing, and only places that are actually growing pay.
 */
const LAND_INTERVAL = 0.5;
const LAND_CELLS_PER_PASS = 3;

/** How coarsely `roomAt` answers are shared between nearby candidate patches. */
const ROOM_CACHE_CELL = 64;
/** Seconds a cached `roomAt` answer is good for. */
const ROOM_CACHE_SECONDS = 25;

export interface WorldConfig {
  width: number;
  height: number;
  village: { name: string; x: number; y: number };
  startingPopulation: number;
  /**
   * Everything a *procedurally generated* world is a pure function of. Still
   * required even when `source` is supplied: plenty of systems that have
   * nothing to do with generation (frontier tie-breaking in `expansion.ts`,
   * settlement naming) take a seed for reproducibility, and they need one
   * whether the ground came from noise or from a survey.
   */
  seed: number;
  /**
   * Where the world comes from. Omitted, `World` builds the procedural
   * generator from `seed` — which is exactly what it always did, and what
   * every harness in `tools/` still does.
   *
   * Supplied, `World` asks no questions about what it was handed. This is an
   * already-constructed object rather than a `{ kind: 'pack', id }` tag on
   * purpose: an imported map has to be *loaded* before it can answer
   * anything, loading is asynchronous, and the simulation has no business
   * owning an async step. Whoever builds the world does the loading, then
   * hands over something that can already answer.
   */
  source?: NodeSource;
  /**
   * Draw the whole map from the start instead of uncovering it as the realm
   * reaches out. Only meaningful for a world with edges — see
   * `World.uncoverWholeMap`.
   */
  revealAll?: boolean;
}

/**
 * The whole simulation. Nothing in here knows that Phaser exists; the renderer
 * reads this state and the input layer calls `buildRoad`.
 */
export class World {
  readonly width: number;
  readonly height: number;

  readonly village: Village;
  readonly nodes: ResourceNode[] = [];
  readonly network = new RoadNetwork();
  readonly terrain: TerrainSource;
  readonly rivers: RiverNetwork;
  readonly traffic: TrafficField;
  /** The world seed everything generated is a deterministic function of — see `worldgen.ts`. */
  readonly seed: number;
  readonly settlements: Settlement[] = [];
  /**
   * Everyone, everywhere — one shared, mobile pool. A villager's `home` says
   * which trader they currently belong to, but that can change (see
   * `MigrationSystem`); nobody is owned by a place the way `Village` used to
   * own its own roster.
   */
  readonly villagers: Villager[] = [];

  hours = 0;
  /** Where total population is easing toward — see `updatePopulation`. */
  populationTarget = 0;

  /**
   * The ground the civilisation actually holds — see `territory.ts`. Grows
   * only when something is deliberately incorporated, never on its own.
   */
  readonly territory = new Territory();

  /**
   * Who holds which patch of ground. The territory says what the *realm*
   * owns; this says what each village and each works actually occupies inside
   * it, one cell to one claimant — see `landUse.ts`.
   */
  readonly land = new LandRegistry();
  /**
   * Unspent Expansion Capacity. Earned by the civilisation doing well (see
   * `expansion.ts`), spent by the player on frontier claims, and the one
   * number standing between "we could go there" and "we went there".
   */
  expansionCapacity = 0;
  /** What the frontier is offering right now. Refreshed whenever the border moves. */
  frontier: FrontierCandidate[] = [];

  private readonly transport = new TransportSystem();
  private readonly workforce = new WorkforceSystem();
  private readonly workerDelivery = new WorkerDeliverySystem();
  private readonly migration = new MigrationSystem();
  private readonly industry = new IndustrySystem();
  private readonly emergence = new SettlementSystem();
  private readonly source: NodeSource;

  private events: WorldEvent[] = [];
  private routeCache = new Map<ResourceNode, Route | null>();
  /**
   * Every *other* route anyone has asked for this window, source by
   * destination — see `routeBetweenSites`.
   */
  private pairRoutes = new Map<Site, Map<Site, Route | null>>();
  /** One finished search per origin, which is what fills a row of it. */
  private routeTrees = new Map<Site, RouteTree | null>();
  private cachedVersion = -1;
  private nextVillagerId = 1;
  private nextSettlementId = 1;
  private populationTimer = 0;
  private pruneTimer = 0;
  private wearRefreshTimer = 0;
  private generationTimer = 0;
  private landTimer = 0;
  private readonly roomCache = new Map<number, { value: number; hours: number }>();
  private villageTier: Tier;
  private readonly settlementTiers = new Map<number, Tier>();
  private readonly nodeLevels = new Map<number, number>();
  /** Ground the civilisation has uncovered, by chunk — what the renderer is allowed to draw. See `uncoverGround`. */
  private readonly uncoveredChunks = new Set<string>();
  private freshlyUncovered: Array<{ cx: number; cy: number }> = [];
  /** Starting headcount, kept around only to size the founding grace floor — see `updatePopulation`. */
  private foundingPopulation = 0;
  /** Counts down from `FOUNDING_GRACE_SECONDS`; the floor it guards disappears for good once this hits zero. */
  private foundingGraceRemaining = FOUNDING_GRACE_SECONDS;

  constructor(config: WorldConfig) {
    this.width = config.width;
    this.height = config.height;
    this.seed = config.seed;
    this.source = config.source ?? new WorldGenerator(config.seed);
    this.terrain = this.source.terrain;
    this.rivers = this.source.rivers ?? NO_RIVERS;
    this.traffic = new TrafficField(config.width, config.height);
    this.network.setTraffic(this.traffic);

    // Where the village is *asked* to stand is a coordinate; where it can
    // stand is a question about the ground, and only the world source can
    // answer it. See `NodeSource.habitableSite` — roughly one seed in
    // ten used to put the founding village in open water, where no road
    // could ever leave it and the game was over before the first input.
    const site = this.source.habitableSite({ x: config.village.x, y: config.village.y }, STARTING_RESOURCE_REACH);
    this.village = new Village(config.village.name, site.x, site.y);

    // The founding seat: the first and only piece of territory nobody had to
    // pay for. Everything the realm ever holds after this is bought.
    this.territory.incorporate({
      key: 'village',
      kind: 'seat',
      position: this.village.position,
      radius: this.village.footprintRadius,
      link: null,
    });

    // Generate the ground under and around the village before anything else
    // touches it — the frontier search below, and every later query against
    // `this.terrain`, needs real ground to answer against rather than empty
    // space waiting to be decided. Same rule as every later expansion: what
    // the realm holds, plus the frontier it can see past it, plus the margin.
    this.generateAround(this.village.position, this.village.footprintRadius + FRONTIER_REACH + GENERATION_MARGIN);
    this.ensureStartingResources();
    this.stockFoundingReserves(config.startingPopulation);
    this.foundingPopulation = config.startingPopulation;

    for (let i = 0; i < config.startingPopulation; i++) this.addVillager();
    // Nothing has been delivered yet, so start the target where the real
    // headcount already is rather than easing it down to zero on day one.
    this.populationTarget = config.startingPopulation;
    this.syncPopulation();
    this.villageTier = this.village.tier;

    this.incorporateFoundingSites();
    this.absorbEnclosedNodes();
    this.refreshFrontier();

    // Last, so it wins over whatever the founding passes happened to uncover.
    if (config.revealAll) this.uncoverWholeMap();
  }

  /**
   * The village starts with the fields and woodlot it has always worked.
   *
   * Without this the realm begins as a single seat holding nothing but its own
   * skirts, and the player's opening move is to wait: capacity accrues from
   * population and trade, both of which need a resource site, which costs
   * capacity. At the founding rate that is ten minutes of watching a village
   * starve before the first decision is even available — and it did, straight
   * to a population of three.
   *
   * These are the sites `NodeSource.ensureStartingResources` already
   * guarantees, and this is the same exception in the same spirit: a place
   * that existed before the player arrived would obviously already be working
   * the ground next to it. Everything past these two is earned.
   */
  private incorporateFoundingSites(): void {
    for (const resource of [ResourceType.Food, ResourceType.Wood]) {
      const nearest = this.nodes
        .filter((n) => !n.isClaimed && n.resource === resource)
        .filter((n) => dist(n.position, this.village.position) <= STARTING_RESOURCE_REACH)
        .sort((a, b) => dist(a.position, this.village.position) - dist(b.position, this.village.position))[0];
      if (!nearest) continue;

      this.territory.incorporate({
        key: `node:${nearest.id}`,
        kind: 'claim',
        position: { ...nearest.position },
        radius: CLAIM_RADIUS,
        link: { ...this.village.position },
      });
      nearest.state = NodeState.Reachable;
    }
  }

  // --------------------------------------------------------------- expansion

  /**
   * Take a frontier opportunity into the realm. The one deliberate act of
   * expansion the game has, and the only thing that ever moves the border
   * outward.
   *
   * Note what this does *not* do. It does not connect the site, staff it,
   * settle it, or deliver anything from it. The player is buying the right to
   * develop somewhere, not its output — a claimed deposit three valleys away
   * with no road to it produces exactly nothing, and will go on producing
   * nothing until the player runs a road out and the simulation decides
   * working it is worth someone's time. That separation is the point: the
   * player shapes the conditions, the simulation decides what comes of them.
   */
  claim(node: ResourceNode): boolean {
    const candidate = this.frontier.find((c) => c.node === node);
    if (!candidate) return false;
    if (this.expansionCapacity < candidate.cost) return false;

    this.expansionCapacity -= candidate.cost;

    // The ground between the realm and what it just took in becomes the
    // realm's too — see `territory.ts`. Without that a claim would read as a
    // detached bubble appearing in the wilderness rather than the border
    // growing out to meet something.
    const from = this.territory.nearestHolding(node.position);
    this.territory.incorporate({
      key: `node:${node.id}`,
      kind: 'claim',
      position: { ...node.position },
      radius: CLAIM_RADIUS,
      link: from ? { ...from.position } : null,
    });

    node.state = NodeState.Reachable;
    this.events.push({ type: 'claimed', at: { ...node.position }, name: node.name, cost: candidate.cost });

    // The border moved, so both what the realm encloses and what it can see
    // past itself have changed. Generation first — an offer must never be
    // made over ground that has not been decided yet.
    this.expandGeneration();
    this.absorbEnclosedNodes();
    this.refreshFrontier();
    this.cachedVersion = -1;
    return true;
  }

  /** What it would cost to take this site in right now, or null if it is not on offer. */
  claimCost(node: ResourceNode): number | null {
    return this.frontier.find((c) => c.node === node)?.cost ?? null;
  }

  /** What the civilisation is currently earning toward its next expansion, and from what. */
  get capacityRate(): CapacityBreakdown {
    return capacityRatePerMin(this.traders);
  }

  /**
   * Generation is otherwise entirely hands-off — the same as any other
   * seed's outcome, sparse or rich, weird or ordinary — except for this one
   * guarantee: a fresh village has to be able to reach *something* to eat
   * and *something* to build with, or the game is over before the player
   * has drawn a single road. See `NodeSource.ensureStartingResources`
   * and point 15 of the brief.
   */
  private ensureStartingResources(): void {
    const summary = this.nodes.map((n) => ({ resource: n.resource, x: n.position.x, y: n.position.y }));
    const forced = this.source.ensureStartingResources(this.village.position, summary, STARTING_RESOURCE_REACH);
    for (const cfg of forced) this.nodes.push(new ResourceNode(cfg));
  }

  /**
   * A place that already existed before the player took over would already
   * have a little food in the larder and a little wood on hand — not enough
   * to coast on, just enough that the first minute or two isn't a
   * starvation timer while the first road is still being drawn. Sized off
   * the game's own demand rate rather than a flat constant, so it scales
   * sensibly if population or consumption ever get retuned. See point 16 of
   * the brief.
   */
  private stockFoundingReserves(startingPopulation: number): void {
    const RESERVE_MINUTES = 2;
    this.village.storage[ResourceType.Food] =
      DEMAND_PER_CAPITA_PER_MIN[ResourceType.Food] * startingPopulation * RESERVE_MINUTES;
    // A smaller cushion — the village has *some* timber on hand, not a
    // stockpile that would let the player skip finding a forest.
    this.village.storage[ResourceType.Wood] =
      DEMAND_PER_CAPITA_PER_MIN[ResourceType.Wood] * startingPopulation * RESERVE_MINUTES * 0.5;
  }

  /**
   * Decide (and cache forever after) every resource node in range of a
   * point — the terrain itself needs no such call, since `TerrainField`
   * answers any query lazily, but *placing nodes* is a deliberate policy
   * decision gated on the civilisation's actual reach, not a side effect of
   * some unrelated query happening to land nearby.
   */
  /**
   * Decide the world out to `radius`, and *show* it out to `uncoverRadius`.
   *
   * The two are deliberately different. Where deposits are has to be settled
   * well ahead of anything that might ask about them — the frontier search
   * will happily look a couple of thousand units past the border when the
   * country nearby is empty, and an offer must never be made over ground that
   * has not been decided. What the player can *see*, though, should stay
   * close to the realm, or the map hands itself over and "what's beyond our
   * frontier?" stops being a question worth asking.
   */
  private generateAround(centre: Vec2, radius: number, uncoverRadius = radius): void {
    const x0 = Math.max(0, centre.x - radius);
    const y0 = Math.max(0, centre.y - radius);
    const x1 = Math.min(this.width, centre.x + radius);
    const y1 = Math.min(this.height, centre.y + radius);
    const created = this.source.ensureNodesGenerated(x0, y0, x1, y1);
    for (const cfg of created) this.nodes.push(new ResourceNode(cfg));

    this.uncoverGround(
      centre,
      uncoverRadius,
      Math.max(0, centre.x - uncoverRadius),
      Math.max(0, centre.y - uncoverRadius),
      Math.min(this.width, centre.x + uncoverRadius),
      Math.min(this.height, centre.y + uncoverRadius),
    );
  }

  /**
   * Show the whole map at once, for a world that has edges.
   *
   * Procedural country goes on forever, so drawing it has to be rationed —
   * uncovering it all is not even a coherent request. An authored map is a
   * finite, deliberate thing that somebody laid out, and hiding it serves
   * nobody: it is the board, and you look at a board. It is also the case
   * that these maps exist to be experimented on, and an experiment you can
   * only see a corner of is a poor one.
   *
   * This reveals *ground*, and nothing else. Which sites exist out there and
   * whether they can be claimed is still governed by `survey.ts` and the
   * frontier, because that is a question about what the civilisation knows
   * and owns rather than about what the player is allowed to look at — see
   * "Knowledge is not ownership" in the vision.
   */
  private uncoverWholeMap(): void {
    const size = TERRAIN_CHUNK_SIZE;
    for (let cy = 0; cy * size < this.height; cy++) {
      for (let cx = 0; cx * size < this.width; cx++) {
        const key = `${cx},${cy}`;
        if (this.uncoveredChunks.has(key)) continue;
        this.uncoveredChunks.add(key);
        this.terrain.ensureGenerated(cx * size, cy * size, (cx + 1) * size - 1, (cy + 1) * size - 1);
        this.freshlyUncovered.push({ cx, cy });
      }
    }
  }

  /**
   * Fill in the ground the player can actually see, as a disc around a place
   * the civilisation reaches from.
   *
   * This has to be its own deliberate pass, because "which chunks exist" is
   * emphatically not the same question as "which chunks should be drawn".
   * `TerrainField` answers any query by generating whatever chunk that query
   * landed in, and plenty of queries land a long way from home — deposit
   * placement samples the ground at cluster centres over a thousand units
   * out, routing prices a road along its whole length. Drawing every chunk
   * that happened to get generated therefore uncovered the map in scattered
   * patches: ground four chunks away drawn because a deposit centre was
   * sampled there, while a chunk directly beside the village stayed blank
   * because nothing had needed to ask about it yet. Uncovering is a function
   * of distance from the realm, so it gets computed from distance to the
   * realm, rather than inferred from where the generator happened to poke.
   */
  private uncoverGround(centre: Vec2, radius: number, x0: number, y0: number, x1: number, y1: number): void {
    const size = TERRAIN_CHUNK_SIZE;
    const cx0 = Math.floor(x0 / size);
    const cx1 = Math.floor(x1 / size);
    const cy0 = Math.floor(y0 / size);
    const cy1 = Math.floor(y1 / size);

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx},${cy}`;
        if (this.uncoveredChunks.has(key)) continue;

        // Nearest point of the chunk to the centre, so the uncovered region
        // follows the influence ring rather than its bounding box.
        const nearestX = Math.max(cx * size, Math.min(centre.x, (cx + 1) * size));
        const nearestY = Math.max(cy * size, Math.min(centre.y, (cy + 1) * size));
        if (Math.hypot(nearestX - centre.x, nearestY - centre.y) > radius) continue;

        this.uncoveredChunks.add(key);
        this.terrain.ensureGenerated(cx * size, cy * size, (cx + 1) * size - 1, (cy + 1) * size - 1);
        this.freshlyUncovered.push({ cx, cy });
      }
    }
  }

  /**
   * Ground uncovered since the last call, for whoever draws it. Terrain
   * generation has no idea rendering exists; this is the one seam between
   * them, the same one-shot drain shape `drainEvents` uses.
   */
  drainUncoveredChunks(): Array<{ cx: number; cy: number }> {
    const out = this.freshlyUncovered;
    this.freshlyUncovered = [];
    return out;
  }

  /**
   * Keep the world generated a fixed margin past the influence border,
   * wherever that border currently runs. `influenceCentres` is deliberately
   * the exact same set `revealNodes` uses, so "generated" always leads
   * "revealed" by `GENERATION_MARGIN` and never the other way round: by the
   * time an influence ring grows out far enough to reveal something, the
   * ground and its deposits were decided a while ago.
   */
  private expandGeneration(): void {
    // Ownership decides how far the world has to be *decided*; the survey
    // decides how far it is *shown*. Both are driven from here so that
    // "generated" can never lag "visible" — an offer, or a deposit drawn on
    // the map, over ground that has not been decided yet is a hard bug.
    for (const holding of this.territory.reachPoints(0)) {
      this.generateAround(holding.position, holding.reach + FRONTIER_SEARCH_LIMIT + GENERATION_MARGIN, 0);
    }

    // Sampled along a corridor rather than run per point: a road polyline
    // carries a point every few units, and each one would otherwise trigger
    // its own chunk sweep over ground the previous point had just covered.
    // One sample per horizon's-width is enough for the discs to overlap into
    // a continuous band.
    const sources = this.surveySources();
    for (const source of sources) {
      for (const point of sampleAlong(source.path, source.horizon)) {
        this.generateAround(point, source.horizon + GENERATION_MARGIN, source.horizon);
      }
    }

    this.surveyCountry(sources);
  }

  /**
   * Everywhere the realm can see from, and how far — see `survey.ts` for why
   * this is deliberately not the same list as what the realm *holds*.
   *
   * Seats see furthest and their horizon grows with their tier, claims see
   * their own neighbourhood, and every stretch of road surveys the corridor
   * it runs through. That last one is what makes "roads open the world"
   * literally true rather than merely stated: a trunk road pays for itself
   * twice, in what it connects and in everything it finds along the way. It
   * reopens no exploit, because a road still grants nothing — it cannot
   * anchor on unclaimed ground, and what it reveals still has to be bought.
   */
  private surveySources(): SurveySource[] {
    const sources: SurveySource[] = [];

    for (const trader of this.traders) {
      sources.push({ path: [trader.position], horizon: TIER_HORIZON[trader.tier] });
    }
    for (const node of this.nodes) {
      if (node.isClaimed) sources.push({ path: [node.position], horizon: CLAIM_HORIZON });
    }
    for (const edge of this.network.edges) {
      sources.push(surveySource(edge.points, ROAD_HORIZON));
    }

    return sources;
  }

  /**
   * Mark everything the realm can currently see. Monotone: `surveyed` is
   * never cleared, so a road that later grows over leaves its discoveries
   * behind, which is exactly why a scouting track is worth drawing at all.
   */
  private surveyCountry(sources: SurveySource[] = this.surveySources()): void {
    for (const node of this.nodes) {
      if (node.surveyed) continue;
      if (!isSurveyed(sources, node.position)) continue;
      node.surveyed = true;
      this.events.push({ type: 'discovered', at: { ...node.position }, name: node.name });
    }
  }

  /**
  /**
   * Everywhere the realm holds ground, and how far past it the world needs
   * to be decided.
   *
   * This used to be a list of *influence* discs — one per place, sized by
   * its tier, plus one per connected node, plus (briefly) one per stretch of
   * road. All three were the same mistake in different clothes: they let the
   * civilisation reach further merely by doing well, or by the player
   * drawing a free road, so the map opened itself and the player was never
   * asked where the realm should grow. Reach is now something bought
   * deliberately (see `claim`), and this only reports what is already held.
   *
   * The margin covers the frontier as well as the border, because the
   * frontier system has to be able to offer sites the player has not taken
   * yet — the ground under an *offer* must already exist.
   */

  // ---------------------------------------------------------------- queries

  get day(): number {
    return Math.floor(this.hours / HOURS_PER_DAY) + 1;
  }

  get visibleNodes(): ResourceNode[] {
    return this.nodes.filter((n) => n.isVisible);
  }

  /**
   * Everything a road may start or end on right now.
   *
   * Claimed sites only. A frontier offer is drawn on the map and can be
   * inspected, but a road cannot anchor on it — you cannot build to somewhere
   * that is not yours. This is also what closes the old exploit where a free
   * road run out into the wild was enough to reach whatever it touched.
   */
  get connectableSites(): Site[] {
    return [this.village, ...this.claimedNodes, ...this.settlements];
  }

  /** Sites the realm has taken in — the ones the simulation is allowed to use. */
  get claimedNodes(): ResourceNode[] {
    return this.nodes.filter((n) => n.isClaimed);
  }

  /** Everywhere goods can be delivered to. The village is not special here. */
  get traders(): Trader[] {
    return [this.village, ...this.settlements];
  }

  storage(resource: ResourceType): number {
    return this.village.storage[resource];
  }

  /** Everyone who currently calls `trader` home. */
  villagersAt(trader: Trader): Villager[] {
    return this.villagers.filter((v) => v.home === trader);
  }

  populationAt(trader: Trader): number {
    return this.villagersAt(trader).length;
  }

  workerCountAt(trader: Trader): number {
    return this.villagersAt(trader).filter((v) => v.role === VillagerRole.Worker).length;
  }

  transporterCountAt(trader: Trader): number {
    return this.villagersAt(trader).filter((v) => v.role === VillagerRole.Transporter).length;
  }

  idleCountAt(trader: Trader): number {
    return this.villagersAt(trader).filter((v) => v.isFree).length;
  }

  routeTo(node: ResourceNode): Route | null {
    this.refreshRoutes();
    return this.routeCache.get(node) ?? null;
  }

  /**
   * The village or a visible node under a point, for hover and inspection.
   *
   * `grow` is how much bigger than its world size a place is currently being
   * *drawn* — see `SettlementLayer`'s `markerScale`, which magnifies places
   * once the map is pulled back far enough to be read rather than walked. The
   * hit target has to follow the drawing, or a city shown as a fat dot would
   * still only answer to the few world units it actually occupies, at exactly
   * the zoom where pointing accurately is hardest.
   */
  siteAt(point: Vec2, slack = 12, grow: (site: Site) => number = () => 1): Site | null {
    const reach = (site: Site, radius: number): boolean =>
      dist(site.position, point) <= radius * grow(site) + slack;

    if (reach(this.village, this.village.radius)) return this.village;

    const node = this.visibleNodes.find((n) => reach(n, n.radius));
    if (node) return node;

    return this.settlements.find((s) => reach(s, s.radius)) ?? null;
  }

  anchorAt(point: Vec2): Anchor | null {
    return this.network.anchorAt(point, this.connectableSites);
  }

  /**
   * The route between any two places, remembered for as long as the answer
   * cannot have changed.
   *
   * `routeCache` has always done this for the one route the world asks for
   * constantly — village to node — and this is the same bargain for all the
   * others, invalidated by the same two events: the network changing shape,
   * and the periodic re-pricing against wear (`WEAR_REFRESH_INTERVAL`).
   *
   * It is not an optimisation of a cheap thing. `findBestShipment` prices
   * every source in the realm against every destination in the realm, and it
   * is asked that up to eleven times a second; with a handful of villages
   * standing that is tens of thousands of identical graph searches per tick,
   * every one of them re-deriving a road network that had not moved. The
   * dispatcher is *meant* to weigh everything against everything — that is the
   * design, and it is the right one — but weighing is arithmetic, and only
   * the routes underneath it were ever expensive.
   */
  routeBetweenSites(from: Site, to: Site): Route | null {
    this.refreshRoutes();

    let fromHere = this.pairRoutes.get(from);
    if (!fromHere) {
      fromHere = new Map();
      this.pairRoutes.set(from, fromHere);
      // The first question asked about a place answers all of them: one search
      // out of it settles every destination at once — see `RoadNetwork.routeTree`.
      this.routeTrees.set(from, this.network.routeTree(from));
    }

    const known = fromHere.get(to);
    if (known !== undefined) return known;

    const route = this.routeTrees.get(from)?.to(to) ?? null;
    fromHere.set(to, route);
    return route;
  }

  /**
   * Whether a road may be laid along this line.
   *
   * Two rules, and between them they are the whole of what water does to a
   * network. A road may **bridge** a river — any crossing short enough that a
   * bridge could really make it (`MAX_BRIDGE_SPAN`) — and may not run along
   * water for longer than that, which is what stops "bridges exist" from
   * meaning "roads may be drawn down the middle of a lake".
   *
   * And it may not leave the map. On a procedural world that is free, because
   * there is no edge; on an authored one the ground past the border is
   * modelled as deep water (see `RasterTerrain`), and without this a road
   * could bridge off the edge into country nothing has ever described.
   */
  canLayAlong(points: Vec2[]): boolean {
    for (const p of points) {
      if (p.x < 0 || p.y < 0 || p.x > this.width || p.y > this.height) return false;
    }
    // Two kinds of water, asked two different ways, because they are two
    // different shapes. Lakes and sea are area and live in the raster, so the
    // question is how far a line runs through wet cells. A river is a line,
    // so the question is what it actually crosses and how wide the water is
    // there — see `RiverNetwork`.
    return this.terrain.canCarryRoad(points) && this.rivers.canCross(points);
  }

  /**
   * How hard a finished road is to walk, ground and bridges together.
   *
   * The ground gives a cost per unit length and the crossings give a lump of
   * effort apiece, so they are added as effort — cost times length — and
   * divided out once. Averaging the two separately would let a long road
   * dilute its bridges away, which is precisely backwards: a bridge is a
   * fixed expense that does not get cheaper because the road went further.
   */
  roadDifficulty(points: Vec2[]): number {
    const ground = this.terrain.averageCost(points);
    if (this.rivers.isEmpty) return ground;

    let length = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    }
    if (length <= 0) return ground;

    return ground + this.rivers.crossingEffort(points) / length;
  }

  drainEvents(): WorldEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // --------------------------------------------------------------- commands

  /**
   * Lay a road exactly where the player drew it, then price it: the ground it
   * crosses decides how hard it is to walk, and therefore whether villagers
   * will prefer it over some other way round.
   */
  buildRoad(rawPoints: Vec2[]): boolean {
    if (!this.canLayAlong(rawPoints)) return false;

    const created = this.network.addRoad(rawPoints, this.connectableSites);
    if (!created || created.length === 0) return false;

    for (const edge of created) {
      edge.difficulty = this.roadDifficulty(edge.points);
      // A newly cleared road shows faintly from the start, then has to be
      // walked to stay: unused, it fades back into the landscape.
      this.traffic.deposit(edge.points, WEAR_ON_BUILD);
    }

    this.events.push({ type: 'roadBuilt', points: created.flatMap((e) => e.points) });
    return true;
  }

  // ----------------------------------------------------------------- update

  update(delta: number): void {
    // Clamp so a backgrounded tab does not teleport everybody on return.
    const dt = Math.min(delta, 0.1);
    this.hours += dt * HOURS_PER_SECOND;

    this.network.update(dt, ROAD_BUILD_TIME);

    // Structural changes (a new or abandoned road) invalidate the route
    // cache immediately, via `network.version`; wear drifting on its own
    // does not bump that, so routes still need a periodic nudge or a road
    // could never actually win the wear-based discount that makes it worth
    // preferring over a fresher, shorter alternative.
    this.wearRefreshTimer += dt;
    if (this.wearRefreshTimer >= WEAR_REFRESH_INTERVAL) {
      this.wearRefreshTimer = 0;
      this.cachedVersion = -1;
    }
    this.refreshRoutes();

    this.generationTimer += dt;
    if (this.generationTimer >= GENERATION_CHECK_INTERVAL) {
      this.generationTimer = 0;
      this.expandGeneration();
    }

    // Before anything that reads a yield or a worker capacity this tick:
    // whose ground is whose is an input to production, housing and industry,
    // not a readout of them.
    this.landTimer += dt;
    if (this.landTimer >= LAND_INTERVAL) {
      this.landTimer = 0;
      this.advanceLandUse();
    }

    const ctx = this.context();
    this.workforce.update(dt, ctx);
    this.industry.update(dt, ctx);
    this.transport.update(dt, ctx);
    this.workerDelivery.update(dt, ctx);
    this.migration.update(dt, ctx);

    for (const node of this.nodes) {
      node.produce(dt);
      this.checkNodeLevel(node);
    }

    // Industry output is the other half of wealth (the first half — selling
    // surplus — lives in `TransportSystem.step`'s `Loading` case): turning
    // raw goods into something worth clearly more is the whole reason a
    // smithy is worth running, so the wealth is earned right where that
    // value gets added, not later when someone happens to move the tools.
    //
    // **Value added**, not the output's whole price. This credited the full
    // `BASE_VALUE` of what came out and nothing for what went in, which is not
    // a margin, it is minting: a sawmill consumed two wood it was handed for
    // free and booked the plank's entire 2.5. The error was invisible for as
    // long as industries never actually ran (see `economy.ts`'s `SUBSISTENCE`
    // for why they never did) and became the largest number in the economy the
    // moment they did — wealth income went from 51 a minute to 516, and since
    // Expansion Capacity is driven substantially by prosperity, the realm
    // began claiming frontier sites roughly three times as fast on identical
    // production.
    //
    // Charging the input also puts the recipes in the order the design says
    // they should be in. A sawmill nets 0.5 a plank and a masonry 0.5 a block
    // — worth doing, and worth doing mostly because of what the *planks* are
    // for, not the coin. A smithy nets 4 a tool. "A smithy is meant to be the
    // most profitable thing a settlement can run" was already written down in
    // `BASE_VALUE`'s comment; it only became true here.
    for (const trader of this.traders) {
      for (const ind of trader.industries) {
        const produced = ind.produce(dt);
        if (produced <= 0) continue;
        let inputValue = 0;
        for (const { resource, per } of ind.recipe.inputs) inputValue += BASE_VALUE[resource] * per;
        const margin = Math.max(0, BASE_VALUE[ind.resource] - inputValue);
        recordWealth(trader, margin * produced);
      }
    }

    // Everybody eats. `consume` draws every good down at exactly the rate
    // the same place's demand is quoted at, which is what keeps `shortage` a
    // live reading — see `economy.ts`. `decayExcessStorage` still handles the
    // separate case of a *shrunken* place sitting on a bigger version of
    // itself's leftovers, which consumption alone would take far too long to
    // work off.
    for (const trader of this.traders) {
      decayExcessStorage(trader, dt);
      consume(trader, dt);
    }

    this.traffic.decay(dt);
    this.emergence.update(dt, this.settlementContext());
    this.updatePopulation(dt);

    this.accrueExpansionCapacity(dt);

    this.pruneTimer += dt;
    if (this.pruneTimer >= PRUNE_INTERVAL) {
      this.pruneTimer = 0;
      this.pruneAbandonedRoads();
      this.syncSeatFootprints();
      // On a timer as well as on every claim. Recomputing only when the
      // border moved looked sufficient and deadlocked the entire game: if the
      // frontier came up empty for a moment — the ground just past the border
      // not generated yet, every nearby site already taken — then nothing
      // could be claimed, so the border never moved, so the frontier was
      // never recomputed, and the civilisation banked capacity forever with
      // nowhere to spend it. Observed going empty on day 61 and staying that
      // way for the rest of the run with nine hundred capacity unspent.
      this.refreshFrontier();
    }
  }

  /**
   * The civilisation earns toward its next expansion, continuously, purely
   * from how well it is actually doing — see `expansion.ts` for what counts.
   *
   * Nothing here caps it. A player who banks capacity instead of spending it
   * is making a real choice (wait for the iron, or take the forest now), and
   * a ceiling would quietly turn that into "spend it or waste it", which is
   * the opposite of the decision this system exists to create.
   */
  /** What the land system needs, and all it is allowed to touch. */
  private landContext(): LandContext {
    return { terrain: this.terrain, registry: this.land, rivers: this.rivers };
  }

  /**
   * Ground gets laid out, and everything downstream of who holds what is
   * brought up to date.
   *
   * The order is deliberate and is the one asymmetry the whole system rests
   * on. Works take their ground first, so a deposit opened in empty country
   * gets the run of it; settlements take theirs second, and a settlement is
   * the one claimant allowed to take ground off a works (see
   * `LandRegistry.canClaim`). So the sequence reads exactly as it should: the
   * wood is there, the village grows, and if the village has nowhere better
   * to grow than into the wood, it does — and the wood is worth less for it.
   * Nothing anywhere says "a town may not expand"; it simply costs what it
   * would really cost.
   */
  private advanceLandUse(): void {
    const ctx = this.landContext();

    for (const node of this.nodes) {
      // Claiming is not exploiting, and it is not occupying either: a
      // deposit beyond the border works no ground, which means a town inside
      // the border can quietly sprawl over country a frontier site would one
      // day want. That is a real consequence of leaving an offer on the
      // table, not an oversight.
      if (!node.isClaimed) continue;
      node.ground.targetArea = node.workedArea;
      node.ground.grow(ctx, LAND_CELLS_PER_PASS);
      node.groundQuality = Math.max(MIN_GROUND_QUALITY, node.ground.quality(this.terrain.cellSize));
    }

    for (const trader of this.traders) {
      trader.ground.targetArea = settledAreaFor(trader.population);
      trader.ground.grow(ctx, LAND_CELLS_PER_PASS);
    }

    for (const trader of this.traders) {
      const survey = surveyGround(
        trader.position,
        hinterlandRadius(trader.ground.targetArea),
        ctx,
        trader.ground,
      );
      trader.hinterland = survey;
      trader.roomSatisfaction = trader.ground.satisfaction(this.terrain.cellSize);
      trader.urbanity = urbanityFor(survey, trader.roomSatisfaction);
    }
  }

  /**
   * How much free, settleable country surrounds a point.
   *
   * Memoised on a coarse grid because the settlement scan asks this of every
   * busy patch on the network, and patches are far finer than the question
   * is: two spots sixty units apart survey almost exactly the same
   * neighbourhood. The entry expires rather than being invalidated — ground
   * changes hands slowly, and a reading half a minute stale feeds a soft
   * weight, not a gate.
   */
  roomAt(point: Vec2): number {
    const col = Math.floor(point.x / ROOM_CACHE_CELL);
    const row = Math.floor(point.y / ROOM_CACHE_CELL);
    const key = (col + 65536) * 131072 + (row + 65536);

    const cached = this.roomCache.get(key);
    if (cached && this.hours - cached.hours < ROOM_CACHE_SECONDS) return cached.value;

    const value = roomScore(surveyGround(point, SETTLEMENT_TUNING.roomRadius, this.landContext()).openness);
    if (this.roomCache.size > 4000) this.roomCache.clear();
    this.roomCache.set(key, { value, hours: this.hours });
    return value;
  }

  private accrueExpansionCapacity(dt: number): void {
    this.expansionCapacity += (this.capacityRate.total / 60) * dt;
  }

  /**
   * A place's own ground grows with the place. Not its *reach* — that is
   * bought, and a settlement growing has never been allowed to widen the
   * realm since this redesign — just how broadly it sits on country the realm
   * already holds. A settlement that has taken hold inside the border also
   * becomes a holding in its own right, which is what makes a thriving
   * frontier town thicken the realm around itself instead of leaving the
   * border pinched around the deposit it grew beside.
   */
  private syncSeatFootprints(): void {
    this.territory.resize('village', this.village.footprintRadius);

    for (const settlement of this.settlements) {
      const key = `settlement:${settlement.id}`;
      if (this.territory.has(key)) {
        this.territory.resize(key, settlement.footprintRadius);
        continue;
      }
      this.territory.incorporate({
        key,
        kind: 'seat',
        position: { ...settlement.position },
        radius: settlement.footprintRadius,
        // Founded inside the realm by definition (see `settlementSystem.ts`),
        // so there is no gap to bridge back to it.
        link: null,
      });
    }
  }

  /** The stretch of road under a point, for hovering and erasing. */
  roadAt(point: Vec2): RoadEdge | null {
    const anchor = this.network.anchorAt(point, []);
    return anchor?.kind === 'edge' ? anchor.edge : null;
  }

  /**
   * The fork under this point, if there is one.
   *
   * A junction was the one thing on the map with real consequences that could
   * not be inspected: it is what a settlement's `junction` term is read off
   * (see `settlementSystem.ts`, where being a fork is worth more than being
   * merely busy), and hovering one simply reported the ROAD panel for
   * whichever of its arms happened to answer first. Given the design asks a
   * player to grow towns by making crossroads, "what is this crossroads
   * worth?" is a question the map ought to be able to answer.
   *
   * Slack matches the weld distance the network itself uses for junctions, so
   * what the player can point at is exactly what the network treats as one
   * fork.
   */
  junctionAt(point: Vec2): GraphNode | null {
    let best: GraphNode | null = null;
    let bestDistance = JUNCTION_GRAB_DISTANCE;
    for (const node of this.network.nodes) {
      if (!node.isJunction) continue;
      const d = dist(node.position, point);
      if (d <= bestDistance) {
        best = node;
        bestDistance = d;
      }
    }
    return best;
  }

  /**
   * Take out the stretch of road under a point. A stretch runs between two
   * junctions or sites: there are no choices inside one, so half of it is
   * never worth keeping. The wear stays in the ground, so rebuilding along the
   * same line picks up where this left off.
   */
  eraseRoadAt(point: Vec2): boolean {
    const edge = this.roadAt(point);
    if (!edge) return false;

    this.network.abandon(edge);
    this.events.push({ type: 'roadLost', points: edge.points.map((p) => ({ ...p })) });
    return true;
  }

  /**
   * A delivery has arrived. The ground remembers both the passage and what was
   * carried, which is what eventually decides whether anywhere grows here.
   */
  private recordTrip(route: Route, resource: ResourceType | null, amount: number): void {
    for (const edge of route.edges) edge.usage++;
    this.traffic.deposit(route.points, wearOfLoad(amount), resource, amount);
  }

  /** How packed down a road is, averaged along it. */
  wearOf(edge: RoadEdge): number {
    return edge.wear(this.traffic);
  }

  /**
   * Roads nobody walks fade away. Anything on a current route to a connected
   * site is spared, as is anything a villager is standing on, so this can only
   * ever remove the network the player has stopped using — never strand a
   * settlement that still depends on it.
   */
  /**
   * How little traffic a stretch of road may carry before it grows over —
   * and the answer depends on whose ground it runs across.
   *
   * This is the border's job, and it is the one that makes the line on the
   * map something the player can actually *feel* rather than merely see.
   * Inside the realm a road is infrastructure: the realm keeps it up, and it
   * survives a quiet season. Outside, it is a track somebody once walked, and
   * the country takes it back unless it stays genuinely busy.
   *
   * The obvious alternative — territory-weighted wear decay in
   * `TrafficField` — says the same thing and costs far more: wear is a dense
   * per-patch field swept every tick, so it would need a cached
   * held-patch set rebuilt whenever the border moved. Abandonment already
   * runs on a slow timer over a few dozen edges, and it is where "has this
   * road gone" is actually decided, so the rule belongs here.
   *
   * What this adds to play is the second half of the scouting loop the survey
   * (`survey.ts`) opens. A road drawn out into unclaimed country is worth
   * drawing — it surveys the corridor it crosses, and what it finds stays
   * found. But it is not free forever: keep it, and you must either give it
   * real traffic or claim the ground it crosses. A track that has done its
   * job and lost its traffic returning to grass is exactly right, and it is
   * now the border, not a global constant, that decides how patient the
   * country is about it.
   */
  private abandonThreshold(edge: RoadEdge): number {
    const middle = edge.points[Math.floor(edge.points.length / 2)];
    return this.territory.contains(middle) ? ABANDON_BELOW : ABANDON_BELOW * OUTSIDE_ABANDON_FACTOR;
  }

  private pruneAbandonedRoads(): void {
    const inUse = new Set<RoadEdge>();

    for (const node of this.nodes) {
      if (!node.isConnected) continue;
      for (const edge of this.routeTo(node)?.edges ?? []) inUse.add(edge);
    }
    for (const villager of this.villagers) {
      for (const edge of villager.route?.edges ?? []) inUse.add(edge);
    }

    for (const edge of [...this.network.edges]) {
      if (inUse.has(edge) || !edge.isBuilt) continue;
      if (this.traffic.weakestAlong(edge.points) >= this.abandonThreshold(edge)) continue;

      this.network.abandon(edge);
      this.events.push({ type: 'roadLost', points: edge.points.map((p) => ({ ...p })) });
    }
  }

  /** Every industry, at every trader, flattened for the systems that staff them. */
  private get industries(): Industry[] {
    return this.traders.flatMap((t) => t.industries);
  }

  private context(): SimContext {
    return {
      village: this.village,
      nodes: this.nodes,
      traders: this.traders,
      industries: this.industries,
      villagers: this.villagers,
      traffic: this.traffic,
      routeTo: (node) => this.routeTo(node),
      routeBetweenSites: (from, to) => this.routeBetweenSites(from, to),
      costAt: (point) => this.terrain.costAt(point) * wearEffort(this.traffic.wearAt(point)),
      recordTrip: (route, resource, amount) => this.recordTrip(route, resource, amount),
      emit: (event) => this.events.push(event),
    };
  }

  /** Recompute reachability whenever the network changed shape. */
  private refreshRoutes(): void {
    if (this.cachedVersion === this.network.version) return;
    this.cachedVersion = this.network.version;
    this.pairRoutes.clear();
    this.routeTrees.clear();

    // Two hundred-odd nodes, all asking the same question of the same place.
    const fromVillage = this.network.routeTree(this.village);

    for (const node of this.nodes) {
      const route = node.isClaimed ? (fromVillage?.to(node) ?? null) : null;
      this.routeCache.set(node, route);
      if (!node.isClaimed) continue;

      if (!route) {
        // Cut off. The workers stay and keep producing; nobody can reach the
        // pile until the player lays a road back to them.
        node.state = NodeState.Reachable;
        continue;
      }

      if (node.state === NodeState.Reachable) {
        this.events.push({ type: 'connected', at: { ...node.position } });
      }
      node.state = node.workers.length > 0 ? NodeState.Operational : NodeState.Connected;
    }
  }

  /**
   * Work out what the frontier is currently offering, and show exactly that.
   *
   * This replaces the old "reveal everything inside our influence" sweep, and
   * the difference is the whole point of the redesign. Before, prospering
   * widened a radius and every deposit that fell inside it became the
   * civilisation's to use, for free, forever — so the map revealed itself and
   * the only question left was the order you got round to things in. Now a
   * small number of sites are held up as *opportunities* (see
   * `expansion.ts`'s `selectFrontier`), and nothing becomes the realm's
   * except by being paid for.
   *
   * Anything that stops being offered goes back to hidden. A frontier offer
   * is the realm's current attention, not a permanent discovery: claim
   * somewhere and the country you are looking at genuinely changes, which is
   * what keeps "what's beyond our border?" a live question instead of a list
   * that only ever grows.
   */
  private refreshFrontier(): void {
    const candidates = selectFrontier(this.nodes, this.territory, this.terrain, this.seed);
    this.frontier = candidates;

    const offered = new Set(candidates.map((c) => c.node));
    for (const node of this.nodes) {
      if (node.isClaimed) continue;
      if (offered.has(node)) {
        if (node.state !== NodeState.Frontier) {
          node.state = NodeState.Frontier;
          this.events.push({ type: 'discovered', at: { ...node.position }, name: node.name });
        }
      } else if (node.state === NodeState.Frontier) {
        node.state = NodeState.Hidden;
      }
    }
  }

  /**
   * Anything the realm already surrounds is already ours.
   *
   * Two jobs. It gives the opening village the sites `ensureStartingResources`
   * guaranteed it — a start where you must earn capacity before you can touch
   * a single deposit is not a start, it is a wait. And it means a claim that
   * takes in ground happening to contain a second site does not leave that
   * site sitting unclaimed *inside* the border, which would read as an
   * obvious bug.
   */
  private absorbEnclosedNodes(): void {
    for (const node of this.nodes) {
      if (node.isClaimed) continue;
      if (!this.territory.contains(node.position)) continue;
      node.state = NodeState.Reachable;
      this.events.push({ type: 'discovered', at: { ...node.position }, name: node.name });
    }
  }

  /**
   * Population and development, for the village and every settlement alike.
   * There is one civilisation-wide headcount now, not a separate number per
   * place: it eases toward what the food actually arriving, anywhere, could
   * sustain in total, and individual people simply live wherever they
   * currently do (see `MigrationSystem` for how that changes). Population
   * feeds demand and workforce, but no longer decides tier — tier is
   * development's job, same as always.
   */
  private updatePopulation(dt: number): void {
    // One reading of what the realm is short of worked goods, shared by every
    // place deciding whether to build a workshop — see .
    const demand = realmDemand(this.traders);
    for (const trader of this.traders) {
      decayThroughput(trader, dt);
      decayWealthIncome(trader, dt);
      advanceConstruction(trader, demand, dt);
      syncDevelopment(trader);
    }

    // Food decides how many people the civilisation *could* feed; housing
    // decides how many it actually has room for, in aggregate — capping the
    // total by whichever is smaller is what makes a civilisation sitting at
    // its housing ceiling actually build more of it (see `construction.ts`,
    // which spends genuine surplus material once a place is at its own
    // capacity) instead of just piling up population nobody has anywhere to
    // put.
    // This stays a civilisation-wide throttle, not a per-place hard block:
    // an earlier version also refused to let a worker *settle* at a specific
    // full place (keeping their old home instead), which sounded harmless
    // but destabilised the whole economy — small, ordinary population dips
    // at a young settlement could no longer be answered by settling new
    // people there, and once combined with the one-time settlement
    // "bootstrap" priority (see `systems.ts`) already having fired, nothing
    // ever bootstrapped it again. A soft, civilisation-wide ceiling gets the
    // same "growth needs housing" feel without that specific failure mode.
    const totalSustainable = sustainablePopulationAcross(this.traders);
    const totalHousing = this.traders.reduce((sum, trader) => sum + housingCapacity(trader), 0);
    // `sustainablePopulation` is deliberately throughput-only — not stock —
    // so a place that stops actually being fed can't coast on a full shelf
    // for as long as that shelf lasts; how many people a civilisation can
    // support is a question about the harvest, not the larder. That's
    // exactly right once the game is under way, but it also
    // means a founding population reads as "unsustainable" from the very
    // first tick, before anyone could possibly have built a road yet — see
    // `foundingGraceRemaining`. The floor is wall-clock, not storage-based,
    // specifically so it can't reopen that same blind spot at scale once a
    // real settlement has accumulated real stock.
    this.foundingGraceRemaining = Math.max(0, this.foundingGraceRemaining - dt);
    const target = Math.min(totalSustainable, totalHousing);
    const graceFloor = this.foundingGraceRemaining > 0 ? Math.min(this.foundingPopulation, totalHousing) : 0;
    this.populationTarget = easePopulation(this.populationTarget, Math.max(target, graceFloor), dt);
    this.reconcilePopulation(dt);
    this.syncPopulation();

    this.checkTierChanges();
  }

  /** Everyone's headcount is real villagers, so the total moves one at a time. */
  private reconcilePopulation(dt: number): void {
    const target = Math.round(this.populationTarget);
    if (this.villagers.length === target) {
      this.populationTimer = 0;
      return;
    }

    this.populationTimer += dt;
    if (this.populationTimer < POPULATION_STEP_INTERVAL) return;
    this.populationTimer = 0;

    if (this.villagers.length < target) {
      const villager = this.addVillager();
      this.events.push({ type: 'villagerBorn', at: { ...villager.position } });
      return;
    }

    // Nobody is floored at a minimum any more — a place too neglected to
    // support anyone can genuinely empty out. Migration (`MigrationSystem`)
    // is what normally moves people on before it comes to this; losing a
    // resident here only happens once the *whole* civilisation's supportable
    // total has shrunk, not because any one place ran dry. Only someone not
    // already out on the roads leaves.
    const pool = [...this.villagers].reverse();
    const leaving = this.pickDeparture(pool);
    if (!leaving) return;
    const index = this.villagers.indexOf(leaving);
    this.villagers.splice(index, 1);
  }

  /**
   * Who actually leaves when the civilisation can no longer support everyone.
   *
   * Whoever is free goes first — costs nothing, since a free villager has no
   * job to lose either way.
   *
   * Once every villager held a post there was nobody free at all, so nothing
   * could leave — and the civilisation simply froze, indefinitely, with the
   * readout plainly saying so. A famine has to be able to resolve. It
   * resolves the way it would in life: the workshop closes before the farm
   * does. Taking someone off a *resource node* is the thing that must never
   * happen here — that was tried, and cutting food production to fix a
   * population overhang is a real death spiral — but an industry is
   * discretionary work by definition, and shutting one is exactly what a
   * place short of food would do.
   */
  private pickDeparture(pool: Villager[]): Villager | null {
    const free = pool.filter((v) => v.isFree);
    if (free.length > 0) return free[0];

    // Nobody idle anywhere. Close a workshop rather than let the shortfall
    // stand forever.
    const worker = pool.find((v) => v.industryWorkplace !== null && v.role === VillagerRole.Worker);
    if (!worker) return null;

    const industry = worker.industryWorkplace!;
    const index = industry.workers.indexOf(worker);
    if (index >= 0) industry.workers.splice(index, 1);
    worker.release();
    return worker;
  }

  /** Every trader's `population` field is a cache of this, refreshed once a tick. */
  private syncPopulation(): void {
    for (const trader of this.traders) trader.population = this.populationAt(trader);
  }

  /** Fire a notification whenever a place actually climbs a rung, not drops one. */
  private checkTierChanges(): void {
    if (tierIndex(this.village.tier) > tierIndex(this.villageTier)) {
      this.events.push({
        type: 'tierUp',
        at: { ...this.village.position },
        tier: this.village.tier,
        name: this.village.name,
      });
    }
    this.villageTier = this.village.tier;

    for (const settlement of this.settlements) {
      const previous = this.settlementTiers.get(settlement.id) ?? Tier.Hamlet;
      if (tierIndex(settlement.tier) > tierIndex(previous)) {
        this.events.push({
          type: 'tierUp',
          at: { ...settlement.position },
          tier: settlement.tier,
          name: settlement.name,
        });
      }
      this.settlementTiers.set(settlement.id, settlement.tier);
    }
  }

  /** A node's level only ever climbs — it's read straight off a lifetime total. */
  private checkNodeLevel(node: ResourceNode): void {
    const previous = this.nodeLevels.get(node.id) ?? 1;
    if (node.level > previous) {
      this.events.push({ type: 'nodeLevelUp', at: { ...node.position }, name: node.name, level: node.level });
    }
    this.nodeLevels.set(node.id, node.level);
  }

  // ------------------------------------------------------------ settlements

  private settlementContext(): SettlementContext {
    return {
      traffic: this.traffic,
      terrain: this.terrain,
      network: this.network,
      nodes: this.nodes,
      village: this.village,
      settlements: this.settlements,
      population: this.villagers.length,
      held: (point) => this.territory.contains(point),
      room: (point) => this.roomAt(point),
      occupied: (point) => this.placeAt(point) !== null,
      hours: this.hours,
      found: (patch, position, trade, potential, origin) =>
        this.foundSettlement(patch, position, trade, potential, origin),
    };
  }

  /**
   * Somewhere has become worth living. It is placed on the road that made it,
   * which splits that road and turns the split into a real node, so traffic
   * runs through the new place and the player can build on from it.
   */
  private foundSettlement(
    patch: number,
    position: Vec2,
    trade: Trade,
    potential: number,
    origin: Origin,
  ): void {
    const settlement = new Settlement({
      id: this.nextSettlementId++,
      position,
      patch,
      foundedHours: this.hours,
      stage: stageFor(potential),
      trade,
      potential,
      name: this.nameFor(trade),
      origin,
    });

    const node = this.network.placeSiteOn(position, settlement);
    if (!node) return;

    // Snap to where the road actually runs, so it never floats beside it.
    settlement.position.x = node.position.x;
    settlement.position.y = node.position.y;

    this.settlements.push(settlement);

    // A settlement founds specifically because there is real, nearby work
    // already happening (see `settlementSystem.ts`'s founding gate) — work
    // someone is very likely already doing, just still homed at whichever
    // trader was nearest before this place existed to claim it. A node only
    // ever re-homes its worker at the moment they first arrive (see
    // `WorkforceSystem`), never afterwards, so without this a "food
    // village" could found right beside an already fully-staffed farm and
    // still show zero residents forever: the farmhand who should obviously
    // live here just never gets the chance to move. This is what actually
    // makes a settlement's founding purpose ("woodcutters settle by their
    // forest") show up as real population right away, not only for anyone
    // hired after the fact.
    for (const villager of this.villagers) {
      if (!villager.workplace) continue;
      if (nearestTrader(villager.workplace.position, this.traders) === settlement) villager.home = settlement;
    }

    this.cachedVersion = -1;
    // A new seat thickens the realm around itself, which can enclose sites and
    // shifts what the frontier is worth offering.
    this.syncSeatFootprints();
    this.absorbEnclosedNodes();
    this.refreshFrontier();
    this.events.push({
      type: 'settlementFounded',
      at: { ...settlement.position },
      name: settlement.name,
    });
  }

  /** First unused name from the trade's list, else a numbered fallback. */
  private nameFor(trade: Trade): string {
    const taken = new Set(this.settlements.map((s) => s.name));
    const free = trade.names.find((name) => !taken.has(name));
    return free ?? `${trade.names[0]} ${this.settlements.length + 1}`;
  }

  /** Candidate ground the emergence system is watching, for the overlay. */
  get watchedSites(): Candidate[] {
    return this.emergence.topCandidates(this.settlementContext());
  }

  /** Accumulated settlement potential at a point, 0 to 1. */
  potentialAt(point: Vec2): number {
    return this.emergence.potentialAt(this.traffic.indexAt(point), this.settlementContext());
  }

  /** Why that potential: the individual contributions behind it. */
  potentialBreakdown(point: Vec2): Record<string, number> {
    return this.emergence.breakdownAt(this.traffic.indexAt(point));
  }

  /** What kind of place this spot would turn into, on current traffic. */
  likelyTradeAt(point: Vec2): string {
    const { resource, share } = dominantGood(this.traffic.goodsAt(point));
    return tradeFor(resource, share).label;
  }

  settlementAt(point: Vec2, slack = 12): Settlement | null {
    return this.settlements.find((s) => dist(s.position, point) <= s.radius + slack) ?? null;
  }

  /**
   * The place whose ground a point falls on — the whole of its sprawl, not
   * the glyph in the middle of it.
   *
   * Separate from `siteAt` rather than folded into it, because these are two
   * different hit targets for two different purposes and always were. A road
   * anchors on a place's *centre* (`anchorAt`, via `Site.radius`), and it has
   * to: "draw a road to Kuttenberg" means to the town, not to whichever of
   * its outlying closes the cursor happened to be over. But "tell me about
   * this place" plainly means the place, and a town that covers a quarter of
   * the screen having a twenty-pixel click target in the middle of it was
   * only ever defensible while a town covered nothing at all.
   *
   * The registry guarantees one owner per cell, so there is never an
   * ambiguity to resolve here.
   */
  placeAt(point: Vec2): Trader | null {
    for (const settlement of this.settlements) {
      if (settlement.ground.contains(point, this.terrain)) return settlement;
    }
    return this.village.ground.contains(point, this.terrain) ? this.village : null;
  }

  /** The works whose ground of operation a point falls on, for the same reason. */
  workingsAt(point: Vec2): ResourceNode | null {
    return this.claimedNodes.find((node) => node.ground.contains(point, this.terrain)) ?? null;
  }

  /** New people default to the founding village; migration redistributes them from there. */
  private addVillager(home: Trader = this.village): Villager {
    const villager = new Villager(this.nextVillagerId++, home);
    villager.restAtHome();
    this.villagers.push(villager);
    return villager;
  }
}
