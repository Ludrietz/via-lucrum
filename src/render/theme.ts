import { IndustryType } from '../sim/industry';
import { ResourceType, SiteType } from '../sim/types';
import { ROAD_DEVELOPED } from '../sim/traffic';

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

  roadCasing: 0x6f6047,
  road: 0xded3b4,

  influence: 0xb9a06a,
  /** Ground a place is actually built over and farms from — see `LandUseLayer`. */
  settledGround: 0xa8794a,
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
  [ResourceType.Fittings]: COLORS.tools,
  [ResourceType.Bread]: COLORS.farm,
};

export const RESOURCE_LABELS: Record<ResourceType, string> = {
  [ResourceType.Wood]: 'WOOD',
  [ResourceType.Iron]: 'IRON',
  [ResourceType.Stone]: 'STONE',
  [ResourceType.Food]: 'FOOD',
  [ResourceType.Planks]: 'PLANKS',
  [ResourceType.StoneBlocks]: 'STONE BLOCKS',
  [ResourceType.Tools]: 'TOOLS',
  [ResourceType.Fittings]: 'FITTINGS',
  [ResourceType.Bread]: 'BREAD',
};

/** Job title a villager takes when posted to each kind of industry. */
export const INDUSTRY_LABELS: Record<IndustryType, string> = {
  [IndustryType.Sawmill]: 'Sawyers',
  [IndustryType.Masonry]: 'Masons',
  [IndustryType.Smithy]: 'Smiths',
  [IndustryType.Joinery]: 'Joiners',
  [IndustryType.Bakery]: 'Bakers',
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
const TRAIL_WIDTH = 2.5;
const HIGHWAY_WIDTH = 20;

/**
 * The exponent is above one, and that is the whole of "roads start as paths".
 *
 * Below one, a road spends almost none of its life looking like a track: a
 * tenth of the traffic it takes to make a highway already bought a fifth of
 * the width, so the first cart through the woods drew something that read as
 * an established way, and every road in the realm looked broadly alike within
 * minutes of being laid. Above one the early gains are slow and the late ones
 * quick, which is both what the eye wants — a path that stays a path until it
 * has genuinely earned otherwise — and what the traffic actually does, now
 * that a well-used route carries heavier loads that pack it harder still.
 */
export function roadWidth(wear: number): number {
  return TRAIL_WIDTH + (HIGHWAY_WIDTH - TRAIL_WIDTH) * Math.pow(wearFraction(wear), 1.15);
}

/** Where a stretch of road sits between a fresh track and a made trunk road. */
export function wearFraction(wear: number): number {
  return Math.max(0, Math.min(1, wear / ROAD_DEVELOPED));
}

/** The names are only for the UI; the drawing itself is continuous. */
export function roadTierName(wear: number): string {
  if (wear >= ROAD_DEVELOPED * 0.5) return 'HIGHWAY';
  if (wear >= ROAD_DEVELOPED * 0.2) return 'ROAD';
  return 'TRAIL';
}

/**
 * A road's colour follows its wear the same continuous way its width does —
 * and it does so by getting *paler*, not greyer. A worn route on a drawn map
 * is a bright line across dark country: the stroke the eye follows first. So
 * a faint track is dusty tan, barely lifted off the ground it crosses, and a
 * highway is all but white. Three stops, linearly interpolated between
 * whichever two straddle the current wear — no hard steps, so one road can
 * shade from near-white at a busy junction to bare dust at its quiet far end.
 */
const ROAD_STOPS: ReadonlyArray<{ at: number; road: number; casing: number }> = [
  { at: 0, road: 0xc7b998, casing: 0x6b5b45 }, // faint track, the colour of dust
  { at: 0.45, road: 0xe3dac2, casing: 0x7d6f53 }, // packed, pale
  { at: 1, road: 0xfbf8f0, casing: 0x8b7d61 }, // highway, near white
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
  const t = wearFraction(wear);
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

/**
 * The pale surface earns its brightness: a faint track is half sunk into the
 * ground it crosses, a highway sits solidly on top of it.
 */
export function roadAlpha(wear: number): number {
  return 0.78 + 0.22 * wearFraction(wear);
}

/**
 * How hard the shadow under a road reads. A near-white highway needs a
 * definite edge to keep it from bleaching into the pale fields around it; a
 * dusty track barely needs separating from the dirt it already is.
 */
export function roadCasingAlpha(wear: number): number {
  return 0.2 + 0.3 * wearFraction(wear);
}

/** A busier road throws a wider shadow, which is most of what reads as bulk. */
export function roadCasingGrow(wear: number): number {
  return 2.6 + 3.4 * wearFraction(wear);
}

/**
 * How far back from its centreline a road has pushed the trees, in world
 * units — the half-width of the swathe it has cut through a wood.
 *
 * Driven by the same wear as the road's width and its colour, and for the
 * same reason: a road's development is *one* fact about it, and everything
 * the map says about that road should be a reading of that fact rather than
 * another thing to keep in step with it. A footpath threads between the
 * trunks and takes down almost nothing; a road that carries carts needs room
 * to pass, and gets cleared to suit.
 *
 * What grows is the verge, not merely the road: at full development the cut
 * is about twice the width of the road inside it, which is what makes the
 * corridor read as *a clearing with a road in it* rather than as trees that
 * happen to stop. The verge is pegged to the scatter spacing in
 * `vegetation.ts` so that a mature road always takes down a rank or two of
 * trees either side, rather than leaving a gap too narrow for the eye to
 * find.
 *
 * Note what this deliberately is not: it clears *drawn* trees and says
 * nothing to the terrain underneath, which stays forest — still classified as
 * woodland, still painted as woodland, still workable as woodland. A road
 * through a wood is a gap in the canopy, not a change of land.
 */
const TREE_SPACING = 15;
const VERGE = TREE_SPACING * 1.4;

export function roadClearing(wear: number): number {
  return roadWidth(wear) / 2 + 1.5 + VERGE * wearFraction(wear);
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
  debugGrid: 2,
  influence: 5,
  // Held ground sits just above the realm's border and below everything
  // drawn on top of the country. Workings first, settled ground over them:
  // where the two overlap it is because a town has built on a works, and the
  // town is what is actually there now.
  workedGround: 5.6,
  settledGround: 5.8,
  settlementPotential: 7,
  roads: 10,
  // Over the roads, for the same reason rivers go under the canopy: a road
  // that nothing can ever overlap is a line drawn *on* the map rather than a
  // thing lying in the country, and the eye knows the difference immediately.
  //
  // It costs nothing to get right, because of how a tree is drawn — scattered
  // at its foot and painted upwards from there. A tree north of a road grows
  // away from it and can never reach it; only a tree standing south of the
  // road has a crown that comes back over it, which is exactly the one that
  // should. So the ordering that looks like a blunt "trees win" is really the
  // correct occlusion for this projection, and it falls out of the depth
  // alone with nothing sorting per tree.
  //
  // What it overlaps is then a readout of how developed the road is, with no
  // extra rule: `roadClearing` holds the trees back by a margin that grows
  // with traffic, so a faint track through a wood is half-roofed by the
  // branches it threads between and a highway runs open down the middle of
  // its own clearing.
  vegetation: 11,
  preview: 15,
  sites: 20,
  villagers: 30,
  debugPath: 35,
  fx: 40,
} as const;

export const FONT_FAMILY = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
