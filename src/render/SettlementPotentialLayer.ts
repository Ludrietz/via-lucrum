import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import type { World } from '../sim/world';
import { COLORS, DEPTH } from './theme';

/** Below this, a candidate patch is too faint to be worth showing at all. */
const VISIBILITY_FLOOR = 0.15;
const REDRAW_INTERVAL = 0.15;
const PULSE_SPEED = 1.6;
const RINGS = 4;

/**
 * A soft glow over ground that's quietly building toward becoming a
 * settlement, so a promising junction reads as something the player is
 * steering rather than a surprise that appears out of nowhere. Reuses the
 * same potential scoring `world.watchedSites` already computes to decide
 * when a place actually founds — this just makes it visible beforehand.
 */
export class SettlementPotentialLayer {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private time = 0;
  private sinceRedraw = 0;

  constructor(scene: Phaser.Scene, private readonly world: World) {
    this.gfx = scene.add.graphics().setDepth(DEPTH.settlementPotential);
  }

  update(dt: number): void {
    this.time += dt;
    this.sinceRedraw += dt;
    if (this.sinceRedraw < REDRAW_INTERVAL) return;
    this.sinceRedraw = 0;
    this.draw();
  }

  private draw(): void {
    const g = this.gfx;
    g.clear();

    for (const candidate of this.world.watchedSites) {
      if (candidate.potential < VISIBILITY_FLOOR) continue;

      // Deterministic per-patch phase offset, so nearby candidates don't
      // all pulse in lockstep.
      const pulse = 0.85 + 0.15 * Math.sin(this.time * PULSE_SPEED + candidate.patch * 0.7);
      const radius = (18 + candidate.potential * 46) * pulse;
      const alpha = Math.min(0.5, candidate.potential * 0.6) * pulse;

      this.glow(g, candidate.position, radius, alpha);
    }
  }

  /** Cheap concentric-ring glow — no shader, just a few soft fades stacked up. */
  private glow(g: Phaser.GameObjects.Graphics, at: Vec2, radius: number, alpha: number): void {
    for (let i = RINGS; i >= 1; i--) {
      const t = i / RINGS;
      g.fillStyle(COLORS.influence, alpha * (1 - t) * 0.5);
      g.fillCircle(at.x, at.y, radius * t);
    }
  }
}
