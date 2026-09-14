import { cumulativeLengths, type Vec2 } from './geometry';
import { ResourceType } from './types';

/**
 * What the ground remembers.
 *
 * This was the wear field, and it still does that job: every delivery packs
 * down each patch it crosses, roads read their width back out of it, and
 * unwalked ground recovers. It now also remembers *what* went past, which is
 * what lets a place develop a character — a patch that has seen nothing but
 * timber for days is a different proposition from a busy crossroads.
 *
 * Keeping both in one grid matters: settlements emerge at places, not at road
 * objects, and a place needs its traffic, its goods and its road quality
 * together. Storage stays bounded by the size of the map rather than by how
 * much road exists, and only patches somebody has actually used are tracked.
 */
export const PATCH_SIZE = 48;

/** Packed into each patch by one person carrying one full load on their back. */
export const WEAR_PER_TRIP = 0.35;
/**
 * How hard a delivery packs the ground down, for the weight it was carrying.
 *
 * The ground remembers *weight*, not footfalls, and that one word is what
 * makes a staple haulage route look like one. A trip used to pack a fixed
 * amount whatever it carried, which had an unpleasant consequence hiding in
 * it the moment loads stopped being uniform: a road good enough for carts
 * moves the same goods in a third of the trips, so counting trips would have
 * had a road *decay* the moment it got good enough to be useful — improve,
 * lose its traffic, fall back to a track, and start again. A textbook
 * oscillation, built in at the foundation.
 *
 * Weighed instead, moving a hundred units of grain packs the same ground down
 * by roughly the same amount however it is split up, and the slight
 * superlinearity on top says the true thing: a loaded waggon cuts ruts a file
 * of porters carrying the same tonnage never would. So the loop runs the
 * right way — a road that earns carts gets packed harder than it was as a
 * footpath, not softer — and it still cannot run away, because everything
 * that reads wear clamps at `WEAR_FULL` and there is only ever as much to
 * carry as the country grows.
 *
 * The floor matters too: a near-empty trip still has feet on it.
 */
export function wearOfLoad(amount: number): number {
  const loads = Math.max(0.35, amount / 3);
  return WEAR_PER_TRIP * Math.pow(loads, 1.15);
}
/** A freshly cleared road starts faintly worn, then has to earn its keep. */
export const WEAR_ON_BUILD = 0.8;
/** Fraction of wear lost per second; roughly a 35 second half-life. */
export const WEAR_DECAY = 0.02;
/** Below this a patch is treated as untouched ground again. */
export const WEAR_EPSILON = 0.02;
/**
 * Wear at which the *ground* is as packed down as it gets.
 *
 * A statement about soil, and the ceiling on what packing the ground can do
 * for the people crossing it: past here a road is as easy to walk, as good to
 * route over, and as attractive to settle beside as any road ever gets.
 */
export const WEAR_FULL = 4.5;

/**
 * Wear at which a road is a fully made trunk road — the scale a road's
 * *appearance*, and what can travel it, are measured against.
 *
 * This used to be `WEAR_FULL` as well, and the two had quietly come to mean
 * different things. Ground stops improving underfoot early: a track that has
 * seen a few hundred crossings is about as firm as a track ever gets, and
 * `WEAR_FULL` is honest about that. But a road's standing in the *network* is
 * a question about traffic, and traffic in a mature realm runs an order of
 * magnitude past the point where soil stops caring.
 *
 * Measured rather than guessed, on seed 1234 at day 120: median wear across
 * live roads 5.7, busiest stretch 19.2. Against a scale topping out at 4.5,
 * every road in the realm was clamped at maximum from the first week — which
 * is the real reason they all looked alike, why nothing ever read as "a path
 * that grew", and why no amount of work on the *drawing* of roads was ever
 * going to fix it. The widths and colours had a two-decade dynamic range to
 * work with and were being handed a saturated one.
 *
 * Set just above that measured maximum, so the busiest road in a developed
 * realm is a full highway and the median one is a third of the way there.
 * Kept apart from `WEAR_FULL` deliberately: `wearEffort`, `routeScore` and
 * settlement emergence are all tuned against the physical figure and *should*
 * clamp early — a well-used lane is as easy to walk as a highway, and ought to
 * be as good a place to settle. It is only how a road looks, and what it can
 * carry, that should keep answering long after the mud has stopped changing.
 */
export const ROAD_DEVELOPED = 18;

/** Floor on how much a fully-packed road eases travel, relative to fresh ground. */
const MIN_EFFORT = 0.6;

/**
 * How much less effort a stretch of ground takes to cross as it wears in:
 * 1 on untouched ground, easing down to `MIN_EFFORT` once it's packed down
 * as solid as it gets. This is what gives a highway an actual reason to
 * exist beyond looking wider — the same road gets faster to walk the more
 * it's used, and the pathfinder feels that too.
 */
export function wearEffort(wear: number): number {
  const t = Math.max(0, Math.min(1, wear / WEAR_FULL));
  return 1 - (1 - MIN_EFFORT) * t;
}

/**
 * Goods fade slower than ruts do. A route's economic character should outlive
 * a quiet afternoon, or nowhere would ever settle.
 */
export const GOODS_DECAY = 0.008;
export const GOODS_EPSILON = 0.05;

export const TRACKED_GOODS: readonly ResourceType[] = [
  ResourceType.Wood,
  ResourceType.Iron,
  ResourceType.Stone,
  ResourceType.Food,
  ResourceType.Planks,
  ResourceType.StoneBlocks,
  ResourceType.Tools,
  ResourceType.Fittings,
  ResourceType.Bread,
];

export type GoodsTally = Record<ResourceType, number>;

function emptyTally(): GoodsTally {
  return {
    [ResourceType.Wood]: 0,
    [ResourceType.Iron]: 0,
    [ResourceType.Stone]: 0,
    [ResourceType.Food]: 0,
    [ResourceType.Planks]: 0,
    [ResourceType.StoneBlocks]: 0,
    [ResourceType.Tools]: 0,
    [ResourceType.Fittings]: 0,
    [ResourceType.Bread]: 0,
  };
}

export class TrafficField {
  readonly cols: number;
  readonly rows: number;
  readonly patchSize = PATCH_SIZE;

  private readonly wear: Float32Array;
  private readonly goods: Record<ResourceType, Float32Array>;
  /**
   * The same seven arrays as `goods`, in `TRACKED_GOODS` order.
   *
   * `decay` touches every one of them for every patch the realm has ever
   * used, every tick; going through the record there means re-resolving seven
   * properties per patch to reach arrays that never change. Held once, in the
   * order the loop wants them.
   */
  private readonly goodsByIndex: Float32Array[];
  /** Patches holding anything at all, so decay never sweeps the whole map. */
  private readonly touched = new Set<number>();
  /**
   * Bumped whenever any patch changes.
   *
   * Anything that reads a *summary* of the field rather than a single patch —
   * above all the mean wear along a road, which the pathfinder wants for every
   * edge it relaxes — can cache that summary against this and know exactly
   * when it has gone stale. Walking a road's whole polyline is cheap once per
   * road and ruinous a hundred thousand times a tick; see `RoadEdge.wear`.
   */
  revision = 0;

  constructor(width: number, height: number) {
    this.cols = Math.ceil(width / PATCH_SIZE);
    this.rows = Math.ceil(height / PATCH_SIZE);

    const size = this.cols * this.rows;
    this.wear = new Float32Array(size);
    this.goods = {
      [ResourceType.Wood]: new Float32Array(size),
      [ResourceType.Iron]: new Float32Array(size),
      [ResourceType.Stone]: new Float32Array(size),
      [ResourceType.Food]: new Float32Array(size),
      [ResourceType.Planks]: new Float32Array(size),
      [ResourceType.StoneBlocks]: new Float32Array(size),
      [ResourceType.Tools]: new Float32Array(size),
      [ResourceType.Fittings]: new Float32Array(size),
      [ResourceType.Bread]: new Float32Array(size),
    };
    this.goodsByIndex = TRACKED_GOODS.map((resource) => this.goods[resource]);
  }

  get touchedPatches(): number {
    return this.touched.size;
  }

  /** Every patch that has seen traffic, for the systems that scan for sites. */
  get activePatches(): Iterable<number> {
    return this.touched;
  }

  patchCentre(index: number): Vec2 {
    const col = index % this.cols;
    const row = Math.floor(index / this.cols);
    return { x: (col + 0.5) * PATCH_SIZE, y: (row + 0.5) * PATCH_SIZE };
  }

  indexAt(point: Vec2): number {
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor(point.x / PATCH_SIZE)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor(point.y / PATCH_SIZE)));
    return row * this.cols + col;
  }

  // ------------------------------------------------------------------ writing

  /**
   * Record a journey. `wear` packs the ground down; `resource`/`amount` note
   * what was carried, when anything was.
   */
  deposit(points: Vec2[], wear: number, resource: ResourceType | null = null, amount = 0): void {
    const visited = new Set<number>();

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (PATCH_SIZE / 2)));

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        visited.add(this.indexAt({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
      }
    }

    for (const index of visited) {
      this.wear[index] += wear;
      if (resource && amount > 0) this.goods[resource][index] += amount;
      this.touched.add(index);
    }
    this.revision++;
  }

  /**
   * Ground recovers, and what was carried over it fades.
   *
   * Runs every tick, and has to. Both curves are exponentials, and
   * `exp(-k*a) * exp(-k*b) === exp(-k*(a+b))` — so integrating one in coarser
   * steps is not an approximation, it is the same answer, and batching this
   * onto a half-second timer looked like free speed for that reason. It is
   * not free, because decay is not the only thing happening to a patch:
   * deliveries keep packing wear *in* between sweeps, so a longer gap lets a
   * little more of it stand before anything takes it away.
   *
   * That bias is well under a percent, and it still moved the game. Measured
   * across six seeds at day 60, a half-second sweep left mean settlements at
   * 5.3 against 4.2, on the same populations — places emerge on a *threshold*
   * of how busy a patch reads, so a permanent thumb on the scale does not
   * blur the outcome, it tips whichever junctions were sitting near the line.
   * The realm came out the same size spread across more, smaller places, and
   * one of the six grew a ghost town, which the baseline never did.
   *
   * A tick is not too often to integrate this. Sweeping every touched patch
   * is a few percent of the tick, and the caches that actually mattered
   * (`RoadEdge.wear`) are keyed on `revision`, so they still collapse
   * thousands of reads per tick into one per road — which was the whole point
   * and never depended on this.
   */
  decay(dt: number): void {
    this.revision++;

    const wearFactor = Math.exp(-WEAR_DECAY * dt);
    const goodsFactor = Math.exp(-GOODS_DECAY * dt);
    const wear = this.wear;
    const goods = this.goodsByIndex;

    for (const index of this.touched) {
      // Stored before it is compared, so the test sees the same single-
      // precision value the field will actually hold — not the wider one the
      // multiply produced.
      wear[index] *= wearFactor;
      if (wear[index] < WEAR_EPSILON) wear[index] = 0;

      let anyGoods = false;
      for (let g = 0; g < goods.length; g++) {
        const carried = goods[g];
        const next = carried[index] * goodsFactor;
        carried[index] = next < GOODS_EPSILON ? 0 : next;
        if (carried[index] > 0) anyGoods = true;
      }

      if (wear[index] === 0 && !anyGoods) this.touched.delete(index);
    }
  }

  // ------------------------------------------------------------------ reading

  /** Bilinear sample, so a road's width changes smoothly rather than in steps. */
  wearAt(point: Vec2): number {
    const gx = point.x / PATCH_SIZE - 0.5;
    const gy = point.y / PATCH_SIZE - 0.5;
    const col = Math.floor(gx);
    const row = Math.floor(gy);
    const fx = gx - col;
    const fy = gy - row;

    return (
      this.wearCell(col, row) * (1 - fx) * (1 - fy) +
      this.wearCell(col + 1, row) * fx * (1 - fy) +
      this.wearCell(col, row + 1) * (1 - fx) * fy +
      this.wearCell(col + 1, row + 1) * fx * fy
    );
  }

  /** Mean wear along a path, which is how worn a whole road reads. */
  wearAlong(points: Vec2[]): number {
    if (points.length === 0) return 0;
    let total = 0;
    for (const p of points) total += this.wearAt(p);
    return total / points.length;
  }

  /**
   * The most faded stretch of a path, ignoring the ends.
   *
   * Averages are no use for deciding a road is abandoned: wherever it meets
   * another road it shares that patch of ground, so its ends stay worn however
   * dead the middle is. A road is gone when any part of it has gone.
   */
  weakestAlong(points: Vec2[]): number {
    if (points.length === 0) return 0;

    const cum = cumulativeLengths(points);
    const total = cum[cum.length - 1];
    const margin = Math.min(PATCH_SIZE, total / 3);

    let weakest = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (cum[i] < margin || cum[i] > total - margin) continue;
      weakest = Math.min(weakest, this.wearAt(points[i]));
    }

    return Number.isFinite(weakest) ? weakest : this.wearAlong(points);
  }

  /** What has been carried through a patch, by kind. */
  goodsAt(point: Vec2): GoodsTally {
    return this.goodsAtIndex(this.indexAt(point));
  }

  goodsAtIndex(index: number): GoodsTally {
    const tally = emptyTally();
    for (const resource of TRACKED_GOODS) tally[resource] = this.goods[resource][index];
    return tally;
  }

  /** Everything carried through a patch, regardless of kind. */
  totalGoodsAtIndex(index: number): number {
    let total = 0;
    for (const resource of TRACKED_GOODS) total += this.goods[resource][index];
    return total;
  }

  wearAtIndex(index: number): number {
    return this.wear[index];
  }

  private wearCell(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return 0;
    return this.wear[row * this.cols + col];
  }
}

/** The good that dominates a tally, and how strongly, from 0 to 1. */
export function dominantGood(tally: GoodsTally): {
  resource: ResourceType | null;
  share: number;
  total: number;
} {
  let total = 0;
  let best: ResourceType | null = null;
  let bestAmount = 0;

  for (const resource of TRACKED_GOODS) {
    const amount = tally[resource];
    total += amount;
    if (amount > bestAmount) {
      bestAmount = amount;
      best = resource;
    }
  }

  return { resource: total > 0 ? best : null, share: total > 0 ? bestAmount / total : 0, total };
}

/**
 * The goods that come out of the ground, as opposed to out of an industry.
 * The distinction matters wherever a reading has to be reachable early: a
 * processed good sits at full shortage everywhere until somebody's industry
 * actually runs, so a score that averages it in is a score that reads the
 * same (bad) everywhere for the entire opening of the game.
 */
export const RAW_GOODS: readonly ResourceType[] = [
  ResourceType.Food,
  ResourceType.Wood,
  ResourceType.Stone,
  ResourceType.Iron,
];
