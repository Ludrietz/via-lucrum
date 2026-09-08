import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import type { Settlement } from '../sim/settlement';
import type { Site } from '../sim/roadNetwork';
import { Tier } from '../sim/tier';
import type { World } from '../sim/world';
import { COLORS, DEPTH, FONT_FAMILY, TRADE_COLORS } from './theme';

interface SettlementView {
  settlement: Settlement;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  ring: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  key: string;
  scale: number;
}

/**
 * Places that grew on the network. Their look says two things at a glance:
 * how far along they are (one hut, a cluster, a proper village with a hall)
 * and what they live on (the colour of their trade).
 */
export class SettlementLayer {
  private readonly views = new Map<number, SettlementView>();
  private hovered: Site | null = null;

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {}

  setHovered(site: Site | null): void {
    this.hovered = site;
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-12 * dt);

    for (const settlement of this.world.settlements) {
      const view = this.views.get(settlement.id) ?? this.createView(settlement);

      const key = `${settlement.tier}:${settlement.trade.key}:${settlement.name}`;
      if (key !== view.key) {
        view.key = key;
        this.draw(view);
      }

      const target = this.hovered === settlement ? 1.12 : 1;
      view.scale += (target - view.scale) * k;
      view.container.setScale(view.scale);
      view.ring.alpha += ((this.hovered === settlement ? 1 : 0) - view.ring.alpha) * k;
    }
  }

  private createView(settlement: Settlement): SettlementView {
    const container = this.scene.add
      .container(settlement.position.x, settlement.position.y)
      .setDepth(DEPTH.sites - 1);

    const ring = this.scene.add.graphics();
    ring.lineStyle(2, COLORS.ink, 0.45);
    ring.strokeCircle(0, 0, settlement.radius + 12);
    ring.alpha = 0;
    container.add(ring);

    const body = this.scene.add.graphics();
    container.add(body);

    const label = this.scene.add.text(0, settlement.radius + 12, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: '#3a3125',
    });
    label.setLetterSpacing(2.5).setOrigin(0.5, 0).setAlpha(0.8);
    container.add(label);

    const view: SettlementView = { settlement, container, body, ring, label, key: '', scale: 1 };
    this.views.set(settlement.id, view);
    this.draw(view);
    return view;
  }

  private draw(view: SettlementView): void {
    const { settlement, body } = view;
    const color = TRADE_COLORS[settlement.trade.key] ?? COLORS.inkSoft;

    body.clear();
    view.label.setText(settlement.tier === Tier.Hamlet ? '' : settlement.name.toUpperCase());
    view.label.setY(settlement.radius + 12);

    switch (settlement.tier) {
      case Tier.Hamlet:
        // A hut set just off the verge: the first sign anyone stopped here.
        this.hut(body, { x: 11, y: -7 }, 7, color);
        break;

      case Tier.Village:
        this.hut(body, { x: -13, y: -9 }, 7.5, color);
        this.hut(body, { x: 6, y: -13 }, 7, color);
        this.hut(body, { x: 13, y: 5 }, 7.5, color);
        break;

      // Town, City and Major City share the fuller cluster; the drawn size
      // (and everything else about the place) keeps climbing with them.
      case Tier.Town:
      case Tier.City:
      case Tier.MajorCity:
      default:
        this.hut(body, { x: -19, y: -8 }, 8, color);
        this.hut(body, { x: -6, y: -18 }, 7.5, color);
        this.hut(body, { x: 17, y: -10 }, 8, color);
        this.hut(body, { x: 15, y: 8 }, 7.5, color);
        this.hut(body, { x: -14, y: 10 }, 7, color);
        this.hall(body, { x: 0, y: 2 }, color);
        break;
    }
  }

  /** A gable end: two walls and a roof, which is all it needs to read. */
  private hut(g: Phaser.GameObjects.Graphics, at: Vec2, s: number, color: number): void {
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
  private hall(g: Phaser.GameObjects.Graphics, at: Vec2, color: number): void {
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
}
