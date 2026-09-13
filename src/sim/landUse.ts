import { dist, type Vec2 } from './geometry';
import type { TerrainSource } from './source';
import { TerrainType, type TerrainSample } from './terrain';
import { ResourceType } from './types';

/**
 * Ground as a finite thing places have to compete for.
 *
 * Until now every place on the map was a point with a radius attached to it,
 * and the radius was only ever a *drawing* instruction or a distance test.
 * Nothing on this map occupied anything. A village of sixty and a hamlet of
 * three took up exactly as much of the world as each other — none — so a
 * village could grow forever without the country around it ever having an
 * opinion, and a forest was a pin rather than a wood.
 *
 * That is the missing constraint behind a whole class of behaviour this game
 * wants and could not produce. A town has to *sprawl*, and sprawling has to
 * cost something, or there is no reason a place near open plain should turn
 * out differently from a place wedged between four mines. A wood has to be
 * cut and replanted over an actual area, or "the village expanded into the
 * forest" is not a thing that can happen, let alone a thing with a
 * consequence.
 *
 * So ground is now held, cell by cell, and only ever by one claimant:
 *
 * - **Settled ground** is a place's built-up area plus the closes and
 *   in-fields around it. It grows with population.
 * - **Worked ground** is a resource site's area of operation — the stretch
 *   of wood actually being felled and replanted, the fields actually being
 *   ploughed. It grows with the node's level.
 *
 * The arbitration between them is the whole point, and it is deliberately
 * asymmetric: a town may build over a wood (and the wood is worth less for
 * it), a wood may never grow back over a town. That single rule is what makes
 * "a village ringed by resource works cannot become a city without ruining
 * the works it lives on" fall out of the simulation rather than being a
 * penalty someone wrote down.
 *
 * Shapes are not circles and are not meant to be. A parcel grows one cell at
 * a time, always taking the best ground it can reach, so it runs up a fertile
 * valley and stops at the water, the crag and the neighbour's fence. The
 * distance term only decides roughly how far is reasonable; the ground
 * decides which way.
 */

// ------------------------------------------------------------------- cells

/**
 * Cells are addressed by the terrain's own grid, packed into one number so a
 * Map/Set can key on them without allocating strings sixty times a second.
 * Columns and rows are signed — a procedural world has no origin corner — so
 * both are biased before packing.
 */
const KEY_OFFSET = 1 << 20;
const KEY_STRIDE = 1 << 21;

export function cellKey(col: number, row: number): number {
  return (col + KEY_OFFSET) * KEY_STRIDE + (row + KEY_OFFSET);
}

export function keyCol(key: number): number {
  return Math.floor(key / KEY_STRIDE) - KEY_OFFSET;
}

export function keyRow(key: number): number {
  return (key % KEY_STRIDE) - KEY_OFFSET;
}

// ------------------------------------------------------------ suitability

/**
 * How willingly each kind of ground is built on. Lived in
 * `settlementSystem.ts` before there was anywhere better; it belongs here now
 * that the same judgement decides both where a settlement is worth founding
 * and which cells its sprawl actually takes, and the two must not be allowed
 * to drift apart.
 */
export const TERRAIN_SUITABILITY: Record<TerrainType, number> = {
  [TerrainType.Plains]: 1,
  [TerrainType.Forest]: 0.62,
  [TerrainType.Hills]: 0.34,
  [TerrainType.Mountains]: 0,
  [TerrainType.Water]: 0,
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * How good this ground is to live on and farm from. Open, dry, fertile and
 * not stony — which is to say the same ground a medieval village actually
 * chose, for the same reasons.
 */
export function settledSuitability(sample: TerrainSample): number {
  const base = TERRAIN_SUITABILITY[sample.type] ?? 0;
  if (base <= 0) return 0;
  // Nobody lays out a toft in a marsh, and the in-fields want soil.
  const dry = 1 - 0.5 * sample.wetness;
  const soil = 0.7 + 0.3 * sample.fertility;
  const clear = 1 - 0.35 * sample.rockiness;
  return clamp01(base * dry * soil * clear);
}

/**
 * How good this ground is for a given trade's *area of operation* — not
 * "is there a deposit here", which generation already decided, but "is this
 * cell worth including in the working area of the deposit next door".
 *
 * This is what makes a working area follow the country. A wood's cutting
 * ground runs along the timber and stops at the meadow; a farm's fields run
 * across the loam and stop at the scree; a quarry's workings climb the stony
 * ground it was opened into.
 */
export function workedSuitability(sample: TerrainSample, resource: ResourceType): number {
  if (sample.type === TerrainType.Water) return 0;

  switch (resource) {
    case ResourceType.Wood: {
      // Standing timber, and somewhere replanting would actually take.
      const slope = sample.type === TerrainType.Mountains ? 0.25 : 1;
      return clamp01(sample.forestDensity ** 0.8 * slope);
    }
    case ResourceType.Food: {
      const ground =
        sample.type === TerrainType.Plains ? 1 : sample.type === TerrainType.Forest ? 0.7 : sample.type === TerrainType.Hills ? 0.45 : 0;
      return clamp01(sample.fertility * ground * (1 - 0.6 * sample.rockiness));
    }
    case ResourceType.Stone: {
      const ground = sample.type === TerrainType.Mountains ? 1 : sample.type === TerrainType.Hills ? 0.9 : 0.5;
      return clamp01((0.2 + 0.8 * sample.rockiness) * ground);
    }
    case ResourceType.Iron: {
      // Ore follows the same stony, raised country stone does, but a seam is
      // narrower than a quarry face — the elevation term makes a mine's
      // workings reach uphill rather than spreading over the valley floor.
      const raised = clamp01(0.35 + sample.elevation);
      return clamp01(sample.rockiness * raised);
    }
    default:
      return 0;
  }
}

// --------------------------------------------------------------- registry

export interface LandContext {
  terrain: TerrainSource;
  registry: LandRegistry;
}

/**
 * Who holds which cell. One owner per cell, always — that is the entire
 * reason this exists, and every interesting consequence in this file comes
 * from it being true.
 */
export class LandRegistry {
  private readonly owners = new Map<number, LandParcel>();

  ownerOf(key: number): LandParcel | undefined {
    return this.owners.get(key);
  }

  /**
   * Whether `claimant` is allowed to take a cell, and from whom.
   *
   * The asymmetry is the rule the whole system turns on. A town may build
   * over a working — that is what sprawl *is*, and the working is worth less
   * afterwards, which is the cost. Nothing may take ground off a town, and no
   * working may take ground off another: two woods on the same ridge simply
   * share the ridge, each the poorer for it.
   */
  canClaim(key: number, claimant: LandParcel): boolean {
    const held = this.owners.get(key);
    if (!held || held === claimant) return true;
    return claimant.kind === 'settled' && held.kind === 'worked';
  }

  /** True if the cell was actually taken, evicting whoever held it. */
  claim(key: number, claimant: LandParcel): boolean {
    if (!this.canClaim(key, claimant)) return false;
    const held = this.owners.get(key);
    if (held === claimant) return true;
    if (held) held.dropCell(key);
    this.owners.set(key, claimant);
    return true;
  }

  release(key: number, claimant: LandParcel): void {
    if (this.owners.get(key) === claimant) this.owners.delete(key);
  }
}

// ----------------------------------------------------------------- parcel

/** How much a claimant will put up with to build over somebody's workings. */
const CONTESTED_PENALTY = 0.25;
/** Ground scoring below this is not worth taking, however much is wanted. */
const MIN_CELL_SCORE = 0.05;
/** Held ground is only given back once it is this far past what is wanted. */
const SHRINK_HYSTERESIS = 1.35;

export interface LandParcelConfig {
  key: string;
  kind: 'settled' | 'worked';
  origin: Vec2;
  suitabilityOf: (sample: TerrainSample) => number;
}

/**
 * One claimant's ground: which cells it holds, and how it goes about taking
 * more.
 *
 * Growth is incremental and one cell at a time on purpose. A parcel is a
 * thing that is *laid out* over days, not a shape recomputed from a radius
 * every tick — which means the map shows a town visibly creeping up its
 * valley, and means the order things were claimed in genuinely matters, the
 * way it does on real ground.
 */
export class LandParcel {
  readonly key: string;
  readonly kind: 'settled' | 'worked';
  readonly origin: Vec2;

  /** Cells held, mapped to the suitability they were valued at when taken. */
  private readonly held = new Map<number, number>();
  /** Cells adjacent to what is held and worth reconsidering next growth pass. */
  private readonly frontier = new Set<number>();
  private readonly suitabilityOf: (sample: TerrainSample) => number;

  /** How much ground this claimant currently wants, in world units². */
  targetArea = 0;
  /**
   * Set when a growth pass wanted more ground and could find none worth
   * taking. This is the honest "boxed in" signal — not "is it smaller than it
   * wants" (everything growing is), but "it tried and the country said no".
   */
  starved = false;

  private suitabilitySum = 0;
  /**
   * What the ground under this claimant's own centre is worth, as the
   * yardstick its held ground is measured against. A quarry opened in poor
   * stone should not read as a ruined quarry merely for being in the country
   * it was always in; what matters is whether it holds as much of the ground
   * it was promised as it should.
   */
  private reference = 0;
  private seeded = false;

  private minCol = 0;
  private maxCol = 0;
  private minRow = 0;
  private maxRow = 0;

  constructor(config: LandParcelConfig) {
    this.key = config.key;
    this.kind = config.kind;
    // Held by reference, not copied: a parcel's centre *is* its claimant's
    // position, and a settlement's position is snapped onto the road that
    // made it after it is constructed (see `World.foundSettlement`). A copy
    // taken here would quietly be the pre-snap point.
    this.origin = config.origin;
    this.suitabilityOf = config.suitabilityOf;
  }

  get cells(): ReadonlyMap<number, number> {
    return this.held;
  }

  get isEmpty(): boolean {
    return this.held.size === 0;
  }

  /** Ground actually held, in world units². */
  area(cellSize: number): number {
    return this.held.size * cellSize * cellSize;
  }

  /** The radius a circle of `targetArea` would have — what "roughly this far" means here. */
  get wantedRadius(): number {
    return Math.sqrt(Math.max(1, this.targetArea) / Math.PI);
  }

  targetCells(cellSize: number): number {
    return Math.max(1, Math.round(this.targetArea / (cellSize * cellSize)));
  }

  /** 0 to 1: how much of the ground it wants this claimant has actually got. */
  satisfaction(cellSize: number): number {
    return clamp01(this.held.size / this.targetCells(cellSize));
  }

  /**
   * 0 to 1: how much good ground this claimant holds against how much it
   * should. Below 1 either because it could not get the acreage or because
   * what it got is poor — and, crucially, because somebody built over the
   * good part of it.
   */
  quality(cellSize: number): number {
    if (this.reference <= 0) return 1;
    const want = this.targetCells(cellSize) * this.reference;
    return clamp01(this.suitabilitySum / want);
  }

  /** Whether a point falls on ground this claimant holds — the real click target. */
  contains(point: Vec2, terrain: TerrainSource): boolean {
    if (this.held.size === 0) return false;
    return this.held.has(cellKey(terrain.colAt(point.x), terrain.rowAt(point.y)));
  }

  /** Cell-grid extent, for a renderer that needs somewhere to start looking. */
  bounds(terrain: TerrainSource): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.held.size === 0) return null;
    const half = terrain.cellSize / 2;
    const a = terrain.cellCentre(this.minCol, this.minRow);
    const b = terrain.cellCentre(this.maxCol, this.maxRow);
    return { x0: a.x - half, y0: a.y - half, x1: b.x + half, y1: b.y + half };
  }

  has(key: number): boolean {
    return this.held.has(key);
  }

  /**
   * Take up to `maxCells` more cells, or give back ground that is no longer
   * wanted. Called on a timer rather than every tick — laying out ground is
   * slow work and should look like it.
   */
  grow(ctx: LandContext, maxCells: number): void {
    this.starved = false;
    if (this.targetArea <= 0) return;

    const { cellSize } = ctx.terrain;
    if (!this.seeded) this.seed(ctx);

    const want = this.targetCells(cellSize);

    if (this.held.size > want * SHRINK_HYSTERESIS) {
      this.shrink(ctx, want);
      return;
    }

    let taken = 0;
    while (this.held.size < want && taken < maxCells) {
      const best = this.bestCandidate(ctx);
      if (best === null) {
        this.starved = true;
        return;
      }
      this.annex(best.key, best.suitability, ctx);
      taken++;
    }
  }

  /** Give up every cell — a place that no longer exists holds no ground. */
  abandon(ctx: LandContext): void {
    for (const key of this.held.keys()) ctx.registry.release(key, this);
    this.held.clear();
    this.frontier.clear();
    this.suitabilitySum = 0;
    this.seeded = false;
  }

  /**
   * Called by the registry when somebody else takes a cell off this parcel.
   * The suitability goes with it, which is exactly how a town building over
   * the best of a wood shows up as that wood being worth less.
   */
  dropCell(key: number): void {
    const suitability = this.held.get(key);
    if (suitability === undefined) return;
    this.held.delete(key);
    this.suitabilitySum -= suitability;
    // Keep it on the frontier: if the neighbour ever gives it up, this
    // claimant is the obvious one to take it back.
    this.frontier.add(key);
  }

  // ------------------------------------------------------------- internals

  private seed(ctx: LandContext): void {
    const col = ctx.terrain.colAt(this.origin.x);
    const row = ctx.terrain.rowAt(this.origin.y);
    this.reference = Math.max(0.25, this.suitabilityOf(ctx.terrain.sampleAtCell(col, row)));
    this.seeded = true;
    this.minCol = this.maxCol = col;
    this.minRow = this.maxRow = row;

    const key = cellKey(col, row);
    // The claimant's own centre. A settlement takes it whatever is there —
    // it is already standing on it — and a node likewise: the pithead is the
    // pithead whether or not the cell around it is prime ground.
    if (ctx.registry.claim(key, this)) {
      this.record(key, Math.max(0, this.suitabilityOf(ctx.terrain.sampleAtCell(col, row))), col, row);
      this.pushNeighbours(col, row);
    } else {
      // Somebody else's town is standing on this exact cell. Start from the
      // ring around it instead; the parcel still grows, just not from under
      // their feet.
      this.pushNeighbours(col, row);
    }
  }

  /**
   * What a candidate cell is worth to this claimant: the ground itself,
   * discounted for being further out than the claimant has any business
   * reaching, and discounted hard again if somebody is already working it.
   *
   * The distance term is cubic, so it is nearly flat well inside the wanted
   * radius and falls off a cliff outside it. That is what keeps a parcel
   * compact without making it a circle: inside the radius the ground decides
   * everything, and past it only genuinely excellent country is worth the
   * walk.
   */
  private scoreCell(key: number, ctx: LandContext): { suitability: number; score: number } | null {
    if (!ctx.registry.canClaim(key, this)) return null;

    const col = keyCol(key);
    const row = keyRow(key);
    const suitability = this.suitabilityOf(ctx.terrain.sampleAtCell(col, row));
    if (suitability <= 0) return null;

    const centre = ctx.terrain.cellCentre(col, row);
    const reach = Math.max(ctx.terrain.cellSize, this.wantedRadius) * 1.15;
    const pull = 1 / (1 + (dist(centre, this.origin) / reach) ** 3);

    const contested = ctx.registry.ownerOf(key) !== undefined ? CONTESTED_PENALTY : 1;
    return { suitability, score: suitability * pull * contested };
  }

  private bestCandidate(ctx: LandContext): { key: number; suitability: number } | null {
    let best: { key: number; suitability: number } | null = null;
    let bestScore = MIN_CELL_SCORE;
    const dead: number[] = [];

    for (const key of this.frontier) {
      const scored = this.scoreCell(key, ctx);
      if (!scored) {
        // Impassable or somebody's town: it will never become available, so
        // stop paying to rescore it every pass.
        if (!ctx.registry.canClaim(key, this) || this.suitabilityOf(ctx.terrain.sampleAtCell(keyCol(key), keyRow(key))) <= 0) {
          dead.push(key);
        }
        continue;
      }
      if (scored.score > bestScore) {
        bestScore = scored.score;
        best = { key, suitability: scored.suitability };
      }
    }

    for (const key of dead) this.frontier.delete(key);
    return best;
  }

  private annex(key: number, suitability: number, ctx: LandContext): void {
    if (!ctx.registry.claim(key, this)) {
      this.frontier.delete(key);
      return;
    }
    const col = keyCol(key);
    const row = keyRow(key);
    this.record(key, suitability, col, row);
    this.pushNeighbours(col, row);
  }

  private record(key: number, suitability: number, col: number, row: number): void {
    this.held.set(key, suitability);
    this.suitabilitySum += suitability;
    this.frontier.delete(key);
    if (col < this.minCol) this.minCol = col;
    if (col > this.maxCol) this.maxCol = col;
    if (row < this.minRow) this.minRow = row;
    if (row > this.maxRow) this.maxRow = row;
  }

  private pushNeighbours(col: number, row: number): void {
    for (const [dc, dr] of NEIGHBOURS) {
      const key = cellKey(col + dc, row + dr);
      if (!this.held.has(key)) this.frontier.add(key);
    }
  }

  /**
   * A place that has shrunk gives ground back from the outside in, worst
   * first — which is the order it would really go: the far close reverts to
   * waste long before the croft behind the church does.
   */
  private shrink(ctx: LandContext, want: number): void {
    let worstKey: number | null = null;
    let worstScore = Infinity;

    for (const [key, suitability] of this.held) {
      const centre = ctx.terrain.cellCentre(keyCol(key), keyRow(key));
      const score = suitability - dist(centre, this.origin) / Math.max(1, this.wantedRadius);
      if (score < worstScore) {
        worstScore = score;
        worstKey = key;
      }
    }

    if (worstKey === null || this.held.size <= Math.max(1, want)) return;
    const suitability = this.held.get(worstKey) ?? 0;
    this.held.delete(worstKey);
    this.suitabilitySum -= suitability;
    ctx.registry.release(worstKey, this);
    this.frontier.add(worstKey);
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// ----------------------------------------------------------------- survey

export interface GroundSurvey {
  /**
   * Share of the surrounding country that is both worth settling and nobody
   * else's — "how much room is there to grow here", which is the question the
   * whole urban/rural split turns on.
   */
  openness: number;
  /** Share already being worked by resource sites: the mark of rural country. */
  worked: number;
  /** Share that could be built on at all, held or not. */
  buildable: number;
}

/** What a place knows about its surroundings before anything has surveyed them. */
export const EMPTY_HINTERLAND: GroundSurvey = { openness: 0, worked: 0, buildable: 0 };

/**
 * What the country around a point looks like to somebody thinking of growing
 * into it.
 *
 * Sampled coarsely and deliberately — this is asked of every candidate patch
 * on every settlement scan, and the answer only ever feeds a soft weight, so
 * a stride of a few cells costs a fraction as much and changes nothing about
 * the shape of the result.
 */
export function surveyGround(
  centre: Vec2,
  radius: number,
  ctx: LandContext,
  self?: LandParcel,
  stride = 3,
): GroundSurvey {
  const { terrain } = ctx;
  const step = stride * terrain.cellSize;
  const reachSq = radius * radius;

  let total = 0;
  let open = 0;
  let worked = 0;
  let buildable = 0;

  for (let y = centre.y - radius; y <= centre.y + radius; y += step) {
    for (let x = centre.x - radius; x <= centre.x + radius; x += step) {
      const dx = x - centre.x;
      const dy = y - centre.y;
      if (dx * dx + dy * dy > reachSq) continue;

      total++;
      const col = terrain.colAt(x);
      const row = terrain.rowAt(y);
      const owner = ctx.registry.ownerOf(cellKey(col, row));
      if (owner && owner.kind === 'worked') worked++;

      if (settledSuitability(terrain.sampleAtCell(col, row)) <= 0.15) continue;
      buildable++;
      if (!owner || owner === self) open++;
    }
  }

  if (total === 0) return EMPTY_HINTERLAND;
  return { openness: open / total, worked: worked / total, buildable: buildable / total };
}

// -------------------------------------------------------------- appetites

/**
 * How much ground one resident's household actually occupies — the toft, the
 * garden, the close, and its share of the in-fields.
 *
 * Roughly 10.7 hectares at this game's stated scale (`scale.ts`), which is
 * only absurd until you remember that a "villager" here is a working
 * household rather than a soul — call it five people — and that two hectares
 * a head is an ordinary figure for medieval mixed agriculture.
 */
const AREA_PER_RESIDENT = 6700;

/**
 * Sub-linear on purpose, and this exponent is doing real work: it is the
 * whole of what "urbanising" physically means here. A place of fifty does not
 * hold five times the ground a place of ten does — it holds about four and a
 * quarter times, because the extra people go in denser, buy more of their
 * food and farm less of it. Linear would mean a city needed a county, and the
 * map would be nothing but sprawl by the second hour.
 */
const DENSITY_EXPONENT = 0.9;

export function settledAreaFor(population: number): number {
  return AREA_PER_RESIDENT * Math.max(1, population) ** DENSITY_EXPONENT;
}

/**
 * How far a place looks when it asks whether it has anywhere to grow. Scales
 * with the place, because a hamlet's horizon and a city's are not the same
 * question, with a floor so a brand-new settlement still surveys a real
 * neighbourhood rather than its own doorstep.
 */
export function hinterlandRadius(settledArea: number): number {
  return Math.max(900, Math.sqrt(Math.max(1, settledArea) / Math.PI) * 2.4);
}

/**
 * How urban a place is, from 0 (a farming village) to 1 (a proper town living
 * off trade and workshops).
 *
 * Two things, and neither of them is population — population is what this
 * *causes*, via housing and industry, and keying it on population as well
 * would close that loop on itself. What it reads instead is the country: is
 * there open ground around this place, and has it actually managed to take
 * the ground it wanted. A place hemmed in by its own workings scores low on
 * both and stays what it is, however busy it gets.
 */
export function urbanityFor(hinterland: GroundSurvey, satisfaction: number): number {
  const rural = clamp01(hinterland.worked / WORKS_HEAVY);
  return roomScore(hinterland.openness) * (1 - rural) * (0.4 + 0.6 * satisfaction);
}

/**
 * Openness as a 0-to-1 judgement rather than a raw share — "is there room
 * here", not "what fraction of the cells are free".
 *
 * Shared by `urbanityFor` and by the settlement score's `room` term, which is
 * the point: the question a founder asks about a spot and the question that
 * later decides what the place becomes are the same question, and they must
 * not be allowed to answer it on different scales. Feeding the raw share into
 * the settlement score was also a quiet bug — ordinary country reads 0.85 to
 * 0.95, so the term contributed almost exactly its full weight everywhere and
 * discriminated between candidates hardly at all.
 */
export function roomScore(openness: number): number {
  return clamp01((openness - OPEN_ENOUGH_FLOOR) / (OPEN_ENOUGH_CEILING - OPEN_ENOUGH_FLOOR));
}

/**
 * The band `openness` is read against, and it is the part of this most likely
 * to need re-measuring rather than re-reasoning.
 *
 * First cut ran 0.25 to 0.70 and read 100% at every place in the realm on the
 * first long run — not because the system was wrong but because the
 * distribution was nothing like the guess. Over a parish-sized hinterland of
 * ordinary procedural country, openness lands in the eighties and nineties;
 * anything below about two-thirds already means a place is genuinely boxed in
 * by water, crag or somebody's workings. This is the same mistake
 * `industry.ts`'s `INDUSTRY_INPUT_LINE` records at length: a threshold's
 * meaning depends entirely on the distribution it is compared against, and
 * this project keeps finding that out by measuring rather than by thinking.
 */
const OPEN_ENOUGH_FLOOR = 0.62;
const OPEN_ENOUGH_CEILING = 0.94;

/**
 * The share of a hinterland under working ground that makes a place
 * thoroughly rural.
 *
 * A separate term from `openness` and not a redundant one, though it looks it.
 * Openness asks "is there anywhere left", which a village with one big wood on
 * its east side answers cheerfully — there are three other compass points.
 * This asks "is this working country", which is the question the user of this
 * place is really in: a settlement whose parish is a quarter workings is a
 * settlement whose people are out in them, whatever room it has to put more
 * houses up. The two together are what tell "a market town on an open plain"
 * apart from "a hamlet in a mining valley that happens to have a spare
 * meadow".
 */
const WORKS_HEAVY = 0.18;

export function urbanityLabel(urbanity: number): string {
  if (urbanity >= 0.66) return 'URBAN';
  if (urbanity >= 0.33) return 'MIXED';
  return 'RURAL';
}
