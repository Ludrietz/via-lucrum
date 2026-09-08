import type { Vec2 } from '../sim/geometry';
import type { ResourceNode } from '../sim/resourceNode';
import type { Site } from '../sim/roadNetwork';
import { Settlement, SettlementStage, STAGE_LABELS } from '../sim/settlement';
import { TERRAIN_LABELS } from '../sim/terrain';
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
  private readonly villageName = document.getElementById('hud-village')!;
  private readonly stats = document.getElementById('hud-stats')!;
  private readonly resources = document.getElementById('hud-resources')!;
  private readonly progress = document.getElementById('hud-progress')!;
  private readonly inspect = document.getElementById('inspect')!;
  private readonly hint = document.getElementById('hint')!;

  private hintFaded = false;

  constructor(private readonly world: World) {
    this.villageName.textContent = world.village.name.toUpperCase();
  }

  update(focused: Site | null, roadPoint: Vec2 | null): void {
    const v = this.world.village;

    this.day.textContent = `DAY ${this.world.day}`;

    this.stats.innerHTML = [
      this.row('Population', `${v.population} / ${v.populationCap}`),
      this.row('Workers', String(v.workerCount)),
      this.row('Transporters', String(v.transporterCount)),
      this.row('Available', String(v.idleCount)),
      this.row('Influence', String(v.influenceRadius)),
      this.row('Level', String(v.level)),
      this.row('Settlements', String(this.world.settlements.length)),
    ].join('');

    this.resources.innerHTML = RESOURCE_ORDER.map((resource) =>
      this.row(RESOURCE_LABELS[resource], String(v.storage[resource])),
    ).join('');

    this.progress.innerHTML = this.levelProgress();

    if (!this.hintFaded && this.world.network.edges.length > 0) {
      this.hintFaded = true;
      this.hint.classList.add('faded');
    }

    this.renderInspect(focused, roadPoint);
  }

  /** What the village still needs before it can grow again. */
  private levelProgress(): string {
    const v = this.world.village;
    const cost = v.nextLevelCost;
    if (!cost) return '<div class="note">The village has reached its peak.</div>';

    const parts = Object.entries(cost).map(([resource, amount]) => {
      const have = v.storage[resource as ResourceType];
      const need = amount ?? 0;
      const done = have >= need ? ' done' : '';
      return `<span class="need${done}">${have}/${need} ${RESOURCE_LABELS[resource as ResourceType]}</span>`;
    });

    return `<div class="note">NEXT LEVEL</div><div class="needs">${parts.join('')}</div>`;
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

    return `
      <div class="name">${village.name.toUpperCase()}</div>
      <div class="meta">VILLAGE &middot; LEVEL ${village.level}</div>
      <div class="stats">
        ${this.row('Population', `${village.population} / ${village.populationCap}`)}
        ${jobs}
        ${this.row('Available', String(village.idleCount))}
        ${this.row('Influence', String(village.influenceRadius))}
      </div>`;
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
      </div>`;
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

    return `
      <div class="name">${settlement.name.toUpperCase()}</div>
      <div class="meta">${STAGE_LABELS[settlement.stage]} &middot; ${settlement.trade.label.toUpperCase()}</div>
      <div class="stats">
        ${this.row('Population', String(settlement.population))}
        ${this.row('Trade', settlement.trade.label)}
        ${this.row('Origin', origin)}
        ${this.row('Age', age === 1 ? '1 day' : `${age} days`)}
        ${settlement.influenceRadius > 0 ? this.row('Influence', String(settlement.influenceRadius)) : ''}
      </div>
      <div class="divider"></div>
      <div class="stats">${this.bar('Standing', settlement.potential, true)}</div>
      ${
        settlement.stage === SettlementStage.Settlement
          ? '<div class="note">A centre in its own right. Roads can be drawn from here.</div>'
          : '<div class="note">Keep the traffic coming and it will grow.</div>'
      }`;
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
