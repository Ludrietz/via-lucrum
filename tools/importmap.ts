import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PACK_FORMAT, RAW16_SCALE, WATER_SIGNAL_STEP, type PackFile, type PackNodeSpec } from '../src/sim/pack';
import { MIN_NODE_DISTANCE, type RawResource } from '../src/sim/source';
import { ResourceType } from '../src/sim/types';
import { METRES_PER_ELEVATION, METRES_PER_UNIT } from '../src/sim/scale';
import { HILLS_LEVEL, MOUNTAIN_LEVEL, WATER_LEVEL } from '../src/sim/terrain';
import { WALK_SPEED } from '../src/sim/villager';
import { decodePng } from './png';

/**
 * Turn a rectangle of the real world into a map pack.
 *
 * Run offline, output checked in. The game never fetches anything; this does
 * the fetching once, on a machine with a person watching, and writes a file.
 *
 *   node tools/.build/importmap.mjs --span 34 --out kuttenberg --name Kuttenberg \
 *     --village 49.948,15.268 --village-at 0.80,0.78 --max-nodes 160
 *
 * ## What it reads
 *
 * - **Elevation** from the public Terrarium tiles (Mapzen/AWS, 30m-ish
 *   Copernicus/SRTM underneath), decoded by `png.ts`.
 * - **Land cover, water and settlements** from OpenStreetMap via Overpass.
 *
 * Both are free and open, and both are the *same* sources for anywhere on
 * Earth — which is the whole reason to build the importer around real data
 * rather than around one game's map. Kuttenberg and a future Earth map are
 * this tool run twice with different arguments.
 *
 * ## What it decides, and what it refuses to decide
 *
 * It translates measurements into the three readings `classifyTerrain`
 * takes, and stops. It never writes a terrain type, never writes a road
 * cost, never invents a resource site that is not standing on something OSM
 * actually records. See the note at the top of `pack.ts` for why that line
 * is where it is.
 *
 * The one genuinely arbitrary choice is `--relief`, and it is arbitrary
 * because the game's elevation band is a gameplay scale, not an altitude:
 * "mountains" means "ground a road hates", not "above 2000m". See
 * `RELIEF_DEFAULT`.
 */

// --------------------------------------------------------------- parameters


/**
 * Real metres one world unit stands for.
 *
 * Defaults to the scale the simulation itself is built at, rather than a
 * number of its own — an import at any other setting is a deliberate choice
 * to stretch or squash the world relative to how fast people walk and how far
 * a village reaches. See the scale report at the end of a run.
 */
const METRES_PER_UNIT_DEFAULT = METRES_PER_UNIT;

/** World units per terrain cell. 32 is what the procedural world uses. */
const CELL_SIZE_DEFAULT = 32;

/** Sim elevation given to open water — just below `WATER_LEVEL`. */
const WATER_ELEVATION = WATER_LEVEL - WATER_SIGNAL_STEP;
/** Sim elevation the lowest land maps to — just above `WATER_LEVEL`, so a valley floor is not a lake. */
const LAND_FLOOR = WATER_LEVEL + WATER_SIGNAL_STEP;

/**
 * Moisture per land-cover class, and with it everything moisture drives:
 * which of forest or plains the classifier picks, how fertile the ground is,
 * how wooded, how rocky. This table *is* the translation from "OSM says
 * this is a wood" to "the game understands this as a wood" — the alternative
 * being to write the terrain type directly, which `pack.ts` explains at
 * length is not allowed.
 */
const COVER_MOISTURE: Record<Cover, number> = {
  water: 1.0,
  forest: 0.78,
  farmland: 0.4,
  bare: 0.34,
};

/** How much colder it gets per 1000m of altitude, in the game's 0-1 temperature scale. */
const LAPSE_PER_KM = 0.15;

/** Terrarium tiles are 256px; this is the standard web-mercator ground resolution at zoom 0. */
const EQUATOR_METRES_PER_PIXEL = 156_543.03392;
const DEM_TILE_SIZE = 256;
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'via-lucrum-importmap/1.0 (map import for a simulation prototype)';

/** How wide a river is taken to be when OSM records it only as a line, in metres. */
const RIVER_WIDTH = 24;

/**
 * How much of a cell a river has to fill before that cell counts as water.
 *
 * The first import painted every `waterway=river` as impassable water a full
 * cell wide, and it quietly killed the map. At the default resolution a cell
 * is 128m across, the Vrchlice below Kutná Hora is about 24m, and the
 * surveyor keeps one cell of clearance from any water — so a creek a person
 * could wade turned into a 384m corridor no road could cross. 1.5% of the
 * region was water and 7.8% of it was closed to roads. The founding woodlot
 * landed inside that margin, the village could never reach timber, and the
 * civilisation died on day 21 of a map with sixty-three woods on it.
 *
 * A stream narrower than half a cell is simply not resolvable at this scale,
 * and pretending otherwise overstates the obstacle enormously: medieval roads
 * forded small water constantly, and the valley is where they *ran*. So
 * narrow water leaves the land beneath it alone, and only water that really
 * does fill a cell — a lake, a pond, a wide river — becomes water. Import at
 * a finer `--metres-per-unit` and more of the real drainage appears, which is
 * the correct relationship between resolution and detail.
 */
const RIVER_CELL_SHARE = 0.5;

/**
 * Metres of local relief that fill the game's whole land elevation band.
 *
 * This is the knob that decides whether a region reads as rolling farmland or
 * as an alpine wall. It is no longer a free number: it is what the band is
 * worth at the scale the simulation states (`METRES_PER_ELEVATION`), so an
 * import at the default cannot disagree with the game about how tall a hill
 * is. Overriding `--relief` is then an explicit decision to stretch or squash
 * a region's relief relative to everything else, which is the same shape of
 * choice `--metres-per-unit` offers horizontally.
 *
 * It comes out at 500m, which is where it was set by hand — chosen so
 * temperate European country reads the way it looks: the Kuttenberg region
 * spans roughly 200-470m, which puts the town and its fields in the lowlands,
 * the wooded ridges into hills, and nothing at all into mountains. That the
 * hand-picked figure and the derived one agree is the same happy accident the
 * horizontal scale turned out to be.
 */
const RELIEF_DEFAULT = Math.round(METRES_PER_ELEVATION * (1 - LAND_FLOOR));

/**
 * How big a district is, for spreading sites out across the map rather than
 * pooling them wherever the biggest features happen to be. Roughly the
 * opening resource reach (850u), so "every district gets served" means
 * something close to "nowhere a village could stand is more than a district
 * away from each trade".
 */
const DISTRICT_SIZE = 1000;

/** Most sites a single import will place, shared out fairly between trades and districts. */
const MAX_NODES_DEFAULT = 80;

type Cover = 'water' | 'forest' | 'farmland' | 'bare';

// --------------------------------------------------------------------- args

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pair(value: string, what: string): { lat: number; lon: number } {
  const [lat, lon] = value.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`--${what} must be "lat,lon", got ${value}`);
  return { lat, lon };
}

const spanArg = arg('span', '12');
const outId = arg('out', 'imported');
const outName = arg('name', outId);
const metresPerUnit = Number(arg('metres-per-unit', String(METRES_PER_UNIT_DEFAULT)));
const cellSize = Number(arg('cell', String(CELL_SIZE_DEFAULT)));
const relief = Number(arg('relief', String(RELIEF_DEFAULT)));
const maxNodes = Number(arg('max-nodes', String(MAX_NODES_DEFAULT)));
const villageArg = arg('village', '');
const villageAtArg = arg('village-at', '');
const includeRivers = !process.argv.includes('--no-rivers');
const seed = Number(arg('seed', '1'));
const startingPopulation = Number(arg('population', '5'));

// ---------------------------------------------------------------- geography

/**
 * A local flat projection, metres from the centre of the import.
 *
 * Over ten or twenty kilometres the error in treating latitude and longitude
 * as a plane is centimetres, so nothing here needs a real projection library.
 * At fifty kilometres it is a few metres, still well under one cell. North is
 * -y, matching both screen coordinates and the game's world.
 */
const METRES_PER_DEG_LAT = 111_320;

/** `--span 30` is a 30km square; `--span 40,25` is 40km east-west by 25km north-south. */
const [spanKmX, spanKmY = spanKmX] = spanArg.split(',').map(Number);
if (!Number.isFinite(spanKmX) || !Number.isFinite(spanKmY) || spanKmX <= 0 || spanKmY <= 0) {
  throw new Error(`--span must be "KM" or "KM,KM", got ${spanArg}`);
}

const spanMetresX = spanKmX * 1000;
const spanMetresY = spanKmY * 1000;
const metresPerCell = metresPerUnit * cellSize;
const cols = Math.max(1, Math.round(spanMetresX / metresPerCell));
const rows = Math.max(1, Math.round(spanMetresY / metresPerCell));
const width = cols * cellSize;
const height = rows * cellSize;

/**
 * Where the rectangle sits.
 *
 * The obvious way to say it is `--centre`, and that is still here — but it is
 * the wrong way round for how these maps are actually wanted. A region is
 * chosen *for* a place ("the country around Kuttenberg"), and where that
 * place should sit on the finished map is a composition decision: dead
 * centre gives an evenly balanced sandbox, a corner gives a realm with its
 * back to one edge and everything to explore in one direction.
 *
 * So `--village-at fx,fy` places the named village at a fraction of the map
 * and derives the centre from it. `--village 49.948,15.268 --village-at
 * 0.78,0.76 --span 34` means "Kuttenberg, down in the bottom-right, with
 * thirty-four kilometres of Bohemia opening away to the north and west".
 */
function resolveCentre(): { lat: number; lon: number } {
  const explicit = arg('centre', '');
  if (!villageAtArg) return pair(explicit || '49.948,15.268', 'centre');
  if (!villageArg) throw new Error('--village-at needs --village lat,lon to place');

  const at = pair(villageArg, 'village');
  const [fx, fy] = villageAtArg.split(',').map(Number);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
    throw new Error(`--village-at must be "fx,fy" in 0..1, got ${villageAtArg}`);
  }

  // Latitude first: it depends on nothing else. Longitude then uses that
  // latitude for its metres-per-degree, which is what makes the rectangle
  // come out the width it was asked for.
  const lat = at.lat + (spanMetresY / METRES_PER_DEG_LAT) * (fy - 0.5);
  const lon = at.lon - (spanMetresX / (METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))) * (fx - 0.5);
  return { lat, lon };
}

const centre = resolveCentre();
const metresPerDegLon = METRES_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180);

const bbox = {
  south: centre.lat - spanMetresY / 2 / METRES_PER_DEG_LAT,
  west: centre.lon - spanMetresX / 2 / metresPerDegLon,
  north: centre.lat + spanMetresY / 2 / METRES_PER_DEG_LAT,
  east: centre.lon + spanMetresX / 2 / metresPerDegLon,
};

/** Where a point on Earth lands in world units. */
function project(lat: number, lon: number): { x: number; y: number } {
  return {
    x: ((lon - bbox.west) * metresPerDegLon) / metresPerUnit,
    y: ((bbox.north - lat) * METRES_PER_DEG_LAT) / metresPerUnit,
  };
}

/** The centre of cell (col,row), back in degrees — for sampling the DEM. */
function unproject(col: number, row: number): { lat: number; lon: number } {
  return {
    lat: bbox.north - ((row + 0.5) * metresPerCell) / METRES_PER_DEG_LAT,
    lon: bbox.west + ((col + 0.5) * metresPerCell) / metresPerDegLon,
  };
}

// ---------------------------------------------------------------------- DEM

/** The coarsest zoom whose pixels are still finer than one of our cells — no point fetching more. */
function chooseZoom(): number {
  const wanted = metresPerCell;
  for (let z = 6; z <= 14; z++) {
    const resolution = (EQUATOR_METRES_PER_PIXEL * Math.cos((centre.lat * Math.PI) / 180)) / 2 ** z;
    if (resolution <= wanted) return z;
  }
  return 14;
}

const lonToTileX = (lon: number, z: number): number => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat: number, z: number): number => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

interface Dem {
  zoom: number;
  x0: number;
  y0: number;
  tilesX: number;
  tilesY: number;
  /** Metres, row-major over the whole mosaic. */
  height: Float32Array;
  pixelsX: number;
  pixelsY: number;
}

async function fetchDem(): Promise<Dem> {
  const zoom = chooseZoom();
  const x0 = Math.floor(lonToTileX(bbox.west, zoom));
  const x1 = Math.floor(lonToTileX(bbox.east, zoom));
  const y0 = Math.floor(latToTileY(bbox.north, zoom));
  const y1 = Math.floor(latToTileY(bbox.south, zoom));
  const tilesX = x1 - x0 + 1;
  const tilesY = y1 - y0 + 1;

  const pixelsX = tilesX * DEM_TILE_SIZE;
  const pixelsY = tilesY * DEM_TILE_SIZE;
  const heights = new Float32Array(pixelsX * pixelsY);

  process.stdout.write(`elevation: zoom ${zoom}, ${tilesX}x${tilesY} tiles `);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const url = `${DEM_URL}/${zoom}/${x0 + tx}/${y0 + ty}.png`;
      const png = await withRetry(`tile ${x0 + tx}/${y0 + ty}`, async () => {
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) throw new Error(`elevation tile -> HTTP ${response.status}`);
        return decodePng(new Uint8Array(await response.arrayBuffer()));
      });

      for (let py = 0; py < DEM_TILE_SIZE; py++) {
        for (let px = 0; px < DEM_TILE_SIZE; px++) {
          const i = (py * png.width + px) * 4;
          // Terrarium encoding: height in metres = R*256 + G + B/256 - 32768.
          const metres = png.pixels[i] * 256 + png.pixels[i + 1] + png.pixels[i + 2] / 256 - 32768;
          heights[(ty * DEM_TILE_SIZE + py) * pixelsX + (tx * DEM_TILE_SIZE + px)] = metres;
        }
      }
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');

  return { zoom, x0, y0, tilesX, tilesY, height: heights, pixelsX, pixelsY };
}

/** Bilinear, so a cell coarser than the DEM does not read one arbitrary pixel out of nine. */
function sampleDem(dem: Dem, lat: number, lon: number): number {
  const fx = (lonToTileX(lon, dem.zoom) - dem.x0) * DEM_TILE_SIZE;
  const fy = (latToTileY(lat, dem.zoom) - dem.y0) * DEM_TILE_SIZE;
  const x0 = Math.max(0, Math.min(dem.pixelsX - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(dem.pixelsY - 1, Math.floor(fy)));
  const x1 = Math.min(dem.pixelsX - 1, x0 + 1);
  const y1 = Math.min(dem.pixelsY - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const h = (x: number, y: number) => dem.height[y * dem.pixelsX + x];
  const top = h(x0, y0) * (1 - tx) + h(x1, y0) * tx;
  const bottom = h(x0, y1) * (1 - tx) + h(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

// ----------------------------------------------------------------- OSM

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{ role: string; geometry?: Array<{ lat: number; lon: number }> }>;
}

async function fetchOsm(): Promise<OsmElement[]> {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `[out:json][timeout:300];
(
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["waterway"="riverbank"](${b});
  ${includeRivers ? `way["waterway"="river"](${b});` : ''}
  way["landuse"~"^(forest|forestry)$"](${b});
  way["natural"="wood"](${b});
  relation["landuse"="forest"](${b});
  relation["natural"="wood"](${b});
  way["landuse"~"^(farmland|meadow|orchard|vineyard)$"](${b});
  way["landuse"="quarry"](${b});
  way["man_made"~"^(quarry|spoil_heap)$"](${b});
  way["natural"~"^(cliff|bare_rock|rock)$"](${b});
  node["natural"~"^(cliff|bare_rock|rock)$"](${b});
  node["man_made"~"^(mineshaft|adit)$"](${b});
  way["man_made"~"^(mineshaft|adit)$"](${b});
  node["historic"~"^(mine|mine_shaft|mine_adit)$"](${b});
  way["historic"~"^(mine|mine_shaft|mine_adit)$"](${b});
  node["place"~"^(city|town|village|hamlet)$"](${b});
);
out geom;`;

  // Iterating on how the data is *translated* should not mean re-downloading
  // the data. Overpass is a shared free service and a 34km query is a heavy
  // one for it — the first few passes over this importer got progressively
  // slower and then started failing outright, which is the service correctly
  // objecting to being used as a scratchpad. The cache is keyed by the exact
  // query, so changing the region or the tags fetches afresh; delete
  // `tools/.cache` to force a refresh of the same query.
  const cacheKey = createHash('sha1').update(query).digest('hex').slice(0, 16);
  const cachePath = `tools/.cache/osm-${cacheKey}.json`;
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { elements: OsmElement[] };
    console.log(`openstreetmap: ${cached.elements.length} elements (cached)`);
    return cached.elements;
  }

  process.stdout.write('openstreetmap: querying overpass ');
  // Overpass is a free service with a per-IP quota, and it answers an
  // over-quota request with a 429 or a 504 and an HTML page. Backing off and
  // trying again is the documented, polite thing to do; failing the whole
  // import over it would mean re-fetching the elevation tiles as well.
  const body = await withRetry('overpass', async () => {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
      body: query,
    });
    const text = await response.text();
    if (!response.ok || !text.startsWith('{')) {
      const detail = text.includes('rate_limited') ? 'rate limited' : `HTTP ${response.status}`;
      throw new Error(`overpass refused the query (${detail})`);
    }
    return JSON.parse(text) as { elements: OsmElement[] };
  });

  console.log(` ${body.elements.length} elements`);
  mkdirSync('tools/.cache', { recursive: true });
  writeFileSync(cachePath, JSON.stringify(body));
  return body.elements;
}

/** Try, then wait longer and try again. Public data services ask for exactly this. */
async function withRetry<T>(what: string, attempt: () => Promise<T>, tries = 5): Promise<T> {
  let wait = 8000;
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= tries) throw error;
      process.stdout.write(`\n  ${what}: ${(error as Error).message} — retrying in ${wait / 1000}s `);
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait *= 2;
    }
  }
}

/**
 * Every closed ring an element contributes, in world units.
 *
 * Multipolygon relations are flattened to their outer members and inner
 * holes are ignored — a lake with an island in it becomes a lake. At the
 * scale one cell covers (a hundred-odd metres on a side by default) that is
 * below the resolution of the result anyway, and carrying proper hole
 * handling would be the most complicated thing in this file for no visible
 * difference.
 */
function ringsOf(element: OsmElement): Array<Array<{ x: number; y: number }>> {
  const rings: Array<Array<{ x: number; y: number }>> = [];
  const add = (geometry?: Array<{ lat: number; lon: number }>) => {
    if (!geometry || geometry.length < 3) return;
    rings.push(geometry.map((p) => project(p.lat, p.lon)));
  };

  if (element.type === 'way') add(element.geometry);
  else if (element.type === 'relation') {
    for (const member of element.members ?? []) {
      if (member.role === 'inner') continue;
      add(member.geometry);
    }
  }
  return rings;
}

function coverOf(tags: Record<string, string> | undefined): Cover | null {
  if (!tags) return null;
  if (tags.natural === 'water' || tags.waterway === 'riverbank') return 'water';
  if (tags.landuse === 'forest' || tags.landuse === 'forestry' || tags.natural === 'wood') return 'forest';
  if (['farmland', 'meadow', 'orchard', 'vineyard'].includes(tags.landuse ?? '')) return 'farmland';
  return null;
}

// --------------------------------------------------------- rasterising cover

/** Even-odd scanline fill of one ring into the cover grid, at cell resolution. */
function fillRing(cover: Uint8Array, ring: Array<{ x: number; y: number }>, value: number): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const row0 = Math.max(0, Math.floor(minY / cellSize));
  const row1 = Math.min(rows - 1, Math.floor(maxY / cellSize));

  for (let row = row0; row <= row1; row++) {
    const y = (row + 0.5) * cellSize;
    const crossings: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a.y === b.y) continue;
      if (y < Math.min(a.y, b.y) || y >= Math.max(a.y, b.y)) continue;
      crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const col0 = Math.max(0, Math.ceil(crossings[i] / cellSize - 0.5));
      const col1 = Math.min(cols - 1, Math.floor(crossings[i + 1] / cellSize - 0.5));
      for (let col = col0; col <= col1; col++) cover[row * cols + col] = value;
    }
  }
}

/** A river recorded as a line, widened into the water it actually is. */
function fillLine(cover: Uint8Array, line: Array<{ x: number; y: number }>, metres: number, value: number): void {
  const radius = metres / 2 / metresPerUnit;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cellSize / 2)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const span = Math.ceil(radius / cellSize);
      const col0 = Math.floor(x / cellSize);
      const row0 = Math.floor(y / cellSize);
      for (let dr = -span; dr <= span; dr++) {
        for (let dc = -span; dc <= span; dc++) {
          const col = col0 + dc;
          const row = row0 + dr;
          if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
          const cx = (col + 0.5) * cellSize;
          const cy = (row + 0.5) * cellSize;
          if (Math.hypot(cx - x, cy - y) <= radius) cover[row * cols + col] = value;
        }
      }
    }
  }
}

const COVER_ORDER: Cover[] = ['bare', 'farmland', 'forest', 'water'];

// --------------------------------------------------------------------- sites

interface Candidate {
  name: string | null;
  resource: RawResource;
  x: number;
  y: number;
  /** Square metres, used both to rank candidates and to set richness. */
  area: number;
}

/** Shoelace area of a ring, in square metres. */
function ringArea(ring: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return (Math.abs(sum) / 2) * metresPerUnit * metresPerUnit;
}

function centroid(ring: Array<{ x: number; y: number }>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

/**
 * What a site is worth, from how big the feature is.
 *
 * A twenty-hectare wood is a better woodlot than a two-hectare one, and
 * that is about as much as the source data can honestly tell us. Kept inside
 * the same 0.7-1.7 band the procedural generator uses, and deliberately
 * compressive (a cube root) so one enormous forest does not end up four
 * times the value of everything else on the map.
 */
function richnessFor(area: number): number {
  const hectares = area / 10_000;
  return Math.max(0.7, Math.min(1.7, 0.7 + Math.cbrt(hectares / 40)));
}

function resourceFor(tags: Record<string, string>): RawResource | null {
  // Mines first: a shaft sunk in a wood is a mine, not a woodlot.
  if (tags.man_made === 'mineshaft' || tags.man_made === 'adit') return ResourceType.Iron;
  if (tags.historic?.startsWith('mine')) return ResourceType.Iron;

  // Stone comes from workings *and* from exposed rock. Medieval quarrying was
  // mostly small, local and long since grassed over, so the one modern quarry
  // OSM records near a town is a bad proxy on its own — an outcrop or a cliff
  // is where the stone was actually got, and OSM does record those.
  if (tags.landuse === 'quarry' || tags.man_made === 'quarry' || tags.man_made === 'spoil_heap') {
    return ResourceType.Stone;
  }
  if (tags.natural === 'cliff' || tags.natural === 'bare_rock' || tags.natural === 'rock') {
    return ResourceType.Stone;
  }

  const cover = coverOf(tags);
  if (cover === 'forest') return ResourceType.Wood;
  if (cover === 'farmland') return ResourceType.Food;
  return null;
}

// ---------------------------------------------------------------------- main

const NAME_FALLBACK: Record<RawResource, string> = {
  [ResourceType.Wood]: 'Woodland',
  [ResourceType.Stone]: 'Quarry',
  [ResourceType.Iron]: 'Mine',
  [ResourceType.Food]: 'Fields',
};

async function main(): Promise<void> {
  console.log(`=== importing ${outName} ===`);
  console.log(
    `centre ${centre.lat.toFixed(4)},${centre.lon.toFixed(4)}  span ${spanKmX}x${spanKmY}km  ` +
      `grid ${cols}x${rows} cells @ ${cellSize}u  (${metresPerCell}m per cell, ${metresPerUnit}m per unit)`,
  );

  const [dem, osm] = await Promise.all([fetchDem(), fetchOsm()]);

  // --- land cover -----------------------------------------------------
  const cover = new Uint8Array(cols * rows); // index into COVER_ORDER
  const rivers: OsmElement[] = [];
  // Painted weakest-first so water always wins over forest and forest over
  // farmland, regardless of what order Overpass happened to return them in.
  for (const wanted of COVER_ORDER) {
    if (wanted === 'bare') continue;
    const value = COVER_ORDER.indexOf(wanted);
    for (const element of osm) {
      if (element.tags?.waterway === 'river') {
        if (wanted === 'water') rivers.push(element);
        continue;
      }
      if (coverOf(element.tags) !== wanted) continue;
      for (const ring of ringsOf(element)) fillRing(cover, ring, value);
    }
  }
  // Only water that genuinely fills a cell becomes water — see
  // `RIVER_CELL_SHARE` for what happened when it did not.
  let riversDrawn = 0;
  let riversForded = 0;
  for (const river of rivers) {
    const line = (river.geometry ?? []).map((p) => project(p.lat, p.lon));
    if (line.length < 2) continue;
    const metresWide = Number(river.tags?.width) || RIVER_WIDTH;
    if (metresWide < metresPerCell * RIVER_CELL_SHARE) {
      riversForded++;
      continue;
    }
    fillLine(cover, line, metresWide, COVER_ORDER.indexOf('water'));
    riversDrawn++;
  }

  // --- elevation ------------------------------------------------------
  const metres = new Float32Array(cols * rows);
  const land: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const { lat, lon } = unproject(col, row);
      const h = sampleDem(dem, lat, lon);
      metres[row * cols + col] = h;
      if (COVER_ORDER[cover[row * cols + col]] !== 'water') land.push(h);
    }
  }
  if (land.length === 0) throw new Error('every cell came out as water — check --centre and --span');
  land.sort((a, b) => a - b);
  const base = land[Math.floor(land.length * 0.05)];
  const top = land[Math.floor(land.length * 0.95)];

  // --- readings -------------------------------------------------------
  const baseTemperature = Math.max(0, Math.min(1, 0.5 + (50 - Math.abs(centre.lat)) * 0.012));
  const raw = new Int16Array(cols * rows * 3);
  const bands = { water: 0, plains: 0, forest: 0, hills: 0, mountains: 0 };

  for (let i = 0; i < cols * rows; i++) {
    const isWater = COVER_ORDER[cover[i]] === 'water';
    const cls = COVER_ORDER[cover[i]];
    const h = metres[i];

    const elevation = isWater
      ? WATER_ELEVATION
      : LAND_FLOOR + Math.max(0, Math.min(1, (h - base) / relief)) * (1 - LAND_FLOOR);
    const moisture = COVER_MOISTURE[cls];
    const temperature = Math.max(0, Math.min(1, baseTemperature - ((h - base) / 1000) * LAPSE_PER_KM));

    raw[i * 3] = Math.round(elevation * RAW16_SCALE);
    raw[i * 3 + 1] = Math.round(moisture * RAW16_SCALE);
    raw[i * 3 + 2] = Math.round(temperature * RAW16_SCALE);

    // Mirrors the thresholds in `terrain.ts`, for the report only — the game
    // still does its own classifying from the readings above.
    if (elevation < WATER_LEVEL) bands.water++;
    else if (elevation > MOUNTAIN_LEVEL) bands.mountains++;
    else if (elevation > HILLS_LEVEL) bands.hills++;
    else if ((moisture - 0.5) * 1.5 + (0.5 - temperature) * 0.3 > 0.05) bands.forest++;
    else bands.plains++;
  }

  // --- village --------------------------------------------------------
  const places = osm.filter((e) => e.type === 'node' && e.tags?.place && e.lat !== undefined);
  const PLACE_RANK: Record<string, number> = { city: 4, town: 3, village: 2, hamlet: 1 };
  let village: { name: string; x: number; y: number } | null = null;

  if (villageArg) {
    const at = pair(villageArg, 'village');
    const p = project(at.lat, at.lon);
    const named = places
      .map((e) => ({ e, d: Math.hypot(project(e.lat!, e.lon!).x - p.x, project(e.lat!, e.lon!).y - p.y) }))
      .sort((a, b) => a.d - b.d)[0];
    village = { name: named && named.d < 400 ? (named.e.tags?.name ?? outName) : outName, x: p.x, y: p.y };
  } else {
    // The most significant settlement nearest the middle — which for a
    // region named after a town is that town.
    const scored = places
      .map((e) => {
        const p = project(e.lat!, e.lon!);
        const d = Math.hypot(p.x - width / 2, p.y - height / 2);
        return { e, p, score: (PLACE_RANK[e.tags!.place] ?? 0) - d / Math.max(width, height) };
      })
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) village = { name: scored[0].e.tags?.name ?? outName, x: scored[0].p.x, y: scored[0].p.y };
  }
  if (!village) throw new Error('no settlement found to found the village on; pass --village lat,lon');

  // --- sites ----------------------------------------------------------
  const candidates: Candidate[] = [];
  for (const element of osm) {
    const tags = element.tags;
    if (!tags) continue;
    const resource = resourceFor(tags);
    if (!resource) continue;

    if (element.type === 'node' && element.lat !== undefined) {
      const p = project(element.lat, element.lon!);
      candidates.push({ name: tags.name ?? null, resource, x: p.x, y: p.y, area: 0 });
      continue;
    }
    for (const ring of ringsOf(element)) {
      const c = centroid(ring);
      candidates.push({ name: tags.name ?? null, resource, x: c.x, y: c.y, area: ringArea(ring) });
    }
  }

  const inBounds = (c: Candidate) => c.x >= 0 && c.y >= 0 && c.x < width && c.y < height;
  const onLand = (c: Candidate) =>
    COVER_ORDER[cover[Math.floor(c.y / cellSize) * cols + Math.floor(c.x / cellSize)]] !== 'water';

  /**
   * Take the candidates a trade at a time and a district at a time, in
   * rotation, biggest first within each.
   *
   * Two rotations, and both were learned the hard way.
   *
   * **By trade**, because the source data is wildly unbalanced in a way the
   * ground is not: OSM maps every field around a town as its own polygon and
   * records mines as single points. Ranking by size alone put a hundred farms
   * and no stone or iron on the first Kuttenberg import, even though four
   * mine shafts and a quarry were sitting right there in the data — they were
   * points, area zero, so they sorted last and the budget ran out first.
   *
   * **By district**, because size is a global ranking and playability is a
   * local property. On the 34km import the sixty-four biggest woods were all
   * out in the forested north-west, so the budget was spent before the rule
   * ever looked at the thirty-five woods within walking distance of Kutná
   * Hora — and a town that cannot reach timber is dead in a fortnight
   * regardless of how much timber the map contains elsewhere. The map had
   * plenty. None of it was anywhere useful.
   *
   * Both are the same mistake `worldgen.ts` describes at `RESOURCE_BALANCE`:
   * placement that ignores what a resource is *for* produces a world that
   * looks plausible and plays stuck.
   */
  const districtsX = Math.max(1, Math.ceil(width / DISTRICT_SIZE));
  const districtOf = (c: Candidate) =>
    Math.floor(c.y / DISTRICT_SIZE) * districtsX + Math.floor(c.x / DISTRICT_SIZE);

  /** Per trade, per district, biggest first. */
  const buckets = new Map<RawResource, Map<number, Candidate[]>>();
  for (const c of candidates) {
    if (!inBounds(c) || !onLand(c)) continue;
    const byDistrict = buckets.get(c.resource) ?? new Map<number, Candidate[]>();
    const list = byDistrict.get(districtOf(c)) ?? [];
    list.push(c);
    byDistrict.set(districtOf(c), list);
    buckets.set(c.resource, byDistrict);
  }
  for (const byDistrict of buckets.values()) {
    for (const list of byDistrict.values()) list.sort((a, b) => b.area - a.area);
  }

  const nodes: PackNodeSpec[] = [];
  const used = new Set<string>();
  const counts: Record<string, number> = {};
  const trades = [...buckets.keys()];
  /** Where each trade has got to in its own list of districts, so the rotation advances independently. */
  const districtCursor = new Map<RawResource, number>();

  while (nodes.length < maxNodes) {
    let placedThisRound = false;

    for (const resource of trades) {
      if (nodes.length >= maxNodes) break;
      const byDistrict = buckets.get(resource)!;
      const districts = [...byDistrict.keys()];
      if (districts.length === 0) continue;

      // Walk districts from wherever this trade left off, taking the first
      // candidate that clears spacing. One per trade per turn, so no trade
      // and no district can run away with the budget.
      let placed = false;
      for (let step = 0; step < districts.length && !placed; step++) {
        const cursor = ((districtCursor.get(resource) ?? 0) + step) % districts.length;
        const list = byDistrict.get(districts[cursor])!;

        while (list.length > 0) {
          const c = list.shift()!;
          if (Math.hypot(c.x - village.x, c.y - village.y) < MIN_NODE_DISTANCE) continue;
          if (nodes.some((n) => Math.hypot(n.x - c.x, n.y - c.y) < MIN_NODE_DISTANCE)) continue;

          counts[resource] = (counts[resource] ?? 0) + 1;
          let name = c.name ?? `${NAME_FALLBACK[resource]} ${counts[resource]}`;
          while (used.has(name)) name = `${name} ${counts[resource]}`;
          used.add(name);

          nodes.push({
            name,
            resource,
            x: Math.round(c.x),
            y: Math.round(c.y),
            richness: Number(richnessFor(c.area).toFixed(2)),
          });
          districtCursor.set(resource, cursor + 1);
          placed = true;
          placedThisRound = true;
          break;
        }
      }
    }

    if (!placedThisRound) break;
  }

  // --- write ----------------------------------------------------------
  const binName = `${outId}.bin`;
  const file: PackFile = {
    format: PACK_FORMAT,
    name: outName,
    source:
      `Elevation: Terrarium tiles (Mapzen/AWS Open Data, SRTM+Copernicus derivatives). ` +
      `Land cover, water and place names: OpenStreetMap contributors, ODbL. ` +
      `Imported ${new Date().toISOString().slice(0, 10)} from ${centre.lat.toFixed(4)},${centre.lon.toFixed(4)} span ${spanKmX}x${spanKmY}km, relief ${relief}m.`,
    cellSize,
    metresPerUnit,
    seed,
    startingPopulation,
    village,
    terrain: { encoding: 'raw16', cols, rows, data: binName },
    nodes,
  };

  mkdirSync('public/maps', { recursive: true });
  writeFileSync(`public/maps/${binName}`, Buffer.from(raw.buffer));
  writeFileSync(`public/maps/${outId}.json`, `${JSON.stringify(file, null, 2)}\n`);

  // --- report ---------------------------------------------------------
  const total = cols * rows;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  console.log('');
  console.log(`elevation: ${base.toFixed(0)}m (5th pct) to ${top.toFixed(0)}m (95th pct), relief scale ${relief}m`);
  console.log(
    `ground:    water ${pct(bands.water)}  plains ${pct(bands.plains)}  forest ${pct(bands.forest)}  ` +
      `hills ${pct(bands.hills)}  mountains ${pct(bands.mountains)}`,
  );
  console.log(`rivers:    ${riversDrawn} drawn as water, ${riversForded} too narrow for a ${metresPerCell}m cell (left fordable)`);
  console.log(
    `village:   ${village.name} at (${Math.round(village.x)}, ${Math.round(village.y)}) — ` +
      `${((village.x / width) * 100).toFixed(0)}% across, ${((village.y / height) * 100).toFixed(0)}% down`,
  );
  console.log(
    `sites:     ${nodes.length} — ` +
      Object.entries(counts)
        .map(([r, n]) => `${r}=${n}`)
        .join(' ') || 'none',
  );
  console.log('');
  console.log('scale check (the simulation reads none of this, but you should):');
  console.log(`  map is ${spanKmX}x${spanKmY}km = ${width}x${height} world units`);
  console.log(`  a hamlet footprint (430u) covers ${((430 * metresPerUnit) / 1000).toFixed(2)}km`);
  console.log(`  the opening resource reach (850u) covers ${((850 * metresPerUnit) / 1000).toFixed(2)}km`);
  console.log(
    `  a villager covers ${((WALK_SPEED * 24 * metresPerUnit) / 1000).toFixed(0)}km in a day ` +
      `(a day's journey on foot under a load is about 35km)`,
  );
  console.log('');
  console.log(`wrote public/maps/${outId}.json and public/maps/${binName}`);
  console.log(`play it with  ?pack=${outId}   or  --pack ${outId}`);
}

await main();
