import type { Vec2 } from './geometry';
import { NodeState, ResourceType, SiteType } from './types';
import type { Villager } from './villager';

export interface ResourceNodeConfig {
  id: number;
  name: string;
  type: SiteType;
  x: number;
  y: number;
  resource: ResourceType;
  /** Seconds one worker needs to produce a single unit. */
  productionInterval: number;
  /** How much can pile up on site before production stalls. */
  capacity?: number;
}

/**
 * A place villagers can be sent to work. Production happens here, not in the
 * village, and transporters are what turns it into village storage.
 */
export class ResourceNode {
  readonly id: number;
  readonly name: string;
  readonly type: SiteType;
  readonly position: Vec2;
  readonly resource: ResourceType;
  readonly productionInterval: number;
  readonly capacity: number;
  readonly radius = 22;

  state: NodeState = NodeState.Hidden;

  /** Villagers who live here permanently. */
  readonly workers: Villager[] = [];
  /** Villagers on their way here to take up work. */
  incomingWorkers = 0;

  /** Produced goods waiting to be collected. */
  stored = 0;
  /** Units already promised to transporters currently en route. */
  claimed = 0;

  private productionTimer = 0;

  constructor(cfg: ResourceNodeConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.type = cfg.type;
    this.position = { x: cfg.x, y: cfg.y };
    this.resource = cfg.resource;
    this.productionInterval = cfg.productionInterval;
    this.capacity = cfg.capacity ?? 8;
  }

  get isVisible(): boolean {
    return this.state !== NodeState.Hidden;
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

  /** Units produced per second across all workers. */
  get productionRate(): number {
    return this.workers.length / this.productionInterval;
  }

  /** Fraction of the current unit that has been produced, for the progress ring. */
  get workProgress(): number {
    if (this.workers.length === 0) return 0;
    return Math.min(1, this.productionTimer / (this.productionInterval / this.workers.length));
  }

  produce(dt: number): number {
    if (this.workers.length === 0 || this.isFull) {
      this.productionTimer = 0;
      return 0;
    }

    this.productionTimer += dt;
    const perUnit = this.productionInterval / this.workers.length;

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
    return taken;
  }
}
