import type { WorldConfig } from './world';

/**
 * The play area is procedurally generated (see `worldgen.ts`) and only ever
 * grows outward from the village as the civilisation's reach does — nothing
 * here places terrain or resources by hand any more. `WORLD_WIDTH`/`HEIGHT`
 * are not "the size of the world" in any geographic sense; noise and node
 * placement are defined at every coordinate, positive or negative, and would
 * carry on exactly as coherently well past this box. They exist only because
 * `TrafficField` (the wear/traffic grid — unrelated to terrain, and
 * deliberately left alone here) still pre-allocates a dense array sized to
 * the play area, so this is the practical ceiling on how far a single game
 * can expand, not a limit generation itself has. Sized generously enough
 * (a village walks roughly 80px/s; crossing this box would take over two
 * hours one-way) that nobody should ever actually reach the edge.
 */
export const WORLD_WIDTH = 40000;
export const WORLD_HEIGHT = 40000;

/** Oakridge starts at the centre of the play area, so it can expand equally in every direction. */
const VX = WORLD_WIDTH / 2;
const VY = WORLD_HEIGHT / 2;

/** A fresh, unreproducible seed — used unless the player (or a debug URL) asks for a specific one. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

export function createWorldConfig(seed: number): WorldConfig {
  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    startingPopulation: 5,
    village: { name: 'Oakridge', x: VX, y: VY },
    seed,
  };
}
