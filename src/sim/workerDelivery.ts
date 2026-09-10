import { destinationsFor, pledge } from './economy';
import { VillagerRole, VillagerState } from './types';
import { CARRY_CAPACITY, TransportLeg } from './villager';
import type { SimContext } from './systems';

/** A node has to have sat full and unclaimed this long before a worker gives up waiting. */
const FULLNESS_GRACE = 8;
/** Don't re-check every tick — one worker stepping out is enough for a while. */
const CHECK_INTERVAL = 3;

/**
 * The fallback for a workplace nobody is coming to empty: rather than stand
 * around with a full shed, one worker carries a load off themselves. They
 * stay on the node's own roster the whole time they're out — `workplace`
 * is never cleared and they're never spliced out of `node.workers` — so the
 * post never reads as an opening while they're gone. It used to send them
 * back through the general labour pool afterwards, on the idea that
 * somewhere more short-handed should get first claim on them; in practice
 * that just meant a second person was routinely hired into the same post
 * while its actual worker was still walking the delivery, since nothing
 * about "gone for a few minutes" should have looked like "the job is
 * vacant." They resume the same post directly when they get back — see
 * `TransportSystem`'s `resumePost`.
 */
export class WorkerDeliverySystem {
  private cooldown = 0;

  update(dt: number, ctx: SimContext): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.cooldown > 0) return;

    for (const node of ctx.nodes) {
      if (node.fullSince < FULLNESS_GRACE || node.available <= 0) continue;
      // Only someone actually standing at the post right now can step away
      // from it — not a worker already mid-delivery from an earlier round.
      const worker = node.workers.find((w) => w.role === VillagerRole.Worker && w.state === VillagerState.Working);
      if (!worker) continue;

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

      const amount = node.collect(Math.min(CARRY_CAPACITY, node.available));

      worker.role = VillagerRole.Transporter;
      worker.task = node;
      worker.resource = node.resource;
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
