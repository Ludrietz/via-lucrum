/**
 * A frame budget, measured.
 *
 * `tools/perf.ts` answers "how long does a tick of the simulation take", and
 * that question turned out to be most of the answer — but it is not all of
 * it, because the thing a player actually waits on is a frame, and a frame is
 * the simulation *plus* twelve render layers plus whatever Phaser does with
 * the display list they have built up. None of that runs headless.
 *
 * So this page plays the game the way `tools/playtest.ts` does — the same
 * stand-in player, so the network has the shape a person's would — fast
 * forwards to a realm of a given size with no rendering at all, and only then
 * hands the finished world to the real `GameScene`. What it prints after that
 * is the real cost of a real frame, layer by layer.
 *
 *     /bench.html?days=90&seed=1234
 *
 * Dev-only, and not reachable from the game.
 */
import Phaser from 'phaser';
import { Surveyor } from './surveyor';
import { UNEXPLORED_COLOR } from '../src/render/CameraController';
import { GameScene } from '../src/render/GameScene';
import { createWorldConfig } from '../src/sim/map';
import { World } from '../src/sim/world';

interface Layer {
  update: (...args: never[]) => unknown;
}

const params = new URLSearchParams(window.location.search);
const seed = Number(params.get('seed') ?? 1234);
const days = Number(params.get('days') ?? 90);
/** Seconds of frames to average over, once the world is built. */
const WINDOW = Number(params.get('window') ?? 5);

const readout = document.getElementById('bench') as HTMLPreElement;
const say = (text: string): void => {
  readout.textContent = text;
};

/**
 * Fast-forward with no scene attached. The same fixed step the headless
 * harness uses, so a bench world and a playtest world of the same age are the
 * same world.
 */
function buildWorld(): World {
  const world = new World(createWorldConfig(seed));
  const surveyor = new Surveyor({ roadInterval: 6, policy: 'measured', verbose: false });
  const DT = 1 / 20;
  while (world.day < days) {
    world.update(DT);
    surveyor.update(world, DT);
    world.drainEvents();
    world.drainUncoveredChunks();
  }
  return world;
}

/** Wrap every layer's `update` so a frame can be attributed to the layer that spent it. */
function instrument(scene: GameScene, spent: Map<string, number>): void {
  const names = [
    'terrainLayer', 'riverLayer', 'influence', 'landUse', 'settlementPotential',
    'roads', 'sites', 'frontier', 'settlements', 'villagers', 'debug', 'hud',
  ];
  const owner = scene as unknown as Record<string, Layer | undefined>;

  for (const name of names) {
    const layer = owner[name];
    if (!layer || typeof layer.update !== 'function') continue;
    const original = layer.update.bind(layer);
    layer.update = (...args: never[]) => {
      const started = performance.now();
      const result = original(...args);
      spent.set(name, (spent.get(name) ?? 0) + (performance.now() - started));
      return result;
    };
  }
}

say(`building a ${days}-day world on seed ${seed}…`);

// Yield once, so the message paints before the build blocks the thread. A
// timeout rather than a frame: a tab that is not compositing never gets a
// frame, and the bench should still build and report there.
window.setTimeout(() => {
  const built = performance.now();
  const world = buildWorld();
  const buildMs = performance.now() - built;

  const scene = new GameScene({ width: world.width, height: world.height, seed, village: { name: '', x: 0, y: 0 }, startingPopulation: 0 });
  // The scene builds its own world from the config it was handed, so the one
  // just fast-forwarded has to replace it the moment the scene exists.
  const ready = (): void => {
    (scene as unknown as { world: World }).world = world;
  };

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: UNEXPLORED_COLOR,
    antialias: true,
    scale: {
      mode: Phaser.Scale.NONE,
      autoCenter: Phaser.Scale.NO_CENTER,
      width: Math.max(window.innerWidth, 320),
      height: Math.max(window.innerHeight, 240),
    },
    scene: [scene],
  });

  const spent = new Map<string, number>();
  let frames = 0;
  let simMs = 0;
  let frameMs = 0;

  game.events.once(Phaser.Core.Events.READY, ready);

  scene.events.once(Phaser.Scenes.Events.CREATE, () => {
    instrument(scene, spent);

    const simOwner = scene as unknown as { world: World };
    const originalUpdate = simOwner.world.update.bind(simOwner.world);
    simOwner.world.update = (dt: number) => {
      const started = performance.now();
      originalUpdate(dt);
      simMs += performance.now() - started;
    };

    const sceneUpdate = scene.update.bind(scene);
    scene.update = (time: number, delta: number) => {
      const started = performance.now();
      sceneUpdate(time, delta);
      frameMs += performance.now() - started;
      frames++;
    };

    window.setTimeout(() => {
      spent.clear();
      frames = 0;
      simMs = 0;
      frameMs = 0;
      window.setTimeout(report, WINDOW * 1000);
    }, 1500);
  });

  function report(): void {
    const per = (ms: number): string => (ms / frames).toFixed(2).padStart(6);
    const rows = [...spent.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, ms]) => `  ${per(ms)} ms  ${name}`)
      .join('\n');

    const displayList = (scene as unknown as { children: { list: unknown[] } }).children.list.length;

    say(
      [
        `seed ${seed} · day ${world.day} · built in ${(buildMs / 1000).toFixed(1)}s`,
        `pop ${world.villagers.length} · nodes ${world.nodes.length} · roads ${world.network.edges.length} · places ${world.settlements.length + 1}`,
        `display list ${displayList}`,
        '',
        `${(frames / WINDOW).toFixed(1)} fps over ${frames} frames`,
        `${per(frameMs)} ms  scene.update total`,
        `${per(simMs)} ms    of which simulation`,
        '',
        rows,
      ].join('\n'),
    );
  }
}, 50);
