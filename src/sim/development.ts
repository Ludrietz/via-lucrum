import type { Trader } from './economy';
import { totalWorks } from './construction';

/**
 * What a place has made of itself — and, since `tier.ts` reads this, what it
 * is called.
 *
 * This used to be an integral: a place accumulated development points for as
 * long as it was comfortable, and lost them when it wasn't. Two things were
 * wrong with that, and they are the same thing seen from either end.
 *
 * It was a number a place could coast on. Development was a store with no
 * physical counterpart anywhere in the world — nothing was ever built, no
 * material was ever spent, and a town's tier was the running total of how
 * pleasant its balance sheet had been. The vision asks for tier to be "a
 * readout of how well an economy is actually doing, never a number a place
 * can coast on independent of its residents", and an integral of comfort is
 * *precisely* a number you coast on: it remembers a good decade forever.
 *
 * And it was the only thing the processed economy fed. Planks and blocks
 * existed to be eaten by a flat per-capita appetite and converted, via
 * wealth, into this score. So the whole chain — fell timber, haul it, mill
 * it, haul the planks — terminated in an abstraction, and a village that
 * built in plank was rewarded with a slightly larger integer and nothing
 * else.
 *
 * Development is now simply **what has been built and is still standing**
 * (see `construction.ts`): houses and workshops, bought with material that
 * villagers carried down roads the player drew, decaying if the supply line
 * that fed them goes quiet. Comfort has not stopped mattering — it is
 * upstream now rather than being the whole story, because only a place with
 * genuine surplus builds anything at all — but a place is a town because it
 * *is* a town, not because it was once content for long enough.
 */

/**
 * How much better a place built in dressed stone and sawn plank reads than
 * the same acreage of log and rubble. Both the grandeur and, separately, the
 * durability (see `construction.ts`'s decay) reward working the material —
 * which is the concrete answer to "what are advanced resources actually for".
 */
const QUALITY_RANGE = 0.5;

/** The standing built stock of a place, graded by what it was built out of. */
export function developmentValue(trader: Trader): number {
  const standing = trader.dwellings + totalWorks(trader);
  return standing * (1 - QUALITY_RANGE / 2 + QUALITY_RANGE * trader.fabricQuality);
}

/**
 * Points per hour development is currently moving — straight off the same
 * construction pass, so the trend a player reads is literally "is this place
 * building or falling down", not a smoothed opinion about its larder.
 */
export function developmentRate(trader: Trader): number {
  return trader.fabricRate * (1 - QUALITY_RANGE / 2 + QUALITY_RANGE * trader.fabricQuality);
}

export function syncDevelopment(trader: Trader): void {
  trader.development = developmentValue(trader);
}
