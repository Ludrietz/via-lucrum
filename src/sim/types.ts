import type { Vec2 } from './geometry';
import type { Tier } from './tier';

/** Everything that can occupy a spot on the map. */
export enum SiteType {
  Village = 'village',
  Forest = 'forest',
  Mine = 'mine',
  Quarry = 'quarry',
  Farm = 'farm',
}

export enum ResourceType {
  Wood = 'wood',
  Iron = 'iron',
  Stone = 'stone',
  Food = 'food',
  Planks = 'planks',
  StoneBlocks = 'stoneBlocks',
  Tools = 'tools',
}

/**
 * Life cycle of a resource node. The design doc also names a `Discovered` step
 * between hidden and reachable; here entering the village's influence does both
 * at once, so the two collapse into `Reachable`.
 */
export enum NodeState {
  /** Outside the village's influence; not drawn at all. */
  Hidden = 'hidden',
  /** Inside the influence, visible, waiting for a road. */
  Reachable = 'reachable',
  /** The road network reaches it, but nobody works there yet. */
  Connected = 'connected',
  /** Staffed and producing. */
  Operational = 'operational',
}

export enum VillagerRole {
  /** Loitering in the village; this is the pool transport draws from. */
  Idle = 'idle',
  /** Walking to a workplace, or already living there. */
  Worker = 'worker',
  /** Running a delivery round. */
  Transporter = 'transporter',
}

export enum VillagerState {
  Waiting = 'waiting',
  Walking = 'walking',
  Working = 'working',
  Loading = 'loading',
  Unloading = 'unloading',
}

export type ResourceAmounts = Partial<Record<ResourceType, number>>;

/** One-shot notifications the renderer may turn into effects. */
export type WorldEvent =
  | { type: 'discovered'; at: Vec2; name: string }
  | { type: 'connected'; at: Vec2 }
  | { type: 'workerArrived'; at: Vec2; resource: ResourceType }
  | { type: 'pickup'; at: Vec2; resource: ResourceType; amount: number }
  | { type: 'deposit'; at: Vec2; resource: ResourceType; amount: number }
  | { type: 'villagerBorn'; at: Vec2 }
  | { type: 'tierUp'; at: Vec2; tier: Tier; name: string }
  | { type: 'nodeLevelUp'; at: Vec2; name: string; level: number }
  | { type: 'roadBuilt'; points: Vec2[] }
  | { type: 'roadLost'; points: Vec2[] }
  | { type: 'settlementFounded'; at: Vec2; name: string };
