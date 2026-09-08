import Phaser from 'phaser';
import type { World } from '../sim/world';
import { COLORS, DEPTH } from './theme';

/**
 * The reach of the civilisation. Deliberately not a range indicator: a warm
 * tint over settled land, fading out through a scatter of dots rather than
 * ending at a hard rim.
 */
export class InfluenceLayer {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private radius: number;
  private drawnRadius = -1;

  constructor(scene: Phaser.Scene, private readonly world: World) {
    this.gfx = scene.add.graphics().setDepth(DEPTH.influence);
    this.radius = world.village.influenceRadius;
  }

  update(dt: number): void {
    const target = this.world.village.influenceRadius;
    this.radius += (target - this.radius) * (1 - Math.exp(-3 * dt));

    // Redrawing a few hundred dots every frame is wasteful; only when it moves.
    if (Math.abs(this.radius - this.drawnRadius) < 0.4) return;
    this.drawnRadius = this.radius;
    this.draw();
  }

  private draw(): void {
    const g = this.gfx;
    const { x, y } = this.world.village.position;
    const r = this.radius;

    g.clear();

    // Settled ground: a couple of very soft, stacked washes.
    g.fillStyle(COLORS.influence, 0.05);
    g.fillCircle(x, y, r);
    g.fillStyle(COLORS.influence, 0.045);
    g.fillCircle(x, y, r * 0.72);
    g.fillStyle(COLORS.influence, 0.04);
    g.fillCircle(x, y, r * 0.42);

    // Frontier: dots that thin out instead of a drawn edge.
    const count = Math.round(r * 0.9);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      // Deterministic wobble so the frontier is ragged, not machined.
      const wobble = Math.sin(angle * 7.3) * 5 + Math.sin(angle * 3.1 + 1.2) * 8;
      const spread = ((i * 37) % 11) - 5;
      const dotRadius = r + wobble + spread;

      g.fillStyle(COLORS.influence, 0.16 + ((i * 13) % 7) * 0.03);
      g.fillCircle(x + Math.cos(angle) * dotRadius, y + Math.sin(angle) * dotRadius, 1.6);
    }
  }
}
