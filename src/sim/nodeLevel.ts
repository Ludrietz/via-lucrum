import { ResourceType, SiteType } from './types';

/**
 * How a resource site improves with use. Nothing to do with population or
 * settlements — a mine that has actually moved a lot of ore gets a deeper
 * shaft and a bigger stockpile, independent of who is buying it.
 */
export interface NodeLevelInfo {
  level: number;
  /** Lifetime units collected needed to reach this level. */
  threshold: number;
  capacityMultiplier: number;
  productionMultiplier: number;
  /** How far this level's own influence reaches, before roads or reveal have any say. */
  influenceRadius: number;
  /**
   * How many hands one workplace can host, once it's grown enough to make
   * room for them. Used to live on whichever trader's tier happened to be
   * closest; now that anyone anywhere can be posted to any node, capacity
   * belongs to the node itself.
   */
  workerCapacity: number;
}

export const NODE_LEVELS: readonly NodeLevelInfo[] = [
  { level: 1, threshold: 0, capacityMultiplier: 1, productionMultiplier: 1, influenceRadius: 0, workerCapacity: 1 },
  { level: 2, threshold: 30, capacityMultiplier: 1.4, productionMultiplier: 1.2, influenceRadius: 60, workerCapacity: 1 },
  { level: 3, threshold: 90, capacityMultiplier: 1.8, productionMultiplier: 1.45, influenceRadius: 110, workerCapacity: 2 },
  { level: 4, threshold: 220, capacityMultiplier: 2.4, productionMultiplier: 1.75, influenceRadius: 170, workerCapacity: 2 },
  { level: 5, threshold: 500, capacityMultiplier: 3, productionMultiplier: 2.1, influenceRadius: 240, workerCapacity: 3 },
];

/**
 * A level a node has earned by working, but can only actually reach once the
 * matching investment has been shipped in — see `NODE_UPGRADE_RESOURCE`
 * below. Same shape and scale as `NODE_LEVELS`'s thresholds on purpose: this
 * is meant to be a real competing claim on a transporter's time, not a
 * rubber stamp that quietly rides along behind production.
 */
export const INVESTMENT_THRESHOLDS: readonly number[] = [0, 25, 75, 180, 400];

/**
 * What a site needs shipped to it, on top of its own output, before it can
 * level up. Forest and quarry lean on each other directly — the two nodes
 * every village starts with — and mines and farms draw on that same pair
 * rather than adding a new resource dependency of their own.
 */
export const NODE_UPGRADE_RESOURCE: Record<SiteType, ResourceType> = {
  [SiteType.Village]: ResourceType.Wood,
  [SiteType.Forest]: ResourceType.Stone,
  [SiteType.Quarry]: ResourceType.Wood,
  [SiteType.Mine]: ResourceType.Wood,
  [SiteType.Farm]: ResourceType.Stone,
};

function levelForThreshold(cumulative: number): number {
  let level = NODE_LEVELS[0].level;
  for (const info of NODE_LEVELS) {
    if (cumulative >= info.threshold) level = info.level;
  }
  return level;
}

function levelForInvestment(invested: number): number {
  let level = NODE_LEVELS[0].level;
  for (let i = 0; i < INVESTMENT_THRESHOLDS.length; i++) {
    if (invested >= INVESTMENT_THRESHOLDS[i]) level = NODE_LEVELS[i].level;
  }
  return level;
}

/**
 * The level a node has actually reached: whichever of "worked enough" and
 * "invested in enough" is behind. A busy node nobody ships materials to
 * stalls here just as surely as a well-supplied one nobody staffs.
 */
export function nodeLevelFor(cumulativeCollected: number, investedResource: number): NodeLevelInfo {
  const level = Math.min(levelForThreshold(cumulativeCollected), levelForInvestment(investedResource));
  return NODE_LEVELS[level - 1];
}

export function isMaxNodeLevel(level: number): boolean {
  return level >= NODE_LEVELS[NODE_LEVELS.length - 1].level;
}

/** The lifetime-collected total that would push a node past this level, if any. */
export function nextNodeThreshold(level: number): number | null {
  const index = NODE_LEVELS.findIndex((info) => info.level === level);
  const next = NODE_LEVELS[index + 1];
  return next ? next.threshold : null;
}

/** The invested-resource total that would push a node past this level, if any. */
export function nextInvestmentThreshold(level: number): number | null {
  const index = NODE_LEVELS.findIndex((info) => info.level === level);
  return index >= 0 && index + 1 < INVESTMENT_THRESHOLDS.length ? INVESTMENT_THRESHOLDS[index + 1] : null;
}
