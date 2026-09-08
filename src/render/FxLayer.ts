import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import { TIER_LABELS } from '../sim/tier';
import type { WorldEvent } from '../sim/types';
import { COLORS, DEPTH, FONT_FAMILY, RESOURCE_COLORS, RESOURCE_LABELS } from './theme';

/** Short, quiet feedback for things the simulation just did. */
export class FxLayer {
  constructor(private readonly scene: Phaser.Scene) {}

  handle(events: WorldEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'discovered':
          this.pulse(event.at, 46, COLORS.influence, 900);
          this.floatingText(event.at, event.name.toUpperCase(), COLORS.inkSoft, 44);
          break;

        case 'connected':
          this.pulse(event.at, 34, COLORS.roadCasing, 650);
          break;

        case 'workerArrived':
          this.pulse(event.at, 30, RESOURCE_COLORS[event.resource], 700);
          break;

        case 'pickup':
          this.pulse(event.at, 26, RESOURCE_COLORS[event.resource], 600);
          break;

        case 'deposit':
          this.floatingText(
            event.at,
            `+${event.amount} ${RESOURCE_LABELS[event.resource]}`,
            RESOURCE_COLORS[event.resource],
            30,
          );
          break;

        case 'villagerBorn':
          this.floatingText(event.at, '+1 VILLAGER', COLORS.inkSoft, 20);
          break;

        case 'tierUp':
          this.pulse(event.at, 90, COLORS.influence, 1400);
          this.floatingText(event.at, `${event.name.toUpperCase()} IS NOW A ${TIER_LABELS[event.tier]}`, COLORS.ink, 56);
          break;

        case 'roadLost':
          this.fadingRoad(event.points);
          break;

        case 'roadBuilt':
          break;
      }
    }
  }

  /** A road grown over: its ghost lingers a moment so the loss is legible. */
  private fadingRoad(points: Vec2[]): void {
    if (points.length < 2) return;

    const g = this.scene.add.graphics().setDepth(DEPTH.roads);
    g.lineStyle(5, COLORS.road, 1);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    g.strokePath();

    this.scene.tweens.add({
      targets: g,
      alpha: { from: 0.55, to: 0 },
      duration: 1800,
      ease: 'Cubic.In',
      onComplete: () => g.destroy(),
    });
  }

  private floatingText(at: Vec2, text: string, color: number, rise: number): void {
    const label = this.scene.add.text(at.x, at.y - rise, text, {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      color: Phaser.Display.Color.IntegerToColor(color).rgba,
    });
    label.setLetterSpacing(2).setOrigin(0.5, 1).setDepth(DEPTH.fx);

    this.scene.tweens.add({
      targets: label,
      y: label.y - 30,
      alpha: { from: 1, to: 0 },
      duration: 1600,
      ease: 'Cubic.Out',
      onComplete: () => label.destroy(),
    });
  }

  private pulse(at: Vec2, radius: number, color: number, duration: number): void {
    const ring = this.scene.add.graphics().setDepth(DEPTH.fx);
    ring.lineStyle(2, color, 1);
    ring.strokeCircle(0, 0, radius);
    ring.setPosition(at.x, at.y);

    this.scene.tweens.add({
      targets: ring,
      scale: { from: 0.55, to: 1.25 },
      alpha: { from: 0.6, to: 0 },
      duration,
      ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
    });
  }
}
