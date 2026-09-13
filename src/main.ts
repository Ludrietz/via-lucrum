import Phaser from 'phaser';
import { UNEXPLORED_COLOR } from './render/CameraController';
import { GameScene } from './render/GameScene';
import { createWorldConfig, randomSeed } from './sim/map';
import { fetchPackWorldConfig } from './sim/packLoader';
import type { WorldConfig } from './sim/world';

/**
 * Deciding which world to play, and building the game around it.
 *
 * World construction moved up here from `GameScene.create` for one reason:
 * an authored map has to be fetched, fetching is asynchronous, and a Phaser
 * scene's `create` is not. Resolving the config before the game exists keeps
 * the whole simulation synchronous — see `packLoader.ts` — at the cost of
 * this file knowing about two kinds of world, which is a fair trade and the
 * only place in the codebase that has to.
 */

/**
 * `?seed=12345` reproduces an exact procedural world — point 23 of the
 * brief, and the whole reason `WorldGenerator` is a pure function of one
 * number in the first place. Anything else (missing, non-numeric) falls back
 * to a fresh random one; the seed actually used is always logged to the
 * console either way, so a map worth coming back to is never lost.
 */
function resolveSeed(params: URLSearchParams): number {
  const fromUrl = params.get('seed');
  if (fromUrl !== null) {
    const parsed = Number(fromUrl);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return randomSeed();
}

/** `?pack=test` plays the authored map in `public/maps/test.json` instead of a generated one. */
async function resolveWorldConfig(): Promise<WorldConfig> {
  const params = new URLSearchParams(window.location.search);

  const pack = params.get('pack');
  if (pack !== null && pack.length > 0) {
    const config = await fetchPackWorldConfig(pack);
    // eslint-disable-next-line no-console
    console.log(`Via Lucrum — map pack "${pack}" (${config.width} x ${config.height} units)`);
    return config;
  }

  const seed = resolveSeed(params);
  // eslint-disable-next-line no-console
  console.log(`Via Lucrum — world seed ${seed} (append ?seed=${seed} to reproduce this map)`);
  return createWorldConfig(seed);
}

/**
 * A pack that will not load is worth saying out loud, on the page. It is the
 * one failure here a person can actually fix — a typo in a hand-written map,
 * a village placed in a lake — and `packViability` went to the trouble of
 * listing exactly what is wrong with it.
 */
function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(error);
  const parent = document.getElementById('game');
  if (!parent) return;
  const box = document.createElement('pre');
  box.className = 'boot-error';
  box.textContent = message;
  parent.appendChild(box);
}

void resolveWorldConfig().then(
  (config) => {
    /**
     * The canvas always fills the window. Sizing is driven explicitly rather
     * than by parent measurement, which can resolve to zero before first
     * layout.
     */
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
      scene: [new GameScene(config)],
    });

    function fitToWindow(): void {
      game.scale.resize(Math.max(window.innerWidth, 320), Math.max(window.innerHeight, 240));
    }

    window.addEventListener('resize', fitToWindow);
    // A tab that booted while hidden can report a zero-sized window; re-fit
    // once it becomes visible again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) fitToWindow();
    });
  },
  (error: unknown) => reportFailure(error),
);
