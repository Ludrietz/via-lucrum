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
};

export const RESOURCE_LABELS: Record<ResourceType, string> = {
  [ResourceType.Wood]: 'WOOD',
  [ResourceType.Iron]: 'IRON',
  [ResourceType.Stone]: 'STONE',
  [ResourceType.Food]: 'FOOD',
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
  debugGrid: 2,
  influence: 5,
  roads: 10,
  preview: 15,
  sites: 20,
  villagers: 30,
  debugPath: 35,
  fx: 40,
} as const;

export const FONT_FAMILY = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
