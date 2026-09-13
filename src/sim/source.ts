import type { Vec2 } from './geometry';
import type { RiverNetwork } from './river';
import type { TerrainSample, TerrainType } from './terrain';
import { ResourceType, SiteType } from './types';

/**
 * Where a world comes from.
 *
 * Everything in `sim/` used to talk to `TerrainField` and `WorldGenerator`
 * directly — two concrete classes, both of them pure functions of a seed.
 * That was fine while procedural generation was the only way a world could
 * exist, and it stops being fine the moment we want to run the same
 * simulation over a *real* place: a heightfield imported from survey data, a
 * road network traced from a historical map, resource sites placed where
 * someone actually dug.
 *
 * So the two questions generation answers are split out here as interfaces,
 * and nothing downstream is allowed to care which implementation answers
 * them:
 *
 * - `TerrainSource` — "what is the ground like at this point?" Asked
 *   constantly, by pathfinding, rendering, settlement siting and expansion
 *   pricing.
 * - `NodeSource` — "what is worth digging up around here, and where could
 *   people live?" Asked rarely, and only by `World`.
 *
 * This is deliberately *not* a plugin system. There are two implementations
 * in mind and no more: the procedural one (`worldgen.ts`, still the default
 * and still what the tuning harness in `tools/` runs against) and a
 * dataset-backed one loaded from an authored map pack. The interfaces exist
 * to keep those two honest about sharing the same rules, not to invite a
 * third.
 */

/**
 * A resource node the way a world source produces it — everything
 * `ResourceNode` needs to be constructed, plus nothing else. `World` is what
 * turns these into real `ResourceNode` instances and decides when they
 * become visible; a source only ever decides *where* and *what*.
 */
export interface GeneratedNode {
  id: number;
  name: string;
  type: SiteType;
  resource: ResourceType;
  x: number;
  y: number;
  productionInterval: number;
  capacity: number;
}

/** The shape `ensureStartingResources` needs to know about sites that already exist. */
export interface NodeSummary {
  resource: ResourceType;
  x: number;
  y: number;
}

/**
 * The ground, queried point by point.
 *
 * Note what is *not* here: any notion of the world being generated, sized or
 * finite. Procedural terrain answers any coordinate from -infinity out;
 * imported terrain answers within its own bounds and falls back to
 * impassable ground past them. Both satisfy this, and callers never have to
 * ask which they're talking to.
 *
 * `ensureGenerated` is the one concession to implementation: a procedural
 * source uses it to materialise chunks ahead of a render pass, an imported
 * one can ignore it entirely. It is a *hint*, never a precondition — every
 * other method on this interface has to answer correctly whether or not it
 * was ever called.
 */
export interface TerrainSource {
  /** World units per terrain cell. The grid everything else quantises to. */
  readonly cellSize: number;

  /** Hint that this world-space rectangle is about to be queried in bulk. */
  ensureGenerated(x0: number, y0: number, x1: number, y1: number): void;

  colAt(x: number): number;
  rowAt(y: number): number;
  cellCentre(col: number, row: number): Vec2;

  sampleAtCell(col: number, row: number): TerrainSample;
  sampleAt(point: Vec2): TerrainSample;
  typeAtCell(col: number, row: number): TerrainType;
  typeAt(point: Vec2): TerrainType;

  /** What it costs to cover this ground, relative to open plains. `Infinity` if nothing can occupy it. */
  costAt(point: Vec2): number;
  /** Whether something could stand, live or work here. Water is always no. */
  isPassable(point: Vec2): boolean;
  /** What this ground costs a *road*, which may bridge what it cannot occupy — see `BRIDGE_COST`. */
  roadCostAt(point: Vec2): number;
  /** How hard a finished road is to walk, averaged over its length. */
  averageCost(points: Vec2[]): number;
  /** The longest unbroken stretch of water this line crosses, in world units. */
  longestWaterSpan(points: Vec2[]): number;
  /** Whether a road could be laid along this line, bridges included. */
  canCarryRoad(points: Vec2[]): boolean;
}

/**
 * Where places and deposits come from.
 *
 * Only `World` talks to this, and only three times' worth: once at founding
 * to site the village and guarantee it a viable start, and then repeatedly
 * as the realm's reach grows. The contract that matters is idempotence —
 * `ensureNodesGenerated` must return each node exactly once across every
 * call it ever gets, because `World` pushes the results straight into
 * `this.nodes` and has no way to notice a duplicate.
 */
export interface NodeSource {
  /** The ground these nodes sit on. One source owns both halves, so they can never disagree. */
  readonly terrain: TerrainSource;

  /**
   * The watercourses crossing it — see `RiverNetwork` for why these are lines
   * and not cells.
   *
   * Optional because a procedural world has none: noise produces lakes,
   * because a lake is just ground below the waterline, and it produces no
   * rivers at all, because a river is a thing water *does* and nothing in
   * this generator models water moving. A source that has no answer omits
   * this and `World` uses `NO_RIVERS`.
   */
  readonly rivers?: RiverNetwork;

  /**
   * Decide every not-yet-decided node overlapping this world-space
   * rectangle, returning only the ones decided by *this* call. Overlapping
   * calls are expected and must be cheap no-ops for ground already settled.
   */
  ensureNodesGenerated(x0: number, y0: number, x1: number, y1: number): GeneratedNode[];

  /**
   * Where a village asked to stand at `requested` can actually stand: dry,
   * walkable ground with enough connected land around it to hold an economy.
   * A source that has an authored answer should just return it.
   */
  habitableSite(requested: Vec2, reach: number): Vec2;

  /**
   * The one sanctioned exception to "the world is what it is": whatever has
   * to be forced into place so a freshly founded village isn't dead on
   * arrival. A source whose sites were placed by hand can reasonably decide
   * its author already answered this and return nothing.
   */
  ensureStartingResources(centre: Vec2, existing: readonly NodeSummary[], reach: number): GeneratedNode[];
}

// ------------------------------------------------------------ raw resources

/** The only resources a raw site can actually produce — processed goods come from industries, never from the ground. */
export type RawResource = ResourceType.Wood | ResourceType.Stone | ResourceType.Iron | ResourceType.Food;

export const RAW_RESOURCES: readonly RawResource[] = [
  ResourceType.Wood,
  ResourceType.Stone,
  ResourceType.Iron,
  ResourceType.Food,
];

export function isRawResource(value: string): value is RawResource {
  return (RAW_RESOURCES as readonly string[]).includes(value);
}

export const SITE_TYPE_FOR: Record<RawResource, SiteType> = {
  [ResourceType.Wood]: SiteType.Forest,
  [ResourceType.Stone]: SiteType.Quarry,
  [ResourceType.Iron]: SiteType.Mine,
  [ResourceType.Food]: SiteType.Farm,
};

/** Seconds one worker needs for a single unit, before richness or node level have any say. */
export const BASE_PRODUCTION_INTERVAL: Record<RawResource, number> = {
  [ResourceType.Wood]: 6,
  [ResourceType.Stone]: 8,
  [ResourceType.Iron]: 10,
  [ResourceType.Food]: 6,
};

export const BASE_CAPACITY = 8;

/**
 * What a site of a given trade and richness is worth, in the only two numbers
 * `ResourceNode` cares about at level one.
 *
 * Shared rather than duplicated per source for the same reason
 * `classifyTerrain` is: a quarry imported from a map pack and a quarry rolled
 * from noise have to be the same quarry, or every production figure the
 * balance harness has ever measured stops meaning anything the moment a real
 * map is loaded. `richness` is the only dial either source gets, and it means
 * the same thing in both — roughly 0.7 (poor) to 1.7 (exceptional), 1.0 being
 * ordinary ground.
 */
export function makeGeneratedNode(
  id: number,
  name: string,
  resource: RawResource,
  x: number,
  y: number,
  richness: number,
): GeneratedNode {
  return {
    id,
    name,
    type: SITE_TYPE_FOR[resource],
    resource,
    x,
    y,
    productionInterval: BASE_PRODUCTION_INTERVAL[resource] / richness,
    capacity: Math.round(BASE_CAPACITY * (0.8 + richness * 0.3)),
  };
}

/**
 * Two sites never sit closer together than this, whoever placed them.
 *
 * A spacing rule rather than a generation detail: it is what stops a place
 * reading as one smeared blob of production instead of somewhere with
 * distinct works in it, and it is exactly as true of an imported map as a
 * rolled one. OpenStreetMap in particular splits a single forest into a
 * dozen adjoining polygons, so an importer that ignored this would put a
 * dozen woodlots inside one wood.
 */
export const MIN_NODE_DISTANCE = 165;
