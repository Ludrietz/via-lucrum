import { METRES_PER_ELEVATION, METRES_PER_UNIT } from '../sim/scale';
import { HILLS_LEVEL, MOUNTAIN_LEVEL, WATER_LEVEL } from '../sim/terrain';

/**
 * What ground *looks* like, as a continuous function of the same physical
 * readings the simulation runs on.
 *
 * This is deliberately not a lookup keyed off `TerrainType`. A type is a
 * bucket — it exists so pathfinding can price a cell and so the UI can name
 * it — and painting from buckets is exactly what made the old terrain read
 * as a grid of coloured squares: every cell in a region got byte-identical
 * paint, so the only thing the eye could see was the cell boundaries.
 *
 * Here elevation and moisture go in as floats and colour comes out as a
 * float, with every transition a smooth blend rather than a threshold. Two
 * neighbouring plains cells at moisture 0.44 and 0.46 come out very slightly
 * different, a hillside shades continuously into the valley below it, and
 * the boundary between forest and field is wherever the moisture field
 * happens to cross — a wandering, ragged line nobody drew.
 *
 * The classifier in `terrain.ts` still has the last word on what ground *is*.
 * This file only decides what it looks like, and the two agree because they
 * read the same numbers and use the same landmark elevations.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const rgb = (hex: number): Rgb => ({ r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff });

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Hermite blend — the workhorse. Every band edge below is one of these, never an `if`. */
function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01((v - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------ palette

/**
 * Muted, slightly desaturated earth: the colours of a painted estate map
 * rather than of a satellite photograph. Nothing here is fully saturated and
 * nothing is near-black, because pigment on paper never is — the darkest
 * value in the whole scene is the ink of the linework, not the land.
 */
/**
 * Water, in one place.
 *
 * Exported because water is now painted by two different things — the ground
 * bake for anything areal, and `RiverLayer` for anything too narrow for the
 * raster to hold — and the first version of that had each of them choose its
 * own blue. They were close enough to look deliberate and far enough apart to
 * look wrong, so a stream reaching a pond changed colour at the join and the
 * whole business read as two substances rather than one. Two renderers is a
 * fact about resolution and cannot be helped; two palettes was a choice, and
 * could.
 */
export const WATER = {
  deep: 0x44606f,
  shallow: 0x7b9daf,
  /** The pale rim where water meets land — sand, silt, trodden bank. */
  shore: 0xb3a886,
} as const;

const DEEP_WATER = rgb(WATER.deep);
const SHALLOW_WATER = rgb(WATER.shallow);
const SHORE = rgb(WATER.shore);

/**
 * Lowland runs dry straw to lush pasture along moisture; forest sits at the
 * wet end.
 *
 * Pitched deliberately down the value scale from where it started. The whole
 * palette used to live in the top third of the range, which made every
 * transition a change of *hue* on ground that was uniformly light — and hue
 * is the weakest signal the eye has at map zoom. Nothing could then be read
 * from across the map: woodland, pasture and upland were three similar-weight
 * greens, and a road drawn over them had nothing to be lighter than.
 *
 * Dropping open country to a mid olive costs nothing legible — it is still
 * plainly grass — and buys the two things the map was missing: woods that
 * read as a dark mass without being painted any darker than they already
 * were, and headroom above the ground for the things that are supposed to be
 * bright, which are the roads and the settlements.
 *
 * The other half of the correction is temperature. Measured against a drawn
 * estate map of real country, every tonal band of it — deep woodland, open
 * ground, cultivated strip — carries as much red as green; ours carried
 * fifteen to twenty units less, which is the difference between khaki and
 * grass, and it is why the landscape read as a satellite pass rather than as
 * pigment.
 *
 * That warming is applied to the *dry* end and not across the board, which
 * matters and was got wrong once. Matching the reference's average hue warms
 * every stop equally and drains the green out of damp country along with the
 * parched — leaving a map that is uniformly khaki, which the reference is
 * not. Its average is warm because most of its ground is dry; its damp
 * ground and its woods are plainly green. So dry grass and dry upland are
 * khaki, pasture and meadow stay green, and the average falls out of how
 * much of each the country happens to have — which is the right way round.
 */
const DRY_GRASS = rgb(0x9b945c);
const PASTURE = rgb(0x839152);
const WET_MEADOW = rgb(0x62763c);

/** Higher ground loses green and gains the olive-brown of thin upland soil. */
const DRY_UPLAND = rgb(0x80754a);
const WET_UPLAND = rgb(0x687540);

const SCREE = rgb(0x7c7469);
const BARE_ROCK = rgb(0x595348);
const SNOW = rgb(0xd8d3c4);

/**
 * How wide the sandy rim below a treeline-free shore is, in world units.
 *
 * In world units, and that matters. This used to be a band of *elevation*
 * either side of the waterline, which meant a shore that sprawled across half
 * a county on flat ground and vanished entirely against a cliff — the width
 * you actually see depended on the local gradient, which is exactly backwards
 * from how a beach works.
 */
const SHORE_WIDTH = 26;

/** Open water, on its own ramp: depth is all that varies under the surface. */
function waterColour(elevation: number): Rgb {
  return mix(DEEP_WATER, SHALLOW_WATER, smoothstep(WATER_LEVEL - 0.3, WATER_LEVEL, elevation));
}

function landColour(elevation: number, moisture: number, fromShore: number): Rgb {
  const lowland = mix(
    mix(DRY_GRASS, PASTURE, smoothstep(0.25, 0.6, moisture)),
    WET_MEADOW,
    smoothstep(0.55, 0.85, moisture),
  );
  const upland = mix(DRY_UPLAND, WET_UPLAND, smoothstep(0.3, 0.7, moisture));
  const rock = mix(SCREE, BARE_ROCK, smoothstep(MOUNTAIN_LEVEL + 0.1, MOUNTAIN_LEVEL + 0.35, elevation));

  // Wide overlaps on purpose. A narrow blend is just a threshold with a
  // gradient painted over it and still reads as a band; these are wide enough
  // that the eye reads a slope, not a contour line.
  let colour = mix(lowland, upland, smoothstep(HILLS_LEVEL - 0.16, HILLS_LEVEL + 0.18, elevation));
  colour = mix(colour, rock, smoothstep(MOUNTAIN_LEVEL - 0.14, MOUNTAIN_LEVEL + 0.14, elevation));
  colour = mix(colour, SNOW, smoothstep(0.82, 0.95, elevation));

  return mix(colour, SHORE, (1 - smoothstep(0, SHORE_WIDTH, fromShore)) * 0.75);
}

/**
 * How much of this point is water, from 0 (dry) to 1 (open water).
 *
 * `fromShore` is the distance to the waterline in *world units*, signed
 * positive on land, and `edge` is the width of one texel. Blending across one
 * texel either side of the line is ordinary analytic antialiasing, and it is
 * what stops the coast being a staircase.
 *
 * Doing it this way rather than by piling on resolution is the difference
 * between a fix and a postponement: a hard branch on `elevation < WATER_LEVEL`
 * quantises the coastline to whatever the texel grid happens to be, so every
 * increase in texture size buys a smaller staircase and never a smooth curve.
 * Measured against distance instead, the edge is exactly one texel wide at any
 * resolution.
 */
export function waterness(fromShore: number, edge: number): number {
  return 1 - smoothstep(-edge, edge, fromShore);
}

/**
 * Ground colour at a point.
 *
 * Deliberately not a lookup keyed off `TerrainType` — see the note at the top
 * of this file. Elevation and moisture go in as floats and colour comes out as
 * a float, with every transition a blend rather than a threshold.
 */
export function groundColour(elevation: number, moisture: number, fromShore: number, edge: number): Rgb {
  return mix(landColour(elevation, moisture, fromShore), waterColour(elevation), waterness(fromShore, edge));
}

/** Blend two packed colours, `t` of the way from the first to the second. */
export function mixHex(a: number, b: number, t: number): number {
  return toHex(mix(rgb(a), rgb(b), t));
}

/** Pack an Rgb back into the single number Phaser wants. */
export function toHex(c: Rgb): number {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return (clamp(c.r) << 16) | (clamp(c.g) << 8) | clamp(c.b);
}

/**
 * The tone of a bank: this ground, damper and paler.
 *
 * Water drawn as geometry has no way to blend into what it sits on the way
 * the ground bake does, because a filled polygon gets one colour and the bake
 * gets a decision per texel. The obvious workaround is to draw the rim
 * semi-transparently and let the ground show through — which works perfectly
 * until two pieces of water overlap, at which point the rim is blended twice
 * and every confluence grows a dark bruise.
 *
 * So the rim is opaque, and it is told what it is sitting on instead. Asking
 * the palette for the local ground and walking it towards the shore tone
 * gives a rim that matches its surroundings wherever it is drawn, and that
 * can be painted over itself any number of times without changing shade.
 */
export function bankTone(elevation: number, moisture: number, towardsWater = 0): number {
  // A huge distance-from-shore, so this is the dry-land answer with none of
  // the bake's own water blending folded into it.
  const ground = groundColour(elevation, moisture, 1e6, 1);
  const bank = mix(ground, SHORE, 0.55);
  return toHex(towardsWater > 0 ? mix(bank, SHALLOW_WATER, towardsWater) : bank);
}

// --------------------------------------------------------------- hillshade

/**
 * How much steeper than life the land is drawn.
 *
 * Not a fudge factor, and no longer a bare number: the conversion from the
 * elevation field to a true gradient is arithmetic (`METRES_PER_ELEVATION`
 * over `METRES_PER_UNIT`), and this is the honest multiplier on top of it.
 * Relief maps have exaggerated the vertical for as long as they have existed,
 * for the reason that applies here — this country runs to a median grade of
 * about 4%, and shaded truthfully it is a blank sheet.
 *
 * Five is roughly what the old hand-picked 520 worked out to once the real
 * conversion was written down, so the map looks much as it did; the
 * difference is that it now means something, and that raising the world's
 * relief in `scale.ts` will correctly make the shading stronger instead of
 * leaving it alone.
 */
const VERTICAL_EXAGGERATION = 5;

/** Elevation-units-per-world-unit to a dimensionless slope, exaggerated. */
const SLOPE_SCALE = (METRES_PER_ELEVATION / METRES_PER_UNIT) * VERTICAL_EXAGGERATION;

/** Light from the north-west, the convention every hand-drawn relief map uses. */
const LIGHT = (() => {
  const v = { x: -0.55, y: -0.6, z: 0.58 };
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
})();

/**
 * Ambient is the floor a fully shadowed face falls to; direct is what a face
 * square to the light adds on top. They are tuned as a pair, and around the
 * constraint that flat ground must come out at very nearly 1 — ground with no
 * slope should be the palette colour, not a shaded version of it.
 *
 * Widening the gap between them (rather than raising both) is what puts the
 * modelling back into a landscape whose palette has been pulled down: the
 * same hills, lit harder, on ground with more room to be darkened.
 */
const AMBIENT = 0.55;
const DIRECT = 0.74;

/**
 * Lambert shading from the local slope, returned as a multiplier on ground
 * colour. `dx`/`dy` are the elevation gradient in elevation-units per world
 * unit.
 *
 * This is the single thing that makes a flat top-down map read as land
 * rather than as a diagram: the eye reconstructs a surface from shading long
 * before it reads any of the symbols drawn on top.
 */
export function hillshade(dx: number, dy: number): number {
  const nx = -dx * SLOPE_SCALE;
  const ny = -dy * SLOPE_SCALE;
  const len = Math.hypot(nx, ny, 1);
  const lambert = (nx * LIGHT.x + ny * LIGHT.y + LIGHT.z) / len;
  return AMBIENT + DIRECT * clamp01(lambert);
}

// ------------------------------------------------------------------- grain

/**
 * Stable hash — the same texel always gets the same fleck.
 *
 * A full murmur3 finalizer rather than the round-and-a-half it is tempting to
 * get away with. Under-mixing leaves neighbouring x values correlated at fixed
 * y, which does not look like weak randomness — it looks like horizontal
 * streaks combed across the whole landscape, because that is exactly what the
 * eye is built to pick out of noise.
 */
function hash2(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y ^ 0x9e3779b9, 0x165667b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise on a lattice of `scale` texels, smoothly interpolated. */
function valueNoise(x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const wx = tx * tx * (3 - 2 * tx);
  const wy = ty * ty * (3 - 2 * ty);

  const v00 = hash2(x0, y0);
  const v10 = hash2(x0 + 1, y0);
  const v01 = hash2(x0, y0 + 1);
  const v11 = hash2(x0 + 1, y0 + 1);

  return (v00 + (v10 - v00) * wx) * (1 - wy) + (v01 + (v11 - v01) * wx) * wy;
}

/**
 * Paper tooth: a per-texel fleck plus a coarser wash, as a signed offset in
 * 0-255 colour units.
 *
 * Small, and doing far more work than its size suggests. Perfectly flat fill
 * is the strongest "this was generated" tell there is — real pigment pools and
 * thins across the tooth of the paper, and two levels of noise is enough for
 * the eye to stop reading the surface as a computed one.
 *
 * The coarse term is interpolated rather than taken from a shifted hash. A
 * shifted hash is constant across each block of texels, which puts a faint
 * checkerboard over the whole map at exactly the scale the eye is best at
 * picking out — a grid reintroduced by the one thing that was supposed to hide
 * the grid.
 */
export function grain(tx: number, ty: number): number {
  return (hash2(tx, ty) - 0.5) * 6 + (valueNoise(tx, ty, 9) - 0.5) * 11;
}
