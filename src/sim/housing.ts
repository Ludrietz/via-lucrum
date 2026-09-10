import type { Trader } from './economy';

/**
 * How many residents a place's housing can actually hold, at each level it
 * can grow into. Independent of tier and wealth on purpose: a place that
 * genuinely needs more hands has to be able to grow room for them whether
 * or not it happens to be "comfortable" yet — tying this to tier would make
 * it circular, since a struggling place is exactly the one that most needs
 * to keep growing.
 */
export interface HousingLevelInfo {
  level: number;
  capacity: number;
}

export const HOUSING_LEVELS: readonly HousingLevelInfo[] = [
  { level: 1, capacity: 10 },
  { level: 2, capacity: 20 },
  { level: 3, capacity: 35 },
  { level: 4, capacity: 55 },
  { level: 5, capacity: 80 },
];

/** Cumulative construction progress needed to reach each level above the first. */
export const HOUSING_INVESTMENT_THRESHOLDS: readonly number[] = [0, 20, 60, 140, 300];

/**
 * Progress per second while actually building. Drawing this straight out of
 * wood (or any other raw good) was tried first and reverted, twice: housing
 * is one more claim competing with node investment, industries and
 * ordinary demand for the exact same tight resource, and with several
 * settlements each drawing on it at once — sometimes gently, sometimes
 * more — it reliably tipped the whole wood economy into a starvation
 * spiral that crashed population civilisation-wide, once even to zero.
 * Progress here is unattached to any shelf: a place under real pressure
 * just works on more room over time, the same way tier progress accrues
 * from being comfortable rather than from spending anything concrete.
 */
const HOUSING_BUILD_RATE = 0.5;

function housingLevelFor(invested: number): number {
  let level = HOUSING_LEVELS[0].level;
  for (let i = 0; i < HOUSING_INVESTMENT_THRESHOLDS.length; i++) {
    if (invested >= HOUSING_INVESTMENT_THRESHOLDS[i]) level = HOUSING_LEVELS[i].level;
  }
  return level;
}

function isMaxHousingLevel(level: number): boolean {
  return level >= HOUSING_LEVELS[HOUSING_LEVELS.length - 1].level;
}

/** How many residents a trader's housing can hold right now, read straight off its investment. */
export function housingCapacity(trader: Trader): number {
  const level = housingLevelFor(trader.housingInvestment);
  return HOUSING_LEVELS[level - 1].capacity;
}

/** The progress total that would unlock the next level of housing, if any. */
export function nextHousingThreshold(trader: Trader): number | null {
  const level = housingLevelFor(trader.housingInvestment);
  if (isMaxHousingLevel(level)) return null;
  return HOUSING_INVESTMENT_THRESHOLDS[level];
}

/**
 * A place works on more housing whenever it's genuinely crowded — most of
 * its current capacity actually occupied, not only once it's overflowing,
 * since population eases toward its target and bounces around whatever a
 * place can support rather than sitting pinned exactly at the ceiling.
 * Progress pauses whenever it isn't crowded: a place with room to spare has
 * no reason to keep building more.
 */
export function advanceHousing(trader: Trader, dt: number): void {
  const level = housingLevelFor(trader.housingInvestment);
  if (isMaxHousingLevel(level)) return;
  if (trader.population < HOUSING_LEVELS[level - 1].capacity * 0.8) return;

  trader.housingInvestment += HOUSING_BUILD_RATE * dt;
}
