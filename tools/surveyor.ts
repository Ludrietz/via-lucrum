/**
 * A stand-in for a thoughtful player, for headless playtesting.
 *
 * The point of this file is *not* to be an AI that beats the game. It is to
 * exercise the simulation the way a real player's network would: roads that
 * follow the cheap ground, branch off whatever is already built rather than
 * radiating from the village, and therefore pack traffic into a few trunks
 * with spurs hanging off them. A straight line from the village to every
 * node — the obvious thing to script — produces a starburst no player would
 * ever draw, and a starburst never tests the parts of this simulation
 * (wear-based routing, junction-driven settlement emergence, corridor
 * traffic) that only a real network exercises.
 */

import { dist, type Vec2 } from '../src/sim/geometry';
import type { ResourceNode } from '../src/sim/resourceNode';
import { BRIDGE_COST, CELL_SIZE, TERRAIN_COSTS, TerrainType } from '../src/sim/terrain';
import { ResourceType, VillagerRole } from '../src/sim/types';
import type { World } from '../src/sim/world';
import { shortage } from '../src/sim/economy';

/** Cells this far (in cells) from open water are penalised, so a smoothed road rarely clips a shore. */
const WATER_CLEARANCE = 1;
/**
 * How much dearer a cell beside water is. Steeper than mountains (3.2), so a
 * route round a pond always beats a route along its edge — but finite, so a
 * gap between two ponds is a hard road rather than a wall.
 */
const SHORE_PENALTY = 5;
/** Give up on a target rather than expand forever; a player would too. */
const MAX_EXPANSIONS = 45_000;
/** How far outside the box holding the network and its goals the search may wander. */
const SEARCH_MARGIN = 1400;
/** Haul distance at which a site is worth roughly half as much to connect. */
const HAUL_REFERENCE = 700;
/**
 * Share of the workforce out carrying at which a careful player stops
 * connecting new sites. Above the equilibrium the labour market itself
 * settles at (`haulageDemand` lets logistics take up to half the workforce),
 * or the gate trips permanently and the player simply stops playing: at 0.45
 * a measured run froze at nine connected sites and twenty-five residents for
 * eighty days. This is meant to catch genuine over-extension, not ordinary
 * operation.
 */
const STRAIN_LIMIT = 0.62;
/** How long a measured player will hold capacity back waiting for a better offer. */
const PATIENCE_SECONDS = 90;
/** How much better the offer worth waiting for has to be than the one already affordable. */
const WAIT_MARGIN = 1.3;
/** Connected sources of a good past which a shortage is a transport problem, not a supply one. */
const ESTABLISHED_SOURCES = 2;
/** How much a squared scarcity term is allowed to outweigh mere convenience. */
const SCARCITY_WEIGHT = 2.5;
/** Compass sectors the stand-in player thinks of the country in, when scouting. */
const SCOUT_SECTORS = 8;
/** How far past the end of the network a scouting track is run. */
const SCOUT_DISTANCE = 900;

/** Which sector of the compass a point lies in, seen from somewhere. */
function bearingSector(point: Vec2, from: Vec2, sectors: number): number {
  const angle = Math.atan2(point.y - from.y, point.x - from.x);
  return Math.floor((((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * sectors);
}

interface Cell {
  col: number;
  row: number;
}

const key = (col: number, row: number): number => (col + 32768) * 65536 + (row + 32768);

/** Tiny binary heap; the grid searches here expand tens of thousands of cells. */
class Heap {
  private readonly items: Array<{ k: number; f: number }> = [];

  get size(): number {
    return this.items.length;
  }

  push(k: number, f: number): void {
    this.items.push({ k, f });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].f <= this.items[i].f) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  pop(): { k: number; f: number } | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.items[l].f < this.items[smallest].f) smallest = l;
        if (r < this.items.length && this.items[r].f < this.items[smallest].f) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

export interface SurveyorOptions {
  /** Sim-seconds between two roads being drawn. A player is not a build queue. */
  roadInterval: number;
  /**
   * 'greedy' connects whatever is nearest and cheapest, the way a player who
   * wants the map open does. 'measured' only connects a site whose good the
   * civilisation actually wants, which is the disciplined play.
   */
  policy: 'greedy' | 'measured';
  /** Log every road drawn. */
  verbose?: boolean;
}

export interface RoadRecord {
  hours: number;
  target: string;
  /** Null for a scouting track, which is drawn toward country rather than toward a good. */
  resource: ResourceType | null;
  length: number;
  /** True when the road left an existing road rather than a site — a genuine branch. */
  branched: boolean;
}

export interface ClaimRecord {
  hours: number;
  name: string;
  resource: ResourceType;
  cost: number;
}

export class Surveyor {
  readonly roads: RoadRecord[] = [];
  readonly claims: ClaimRecord[] = [];
  /** How many scouting tracks were run out into unknown country. */
  scouts = 0;
  /** When each compass sector was last scouted, so a failed heading is not retried forever. */
  private readonly scouted = new Map<number, number>();
  private timer = 0;
  /** Targets that could not be pathed to; not worth re-pathing every planning tick. */
  private readonly refused = new Set<number>();
  private refusedClearedAt = 0;
  /**
   * The terrain grid this world is actually laid out on. The pathfinder
   * below indexes terrain cells directly, so it has to agree with the
   * terrain about how big one is — assuming the procedural constant made
   * every cell of an imported map read as off-map water, and no road was
   * ever drawn again.
   */
  private cellSize = CELL_SIZE;

  constructor(private readonly options: SurveyorOptions) {}

  update(world: World, dt: number): void {
    this.timer += dt;
    if (this.timer < this.options.roadInterval) return;
    this.timer = 0;
    this.cellSize = world.terrain.cellSize;

    // Ground opens up over time, so a site that could not be reached an hour
    // ago may well be reachable now. Forget refusals periodically.
    if (world.hours - this.refusedClearedAt > 200) {
      this.refused.clear();
      this.refusedClearedAt = world.hours;
    }

    this.considerExpansion(world);
    if (!this.drawOneRoad(world)) this.scout(world);
  }

  /**
   * Run a track out toward country the realm knows nothing about.
   *
   * A real player does this constantly and the stand-in never did: it only
   * ever drew roads to *claimed, unconnected* sites, so every stretch of road
   * in a playtest ran between two things the realm already owned. That made
   * the harness structurally blind to half of what roads are for. Nothing
   * ever tested whether a road opens country (`survey.ts`), nothing ever
   * tested what becomes of a track across ground nobody holds
   * (`World.abandonThreshold`), and a change to either could read as a
   * perfect no-op across every seed — as both did, byte for byte, until this
   * existed.
   *
   * The heading is chosen the way a player picks one: the compass sector the
   * realm currently knows least about, biased by where there is already a
   * road to branch from, so a scouting track extends the network rather than
   * striking out from the capital every time.
   */
  private scout(world: World): boolean {
    // Only worth doing when there is genuinely nothing better to build, and
    // only if the realm is not already drowning in road it cannot walk.
    if (this.strained(world)) return false;

    const centre = world.village.position;
    const known = new Array<number>(SCOUT_SECTORS).fill(0);
    for (const node of world.nodes) {
      if (!node.isVisible) continue;
      known[bearingSector(node.position, centre, SCOUT_SECTORS)]++;
    }

    // Least-known sector first; ties broken toward whichever the realm has
    // not tried lately, so a scout that fails on impassable ground does not
    // retry the same heading forever.
    const order = known
      .map((count, sector) => ({ sector, count, tried: this.scouted.get(sector) ?? -Infinity }))
      .sort((a, b) => a.count - b.count || a.tried - b.tried);

    const sources = this.networkSources(world);
    if (sources.size === 0) return false;

    for (const { sector } of order.slice(0, 3)) {
      const angle = ((sector + 0.5) / SCOUT_SECTORS) * Math.PI * 2;
      // Far enough past the border that the corridor surveys new country, not
      // ground a claim already sees.
      const from = [...sources.values()].reduce((a, b) =>
        Math.cos(angle) * (b.x - centre.x) + Math.sin(angle) * (b.y - centre.y) >
        Math.cos(angle) * (a.x - centre.x) + Math.sin(angle) * (a.y - centre.y)
          ? b
          : a,
      );
      const target = {
        x: from.x + Math.cos(angle) * SCOUT_DISTANCE,
        y: from.y + Math.sin(angle) * SCOUT_DISTANCE,
      };
      if (target.x < 0 || target.y < 0 || target.x > world.width || target.y > world.height) continue;
      if (!world.terrain.isPassable(target)) continue;

      const reach = this.survey(world, sources, [{ id: -1, position: target }]);
      const found = reach.get(-1);
      this.scouted.set(sector, world.hours);
      if (!found || found.path.length < 2) continue;
      if (!world.buildRoad(found.path)) continue;

      let length = 0;
      for (let i = 1; i < found.path.length; i++) length += dist(found.path[i - 1], found.path[i]);
      this.roads.push({ hours: world.hours, target: 'scouting', resource: null, length, branched: true });
      this.scouts++;
      if (this.options.verbose) {
        // eslint-disable-next-line no-console
        console.log(`  day ${String(world.day).padStart(3)}  scout  branch -> sector ${sector}  ${Math.round(length)}u`);
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ expansion

  /**
   * Spend Expansion Capacity, or decide to keep saving.
   *
   * This is the decision the whole redesign exists to create, so the stand-in
   * player has to actually make it rather than grabbing whatever is cheapest
   * the instant it can afford it. Two things it weighs:
   *
   * - **What the realm is short of.** A timber offer is worth far more to a
   *   civilisation running out of firewood than a fourth quarry is.
   * - **Whether it is worth waiting.** If something substantially more useful
   *   is on offer and only a little further out of reach, a measured player
   *   banks capacity for it instead of spending on the nearest thing. That is
   *   precisely the "cheap useful resource now OR expensive strategic
   *   resource later" choice the design is after, and if the stand-in never
   *   makes it, the playtest never tests it.
   */
  private considerExpansion(world: World): void {
    const offers = world.frontier;
    if (offers.length === 0) return;

    // Ranked by what the realm actually needs, *not* by need-per-unit-cost.
    //
    // Value-per-capacity is the intuitive metric and it is the wrong one
    // here, because it is systematically biased by the two rules either side
    // of it. Generation deliberately puts stone and iron a long way out;
    // `expansionCost` deliberately charges for distance. So the dear offer is
    // dear precisely *because* it is the strategic one, and dividing by cost
    // hands the decision to whatever is near and ordinary at every level of
    // scarcity. Measured over a hundred and fifty days on seed 1234: forty-one
    // stone deposits generated, one ever claimed, the civilisation sitting at
    // a flat 1.00 stone shortage from day a hundred on — which freezes every
    // node at level one (stone is the upgrade material for forests and farms
    // alike) and leaves every masonry in the realm idle.
    //
    // Cost has not stopped mattering; it has been moved to where it belongs.
    // It decides what is *affordable*, and how long it is worth saving for —
    // which is precisely the "timber now, or hold out for the iron" decision
    // this system exists to create. A player who needs iron badly enough saves
    // up for it; they do not conclude that iron is bad value and buy a fourth
    // farm.
    const valued = offers.map((offer) => ({
      offer,
      value: this.appetite(world, offer.node.resource),
    }));
    valued.sort((a, b) => b.value - a.value);

    const best = valued[0];
    const affordable = valued.filter((v) => world.expansionCapacity >= v.offer.cost);
    if (affordable.length === 0) return;

    if (this.options.policy === 'greedy') {
      // Spend the moment it can: whatever is affordable and looks best now.
      world.claim(affordable[0].offer.node);
      this.recordClaim(world, affordable[0].offer.node, affordable[0].offer.cost);
      return;
    }

    // Measured: hold out for the best offer on the board if it is close
    // enough to be worth the wait, otherwise take the best thing affordable.
    const canAffordBest = world.expansionCapacity >= best.offer.cost;
    if (!canAffordBest) {
      const rate = world.capacityRate.total;
      const secondsAway = rate > 0 ? ((best.offer.cost - world.expansionCapacity) / rate) * 60 : Infinity;
      const worthWaiting = secondsAway < PATIENCE_SECONDS && best.value > affordable[0].value * WAIT_MARGIN;
      if (worthWaiting) return;
    }

    const pick = canAffordBest ? best : affordable[0];
    world.claim(pick.offer.node);
    this.recordClaim(world, pick.offer.node, pick.offer.cost);
  }

  private recordClaim(world: World, node: ResourceNode, cost: number): void {
    this.claims.push({ hours: world.hours, name: node.name, resource: node.resource, cost });
    if (this.options.verbose) {
      // eslint-disable-next-line no-console
      console.log(
        `  day ${String(world.day).padStart(3)}  CLAIM  ${node.name.padEnd(22)} ${node.resource.padEnd(6)} for ${cost}`,
      );
    }
  }

  // ------------------------------------------------------------- deciding

  /**
   * Whether the civilisation is already spending most of its people walking.
   * A network is not free to own: every connected site is trips somebody has
   * to keep making forever, so past a point the answer to "we're short of
   * wood" is not "connect another forest".
   */
  private strained(world: World): boolean {
    const total = world.villagers.length;
    if (total === 0) return true;
    const carrying = world.villagers.filter((v) => v.role === VillagerRole.Transporter).length;
    return carrying / total > STRAIN_LIMIT;
  }

  /** Genuinely short of something people cannot do without — food or timber. */
  private shortOfNecessities(world: World): boolean {
    for (const resource of [ResourceType.Food, ResourceType.Wood]) {
      if (Math.max(...world.traders.map((t) => shortage(t, resource))) > 0.4) return true;
    }
    return false;
  }

  /** How much the civilisation currently wants another source of this good. */
  /**
   * How badly the realm wants one more source of a good.
   *
   * The shortage term is deliberately *superlinear*. Offers are eventually
   * judged as value-per-capacity (`appetite / cost`), and the cost model
   * quite rightly charges for distance — while generation quite rightly puts
   * stone and iron a long way out, so that reaching them is a decision
   * rather than a formality. Those two correct rules multiply into an
   * incorrect player: a cheap farm next door beats a dear quarry three
   * thousand units away on value-per-capacity *at every level of scarcity*,
   * because the near thing is cheap in exact proportion to how ordinary it
   * is. Measured across a hundred and fifty days on seed 1234: fifteen
   * claims, seven of them food and one stone, with the civilisation sitting
   * at a flat 1.00 stone shortage from day a hundred onward and every
   * masonry in the realm idle for want of input.
   *
   * Squaring it says the thing a planning player actually believes: being
   * completely out of something is worth far more than twice being half out
   * of it. A good at full shortage is now worth roughly four times one at
   * half, which is enough to carry a distant quarry past a convenient farm
   * the realm does not really need.
   */
  private appetite(world: World, resource: ResourceType): number {
    const worst = Math.max(...world.traders.map((t) => shortage(t, resource)));
    // Even a comfortable good is worth a *little*: capacity built now feeds
    // a population that does not exist yet.
    const base = resource === ResourceType.Food ? 0.45 : resource === ResourceType.Wood ? 0.35 : 0.2;
    return base + worst * worst * SCARCITY_WEIGHT;
  }

  /*
   * Appetite is a *weight*, and only a weight. It used to also be an absolute
   * gate — a measured player refused to connect any site scoring under 0.5 —
   * and that gate quietly decided the outcome of every experiment run through
   * this harness, in the worst possible direction: it made the stand-in
   * player **stop playing when the economy was going well**.
   *
   * The bases are 0.2 for stone and iron, so a comfortable ore deposit scored
   * 0.2 + worst² × 2.5 and needed a realm-wide shortage of 0.35 just to be
   * considered. Any change that genuinely improved supply therefore pushed
   * shortages down, which switched off expansion, which looked in the report
   * exactly like the change had broken the game. Measured directly: the same
   * seed and the same days, with a change that lowered iron shortage from
   * 1.00 to 0.22, went from seventy-three connected deposits to
   * twenty-two — with two thousand Expansion Capacity banked and nothing
   * bought. The simulation was fine; the player had walked away.
   *
   * A harness whose stand-in player rewards scarcity is worse than no harness,
   * because its bias points the same way every time and it is invisible in the
   * columns. Appetite still steers *which* site is worth connecting next,
   * through the score below, and `strained` still catches genuine
   * over-extension — that one is a real judgement about the network, not about
   * whether the larder happens to be full this week.
   */

  private drawOneRoad(world: World): boolean {
    const targets = world.claimedNodes.filter((n) => !n.isConnected && !this.refused.has(n.id));
    const sources = this.networkSources(world);
    if (sources.size === 0) return false;

    if (targets.length === 0) return false;

    // One search, many candidates: expanding outward from the whole existing
    // network at once answers "where would I branch from, and how" for every
    // unconnected site in a single sweep, and does it in the same terms a
    // player eyeballs — cheap ground, short detour, reuse what's built.
    const reach = this.survey(world, sources, targets);

    let best: { node: ResourceNode; path: Vec2[]; cost: number; score: number } | null = null;
    for (const node of targets) {
      const found = reach.get(node.id);
      if (!found) {
        this.refused.add(node.id);
        continue;
      }

      const appetite = this.appetite(world, node.resource);
      // Already carrying everything it can: another site to service would
      // make the shortages worse, not better. This is the judgement a player
      // makes by looking at the map and seeing more road than traffic.
      //
      // It does *not* apply when the civilisation barely has this good at
      // all. "Short of wood with four forests connected" is a transport
      // problem and another forest makes it worse; "short of wood with no
      // forest connected" is a wood problem and another forest is the entire
      // answer. Without that distinction the rule deadlocks the opening, when
      // nearly everybody is out carrying by definition and nothing ever gets
      // connected at all.
      const sources = world.nodes.filter((n) => n.isConnected && n.resource === node.resource).length;
      if (this.options.policy === 'measured' && sources >= ESTABLISHED_SOURCES && this.strained(world)) continue;

      // Two different costs, and a player weighs both. Build cost is
      // terrain-weighted length — a short haul over hills can lose to a
      // longer one across the flat. Haul cost is how far the goods will have
      // to travel *forever after*, to the nearest place that can receive
      // them, and it is the one that decides whether connecting a site is
      // actually worth it: every trip down a long road is a villager not
      // doing anything else (see `haulageDemand` in `systems.ts`). A greedy
      // player ignores this and drowns in carrying; a measured one does not.
      let haul = Infinity;
      for (const trader of world.traders) haul = Math.min(haul, dist(node.position, trader.position));
      const haulPenalty = this.options.policy === 'measured' ? 1 + haul / HAUL_REFERENCE : 1;

      const score = appetite / (1 + found.cost / 900) / haulPenalty;
      if (!best || score > best.score) best = { node, path: found.path, cost: found.cost, score };
    }

    if (!best) return false;
    if (best.path.length < 2) return false;

    const branched = !this.isSiteHead(world, best.path[0]);
    if (!world.buildRoad(best.path)) {
      this.refused.add(best.node.id);
      return false;
    }

    let length = 0;
    for (let i = 1; i < best.path.length; i++) length += dist(best.path[i - 1], best.path[i]);
    this.roads.push({
      hours: world.hours,
      target: best.node.name,
      resource: best.node.resource,
      length,
      branched,
    });
    if (this.options.verbose) {
      const from = branched ? 'branch' : 'site  ';
      // eslint-disable-next-line no-console
      console.log(
        `  day ${String(world.day).padStart(3)}  road ${from} -> ${best.node.name.padEnd(22)} ${Math.round(length)
          .toString()
          .padStart(5)}u`,
      );
    }

    return true;
  }

  private isSiteHead(world: World, point: Vec2): boolean {
    for (const site of world.connectableSites) {
      if (dist(site.position, point) <= ('radius' in site ? site.radius : 24) + 10) return true;
    }
    return false;
  }

  // -------------------------------------------------------------- pathing

  /**
   * Every point the network can be joined at, mapped to the cell it sits in.
   * Sites *and* every sampled point along every road — joining a road
   * halfway along is what makes a branch a branch.
   */
  private networkSources(world: World): Map<number, Vec2> {
    const sources = new Map<number, Vec2>();

    const add = (point: Vec2) => {
      const k = key(Math.floor(point.x / this.cellSize), Math.floor(point.y / this.cellSize));
      if (!sources.has(k)) sources.set(k, point);
    };

    for (const site of world.connectableSites) {
      // Only sites the network can actually reach — an unconnected node is
      // not somewhere a player can start a road from and expect goods to flow.
      if ('isConnected' in site && !site.isConnected) continue;
      add(site.position);
    }
    for (const edge of world.network.edges) {
      for (const p of edge.points) add(p);
    }

    return sources;
  }

  /**
   * Multi-source Dijkstra over the terrain grid, from the whole existing
   * network outward, stopping once every target has been reached.
   *
   * Sources start at zero cost, which is the whole trick: running *along* an
   * existing road is free, so the cheapest way to a far-off deposit is
   * "follow the trunk, then cut across" rather than "strike out from the
   * village". That is what grows highways with spurs instead of a starburst,
   * and it falls out of the cost model rather than being scripted.
   */
  private survey(
    world: World,
    sources: Map<number, Vec2>,
    targets: ReadonlyArray<{ id: number; position: Vec2 }>,
  ): Map<number, { path: Vec2[]; cost: number }> {
    const best = new Map<number, number>();
    const from = new Map<number, number>();
    const open = new Heap();

    for (const [k] of sources) {
      best.set(k, 0);
      open.push(k, 0);
    }

    const wanted = new Map<number, { id: number; position: Vec2 }>();
    for (const node of targets) {
      wanted.set(key(Math.floor(node.position.x / this.cellSize), Math.floor(node.position.y / this.cellSize)), node);
    }

    const found = new Map<number, { path: Vec2[]; cost: number }>();
    const costCache = new Map<number, number>();

    // Steered toward whichever goal is still outstanding, and fenced into a
    // box around the work. Plain Dijkstra out of every road at once is
    // correct but ruinous once the frontier is a few thousand units out — and
    // catastrophic when a goal turns out to be unreachable, since it then
    // expands every cell it can afford before giving up. The heuristic is
    // straight-line distance times the cheapest possible ground, so it never
    // overestimates and the paths stay optimal.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of [...sources.values(), ...targets.map((t) => t.position)]) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    minX -= SEARCH_MARGIN;
    minY -= SEARCH_MARGIN;
    maxX += SEARCH_MARGIN;
    maxY += SEARCH_MARGIN;

    const cheapest = TERRAIN_COSTS[TerrainType.Plains];
    const heuristic = (col: number, row: number): number => {
      const x = (col + 0.5) * this.cellSize;
      const y = (row + 0.5) * this.cellSize;
      let closest = Infinity;
      for (const target of targets) {
        if (found.has(target.id)) continue;
        closest = Math.min(closest, Math.hypot(target.position.x - x, target.position.y - y));
      }
      return Number.isFinite(closest) ? closest * cheapest : 0;
    };

    const cellCost = (col: number, row: number): number => {
      const k = key(col, row);
      const cached = costCache.get(k);
      if (cached !== undefined) return cached;

      // A river is crossable now, at a price — so the pathfinder prices it
      // rather than refusing it, and roads reach across the valley the way a
      // player would build them. Steeply dearer than `BRIDGE_COST` itself,
      // because a grid search would otherwise happily slide a road *along* a
      // river for a dozen cells to save a detour, and `canLayAlong` would
      // then throw the whole proposal out. Making the crossing expensive per
      // cell means the search naturally takes the narrowest one it can find,
      // which is where a bridge belongs.
      const type = world.terrain.typeAtCell(col, row);
      let cost = type === TerrainType.Water ? BRIDGE_COST * 2.5 : TERRAIN_COSTS[type];
      if (type !== TerrainType.Water) {
        // Stay off the waterline where there is any choice: the network
        // smooths a drawn path into a spline afterwards, and a road that hugs
        // a shore can bulge across it and be rejected. A player leaves
        // themselves the same margin.
        //
        // A *preference*, not a prohibition — it used to be `Infinity`, which
        // is a different claim entirely: that no road may ever pass within a
        // cell of water. That held up on procedural maps, where water comes in
        // big blobs you can simply walk around, and fell apart on the first
        // real one. The country around Kutná Hora is dotted with fishponds a
        // cell or two across; at 1.5% water, a hard margin closed 7.6% of the
        // map to roads, and the woodlot the village is founded with sat inside
        // it. The village could see its timber and could never build to it,
        // and died on day 21.
        //
        // Whether a road is genuinely impossible is the simulation's call, not
        // this file's — `canLayAlong` already answers it, and a proposal it
        // rejects costs nothing but one refused target.
        outer: for (let dy = -WATER_CLEARANCE; dy <= WATER_CLEARANCE; dy++) {
          for (let dx = -WATER_CLEARANCE; dx <= WATER_CLEARANCE; dx++) {
            if (world.terrain.typeAtCell(col + dx, row + dy) === TerrainType.Water) {
              cost *= SHORE_PENALTY;
              break outer;
            }
          }
        }
      }
      costCache.set(k, cost);
      return cost;
    };

    let expansions = 0;
    while (open.size > 0 && found.size < wanted.size && expansions < MAX_EXPANSIONS) {
      const top = open.pop();
      if (!top) break;
      const g = best.get(top.k);
      if (g === undefined) continue;
      expansions++;

      const col = Math.floor(top.k / 65536) - 32768;
      const row = (top.k % 65536) - 32768;

      const target = wanted.get(top.k);
      if (target && !found.has(target.id)) {
        found.set(target.id, { path: this.reconstruct(top.k, from, sources, target.position), cost: g });
      }

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nc = col + dx;
          const nr = row + dy;
          const cost = cellCost(nc, nr);
          if (!Number.isFinite(cost)) continue;

          const x = (nc + 0.5) * this.cellSize;
          const y = (nr + 0.5) * this.cellSize;
          if (x < minX || x > maxX || y < minY || y > maxY) continue;

          const step = Math.hypot(dx, dy) * this.cellSize * cost;
          const nk = key(nc, nr);
          const next = g + step;
          if (next >= (best.get(nk) ?? Infinity)) continue;
          best.set(nk, next);
          from.set(nk, top.k);
          open.push(nk, next + heuristic(nc, nr));
        }
      }
    }

    return found;
  }


  /** Walk the came-from chain back to the road it left, then straighten it. */
  private reconstruct(
    endKey: number,
    from: Map<number, number>,
    sources: Map<number, Vec2>,
    endPoint: Vec2,
  ): Vec2[] {
    const cells: Cell[] = [];
    let cursor: number | undefined = endKey;
    let head: Vec2 | null = null;

    while (cursor !== undefined) {
      const source = sources.get(cursor);
      if (source) {
        // Pin the first point to the road itself, not the cell centre, so the
        // game's own anchor lookup actually finds something to weld onto.
        head = source;
        break;
      }
      cells.push({ col: Math.floor(cursor / 65536) - 32768, row: (cursor % 65536) - 32768 });
      cursor = from.get(cursor);
    }

    cells.reverse();
    const points: Vec2[] = [];
    if (head) points.push({ ...head });
    for (const c of cells) points.push({ x: (c.col + 0.5) * this.cellSize, y: (c.row + 0.5) * this.cellSize });
    points[points.length - 1] = { ...endPoint };

    return points;
  }
}
