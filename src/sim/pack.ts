import type { Vec2 } from './geometry';
import type { River } from './river';
import { isRawResource, type RawResource, type TerrainSource } from './source';
import { CELL_SIZE, isWalkableTo, MAX_BRIDGE_SPAN, TerrainType, walkableCellsFrom } from './terrain';
import { ResourceType } from './types';

/**
 * A map pack: a world someone authored, rather than one a seed rolled.
 *
 * The format is deliberately dull. It holds three physical readings per
 * cell, a list of sites, and where the first village stands — and nothing
 * that could be mistaken for a rule. It states no terrain types, no road
 * costs, no resource richness curves, because every one of those is decided
 * by code the procedural generator also runs through (`classifyTerrain`,
 * `makeGeneratedNode`). A pack that could state them would be a second set
 * of rules wearing a data file as a disguise, and the two sets would drift.
 *
 * What a pack *is* allowed to decide is the two things only an author can
 * know: what the ground is actually like at a real place, and what is
 * actually buried there.
 *
 * ## Coordinates
 *
 * A pack is a rectangle whose top-left corner is the world origin. Its size
 * is whatever the raster says it is — there is no separate width/height
 * field to disagree with the row count. Everything outside it is off-map and
 * impassable (see `RasterTerrain`).
 *
 * ## Encodings
 *
 * Two, decoding into the same `PackRaster` so nothing downstream can tell
 * which was used.
 *
 * `legend` is rows of single characters plus a legend giving the readings
 * each character stands for. It is meant to be *typed by a person* — for
 * tests, for trying an idea out, for the fixture this whole path was built
 * against. It cannot carry a real survey: a hundred thousand cells of
 * measured elevation will not survive being squeezed into sixty-odd distinct
 * characters.
 *
 * `raw16` is what `tools/importmap.ts` and `tools/importimage.ts` write. Three channels of Int16,
 * interleaved per cell, in a sidecar `.bin` beside the JSON — elevation,
 * moisture and temperature, each scaled by `RAW16_SCALE`. Int16 gives four
 * decimal places over the whole range of every channel, which is far finer
 * than the source data and an eighth the size of writing the numbers out as
 * JSON text.
 */

export const PACK_FORMAT = 'via-lucrum-map/1';

/** Fixed-point scale for `raw16`. Every channel fits in an Int16 with four decimals to spare. */
export const RAW16_SCALE = 10_000;

/**
 * How far either side of `WATER_LEVEL` an importer puts ground to say which
 * side of the waterline it is on.
 *
 * A pack may not state that a cell is water — it states readings and the
 * classifier decides, which is the rule this whole file exists to enforce —
 * so an importer that knows a cell is a river has exactly one way to say so:
 * put its elevation below the waterline. That is legitimate, and it is the
 * only part of the encoding where a *measurement* gets overridden by
 * something the importer knows from another source, so it wants stating here
 * rather than being picked separately by each tool.
 *
 * It was picked separately by each tool, and both picked far too much:
 * `importmap.ts` used a step of 0.30 and `importimage.ts` 0.32, which at
 * `METRES_PER_ELEVATION` is a hundred-and-twenty-metre cliff around every
 * pond. Nothing in the simulation noticed, because nothing reads slope yet.
 * The renderer noticed at once — it antialiases the coast by dividing height
 * above the waterline by the local gradient, and against a cliff that
 * gradient is enormous, so the blend collapsed and the shoreline came out as
 * a staircase on cell boundaries.
 *
 * The step only has to survive `RAW16_SCALE` quantisation and leave the
 * classifier's answer unambiguous either side. A twentieth of what was there
 * does both, and leaves a lake edge reading as a bank rather than an
 * escarpment.
 */
export const WATER_SIGNAL_STEP = 0.04;

/**
 * The decoded ground, as three parallel channels rather than a cell object
 * each. A region a few kilometres across is a hundred thousand cells, and a
 * hundred thousand small objects is real memory for no benefit — nothing
 * ever wants a cell's readings as a *thing*, only as three numbers on the
 * way into `classifyTerrain`.
 */
export interface PackRaster {
  cols: number;
  rows: number;
  elevation: Float32Array;
  moisture: Float32Array;
  temperature: Float32Array;
}

/** One cell of ground, as physical readings. Deliberately the exact inputs `classifyTerrain` takes. */
export interface PackReadings {
  /** -1 (seabed) to 1 (peak). Below `WATER_LEVEL` is water — see `terrain.ts`. */
  elevation: number;
  /** 0 (arid) to 1 (sodden). */
  moisture: number;
  /** 0 (cold) to 1 (warm). */
  temperature: number;
}

export interface PackNodeSpec {
  name: string;
  resource: RawResource;
  x: number;
  y: number;
  /** ~0.7 (poor) to ~1.7 (exceptional); 1.0 is ordinary ground. Optional, defaults to 1. */
  richness?: number;
}

/** Hand-typed ground: one character per cell, plus what each character means. */
export interface LegendTerrain {
  encoding: 'legend';
  legend: Record<string, PackReadings>;
  rows: string[];
}

/** Surveyed ground: three Int16 channels per cell, interleaved, in a sidecar file. */
export interface Raw16Terrain {
  encoding: 'raw16';
  cols: number;
  rows: number;
  /** Filename of the `.bin`, resolved beside the JSON by whoever is loading. */
  data: string;
}

/** The JSON on disk. */
export interface PackFile {
  format: string;
  name: string;
  /** Where the readings came from, and under what licence. Free text; never read by the game. */
  source?: string;
  cellSize?: number;
  /**
   * How many real metres one world unit stands for. Recorded so an imported
   * map can always be traced back to the ground it came from, and so two
   * imports can be compared. The simulation itself never reads it — every
   * distance in the game is in world units and always has been — but it is
   * the number that decides whether a village footprint reads as a parish or
   * a county, so losing it would make an import unreproducible.
   */
  metresPerUnit?: number;
  village: { name: string; x: number; y: number };
  startingPopulation?: number;
  /** Reproducibility for everything that is random but not generation — see `WorldConfig.seed`. */
  seed?: number;
  terrain: LegendTerrain | Raw16Terrain;
  nodes: PackNodeSpec[];
  /**
   * Watercourses, as lines. Optional: a pack written before rivers existed
   * simply has none, and a hand-typed legend map is not expected to draw any.
   */
  rivers?: PackRiverSpec[];
}

/**
 * One watercourse: a centreline and how wide the water is along it.
 *
 * In world units like every other geometry a pack states, not metres — the
 * importer does that conversion, exactly as it already does for the village
 * and every site. The simulation has never held a distance in metres and this
 * is not the place to start.
 *
 * This is a *reading*, not a rule, which is what makes it allowed here at all
 * (see the note at the top of this file). "There is a river here and it is
 * five metres across" is a measurement of a real place, in the same category
 * as its elevation. What that river costs a road to cross stays in code, in
 * `BRIDGE_COST` and `RiverNetwork`, where a pack cannot reach it.
 */
export interface PackRiverSpec {
  name?: string;
  /** Centreline, world units, at least two points. */
  points: Array<{ x: number; y: number }>;
  /**
   * Water width at each point, world units, one per point. A single figure
   * would have to be wrong at one end: the same brook is a step across at its
   * head and a bridge-worth at the town.
   */
  widths: number[];
}

/** A pack that has been parsed and checked, ready to build a world from. */
export interface MapPack {
  name: string;
  source: string | null;
  cellSize: number;
  cols: number;
  rows: number;
  /** World units. Derived from the raster; never stated twice. */
  width: number;
  height: number;
  /** Real metres per world unit, or null for a map that does not stand for anywhere. */
  metresPerUnit: number | null;
  village: { name: string; x: number; y: number };
  startingPopulation: number;
  seed: number;
  raster: PackRaster;
  nodes: PackNodeSpec[];
  rivers: River[];
}

export class PackError extends Error {}

// ------------------------------------------------------------------ parsing

/**
 * Parse and check a pack. Throws `PackError` with every problem it found
 * rather than the first — an author fixing a hand-written map wants the
 * whole list, not one round trip per typo.
 *
 * This is where a pack earns the right to be trusted. Everything downstream
 * (`RasterTerrain`, `PackNodes`) is written assuming the pack is coherent,
 * which is only safe because nothing else can construct one.
 *
 * `binary` is the contents of the sidecar file a `raw16` pack names in
 * `terrain.data`. Reading it is the loader's job, not this function's —
 * fetching in a browser and reading from disk in a build tool are different
 * enough that pushing either in here would make parsing environment-specific
 * for no gain.
 */
export function parseMapPack(raw: unknown, binary?: Uint8Array): MapPack {
  const problems: string[] = [];
  const fail = (message: string): never => {
    problems.push(message);
    throw new PackError(problems.join('\n'));
  };

  if (typeof raw !== 'object' || raw === null) fail('pack is not an object');
  const file = raw as PackFile;

  if (file.format !== PACK_FORMAT) {
    fail(`unknown format ${JSON.stringify(file.format)} (expected ${JSON.stringify(PACK_FORMAT)})`);
  }
  if (typeof file.name !== 'string' || file.name.length === 0) fail('pack needs a name');

  const cellSize = file.cellSize ?? CELL_SIZE;
  if (!Number.isFinite(cellSize) || cellSize <= 0) fail(`cellSize must be a positive number, got ${cellSize}`);

  const raster =
    file.terrain?.encoding === 'raw16'
      ? decodeRaw16(file.terrain, binary, problems, fail)
      : decodeLegend(file.terrain, problems, fail);

  const { cols, rows } = raster;
  const width = cols * cellSize;
  const height = rows * cellSize;

  if (!file.village || typeof file.village.name !== 'string') problems.push('village needs a name');
  const village = {
    name: file.village?.name ?? 'Village',
    x: file.village?.x ?? 0,
    y: file.village?.y ?? 0,
  };
  if (!inRange(village.x, 0, width) || !inRange(village.y, 0, height)) {
    problems.push(`village at (${village.x}, ${village.y}) is outside the map (${width} x ${height})`);
  }

  const nodes: PackNodeSpec[] = [];
  const seenNames = new Set<string>();
  const specs = Array.isArray(file.nodes) ? file.nodes : [];
  specs.forEach((spec, i) => {
    const where = `nodes[${i}]${spec?.name ? ` (${spec.name})` : ''}`;
    if (typeof spec?.name !== 'string' || spec.name.length === 0) problems.push(`${where}: needs a name`);
    else if (seenNames.has(spec.name)) problems.push(`${where}: duplicate name`);
    else seenNames.add(spec.name);

    if (typeof spec?.resource !== 'string' || !isRawResource(spec.resource)) {
      problems.push(`${where}: resource must be one of wood, stone, iron, food (got ${JSON.stringify(spec?.resource)})`);
    }
    if (!inRange(spec?.x, 0, width) || !inRange(spec?.y, 0, height)) {
      problems.push(`${where}: at (${spec?.x}, ${spec?.y}), outside the map (${width} x ${height})`);
    }
    if (spec?.richness !== undefined && !inRange(spec.richness, 0.1, 3)) {
      problems.push(`${where}: richness must be 0.1..3`);
    }
    nodes.push({ ...spec, richness: spec?.richness ?? 1 });
  });

  const rivers: River[] = [];
  for (const [index, spec] of (file.rivers ?? []).entries()) {
    const where = `river ${index}${spec?.name ? ` ("${spec.name}")` : ''}`;
    if (!Array.isArray(spec?.points) || spec.points.length < 2) {
      problems.push(`${where}: needs at least two points`);
      continue;
    }
    if (!Array.isArray(spec.widths) || spec.widths.length !== spec.points.length) {
      problems.push(`${where}: needs one width per point (${spec.points.length} points, ${spec.widths?.length ?? 0} widths)`);
      continue;
    }
    if (spec.points.some((q) => !Number.isFinite(q?.x) || !Number.isFinite(q?.y))) {
      problems.push(`${where}: every point needs finite x and y`);
      continue;
    }
    if (spec.widths.some((wd) => !Number.isFinite(wd) || wd <= 0)) {
      problems.push(`${where}: every width must be a positive number of world units`);
      continue;
    }
    rivers.push({
      name: spec.name ?? null,
      points: spec.points.map((q) => ({ x: q.x, y: q.y })),
      widths: [...spec.widths],
    });
  }

  if (problems.length > 0) throw new PackError(problems.join('\n'));

  return {
    name: file.name,
    source: file.source ?? null,
    cellSize,
    cols,
    rows,
    width,
    height,
    metresPerUnit: file.metresPerUnit ?? null,
    village,
    startingPopulation: file.startingPopulation ?? 5,
    seed: file.seed ?? 1,
    raster,
    nodes,
    rivers,
  };
}

/** One character per cell, so a row reads on screen the way the ground it describes is laid out. */
function decodeLegend(
  terrain: LegendTerrain | Raw16Terrain | undefined,
  problems: string[],
  fail: (message: string) => never,
): PackRaster {
  if (!terrain || terrain.encoding !== 'legend') {
    fail(`terrain.encoding must be "legend" or "raw16" (got ${JSON.stringify((terrain as { encoding?: string })?.encoding)})`);
  }
  const { legend, rows: rowStrings } = terrain as LegendTerrain;
  if (!Array.isArray(rowStrings) || rowStrings.length === 0) fail('terrain.rows is empty');

  const rows = rowStrings.length;
  const cols = rowStrings[0].length;
  if (cols === 0) fail('terrain.rows[0] is empty');
  rowStrings.forEach((row, i) => {
    if (row.length !== cols) problems.push(`terrain.rows[${i}] is ${row.length} cells, expected ${cols}`);
  });

  for (const [ch, entry] of Object.entries(legend ?? {})) {
    if (!inRange(entry?.elevation, -1, 1)) problems.push(`legend ${JSON.stringify(ch)}: elevation must be -1..1`);
    if (!inRange(entry?.moisture, 0, 1)) problems.push(`legend ${JSON.stringify(ch)}: moisture must be 0..1`);
    if (!inRange(entry?.temperature, 0, 1)) problems.push(`legend ${JSON.stringify(ch)}: temperature must be 0..1`);
  }

  const raster = emptyRaster(cols, rows);
  const unknownChars = new Set<string>();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < Math.min(cols, rowStrings[row].length); col++) {
      const ch = rowStrings[row][col];
      const entry = legend?.[ch];
      if (!entry) {
        unknownChars.add(ch);
        continue;
      }
      const i = row * cols + col;
      raster.elevation[i] = entry.elevation;
      raster.moisture[i] = entry.moisture;
      raster.temperature[i] = entry.temperature;
    }
  }
  for (const ch of unknownChars) problems.push(`terrain uses ${JSON.stringify(ch)}, which the legend does not define`);

  return raster;
}

/** Three Int16 channels per cell, interleaved, straight out of `tools/importmap.ts`. */
function decodeRaw16(
  terrain: Raw16Terrain,
  binary: Uint8Array | undefined,
  problems: string[],
  fail: (message: string) => never,
): PackRaster {
  const { cols, rows } = terrain;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    fail(`terrain.cols/rows must be positive integers, got ${cols} x ${rows}`);
  }
  if (typeof terrain.data !== 'string' || terrain.data.length === 0) fail('terrain.data must name the .bin file');
  if (!binary) fail(`terrain.data is "${terrain.data}" but its contents were not supplied to parseMapPack`);

  const expected = cols * rows * 3 * 2;
  if (binary.byteLength !== expected) {
    problems.push(`${terrain.data} is ${binary.byteLength} bytes, expected ${expected} for ${cols} x ${rows} cells`);
    return emptyRaster(cols, rows);
  }

  // A fresh copy of the bytes, so the view is aligned and never shares a
  // buffer with whatever read the file.
  const view = new Int16Array(binary.slice().buffer);
  const raster = emptyRaster(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    raster.elevation[i] = view[i * 3] / RAW16_SCALE;
    raster.moisture[i] = view[i * 3 + 1] / RAW16_SCALE;
    raster.temperature[i] = view[i * 3 + 2] / RAW16_SCALE;
  }
  return raster;
}

function emptyRaster(cols: number, rows: number): PackRaster {
  return {
    cols,
    rows,
    elevation: new Float32Array(cols * rows),
    moisture: new Float32Array(cols * rows),
    temperature: new Float32Array(cols * rows),
  };
}

function inRange(value: unknown, lo: number, hi: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
}

// --------------------------------------------------------------- viability

/**
 * Whether a pack can actually be played, as opposed to merely parsed.
 *
 * A procedural world gets this for free: `ensureStartingResources` forces
 * food and timber into place when a seed failed to provide them, because a
 * village that cannot eat is not a hard game, it is a dead one. An authored
 * map has no such safety net *by design* — the author placed the sites, and
 * quietly conjuring extra ones would make the map a suggestion rather than a
 * record of a real place.
 *
 * So the safety net moves from generation to load time, and changes from
 * "fix it" to "refuse it, and say exactly what is wrong". These are the same
 * two things the procedural guarantee checks, for the same reasons, and they
 * are checked the same way — including walkability, because a farm across a
 * lake is a farm nobody will ever reach.
 *
 * Returns a list of complaints, empty if the map is fine.
 */
export function packViability(pack: MapPack, terrain: TerrainSource, reach: number): string[] {
  const problems: string[] = [];
  const centre: Vec2 = { x: pack.village.x, y: pack.village.y };

  if (!terrain.isPassable(centre)) {
    problems.push(`village "${pack.village.name}" stands on ${terrain.typeAt(centre)} — nothing could walk out of it`);
  }

  // A road may bridge a river, so "can the village get there" has to ask the
  // routing question and not the wading one — otherwise a map is refused for
  // putting a farm across a stream any road would cross without comment.
  const bridgeable = Math.ceil(MAX_BRIDGE_SPAN / terrain.cellSize);
  const walkable = walkableCellsFrom(terrain, centre, reach, bridgeable);
  const withinReach = (spec: PackNodeSpec): boolean =>
    Math.hypot(spec.x - centre.x, spec.y - centre.y) <= reach &&
    isWalkableTo(terrain, centre, reach, walkable, { x: spec.x, y: spec.y });

  // Two food and one wood, matching the procedural guarantee exactly — see
  // `WorldGenerator.ensureStartingResources` for why it is two and not one.
  const needed: Array<[RawResource, number]> = [
    [ResourceType.Food, 2],
    [ResourceType.Wood, 1],
  ];
  for (const [resource, count] of needed) {
    const have = pack.nodes.filter((n) => n.resource === resource && withinReach(n)).length;
    if (have < count) {
      problems.push(
        `only ${have} ${resource} site(s) within ${reach}u of the village and reachable on foot; needs ${count}`,
      );
    }
  }

  for (const spec of pack.nodes) {
    if (terrain.typeAt({ x: spec.x, y: spec.y }) === TerrainType.Water) {
      problems.push(`"${spec.name}" stands in water — no road can ever reach it`);
    }
  }

  return problems;
}

