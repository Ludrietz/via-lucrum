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
 * How far behind its own wanted acreage a place may fall before it counts as
 * having nowhere to build.
 *
 * Ordinary growth never comes near this. A parcel takes six cells a second
 * (see `World`'s `LAND_CELLS_PER_PASS`) and a growing population asks for
 * roughly six more every nine, so a place with country around it runs at
 * satisfaction 1 essentially all the time and only dips for a moment after a
 * birth. Sitting below three-quarters means it is genuinely losing the race
 * for ground — to water, to crag, to a neighbour, or to the workings it lives
 * beside.
 */
const ROOM_TO_BUILD = 0.75;

/**
 * Whether a place has the ground to put more houses on.
 *
 * Two readings of the same fact, because one of them is nearly unreachable on
 * its own. `starved` is the categorical case — a growth pass found *nothing*
 * worth taking anywhere on the parcel's edge — which in practice needs the
 * place to be walled in by water, mountain and other people's ground on every
 * side at once. That is the right answer when it happens and far too rare to
 * be the whole of the rule: a place can be comprehensively out of room while
 * still finding the odd poor cell to creep onto, and the honest signal for
 * that is simply being unable to keep up with what it already wants.
 */
export function hasRoomToBuild(trader: Trader): boolean {
  return !trader.ground.starved && trader.roomSatisfaction >= ROOM_TO_BUILD;
}

/**
 * A place works on more housing whenever it's genuinely crowded — most of
 * its current capacity actually occupied, not only once it's overflowing,
 * since population eases toward its target and bounces around whatever a
 * place can support rather than sitting pinned exactly at the ceiling.
 * Progress pauses whenever it isn't crowded: a place with room to spare has
 * no reason to keep building more.
 *
 * And whenever it has nowhere to put them. Houses need ground to stand on,
 * and a place whose sprawl has run out of country it can take — the valley
 * ends, the river turns, the neighbouring works hold everything worth having —
 * cannot build its way past that. This is where that fact enters the economy,
 * and it is the mechanism behind the whole rural/urban split: nothing tells a
 * village hemmed in by four mines that it may not become a city, it simply
 * never gets the room to house the people a city needs, and `tier.ts`'s
 * population bar does the rest.
 */
export function advanceHousing(trader: Trader, dt: number): void {
  const level = housingLevelFor(trader.housingInvestment);
  if (isMaxHousingLevel(level)) return;
  if (trader.population < HOUSING_LEVELS[level - 1].capacity * 0.8) return;
  if (!hasRoomToBuild(trader)) return;

  trader.housingInvestment += HOUSING_BUILD_RATE * dt;
}
