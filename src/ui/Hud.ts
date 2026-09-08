import type { ResourceNode } from '../sim/resourceNode';
import type { Site } from '../sim/roadNetwork';
import { TERRAIN_LABELS } from '../sim/terrain';
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

  update(focused: Site | null): void {
    const v = this.world.village;

    this.day.textContent = `DAY ${this.world.day}`;

    this.stats.innerHTML = [
      this.row('Population', `${v.population} / ${v.populationCap}`),
      this.row('Workers', String(v.workerCount)),
      this.row('Transporters', String(v.transporterCount)),
      this.row('Available', String(v.idleCount)),
      this.row('Influence', String(v.influenceRadius)),
      this.row('Level', String(v.level)),
    ].join('');

    this.resources.innerHTML = RESOURCE_ORDER.map((resource) =>
      this.row(RESOURCE_LABELS[resource], String(v.storage[resource])),
    ).join('');

    this.progress.innerHTML = this.levelProgress();

    if (!this.hintFaded && this.world.network.edges.length > 0) {
      this.hintFaded = true;
      this.hint.classList.add('faded');
    }

    this.renderInspect(focused);
  }

  /** What the village still needs before it can grow again. */
  private levelProgress(): string {
    const v = this.world.village;
    const cost = v.nextLevelCost;
    if (!cost) return '<div class="note">The settlement has reached its peak.</div>';

    const parts = Object.entries(cost).map(([resource, amount]) => {
      const have = v.storage[resource as ResourceType];
      const need = amount ?? 0;
      const done = have >= need ? ' done' : '';
      return `<span class="need${done}">${have}/${need} ${RESOURCE_LABELS[resource as ResourceType]}</span>`;
    });

    return `<div class="note">NEXT LEVEL</div><div class="needs">${parts.join('')}</div>`;
  }

  private renderInspect(site: Site | null): void {
    if (!site) {
      this.inspect.classList.add('hidden');
      return;
    }

    this.inspect.classList.remove('hidden');
    this.inspect.innerHTML =
      site instanceof Village ? this.villagePanel(site) : this.nodePanel(site as ResourceNode);
  }

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
    // The busiest stretch of the route is what gives it its character.
    const tier = route && route.edges.length > 0
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

  private row(label: string, value: string): string {
    return `<div class="row"><span class="label">${label.toUpperCase()}</span><span class="value">${value}</span></div>`;
  }
}
