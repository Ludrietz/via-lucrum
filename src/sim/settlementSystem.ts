import { dist, type Vec2 } from './geometry';
import { TERRAIN_SUITABILITY } from './landUse';
import type { ResourceNode } from './resourceNode';
import type { RoadNetwork } from './roadNetwork';
import { Settlement, SettlementStage, stageFor, tradeFor, type Trade } from './settlement';
import type { TerrainSource } from './source';
import { dominantGood, WEAR_FULL, type TrafficField } from './traffic';
import { ResourceType } from './types';
import type { Village } from './village';

/**
 * Everything the emergence rules are allowed to look at, and the one thing
 * they are allowed to do. Founding touches the road graph, which the world
 * owns, so the system asks rather than reaching in.
 */
export interface SettlementContext {
  traffic: TrafficField;
  terrain: TerrainSource;
  network: RoadNetwork;
  nodes: ResourceNode[];
  village: Village;
  settlements: Settlement[];
  /** Everyone, everywhere — a new place has to have people available to fill it. */
  population: number;
  /** Whether the realm actually holds this ground — see `tryFound`. */
  held(point: Vec2): boolean;
  /**
   * How much free, settleable country surrounds a point, 0 to 1 — see
   * `landUse.ts`'s `surveyGround`. Asked of every candidate patch, so `World`
   * memoises it on a coarse grid.
   */
  room(point: Vec2): number;
  /** Whether another place is already built over this ground — see `tryFound`. */
  occupied(point: Vec2): boolean;
  hours: number;
  found(patch: number, position: Vec2, trade: Trade, potential: number, origin: Origin): void;
}

export interface Origin {
  resource: ResourceType | null;
  share: number;
}

/**
 * Tuning. Every number the emergence rules depend on lives here, so the feel
 * can be changed without reading the logic.
 */
export const SETTLEMENT_TUNING = {
  /** How often candidate ground is re-scored, in seconds. */
  scanInterval: 1.5,
  /**
   * Goods through a patch that count as a thoroughly busy place. Goods decay,
   * so a route settles at a level set by its delivery rate rather than piling
   * up forever: one hard-worked route holds around 15, and ground where two
   * routes overlap roughly doubles that.
   */
  referenceGoods: 20,
  /** Ignore ground quieter than this; most of the network never qualifies. */
  minimumGoods: 4,
  /** Seconds for potential to close on its score. Bigger means slower towns. */
  timeConstant: 95,

  /** Contributions, before crowding is applied. These sum to 1. */
  weights: {
    traffic: 0.3,
    quality: 0.12,
    junction: 0.17,
    resources: 0.13,
    terrain: 0.12,
    room: 0.16,
  },

  /**
   * How far a prospective place looks when it asks whether there is anywhere
   * to grow. Wider than a hamlet will ever need on purpose — the question is
   * not "can we put the first dozen huts down", which almost anywhere passes,
   * but "is this somewhere that could one day be a town", which is exactly
   * the judgement a founder makes and exactly what `terrain` alone (one cell,
   * underfoot) could never answer. Roughly the footprint of a place of two
   * hundred, at `landUse.ts`'s acreage.
   */
  roomRadius: 520,

  /** A junction this close counts fully; further away it tails off. */
  junctionRadius: 150,
  /** Roads meeting here beyond the second each add this much, up to 1. */
  junctionDegreeBonus: 0.28,

  /** Resource nodes closer than this make a place worth stopping at. */
  resourceRange: 520,
  /**
   * Below this much resource proximity, a place may accumulate potential
   * from traffic and junctions alone but never actually founds — a spawn
   * with no working resource nearby has no occupation to give anyone a
   * reason to live there, and stays a ghost the moment it's built. See the
   * `resources` term in `score()`.
   */
  minimumResourceProximity: 0.25,
  /**
   * A forest stays a forest and a mine stays a mine: nothing may take hold on
   * top of a resource site. This is a hard gate, not a penalty, or a busy road
   * ending at a node will happily bury it.
   */
  resourceExclusion: 150,

  /** Nothing may take hold nearer than this to the village or another town. */
  minimumSpacing: 360,
  /** Crowding stops biting entirely at this distance. */
  comfortableSpacing: 640,
} as const;

/**
 * Residents a civilisation needs per place before it may found another.
 * Matched to the Village tier's own population bar (`tier.ts`'s
 * `TIER_POPULATION_THRESHOLDS`, 8), so a civilisation that could not support
 * a second real village does not get to scatter hamlets it will never fill.
 *
 * The gate below used to read `(places + 1) * POPULATION_PER_PLACE`, which
 * counts the settlement-about-to-be-founded twice — once as `places`, once
 * again as the `+ 1`. At the old constant (12) that demanded a population of
 * 24 just to found the *first* settlement, above even the Town population
 * bar (18), and every settlement after it got stricter twice as fast as
 * intended. Playtesting a civilisation that had claimed two dozen sites in
 * a long chain never got past its first settlement — not because the gate
 * was working as designed, but because it was quietly asking for roughly
 * triple what the comment above says it should.
 */
const POPULATION_PER_PLACE = 9;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export interface Candidate {
  patch: number;
  position: Vec2;
  potential: number;
  score: number;
  parts: Record<string, number>;
}

/**
 * Watches the network for places worth living, and lets them grow.
 *
 * There is no rule that says "usage over N spawns a town". A patch of ground
 * is scored on what moves through it, how good the road is, whether routes
 * meet there, what it is near and what it is standing on — and that score is
 * only a target. Potential eases towards it, so a place has to stay useful for
 * a while before anything appears, and slips back if the traffic dries up.
 */
export class SettlementSystem {
  /** Ground being watched but not yet built on, keyed by patch. */
  private readonly candidates = new Map<number, number>();
  private lastParts = new Map<number, Record<string, number>>();
  private sinceScan = 0;

  update(dt: number, ctx: SettlementContext): void {
    this.sinceScan += dt;
    if (this.sinceScan >= SETTLEMENT_TUNING.scanInterval) {
      this.scan(this.sinceScan, ctx);
      this.sinceScan = 0;
    }
  }

  /** Candidate ground, strongest first, for the debug overlay. */
  topCandidates(ctx: SettlementContext, limit = 6): Candidate[] {
    return [...this.candidates.entries()]
      .map(([patch, potential]) => ({
        patch,
        potential,
        position: ctx.traffic.patchCentre(patch),
        score: 0,
        parts: this.lastParts.get(patch) ?? {},
      }))
      .sort((a, b) => b.potential - a.potential)
      .slice(0, limit);
  }

  /** Accumulated potential on a patch, whether or not anything stands there. */
  potentialAt(patch: number, ctx: SettlementContext): number {
    const settled = ctx.settlements.find((s) => s.patch === patch);
    if (settled) return settled.potential;
    return this.candidates.get(patch) ?? 0;
  }

  /** The reasons behind the most recent score for a patch. */
  breakdownAt(patch: number): Record<string, number> {
    return this.lastParts.get(patch) ?? {};
  }

  // ------------------------------------------------------------------ scoring

  private scan(dt: number, ctx: SettlementContext): void {
    const ease = 1 - Math.exp(-dt / SETTLEMENT_TUNING.timeConstant);
    const seen = new Set<number>();

    for (const patch of ctx.traffic.activePatches) {
      const goods = ctx.traffic.totalGoodsAtIndex(patch);
      if (goods < SETTLEMENT_TUNING.minimumGoods) continue;

      const position = ctx.traffic.patchCentre(patch);
      const settled = ctx.settlements.find((s) => s.patch === patch);
      const { score, parts } = this.score(patch, position, ctx, settled ?? null);
      this.lastParts.set(patch, parts);

      if (settled) {
        settled.potential += (score - settled.potential) * ease;
        settled.stage = this.stageOf(settled);
        this.refreshTrade(settled, ctx);
        continue;
      }

      seen.add(patch);
      const potential = (this.candidates.get(patch) ?? 0) + (score - (this.candidates.get(patch) ?? 0)) * ease;
      this.candidates.set(patch, potential);

      if (stageFor(potential) !== SettlementStage.Site) {
        this.tryFound(patch, position, potential, ctx);
      }
    }

    // Ground that has gone quiet loses what it had built up.
    for (const [patch, potential] of this.candidates) {
      if (seen.has(patch)) continue;
      const faded = potential * (1 - ease);
      if (faded < 0.01) this.candidates.delete(patch);
      else this.candidates.set(patch, faded);
    }
  }

  /**
   * What a place is worth, from 0 to 1. Each term is independent and weighted,
   * and crowding scales the whole thing rather than being another term — being
   * next door to an existing town should not be outweighed by heavy traffic.
   */
  private score(
    patch: number,
    position: Vec2,
    ctx: SettlementContext,
    self: Settlement | null,
  ): { score: number; parts: Record<string, number> } {
    const w = SETTLEMENT_TUNING.weights;

    // Resource sites are not building land, however good the road past them is.
    if (this.onTopOfResource(position, ctx)) {
      return {
        score: 0,
        parts: { traffic: 0, quality: 0, junction: 0, resources: 0, terrain: 0, room: 0, crowding: 0, goods: 0 },
      };
    }

    const goods = ctx.traffic.totalGoodsAtIndex(patch);
    const traffic = clamp01(goods / SETTLEMENT_TUNING.referenceGoods);
    const quality = clamp01(ctx.traffic.wearAtIndex(patch) / WEAR_FULL);
    const junction = this.junctionImportance(position, ctx);
    const resources = this.resourceProximity(position, ctx);
    const terrain = TERRAIN_SUITABILITY[ctx.terrain.typeAt(position)] ?? 0;
    // Somewhere to grow into, which is a different question from what is
    // underfoot: a crossroads on a good acre wedged between a mountain, a
    // lake and three working woods has a perfect `terrain` and no future.
    // This is what makes the map's open country worth settling and tells the
    // busy-but-boxed-in spot apart from the busy-and-open one — and, since
    // the same reading later decides how urban the place becomes, a
    // settlement founded with room around it is a settlement that can
    // actually take it.
    const room = ctx.room(position);
    const crowding = this.crowding(position, ctx, self);

    const raw =
      w.traffic * traffic +
      w.quality * quality +
      w.junction * junction +
      w.resources * resources +
      w.terrain * terrain +
      w.room * room;

    const parts = { traffic, quality, junction, resources, terrain, room, crowding, goods };
    // Nothing is founded on ground nothing can stand on. This used to read
    // `terrain > 0`, which was the same test only for as long as water scored
    // exactly zero — and water stopped scoring zero when a town was allowed to
    // run a wharf out over its own river (see `landUse.ts`). Suitability is a
    // *preference*; whether a place can exist at all is a different question,
    // and asking the one that means what it says keeps the two independent.
    const standable = ctx.terrain.isPassable(position) ? 1 : 0;
    return { score: clamp01(raw) * crowding * standable, parts };
  }

  /** Roads meeting nearby make a place matter more than a straight run does. */
  private junctionImportance(position: Vec2, ctx: SettlementContext): number {
    let best = 0;

    for (const node of ctx.network.nodes) {
      if (node.edges.length < 3) continue;

      const d = dist(node.position, position);
      if (d > SETTLEMENT_TUNING.junctionRadius) continue;

      const closeness = 1 - d / SETTLEMENT_TUNING.junctionRadius;
      const degree = clamp01((node.edges.length - 2) * SETTLEMENT_TUNING.junctionDegreeBonus);
      best = Math.max(best, closeness * (0.55 + 0.45 * degree));
    }

    return best;
  }

  private onTopOfResource(position: Vec2, ctx: SettlementContext): boolean {
    return ctx.nodes.some(
      (node) => node.isVisible && dist(node.position, position) < SETTLEMENT_TUNING.resourceExclusion,
    );
  }

  /** Near enough to a resource to be worth stopping at, but not on top of it. */
  private resourceProximity(position: Vec2, ctx: SettlementContext): number {
    let best = 0;

    for (const node of ctx.nodes) {
      // Claimed sites only: an opportunity beyond the border is not work
      // anybody can do yet, so it is no reason for a place to grow here.
      if (!node.isClaimed) continue;

      const d = dist(node.position, position);
      if (d < SETTLEMENT_TUNING.resourceExclusion) return 0;
      if (d > SETTLEMENT_TUNING.resourceRange) continue;

      best = Math.max(best, 1 - d / SETTLEMENT_TUNING.resourceRange);
    }

    return best;
  }

  /**
   * Whether a real, staffed workplace sits close enough to actually hand a
   * new settlement its first resident the moment it founds — see `tryFound`.
   * Same band as `resourceProximity`; this only narrows *which* sites in it
   * count.
   */
  private hasNearbyWorkedSite(position: Vec2, ctx: SettlementContext): boolean {
    // Not merely "is somebody working nearby" but "would founding here
    // actually *win* that worker" — which is the condition the hand-off in
    // `World.foundSettlement` really runs on: a villager moves house only if
    // the new place becomes the nearest trader to their workplace.
    //
    // Asking the weaker question let a settlement found beside a busy site
    // whose worker already called a closer, older place home, and the
    // hand-off then caught nobody. Re-homing happens once, at founding, and
    // is never reconsidered, so such a place opens at zero and has no
    // residents with which to attract more — observed twice in a single
    // hundred-and-fifty-day run, both still at population zero and at the
    // development floor at the end of it. The gap is structural rather than
    // unlucky: `crowding`'s minimum spacing (360) is smaller than
    // `resourceRange` (520), so there is always a band in which a site is
    // "nearby" for a new settlement and nearer still to an existing one.
    //
    // Checking the hand-off's own condition closes it exactly, with no new
    // spacing constant to keep in sync with two others.
    for (const node of ctx.nodes) {
      if (!node.isClaimed || node.workers.length === 0) continue;
      const d = dist(node.position, position);
      if (d < SETTLEMENT_TUNING.resourceExclusion || d > SETTLEMENT_TUNING.resourceRange) continue;
      if (d < this.distanceToNearestSeat(node.position, ctx)) return true;
    }
    return false;
  }

  /** How far the nearest place people already live is from a point. */
  private distanceToNearestSeat(point: Vec2, ctx: SettlementContext): number {
    let nearest = dist(ctx.village.position, point);
    for (const settlement of ctx.settlements) nearest = Math.min(nearest, dist(settlement.position, point));
    return nearest;
  }

  /** Nothing grows in the shadow of somewhere that already exists. */
  private crowding(position: Vec2, ctx: SettlementContext, self: Settlement | null): number {
    const { minimumSpacing, comfortableSpacing } = SETTLEMENT_TUNING;
    let factor = 1;

    const neighbours: Vec2[] = [ctx.village.position];
    for (const settlement of ctx.settlements) {
      if (settlement !== self) neighbours.push(settlement.position);
    }

    for (const neighbour of neighbours) {
      const d = dist(neighbour, position);
      if (d <= minimumSpacing) return 0;
      factor = Math.min(factor, clamp01((d - minimumSpacing) / (comfortableSpacing - minimumSpacing)));
    }

    return factor;
  }

  // ---------------------------------------------------------------- emergence

  private tryFound(patch: number, position: Vec2, potential: number, ctx: SettlementContext): void {
    // A place with nothing to actually do nearby has no reason for anyone
    // to live there once it exists — heavy through-traffic and a good
    // junction can carry a crossroads to full potential on their own, but
    // that just produces a settlement with no local jobs, which stays
    // permanently empty. Gate founding on the same `resources` term the
    // score already computes, so every settlement is founded near real,
    // nearby work.
    const resources = this.lastParts.get(patch)?.resources ?? 0;
    if (resources < SETTLEMENT_TUNING.minimumResourceProximity) return;

    // People settle on the realm's own ground, and nowhere else.
    //
    // This is the border's job. Before it existed, `Territory` was consulted
    // by exactly two things — what a claim costs, and how far ahead the world
    // needs generating — neither of which the player ever sees, so the line
    // drawn across the map was decoration: settlements founded wherever the
    // traffic happened to be busy, cheerfully outside the realm they
    // supposedly belonged to, and claiming ground bought nothing anyone could
    // point at.
    //
    // With this, a claim is what it should always have been: opening a
    // province the realm can actually grow into. It closes the loop the two
    // verbs are supposed to form — prosper, earn capacity, take in country,
    // *have somewhere for a town to appear*, prosper — where before the
    // middle link was missing and towns appeared regardless of whether the
    // player had ever expanded at all.
    //
    // A hard gate rather than a discount, which this project is otherwise
    // rightly wary of: "the realm does not hold this ground" is categorical
    // in the same way "a settlement cannot sit on top of a resource site" is,
    // not a matter of degree. It cannot deadlock, because founding already
    // requires a *claimed, staffed* site within `resourceRange` (520) and a
    // claim holds `CLAIM_RADIUS` (380) of ground around itself plus the whole
    // corridor back to the realm — so any patch this gate rejects has held
    // ground a couple of hundred units away, and the traffic that made it a
    // candidate runs through that ground too.
    if (!ctx.held(position)) return;

    // And not on ground somebody else's town is already standing on.
    //
    // `crowding` looks like it covers this and does not quite: it measures
    // from a neighbour's *centre* at a fixed 360 units, while a place's
    // sprawl grows with its population and passes that figure somewhere
    // around a hundred residents. A settlement founded inside a big
    // neighbour's fields would be born with nowhere to put a single house —
    // every cell around it already held, and settled ground is the one thing
    // nothing may take (see `LandRegistry.canClaim`) — so it would open
    // starved, never build housing, and sit at the development floor forever.
    // That is the 0-population settlement failure arriving by a new road.
    //
    // Categorical rather than a penalty, exactly like "nothing may take hold
    // on top of a resource site" above, and for the same reason: this is not
    // a matter of degree.
    if (ctx.occupied(position)) return;

    // `resources` alone counts a claimed-but-unstaffed site exactly the same
    // as a busy one — it only asks "is there ground worth working nearby",
    // not "is anyone actually working it right now". `World.foundSettlement`
    // gives a brand-new settlement its first residents by re-homing whoever
    // is already working the nearest site to it; if nobody is working
    // anywhere nearby at the moment of founding, that hand-off has nobody to
    // hand off, and the settlement opens at zero with nothing left to change
    // that — hiring and migration both key off *existing* settlements
    // pulling people in, not empty ones with no residents to attract more.
    // Observed directly: a settlement thirty-six days old, still at zero,
    // sitting on a resource site nobody had been posted to yet when it
    // founded. Requiring a worked site nearby is the same gate the founding
    // hand-off already assumes; this just makes it real.
    if (!this.hasNearbyWorkedSite(position, ctx)) return;

    // Places are founded by people, and there have to be some to spare.
    // Nothing checked this, so once the network got busy enough that several
    // patches cleared the potential threshold at once, settlements appeared
    // at whatever rate the traffic allowed — ten of them for a civilisation
    // of thirty, four of which never held a single resident and sat at the
    // development floor forever wearing a name and a label. That is the
    // "0-population settlement" failure in its purest form, and no amount of
    // tuning migration fixes it, because the problem is that the place should
    // never have existed yet. A civilisation earns its next village by being
    // big enough to populate one.
    const places = ctx.settlements.length + 1;
    if (ctx.population < places * POPULATION_PER_PLACE) return;

    const tally = ctx.traffic.goodsAtIndex(patch);
    const { resource, share } = dominantGood(tally);
    const trade = tradeFor(resource, share);

    ctx.found(patch, position, trade, potential, { resource, share });
    this.candidates.delete(patch);
  }

  /** A settlement never unbuilds itself, however quiet it gets. */
  private stageOf(settlement: Settlement): SettlementStage {
    const stage = stageFor(settlement.potential);
    return stage === SettlementStage.Site ? SettlementStage.Roadside : stage;
  }

  /** Keep the trade honest: a place that turns to iron should say so. */
  private refreshTrade(settlement: Settlement, ctx: SettlementContext): void {
    const { resource, share } = dominantGood(ctx.traffic.goodsAtIndex(settlement.patch));
    const trade = tradeFor(resource, share);
    if (trade.key !== settlement.trade.key) settlement.trade = trade;
  }
}
