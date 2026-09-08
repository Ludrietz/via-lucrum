import type { Vec2 } from './geometry';
import type { ResourceNode } from './resourceNode';
import type { Route } from './roadNetwork';
import { ResourceType, VillagerRole, VillagerState } from './types';
import type { Village } from './village';

export const WALK_SPEED = 82;
/** How much one villager can carry per trip. */
export const CARRY_CAPACITY = 3;

export interface Cargo {
  resource: ResourceType;
  amount: number;
}

/**
 * One person. The same class covers idlers, resource workers and transporters;
 * what separates them is `role` and where their feet are pointed.
 */
export class Villager {
  readonly id: number;
  readonly home: Village;

  role: VillagerRole = VillagerRole.Idle;
  state: VillagerState = VillagerState.Waiting;

  /** Where a worker lives permanently, once it has arrived. */
  workplace: ResourceNode | null = null;
  /** Where a transporter is currently headed to collect from. */
  task: ResourceNode | null = null;

  route: Route | null = null;
  travelled = 0;
  /** True while a transporter is on the leg back to the village. */
  homebound = false;
  /** Units this transporter reserved at its task, so nobody double-books them. */
  claim = 0;

  cargo: Cargo | null = null;
  timer = 0;

  position: Vec2;
  heading = 0;
  /** Current walking speed, after the ground has had its say. */
  speed = WALK_SPEED;
  /** Stable scatter so idlers do not stack on the village centre. */
  readonly restOffset: Vec2;

  constructor(id: number, home: Village) {
    this.id = id;
    this.home = home;
    this.position = { ...home.position };

    const angle = (id * 2.39996) % (Math.PI * 2);
    const radius = home.radius + 16 + ((id * 7) % 18);
    this.restOffset = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.7 };
  }

  get isAvailable(): boolean {
    return this.role === VillagerRole.Idle;
  }

  get isWalking(): boolean {
    return this.state === VillagerState.Walking;
  }

  setRoute(route: Route): void {
    this.route = route;
    this.travelled = 0;
    this.state = VillagerState.Walking;
    this.syncPosition();
  }

  /**
   * Advance along the current route; true once the far end is reached.
   *
   * `terrainCost` is the ground under this villager's feet right now, so they
   * visibly labour up a hill road and stride out again on the flat. Route
   * choice uses each road's average of the same number, which means the way
   * villagers pick really is the way they cover fastest.
   */
  advance(dt: number, terrainCost = 1): boolean {
    const route = this.route;
    if (!route) return true;

    const going = Number.isFinite(terrainCost) && terrainCost > 0 ? terrainCost : 1;
    this.speed = WALK_SPEED / going;

    this.travelled += this.speed * dt;
    this.syncPosition();

    if (this.travelled >= route.length) {
      this.travelled = route.length;
      return true;
    }
    return false;
  }

  private syncPosition(): void {
    if (!this.route) return;
    const sample = this.route.sample(this.travelled);
    this.position = { x: sample.x, y: sample.y };
    this.heading = sample.angle;
  }

  restAtHome(): void {
    this.position = {
      x: this.home.position.x + this.restOffset.x,
      y: this.home.position.y + this.restOffset.y,
    };
    this.route = null;
    this.travelled = 0;
  }

  release(): void {
    this.role = VillagerRole.Idle;
    this.state = VillagerState.Waiting;
    this.task = null;
    this.cargo = null;
    this.homebound = false;
    this.claim = 0;
    this.timer = 0;
    this.restAtHome();
  }
}
