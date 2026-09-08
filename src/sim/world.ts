import { dist, type Vec2 } from './geometry';
import { ResourceNode, type ResourceNodeConfig } from './resourceNode';
import { RoadNetwork, type Anchor, type RoadEdge, type Route, type Site } from './roadNetwork';
import { TerrainGrid, type TerrainBrush } from './terrain';
import { WEAR_ON_BUILD, WEAR_PER_TRIP, WearField } from './wear';
import { TransportSystem, WorkforceSystem, type SimContext } from './systems';
import { NodeState, ResourceType, type WorldEvent } from './types';
import { Village } from './village';
import { Villager } from './villager';

/** Seconds a drawn road takes to finish drawing itself in. */
const ROAD_BUILD_TIME = 0.45;
/** In-game hours per real second. */
const HOURS_PER_SECOND = 1;
const HOURS_PER_DAY = 24;
/** Seconds between births, while there is food and room. */
const BIRTH_INTERVAL = 9;
const FOOD_PER_BIRTH = 3;
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
  readonly wear: WearField;

  hours = 0;

  private readonly transport = new TransportSystem();
  private readonly workforce = new WorkforceSystem();

  private events: WorldEvent[] = [];
  private routeCache = new Map<ResourceNode, Route | null>();
  private cachedVersion = -1;
  private nextVillagerId = 1;
  private growthTimer = 0;
  private pruneTimer = 0;

  constructor(config: WorldConfig) {
    this.width = config.width;
    this.height = config.height;
    this.terrain = new TerrainGrid(config.width, config.height, config.terrain);
    this.wear = new WearField(config.width, config.height);

    this.village = new Village(config.village.name, config.village.x, config.village.y);
    for (const cfg of config.nodes) this.nodes.push(new ResourceNode(cfg));

    for (let i = 0; i < config.startingPopulation; i++) this.addVillager();

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
    return [this.village, ...this.visibleNodes];
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
    return this.visibleNodes.find((n) => dist(n.position, point) <= n.radius + slack) ?? null;
  }

  anchorAt(point: Vec2): Anchor | null {
    return this.network.anchorAt(point, this.connectableSites);
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
      this.wear.deposit(edge.points, WEAR_ON_BUILD);
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

    for (const node of this.nodes) node.produce(dt);

    this.wear.decay(dt);
    this.grow(dt);
    this.tryLevelUp();

    this.pruneTimer += dt;
    if (this.pruneTimer >= PRUNE_INTERVAL) {
      this.pruneTimer = 0;
      this.pruneAbandonedRoads();
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

  /** A delivery has arrived: wear the ground the whole way back. */
  private recordTrip(route: Route): void {
    for (const edge of route.edges) edge.usage++;
    this.wear.deposit(route.points, WEAR_PER_TRIP);
  }

  /** How packed down a road is, averaged along it. */
  wearOf(edge: RoadEdge): number {
    return this.wear.along(edge.points);
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
      if (this.wear.weakestAlong(edge.points) >= ABANDON_BELOW) continue;

      this.network.abandon(edge);
      this.events.push({ type: 'roadLost', points: edge.points.map((p) => ({ ...p })) });
    }
  }

  private context(): SimContext {
    return {
      village: this.village,
      nodes: this.nodes,
      routeTo: (node) => this.routeTo(node),
      costAt: (point) => this.terrain.costAt(point),
      recordTrip: (route) => this.recordTrip(route),
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
    const reach = this.village.influenceRadius;

    for (const node of this.nodes) {
      if (node.state !== NodeState.Hidden) continue;
      if (dist(node.position, this.village.position) > reach) continue;

      node.state = NodeState.Reachable;
      this.events.push({ type: 'discovered', at: { ...node.position }, name: node.name });
    }
  }

  private grow(dt: number): void {
    if (this.village.population >= this.village.populationCap) {
      this.growthTimer = 0;
      return;
    }

    this.growthTimer += dt;
    if (this.growthTimer < BIRTH_INTERVAL) return;
    if (this.village.storage[ResourceType.Food] < FOOD_PER_BIRTH) return;

    this.village.storage[ResourceType.Food] -= FOOD_PER_BIRTH;
    this.growthTimer = 0;
    const villager = this.addVillager();
    this.events.push({ type: 'villagerBorn', at: { ...villager.position } });
  }

  private tryLevelUp(): void {
    const cost = this.village.nextLevelCost;
    if (!cost || !this.village.canAfford(cost)) return;

    this.village.spend(cost);
    this.village.level++;
    this.events.push({
      type: 'levelUp',
      at: { ...this.village.position },
      level: this.village.level,
    });

    this.revealNodes();
    // New nodes may now be reachable, and older roads may already touch them.
    this.cachedVersion = -1;
    this.refreshRoutes();
  }

  private addVillager(): Villager {
    const villager = new Villager(this.nextVillagerId++, this.village);
    villager.restAtHome();
    this.village.villagers.push(villager);
    return villager;
  }
}
