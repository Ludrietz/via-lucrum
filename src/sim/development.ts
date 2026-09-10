import { shortage, wealthIncomePerMin, type Trader } from './economy';
import { ResourceType } from './types';

/**
 * How a place actually climbs the tier ladder: wealth generation and
 * population, nothing else. Not wood/stone shortage any more — a place that
 * nobody lives in but happens to be comfortably stocked used to be able to
 * coast at the top tier forever, which is exactly backwards. Tier should be
 * a consequence of a place actually being a going concern, not a
 * disconnected number it accumulated.
 */

/** Points per second gained while comfortably wealthy for the population on hand. */
const FAST_RATE = 0.35;
/** Points per second gained while getting by, but not comfortably. */
const SLOW_RATE = 0.08;
/** Points per second lost at the worst possible neglect — decline bites faster than growth pays off. */
const MAX_DECLINE_RATE = 1.6;

/** Below this shortfall, comfort counts as genuinely comfortable. */
const COMFORTABLE = 0.1;
/** Above this, it's bad enough that development starts sliding backwards. */
const STRUGGLING = 0.5;

/** Floor so a bad patch is recoverable rather than a hole dug forever. */
const MIN_DEVELOPMENT = -100;

/**
 * Below this population, a place simply isn't a going concern yet, however
 * comfortable its balance sheet momentarily looks. Deliberately low: this
 * only needs to tell an empty or just-founded place (population 0-1) apart
 * from a real, if small, household — it is no longer what stands between a
 * tiny population and a big-sounding tier (see `tier.ts`'s
 * `TIER_POPULATION_THRESHOLDS`, which does that job directly now). A higher
 * floor here was tried and reverted: it also suppressed comfort for a
 * genuinely stable, well-fed settlement of 2-4, which then read as
 * "struggling" and slid toward the development floor for no reason other
 * than being small — exactly the kind of place that should be able to hold
 * its own at a modest pace while it waits to grow, not get punished for it.
 */
const POPULATION_FLOOR = 2;
/**
 * Wealth per minute, per resident, that counts as comfortable — normalized
 * per capita rather than a flat number, so a small population with real
 * income (an efficient smithy, say) reaches comfortable exactly as readily
 * as a large middling one.
 */
const WEALTH_PER_CAPITA_TARGET = 0.5;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * 0 (nothing to show for itself) to 1 (a genuinely thriving place): how
 * close a trader is to comfortable, blending "is anyone actually here" with
 * "is it fed" and "is it earning." Population alone gates the other two —
 * a wealthy ghost town still falls short — but fed and wealth are then
 * weighed side by side, not wealth alone. A solo, self-sufficient village
 * with nobody else to trade with and no population to spare for an
 * industry (see `industry.ts`) can never earn a single point of wealth
 * income no matter how well it's doing, and that used to read as "zero
 * comfort" and crash straight to the fastest possible decline — the entire
 * early game, before a second settlement or a big enough population exists
 * to trade or staff an industry, was an unavoidable slide to the
 * development floor regardless of play. Being genuinely fed is the "going
 * concern" signal every place can reach on its own; wealth is the extra
 * credit that comes from real trade or industry, so a well-fed but
 * wealth-less place should hold steady (a slow climb, not a decline) while
 * a trading or industrial place is what actually pushes toward the fast
 * lane.
 */
function comfort(trader: Trader): number {
  const populationFactor = clamp01(trader.population / POPULATION_FLOOR);
  const fedFactor = 1 - shortage(trader, ResourceType.Food);
  const incomeTarget = WEALTH_PER_CAPITA_TARGET * Math.max(1, trader.population);
  const wealthFactor = clamp01(wealthIncomePerMin(trader) / incomeTarget);
  return populationFactor * (0.5 * fedFactor + 0.5 * wealthFactor);
}

/**
 * How fast development is currently moving, in points per second. Positive
 * and quick while comfortably populated and earning, positive but slow
 * while only getting by, and negative — sliding back down the ladder — once
 * that shortfall is bad enough to call it real neglect rather than a slow
 * week. An empty or penniless place saturates at the fastest decline.
 */
export function developmentRate(trader: Trader): number {
  const severity = 1 - comfort(trader);

  if (severity <= COMFORTABLE) return FAST_RATE;
  if (severity <= STRUGGLING) return SLOW_RATE;

  const over = (severity - STRUGGLING) / (1 - STRUGGLING);
  return -MAX_DECLINE_RATE * over;
}

export function advanceDevelopment(trader: Trader, dt: number): void {
  const next = trader.development + developmentRate(trader) * dt;
  trader.development = Math.max(MIN_DEVELOPMENT, next);
}
