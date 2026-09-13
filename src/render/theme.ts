import { IndustryType } from '../sim/industry';
import { ResourceType, SiteType } from '../sim/types';
import { WEAR_FULL } from '../sim/traffic';

/** Parchment cartography underneath, Mini Metro information design on top. */
export const COLORS = {
  parchment: 0xe9dcbb,
  parchmentDark: 0xdfd0a9,
  parchmentLight: 0xf3ead2,
  ink: 0x3a3125,
  inkSoft: 0x6b5f4b,

  water: 0x8fb0ad,
  hill: 0x8d7f63,
  plains: 0xd8cda2,
  mountain: 0x6f6455,
  field: 0xbda86a,

  village: 0x3a3125,
  forest: 0x4c6b45,
  mine: 0x5c6470,
  quarry: 0x77706a,
  farm: 0x9a7d33,

  // Processed goods get their own, warmer shades — worked material reading
  // as distinct from the raw stuff it came from.
  planks: 0xa9793f,
  stoneBlocks: 0x9c948a,
  tools: 0x8a3a2e,

  roadCasing: 0x6b5b45,
  road: 0x8d7a5a,

  influence: 0xb9a06a,
  erase: 0x9c3b2f,
} as const;

export const SITE_COLORS: Record<SiteType, number> = {
  [SiteType.Village]: COLORS.village,
  [SiteType.Forest]: COLORS.forest,
  [SiteType.Mine]: COLORS.mine,
  [SiteType.Quarry]: COLORS.quarry,
  [SiteType.Farm]: COLORS.farm,
};

export const RESOURCE_COLORS: Record<ResourceType, number> = {
  [ResourceType.Wood]: COLORS.forest,
  [ResourceType.Iron]: COLORS.mine,
  [ResourceType.Stone]: COLORS.quarry,
  [ResourceType.Food]: COLORS.farm,
  [ResourceType.Planks]: COLORS.planks,
  [ResourceType.StoneBlocks]: COLORS.stoneBlocks,
  [ResourceType.Tools]: COLORS.tools,
};

export const RESOURCE_LABELS: Record<ResourceType, string> = {
  [ResourceType.Wood]: 'WOOD',
  [ResourceType.Iron]: 'IRON',
  [ResourceType.Stone]: 'STONE',
  [ResourceType.Food]: 'FOOD',
  [ResourceType.Planks]: 'PLANKS',
  [ResourceType.StoneBlocks]: 'STONE BLOCKS',
  [ResourceType.Tools]: 'TOOLS',
};

/** Job title a villager takes when posted to each kind of industry. */
export const INDUSTRY_LABELS: Record<IndustryType, string> = {
  [IndustryType.Sawmill]: 'Sawyers',
  [IndustryType.Masonry]: 'Masons',
  [IndustryType.Smithy]: 'Smiths',
};

export const SITE_LABELS: Record<SiteType, string> = {
  [SiteType.Village]: 'VILLAGE',
  [SiteType.Forest]: 'FOREST',
  [SiteType.Mine]: 'IRON MINE',
  [SiteType.Quarry]: 'QUARRY',
  [SiteType.Farm]: 'FARM',
};

/** Job title a villager takes when posted to each kind of site. */
export const WORKER_LABELS: Record<SiteType, string> = {
  [SiteType.Village]: 'Villagers',
  [SiteType.Forest]: 'Lumberjacks',
  [SiteType.Mine]: 'Miners',
  [SiteType.Quarry]: 'Stonecutters',
  [SiteType.Farm]: 'Farmers',
};

/**
 * Roads widen with the wear packed into the ground under them, smoothly rather
 * than in steps, so one road can be a highway where the traffic converges and
 * a trail out at its far end.
 */
const TRAIL_WIDTH = 4;
const HIGHWAY_WIDTH = 16;

export function roadWidth(wear: number): number {
  const t = Math.max(0, Math.min(1, wear / WEAR_FULL));
  return TRAIL_WIDTH + (HIGHWAY_WIDTH - TRAIL_WIDTH) * Math.pow(t, 0.85);
}

/** The names are only for the UI; the drawing itself is continuous. */
export function roadTierName(wear: number): string {
  if (wear >= WEAR_FULL * 0.5) return 'HIGHWAY';
  if (wear >= WEAR_FULL * 0.2) return 'ROAD';
  return 'TRAIL';
}

/**
 * A road's colour follows its wear the same continuous way its width does:
 * bare dirt trail, through packed gravel, to a paved grey highway. Three
 * stops, linearly interpolated between whichever two straddle the current
 * wear — no hard steps, so one road can visibly shade from paved near a busy
 * junction to bare dirt out at its quiet far end.
 */
const ROAD_STOPS: ReadonlyArray<{ at: number; road: number; casing: number }> = [
  { at: 0, road: 0x8d7a5a, casing: 0x6b5b45 }, // dirt trail
  { at: 0.5, road: 0x9d9179, casing: 0x7a7260 }, // packed gravel
  { at: 1, road: 0x8f8d89, casing: 0x605e5a }, // paved, grey
];

function lerpChannel(a: number, b: number, t: number, shift: number): number {
  const from = (a >> shift) & 0xff;
  const to = (b >> shift) & 0xff;
  return Math.round(from + (to - from) * t);
}

function lerpColor(a: number, b: number, t: number): number {
  const r = lerpChannel(a, b, t, 16);
  const g = lerpChannel(a, b, t, 8);
  const bl = lerpChannel(a, b, t, 0);
  return (r << 16) | (g << 8) | bl;
}

function roadStopColor(wear: number, channel: 'road' | 'casing'): number {
  const t = Math.max(0, Math.min(1, wear / WEAR_FULL));
  let lower = ROAD_STOPS[0];
  let upper = ROAD_STOPS[ROAD_STOPS.length - 1];
  for (let i = 0; i < ROAD_STOPS.length - 1; i++) {
    if (t >= ROAD_STOPS[i].at && t <= ROAD_STOPS[i + 1].at) {
      lower = ROAD_STOPS[i];
      upper = ROAD_STOPS[i + 1];
      break;
    }
  }
  const span = upper.at - lower.at;
  const local = span > 0 ? (t - lower.at) / span : 0;
  return lerpColor(lower[channel], upper[channel], local);
}

export function roadColor(wear: number): number {
  return roadStopColor(wear, 'road');
}

export function roadCasingColor(wear: number): number {
  return roadStopColor(wear, 'casing');
}

/** Settlements are coloured by what they live on. */
export const TRADE_COLORS: Record<string, number> = {
  wood: COLORS.forest,
  iron: COLORS.mine,
  stone: COLORS.quarry,
  food: COLORS.farm,
  mixed: 0x8a6f4a,
};

export const DEPTH = {
  terrain: 0,
  // Under the canopy, not over it. A river drawn on top of the trees is
  // drawn on top of the *map* — the eye reads anything that occludes the
  // scenery as an annotation of it rather than as part of it, which is most
  // of why the first version looked stuck on. Trees on the bank overlapping
  // the water is what puts the water into the landscape.
  rivers: 0.5,
  // The ripple hatching sits on the water and under everything that stands on
  // the bank, same as the water itself.
  waterPattern: 0.6,
  vegetation: 1,
  debugGrid: 2,
  influence: 5,
  settlementPotential: 7,
  roads: 10,
  preview: 15,
  sites: 20,
  villagers: 30,
  debugPath: 35,
  fx: 40,
} as const;

export const FONT_FAMILY = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
