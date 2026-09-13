import type { Vec2 } from './geometry';
import { BRIDGE_COST, MAX_BRIDGE_SPAN } from './terrain';

/**
 * Rivers, as lines rather than as cells.
 *
 * ## Why they cannot live in the raster
 *
 * A river is three orders of magnitude longer than it is wide. The Vrchlice
 * below Kutná Hora is about five metres across and runs for tens of
 * kilometres, and the reference drawing this project's map was traced from
 * renders its watercourses at a median of five metres. A terrain cell on that
 * map is sixty-four. Nothing that stores water as "which cells are wet" can
 * represent that, at any resolution anyone would pay for.
 *
 * Worse, it could not even be made *consistent*. A watercourse rasterised one
 * cell wide and running diagonally is a staircase of cells touching only at
 * their corners — and nothing in this game moves diagonally, so a road could
 * thread between two of them and cross a river without ever meeting it. The
 * picture said there was a river; the simulation said there was not.
 * `importimage.ts` dealt with that by dilating every watercourse to two cells,
 * which fixed the topology and fixed the width at a hundred and twenty-eight
 * metres — twenty-five times life, and wide enough that the renderer drew
 * every brook in Bohemia as a lake.
 *
 * That floor is structural, not a matter of resolution: the dilation is
 * needed because of how cells connect, so the minimum is two cells however
 * small a cell gets. Refining the grid to hold a real river would have cost
 * twenty-eight times the cells and still left a floor, with a five-metre
 * brook out of reach.
 *
 * As a line, the width is simply a number the river carries, and the
 * crossing test is an intersection — exact, with no diagonal gap to fall
 * through and nothing to dilate. The bug disappears rather than being worked
 * around.
 *
 * ## What is still a cell
 *
 * Lakes, ponds, estuaries, the sea. Those genuinely are areal — their width
 * is the same order as their length — and the raster holds them perfectly
 * well. The split is not "water is vector now", it is "water is stored in the
 * shape it actually has".
 */

export interface River {
  name: string | null;
  /** Centreline, in world units. */
  points: Vec2[];
  /**
   * Water width at each point, in world units, parallel to `points`.
   *
   * Per point rather than per river because it genuinely varies — the same
   * watercourse is a step across at its head and a bridge-worth at the town,
   * and a single figure would have to be wrong at one end or the other.
   */
  widths: number[];
}

/**
 * A body of water wide enough to be an area rather than a line.
 *
 * Geometry for the renderer only. The simulation's answer to "can anything
 * stand here" still comes from the terrain raster, which holds these cells as
 * water exactly as it always did — see `PackFile.water`. Nothing here is
 * consulted by a road, a villager or a settlement, which is why this carries
 * an outline and no rules whatever.
 */
export interface WaterBody {
  name: string | null;
  /** Closed shore outline, world units. */
  points: Vec2[];
}

/** A place a line crosses a river, and how much water it has to get over. */
export interface Crossing {
  at: Vec2;
  /** World units of water, which is what decides ford, bridge or impossible. */
  width: number;
}

/** Signed area of the triangle abc — positive if abc turns anticlockwise. */
function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Where two segments meet, or null. Collinear overlap counts as no crossing:
 * a road laid exactly along a river bank is running *beside* the water, not
 * over it, and charging it a bridge would price the most natural road in any
 * valley as the most expensive.
 */
function intersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (d1 * d2 >= 0 || d3 * d4 >= 0) return null;

  const t = d3 / (d3 - d4);
  return { x: c.x + (d.x - c.x) * t, y: c.y + (d.y - c.y) * t };
}

export class RiverNetwork {
  constructor(readonly rivers: readonly River[] = []) {}

  get isEmpty(): boolean {
    return this.rivers.length === 0;
  }

  /**
   * Whether this world's water is drawn by the water layer rather than by the
   * ground bake.
   *
   * It is all-or-nothing on purpose. A world with rivers has water the bake
   * cannot draw, so its water layer has to exist — and once it does, leaving
   * the *areal* water to the bake would give one map two kinds of water with a
   * visible seam between them, which is the thing this whole exercise is
   * about. So if the water layer draws any of it, it draws all of it.
   */
  get drawsOwnWater(): boolean {
    return this.rivers.length > 0;
  }

  /**
   * Every crossing a line makes. A road that meets the same river three times
   * pays for three bridges, which is correct and is exactly the pressure that
   * should make a surveyor straighten it out.
   */
  crossings(points: readonly Vec2[]): Crossing[] {
    const found: Crossing[] = [];
    if (this.rivers.length === 0 || points.length < 2) return found;

    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];

      for (const river of this.rivers) {
        for (let j = 0; j + 1 < river.points.length; j++) {
          const at = intersection(a, b, river.points[j], river.points[j + 1]);
          if (!at) continue;
          // The narrower of the two ends bounds what has to be spanned; a
          // crossing sits somewhere between them and a bridge is built for
          // the water actually under it.
          found.push({ at, width: Math.min(river.widths[j], river.widths[j + 1]) });
        }
      }
    }

    return found;
  }

  /**
   * Whether every crossing along this line is one a bridge could really make.
   *
   * The same rule the raster applied through `longestWaterSpan`, asked of the
   * river's own width instead of of how many wet cells a line happened to
   * clip. It is the stricter reading and the more honest one: a ford across
   * five metres of brook is now genuinely free of the question, where before
   * it was a hundred and twenty-eight metres of raster and a third of the
   * budget for a real bridge.
   */
  canCross(points: readonly Vec2[]): boolean {
    return this.crossings(points).every((c) => c.width <= MAX_BRIDGE_SPAN);
  }

  /**
   * What the crossings along a line add to the cost of building and walking
   * it, as cost-times-length in the same units `TERRAIN_COSTS` is in.
   *
   * Returned as an integral rather than as an average so the caller can fold
   * it into a road's difficulty alongside the ground's, without either having
   * to know how long the other thinks the road is.
   */
  crossingEffort(points: readonly Vec2[]): number {
    let total = 0;
    for (const crossing of this.crossings(points)) total += BRIDGE_COST * crossing.width;
    return total;
  }
}

/** The answer for every world that has no rivers — every procedural one, so far. */
export const NO_RIVERS = new RiverNetwork();
