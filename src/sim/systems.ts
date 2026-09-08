import { desiredStock, destinationsFor, pledge, recordDelivery, shortage, unpledge, type Trader } from './economy';
import type { ResourceNode } from './resourceNode';
import type { Vec2 } from './geometry';
import type { Route } from './roadNetwork';
import type { TrafficField } from './traffic';
import { NodeState, VillagerRole, VillagerState, type ResourceType, type WorldEvent } from './types';
import type { Village } from './village';
import { CARRY_CAPACITY, TransportLeg, type Villager } from './villager';

/** What the systems are allowed to see of the world. */
export interface SimContext {
  village: Village;
  nodes: ResourceNode[];
  /** Every place goods can be delivered to: the village, and every settlement. */
  traders: Trader[];
  traffic: TrafficField;
  routeTo(node: ResourceNode): Route | null;
  routeBetweenSites(from: ResourceNode | Trader, to: ResourceNode | Trader): Route | null;
  /** How hard the ground at a point is to cross, relative to open plains. */
  costAt(point: Vec2): number;
  /** A delivery just came in along this route; mark the ground it used. */
  recordTrip(route: Route, resource: ResourceType | null, amount: number): void;
  emit(event: WorldEvent): void;
}

const LOAD_TIME = 1.2;
const UNLOAD_TIME = 1.0;
/** Gap between two villagers setting off, so they do not leave as a blob. */
const DISPATCH_INTERVAL = 0.7;

/**
 * Turns idle villagers into transporters and runs their delivery rounds.
 *
 * Capacity is simply how many people are not posted to a workplace, which is
 * the constraint the whole game is built around. Where a load actually goes
 * is not fixed to the village any more: every dispatch weighs every reachable
 * destination's shortage against how good the road there is, so a forest with
 * two settlements on its roads splits its output between them rather than
 * always favouring whichever came first.
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

    idle.role = VillagerRole.Transporter;
    idle.task = task.node;
    idle.destination = task.destination;
    idle.leg = TransportLeg.ToPickup;
    idle.setRoute(task.route);
    idle.claim = task.amount;
    task.node.claimed += idle.claim;
    pledge(task.destination, task.node.resource, idle.claim);
    this.cooldown = DISPATCH_INTERVAL;
  }

  /**
   * Which node to fetch from and where to carry it. Every connected node with
   * goods waiting is weighed against every reachable destination's shortage
   * and road quality; the winner is a (node, destination) pair, not just a
   * node, so the economic decision and the walking are worked out together.
   */
  private pickTask(
    ctx: SimContext,
  ): { node: ResourceNode; destination: Trader; route: Route; amount: number } | null {
    let best: { node: ResourceNode; destination: Trader; route: Route; amount: number } | null = null;
    let bestScore = -Infinity;

    for (const node of ctx.nodes) {
      if (!node.isConnected || node.available <= 0) continue;

      const pickupRoute = ctx.routeTo(node);
      if (!pickupRoute) continue;

      const destinations = destinationsFor(
        node.resource,
        ctx.traders,
        (trader) => ctx.routeBetweenSites(node, trader),
        ctx.traffic,
      );
      if (destinations.length === 0) continue;
      const winner = destinations[0];

      const urgency = (node.isFull ? 400 : 0) + node.available * 20 - pickupRoute.resistance / 50;
      const score = urgency + winner.score * 60;
      if (score <= bestScore) continue;

      const desired = desiredStock(winner.trader, node.resource);
      const unmet = Math.max(1, Math.ceil(desired - (winner.trader.storage[node.resource] + winner.trader.incoming[node.resource])));
      const amount = Math.min(CARRY_CAPACITY, node.available, unmet);

      bestScore = score;
      best = { node, destination: winner.trader, route: pickupRoute, amount };
    }

    return best;
  }

  private step(villager: Villager, dt: number, ctx: SimContext): void {
    const task = villager.task;
    const destination = villager.destination;
    if (!task || !destination) {
      villager.release();
      return;
    }

    switch (villager.state) {
      case VillagerState.Walking: {
        if (!villager.advance(dt, ctx.costAt(villager.position))) return;

        if (villager.leg === TransportLeg.Returning) {
          if (villager.selfDelivering) this.rejoinWorkplace(villager, task);
          else villager.release();
          return;
        }

        if (villager.leg === TransportLeg.ToPickup) {
          villager.state = VillagerState.Loading;
          villager.timer = LOAD_TIME;
        } else {
          villager.state = VillagerState.Unloading;
          villager.timer = UNLOAD_TIME;
        }
        return;
      }

      case VillagerState.Loading: {
        villager.timer -= dt;
        if (villager.timer > 0) return;

        const claimed = villager.claim;
        task.claimed = Math.max(0, task.claimed - claimed);
        const amount = task.collect(claimed);
        villager.claim = 0;

        if (amount > 0) {
          villager.cargo = { resource: task.resource, amount };
          ctx.emit({ type: 'pickup', at: { ...task.position }, resource: task.resource, amount });
        }
        // Whatever the pledge overstated (the node came up short), the
        // destination should stop counting on it arriving.
        if (claimed > amount) unpledge(destination, task.resource, claimed - amount);

        const onward = ctx.routeBetweenSites(task, destination);
        if (!onward) {
          villager.release();
          return;
        }
        villager.leg = TransportLeg.ToDestination;
        villager.setRoute(onward);
        return;
      }

      case VillagerState.Unloading: {
        villager.timer -= dt;
        if (villager.timer > 0) return;

        const cargo = villager.cargo;
        if (cargo) {
          destination.storage[cargo.resource] += cargo.amount;
          unpledge(destination, cargo.resource, cargo.amount);
          recordDelivery(destination, cargo.resource, cargo.amount);
          ctx.emit({
            type: 'deposit',
            at: { ...destination.position },
            resource: cargo.resource,
            amount: cargo.amount,
          });
        }

        if (villager.route) ctx.recordTrip(villager.route, cargo?.resource ?? null, cargo?.amount ?? 0);

        // A worker delivering their own backlog walks home to their post, not
        // to the village — everyone else's round trip ends at the village.
        const goingHomeTo = villager.selfDelivering ? task : destination === ctx.village ? null : ctx.village;
        if (goingHomeTo === null) {
          villager.release();
          return;
        }

        const home = ctx.routeBetweenSites(destination, goingHomeTo);
        if (!home) {
          if (villager.selfDelivering) this.rejoinWorkplace(villager, task);
          else villager.release();
          return;
        }
        villager.leg = TransportLeg.Returning;
        villager.cargo = null;
        villager.setRoute(home);
        return;
      }

      default:
        villager.release();
    }
  }

  /** A self-delivering worker is home; stand them back up at their post. */
  private rejoinWorkplace(villager: Villager, workplace: ResourceNode): void {
    villager.role = VillagerRole.Worker;
    villager.state = VillagerState.Working;
    villager.selfDelivering = false;
    villager.task = null;
    villager.destination = null;
    villager.route = null;
    villager.cargo = null;
    villager.leg = TransportLeg.ToPickup;

    workplace.workers.push(villager);
    workplace.state = NodeState.Operational;

    const slot = workplace.workers.length - 1;
    const angle = -Math.PI / 2 + slot * 1.1;
    villager.position = {
      x: workplace.position.x + Math.cos(angle) * (workplace.radius + 12),
      y: workplace.position.y + Math.sin(angle) * (workplace.radius + 12),
    };
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

    // No artificial reserve held back for logistics any more: workplace
    // openings are their own natural cap, and a node nobody can reach in
    // time now empties itself via the worker-delivery fallback rather than
    // needing hands kept idle "just in case".
    const village = ctx.village;
    const capacity = village.workersPerNode;
    const openings = ctx.nodes.filter((n) => n.isConnected && n.workers.length + n.incomingWorkers < capacity);
    if (openings.length === 0) return;

    // Whichever good the village is shortest on gets staffed first — food
    // above all, since an unfed village has nothing else to spend hands on.
    openings.sort((a, b) => shortage(village, b.resource) - shortage(village, a.resource));
    const target = openings[0];

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
