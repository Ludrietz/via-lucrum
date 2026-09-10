import {
  BASE_VALUE,
  consumeProcessedGoods,
  decayExcessStorage,
  decayThroughput,
  decayWealthIncome,
  DEMAND_PER_CAPITA_PER_MIN,
  easePopulation,
  recordWealth,
  sustainablePopulation,
  type Trader,
} from './economy';
import { advanceDevelopment } from './development';
import { dist, type Vec2 } from './geometry';
import { advanceHousing, housingCapacity } from './housing';
import type { Industry } from './industry';
import { ResourceNode } from './resourceNode';
import { RoadNetwork, type Anchor, type RoadEdge, type Route, type Site } from './roadNetwork';
import { TERRAIN_CHUNK_SIZE, TerrainField } from './terrain';
import { dominantGood, TrafficField, WEAR_ON_BUILD, WEAR_PER_TRIP, wearEffort } from './traffic';
import { WorldGenerator } from './worldgen';
import { Settlement, stageFor, tradeFor, type Trade } from './settlement';
import { SettlementSystem, type Candidate, type Origin, type SettlementContext } from './settlementSystem';
import { IndustrySystem, MigrationSystem, nearestTrader, TransportSystem, WorkforceSystem, type SimContext } from './systems';
import { Tier, tierIndex } from './tier';
import { NodeState, ResourceType, VillagerRole, type WorldEvent } from './types';
import { Village } from './village';
import { Villager, WORKING_POPULATION_SHARE } from './villager';
import { WorkerDeliverySystem } from './workerDelivery';

/** Seconds a drawn road takes to finish drawing itself in. */
const ROAD_BUILD_TIME = 0.45;
/** In-game hours per real second. */
const HOURS_PER_SECOND = 1;
const HOURS_PER_DAY = 24;
/** Seconds between the village's population actually gaining or losing someone. */
const POPULATION_STEP_INTERVAL = 9;
/** Mean wear below which an unused road has faded back into the landscape. */
const ABANDON_BELOW = 0.12;
/** How often cached routes get re-priced against current wear, not just a structural change. */
const WEAR_REFRESH_INTERVAL = 4;
/** Seconds between sweeps for roads nobody is keeping up. */
const PRUNE_INTERVAL = 2;
/** How far a guaranteed early food/wood source is allowed to be forced into place — see `WorldGenerator.ensureStartingResources`. */
const STARTING_RESOURCE_REACH = 850;
/**
 * How far past the *influence border* the world is generated — the only
 * thing that drives generation. Not the camera: panning around a map is
 * looking, not expanding, and a world that materialised wherever someone
 * happened to scroll would generate ground the civilisation has no claim
 * on and may never reach. What expands the world is the civilisation
 * expanding: the village's own reach growing with its tier, a settlement
 * taking hold further out and opening its own ring, a node levelling up
 * and pushing its own frontier. Generation stays this far ahead of all of
 * them, so ground (and the deposits in it) is always decided well before
 * an influence ring arrives to reveal it.
 */
const GENERATION_MARGIN = 1200;
/** How often the generation frontier is re-checked. Chunk decisions are cached, so a miss here just means a short delay, not wasted work. */
const GENERATION_CHECK_INTERVAL = 3;
/**
 * How far a node the road network reaches opens the country around itself,
 * before its own level adds anything — see `influenceCentres`. This is what
 * keeps the frontier from ever closing: the player's one verb is drawing
 * roads, so drawing one has to be able to reveal something.
 *
 * Sized against the gap between deposits rather than picked for feel.
 * Deposits sit about `CLUSTER_CELL_SIZE` (1300) apart and their sites
 * scatter a few hundred units either side of centre, so the typical gap
 * between the nearest sites of neighbouring deposits is more like 700-800.
 * At 620 a frontier node usually *couldn't* see the next deposit along, so
 * chains dead-ended and expansion stalled at a hard ceiling even with roads
 * still being built. This clears that gap most of the time without simply
 * handing over the map.
 */
const CONNECTED_NODE_REACH = 780;
/**
 * Seconds (this world's "hours" are 1:1 with real seconds — see
 * `HOURS_PER_SECOND`) the founding population is propped up regardless of
 * what's actually being delivered — see `updatePopulation`'s
 * `foundingGraceRemaining`. Matches `stockFoundingReserves`'s reserve: the
 * same two minutes that reserve was sized to cover.
 */
const FOUNDING_GRACE_SECONDS = 120;

export interface WorldConfig {
  width: number;
  height: number;
  village: { name: string; x: number; y: number };
  startingPopulation: number;
  /** Everything about the generated world — terrain and resource placement alike — is a pure function of this. */
  seed: number;
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
  readonly terrain: TerrainField;
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

  private readonly transport = new TransportSystem();
  private readonly workforce = new WorkforceSystem();
  private readonly workerDelivery = new WorkerDeliverySystem();
  private readonly migration = new MigrationSystem();
  private readonly industry = new IndustrySystem();
  private readonly emergence = new SettlementSystem();
  private readonly generator: WorldGenerator;

  private events: WorldEvent[] = [];
  private routeCache = new Map<ResourceNode, Route | null>();
  private cachedVersion = -1;
  private nextVillagerId = 1;
  private nextSettlementId = 1;
  private populationTimer = 0;
  private pruneTimer = 0;
  private wearRefreshTimer = 0;
  private generationTimer = 0;
  private villageTier: Tier;
  private readonly settlementTiers = new Map<number, Tier>();
  private readonly nodeLevels = new Map<number, number>();
  /**
   * How many dependents the population currently owes itself, or has too
   * many of (negative). A shrink event can only ever safely remove whoever
   * is actually free (see `reconcilePopulation`), which is almost always a
   * dependent — there's rarely a genuinely idle non-dependent to take
   * instead — so every shrink that wanted to take a non-dependent but
   * couldn't banks the difference here, and `addVillager` leans the other
   * way at the next few births until it's paid back. Corrects the same
   * long-run drift a forced mid-job removal would, without ever touching
   * someone who's actually working.
   */
  private dependentDebt = 0;
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
    this.generator = new WorldGenerator(config.seed);
    this.terrain = this.generator.terrain;
    this.traffic = new TrafficField(config.width, config.height);
    this.network.setWearLookup((points) => this.traffic.wearAlong(points));

    this.village = new Village(config.village.name, config.village.x, config.village.y);

    // Generate the ground under and around the village before anything else
    // touches it — `revealNodes` below, and every later query against
    // `this.terrain`, needs real ground to answer against, not empty space
    // waiting to be decided later. Same rule as every later expansion: the
    // village's own influence, plus the standing margin.
    this.generateAround(this.village.position, this.village.influenceRadius + GENERATION_MARGIN);
    this.ensureStartingResources();
    this.stockFoundingReserves(config.startingPopulation);
    this.foundingPopulation = config.startingPopulation;

    for (let i = 0; i < config.startingPopulation; i++) this.addVillager();
    // Nothing has been delivered yet, so start the target where the real
    // headcount already is rather than easing it down to zero on day one.
    this.populationTarget = config.startingPopulation;
    this.syncPopulation();
    this.villageTier = this.village.tier;

    this.revealNodes();
  }

  /**
   * Generation is otherwise entirely hands-off — the same as any other
   * seed's outcome, sparse or rich, weird or ordinary — except for this one
   * guarantee: a fresh village has to be able to reach *something* to eat
   * and *something* to build with, or the game is over before the player
   * has drawn a single road. See `WorldGenerator.ensureStartingResources`
   * and point 15 of the brief.
   */
  private ensureStartingResources(): void {
    const summary = this.nodes.map((n) => ({ resource: n.resource, x: n.position.x, y: n.position.y }));
    const forced = this.generator.ensureStartingResources(this.village.position, summary, STARTING_RESOURCE_REACH);
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
  private generateAround(centre: Vec2, radius: number): void {
    const x0 = Math.max(0, centre.x - radius);
    const y0 = Math.max(0, centre.y - radius);
    const x1 = Math.min(this.width, centre.x + radius);
    const y1 = Math.min(this.height, centre.y + radius);
    const created = this.generator.ensureNodesGenerated(x0, y0, x1, y1);
    for (const cfg of created) this.nodes.push(new ResourceNode(cfg));

    this.uncoverGround(centre, radius, x0, y0, x1, y1);
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
    for (const centre of this.influenceCentres()) {
      this.generateAround(centre.position, centre.reach + GENERATION_MARGIN);
    }
  }

  /**
   * Everywhere the civilisation currently reaches from, and how far. The
   * village, every settlement that has taken hold, and every node the road
   * network actually reaches — a civilisation expands from all of them at
   * once, not just from wherever it started.
   *
   * A *connected* node counts for `CONNECTED_NODE_REACH` whether or not it
   * has levelled up yet, and that is the safeguard against the frontier
   * closing. Previously a node opened ground only once its own level had
   * earned it some (level one gives exactly zero), so reach grew only with
   * tier — which needs development, which needs wealth, which needs the
   * industries and deposits that are on the far side of the frontier you
   * are trying to widen. A civilisation that plateaued below the next tier
   * could reach nothing new ever again, and no amount of road-building
   * helped, which is a miserable thing to be told by a game whose only verb
   * is building roads. Now a road out to a working site opens the country
   * around that site, so the player always has a move: reach a little
   * further, and see a little further.
   */
  private influenceCentres(): Array<{ position: Vec2; reach: number }> {
    return [
      { position: this.village.position, reach: this.village.influenceRadius },
      ...this.settlements
        .filter((s) => s.influenceRadius > 0)
        .map((s) => ({ position: s.position, reach: s.influenceRadius })),
      // Additive rather than whichever is larger: a node's own levelling-up
      // should push the frontier further than merely connecting it did, or
      // shipping investment out to a remote site buys nothing you can see.
      ...this.nodes
        .filter((n) => n.isConnected)
        .map((n) => ({ position: n.position, reach: CONNECTED_NODE_REACH + n.influenceRadius })),
    ];
  }

  // ---------------------------------------------------------------- queries

  get day(): number {
    return Math.floor(this.hours / HOURS_PER_DAY) + 1;
  }

  get visibleNodes(): ResourceNode[] {
    return this.nodes.filter((n) => n.isVisible);
  }

  /** Everything a road may start or end on right now. */
  get connectableSites(): Site[] {
    return [this.village, ...this.visibleNodes, ...this.settlements];
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

  /** Idle *and* actually available — a dependent can be idle forever without ever counting here. */
  idleCountAt(trader: Trader): number {
    return this.villagersAt(trader).filter((v) => v.isAvailable).length;
  }

  /** Labour capacity: everyone who isn't a dependent, whether currently employed or not. */
  workingPopulationAt(trader: Trader): number {
    return this.villagersAt(trader).filter((v) => !v.isDependent).length;
  }

  routeTo(node: ResourceNode): Route | null {
    this.refreshRoutes();
    return this.routeCache.get(node) ?? null;
  }

  /** The village or a visible node under a point, for hover and inspection. */
  siteAt(point: Vec2, slack = 12): Site | null {
    if (dist(this.village.position, point) <= this.village.radius + slack) return this.village;

    const node = this.visibleNodes.find((n) => dist(n.position, point) <= n.radius + slack);
    if (node) return node;

    return this.settlements.find((s) => dist(s.position, point) <= s.radius + slack) ?? null;
  }

  anchorAt(point: Vec2): Anchor | null {
    return this.network.anchorAt(point, this.connectableSites);
  }

  routeBetweenSites(from: Site, to: Site): Route | null {
    return this.network.routeBetween(from, to);
  }

  /** Roads cannot be laid across water; there are no bridges yet. */
  canLayAlong(points: Vec2[]): boolean {
    return !this.terrain.crossesImpassable(points);
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
      edge.difficulty = this.terrain.averageCost(edge.points);
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
    for (const trader of this.traders) {
      for (const ind of trader.industries) {
        const produced = ind.produce(dt);
        if (produced > 0) recordWealth(trader, BASE_VALUE[ind.resource] * produced);
      }
    }

    // Flat per-capita consumption was tried and reverted here: at today's
    // population scale it drains faster than production can keep up,
    // starving development instead of merely keeping storage honest. Only
    // genuine excess — stock a place is sitting on well past what it could
    // ever ask for — decays, so a settlement whose population (and so its
    // target) has shrunk back down can't coast on yesterday's peak forever.
    // Planks/stone blocks/tools are the exception — see `consumeProcessedGoods`.
    for (const trader of this.traders) {
      decayExcessStorage(trader, dt);
      consumeProcessedGoods(trader, dt);
    }

    this.traffic.decay(dt);
    this.emergence.update(dt, this.settlementContext());
    this.updatePopulation(dt);

    this.pruneTimer += dt;
    if (this.pruneTimer >= PRUNE_INTERVAL) {
      this.pruneTimer = 0;
      this.pruneAbandonedRoads();
      this.revealNodes();
    }
  }

  /** The stretch of road under a point, for hovering and erasing. */
  roadAt(point: Vec2): RoadEdge | null {
    const anchor = this.network.anchorAt(point, []);
    return anchor?.kind === 'edge' ? anchor.edge : null;
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
    this.traffic.deposit(route.points, WEAR_PER_TRIP, resource, amount);
  }

  /** How packed down a road is, averaged along it. */
  wearOf(edge: RoadEdge): number {
    return this.traffic.wearAlong(edge.points);
  }

  /**
   * Roads nobody walks fade away. Anything on a current route to a connected
   * site is spared, as is anything a villager is standing on, so this can only
   * ever remove the network the player has stopped using — never strand a
   * settlement that still depends on it.
   */
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
      if (this.traffic.weakestAlong(edge.points) >= ABANDON_BELOW) continue;

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
      routeBetweenSites: (from, to) => this.network.routeBetween(from, to),
      costAt: (point) => this.terrain.costAt(point) * wearEffort(this.traffic.wearAt(point)),
      recordTrip: (route, resource, amount) => this.recordTrip(route, resource, amount),
      emit: (event) => this.events.push(event),
    };
  }

  /** Recompute reachability whenever the network changed shape. */
  private refreshRoutes(): void {
    if (this.cachedVersion === this.network.version) return;
    this.cachedVersion = this.network.version;

    for (const node of this.nodes) {
      const route = node.isVisible ? this.network.routeBetween(this.village, node) : null;
      this.routeCache.set(node, route);
      if (!node.isVisible) continue;

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

  /** Nodes inside the civilisation's influence become visible and connectable. */
  private revealNodes(): void {
    // Every established place opens up the country around it, so the map is
    // unlocked by the network spreading rather than by the first village
    // alone — and it is the same set generation works from (see
    // `influenceCentres`), so nothing can ever be revealed before it exists.
    const centres = this.influenceCentres();

    for (const node of this.nodes) {
      if (node.state !== NodeState.Hidden) continue;
      if (!centres.some((c) => dist(node.position, c.position) <= c.reach)) continue;

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
    for (const trader of this.traders) {
      decayThroughput(trader, dt);
      decayWealthIncome(trader, dt);
      advanceDevelopment(trader, dt);
      advanceHousing(trader, dt);
    }

    // Food decides how many people the civilisation *could* feed; housing
    // decides how many it actually has room for. Capping the target by
    // whichever is smaller is what makes a full village actually work on
    // more housing instead of just piling up population nobody has
    // anywhere to put — see `housing.ts`'s `advanceHousing`, which only
    // spends wood once a place is genuinely at its own capacity.
    // Food decides how many people the civilisation *could* feed; housing
    // decides how many it actually has room for, in aggregate — capping the
    // total by whichever is smaller is what makes a civilisation sitting at
    // its housing ceiling actually work on more of it (see `advanceHousing`,
    // which only spends wood once a place is genuinely at its own capacity)
    // instead of just piling up population nobody has anywhere to put.
    // This stays a civilisation-wide throttle, not a per-place hard block:
    // an earlier version also refused to let a worker *settle* at a specific
    // full place (keeping their old home instead), which sounded harmless
    // but destabilised the whole economy — small, ordinary population dips
    // at a young settlement could no longer be answered by settling new
    // people there, and once combined with the one-time settlement
    // "bootstrap" priority (see `systems.ts`) already having fired, nothing
    // ever bootstrapped it again. A soft, civilisation-wide ceiling gets the
    // same "growth needs housing" feel without that specific failure mode.
    const totalSustainable = this.traders.reduce((sum, trader) => sum + sustainablePopulation(trader), 0);
    const totalHousing = this.traders.reduce((sum, trader) => sum + housingCapacity(trader), 0);
    // `sustainablePopulation` is deliberately throughput-only — not stock —
    // so a place that stops actually being fed can't hide behind a shelf
    // that (by design, see `economy.ts`'s `consume`) never depletes on its
    // own. That's exactly right once the game is under way, but it also
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
    // already out on the roads leaves — and a free dependent goes first, the
    // same way one gets added first on the way up (see `addVillager`), so
    // shrinking doesn't quietly grind the labour force down to nothing while
    // dependents (who were never doing anything anyway) pile up untouched.
    //
    // Forcibly retiring a *working* non-dependent instead, to correct the
    // ratio the moment it drifts, was tried and reverted: it fixes the
    // ratio but at the cost of the very production that population depends
    // on, and pulling a farm or mine worker out mid-shortage can tip
    // `sustainablePopulation` itself downward, which shrinks the target
    // further, which pulls another worker — a real death spiral, not a
    // cosmetic one, over something that was only ever a bookkeeping
    // imbalance. Correcting it has to stay confined to people who aren't
    // doing anything, which then only leaves dependents to take almost
    // every time — see `dependentDebt` for how the *next* births pay that
    // back instead.
    const pool = [...this.villagers].reverse();
    const leaving = pool.find((v) => v.isFree && v.isDependent) ?? pool.find((v) => v.isFree);
    if (!leaving) return;
    if (leaving.isDependent) this.dependentDebt--;
    else this.dependentDebt++;
    const index = this.villagers.indexOf(leaving);
    this.villagers.splice(index, 1);
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
    this.revealNodes();
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

  /** New people default to the founding village; migration redistributes them from there. */
  private addVillager(home: Trader = this.village): Villager {
    // Decided against the actual running ratio, not a coin flip per person —
    // a coin flip can unluckily leave a tiny starting population with no
    // workers at all, an unrecoverable dead end this game avoids on purpose.
    // Comparing against the count *after* this birth keeps the fraction
    // pinned close to the target at every population size, including one.
    // `dependentDebt` folds in on top of the plain target: a run of
    // shrink events that could only ever safely take a dependent (see
    // `reconcilePopulation`) leans the next few births toward a
    // non-dependent instead, and vice versa, so the ratio a shrink couldn't
    // hit gets paid back at the next opportunity rather than staying lost.
    const totalAfter = this.villagers.length + 1;
    const targetDependents = Math.round(totalAfter * (1 - WORKING_POPULATION_SHARE)) - this.dependentDebt;
    const currentDependents = this.villagers.filter((v) => v.isDependent).length;
    const isDependent = currentDependents < targetDependents;
    if (isDependent && this.dependentDebt < 0) this.dependentDebt++;
    else if (!isDependent && this.dependentDebt > 0) this.dependentDebt--;

    const villager = new Villager(this.nextVillagerId++, home, isDependent);
    villager.restAtHome();
    this.villagers.push(villager);
    return villager;
  }
}
