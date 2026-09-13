import { economicActivity, wealthIncomePerMin, type Trader } from './economy';
import { dist, type Vec2 } from './geometry';
import { hashRandom } from './noise';
import type { ResourceNode } from './resourceNode';
import type { TerrainSource } from './source';
import type { Territory } from './territory';
import { ResourceType } from './types';

/**
 * Expansion Capacity: what the civilisation spends to take in new country.
 *
 * Deliberately not money. Wealth is already the measure of trade going well,
 * and if expansion simply cost coin then the best economic play and the best
 * territorial play would be the same play, which is no choice at all. This is
 * the civilisation's *capacity to absorb somewhere new* — the spare people,
 * organisation and confidence that incorporating a frontier site takes. It
 * accrues only from the civilisation actually doing well, which is the whole
 * point: growth is earned by the simulation, and then spent by the player.
 *
 * Three contributors, all read off numbers that already exist:
 *
 * - **People.** The most legible one, and the one that makes a growing realm
 *   visibly speed up.
 * - **Prosperity.** Wealth *income*, not the hoard — a place that is actively
 *   earning, from industry or genuine exports.
 * - **Activity.** How much of what a place wants is actually reaching it
 *   (`economicActivity`, which existed and was unused), scaled by how many
 *   people that is true for. A large realm that cannot supply itself
 *   contributes far less than a smaller one that runs smoothly.
 *
 * Summed per place rather than computed once for the whole civilisation, so
 * a second thriving town genuinely accelerates expansion — "more/better
 * settlements" falls out of the sum instead of needing its own term.
 */
export const CAPACITY_WEIGHTS = {
  /** Per resident, per minute. */
  population: 0.5,
  /** Per unit of wealth earned per minute. */
  prosperity: 0.35,
  /** Per resident, per minute, at a fully-supplied place; nothing at a starving one. */
  activity: 0.9,
} as const;

export interface CapacityBreakdown {
  population: number;
  prosperity: number;
  activity: number;
  total: number;
}

/** What the civilisation is currently earning, and from what — the HUD shows this verbatim. */
export function capacityRatePerMin(traders: readonly Trader[]): CapacityBreakdown {
  let population = 0;
  let prosperity = 0;
  let activity = 0;

  for (const trader of traders) {
    population += CAPACITY_WEIGHTS.population * trader.population;
    prosperity += CAPACITY_WEIGHTS.prosperity * Math.max(0, wealthIncomePerMin(trader));
    activity += CAPACITY_WEIGHTS.activity * economicActivity(trader) * trader.population;
  }

  return { population, prosperity, activity, total: population + prosperity + activity };
}

// ---------------------------------------------------------------------- cost

/** What taking in a site costs at the realm's own doorstep, before anything makes it harder. */
const BASE_COST = 24;
/** Distance beyond the border at which a site costs roughly twice the base. */
const COST_DISTANCE_REFERENCE = 700;
/**
 * How much the ground in between matters. Terrain cost runs 1 (plains) to 3.2
 * (mountains); this pulls that into a milder multiplier, so a mountain claim
 * is dearer than a meadow but not prohibitively so.
 */
const COST_TERRAIN_WEIGHT = 0.45;
/** How much each piece of ground the realm already holds adds to the price of the next. */
const COST_PER_HOLDING = 0.16;
/** Distance from the nearest seat at which remoteness roughly doubles a claim's cost. */
const REMOTENESS_REFERENCE = 1100;

/**
 * How dear a frontier site is to incorporate.
 *
 * Four factors, multiplied, each individually obvious: how far past the
 * border it is, how remote it is from anywhere people actually live, how hard
 * the country between is, and how good the site is. Multiplying keeps the
 * result a single number the player can reason about ("further, lonelier,
 * rockier and richer, so dearer") without a table of modifiers.
 *
 * The border-distance and remoteness terms answer different questions, and
 * both are needed. Border distance (`distanceOutside`, nearest *holding* —
 * claim or seat) is what makes dense infill next to anything already ours
 * cheap, which is right: filling in the country around an outpost you
 * already have shouldn't cost what founding it did. Remoteness is what a
 * flat per-holding tax cannot capture: a chain of claims each just beyond
 * the last is cheap by the border-distance measure at every single hop, so a
 * civilisation could walk a single-file line of resource sites for miles at
 * a nearly flat price per hop — a "snake" with no relationship to where
 * anyone could plausibly live or administer from.
 *
 * Remoteness is charged on the *gap* between those two measures, not on raw
 * distance from the nearest seat outright — that distinction matters. Both
 * measures agree (gap zero) for any claim made directly off a seat, which
 * covers the whole opening game and every bit of ordinary growth hugging an
 * existing town; charging full seat-distance there would tax the first few
 * claims of every game twice for the same distance, before there is even a
 * second holding for "shape" to mean anything. The gap only opens once a
 * claim is anchored on something that is itself far from any seat — exactly
 * a snake's tip — and it widens with every further hop, since the tip keeps
 * retreating from town while staying cheap by the local, nearest-holding
 * measure alone. A compact cluster growing outward from an actual settlement
 * never opens this gap, because its edge stays a claim or two from that
 * settlement however large the cluster gets.
 */
export function expansionCost(node: ResourceNode, territory: Territory, terrain: TerrainSource): number {
  const beyond = territory.distanceOutside(node.position);
  const distanceFactor = 1 + beyond / COST_DISTANCE_REFERENCE;

  const seatDistance = territory.distanceFromNearestSeat(node.position);
  const remoteness = Math.max(0, seatDistance - beyond);
  const remotenessFactor = 1 + remoteness / REMOTENESS_REFERENCE;

  const from = territory.nearestHolding(node.position);
  const groundFactor = from ? 1 + (averageTerrainCost(terrain, from.position, node.position) - 1) * COST_TERRAIN_WEIGHT : 1;

  // A richer site produces faster (see `worldgen.ts`, which divides the
  // interval by richness), so a short interval means a good deposit. Worth
  // more, and priced accordingly.
  const qualityFactor = clamp(BASE_INTERVAL_FOR[node.resource] / node.baseProductionInterval, 0.75, 1.4);

  // A larger realm absorbs its next province less easily than its second.
  //
  // This is also the one thing standing between the loop and a runaway: the
  // capacity a civilisation earns scales with its population, its population
  // scales with the sites it works, and the sites it works scale with what it
  // has claimed — so with a flat price, every claim makes the next one
  // cheaper in real terms and expansion accelerates without limit. Measured
  // before this existed: income reached 137/min against claims costing 40,
  // three expansions a minute, eighty-one sites claimed and only twenty-four
  // of them ever connected to a road. Scaling with what is already held keeps
  // the *cadence* roughly steady as the realm grows, which is what makes each
  // claim continue to feel like a decision rather than a formality.
  const heldFactor = 1 + territory.all.length * COST_PER_HOLDING;

  return Math.max(
    1,
    Math.round(BASE_COST * distanceFactor * remotenessFactor * groundFactor * qualityFactor * heldFactor),
  );
}

/** The unmodified production interval each raw good is generated with — the yardstick for "is this a good site". */
const BASE_INTERVAL_FOR: Record<string, number> = {
  [ResourceType.Wood]: 6,
  [ResourceType.Stone]: 8,
  [ResourceType.Iron]: 10,
  [ResourceType.Food]: 6,
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function averageTerrainCost(terrain: TerrainSource, from: Vec2, to: Vec2): number {
  const steps = Math.max(1, Math.ceil(dist(from, to) / 64));
  let total = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // A road's view of the ground, not a settlement's: crossing a river is
    // dear but possible, so pricing a claim on the far side of one should say
    // "dear" rather than substituting a mountain for it.
    total += terrain.roadCostAt({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return total / (steps + 1);
}

// ----------------------------------------------------------------- frontier

/**
 * How far beyond the border the frontier looks first — the distance at which
 * an offer feels like a natural next step rather than a leap.
 */
export const FRONTIER_REACH = 950;
/**
 * How far it will look if there is genuinely nothing nearer.
 *
 * Without this the realm can hit a hard wall and simply stop: deposits are
 * scattered on a lattice roughly 1300 units apart, so a civilisation that
 * absorbs one cluster can easily find the next one eleven hundred units past
 * its border — fifty units too far — and then no offer exists, so nothing can
 * be claimed, so the border never moves again. Measured on seed 1234: the
 * frontier went empty on day 61 and stayed empty for the rest of the run
 * while capacity piled up to nine hundred unspent.
 *
 * Widening the search rather than widening `FRONTIER_REACH` keeps the usual
 * case tight. And it needs no special pricing, because cost already scales
 * with distance past the border: a site found only at the far end of this
 * range is simply an expensive one, which is exactly what a remote mountain
 * ought to be.
 */
export const FRONTIER_SEARCH_LIMIT = 2600;
/** How many opportunities the player is shown at once. */
const FRONTIER_SLOTS = 4;
/**
 * How far apart two offers have to be before they count as genuinely
 * different directions. Without this the frontier happily offers three sites
 * from the same deposit, which is one choice wearing three hats.
 */
const FRONTIER_SEPARATION = 520;

export interface FrontierCandidate {
  node: ResourceNode;
  cost: number;
  /** How far past the border it sits, for display. */
  beyond: number;
}

/**
 * Which opportunities the frontier is currently offering.
 *
 * The brief for this system was explicit that it must not become a checklist
 * — see the nearest unclaimed site, take it, repeat — so this deliberately
 * does *not* just sort by distance and slice. Two rules do the work:
 *
 * - **One per resource.** The player should be choosing what the realm
 *   reaches for (timber now, or iron later), not which of four identical
 *   farms is nearest. Offering at most one site per good forces every slot to
 *   be a different kind of decision.
 * - **Spread out.** Offers have to sit `FRONTIER_SEPARATION` apart, so they
 *   represent different directions across the map rather than one cluster.
 *
 * Within those rules the pick is by "how natural a next step is this" —
 * mostly closeness to the border, softened by a fixed per-site quirk derived
 * from the world seed. The quirk is what stops the choice being computable:
 * it is stable for a given world (the same seed always offers the same
 * frontier) but it means the offer is not simply "whatever is nearest", so
 * two runs of the same map can still diverge on player decisions rather than
 * on arithmetic.
 */
export function selectFrontier(
  nodes: readonly ResourceNode[],
  territory: Territory,
  terrain: TerrainSource,
  seed: number,
): FrontierCandidate[] {
  // The realm's own middle, for measuring which *way* an offer lies. Offers
  // that all sit in one direction are four versions of the same decision no
  // matter how far apart they are, which is the failure `FRONTIER_SEPARATION`
  // alone could not catch: separation is a distance, and two sites a thousand
  // units apart can still both be east.
  const centre = realmCentre(territory);

  const eligibleAt = (reach: number, surveyedOnly: boolean) => {
    const out: Array<{ node: ResourceNode; beyond: number; score: number; sector: number }> = [];
    for (const node of nodes) {
      if (node.isClaimed) continue;
      // You can only be offered what you actually know about. This is what
      // makes the survey (see `survey.ts`) load-bearing rather than
      // decorative: scouting a corridor with a road genuinely changes what
      // the frontier has to offer, in that direction, which is the whole
      // reason a road drawn toward nothing in particular is ever worth
      // drawing. It also guarantees an offer is never made over country the
      // player cannot see.
      if (surveyedOnly && !node.surveyed) continue;
      const beyond = territory.distanceOutside(node.position);
      if (beyond <= 0 || beyond > reach) continue;
      // Nothing across open water: a site no road could ever reach is not an
      // opportunity, it is a trap the player pays for.
      if (!terrain.isPassable(node.position)) continue;

      // Nearness is a preference, not a cut-off. It used to be `1 - beyond /
      // reach` against a hard `reach` ceiling, which made distance do two
      // jobs at once: rank the offers, and decide which existed at all. The
      // second job is what quietly kept the realm a monoculture. A surveyed
      // realm can see five thousand units in every direction, but stone and
      // iron are deliberately generated far out (1500-3000) while food and
      // wood are near — so a ceiling anywhere near the deposit scale offers
      // nothing but the common goods, whatever the civilisation actually
      // needs. Measured on seed 1234 at day 150: sixty-two deposits visible,
      // forty-one of them stone, exactly one stone ever offered or claimed,
      // and a flat 1.00 stone shortage from day a hundred onward — which
      // freezes every node at level one, since stone is what farms and
      // forests upgrade with.
      //
      // Ranking softly instead lets the nearest *stone* hold the stone slot
      // however far out it is, which is precisely the "timber now, or hold
      // out for the iron" decision the frontier exists to pose. Nothing about
      // distance goes unpunished: `expansionCost` already charges for it, so
      // a far offer is simply an expensive one, and the player pays for the
      // reach in the currency meant for it.
      const closeness = 1 / (1 + beyond / FRONTIER_REACH);
      const quirk = hashRandom(seed, SALT_FRONTIER, node.id, 0);
      out.push({
        node,
        beyond,
        score: closeness + quirk * QUIRK_WEIGHT,
        sector: bearingSector(node.position, centre),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  };

  const pick = (eligible: ReturnType<typeof eligibleAt>) => {
    const chosen: FrontierCandidate[] = [];
    const takenResources = new Set<ResourceType>();
    const takenSectors = new Set<number>();

    // Two passes over the same ranked list, each relaxing one rule. The order
    // matters: variety of *kind* and variety of *direction* are both worth
    // more than the marginal closeness of a fourth offer, but neither is
    // worth leaving a slot empty over — an empty slot is a decision the
    // player simply never gets to make.
    const consider = (entry: (typeof eligible)[number], byKind: boolean, byBearing: boolean) => {
      if (chosen.length >= FRONTIER_SLOTS) return;
      if (chosen.some((c) => c.node === entry.node)) return;
      if (byKind && takenResources.has(entry.node.resource)) return;
      if (byBearing && takenSectors.has(entry.sector)) return;
      if (chosen.some((c) => dist(c.node.position, entry.node.position) < FRONTIER_SEPARATION)) return;
      takenResources.add(entry.node.resource);
      takenSectors.add(entry.sector);
      chosen.push({ node: entry.node, beyond: entry.beyond, cost: expansionCost(entry.node, territory, terrain) });
    };

    for (const entry of eligible) consider(entry, true, true);
    // If the country nearby genuinely only holds one kind of thing, or only
    // lies one way, a realm hemmed in by nothing but forest should still have
    // somewhere to go — relax rather than offer nothing.
    for (const entry of eligible) consider(entry, false, true);
    for (const entry of eligible) consider(entry, false, false);
    return chosen;
  };

  // Widen only as far as it has to, and widen on the question that actually
  // matters. This used to stop the moment *two candidates existed*, which is
  // not the same question as "can the frontier fill its slots": one-per-kind
  // and the separation rule routinely cut those two down to one, so the
  // search stopped at its narrowest step and the player was shown a single
  // offer — measured on seed 1234 as two offers, from two of eight compass
  // sectors, for most of a sixty-day run. Widening until the slots are
  // genuinely full keeps the usual case tight (the first step almost always
  // finds plenty now that the survey is broad) while letting a realm hemmed
  // in by empty country still see its real options.
  // One rule where there used to be a ladder of four widening steps: the
  // frontier offers what the realm knows about. The steps existed only
  // because there was no model of knowledge — reach had to stand in for "how
  // far has anyone actually looked", and it was a poor proxy, being both too
  // narrow to ever offer a strategic resource and too blunt to notice when a
  // realm had nothing nearby at all. With `survey.ts` answering that question
  // properly, the ladder is redundant: the survey *is* the boundary of what
  // may be offered, and it moves because the realm grew or the player scouted
  // rather than because a constant said so.
  let best = pick(eligibleAt(Infinity, true));

  // Last resort: a realm that can see nothing it does not already own must
  // still be able to send someone over the next hill. Requiring an offer to
  // be surveyed is the right rule almost always — it is what makes scouting
  // with a road change what the frontier has to say — but a hard gate that
  // can be permanently on the wrong side of itself is how this project has
  // repeatedly manufactured deadlocks, and this one is reachable: a realm
  // whose horizon happens to fall in a gap between deposit clusters cannot
  // claim, so cannot move its border, so cannot widen its horizon, forever.
  // Relaxing the rule only when it would otherwise offer nothing keeps the
  // gate's meaning everywhere it actually matters.
  if (best.length === 0) best = pick(eligibleAt(FRONTIER_SEARCH_LIMIT, false));

  return best;
}

/** The middle of everything the realm holds — what "which way is this?" is measured from. */
function realmCentre(territory: Territory): Vec2 {
  const holdings = territory.all;
  if (holdings.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const h of holdings) {
    x += h.position.x;
    y += h.position.y;
  }
  return { x: x / holdings.length, y: y / holdings.length };
}

/** How many directions the frontier tries to offer from. */
const BEARING_SECTORS = 6;

function bearingSector(point: Vec2, from: Vec2): number {
  const angle = Math.atan2(point.y - from.y, point.x - from.x);
  return Math.floor((((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * BEARING_SECTORS);
}

const SALT_FRONTIER = 77;
/** How much the per-site quirk is allowed to reorder otherwise-similar offers. */
const QUIRK_WEIGHT = 0.45;
