import type { Vec2 } from './geometry';
import {
  nextInvestmentThreshold,
  nextNodeThreshold,
  NODE_UPGRADE_RESOURCE,
  nodeLevelFor,
  type NodeLevelInfo,
} from './nodeLevel';
import { NodeState, ResourceType, SiteType } from './types';
import type { Villager } from './villager';

/**
 * How sharply an extra pair of hands falls off in usefulness once a node
 * already has some workers. 1 would be plain linear (today's old
 * behaviour); the lower this is, the more the first worker matters and the
 * less the last one does. Chosen so a fully-staffed node's throughput is
 * unchanged — only partial staffing gets discounted.
 */
const DIMINISHING_EXPONENT = 0.7;

export interface ResourceNodeConfig {
  id: number;
  name: string;
  type: SiteType;
  x: number;
  y: number;
  resource: ResourceType;
  /** Seconds one worker needs to produce a single unit, at level 1. */
  productionInterval: number;
  /** How much can pile up on site before production stalls, at level 1. */
  capacity?: number;
}

/**
 * A place villagers can be sent to work. Production happens here, not in the
 * village, and transporters are what turns it into village storage.
 *
 * A node also quietly improves with use: every unit actually carried off adds
 * to its lifetime total, and enough of that unlocks a bigger stockpile and a
 * faster crew — see `nodeLevel.ts`. Nothing about who buys the goods matters
 * here, only that they were worth someone's trip to come and get.
 */
export class ResourceNode {
  readonly id: number;
  readonly name: string;
  readonly type: SiteType;
  readonly position: Vec2;
  readonly resource: ResourceType;
  readonly baseProductionInterval: number;
  readonly baseCapacity: number;
  readonly radius = 22;

  state: NodeState = NodeState.Hidden;

  /**
   * Whether the realm has ever surveyed this spot. Monotone on purpose — see
   * `survey.ts`. Knowing where something is grants no right to it whatsoever;
   * `isClaimed` remains the only gate on actually using one.
   */
  surveyed = false;

  /** Villagers who live here permanently. */
  readonly workers: Villager[] = [];
  /** Villagers on their way here to take up work. */
  incomingWorkers = 0;

  /** Produced goods waiting to be collected. */
  stored = 0;
  /** Units already promised to transporters currently en route. */
  claimed = 0;
  /** Seconds this node has sat full with nobody coming to empty it. */
  fullSince = 0;
  /** Lifetime units actually carried off, the same figure that drives its level. */
  cumulativeCollected = 0;
  /** Lifetime units of `requiredResource` shipped in — the other half of levelling up. */
  investedResource = 0;
  /** Units of `requiredResource` already promised by a transporter en route. */
  pendingInvestment = 0;

  private productionTimer = 0;

  constructor(cfg: ResourceNodeConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.type = cfg.type;
    this.position = { x: cfg.x, y: cfg.y };
    this.resource = cfg.resource;
    this.baseProductionInterval = cfg.productionInterval;
    this.baseCapacity = cfg.capacity ?? 8;
  }

  get levelInfo(): NodeLevelInfo {
    return nodeLevelFor(this.cumulativeCollected, this.investedResource);
  }

  get level(): number {
    return this.levelInfo.level;
  }

  /** How much stock the next level needs, and how close this node is. */
  get levelProgress(): { collected: number; next: number | null } {
    return { collected: this.cumulativeCollected, next: nextNodeThreshold(this.level) };
  }

  /** What this node needs shipped in to level up, on top of its own output. */
  get requiredResource(): ResourceType {
    return NODE_UPGRADE_RESOURCE[this.type];
  }

  /** How much of `requiredResource` the next level needs, and how close this node is. */
  get investmentProgress(): { invested: number; next: number | null } {
    return { invested: this.investedResource, next: nextInvestmentThreshold(this.level) };
  }

  /** Investment already delivered or promised — what a shipment shouldn't double up on. */
  get effectiveInvestment(): number {
    return this.investedResource + this.pendingInvestment;
  }

  invest(amount: number): void {
    this.investedResource += amount;
  }

  get capacity(): number {
    return Math.round(this.baseCapacity * this.levelInfo.capacityMultiplier);
  }

  get productionInterval(): number {
    return this.baseProductionInterval / this.levelInfo.productionMultiplier;
  }

  /** How far this node's own development reaches, before roads or a settlement's reach add to it. */
  get influenceRadius(): number {
    return this.levelInfo.influenceRadius;
  }

  /** How many hands this node can host at once, grown into rather than borrowed from a trader's tier. */
  get workerCapacity(): number {
    return this.levelInfo.workerCapacity;
  }

  /**
   * Drawn on the map at all.
   *
   * This used to be `state !== Hidden`, which quietly made the frontier offer
   * list the whole of the visibility model: the player saw the two-to-four
   * sites currently on the table and nothing else, and a site that stopped
   * being offered went dark again. Being *offered* and being *known about*
   * are different facts about a deposit — the first is the realm's current
   * attention, the second is what the player needs in order to hold any
   * opinion at all about which way to grow. A claimed site counts regardless:
   * the realm plainly knows about ground it owns.
   */
  get isVisible(): boolean {
    return this.surveyed || this.isClaimed || this.state === NodeState.Frontier;
  }

  /**
   * Part of the realm. Everything that treats a node as the civilisation's
   * to use — routing, hiring, trade, settlement emergence — has to go through
   * this rather than `isVisible`, because a frontier offer is visible and is
   * emphatically not ours yet.
   */
  get isClaimed(): boolean {
    return (
      this.state === NodeState.Reachable ||
      this.state === NodeState.Connected ||
      this.state === NodeState.Operational
    );
  }

  get isConnected(): boolean {
    return this.state === NodeState.Connected || this.state === NodeState.Operational;
  }

  get isFull(): boolean {
    return this.stored >= this.capacity;
  }

  /** Goods nobody has been sent to fetch yet. */
  get available(): number {
    return Math.max(0, this.stored - this.claimed);
  }

  /**
   * Units produced per second across all workers — diminishing returns on
   * headcount, not linear. A node fully staffed still produces exactly what
   * it always could (`workerCapacity / productionInterval`); it's only
   * partial staffing that now yields proportionally less than it used to,
   * so piling every last villager onto one node stops being free.
   */
  get productionRate(): number {
    if (this.workers.length === 0) return 0;
    const fraction = this.workers.length / this.workerCapacity;
    return (this.workerCapacity / this.productionInterval) * fraction ** DIMINISHING_EXPONENT;
  }

  /** Fraction of the current unit that has been produced, for the progress ring. */
  get workProgress(): number {
    if (this.workers.length === 0) return 0;
    return Math.min(1, this.productionTimer / (1 / this.productionRate));
  }

  produce(dt: number): number {
    // Full and nobody is even on the way: a worker may step away and carry
    // some off themselves rather than stand idle. See `workerDelivery.ts`.
    this.fullSince = this.isFull && this.claimed === 0 ? this.fullSince + dt : 0;

    if (this.workers.length === 0 || this.isFull) {
      this.productionTimer = 0;
      return 0;
    }

    this.productionTimer += dt;
    const perUnit = 1 / this.productionRate;

    let produced = 0;
    while (this.productionTimer >= perUnit && this.stored + produced < this.capacity) {
      this.productionTimer -= perUnit;
      produced++;
    }

    this.stored += produced;
    return produced;
  }

  collect(amount: number): number {
    const taken = Math.min(amount, this.stored);
    this.stored -= taken;
    this.cumulativeCollected += taken;
    return taken;
  }
}
