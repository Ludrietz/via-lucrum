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

/**
 * Residents one point of standing fabric houses, and the roof over the heads
 * of anyone living somewhere that has built nothing at all.
 *
 * Capacity is read off the fabric *continuously*, and the level table above
 * survives only as a label for the inspector. It used to be the other way
 * round — five rungs with hard thresholds — and once housing started costing
 * real material that turned into a genuine trap at the top of the ladder. A
 * place at the last rung wanted nothing more, so it built nothing, so its
 * fabric decayed, so it dropped a rung and lost twenty-five of its eighty
 * places overnight, so its population fell, and it then rebuilt the same rung
 * to lose it again. Measured on seed 1234 at day 91: the capital sat at
 * exactly 100.0 dwelling fabric, losing 3.6 a day with eighty-seven fabric of
 * material on its own shelves and no project it was willing to spend them on,
 * while its population fell from 65 to 52.
 *
 * A cliff in a quantity that decays is a cliff something will sit astride.
 * Read continuously there is no top rung to stall at: a place always has
 * *some* reason to keep building, upkeep is an ordinary project rather than a
 * special case, and how big a place can get is settled by the three things
 * that should settle it — the ground it has, the material it can get, and how
 * much of that material simply goes on keeping the roofs on.
 */
const RESIDENTS_PER_FABRIC = 0.7;
const HOUSING_BASE = 10;

/*
 * Housing used to be a "cumulative construction progress" that accrued at a
 * flat half a point a second for any place that felt crowded, attached to no
 * resource at all. The comment justifying that is worth remembering, because
 * it was right about the thing it was avoiding: drawing housing straight out
 * of wood was tried twice and reverted twice, both times because it competed
 * head-on with ordinary demand, node investment and the industries for the
 * same tight timber, and reliably tipped the wood economy into a starvation
 * spiral that crashed population civilisation-wide.
 *
 * What was wrong was the *claim*, not the idea that houses cost something. A
 * claim that can only ever eat genuine surplus — material above what the
 * place wants on hand for its own living — cannot start that spiral, because
 * in a tight economy it simply builds nothing. That is what
 * `construction.ts` does, and it is why houses can cost material again.
 *
 * The numbers are denominated in goods somebody actually carried here: a
 * hundred residents want roughly a hundred and thirty fabric, which is a
 * hundred and thirty logs, or — if the place has a sawmill — forty-three
 * planks. That gap is the point.
 */

/** How many residents a trader's housing can hold right now, read straight off what it has built. */
export function housingCapacity(trader: Trader): number {
  return HOUSING_BASE + trader.dwellings * RESIDENTS_PER_FABRIC;
}

/** How many residents a given amount of standing dwelling fabric would house. */
export function capacityForFabric(dwellings: number): number {
  return HOUSING_BASE + dwellings * RESIDENTS_PER_FABRIC;
}

/** Which rung of the ladder a place's housing reads as — a label for the inspector, nothing more. */
export function housingLevelFor(dwellings: number): number {
  const capacity = capacityForFabric(dwellings);
  let level = HOUSING_LEVELS[0].level;
  for (const info of HOUSING_LEVELS) {
    if (capacity >= info.capacity) level = info.level;
  }
  return level;
}

/** The capacity the next rung would bring, if this place is not already past the last one. */
export function nextHousingCapacity(trader: Trader): number | null {
  const capacity = housingCapacity(trader);
  return HOUSING_LEVELS.find((info) => info.capacity > capacity)?.capacity ?? null;
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
