import Phaser from 'phaser';
import { UNEXPLORED_COLOR } from './render/CameraController';
import { GameScene } from './render/GameScene';

/**
 * The canvas always fills the window. Sizing is driven explicitly rather than
 * by parent measurement, which can resolve to zero before first layout.
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
  scene: [GameScene],
});

function fitToWindow(): void {
  game.scale.resize(Math.max(window.innerWidth, 320), Math.max(window.innerHeight, 240));
}

window.addEventListener('resize', fitToWindow);
// A tab that booted while hidden can report a zero-sized window; re-fit once
// it becomes visible again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) fitToWindow();
});
