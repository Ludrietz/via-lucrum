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
import { housingCapacity, nextHousingThreshold } from '../sim/housing';
import type { ResourceNode } from '../sim/resourceNode';
import type { Site } from '../sim/roadNetwork';
import { Settlement } from '../sim/settlement';
import { TERRAIN_LABELS } from '../sim/terrain';
import { TIER_LABELS, TIER_THRESHOLDS } from '../sim/tier';
import { dominantGood, TRACKED_GOODS, WEAR_FULL } from '../sim/traffic';
import { NodeState, ResourceType, SiteType, VillagerRole } from '../sim/types';
import { Village } from '../sim/village';
import type { World } from '../sim/world';
import { INDUSTRY_LABELS, RESOURCE_LABELS, SITE_LABELS, WORKER_LABELS, roadTierName } from '../render/theme';

const NODE_STATE_LABELS: Record<NodeState, string> = {
  [NodeState.Hidden]: 'UNKNOWN',
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
];

/** Plain DOM HUD. Reads the world, never writes to it. */
export class Hud {
  private readonly day = document.getElementById('hud-day')!;
  private readonly inspect = document.getElementById('inspect')!;
  private readonly hint = document.getElementById('hint')!;

  private hintFaded = false;

  constructor(private readonly world: World) {}

  update(focused: Site | null, roadPoint: Vec2 | null): void {
    this.day.textContent = `DAY ${this.world.day}`;

    if (!this.hintFaded && this.world.network.edges.length > 0) {
      this.hintFaded = true;
      this.hint.classList.add('faded');
    }

    this.renderInspect(focused, roadPoint);
  }

  private renderInspect(site: Site | null, roadPoint: Vec2 | null): void {
    let html: string | null = null;

    if (site instanceof Village) html = this.villagePanel(site);
    else if (site instanceof Settlement) html = this.settlementPanel(site);
    else if (site) html = this.nodePanel(site as ResourceNode);
    else if (roadPoint) html = this.roadPanel(roadPoint);

    if (!html) {
      this.inspect.classList.add('hidden');
      return;
    }

    this.inspect.classList.remove('hidden');
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
      .map((ind) => this.row(INDUSTRY_LABELS[ind.type], `${ind.workers.length} / ${ind.workerCapacity}`))
      .join('');
    return `<div class="note">INDUSTRIES</div><div class="stats">${rows}</div>`;
  }

  /** How many residents this place has room for right now, and whether it's crowded enough to be working on more. */
  private housingRow(trader: Trader): string {
    const capacity = housingCapacity(trader);
    const maxed = nextHousingThreshold(trader) === null;
    const crowded = !maxed && trader.population >= capacity * 0.8;
    const note = crowded ? 'building more room' : maxed ? 'fully grown' : 'room to spare';
    return this.row('Housing', `${capacity} <span class="note-inline">${note}</span>`);
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
        ${this.row('Working', `${this.world.workingPopulationAt(village)} <span class="note-inline">of ${village.population} — the rest are dependents</span>`)}
        ${jobs}
        ${this.row('Available', String(this.world.idleCountAt(village)))}
        ${this.row('Transporters', String(this.world.transporterCountAt(village)))}
        ${this.row('Influence', String(village.influenceRadius))}
      </div>
      <div class="divider"></div>
      ${this.developmentPanel(village)}
      ${this.wealthPanel(village)}
      <div class="stats">${this.bar('Economy', economicActivity(village), true)}</div>
      <div class="divider"></div>
      ${this.industriesPanel(village)}
      <div class="divider"></div>
      ${this.traderStats(village)}
      ${this.tradePanel(village)}`;
  }

  /**
   * The tier bar: how close this place is to its next rung, and whether its
   * wood-and-stone supply is currently pulling it up or letting it slide.
   */
  private developmentPanel(trader: Trader): string {
    const tierIndex = TIER_THRESHOLDS.findIndex((step) => step.tier === trader.tier);
    const current = TIER_THRESHOLDS[tierIndex].threshold;
    const next = TIER_THRESHOLDS[tierIndex - 1] ?? null;

    const progress = next ? (trader.development - current) / (next.threshold - current) : 1;
    const rate = developmentRate(trader);
    const trend = rate > 0.05 ? 'RISING' : rate < -0.05 ? 'FALLING' : 'STEADY';

    return `<div class="stats">
      ${this.bar('Development', progress, true)}
      ${this.row('Trend', `${trend} <span class="note-inline">${rate >= 0 ? '+' : ''}${rate.toFixed(2)}/s</span>`)}
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
        ${this.bar('Traffic', Math.min(1, wear / WEAR_FULL))}
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
        ${this.row('Working', `${this.world.workingPopulationAt(settlement)} <span class="note-inline">of ${settlement.population} — the rest are dependents</span>`)}
        ${jobs}
        ${this.row('Available', String(this.world.idleCountAt(settlement)))}
        ${this.row('Transporters', String(this.world.transporterCountAt(settlement)))}
        ${this.row('Specialization', settlement.trade.label)}
        ${this.row('Origin', origin)}
        ${this.row('Age', age === 1 ? '1 day' : `${age} days`)}
        ${settlement.influenceRadius > 0 ? this.row('Influence', String(settlement.influenceRadius)) : ''}
      </div>
      <div class="divider"></div>
      ${this.developmentPanel(settlement)}
      ${this.wealthPanel(settlement)}
      <div class="stats">
        ${this.bar('Economy', economicActivity(settlement), true)}
        ${this.bar('Standing', settlement.potential, true)}
      </div>
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
