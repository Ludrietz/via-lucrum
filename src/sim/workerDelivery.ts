import { destinationsFor, pledge } from './economy';
import { NodeState, VillagerRole } from './types';
import { CARRY_CAPACITY, TransportLeg } from './villager';
import type { SimContext } from './systems';

/** A node has to have sat full and unclaimed this long before a worker gives up waiting. */
const FULLNESS_GRACE = 8;
/** Don't re-check every tick — one worker stepping out is enough for a while. */
const CHECK_INTERVAL = 3;

/**
 * The fallback for a workplace nobody is coming to empty: rather than stand
 * around with a full shed, one worker carries a load off themselves, then
 * comes back and picks their tools back up. They never become a real
 * transporter — this is a stopgap, not a second job.
 */
export class WorkerDeliverySystem {
  private cooldown = 0;

  update(dt: number, ctx: SimContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.cooldown > 0) return;

    for (const node of ctx.nodes) {
      if (node.fullSince < FULLNESS_GRACE || node.workers.length === 0 || node.available <= 0) continue;

      const destinations = destinationsFor(
        node.resource,
        ctx.traders,
        (trader) => ctx.routeBetweenSites(node, trader),
        ctx.traffic,
      );
      if (destinations.length === 0) continue;

      const destination = destinations[0].trader;
      const route = ctx.routeBetweenSites(node, destination);
      if (!route) continue;

      const worker = node.workers[0];
      node.workers.splice(0, 1);
      if (node.workers.length === 0) node.state = NodeState.Connected;

      const amount = node.collect(Math.min(CARRY_CAPACITY, node.available));

      worker.role = VillagerRole.Transporter;
      worker.selfDelivering = true;
      worker.task = node;
      worker.destination = destination;
      worker.leg = TransportLeg.ToDestination;
      worker.cargo = { resource: node.resource, amount };
      pledge(destination, node.resource, amount);
      worker.setRoute(route);

      node.fullSince = 0;
      this.cooldown = CHECK_INTERVAL;
      return;
    }
  }
}
