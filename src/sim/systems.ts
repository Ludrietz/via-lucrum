import type { ResourceNode } from './resourceNode';
import type { Vec2 } from './geometry';
import type { Route } from './roadNetwork';
import { NodeState, VillagerRole, VillagerState, type WorldEvent } from './types';
import type { Village } from './village';
import { CARRY_CAPACITY, type Villager } from './villager';

/** What the systems are allowed to see of the world. */
export interface SimContext {
  village: Village;
  nodes: ResourceNode[];
  routeTo(node: ResourceNode): Route | null;
  /** How hard the ground at a point is to cross, relative to open plains. */
  costAt(point: Vec2): number;
  /** A delivery just came in along this route; wear the ground it used. */
  recordTrip(route: Route): void;
  emit(event: WorldEvent): void;
}

const LOAD_TIME = 1.2;
const UNLOAD_TIME = 1.0;
/** Gap between two villagers setting off, so they do not leave as a blob. */
const DISPATCH_INTERVAL = 0.7;

/**
 * Turns idle villagers into transporters and runs their delivery rounds.
 * Capacity is simply how many people are not posted to a workplace, which is
 * the constraint the whole game is built around.
 */
export class TransportSystem {
  private cooldown = 0;

  update(dt: number, ctx: SimContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.dispatch(ctx);

    for (const villager of ctx.village.villagers) {
      if (villager.role === VillagerRole.Transporter) this.step(villager, dt, ctx);
    }
  }

  private dispatch(ctx: SimContext): void {
    if (this.cooldown > 0) return;

    const idle = ctx.village.villagers.find((v) => v.isAvailable);
    if (!idle) return;

    const task = this.pickTask(ctx);
    if (!task) return;

    const route = ctx.routeTo(task.node);
    if (!route) return;

    idle.role = VillagerRole.Transporter;
    idle.task = task.node;
    idle.homebound = false;
    idle.setRoute(route);
    idle.claim = Math.min(CARRY_CAPACITY, task.node.available);
    task.node.claimed += idle.claim;
    this.cooldown = DISPATCH_INTERVAL;
  }

  /**
   * Priority: sites that have filled up and stalled, then the biggest backlog,
   * then whatever is cheapest to reach — which is the terrain-weighted cost of
   * the walk, not its distance on the map.
   */
  private pickTask(ctx: SimContext): { node: ResourceNode; route: Route } | null {
    let best: { node: ResourceNode; route: Route } | null = null;
    let bestScore = -Infinity;

    for (const node of ctx.nodes) {
      if (!node.isConnected || node.available <= 0) continue;

      const route = ctx.routeTo(node);
      if (!route) continue;

      const score = (node.isFull ? 400 : 0) + node.available * 20 - route.resistance / 50;
      if (score > bestScore) {
        bestScore = score;
        best = { node, route };
      }
    }

    return best;
  }

  private step(villager: Villager, dt: number, ctx: SimContext): void {
    const task = villager.task;
    if (!task) {
      villager.release();
      return;
    }

    switch (villager.state) {
      case VillagerState.Walking: {
        if (!villager.advance(dt, ctx.costAt(villager.position))) return;

        if (villager.homebound) {
          villager.state = VillagerState.Unloading;
          villager.timer = UNLOAD_TIME;
        } else {
          villager.state = VillagerState.Loading;
          villager.timer = LOAD_TIME;
        }
        return;
      }

      case VillagerState.Loading: {
        villager.timer -= dt;
        if (villager.timer > 0) return;

        task.claimed = Math.max(0, task.claimed - villager.claim);
        villager.claim = 0;
        const amount = task.collect(CARRY_CAPACITY);

        if (amount > 0) {
          villager.cargo = { resource: task.resource, amount };
          ctx.emit({ type: 'pickup', at: { ...task.position }, resource: task.resource, amount });
        }

        const back = villager.route?.reversed();
        if (!back) {
          villager.release();
          return;
        }
        villager.homebound = true;
        villager.setRoute(back);
        return;
      }

      case VillagerState.Unloading: {
        villager.timer -= dt;
        if (villager.timer > 0) return;

        const cargo = villager.cargo;
        if (cargo) {
          ctx.village.storage[cargo.resource] += cargo.amount;
          ctx.emit({
            type: 'deposit',
            at: { ...ctx.village.position },
            resource: cargo.resource,
            amount: cargo.amount,
          });
        }

        if (villager.route) ctx.recordTrip(villager.route);
        villager.release();
        return;
      }

      default:
        villager.release();
    }
  }
}

/**
 * Posts villagers to connected resource nodes. Unlike transporters they make
 * the trip once and then stay for good.
 */
export class WorkforceSystem {
  private cooldown = 0;

  update(dt: number, ctx: SimContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.post(ctx);

    for (const villager of ctx.village.villagers) {
      if (villager.role === VillagerRole.Worker) this.step(villager, dt, ctx);
    }
  }

  private post(ctx: SimContext): void {
    if (this.cooldown > 0) return;

    // Never staff a site so eagerly that nobody is left to walk the roads.
    const village = ctx.village;
    const reserve = Math.max(2, Math.floor(village.population * 0.35));
    if (village.population - village.workerCount <= reserve) return;

    const capacity = village.workersPerNode;
    const target = ctx.nodes.find(
      (n) => n.isConnected && n.workers.length + n.incomingWorkers < capacity,
    );
    if (!target) return;

    const route = ctx.routeTo(target);
    if (!route) return;

    const idle = ctx.village.villagers.find((v) => v.isAvailable);
    if (!idle) return;

    idle.role = VillagerRole.Worker;
    idle.workplace = target;
    idle.setRoute(route);
    target.incomingWorkers++;
    this.cooldown = DISPATCH_INTERVAL;
  }

  private step(villager: Villager, dt: number, ctx: SimContext): void {
    if (villager.state !== VillagerState.Walking) return;

    const workplace = villager.workplace;
    if (!workplace) {
      villager.release();
      return;
    }

    if (!villager.advance(dt, ctx.costAt(villager.position))) return;

    villager.state = VillagerState.Working;
    villager.route = null;
    workplace.incomingWorkers = Math.max(0, workplace.incomingWorkers - 1);
    workplace.workers.push(villager);
    workplace.state = NodeState.Operational;

    // Stand just off the node centre so the glyph stays readable.
    const slot = workplace.workers.length - 1;
    const angle = -Math.PI / 2 + slot * 1.1;
    villager.position = {
      x: workplace.position.x + Math.cos(angle) * (workplace.radius + 12),
      y: workplace.position.y + Math.sin(angle) * (workplace.radius + 12),
    };

    ctx.emit({
      type: 'workerArrived',
      at: { ...workplace.position },
      resource: workplace.resource,
    });
  }
}
