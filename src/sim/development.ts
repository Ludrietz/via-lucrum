import { DEMAND_PER_CAPITA_PER_MIN, shortage, wealthIncomePerMin, type Trader } from './economy';
import { RAW_GOODS } from './traffic';

/**
 * How a place actually climbs the tier ladder: wealth generation and
 * population, nothing else. Not wood/stone shortage any more — a place that
 * nobody lives in but happens to be comfortably stocked used to be able to
 * coast at the top tier forever, which is exactly backwards. Tier should be
 * a consequence of a place actually being a going concern, not a
 * disconnected number it accumulated.
 */

/** Points per second at the very best a place can be doing. */
const BEST_RATE = 0.35;
/** Points per second at the very worst. Steeper than growth — neglect bites — but not the twentyfold gap it used to be. */
const WORST_RATE = 0.6;
/**
 * The comfort a place neither grows nor slides at. Below the midpoint on
 * purpose: an ordinary, decently-run place should tick upward, and it should
 * take real neglect — not merely being unremarkable — to lose ground.
 */
const BREAK_EVEN = 0.45;

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
/**
 * How much of comfort is "is this place supplied" versus "is it earning".
 * Weighted toward provision: every place can reach it by being well run,
 * while wealth income depends on having somewhere to sell to or something
 * to refine, which is not available to everyone at every stage.
 */
const PROVISION_WEIGHT = 0.65;

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
  const incomeTarget = WEALTH_PER_CAPITA_TARGET * Math.max(1, trader.population);
  const wealthFactor = clamp01(wealthIncomePerMin(trader) / incomeTarget);
  return populationFactor * (PROVISION_WEIGHT * provision(trader) + (1 - PROVISION_WEIGHT) * wealthFactor);
}

/**
 * How well a place is actually supplied, across everything its residents
 * live on, weighted by how much of each they get through.
 *
 * Food alone was the whole of this term, and it made the formula knife-edged
 * in a way that is easy to miss on paper: a perfectly fed place with no
 * wealth income scored exactly 0.5, which is exactly `STRUGGLING`, so the
 * *smallest* dip in the larder tipped it from "slow climb" into "fastest
 * decline". In practice the founding village — the one place in the game
 * structurally guaranteed to earn no wealth, because it is where everything
 * is carried *to* rather than sold *from* — sat at the development floor
 * with sixty-seven well-fed residents, permanently labelled a hamlet.
 *
 * Weighting by demand is what makes this a real readout rather than a single
 * boolean about grain: food and firewood are most of what a place needs, so
 * covering those two alone already reads as "getting by", and stone, iron
 * and the worked goods on top of them are what "thriving" actually means.
 * Wealth still decides who reaches the fast lane; it is no longer the
 * difference between holding on and sliding.
 */
function provision(trader: Trader): number {
  let weight = 0;
  let met = 0;
  // Raw goods only. The worked goods are deliberately left out: they sit at
  // full shortage at every place in the game until somebody's industry is
  // actually running, so counting them here would mean *no* place could be
  // well provisioned during the entire early game — the same saturation trap
  // that made `MigrationSystem`'s opportunity score inert. Industry's
  // contribution to a place doing well arrives through the wealth term
  // instead, which is where it belongs.
  for (const resource of RAW_GOODS) {
    const w = DEMAND_PER_CAPITA_PER_MIN[resource];
    weight += w;
    met += w * (1 - shortage(trader, resource));
  }
  return weight > 0 ? met / weight : 0;
}

/**
 * How fast development is currently moving, in points per second: a straight
 * line through `BREAK_EVEN`, positive above it and negative below.
 *
 * This used to be three flat zones — fast, slow, and a decline that ramped to
 * more than four times the fast rate. Two things were wrong with that. The
 * cliff sat exactly where an ordinary well-run place landed, so the same
 * village would flip between climbing and crashing on a rounding error in
 * its larder. And the asymmetry meant a place had to be comfortable roughly
 * two-thirds of the time merely to hold station, which in practice meant
 * almost everywhere lived pinned at the development floor wearing a "hamlet"
 * label over sixty-odd residents. Development is supposed to be a readout of
 * how a place is doing; a readout should move smoothly with the thing it
 * reads, not snap between three states.
 */
export function developmentRate(trader: Trader): number {
  const c = comfort(trader);
  if (c >= BREAK_EVEN) return (BEST_RATE * (c - BREAK_EVEN)) / (1 - BREAK_EVEN);
  return (-WORST_RATE * (BREAK_EVEN - c)) / BREAK_EVEN;
}

export function advanceDevelopment(trader: Trader, dt: number): void {
  const next = trader.development + developmentRate(trader) * dt;
  trader.development = Math.max(MIN_DEVELOPMENT, next);
}
