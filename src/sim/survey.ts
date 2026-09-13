import { closestPointOnPolyline, dist, type Vec2 } from './geometry';
import { Tier } from './tier';

/**
 * What the civilisation *knows about*, as opposed to what it owns.
 *
 * These are two different questions, and collapsing them was the same mistake
 * this project has now made twice in opposite directions.
 *
 * The first version answered both with one radius: a place's influence ring
 * revealed country *and* handed it over, free, so prospering silently annexed
 * the map and the player was never asked anything. The territory redesign
 * correctly split ownership out — but it then made the *frontier offer list*
 * the entire visibility model, so the player could see precisely the two to
 * four sites currently on the table and nothing else, and a site that stopped
 * being offered went dark again. Measured on seed 1234 at day 60: a hundred
 * and ten deposits decided, eleven ever drawn, offers arriving from two of
 * eight compass sectors, and iron never once visible in the whole run. That
 * is not a frontier, it is a keyhole — and it makes the one real decision in
 * the game ("which way should the realm grow?") unanswerable, because the
 * player has no idea what is out there in any direction.
 *
 * So knowledge is its own thing now, and it obeys rules an offer list cannot:
 *
 * - **It is monotone.** Somewhere the realm has once surveyed stays known.
 *   Forgetting a deposit is not a design choice, it is an illusion of
 *   scarcity that costs the player the ability to plan.
 * - **It grants nothing.** This is what makes it safe to be generous with,
 *   and it is the precise distinction the old influence system failed to
 *   draw. Knowing where the iron is does not give you the iron; it is still
 *   bought with Expansion Capacity like everything else. A surveyed site
 *   cannot be worked, cannot be routed to, and cannot anchor a road.
 * - **It comes from presence, not from prosperity alone.** Seats survey the
 *   country around them, claims survey their own neighbourhood, and roads
 *   survey the corridor they run through — which is what makes "roads open
 *   the world" literally true rather than merely stated, and makes a long
 *   trunk road pay for itself twice: in what it connects, and in everything
 *   it finds along the way.
 *
 * Because a seat's horizon grows with its tier, a prospering realm does see
 * further — the feedback loop the influence system was rightly killed for.
 * The loop is harmless here for exactly one reason: seeing further no longer
 * *does* anything on its own. It widens the menu, not the realm.
 */

/**
 * How far a place can see, by tier. Much larger than `TIER_FOOTPRINT` (what a
 * place *holds*) and roughly the scale the old influence rings ran at, which
 * is the right scale for a horizon — it was only ever the wrong scale for
 * ownership.
 *
 * These numbers are calibrated against the deposit lattice, not picked for
 * feel. `worldgen.ts` scatters deposit clusters roughly 1300 units apart, and
 * the first version of this table opened at 1400 — which is the same number.
 * A horizon sitting *at* the spacing of the thing it is meant to reveal makes
 * "can this realm see anything at all?" a coin flip on the seed: measured
 * across six seeds, two opened with the nearest unclaimed deposit at 1667 and
 * 1849 units, saw literally nothing beyond their founding sites, and — since
 * the frontier only offers surveyed country — could never claim, never grow
 * the border, and never widen the horizon. A dead game from turn one, on a
 * third of seeds. A horizon has to comfortably clear the lattice it looks
 * across or it is not a horizon, it is a coin flip; these open at nearly two
 * rings of deposits and reach four or five by the time a place is a city.
 */
export const TIER_HORIZON: Record<Tier, number> = {
  [Tier.Hamlet]: 2400,
  [Tier.Village]: 2900,
  [Tier.Town]: 3500,
  [Tier.City]: 4200,
  [Tier.MajorCity]: 5000,
};

/**
 * How far a claimed deposit sees around itself — there are people out there
 * working it, and they know their own valley. Above the lattice spacing for
 * the same reason as the table above: this is what makes the realm's
 * knowledge follow its *border* outward in every direction, rather than
 * staying a disc around the capital.
 */
export const CLAIM_HORIZON = 1500;

/**
 * How wide a corridor a road surveys. Deliberately narrow: a road tells you
 * about the country it actually passes through, which is what makes the
 * *route* a player picks matter rather than merely the endpoints. A scouting
 * track that leads nowhere still grows over — and what it found stays found,
 * which is the whole reason such a track is ever worth drawing.
 */
export const ROAD_HORIZON = 480;

/** One place the realm can see from, and how far. */
export interface SurveySource {
  /** A point, or a polyline for a road corridor. */
  readonly path: Vec2[];
  readonly horizon: number;
}

/** How far outside every survey source a point sits — 0 if it is known. */
export function distanceToSurvey(sources: readonly SurveySource[], point: Vec2): number {
  let nearest = Infinity;
  for (const source of sources) {
    const d =
      source.path.length === 1
        ? dist(source.path[0], point)
        : closestPointOnPolyline(source.path, point).distance;
    nearest = Math.min(nearest, d - source.horizon);
    if (nearest <= 0) return 0;
  }
  return Math.max(0, nearest);
}

export function isSurveyed(sources: readonly SurveySource[], point: Vec2): boolean {
  return distanceToSurvey(sources, point) <= 0;
}

/**
 * Points along a path no further apart than `spacing`, always including both
 * ends. Used to turn a road corridor into a handful of overlapping discs for
 * whatever wants to work in discs (chunk generation, uncovering) rather than
 * in polylines.
 */
export function sampleAlong(path: readonly Vec2[], spacing: number): Vec2[] {
  if (path.length <= 1) return [...path];
  const out: Vec2[] = [path[0]];
  let since = 0;
  for (let i = 1; i < path.length; i++) {
    since += dist(path[i - 1], path[i]);
    if (since >= spacing) {
      out.push(path[i]);
      since = 0;
    }
  }
  const last = path[path.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
