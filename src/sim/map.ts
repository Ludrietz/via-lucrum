import { TerrainType, type TerrainBrush } from './terrain';
import { ResourceType, SiteType } from './types';
import type { WorldConfig } from './world';

/**
 * A country rather than a valley. Oakridge sits west of centre with its own
 * small basin; everything else is wilderness the network has to earn its way
 * into. At the widest reach the first village can see about a fifth of this,
 * so the rest opens up only as settlements grow into second centres.
 */
export const WORLD_WIDTH = 6400;
export const WORLD_HEIGHT = 4600;

/** Oakridge. Everything below is placed relative to it. */
const VX = 1800;
const VY = 2300;

/**
 * Regions, painted broadest first so the sharper features sit on top.
 *
 * The shapes are chosen to make routing a decision rather than a formality:
 * the Ironspine divides the home basin from the eastern ore country, the
 * Longmere blocks the direct line south-east, and the Fell runs down the
 * middle of the north woods.
 */
export const TERRAIN_BRUSHES: TerrainBrush[] = [
  // --- rolling ground ------------------------------------------------------
  { shape: 'ellipse', type: TerrainType.Hills, x: 900, y: 1900, rx: 620, ry: 520 },
  { shape: 'ellipse', type: TerrainType.Hills, x: 1450, y: 3000, rx: 520, ry: 420 },
  { shape: 'ellipse', type: TerrainType.Hills, x: 2500, y: 1850, rx: 480, ry: 380 },
  { shape: 'ellipse', type: TerrainType.Hills, x: 3600, y: 1850, rx: 700, ry: 560 },
  { shape: 'ellipse', type: TerrainType.Hills, x: 3800, y: 2700, rx: 620, ry: 480 },
  { shape: 'ellipse', type: TerrainType.Hills, x: 5400, y: 1500, rx: 780, ry: 620 },
  { shape: 'ellipse', type: TerrainType.Hills, x: 5200, y: 3600, rx: 700, ry: 560 },
  { shape: 'ellipse', type: TerrainType.Hills, x: 1500, y: 4000, rx: 560, ry: 420 },

  // --- the Ironspine: the barrier between the basin and the ore country ----
  { shape: 'ellipse', type: TerrainType.Mountains, x: 2900, y: 1600, rx: 300, ry: 190 },
  { shape: 'ellipse', type: TerrainType.Mountains, x: 3150, y: 2000, rx: 250, ry: 210 },
  { shape: 'ellipse', type: TerrainType.Mountains, x: 3250, y: 2450, rx: 210, ry: 230 },
  { shape: 'ellipse', type: TerrainType.Mountains, x: 3150, y: 2900, rx: 190, ry: 200 },
  // Outlying peaks, so the spine has ends rather than stopping dead.
  { shape: 'ellipse', type: TerrainType.Mountains, x: 5600, y: 1350, rx: 320, ry: 240 },
  { shape: 'ellipse', type: TerrainType.Mountains, x: 700, y: 1500, rx: 260, ry: 200 },

  // --- woodland ------------------------------------------------------------
  { shape: 'ellipse', type: TerrainType.Forest, x: 1450, y: 1950, rx: 460, ry: 360 },
  { shape: 'ellipse', type: TerrainType.Forest, x: 1200, y: 1450, rx: 520, ry: 400 },
  { shape: 'ellipse', type: TerrainType.Forest, x: 2200, y: 900, rx: 620, ry: 460 },
  { shape: 'ellipse', type: TerrainType.Forest, x: 3050, y: 1150, rx: 520, ry: 380 },
  { shape: 'ellipse', type: TerrainType.Forest, x: 1050, y: 2700, rx: 480, ry: 380 },
  { shape: 'ellipse', type: TerrainType.Forest, x: 1650, y: 3900, rx: 560, ry: 420 },
  { shape: 'ellipse', type: TerrainType.Forest, x: 4600, y: 900, rx: 640, ry: 460 },
  { shape: 'ellipse', type: TerrainType.Forest, x: 4400, y: 4100, rx: 620, ry: 440 },

  // --- water: last, because nothing paints over a lake ----------------------
  // The Longmere, square across the short way east.
  { shape: 'ellipse', type: TerrainType.Water, x: 2850, y: 3350, rx: 420, ry: 260 },
  { shape: 'ellipse', type: TerrainType.Water, x: 5100, y: 2450, rx: 330, ry: 220 },
  {
    shape: 'path',
    type: TerrainType.Water,
    width: 58,
    points: [
      { x: 2500, y: -60 },
      { x: 2440, y: 420 },
      { x: 2560, y: 780 },
      { x: 2430, y: 1150 },
      { x: 2520, y: 1500 },
      { x: 2660, y: 1900 },
      { x: 2720, y: 2350 },
      { x: 2800, y: 2800 },
      { x: 2850, y: 3150 },
    ],
  },
];

/**
 * Sites are placed for the shape of the network, not to match their ground.
 * The bands they fall in decide when they can be reached: the village sees
 * 480 at first and 1250 at its largest, and anything past that waits for a
 * settlement to grow near enough to open it up.
 */
export const PROTOTYPE_MAP: WorldConfig = {
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  startingPopulation: 5,
  village: { name: 'Oakridge', x: VX, y: VY },
  terrain: TERRAIN_BRUSHES,
  nodes: [
    // --- the home basin, open from the start (within 480) -----------------
    { id: 1, name: 'Elderwood', type: SiteType.Forest, x: 1480, y: 1980, resource: ResourceType.Wood, productionInterval: 6 },
    { id: 2, name: 'Millfield', type: SiteType.Farm, x: 2180, y: 2560, resource: ResourceType.Food, productionInterval: 5 },

    // --- opened by the village growing (660 / 800 / 900) ------------------
    { id: 3, name: 'Ironhollow', type: SiteType.Mine, x: 2280, y: 2010, resource: ResourceType.Iron, productionInterval: 9 },
    { id: 4, name: 'Greystone', type: SiteType.Quarry, x: 1560, y: 2820, resource: ResourceType.Stone, productionInterval: 8 },
    { id: 5, name: 'Thornwood', type: SiteType.Forest, x: 1160, y: 2620, resource: ResourceType.Wood, productionInterval: 6 },
    { id: 6, name: 'Sunmeadow', type: SiteType.Farm, x: 2350, y: 2840, resource: ResourceType.Food, productionInterval: 5 },
    { id: 7, name: 'Highwood', type: SiteType.Forest, x: 1300, y: 1620, resource: ResourceType.Wood, productionInterval: 5 },

    // --- past the village's sight: a hamlet has to grow out this way ------
    { id: 8, name: 'Stonewatch', type: SiteType.Quarry, x: 900, y: 2500, resource: ResourceType.Stone, productionInterval: 8 },
    { id: 9, name: 'Marshgrain', type: SiteType.Farm, x: 2080, y: 3300, resource: ResourceType.Food, productionInterval: 6 },
    { id: 10, name: 'Pinehollow', type: SiteType.Forest, x: 1720, y: 1300, resource: ResourceType.Wood, productionInterval: 5 },
    { id: 11, name: 'Duskwood', type: SiteType.Forest, x: 1400, y: 3400, resource: ResourceType.Wood, productionInterval: 6 },

    // --- the far country, behind the Ironspine and out east ---------------
    { id: 12, name: 'Frostpine', type: SiteType.Forest, x: 2750, y: 1150, resource: ResourceType.Wood, productionInterval: 6 },
    { id: 13, name: 'Emberfell', type: SiteType.Mine, x: 3400, y: 1850, resource: ResourceType.Iron, productionInterval: 8 },
    { id: 14, name: 'Redhill', type: SiteType.Mine, x: 3450, y: 2950, resource: ResourceType.Iron, productionInterval: 9 },
    { id: 15, name: 'Goldfield', type: SiteType.Farm, x: 3900, y: 3300, resource: ResourceType.Food, productionInterval: 5 },
    { id: 16, name: 'Cairnmoor', type: SiteType.Quarry, x: 4200, y: 1750, resource: ResourceType.Stone, productionInterval: 8 },
  ],
};
