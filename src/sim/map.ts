import { TerrainType, type TerrainBrush } from './terrain';
import { ResourceType, SiteType } from './types';
import type { WorldConfig } from './world';

export const WORLD_WIDTH = 2600;
export const WORLD_HEIGHT = 1900;

const CX = WORLD_WIDTH / 2;
const CY = WORLD_HEIGHT / 2;

/**
 * Terrain is painted with broad shapes, later ones over earlier ones. Each
 * feature here exists to force a specific routing decision:
 *
 *  - a mountain massif sits directly between the village and Ironhollow, so
 *    that road has to swing around it;
 *  - the massif is ringed by hills, so the cheap way round is a wide arc;
 *  - a lake blocks the straight line out to Deepdelve;
 *  - a river runs from the north into the lake, closing the northern side of
 *    that detour;
 *  - forests sit lightly enough that roads will often just cut through them.
 */
export const TERRAIN_BRUSHES: TerrainBrush[] = [
  // Rolling country first, so the sharper features can be laid on top.
  { shape: 'ellipse', type: TerrainType.Hills, x: CX + 235, y: CY - 215, rx: 285, ry: 205 },
  { shape: 'ellipse', type: TerrainType.Hills, x: CX - 170, y: CY + 400, rx: 265, ry: 190 },
  { shape: 'ellipse', type: TerrainType.Hills, x: CX - 800, y: CY - 250, rx: 320, ry: 250 },
  { shape: 'ellipse', type: TerrainType.Hills, x: CX + 700, y: CY + 480, rx: 250, ry: 180 },

  // The massif between Oakridge and Ironhollow.
  { shape: 'ellipse', type: TerrainType.Mountains, x: CX + 105, y: CY - 130, rx: 140, ry: 92 },
  { shape: 'ellipse', type: TerrainType.Mountains, x: CX + 225, y: CY - 205, rx: 118, ry: 78 },
  { shape: 'ellipse', type: TerrainType.Mountains, x: CX - 640, y: CY - 330, rx: 130, ry: 88 },

  // Woodland.
  { shape: 'ellipse', type: TerrainType.Forest, x: CX - 245, y: CY - 200, rx: 270, ry: 200 },
  { shape: 'ellipse', type: TerrainType.Forest, x: CX - 400, y: CY - 520, rx: 245, ry: 180 },
  { shape: 'ellipse', type: TerrainType.Forest, x: CX - 555, y: CY + 225, rx: 235, ry: 175 },
  { shape: 'ellipse', type: TerrainType.Forest, x: CX + 620, y: CY - 560, rx: 240, ry: 175 },
  { shape: 'ellipse', type: TerrainType.Forest, x: CX + 90, y: CY + 690, rx: 250, ry: 165 },

  // Water goes on last: nothing paints over a lake.
  { shape: 'ellipse', type: TerrainType.Water, x: CX + 375, y: CY + 235, rx: 165, ry: 100 },
  {
    shape: 'path',
    type: TerrainType.Water,
    width: 42,
    points: [
      { x: CX + 505, y: -40 },
      { x: CX + 468, y: CY - 800 },
      { x: CX + 500, y: CY - 690 },
      { x: CX + 452, y: CY - 560 },
      { x: CX + 470, y: CY - 430 },
      { x: CX + 418, y: CY - 320 },
      { x: CX + 440, y: CY - 210 },
      { x: CX + 398, y: CY - 105 },
      { x: CX + 415, y: CY - 10 },
      { x: CX + 386, y: CY + 90 },
      { x: CX + 380, y: CY + 165 },
    ],
  },
];

/**
 * One hand-placed map. Distances from the village are chosen so that each
 * village level opens up a new band of the wilderness:
 * level 1 reaches 330, level 2 470, level 3 630, level 4 820.
 *
 * Sites are placed for the shape of the network, not to match the ground they
 * stand on: Ironhollow happens to sit in hills, Millfield on open plains.
 */
export const PROTOTYPE_MAP: WorldConfig = {
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  startingPopulation: 5,
  village: { name: 'Oakridge', x: CX, y: CY },
  terrain: TERRAIN_BRUSHES,
  nodes: [
    // Within reach from the start.
    {
      id: 1,
      name: 'Elderwood',
      type: SiteType.Forest,
      x: CX - 220,
      y: CY - 190,
      resource: ResourceType.Wood,
      productionInterval: 6,
    },
    {
      id: 2,
      name: 'Millfield',
      type: SiteType.Farm,
      x: CX + 255,
      y: CY + 115,
      resource: ResourceType.Food,
      productionInterval: 5,
    },
    // Opens at level 2. The straight line to Ironhollow runs into the massif.
    {
      id: 3,
      name: 'Ironhollow',
      type: SiteType.Mine,
      x: CX + 300,
      y: CY - 300,
      resource: ResourceType.Iron,
      productionInterval: 9,
    },
    {
      id: 4,
      name: 'Greystone',
      type: SiteType.Quarry,
      x: CX - 180,
      y: CY + 385,
      resource: ResourceType.Stone,
      productionInterval: 8,
    },
    // Opens at level 3.
    {
      id: 5,
      name: 'Thornwood',
      type: SiteType.Forest,
      x: CX - 545,
      y: CY + 215,
      resource: ResourceType.Wood,
      productionInterval: 6,
    },
    // Opens at level 4.
    {
      id: 6,
      name: 'Highwood',
      type: SiteType.Forest,
      x: CX - 405,
      y: CY - 520,
      resource: ResourceType.Wood,
      productionInterval: 5,
    },
    {
      id: 7,
      name: 'Deepdelve',
      type: SiteType.Mine,
      x: CX + 600,
      y: CY + 340,
      resource: ResourceType.Iron,
      productionInterval: 8,
    },
    {
      id: 8,
      name: 'Sunmeadow',
      type: SiteType.Farm,
      x: CX + 130,
      y: CY + 700,
      resource: ResourceType.Food,
      productionInterval: 5,
    },
  ],
};
