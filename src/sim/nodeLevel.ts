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
  /**
   * Roughly how far this level's *area of operation* reaches — the stretch of
   * wood actually being felled and replanted, the fields actually ploughed.
   * See `landUse.ts`: the real shape follows the ground and is never this
   * circle, but this is the acreage it is trying to hold.
   *
   * This field used to be `influenceRadius` and meant "which sites this node
   * lets the civilisation see and use". That job was taken off it by the
   * territory redesign and nothing ever read it again — including the level-1
   * entry sitting at 0, which would have meant a node at its opening level
   * projecting nothing at all. It is now the one number that actually says
   * how much country a works occupies, which is what it always sounded like
   * it said.
   */
  workedRadius: number;
  /**
   * How many hands one workplace can host, once it's grown enough to make
   * room for them. Used to live on whichever trader's tier happened to be
   * closest; now that anyone anywhere can be posted to any node, capacity
   * belongs to the node itself.
   */
  workerCapacity: number;
}

/**
 * `workedRadius` grows about threefold across the ladder, which is an eight-
 * fold growth in acreage — a level-1 works holds around 80 hectares and a
 * level-5 one around 720, at `scale.ts`'s four metres to the unit. Those are
 * the right orders of magnitude for a coppiced wood serving a hamlet and a
 * managed forest district respectively, and the top of the ladder is
 * deliberately not much more than `MIN_NODE_DISTANCE` (165): two mature works
 * in the same valley are *meant* to end up sharing the ground and each be a
 * little the poorer for it.
 */
export const NODE_LEVELS: readonly NodeLevelInfo[] = [
  { level: 1, threshold: 0, capacityMultiplier: 1, productionMultiplier: 1, workedRadius: 80, workerCapacity: 1 },
  { level: 2, threshold: 30, capacityMultiplier: 1.4, productionMultiplier: 1.2, workedRadius: 120, workerCapacity: 1 },
  { level: 3, threshold: 90, capacityMultiplier: 1.8, productionMultiplier: 1.45, workedRadius: 165, workerCapacity: 2 },
  { level: 4, threshold: 220, capacityMultiplier: 2.4, productionMultiplier: 1.75, workedRadius: 205, workerCapacity: 2 },
  { level: 5, threshold: 500, capacityMultiplier: 3, productionMultiplier: 2.1, workedRadius: 240, workerCapacity: 3 },
];

/**
 * A level a node has earned by working, but can only actually reach once the
 * matching investment has been shipped in — see `NODE_UPGRADE_RESOURCE`
 * below. Meant to be a real competing claim on a transporter's time, not a
 * rubber stamp that quietly rides along behind production.
 *
 * Roughly halved from its original [0, 25, 75, 180, 400] once it turned out
 * the claim wasn't competing so much as losing outright: a trader wanting a
 * good outbids investment whenever anyone is even slightly short, and with a
 * dozen settlements each keeping a buffer somebody always is. Across a
 * hundred in-game days *no node had ever received a single unit*, so no node
 * had ever levelled, so worker capacity stayed at one everywhere and both
 * settlement growth and the reveal frontier were pinned. `trade.ts` now
 * prioritises visibly starved sites, and the first rung sits somewhere that
 * trickle can actually reach.
 */
export const INVESTMENT_THRESHOLDS: readonly number[] = [0, 10, 35, 90, 200];

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

/**
 * How many levels a node has already earned by being *worked* that its
 * shipped-in investment hasn't paid for yet — the honest measure of a site
 * being held back by logistics rather than by effort. Zero for a fresh node
 * (it has earned nothing yet either), and it closes on its own the moment
 * the materials actually arrive, which is what makes it safe to prioritise
 * on: see `trade.ts`, where it stops investment being outbid forever.
 */
export function levelsHeldBackByInvestment(cumulativeCollected: number, investedResource: number): number {
  return Math.max(0, levelForThreshold(cumulativeCollected) - levelForInvestment(investedResource));
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
