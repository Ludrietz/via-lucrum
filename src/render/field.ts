import type { TerrainSource } from '../sim/source';
import type { TerrainSample } from '../sim/terrain';

/**
 * Reading the terrain as a surface instead of as a set of tiles.
 *
 * The simulation stores its readings on a grid because it has to — a road has
 * to be priced somewhere, a settlement has to stand somewhere. But elevation,
 * moisture and temperature are samples of continuous fields, and every part of
 * the renderer that puts something at a precise point (a texel of shading, a
 * tree) needs a reading at *that* point, not at the middle of whichever cell
 * it fell in.
 *
 * Both of those callers must reconstruct the surface the same way. If the
 * relief shading used one filter and the treeline another, woods would sit
 * slightly off the hillsides they grow on — a mismatch nobody could name but
 * everybody would see. Hence one shared kernel here.
 */

/**
 * Catmull-Rom through four samples, evaluated between the middle two.
 *
 * ## Why not something simpler
 *
 * Linear interpolation of a height field leaves creases along the cell
 * diagonals, which hillshading lights up as a visible quilt. The obvious
 * repair is to ease the weights with a smoothstep — and it does fix the
 * diagonals, and it quietly introduces something worse.
 *
 * Smoothstep has zero derivative at both ends. Applied to a grid, that means
 * the reconstructed surface is *flat along every cell line*, in the direction
 * being interpolated. The surface is smooth, so nothing looks wrong until you
 * differentiate it — and hillshading is exactly a differentiation. The
 * gradient field then carries the lattice, and the landscape comes out combed
 * into a faint plaid at precisely cell spacing: the grid we set out to remove,
 * reintroduced by the tool meant to remove it.
 *
 * Catmull-Rom takes its slope at each sample from that sample's neighbours
 * instead of forcing it to zero, so the reconstruction is smooth *and* its
 * derivative keeps varying across cell boundaries. It costs four taps per axis
 * rather than two. That is the whole price of a landscape with no lattice in
 * it, and it is worth paying.
 */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}

/** The readings a renderer wants, reconstructed at an exact point. */
export interface SmoothReading {
  elevation: number;
  moisture: number;
  temperature: number;
  forestDensity: number;
}

/**
 * The 4x4 block of cells a reconstruction reads from, reused between calls.
 *
 * Scatter asks for a reading at every candidate tree — a few thousand per
 * chunk — so this runs often enough that allocating a fresh array each time
 * showed up as garbage collection pauses while the frontier was expanding.
 */
const block: TerrainSample[] = new Array(16);

function blend(key: keyof SmoothReading, tx: number, ty: number): number {
  const r0 = catmullRom(block[0][key], block[1][key], block[2][key], block[3][key], tx);
  const r1 = catmullRom(block[4][key], block[5][key], block[6][key], block[7][key], tx);
  const r2 = catmullRom(block[8][key], block[9][key], block[10][key], block[11][key], tx);
  const r3 = catmullRom(block[12][key], block[13][key], block[14][key], block[15][key], tx);
  return catmullRom(r0, r1, r2, r3, ty);
}

/**
 * Reconstruct the terrain's readings at a world point.
 *
 * Every reading comes out of the same sixteen cells, so they are fetched once
 * and blended four times rather than the field-at-a-time form this started
 * as, which asked the terrain for the same sixteen cells four times over and
 * made scatter the most expensive thing in the renderer by a wide margin.
 *
 * The relief pass wants the same reconstruction per texel — tens of thousands
 * of times — so it resamples into flat arrays first rather than coming through
 * here (see `relief.ts`), but it uses the same kernel.
 */
export function readSmooth(terrain: TerrainSource, x: number, y: number): SmoothReading {
  const size = terrain.cellSize;
  // Cell-centre coordinates: a cell's reading belongs at its middle, not at
  // its corner, so shift by half a cell before flooring.
  const fx = x / size - 0.5;
  const fy = y / size - 0.5;
  const col = Math.floor(fx);
  const row = Math.floor(fy);
  const tx = fx - col;
  const ty = fy - row;

  for (let j = -1; j <= 2; j++) {
    for (let i = -1; i <= 2; i++) {
      block[(j + 1) * 4 + (i + 1)] = terrain.sampleAtCell(col + i, row + j);
    }
  }

  return {
    elevation: blend('elevation', tx, ty),
    moisture: blend('moisture', tx, ty),
    temperature: blend('temperature', tx, ty),
    forestDensity: blend('forestDensity', tx, ty),
  };
}
