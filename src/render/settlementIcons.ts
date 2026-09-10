import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import { Tier } from '../sim/tier';
import { COLORS } from './theme';

/**
 * The building cluster every place gets, grown into by tier — a settlement
 * that sprouted from traffic and the founding village are drawn by the
 * identical function, because they are the same kind of thing. Only the
 * colour changes between them.
 */
export function drawSettlementIcon(g: Phaser.GameObjects.Graphics, tier: Tier, color: number): void {
  switch (tier) {
    case Tier.Hamlet:
      // A hut set just off the verge: the first sign anyone stopped here.
      hut(g, { x: 11, y: -7 }, 7, color);
      break;

    case Tier.Village:
      hut(g, { x: -13, y: -9 }, 7.5, color);
      hut(g, { x: 6, y: -13 }, 7, color);
      hut(g, { x: 13, y: 5 }, 7.5, color);
      break;

    // Town, City and Major City share the fuller cluster; the drawn size
    // (and everything else about the place) keeps climbing with them.
    case Tier.Town:
    case Tier.City:
    case Tier.MajorCity:
    default:
      hut(g, { x: -19, y: -8 }, 8, color);
      hut(g, { x: -6, y: -18 }, 7.5, color);
      hut(g, { x: 17, y: -10 }, 8, color);
      hut(g, { x: 15, y: 8 }, 7.5, color);
      hut(g, { x: -14, y: 10 }, 7, color);
      hall(g, { x: 0, y: 2 }, color);
      break;
  }
}

/** A gable end: two walls and a roof, which is all it needs to read. */
function hut(g: Phaser.GameObjects.Graphics, at: Vec2, s: number, color: number): void {
  g.fillStyle(COLORS.ink, 0.12);
  g.fillEllipse(at.x + 1, at.y + s * 0.75, s * 2.1, s * 0.7);

  g.fillStyle(COLORS.parchmentLight, 1);
  g.fillRect(at.x - s * 0.6, at.y - s * 0.15, s * 1.2, s * 0.8);
  g.lineStyle(1.6, color, 1);
  g.strokeRect(at.x - s * 0.6, at.y - s * 0.15, s * 1.2, s * 0.8);

  g.fillStyle(color, 1);
  g.fillTriangle(at.x - s * 0.8, at.y - s * 0.15, at.x + s * 0.8, at.y - s * 0.15, at.x, at.y - s);
}

/** The moot hall, which only a proper settlement gets. */
function hall(g: Phaser.GameObjects.Graphics, at: Vec2, color: number): void {
  g.fillStyle(COLORS.ink, 0.14);
  g.fillEllipse(at.x + 1, at.y + 9, 26, 8);

  g.fillStyle(COLORS.parchmentLight, 1);
  g.fillRect(at.x - 9, at.y - 3, 18, 11);
  g.lineStyle(2, color, 1);
  g.strokeRect(at.x - 9, at.y - 3, 18, 11);

  g.fillStyle(color, 1);
  g.fillTriangle(at.x - 11, at.y - 3, at.x + 11, at.y - 3, at.x, at.y - 12);
  // A banner, so the centre of a settlement reads as its centre.
  g.fillRect(at.x - 0.8, at.y - 19, 1.6, 8);
  g.fillTriangle(at.x + 0.8, at.y - 19, at.x + 0.8, at.y - 14, at.x + 7, at.y - 16.5);
}
