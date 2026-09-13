import type { Vec2 } from './geometry';
import { LandParcel, workedSuitability } from './landUse';
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

/**
 * The worst a works can be reduced to by losing its ground.
 *
 * A floor rather than a straight multiplier, because "the town built over the
 * wood" should be a real, visible cost and never a way to switch a site off
 * entirely. A node driven to zero output is a node whose workers are posted
 * to nothing, whose investment shipments become pointless, and whose
 * settlement then starves — the resource-starvation spiral this project has
 * already been burned by twice. At 0.45 a thoroughly built-over works is
 * plainly worse off, still worth staffing, and still worth the road.
 */
export const MIN_GROUND_QUALITY = 0.45;

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

  /**
   * The ground this works actually operates over — the wood being felled and
   * replanted, the fields being ploughed, the stone being quarried. The node
   * itself stays one point: it is where the workers muster and where a
   * transporter comes to load, exactly as before. What is new is that the
   * *production* behind that point now has somewhere it happens, which can be
   * good country or poor, can grow with the works, and can be built over by
   * the town next door. See `landUse.ts`.
   */
  readonly ground: LandParcel;

  /**
   * How much the ground it holds is actually supporting it, 0.45 to 1 — see
   * `groundQuality`. Recomputed by `World` on the same timer the parcels grow
   * on rather than read live, because it walks the whole parcel and
   * `productionInterval` is asked for on every tick by every worker.
   */
  groundQuality = 1;

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
    this.ground = new LandParcel({
      key: `node:${cfg.id}`,
      kind: 'worked',
      origin: this.position,
      suitabilityOf: (sample) => workedSuitability(sample, this.resource),
    });
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

  /**
   * Seconds per unit per worker, after both the node's own level and the
   * ground it is standing on have had their say.
   *
   * The second term is the point of the whole land-use system. A works that
   * holds the acreage its level calls for, on country suited to its trade,
   * produces exactly what it always did — nothing is nerfed. What is new is
   * that a wood whose best stands have been built over by the village beside
   * it, or a quarry hemmed in between two others opened on the same ridge,
   * genuinely yields less, because there is less of it being worked. That is
   * the cost a town pays for sprawling into its own hinterland, and it is
   * levied here rather than as a rule somewhere that says "towns may not
   * expand".
   */
  get productionInterval(): number {
    return this.baseProductionInterval / (this.levelInfo.productionMultiplier * this.groundQuality);
  }

  /** Roughly how far this works' area of operation reaches at its current level. */
  get workedRadius(): number {
    return this.levelInfo.workedRadius;
  }

  /** The acreage this works is trying to hold, in world units². */
  get workedArea(): number {
    return Math.PI * this.workedRadius ** 2;
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
