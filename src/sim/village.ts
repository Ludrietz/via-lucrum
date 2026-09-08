import { emptyAmounts } from './economy';
import type { Vec2 } from './geometry';
import { Tier, TIER_INFLUENCE, TIER_WORKERS_PER_NODE, tierFor } from './tier';
import { VillagerRole } from './types';
import type { Villager } from './villager';

/**
 * The first place. It is built the same way everything else on the map is:
 * a population that rises and falls with how well it is fed, and a tier read
 * straight off that number. It happens to keep its own roster of physical
 * villagers rather than a bare headcount, because it always has — but there
 * is no cost to pay and no rung to climb that a settlement does not also
 * have.
 */
export class Village {
  readonly name: string;
  readonly position: Vec2;
  readonly radius = 32;

  readonly storage = emptyAmounts();
  /** Goods already dispatched here but not yet arrived. */
  readonly incoming = emptyAmounts();
  /** Rolling record of what has been arriving, per resource. */
  readonly throughput = emptyAmounts();

  readonly villagers: Villager[] = [];
  /** Where population is easing toward zero of; villagers are added or let go to match it. */
  populationTarget: number;

  constructor(name: string, x: number, y: number) {
    this.name = name;
    this.position = { x, y };
    this.populationTarget = 0;
  }

  get tier(): Tier {
    return tierFor(this.population);
  }

  get influenceRadius(): number {
    return TIER_INFLUENCE[this.tier];
  }

  get workersPerNode(): number {
    return TIER_WORKERS_PER_NODE[this.tier];
  }

  get population(): number {
    return this.villagers.length;
  }

  get workerCount(): number {
    return this.villagers.filter((v) => v.role === VillagerRole.Worker).length;
  }

  get transporterCount(): number {
    return this.villagers.filter((v) => v.role === VillagerRole.Transporter).length;
  }

  get idleCount(): number {
    return this.villagers.filter((v) => v.role === VillagerRole.Idle).length;
  }

  /** Everyone not permanently posted to a workplace is available logistics labour. */
  get labourPool(): number {
    return this.population - this.workerCount;
  }
}
