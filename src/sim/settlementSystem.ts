import { dist, type Vec2 } from './geometry';
import type { ResourceNode } from './resourceNode';
import type { RoadNetwork } from './roadNetwork';
import { Settlement, SettlementStage, stageFor, tradeFor, type Trade } from './settlement';
import { TerrainType, type TerrainGrid } from './terrain';
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
  terrain: TerrainGrid;
  network: RoadNetwork;
  nodes: ResourceNode[];
  village: Village;
  settlements: Settlement[];
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
    traffic: 0.34,
    quality: 0.15,
    junction: 0.19,
    resources: 0.14,
    terrain: 0.18,
  },

  /** A junction this close counts fully; further away it tails off. */
  junctionRadius: 150,
  /** Roads meeting here beyond the second each add this much, up to 1. */
  junctionDegreeBonus: 0.28,

  /** Resource nodes closer than this make a place worth stopping at. */
  resourceRange: 520,
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

/** How willingly each kind of ground is built on. */
const TERRAIN_SUITABILITY: Record<TerrainType, number> = {
  [TerrainType.Plains]: 1,
  [TerrainType.Forest]: 0.62,
  [TerrainType.Hills]: 0.34,
  [TerrainType.Mountains]: 0,
  [TerrainType.Water]: 0,
};

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
      return { score: 0, parts: { traffic: 0, quality: 0, junction: 0, resources: 0, terrain: 0, crowding: 0, goods: 0 } };
    }

    const goods = ctx.traffic.totalGoodsAtIndex(patch);
    const traffic = clamp01(goods / SETTLEMENT_TUNING.referenceGoods);
    const quality = clamp01(ctx.traffic.wearAtIndex(patch) / WEAR_FULL);
    const junction = this.junctionImportance(position, ctx);
    const resources = this.resourceProximity(position, ctx);
    const terrain = TERRAIN_SUITABILITY[ctx.terrain.typeAt(position)] ?? 0;
    const crowding = this.crowding(position, ctx, self);

    const raw =
      w.traffic * traffic +
      w.quality * quality +
      w.junction * junction +
      w.resources * resources +
      w.terrain * terrain;

    const parts = { traffic, quality, junction, resources, terrain, crowding, goods };
    return { score: clamp01(raw) * crowding * (terrain > 0 ? 1 : 0), parts };
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
      if (!node.isVisible) continue;

      const d = dist(node.position, position);
      if (d < SETTLEMENT_TUNING.resourceExclusion) return 0;
      if (d > SETTLEMENT_TUNING.resourceRange) continue;

      best = Math.max(best, 1 - d / SETTLEMENT_TUNING.resourceRange);
    }

    return best;
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
