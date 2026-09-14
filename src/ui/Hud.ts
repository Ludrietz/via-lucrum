import {
  destinationsFor,
  economicActivity,
  exportableAmount,
  shortageAmount,
  sustainablePopulation,
  targetStock,
  wealthIncomePerMin,
  type Trader,
} from '../sim/economy';
import { developmentRate } from '../sim/development';
import type { Vec2 } from '../sim/geometry';
import { materialOnHand, totalWorks } from '../sim/construction';
import { hasRoomToBuild, housingCapacity } from '../sim/housing';
import { urbanityLabel } from '../sim/landUse';
import type { ResourceNode } from '../sim/resourceNode';
import type { GraphNode, Site } from '../sim/roadNetwork';
import { METRES_PER_UNIT } from '../sim/scale';
import { Settlement } from '../sim/settlement';
import { TERRAIN_LABELS } from '../sim/terrain';
import { TIER_LABELS, TIER_THRESHOLDS } from '../sim/tier';
import { dominantGood, ROAD_DEVELOPED, TRACKED_GOODS } from '../sim/traffic';
import { NodeState, ResourceType, SiteType, VillagerRole } from '../sim/types';
import { Village } from '../sim/village';
import type { World } from '../sim/world';
import { INDUSTRY_LABELS, RESOURCE_LABELS, SITE_LABELS, WORKER_LABELS, roadTierName } from '../render/theme';

const NODE_STATE_LABELS: Record<NodeState, string> = {
  [NodeState.Hidden]: 'UNKNOWN',
  [NodeState.Frontier]: 'BEYOND THE BORDER',
  [NodeState.Reachable]: 'NOT CONNECTED',
  [NodeState.Connected]: 'CONNECTED',
  [NodeState.Operational]: 'OPERATIONAL',
};

const RESOURCE_ORDER = [
  ResourceType.Wood,
  ResourceType.Food,
  ResourceType.Stone,
  ResourceType.Iron,
  ResourceType.Planks,
  ResourceType.StoneBlocks,
  ResourceType.Tools,
  ResourceType.Bread,
  ResourceType.Fittings,
];

/** Plain DOM HUD. Reads the world, never writes to it. */
export class Hud {
  private readonly day = document.getElementById('hud-day')!;
  private readonly inspect = document.getElementById('inspect')!;
  private readonly hint = document.getElementById('hint')!;
  private readonly capacity = document.getElementById('capacity')!;

  private hintFaded = false;
  /** What the inspect panel currently shows, so it is only rebuilt when it changes. */
  private lastInspectHtml = '';

  constructor(private readonly world: World) {
    // The claim button lives inside the inspect panel's innerHTML, which is
    // replaced wholesale whenever the panel changes — so the click is caught
    // by delegation on the container, which is not.
    this.inspect.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-claim]');
      if (!target) return;
      const id = Number(target.getAttribute('data-claim'));
      const node = this.world.nodes.find((n) => n.id === id);
      if (node) this.world.claim(node);
    });
  }

  update(focused: Site | null, roadPoint: Vec2 | null, junction: GraphNode | null = null): void {
    this.day.textContent = `DAY ${this.world.day}`;

    if (!this.hintFaded && this.world.network.edges.length > 0) {
      this.hintFaded = true;
      this.hint.classList.add('faded');
    }

    this.renderCapacity();
    this.renderInspect(focused, roadPoint, junction);
  }

  /**
   * Expansion Capacity, and where it is coming from.
   *
   * Shown as a standing readout rather than only on the frontier panel,
   * because it is the number the player is waiting on: the whole loop is
   * "watch the civilisation earn its next expansion, then decide where to
   * spend it", and that only works if the earning is visible while it
   * happens. The breakdown is there so a player can see *which* part of the
   * civilisation is buying their next province.
   */
  private renderCapacity(): void {
    const rate = this.world.capacityRate;
    const cheapest = this.world.frontier.reduce<number | null>(
      (best, c) => (best === null || c.cost < best ? c.cost : best),
      null,
    );

    const held = Math.floor(this.world.expansionCapacity);
    const toward = cheapest === null ? '' : ` / ${cheapest}`;
    const progress = cheapest === null ? 0 : Math.min(1, this.world.expansionCapacity / cheapest);

    this.capacity.innerHTML = `
      <div class="cap-label">EXPANSION CAPACITY</div>
      <div class="cap-value">${held}<span class="cap-target">${toward}</span></div>
      <div class="cap-track"><div class="cap-fill" style="width:${(progress * 100).toFixed(1)}%"></div></div>
      <div class="cap-rate">+${rate.total.toFixed(1)} / min</div>
      <div class="cap-breakdown">
        ${this.capRow('People', rate.population)}
        ${this.capRow('Prosperity', rate.prosperity)}
        ${this.capRow('Activity', rate.activity)}
      </div>`;
  }

  private capRow(label: string, value: number): string {
    return `<div class="cap-row"><span>${label}</span><span>+${value.toFixed(1)}</span></div>`;
  }

  private renderInspect(site: Site | null, roadPoint: Vec2 | null, junction: GraphNode | null): void {
    let html: string | null = null;

    if (site instanceof Village) html = this.villagePanel(site);
    else if (site instanceof Settlement) html = this.settlementPanel(site);
    else if (site && (site as ResourceNode).state === NodeState.Frontier) html = this.frontierPanel(site as ResourceNode);
    else if (site) html = this.nodePanel(site as ResourceNode);
    else if (junction) html = this.junctionPanel(junction);
    else if (roadPoint) html = this.roadPanel(roadPoint);

    if (!html) {
      this.inspect.classList.add('hidden');
      this.lastInspectHtml = '';
      return;
    }

    this.inspect.classList.remove('hidden');
    // Only rewrite when something actually changed. Replacing `innerHTML`
    // every frame would rebuild the claim button under the cursor sixty times
    // a second, which loses hover state and can swallow the click.
    if (html === this.lastInspectHtml) return;
    this.lastInspectHtml = html;
    this.inspect.innerHTML = html;
  }

  // ------------------------------------------------------------------ panels

  /** Who this trader's own residents are working as, by the resource they work. */
  private jobsPanel(trader: Trader): string {
    const byRole = new Map<SiteType, number>();
    for (const node of this.world.nodes) {
      const homeWorkers = node.workers.filter((w) => w.home === trader).length;
      if (homeWorkers > 0) byRole.set(node.type, (byRole.get(node.type) ?? 0) + homeWorkers);
    }
    return [...byRole.entries()].map(([type, count]) => this.row(WORKER_LABELS[type], String(count))).join('');
  }

  /** Every industry a trader runs, staffed or not — an empty one just reads as inert. */
  private industriesPanel(trader: Trader): string {
    const rows = trader.industries
      .map((ind) =>
        this.row(
          INDUSTRY_LABELS[ind.type],
          ind.exists
            ? `${ind.workers.length} / ${ind.workerCapacity}`
            : '<span class="note-inline">not built</span>',
        ),
      )
      .join('');
    return `<div class="note">INDUSTRIES</div><div class="stats">${rows}</div>`;
  }

  /** How many residents this place has room for right now, and whether it's crowded enough to be working on more. */
  private housingRow(trader: Trader): string {
    const capacity = housingCapacity(trader);
    const crowded = trader.population >= capacity * 0.8;
    const note = crowded ? 'building more room' : 'room to spare';
    return this.row('Housing', `${Math.floor(capacity)} <span class="note-inline">${note}</span>`);
  }

  /**
   * What this place has built, what it was built out of, and whether it is
   * currently going up or falling down.
   *
   * This is the panel that makes the whole processed economy legible. Before
   * it, a player watching planks arrive had no way to see what became of them
   * — the goods vanished into a per-capita appetite and reappeared, much
   * later and much transformed, as a tier label. `Built in` is the reward for
   * running a sawmill stated in one line: a place built of plank and dressed
   * stone is grander for the same acreage and needs mending half as often.
   */
  private builtPanel(trader: Trader): string {
    const standing = trader.dwellings + totalWorks(trader);
    const rate = trader.fabricRate * 24;
    const trend = rate > 0.2 ? 'BUILDING' : rate < -0.2 ? 'FALLING DOWN' : 'HOLDING';
    const material = materialOnHand(trader);
    const quality =
      trader.fabricQuality >= 0.66
        ? 'dressed stone &amp; sawn plank'
        : trader.fabricQuality >= 0.33
          ? 'part worked, part rough'
          : 'log and rubble';
    const wanting =
      trader.buildAppetite > 0.05 && material < 1
        ? ' <span class="need">wants material</span>'
        : '';

    return `<div class="note">BUILT</div><div class="stats">
      ${this.row('Standing', `${Math.round(standing)} <span class="note-inline">${trend} ${rate >= 0 ? '+' : ''}${rate.toFixed(1)}/day</span>`)}
      ${this.row('Built in', `<span class="note-inline">${quality}</span>`)}
      ${this.row('Materials', `${Math.round(material)}${wanting}`)}
      ${this.bar('Wants to build', trader.buildAppetite, true)}
    </div>`;
  }

  /**
   * The ground a place actually sits on, and what the country around it is
   * letting it become.
   *
   * Three facts, in the order they cause each other: how much it has laid out,
   * whether it has anywhere left to lay out (the one thing that can stop its
   * housing growing), and what it has therefore turned into. Without this the
   * land system would be invisible except as an unexplained ceiling on
   * population, which is exactly the kind of correct-but-unreadable number
   * this game is supposed to refuse.
   */
  private landPanel(trader: Trader): string {
    const { ground } = trader;
    const cellSize = this.world.terrain.cellSize;
    const held = hectares(ground.area(cellSize));
    const wanted = hectares(ground.targetArea);
    const roomNote = !hasRoomToBuild(trader)
      ? '<span class="need">no room to build</span>'
      : ground.satisfaction(cellSize) < 0.95
        ? '<span class="note-inline">laying out more</span>'
        : '<span class="note-inline">settled</span>';

    return `<div class="note">LAND</div><div class="stats">
      ${this.row('Held', `${held} ha <span class="note-inline">of ${wanted}</span> ${roomNote}`)}
      ${this.row('Room around', `${Math.round(trader.hinterland.openness * 100)}% <span class="note-inline">open &middot; ${Math.round(trader.hinterland.worked * 100)}% worked</span>`)}
      ${this.bar(urbanityLabel(trader.urbanity), trader.urbanity, true)}
    </div>`;
  }

  /** Wealth: the running total, and how fast it's currently coming in — what tier now actually tracks. */
  private wealthPanel(trader: Trader): string {
    const income = wealthIncomePerMin(trader);
    return `<div class="stats">${this.row('Wealth', `${Math.round(trader.wealth)} <span class="note-inline">${income >= 0 ? '+' : ''}${income.toFixed(1)}/min</span>`)}</div>`;
  }

  private villagePanel(village: Village): string {
    const jobs = this.jobsPanel(village);
    const sustainable = Math.round(sustainablePopulation(village));

    return `
      <div class="name">${village.name.toUpperCase()}</div>
      <div class="meta">${TIER_LABELS[village.tier]}</div>
      <div class="stats">
        ${this.row('Population', `${village.population} <span class="note-inline">sustainable ~${sustainable}</span>`)}
        ${this.housingRow(village)}
        ${jobs}
        ${this.row('Available', String(this.world.idleCountAt(village)))}
        ${this.row('Transporters', String(this.world.transporterCountAt(village)))}
        ${this.row('Holds', `${village.footprintRadius} <span class="note-inline">of the realm's ground</span>`)}
      </div>
      <div class="divider"></div>
      ${this.landPanel(village)}
      <div class="divider"></div>
      ${this.developmentPanel(village)}
      ${this.wealthPanel(village)}
      <div class="stats">${this.bar('Economy', economicActivity(village), true)}</div>
      <div class="divider"></div>
      ${this.builtPanel(village)}
      <div class="divider"></div>
      ${this.industriesPanel(village)}
      <div class="divider"></div>
      ${this.traderStats(village)}
      ${this.tradePanel(village)}`;
  }

  /**
   * The tier bar: how close this place is to its next rung. Development is
   * standing built fabric now (see `development.ts`), so this bar and the
   * BUILT panel above are two readings of one fact — which is the point. A
   * place climbs because it put something up, and the panel says what.
   */
  private developmentPanel(trader: Trader): string {
    const tierIndex = TIER_THRESHOLDS.findIndex((step) => step.tier === trader.tier);
    const current = TIER_THRESHOLDS[tierIndex].threshold;
    const next = TIER_THRESHOLDS[tierIndex - 1] ?? null;

    const progress = next ? (trader.development - current) / (next.threshold - current) : 1;
    const rate = developmentRate(trader) * 24;
    const trend = rate > 0.2 ? 'RISING' : rate < -0.2 ? 'FALLING' : 'STEADY';

    return `<div class="stats">
      ${this.bar('Development', progress, true)}
      ${this.row('Trend', `${trend} <span class="note-inline">${rate >= 0 ? '+' : ''}${rate.toFixed(1)}/day</span>`)}
    </div>`;
  }

  /**
   * Stock against target for one place — used for the village and every
   * settlement alike, because as far as the economy is concerned they are
   * the same kind of thing. A settlement above its comfortable buffer is a
   * source other places can draw on; well below it, it's the one drawing.
   */
  private traderStats(trader: Trader): string {
    const rows = RESOURCE_ORDER.map((resource) => {
      const stock = Math.round(trader.storage[resource]);
      const target = Math.round(targetStock(trader, resource));
      const surplus = exportableAmount(trader, resource);
      const short = shortageAmount(trader, resource);

      let tag = '';
      if (surplus >= 1) tag = ` <span class="need done">+${Math.round(surplus)}</span>`;
      else if (short >= 1) tag = ` <span class="need">&minus;${Math.round(short)}</span>`;

      return this.row(RESOURCE_LABELS[resource], `${stock} / ${target}${tag}`);
    }).join('');

    return `<div class="note">STOCK</div><div class="stats">${rows}</div>`;
  }

  /** Loads a villager is currently carrying to or from this place. */
  private tradePanel(trader: Trader): string {
    const rows: string[] = [];

    for (const v of this.world.villagers) {
      if (v.role !== VillagerRole.Transporter || !v.resource || !v.task) continue;
      const amount = v.claim || v.cargo?.amount || 0;
      if (amount <= 0) continue;

      if (v.task === trader) {
        rows.push(this.row(`${RESOURCE_LABELS[v.resource]} &rarr; ${v.destination?.name ?? '?'}`, String(amount)));
      } else if (v.destination === trader) {
        rows.push(this.row(`${RESOURCE_LABELS[v.resource]} &larr; ${v.task.name}`, String(amount)));
      }
    }

    if (rows.length === 0) return '';
    return `<div class="divider"></div><div class="note">IN TRANSIT</div><div class="stats">${rows.join('')}</div>`;
  }

  /**
   * A frontier offer: what is out there, and what taking it in would cost.
   *
   * Deliberately *not* the operational node panel. A site beyond the border
   * has no route, no workers, no production and no stock, and showing eight
   * rows of zeroes would suggest the player is looking at something broken
   * rather than something they have not bought yet. What matters here is
   * what it would be worth and what it would cost.
   */
  private frontierPanel(node: ResourceNode): string {
    const cost = this.world.claimCost(node);
    if (cost === null) return this.nodePanel(node);

    const affordable = this.world.expansionCapacity >= cost;
    const short = Math.ceil(cost - this.world.expansionCapacity);
    const rate = this.world.capacityRate.total;
    const wait = !affordable && rate > 0 ? ` <span class="note-inline">~${Math.ceil((short / rate) * 60)}s away</span>` : '';

    return `
      <div class="name">${node.name.toUpperCase()}</div>
      <div class="meta">${SITE_LABELS[node.type]} &middot; BEYOND THE BORDER</div>
      <div class="stats">
        ${this.row('Would produce', RESOURCE_LABELS[node.resource])}
        ${this.row('Ground', TERRAIN_LABELS[this.world.terrain.typeAt(node.position)])}
        ${this.row('Beyond the border', `${Math.round(this.world.territory.distanceOutside(node.position))}`)}
      </div>
      <div class="divider"></div>
      <div class="claim">
        <div class="claim-cost ${affordable ? '' : 'short'}">
          <span class="claim-label">EXPANSION COST</span>
          <span class="claim-value">${cost}</span>
        </div>
        <button type="button" class="claim-button" data-claim="${node.id}" ${affordable ? '' : 'disabled'}>
          ${affordable ? 'Claim' : `Need ${short} more${wait}`}
        </button>
        <div class="note">Incorporating this gives the realm the ground, not the goods — it still needs a road, and people willing to work it.</div>
      </div>`;
  }

  /**
   * The ground this works actually operates over, and what it is doing to its
   * output.
   *
   * The second half only appears when there is something to say. A works with
   * the run of its own valley is at full yield and the row would be noise; a
   * works at three-quarters is a works somebody has built over, and that is
   * the single most useful thing the panel can tell the player about why the
   * numbers moved.
   */
  private workingsRow(node: ResourceNode): string {
    if (!node.isClaimed) return '';
    const cellSize = this.world.terrain.cellSize;
    const held = hectares(node.ground.area(cellSize));
    const wanted = hectares(node.workedArea);
    const penalty =
      node.groundQuality < 0.97
        ? ` <span class="need">&minus;${Math.round((1 - node.groundQuality) * 100)}% yield</span>`
        : '';
    return this.row('Workings', `${held} ha <span class="note-inline">of ${wanted}</span>${penalty}`);
  }

  private nodePanel(node: ResourceNode): string {
    const perMinute = (node.productionRate * 60).toFixed(1);
    const route = this.world.routeTo(node);
    const tier =
      route && route.edges.length > 0
        ? roadTierName(Math.max(...route.edges.map((e) => this.world.wearOf(e))))
        : null;

    const progress = node.levelProgress;
    const levelNote =
      progress.next !== null
        ? `<span class="note-inline">${progress.collected.toFixed(0)} / ${progress.next} to next</span>`
        : '<span class="note-inline">max level</span>';

    const investment = node.investmentProgress;
    const investmentNote =
      investment.next !== null
        ? `${investment.invested.toFixed(0)} / ${investment.next} ${RESOURCE_LABELS[node.requiredResource]}`
        : 'max level';

    return `
      <div class="name">${node.name.toUpperCase()}</div>
      <div class="meta">${SITE_LABELS[node.type]} &middot; ${NODE_STATE_LABELS[node.state]}</div>
      <div class="stats">
        ${this.row('Produces', RESOURCE_LABELS[node.resource])}
        ${this.row('Level', `${node.level} ${levelNote}`)}
        ${this.row('Investment', investmentNote)}
        ${this.row(WORKER_LABELS[node.type], `${node.workers.length} / ${node.workerCapacity}`)}
        ${this.row('Production', node.workers.length > 0 ? `${perMinute} / min` : 'idle')}
        ${this.row('Stored', `${node.stored} / ${node.capacity}`)}
        ${this.row('Ground', TERRAIN_LABELS[this.world.terrain.typeAt(node.position)])}
        ${this.workingsRow(node)}
        ${route ? this.row('Route', `${Math.round(route.length)} &middot; ${tier}`) : this.row('Route', 'none')}
        ${route ? this.row('Going', `&times;${route.difficulty.toFixed(2)}`) : ''}
      </div>
      ${this.destinationsPanel(node)}`;
  }

  /** Where this node's goods are actually going, and who else would take them. */
  private destinationsPanel(node: ResourceNode): string {
    if (!node.isConnected) return '';

    const options = destinationsFor(
      node.resource,
      this.world.traders,
      (trader) => this.world.routeBetweenSites(node, trader),
      this.world.traffic,
    );
    if (options.length === 0) return '';

    const rows = options
      .slice(0, 4)
      .map((opt, i) => {
        const mark = i === 0 ? ' <span class="need">CHOSEN</span>' : '';
        const debug = `<span class="note-inline">value ${opt.value.toFixed(2)} &times; road ${opt.routeQuality.toFixed(2)}</span>`;
        return this.row(
          opt.trader.name.toUpperCase(),
          `${Math.round(opt.distance)} &middot; ${opt.demand}${mark}<br>${debug}`,
        );
      })
      .join('');

    return `<div class="divider"></div><div class="note">DESTINATIONS</div><div class="stats">${rows}</div>`;
  }

  /**
   * The panel this whole version turns on: what is moving through this spot,
   * how good the road is, and how close it is to becoming somewhere.
   */
  /**
   * A fork in the road, which is a different thing from the roads that meet
   * at it and was the one feature on the map with real consequences that
   * could not be inspected.
   *
   * Being a junction is worth more to a prospective settlement than being
   * merely busy is (`settlementSystem.ts` weighs `junction` at 0.17 against
   * traffic's 0.30, and the last step from hamlet to settlement needs the
   * junction term to clear it at all) — so "a place becomes a town by
   * becoming a hub" is a rule the design leans on and the map never showed.
   * Hovering one used to report whichever of its arms answered first.
   */
  private junctionPanel(node: GraphNode): string {
    const point = node.position;
    const goods = this.world.traffic.goodsAt(point);
    const { total } = dominantGood(goods);
    const wear = this.world.traffic.wearAt(point);
    const potential = this.world.potentialAt(point);
    const degree = node.edges.length;

    const arms = node.edges
      .slice()
      .sort((a, b) => b.wear(this.world.traffic) - a.wear(this.world.traffic))
      .map((edge) =>
        this.row(
          roadTierName(edge.wear(this.world.traffic)),
          `${Math.round(edge.length * METRES_PER_UNIT)} m <span class="note-inline">${edge.usage} trips</span>`,
        ),
      )
      .join('');

    const bars = TRACKED_GOODS.filter((r) => goods[r] > 0.05)
      .sort((a, b) => goods[b] - goods[a])
      .slice(0, 4)
      .map((r) => this.bar(RESOURCE_LABELS[r], goods[r] / Math.max(total, 1)))
      .join('');

    return `
      <div class="name">${degree >= 4 ? 'CROSSROADS' : degree === 3 ? 'FORK' : 'BEND'}</div>
      <div class="meta">${degree} ROADS MEET &middot; ${TERRAIN_LABELS[this.world.terrain.typeAt(point)]}</div>
      <div class="stats">
        ${this.bar('Traffic', Math.min(1, wear / ROAD_DEVELOPED))}
        ${bars || '<div class="note">Nothing has been carried past here yet.</div>'}
      </div>
      <div class="divider"></div>
      <div class="note">ROADS MEETING HERE</div>
      <div class="stats">${arms}</div>
      <div class="divider"></div>
      <div class="stats">
        ${this.bar('Settlement', potential, true)}
        ${this.row('Likely', potential > 0.04 ? this.world.likelyTradeAt(point) : '&mdash;')}
      </div>
      ${this.reasons(point)}`;
  }

  private roadPanel(point: Vec2): string {
    const goods = this.world.traffic.goodsAt(point);
    const { resource, share, total } = dominantGood(goods);
    const wear = this.world.traffic.wearAt(point);
    const potential = this.world.potentialAt(point);

    const bars = TRACKED_GOODS.filter((r) => goods[r] > 0.05)
      .sort((a, b) => goods[b] - goods[a])
      .map((r) => this.bar(RESOURCE_LABELS[r], goods[r] / Math.max(total, 1)))
      .join('');

    return `
      <div class="name">ROAD</div>
      <div class="meta">${roadTierName(wear)} &middot; ${TERRAIN_LABELS[this.world.terrain.typeAt(point)]}</div>
      <div class="stats">
        ${this.bar('Traffic', Math.min(1, wear / ROAD_DEVELOPED))}
        ${bars || '<div class="note">Nothing has been carried past here yet.</div>'}
      </div>
      <div class="divider"></div>
      <div class="stats">
        ${this.bar('Settlement', potential, true)}
        ${this.row('Likely', potential > 0.04 ? this.world.likelyTradeAt(point) : '&mdash;')}
        ${
          resource && share >= 0.55
            ? this.row('Dominant', `${RESOURCE_LABELS[resource]} ${Math.round(share * 100)}%`)
            : ''
        }
      </div>
      ${this.reasons(point)}`;
  }

  /** Which factors are actually carrying the potential at this spot. */
  private reasons(point: Vec2): string {
    const parts = this.world.potentialBreakdown(point);
    const named: Array<[string, string]> = [
      ['traffic', 'Traffic'],
      ['junction', 'Junction'],
      ['resources', 'Resources'],
      ['terrain', 'Ground'],
      ['room', 'Room to grow'],
      ['quality', 'Road'],
    ];

    const rows = named
      .filter(([key]) => (parts[key] ?? 0) > 0.02)
      .sort((a, b) => (parts[b[0]] ?? 0) - (parts[a[0]] ?? 0))
      .map(([key, label]) => this.bar(label, parts[key] ?? 0))
      .join('');

    if (!rows) return '';

    const crowding = parts.crowding ?? 1;
    const crowded =
      crowding < 0.99
        ? `<div class="note">Crowded by a neighbour &middot; &times;${crowding.toFixed(2)}</div>`
        : '';

    return `<div class="divider"></div><div class="note">WHY</div><div class="stats">${rows}</div>${crowded}`;
  }

  private settlementPanel(settlement: Settlement): string {
    const origin = settlement.origin.resource
      ? `Heavy ${RESOURCE_LABELS[settlement.origin.resource].toLowerCase()} traffic`
      : 'Mixed trade on a busy road';
    const age = settlement.ageInDays(this.world.hours);
    const sustainable = Math.round(sustainablePopulation(settlement));
    const jobs = this.jobsPanel(settlement);

    return `
      <div class="name">${settlement.name.toUpperCase()}</div>
      <div class="meta">${TIER_LABELS[settlement.tier]} &middot; ${settlement.trade.label.toUpperCase()}</div>
      <div class="stats">
        ${this.row('Population', `${Math.round(settlement.population)} <span class="note-inline">sustainable ~${sustainable}</span>`)}
        ${this.housingRow(settlement)}
        ${jobs}
        ${this.row('Available', String(this.world.idleCountAt(settlement)))}
        ${this.row('Transporters', String(this.world.transporterCountAt(settlement)))}
        ${this.row('Specialization', settlement.trade.label)}
        ${this.row('Origin', origin)}
        ${this.row('Age', age === 1 ? '1 day' : `${age} days`)}
        ${this.row('Holds', `${settlement.footprintRadius} <span class="note-inline">of the realm's ground</span>`)}
      </div>
      <div class="divider"></div>
      ${this.landPanel(settlement)}
      <div class="divider"></div>
      ${this.developmentPanel(settlement)}
      ${this.wealthPanel(settlement)}
      <div class="stats">
        ${this.bar('Economy', economicActivity(settlement), true)}
        ${this.bar('Standing', settlement.potential, true)}
      </div>
      <div class="divider"></div>
      ${this.builtPanel(settlement)}
      <div class="divider"></div>
      ${this.industriesPanel(settlement)}
      <div class="divider"></div>
      ${this.traderStats(settlement)}
      ${this.tradePanel(settlement)}
      <div class="note">Grows or shrinks with what actually reaches it &mdash; the same rule Oakridge follows.</div>`;
  }

  // ------------------------------------------------------------------ pieces

  private bar(label: string, fraction: number, showPercent = false): string {
    const clamped = Math.max(0, Math.min(1, fraction));
    const filled = Math.round(clamped * 14);
    const meter = '█'.repeat(filled) + '░'.repeat(14 - filled);
    const value = showPercent ? ` ${Math.round(clamped * 100)}%` : '';
    return `<div class="meter"><span class="label">${label.toUpperCase()}</span><span class="bar">${meter}${value}</span></div>`;
  }

  private row(label: string, value: string): string {
    return `<div class="row"><span class="label">${label.toUpperCase()}</span><span class="value">${value}</span></div>`;
  }
}

/**
 * World units² as hectares, at `scale.ts`'s four metres to the unit.
 *
 * The panel quotes acreage rather than a radius because acreage is what a
 * parcel actually is — an irregular patch of held cells — and because a
 * hectare is a figure a player can weigh against a real village. A radius
 * would be both a lie about the shape and meaningless without one.
 */
function hectares(areaInUnits: number): number {
  return Math.round((areaInUnits * METRES_PER_UNIT * METRES_PER_UNIT) / 10_000);
}
