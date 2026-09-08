import type { Vec2 } from './geometry';
import { ResourceType, VillagerRole, type ResourceAmounts } from './types';
import type { Villager } from './villager';

export interface VillageLevel {
  population: number;
  influence: number;
  /** How many villagers may staff a single resource node at this level. */
  workersPerNode: number;
  /** What the village must pay to reach this level. */
  cost: ResourceAmounts | null;
}

/**
 * Level determines everything the player feels: how far the civilisation
 * reaches, how many people it can hold, and therefore how much of the network
 * it can actually operate.
 */
export const VILLAGE_LEVELS: VillageLevel[] = [
  { population: 5, influence: 330, workersPerNode: 1, cost: null },
  { population: 8, influence: 470, workersPerNode: 1, cost: { wood: 8, food: 6 } },
  { population: 13, influence: 630, workersPerNode: 2, cost: { wood: 20, food: 16, stone: 10 } },
  {
    population: 20,
    influence: 820,
    workersPerNode: 2,
    cost: { wood: 40, food: 30, stone: 24, iron: 18 },
  },
];

export class Village {
  readonly name: string;
  readonly position: Vec2;
  readonly radius = 32;

  level = 1;

  readonly storage: Record<ResourceType, number> = {
    [ResourceType.Wood]: 0,
    [ResourceType.Iron]: 0,
    [ResourceType.Stone]: 0,
    [ResourceType.Food]: 0,
  };

  readonly villagers: Villager[] = [];

  constructor(name: string, x: number, y: number) {
    this.name = name;
    this.position = { x, y };
  }

  private get tier(): VillageLevel {
    return VILLAGE_LEVELS[Math.min(this.level, VILLAGE_LEVELS.length) - 1];
  }

  get populationCap(): number {
    return this.tier.population;
  }

  get influenceRadius(): number {
    return this.tier.influence;
  }

  get workersPerNode(): number {
    return this.tier.workersPerNode;
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

  get isMaxLevel(): boolean {
    return this.level >= VILLAGE_LEVELS.length;
  }

  get nextLevelCost(): ResourceAmounts | null {
    return this.isMaxLevel ? null : VILLAGE_LEVELS[this.level].cost;
  }

  canAfford(cost: ResourceAmounts): boolean {
    return Object.entries(cost).every(
      ([resource, amount]) => this.storage[resource as ResourceType] >= (amount ?? 0),
    );
  }

  spend(cost: ResourceAmounts): void {
    for (const [resource, amount] of Object.entries(cost)) {
      this.storage[resource as ResourceType] -= amount ?? 0;
    }
  }
}
