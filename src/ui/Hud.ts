import {
  demandLevel,
  demandPerMin,
  destinationsFor,
  economicActivity,
  sustainablePopulation,
  throughputPerMin,
  type Trader,
} from '../sim/economy';
import type { Vec2 } from '../sim/geometry';
import type { ResourceNode } from '../sim/resourceNode';
import type { Site } from '../sim/roadNetwork';
import { Settlement } from '../sim/settlement';
import { TERRAIN_LABELS } from '../sim/terrain';
import { TIER_LABELS } from '../sim/tier';
import { dominantGood, TRACKED_GOODS, WEAR_FULL } from '../sim/traffic';
import { NodeState, ResourceType, SiteType } from '../sim/types';
import { Village } from '../sim/village';
import type { World } from '../sim/world';
import { RESOURCE_LABELS, SITE_LABELS, WORKER_LABELS, roadTierName } from '../render/theme';

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

  private villagePanel(village: Village): string {
    const byRole = new Map<SiteType, number>();
    for (const node of this.world.nodes) {
      if (node.workers.length > 0) {
        byRole.set(node.type, (byRole.get(node.type) ?? 0) + node.workers.length);
      }
    }

    const jobs = [...byRole.entries()]
      .map(([type, count]) => this.row(WORKER_LABELS[type], String(count)))
      .join('');
    const sustainable = Math.round(sustainablePopulation(village));

    return `
      <div class="name">${village.name.toUpperCase()}</div>
      <div class="meta">${TIER_LABELS[village.tier]}</div>
      <div class="stats">
        ${this.row('Population', `${village.population} <span class="note-inline">sustainable ~${sustainable}</span>`)}
        ${jobs}
        ${this.row('Available', String(village.idleCount))}
        ${this.row('Transporters', String(village.transporterCount))}
        ${this.row('Influence', String(village.influenceRadius))}
      </div>
      <div class="divider"></div>
      <div class="stats">${this.bar('Economy', economicActivity(village), true)}</div>
      <div class="divider"></div>
      ${this.traderStats(village)}`;
  }

  /**
   * Supply and demand for one place — used for the village and every
   * settlement alike, because as far as the economy is concerned they are
   * the same kind of thing.
   */
  private traderStats(trader: Trader): string {
    const rows = RESOURCE_ORDER.map((resource) => {
      const supply = throughputPerMin(trader, resource);
      const demand = demandPerMin(trader, resource);
      const level = demandLevel(trader, resource);
      const tag = level === 'NONE' || level === 'LOW' ? '' : ` <span class="need">${level}</span>`;
      return this.row(
        RESOURCE_LABELS[resource],
        `${supply.toFixed(1)} <span class="note-inline">of ${demand.toFixed(1)}/min</span>${tag}`,
      );
    }).join('');

    return `<div class="note">SUPPLY</div><div class="stats">${rows}</div>`;
  }

  private nodePanel(node: ResourceNode): string {
    const perMinute = (node.productionRate * 60).toFixed(1);
    const route = this.world.routeTo(node);
    const tier =
      route && route.edges.length > 0
        ? roadTierName(Math.max(...route.edges.map((e) => this.world.wearOf(e))))
        : null;

    return `
      <div class="name">${node.name.toUpperCase()}</div>
      <div class="meta">${SITE_LABELS[node.type]} &middot; ${NODE_STATE_LABELS[node.state]}</div>
      <div class="stats">
        ${this.row('Produces', RESOURCE_LABELS[node.resource])}
        ${this.row(WORKER_LABELS[node.type], `${node.workers.length} / ${this.world.village.workersPerNode}`)}
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
        return this.row(
          opt.trader.name.toUpperCase(),
          `${Math.round(opt.distance)} &middot; ${opt.demand}${mark}`,
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

    return `
      <div class="name">${settlement.name.toUpperCase()}</div>
      <div class="meta">${TIER_LABELS[settlement.tier]} &middot; ${settlement.trade.label.toUpperCase()}</div>
      <div class="stats">
        ${this.row('Population', `${Math.round(settlement.population)} <span class="note-inline">sustainable ~${sustainable}</span>`)}
        ${this.row('Specialization', settlement.trade.label)}
        ${this.row('Origin', origin)}
        ${this.row('Age', age === 1 ? '1 day' : `${age} days`)}
        ${settlement.influenceRadius > 0 ? this.row('Influence', String(settlement.influenceRadius)) : ''}
      </div>
      <div class="divider"></div>
      <div class="stats">
        ${this.bar('Economy', economicActivity(settlement), true)}
        ${this.bar('Standing', settlement.potential, true)}
      </div>
      <div class="divider"></div>
      ${this.traderStats(settlement)}
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
