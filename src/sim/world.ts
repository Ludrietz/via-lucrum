import { decayThroughput, easePopulation, sustainablePopulation, type Trader } from './economy';
import { dist, type Vec2 } from './geometry';
import { ResourceNode, type ResourceNodeConfig } from './resourceNode';
import { RoadNetwork, type Anchor, type RoadEdge, type Route, type Site } from './roadNetwork';
import { TerrainGrid, type TerrainBrush } from './terrain';
import { dominantGood, TrafficField, WEAR_ON_BUILD, WEAR_PER_TRIP } from './traffic';
import { Settlement, stageFor, tradeFor, type Trade } from './settlement';
import { SettlementSystem, type Candidate, type Origin, type SettlementContext } from './settlementSystem';
import { TransportSystem, WorkforceSystem, type SimContext } from './systems';
import { Tier, tierIndex } from './tier';
import { NodeState, ResourceType, type WorldEvent } from './types';
import { Village } from './village';
import { Villager } from './villager';
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
/** Seconds between sweeps for roads nobody is keeping up. */
const PRUNE_INTERVAL = 2;

export interface WorldConfig {
  width: number;
  height: number;
  village: { name: string; x: number; y: number };
  startingPopulation: number;
  terrain: TerrainBrush[];
  nodes: ResourceNodeConfig[];
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
  readonly terrain: TerrainGrid;
  readonly traffic: TrafficField;
  readonly settlements: Settlement[] = [];

  hours = 0;

  private readonly transport = new TransportSystem();
  private readonly workforce = new WorkforceSystem();
  private readonly workerDelivery = new WorkerDeliverySystem();
  private readonly emergence = new SettlementSystem();

  private events: WorldEvent[] = [];
  private routeCache = new Map<ResourceNode, Route | null>();
  private cachedVersion = -1;
  private nextVillagerId = 1;
  private nextSettlementId = 1;
  private populationTimer = 0;
  private pruneTimer = 0;
  private villageTier: Tier;
  private readonly settlementTiers = new Map<number, Tier>();

  constructor(config: WorldConfig) {
    this.width = config.width;
    this.height = config.height;
    this.terrain = new TerrainGrid(config.width, config.height, config.terrain);
    this.traffic = new TrafficField(config.width, config.height);

    this.village = new Village(config.village.name, config.village.x, config.village.y);
    for (const cfg of config.nodes) this.nodes.push(new ResourceNode(cfg));

    for (let i = 0; i < config.startingPopulation; i++) this.addVillager();
    // Nothing has been delivered yet, so start the target where the real
    // headcount already is rather than easing it down to zero on day one.
    this.village.populationTarget = config.startingPopulation;
    this.villageTier = this.village.tier;

    this.revealNodes();
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
    this.refreshRoutes();

    const ctx = this.context();
    this.workforce.update(dt, ctx);
    this.transport.update(dt, ctx);
    this.workerDelivery.update(dt, ctx);

    for (const node of this.nodes) node.produce(dt);

    // Ongoing per-capita consumption is disabled for now: with production
    // fixed, it competed with the village for the same stock it needs to
    // grow. Revisit once nodes can grow their own output — until then demand
    // still drives *where* goods go, it just doesn't also burn them.
    // for (const trader of this.traders) consume(trader, dt);

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
    for (const villager of this.village.villagers) {
      for (const edge of villager.route?.edges ?? []) inUse.add(edge);
    }

    for (const edge of [...this.network.edges]) {
      if (inUse.has(edge) || !edge.isBuilt) continue;
      if (this.traffic.weakestAlong(edge.points) >= ABANDON_BELOW) continue;

      this.network.abandon(edge);
      this.events.push({ type: 'roadLost', points: edge.points.map((p) => ({ ...p })) });
    }
  }

  private context(): SimContext {
    return {
      village: this.village,
      nodes: this.nodes,
      traders: this.traders,
      traffic: this.traffic,
      routeTo: (node) => this.routeTo(node),
      routeBetweenSites: (from, to) => this.network.routeBetween(from, to),
      costAt: (point) => this.terrain.costAt(point),
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

  /** Nodes inside the village's influence become visible and connectable. */
  private revealNodes(): void {
    // Every established place opens up the country around it, so the map is
    // unlocked by the network spreading rather than by the first village alone.
    const centres: Array<{ position: Vec2; reach: number }> = [
      { position: this.village.position, reach: this.village.influenceRadius },
      ...this.settlements
        .filter((s) => s.influenceRadius > 0)
        .map((s) => ({ position: s.position, reach: s.influenceRadius })),
    ];

    for (const node of this.nodes) {
      if (node.state !== NodeState.Hidden) continue;
      if (!centres.some((c) => dist(node.position, c.position) <= c.reach)) continue;

      node.state = NodeState.Reachable;
      this.events.push({ type: 'discovered', at: { ...node.position }, name: node.name });
    }
  }

  /**
   * Population, for the village and every settlement alike: a rolling read of
   * how much food is actually arriving eases each place's population toward
   * what that could sustain, and tier is just whichever rung that number
   * currently sits on. Nothing here is village-only — a settlement fed better
   * than Oakridge grows faster than Oakridge, full stop.
   */
  private updatePopulation(dt: number): void {
    for (const trader of this.traders) decayThroughput(trader, dt);

    this.village.populationTarget = easePopulation(
      this.village.populationTarget,
      sustainablePopulation(this.village),
      dt,
    );
    this.reconcileVillagePopulation(dt);

    for (const settlement of this.settlements) {
      settlement.population = Math.max(
        1,
        easePopulation(settlement.population, sustainablePopulation(settlement), dt),
      );
    }

    this.checkTierChanges();
  }

  /** The village's headcount is real villagers, so it moves one at a time. */
  private reconcileVillagePopulation(dt: number): void {
    const target = Math.round(this.village.populationTarget);
    if (this.village.population === target) {
      this.populationTimer = 0;
      return;
    }

    this.populationTimer += dt;
    if (this.populationTimer < POPULATION_STEP_INTERVAL) return;
    this.populationTimer = 0;

    if (this.village.population < target) {
      const villager = this.addVillager();
      this.events.push({ type: 'villagerBorn', at: { ...villager.position } });
      return;
    }

    // Only someone not already out on the roads leaves — the population
    // catches up with a shrinking food supply as people free up, not by
    // yanking anyone off a delivery mid-stride.
    const leaving = [...this.village.villagers].reverse().find((v) => v.isAvailable);
    if (!leaving) return;
    const index = this.village.villagers.indexOf(leaving);
    this.village.villagers.splice(index, 1);
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

  private addVillager(): Villager {
    const villager = new Villager(this.nextVillagerId++, this.village);
    villager.restAtHome();
    this.village.villagers.push(villager);
    return villager;
  }
}
