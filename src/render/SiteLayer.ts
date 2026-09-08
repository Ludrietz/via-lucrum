import Phaser from 'phaser';
import type { ResourceNode } from '../sim/resourceNode';
import type { Site } from '../sim/roadNetwork';
import { NodeState, SiteType } from '../sim/types';
import type { World } from '../sim/world';
import { COLORS, DEPTH, FONT_FAMILY, RESOURCE_COLORS, SITE_COLORS } from './theme';

interface NodeView {
  node: ResourceNode;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  status: Phaser.GameObjects.Graphics;
  ring: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  drawnState: NodeState | null;
  scale: number;
}

/** Village and resource nodes: the readable layer on top of the terrain. */
export class SiteLayer {
  private readonly views: NodeView[] = [];
  private readonly village: Phaser.GameObjects.Container;
  private readonly villageBody: Phaser.GameObjects.Graphics;
  private readonly villageRing: Phaser.GameObjects.Graphics;
  private drawnLevel = 0;
  private villageScale = 1;

  private hovered: Site | null = null;

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {
    const v = world.village;
    this.village = scene.add.container(v.position.x, v.position.y).setDepth(DEPTH.sites);

    this.villageRing = scene.add.graphics();
    this.villageRing.lineStyle(2, COLORS.ink, 0.45);
    this.villageRing.strokeCircle(0, 0, v.radius + 12);
    this.villageRing.alpha = 0;
    this.village.add(this.villageRing);

    this.villageBody = scene.add.graphics();
    this.village.add(this.villageBody);

    const label = scene.add.text(0, v.radius + 20, v.name.toUpperCase(), {
      fontFamily: FONT_FAMILY,
      fontSize: '14px',
      color: '#3a3125',
    });
    label.setLetterSpacing(3).setOrigin(0.5, 0).setAlpha(0.85);
    this.village.add(label);

    for (const node of world.nodes) this.views.push(this.createNodeView(node));
  }

  setHovered(site: Site | null): void {
    this.hovered = site;
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-12 * dt);

    if (this.drawnLevel !== this.world.village.level) {
      this.drawnLevel = this.world.village.level;
      this.drawVillage();
    }

    const villageTarget = this.hovered === this.world.village ? 1.1 : 1;
    this.villageScale += (villageTarget - this.villageScale) * k;
    this.village.setScale(this.villageScale);
    this.villageRing.alpha += ((this.hovered === this.world.village ? 1 : 0) - this.villageRing.alpha) * k;

    for (const view of this.views) {
      const { node } = view;
      view.container.setVisible(node.isVisible);
      if (!node.isVisible) continue;

      if (view.drawnState !== node.state) {
        view.drawnState = node.state;
        this.drawNode(view);
      }

      const target = this.hovered === node ? 1.12 : 1;
      view.scale += (target - view.scale) * k;
      view.container.setScale(view.scale);
      view.ring.alpha += ((this.hovered === node ? 1 : 0) - view.ring.alpha) * k;

      this.drawStatus(view);
    }
  }

  // ------------------------------------------------------------------ village

  /** The keep gains outbuildings as the settlement levels up. */
  private drawVillage(): void {
    const g = this.villageBody;
    const level = this.world.village.level;
    const r = this.world.village.radius;

    g.clear();
    g.fillStyle(COLORS.ink, 0.1);
    g.fillCircle(2, 3.5, r + 2);

    // Outbuildings first, so the keep sits on top of them.
    const houses = (level - 1) * 2;
    for (let i = 0; i < houses; i++) {
      const angle = -Math.PI / 2 + (i + 0.5) * ((Math.PI * 2) / Math.max(houses, 1));
      const hx = Math.cos(angle) * (r + 13);
      const hy = Math.sin(angle) * (r + 13);

      g.fillStyle(COLORS.parchmentLight, 1);
      g.fillRect(hx - 6, hy - 4, 12, 9);
      g.lineStyle(2, COLORS.village, 1);
      g.strokeRect(hx - 6, hy - 4, 12, 9);
      g.fillStyle(COLORS.village, 1);
      g.fillTriangle(hx - 7.5, hy - 4, hx + 7.5, hy - 4, hx, hy - 10);
    }

    g.fillStyle(COLORS.parchmentLight, 1);
    g.fillCircle(0, 0, r);
    g.lineStyle(5, COLORS.village, 1);
    g.strokeCircle(0, 0, r);

    // Keep with battlements.
    g.fillStyle(COLORS.village, 1);
    g.fillRect(-10, -4, 20, 14);
    g.fillRect(-11, -10, 5, 7);
    g.fillRect(-2.5, -10, 5, 7);
    g.fillRect(6, -10, 5, 7);
    g.fillStyle(COLORS.parchmentLight, 1);
    g.fillRect(-2.5, 1, 5, 9);
  }

  // -------------------------------------------------------------------- nodes

  private createNodeView(node: ResourceNode): NodeView {
    const container = this.scene.add
      .container(node.position.x, node.position.y)
      .setDepth(DEPTH.sites)
      .setVisible(false);

    const ring = this.scene.add.graphics();
    ring.lineStyle(2, COLORS.ink, 0.45);
    ring.strokeCircle(0, 0, node.radius + 11);
    ring.alpha = 0;
    container.add(ring);

    const body = this.scene.add.graphics();
    container.add(body);

    const status = this.scene.add.graphics();
    container.add(status);

    const label = this.scene.add.text(0, node.radius + 16, node.name.toUpperCase(), {
      fontFamily: FONT_FAMILY,
      fontSize: '12px',
      color: '#3a3125',
    });
    label.setLetterSpacing(2.5).setOrigin(0.5, 0).setAlpha(0.75);
    container.add(label);

    return { node, container, body, status, ring, label, drawnState: null, scale: 1 };
  }

  private drawNode(view: NodeView): void {
    const { node, body } = view;
    const color = SITE_COLORS[node.type];
    const r = node.radius;
    const waiting = node.state === NodeState.Reachable;

    body.clear();
    view.container.setAlpha(waiting ? 0.62 : 1);
    view.label.setAlpha(waiting ? 0.5 : 0.75);

    body.fillStyle(COLORS.ink, 0.09);
    body.fillCircle(1.5, 3, r + 2);

    body.fillStyle(COLORS.parchmentLight, 1);
    body.fillCircle(0, 0, r);

    if (waiting) {
      // Unconnected sites read as an invitation: a dashed outline, not a wall.
      const segments = 22;
      body.lineStyle(3, color, 0.85);
      for (let i = 0; i < segments; i += 2) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        body.beginPath();
        body.arc(0, 0, r, a0, a1, false);
        body.strokePath();
      }
    } else {
      body.lineStyle(4, color, 1);
      body.strokeCircle(0, 0, r);
    }

    this.drawGlyph(body, node.type, color);
  }

  private drawGlyph(g: Phaser.GameObjects.Graphics, type: SiteType, color: number): void {
    switch (type) {
      case SiteType.Forest:
        g.fillStyle(color, 1);
        g.fillTriangle(0, -11, -8, 4, 8, 4);
        g.fillTriangle(-8, -2, -14, 8, -2, 8);
        g.fillTriangle(8, -2, 2, 8, 14, 8);
        break;

      case SiteType.Mine:
        g.lineStyle(3, color, 1);
        g.lineBetween(-9, -8, 9, 8);
        g.lineBetween(9, -8, -9, 8);
        g.fillStyle(color, 1);
        g.fillCircle(-9, -8, 2.4);
        g.fillCircle(9, -8, 2.4);
        break;

      case SiteType.Quarry:
        // Stacked cut blocks.
        g.fillStyle(color, 1);
        g.fillRect(-11, 0, 10, 8);
        g.fillRect(1, 0, 10, 8);
        g.fillRect(-5, -9, 10, 8);
        break;

      case SiteType.Farm:
        // A sheaf: stalks tied at the waist.
        g.lineStyle(2.5, color, 1);
        g.lineBetween(0, 9, 0, -10);
        g.lineBetween(0, 2, -8, -9);
        g.lineBetween(0, 2, 8, -9);
        g.lineStyle(3, color, 1);
        g.lineBetween(-6, 4, 6, 4);
        break;

      default:
        break;
    }
  }

  /** Per-frame bits: stored goods and the production ring. */
  private drawStatus(view: NodeView): void {
    const { node, status } = view;
    status.clear();
    if (!node.isConnected) return;

    if (node.workers.length > 0) {
      const sweep = node.workProgress * Math.PI * 2;
      status.lineStyle(2.5, SITE_COLORS[node.type], 0.28);
      status.strokeCircle(0, 0, node.radius + 6);
      status.lineStyle(2.5, SITE_COLORS[node.type], 0.8);
      status.beginPath();
      status.arc(0, 0, node.radius + 6, -Math.PI / 2, -Math.PI / 2 + sweep, false);
      status.strokePath();
    }

    // Goods waiting for collection, stacked above the node.
    const color = RESOURCE_COLORS[node.resource];
    for (let i = 0; i < node.stored; i++) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      status.fillStyle(color, 0.9);
      status.fillRect(-16 + col * 9, -node.radius - 14 - row * 9, 6, 6);
    }
  }
}
