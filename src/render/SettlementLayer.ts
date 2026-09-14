import Phaser from 'phaser';
import type { Settlement } from '../sim/settlement';
import type { Site } from '../sim/roadNetwork';
import { Tier } from '../sim/tier';
import type { World } from '../sim/world';
import { drawSettlementIcon } from './settlementIcons';
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
 * Zoom at and below which the map stops being a place you walk and starts
 * being a map you read.
 *
 * Pulled back far enough to see the shape of a realm, every settlement was a
 * few pixels of ink and a major city looked exactly like a hamlet — so the one
 * view that should answer "where are my towns, and which are the big ones"
 * answered neither. Below this, markers stop shrinking with the world and
 * start standing *for* a place instead of drawing one.
 */
const MAP_ZOOM = 0.55;

/**
 * How much of the eye a place of each rung is entitled to when the map is read
 * rather than walked. This is the point of the mode: at a glance, the big dots
 * are the cities.
 */
const TIER_PROMINENCE: Record<Tier, number> = {
  [Tier.Hamlet]: 0.75,
  [Tier.Village]: 1,
  [Tier.Town]: 1.35,
  [Tier.City]: 1.7,
  [Tier.MajorCity]: 2.1,
};

/** How far a marker may grow past its drawn size, so a dense realm stays readable. */
const MAX_MARKER_SCALE = 4;

/**
 * How much a place is magnified at the current zoom — 1 while the map is being
 * walked, growing as it is pulled back, and weighted by rank. Exported because
 * the hit target has to grow with the marker or the bigger dot would not be
 * clickable where it is drawn (see GameScene).
 */
export function markerScale(tier: Tier, zoom: number): number {
  if (zoom >= MAP_ZOOM) return 1;
  const pull = (MAP_ZOOM / Math.max(0.02, zoom)) ** 0.8;
  return Math.min(MAX_MARKER_SCALE, Math.max(1, pull * TIER_PROMINENCE[tier]));
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

  update(dt: number, zoom = 1): void {
    const k = 1 - Math.exp(-12 * dt);

    for (const settlement of this.world.settlements) {
      const view = this.views.get(settlement.id) ?? this.createView(settlement);

      const key = `${settlement.tier}:${settlement.trade.key}:${settlement.name}`;
      if (key !== view.key) {
        view.key = key;
        this.draw(view);
      }

      const target = markerScale(settlement.tier, zoom) * (this.hovered === settlement ? 1.12 : 1);
      view.scale += (target - view.scale) * k;
      view.container.setScale(view.scale);
      // A name is worth reading on a map and clutter underfoot. Hamlets stay
      // anonymous close up and are named once the view is wide enough that the
      // name is the only thing telling one dot from another.
      view.label.setAlpha(settlement.tier === Tier.Hamlet && zoom >= MAP_ZOOM ? 0 : 0.8);
      // The label rides at the marker's own scale, so it neither swells with
      // the icon nor shrinks away with the world.
      view.label.setScale(1 / view.scale);
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
    view.label.setText(settlement.name.toUpperCase());
    view.label.setY(settlement.radius + 12);

    drawSettlementIcon(body, settlement.tier, color);
  }
}
