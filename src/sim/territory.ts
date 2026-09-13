import { closestPointOnPolyline, dist, type Vec2 } from './geometry';

/**
 * What the civilisation actually holds.
 *
 * The old model asked "how far does this place's influence reach", answered
 * it with a radius read off the place's tier, and let the answer grow on its
 * own as the simulation prospered. That made expansion automatic: a village
 * that did well reached further, which reached a deposit, which made it do
 * better. The player never chose anything.
 *
 * Territory is now a set of deliberate acts. Every piece of it is here
 * because something was incorporated — the founding seat, a settlement that
 * grew inside the realm, or a frontier node the player paid to take in — and
 * nothing widens it except another such act. Simulation values still shape
 * the *look* of the border (a city holds more ground around itself than a
 * hamlet does) but they can no longer push it outward over new country.
 *
 * The shape is deliberately not a list of circles. Each holding contributes a
 * smooth bump to one scalar field, and incorporating something also takes in
 * the ground *between* it and the realm it joined (`link`), so the realm
 * grows a lobe out toward what it claimed rather than sprouting a detached
 * bubble. Tracing one contour through that field (see `InfluenceLayer`) is
 * what turns it into a single irregular outline instead of overlapping discs.
 */
export interface Holding {
  /** Stable across ticks, so the renderer can tell a new holding from a grown one. */
  readonly key: string;
  /** A seat is a place people live; a claim is ground taken in for what is on it. */
  readonly kind: 'seat' | 'claim';
  readonly position: Vec2;
  /** How much ground this holding itself holds. */
  readonly radius: number;
  /**
   * Where the realm reached out from when this was incorporated. The ground
   * along that line is held too — which is what makes an expansion read as
   * the realm growing toward something rather than teleporting to it.
   */
  readonly link: Vec2 | null;
}

/** How much ground a claimed resource site brings into the realm around itself. */
export const CLAIM_RADIUS = 380;
/** How wide the corridor taken in alongside a claim is. */
const LINK_RADIUS = 210;
/** Contour level the border is drawn at, and the line `contains` tests against. */
export const TERRITORY_THRESHOLD = 0.1;

/**
 * A holding's own contribution to the field: 1 at its centre, easing to 0 at
 * its radius. Squared rather than linear so two neighbouring holdings blend
 * into one broad shape instead of meeting in a visible crease.
 */
function bump(distance: number, radius: number): number {
  if (radius <= 0 || distance >= radius) return 0;
  return 1 - (distance / radius) ** 2;
}

/**
 * The realm as one field, plus the questions the rest of the game asks of it.
 *
 * Deliberately not a grid. The world is 40,000 units across and mostly empty;
 * a dense array over it would be enormous, and the interesting queries
 * ("is this point ours", "how far outside are we") are all local. Evaluating
 * a handful of holdings per sample is cheaper and has no resolution to pick.
 */
export class Territory {
  private readonly holdings: Holding[] = [];

  /** Everything held right now, for the renderer and for the frontier search. */
  get all(): readonly Holding[] {
    return this.holdings;
  }

  get isEmpty(): boolean {
    return this.holdings.length === 0;
  }

  /**
   * Take in new ground. `link` is the point in the existing realm this was
   * reached from; passing null (the founding seat) simply holds its own
   * ground with nothing to connect back to.
   */
  incorporate(holding: Holding): void {
    this.holdings.push(holding);
  }

  /** Replace a holding's radius in place — a seat's footprint grows with the place. */
  resize(key: string, radius: number): void {
    const index = this.holdings.findIndex((h) => h.key === key);
    if (index < 0) return;
    const existing = this.holdings[index];
    if (Math.abs(existing.radius - radius) < 1) return;
    this.holdings[index] = { ...existing, radius };
  }

  has(key: string): boolean {
    return this.holdings.some((h) => h.key === key);
  }

  /** How strongly this point belongs to the realm. Above `TERRITORY_THRESHOLD` is inside. */
  fieldAt(x: number, y: number): number {
    let sum = 0;
    for (const holding of this.holdings) {
      sum += bump(Math.hypot(x - holding.position.x, y - holding.position.y), holding.radius);
      if (holding.link) {
        const d = closestPointOnPolyline([holding.link, holding.position], { x, y }).distance;
        sum += bump(d, LINK_RADIUS);
      }
    }
    return sum;
  }

  contains(point: Vec2): boolean {
    return this.fieldAt(point.x, point.y) >= TERRITORY_THRESHOLD;
  }

  /**
   * Roughly how far outside the border a point sits, in world units, or 0 if
   * it is inside.
   *
   * Measured against the nearest holding's own edge rather than by walking
   * the traced contour. That is an approximation — the real border bulges
   * slightly where holdings overlap — but it is cheap, monotone, and every
   * caller (expansion cost, frontier eligibility) wants "how much further out
   * is this than that", which the approximation orders correctly.
   */
  distanceOutside(point: Vec2): number {
    let nearest = Infinity;
    for (const holding of this.holdings) {
      nearest = Math.min(nearest, dist(point, holding.position) - holding.radius);
      if (holding.link) {
        const d = closestPointOnPolyline([holding.link, holding.position], point).distance;
        nearest = Math.min(nearest, d - LINK_RADIUS);
      }
    }
    return Math.max(0, nearest);
  }

  /** The nearest point of the realm to somewhere outside it — where a claim's corridor starts. */
  nearestHolding(point: Vec2): Holding | null {
    let best: Holding | null = null;
    let bestDistance = Infinity;
    for (const holding of this.holdings) {
      const d = dist(point, holding.position);
      if (d < bestDistance) {
        bestDistance = d;
        best = holding;
      }
    }
    return best;
  }

  /**
   * The nearest *seat* — the village or a settlement, somewhere people
   * actually live — as opposed to a bare resource claim with nobody on it.
   *
   * This is the distinction `expansionCost` needs to price a claim
   * realistically. `nearestHolding` answers "what's the closest thing we
   * already own", which a chain of claims satisfies just as well as a
   * compact cluster around a town — so pricing purely off that lets a player
   * walk a single-file line of claims arbitrarily far from anywhere anyone
   * lives, one cheap hop at a time. Seats are where the administration, the
   * labour pool and the roads-worth-having actually are; a claim's real cost
   * is how far it sits from one of those, not from whatever was claimed
   * immediately before it.
   */
  nearestSeat(point: Vec2): Holding | null {
    let best: Holding | null = null;
    let bestDistance = Infinity;
    for (const holding of this.holdings) {
      if (holding.kind !== 'seat') continue;
      const d = dist(point, holding.position);
      if (d < bestDistance) {
        bestDistance = d;
        best = holding;
      }
    }
    return best;
  }

  /** How far past the nearest seat's own footprint a point sits — 0 if within it, or if there is no seat at all. */
  distanceFromNearestSeat(point: Vec2): number {
    const seat = this.nearestSeat(point);
    if (!seat) return 0;
    return Math.max(0, dist(point, seat.position) - seat.radius);
  }

  /** Every centre the world should keep generated and uncovered around, with how far. */
  reachPoints(margin: number): Array<{ position: Vec2; reach: number }> {
    const out: Array<{ position: Vec2; reach: number }> = [];
    for (const holding of this.holdings) {
      out.push({ position: holding.position, reach: holding.radius + margin });
      // The corridor's midpoint too, so a long link doesn't leave a gap of
      // ungenerated ground running through the middle of the realm.
      if (holding.link) {
        out.push({
          position: { x: (holding.link.x + holding.position.x) / 2, y: (holding.link.y + holding.position.y) / 2 },
          reach: LINK_RADIUS + margin,
        });
      }
    }
    return out;
  }
}
