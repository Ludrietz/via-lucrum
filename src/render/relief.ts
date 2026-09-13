import Phaser from 'phaser';
import { TERRAIN_CHUNK_SIZE, WATER_LEVEL } from '../sim/terrain';
import type { TerrainSource } from '../sim/source';
import { catmullRom } from './field';
import { grain, groundColour, hillshade, waterness } from './land';

/**
 * Turns a chunk of terrain into a painted image of itself.
 *
 * ## Why a raster, when the simulation is a grid of cells
 *
 * Because the grid is an artefact of how the world is *stored*, not of what
 * it is. Elevation and moisture are continuous fields (see `TerrainSampler`);
 * cells are just where we chose to sample them. The old layer drew one
 * rectangle per cell, which meant the sampling lattice was the most visible
 * thing on screen — you could read the cell size off the picture.
 *
 * Here the cell readings are treated as what they are: samples of a smooth
 * surface, to be interpolated back into one. The chunk is painted at several
 * texels per cell, each texel interpolated from the four cells around it, and
 * the lattice disappears. The simulation still sees squares; the player never
 * does.
 *
 * ## Why the reconstruction filter matters more than the resolution
 *
 * Hillshading is a differentiation of the height field, so it does not show
 * you the reconstructed surface — it shows you the surface's *slope*, and any
 * lattice structure hiding in the slope comes straight out as a visible plaid
 * at cell spacing. Which filter is used therefore matters more here than how
 * many texels are spent, and the obvious choices both fail. See `catmullRom`
 * in `field.ts` for why this uses bicubic.
 *
 * ## Why this is safe to bake, when vegetation is not
 *
 * Everything painted here derives from elevation and moisture, and neither
 * ever changes: hills are not felled, rivers do not move. Anything the
 * simulation can *alter* — woodland cleared for a growing settlement, ground
 * broken for fields — is drawn live on top of this by other layers, so a
 * baked chunk never has to be invalidated. Splitting the map this way is what
 * buys both the fidelity and the mutability; baking the lot would have made
 * clearing a forest mean repainting the county.
 */

/**
 * Texels per terrain cell.
 *
 * Four, and it can afford to be that low only because of what the filtering
 * does. The reconstruction (`catmullRom`) removes the lattice from the
 * shading, the waterline is antialiased against distance rather than against
 * the texel grid (`waterness`), and the texture is stretched bilinearly — so
 * the ground the player sees is smooth regardless, and extra texels buy
 * nothing but bake time. Six looked identical and cost more than twice as
 * much per chunk.
 */
const TEXELS_PER_CELL = 4;
/** Ceiling on a chunk texture's side, so a finely surveyed pack can't blow up texture memory. */
const MAX_TEXELS = 192;

/**
 * Bicubic reconstruction over a flat array, sharing `catmullRom` with the
 * generic version in `field.ts` but not its per-tap callback.
 *
 * The generic form takes a `get` function, which is the right shape for the
 * handful of taps a tree needs and the wrong one here: this loop runs it
 * thirty-odd thousand times per chunk per field, and the indirection alone
 * cost more than everything else in the bake put together. The arithmetic is
 * identical — only the way the samples are fetched differs — so the two still
 * reconstruct the same surface.
 */
function bicubicArray(field: Float32Array, stride: number, fx: number, fy: number): number {
  const col = Math.floor(fx);
  const row = Math.floor(fy);
  const tx = fx - col;
  const ty = fy - row;

  const base = (row - 1) * stride + col - 1;
  const r0 = catmullRom(field[base], field[base + 1], field[base + 2], field[base + 3], tx);
  const r1 = catmullRom(field[base + stride], field[base + stride + 1], field[base + stride + 2], field[base + stride + 3], tx);
  const r2 = catmullRom(field[base + stride * 2], field[base + stride * 2 + 1], field[base + stride * 2 + 2], field[base + stride * 2 + 3], tx);
  const r3 = catmullRom(field[base + stride * 3], field[base + stride * 3 + 1], field[base + stride * 3 + 2], field[base + stride * 3 + 3], tx);

  return catmullRom(r0, r1, r2, r3, ty);
}

/**
 * How many texels of the neighbouring chunk each texture carries past its own
 * edge.
 *
 * Without it, chunks meet in a visible seam. Linear filtering at a texture's
 * border has no neighbour to blend towards, so it clamps against the edge
 * texel — and two chunks clamping away from each other leave a hairline of
 * wrongly-weighted colour down the join, which at any real zoom reads as a
 * ruled line across the countryside. Painting one texel of the neighbour's
 * ground into each texture and overlapping them gives the filter the samples
 * it was missing. The overlapping texels agree exactly, because both chunks
 * computed them from the same terrain.
 */
const BLEED = 1;

export interface ReliefTexture {
  key: string;
  /** How many world units one texel covers — what the sprite must be scaled by. */
  texelSize: number;
  /** World units the texture extends past the chunk's corner, on every side. */
  bleed: number;
}

/**
 * Paint one chunk into a Phaser canvas texture and return its key.
 *
 * Cost is dominated by the texel loop, roughly 16k texels for a default
 * chunk. Chunks arrive a few at a time as the frontier spreads, and
 * `TerrainLayer` budgets how many get built per frame, so this never needs to
 * be fast — only cheap enough not to be noticed.
 */
export function bakeRelief(
  scene: Phaser.Scene,
  terrain: TerrainSource,
  cx: number,
  cy: number,
  /**
   * Leave the water to someone else.
   *
   * Set for a world that carries its own water geometry. The cells stay
   * water — the simulation still reads them that way — but painting them
   * here as well would put a blurred four-texel smudge underneath the crisp
   * outline drawn on top, so the two would show as a double edge with a
   * sandbank between them. Below the waterline is simply painted as the
   * lowest land instead, which is what a lake bed is.
   */
  skipWater = false,
): ReliefTexture {
  const cellSize = terrain.cellSize;
  const cellsPerChunk = Math.round(TERRAIN_CHUNK_SIZE / cellSize);
  const texels = Math.min(MAX_TEXELS, cellsPerChunk * TEXELS_PER_CELL);
  const texelSize = TERRAIN_CHUNK_SIZE / texels;

  const originCol = cx * cellsPerChunk;
  const originRow = cy * cellsPerChunk;

  // A margin of cells either side, because interpolating the texels at the
  // chunk's edge needs the neighbouring chunk's cells. Reading them costs
  // nothing (terrain answers at any coordinate, generated or not) and is the
  // whole reason adjacent chunks meet seamlessly instead of showing a join.
  // Bicubic reaches one sample further than linear does, so the skirt has to
  // cover `floor(fx) - 1` through `floor(fx) + 2`. Three is the smallest
  // margin that always has those four cells in hand; reading past the end of
  // the array would quietly hand the shading a zero and draw a cliff along
  // every chunk edge.
  const MARGIN = 3;
  const stride = cellsPerChunk + MARGIN * 2;
  const elevation = new Float32Array(stride * stride);
  const moisture = new Float32Array(stride * stride);

  for (let row = 0; row < stride; row++) {
    for (let col = 0; col < stride; col++) {
      const sample = terrain.sampleAtCell(originCol + col - MARGIN, originRow + row - MARGIN);
      const at = row * stride + col;
      elevation[at] = sample.elevation;
      moisture[at] = sample.moisture;
    }
  }

  // Resolve elevation to texel resolution once, with a one-texel skirt, so
  // the shading pass can take its gradient from neighbouring texels instead
  // of re-interpolating the cell grid four more times per texel.
  // One texel of skirt past the painted area, which itself already reaches
  // `BLEED` past the chunk — the shading pass takes central differences, so
  // every painted texel needs a neighbour on each side.
  const SKIRT = BLEED + 1;
  const hStride = texels + SKIRT * 2;
  const height = new Float32Array(hStride * hStride);
  const damp = new Float32Array(hStride * hStride);
  const toCell = texelSize / cellSize;

  for (let ty = -SKIRT; ty < texels + SKIRT; ty++) {
    for (let tx = -SKIRT; tx < texels + SKIRT; tx++) {
      // Cell-centre coordinates of this texel's centre, offset by the margin.
      const fx = (tx + 0.5) * toCell + MARGIN - 0.5;
      const fy = (ty + 0.5) * toCell + MARGIN - 0.5;
      const at = (ty + SKIRT) * hStride + (tx + SKIRT);
      height[at] = bicubicArray(elevation, stride, fx, fy);
      damp[at] = bicubicArray(moisture, stride, fx, fy);
    }
  }

  // Flatten the lake beds too, not just their colour.
  //
  // A pack signals "this cell is water" by dropping it below the waterline
  // (`WATER_SIGNAL_STEP`), which is a step in the height field — and
  // hillshading is a differentiation, so even with the water left unpainted
  // that step still lights up as a dark ring round every pond. Clamping the
  // reconstructed height before the gradient is taken removes the ring at
  // source, and is honest about what it is doing: the surface of still water
  // is flat, so there is nothing there to shade.
  if (skipWater) {
    for (let i = 0; i < height.length; i++) {
      if (height[i] < WATER_LEVEL) height[i] = WATER_LEVEL;
    }
  }

  const key = `relief:${cx},${cy}`;
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const painted = texels + BLEED * 2;
  const canvas = scene.textures.createCanvas(key, painted, painted)!;

  const image = canvas.context.createImageData(painted, painted);
  const pixels = image.data;

  for (let ty = -BLEED; ty < texels + BLEED; ty++) {
    for (let tx = -BLEED; tx < texels + BLEED; tx++) {
      const at = (ty + SKIRT) * hStride + (tx + SKIRT);
      const e = height[at];
      const m = damp[at];

      // Central differences, in elevation per world unit.
      const dx = (height[at + 1] - height[at - 1]) / (2 * texelSize);
      const dy = (height[at + hStride] - height[at - hStride]) / (2 * texelSize);

      // Distance to the waterline, in world units, from the local gradient:
      // how far above the surface we are, divided by how fast height is
      // changing. That converts a question about elevation into a question
      // about ground, which is what both the shoreline and the beach actually
      // depend on. Flat ground gives a huge number, which is correct — you
      // are a long way from any shore.
      const slope = Math.hypot(dx, dy);
      const fromShore = skipWater
        ? Number.POSITIVE_INFINITY
        : (e - WATER_LEVEL) / Math.max(slope, 1e-6);

      const colour = groundColour(skipWater ? Math.max(e, WATER_LEVEL) : e, m, fromShore, texelSize);

      // Relief shading is a statement about a *surface* catching the light,
      // and the surface of a lake is flat however far the bed drops away
      // beneath it. Shading the submerged terrain instead put lit and shaded
      // faces inside the water, which read as a hole rather than a lake.
      const wet = waterness(fromShore, texelSize);
      const shade = 1 + (hillshade(dx, dy) - 1) * (1 - wet);
      const fleck = grain(cx * texels + tx, cy * texels + ty) * (1 - wet * 0.7);

      const p = ((ty + BLEED) * painted + (tx + BLEED)) * 4;
      pixels[p] = Math.max(0, Math.min(255, colour.r * shade + fleck));
      pixels[p + 1] = Math.max(0, Math.min(255, colour.g * shade + fleck));
      pixels[p + 2] = Math.max(0, Math.min(255, colour.b * shade + fleck));
      pixels[p + 3] = 255;
    }
  }

  canvas.context.putImageData(image, 0, 0);
  // Bilinear, and this is not a detail. The texture is stretched several
  // times its own size to cover the chunk, and Phaser's default for a canvas
  // texture is nearest-neighbour — which reproduces the very thing this whole
  // layer exists to remove, just at texel size instead of cell size. With
  // linear filtering the GPU reconstructs the smooth surface the texels were
  // sampled from, and the landscape stops having edges nobody drew.
  canvas.setFilter(Phaser.Textures.FilterMode.LINEAR);
  canvas.refresh();

  return { key, texelSize, bleed: BLEED * texelSize };
}
