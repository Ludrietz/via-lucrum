import { bestDestinationFor, pledge } from './economy';
import type { ResourceNode } from './resourceNode';

import { VillagerRole, VillagerState } from './types';
import { CONVOY_CLASSES, convoyFor, TransportLeg } from './villager';
import type { SimContext } from './systems';

/**
 * How long a node has to have stood full with goods nobody has come for
 * before one of its own workers gives up waiting and carries a load off.
 */
const STALL_GRACE = 8;

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
 *
 * This had quietly stopped happening at any useful rate, in two ways that
 * compounded:
 *
 * - **It was a global serial queue**, one worker anywhere in the realm every
 *   three hours. That is a fine rate for the six-deposit civilisation it was
 *   written for and no rate at all for a realm with sixty deposits, where the
 *   average site's turn came round once every week and a half. Waiting is now
 *   counted per site, which is where the waiting actually happens, so sixty
 *   stalled sheds answer sixty times as loudly as one.
 * - **Its timer reset whenever anybody claimed a single unit.** It watched
 *   `fullSince`, which exists for a different question ("has anyone even been
 *   dispatched here?", see `trade.ts`) and resets the moment one carrier is on
 *   the way. On a long haul that carrier is walking for hours, during which
 *   the shed stays full, production stays stopped, and the timer sits at zero.
 *   The condition that matters here is simply: is this site full, and is there
 *   stock on the ground that nobody is coming for?
 *
 * It is also the mechanism that seeds an outlying settlement. A deposit far
 * from anywhere generates no traffic of its own until somebody walks its road,
 * and settlements emerge from traffic near real work — so a site whose own
 * people carry its goods out is a site that slowly builds the road, and the
 * case for a village, that it would otherwise never have.
 */
export class WorkerDeliverySystem {
  /** Hours each site has stood full with goods nobody has come for. */
  private readonly stalled = new WeakMap<ResourceNode, number>();

  update(dt: number, ctx: SimContext): void {
    for (const node of ctx.nodes) {
      // Full, and holding stock nobody has been sent for. Production has
      // stopped dead and no relief is on its way: that, and not "has a
      // carrier been dispatched", is when standing about stops making sense.
      if (!node.isFull || node.available <= 0) {
        if (this.stalled.has(node)) this.stalled.delete(node);
        continue;
      }

      const waited = (this.stalled.get(node) ?? 0) + dt;
      if (waited < STALL_GRACE) {
        this.stalled.set(node, waited);
        continue;
      }

      if (this.sendOne(node, ctx)) this.stalled.delete(node);
      else this.stalled.set(node, waited);
    }
  }

  private sendOne(node: ResourceNode, ctx: SimContext): boolean {
    // Only someone actually standing at the post right now can step away
    // from it — not a worker already mid-delivery from an earlier round.
    const worker = node.workers.find((w) => w.role === VillagerRole.Worker && w.state === VillagerState.Working);
    if (!worker) return false;

    const best = bestDestinationFor(
      node.resource,
      ctx.traders,
      (trader) => ctx.routeBetweenSites(node, trader),
      ctx.traffic,
    );
    if (!best) return false;

    const destination = best.trader;
    const route = ctx.routeBetweenSites(node, destination);
    if (!route) return false;

    // What the road will bear, the same question every other load asks. This
    // used to be a single back-load regardless: a woodcutter beside a made
    // road walked home with three logs while the carts went past him.
    const weakest = route.weakestWear(ctx.traffic);
    const allowed = convoyFor(weakest, route.length);
    const amount = node.collect(Math.min(CONVOY_CLASSES[allowed].capacity, node.available));
    const convoy = convoyFor(weakest, route.length, amount);
    if (amount <= 0) return false;

    worker.role = VillagerRole.Transporter;
    worker.task = node;
    worker.resource = node.resource;
    worker.destination = destination;
    worker.leg = TransportLeg.ToDestination;
    worker.convoy = convoy;
    worker.cargo = { resource: node.resource, amount };
    pledge(destination, node.resource, amount);
    worker.setRoute(route);

    node.fullSince = 0;
    return true;
  }
}
