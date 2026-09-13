import Phaser from 'phaser';
import type { ResourceNode } from '../sim/resourceNode';
import type { World } from '../sim/world';
import { COLORS, DEPTH, FONT_FAMILY, RESOURCE_COLORS, RESOURCE_LABELS } from './theme';

/**
 * The country beyond the border, at two levels of attention.
 *
 * **Surveyed** sites are everywhere the realm has learned about and does not
 * own (see `survey.ts`): a small, quiet notation in the resource's colour,
 * unpriced, the way a real map carries a symbol for a deposit somebody once
 * rode past. They exist so the player can have an opinion about which way to
 * grow. Before they were drawn, the survey was real in the simulation and
 * completely invisible in the game, which is the same as not existing.
 *
 * **Offered** sites are the handful the frontier is actually holding up right
 * now, and they are drawn deliberately unlike anything the civilisation owns:
 * an outlined diamond sitting *outside* the border, carrying a price. The
 * reading should be "that is out there, and it would cost this much" rather
 * than "that is one of ours that happens to be idle" — the whole redesign
 * turns on the player feeling the difference between seeing an opportunity
 * and having taken it.
 *
 * Keeping both here rather than splitting a second layer off is deliberate:
 * they are the same fact at two intensities, and a site crossing between them
 * should visibly *promote*, not disappear from one layer and pop into
 * another.
 */
const MARKER_RADIUS = 13;
/** How far above the marker the cost sits. */
const COST_OFFSET = 30;
/** A merely-surveyed site is a small notation, not a marker demanding attention. */
const SURVEYED_RADIUS = 7;

interface Marker {
  node: ResourceNode;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  cost: Phaser.GameObjects.Text;
  label: Phaser.GameObjects.Text;
  drawnCost: number;
  drawnAffordable: boolean | null;
  scale: number;
  pulse: number;
}

export class FrontierLayer {
  private readonly markers = new Map<number, Marker>();
  private hovered: ResourceNode | null = null;

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {}

  setHovered(node: ResourceNode | null): void {
    this.hovered = node;
  }

  update(dt: number): void {
    const offered = new Map(this.world.frontier.map((c) => [c.node.id, c]));

    // Everything out there the realm knows of: what it is being offered, plus
    // everywhere it has merely surveyed. A claimed site drops out — that one
    // belongs to `SiteLayer`, drawn as a working part of the civilisation.
    const shown = new Set(offered.keys());
    for (const node of this.world.nodes) {
      if (node.surveyed && !node.isClaimed) shown.add(node.id);
    }

    // Surveyed country is monotone, so in practice only a claim removes a
    // marker — but an offer that lapses back to a plain surveyed site still
    // has to be redrawn at the quieter intensity, which the `drawnAffordable`
    // check below picks up.
    for (const [id, marker] of this.markers) {
      if (shown.has(id)) continue;
      marker.container.destroy();
      this.markers.delete(id);
    }

    const k = 1 - Math.exp(-12 * dt);
    const byId = new Map(this.world.nodes.map((n) => [n.id, n]));

    for (const id of shown) {
      const node = byId.get(id);
      if (!node) continue;
      const candidate = offered.get(id);

      let marker = this.markers.get(id);
      if (!marker) {
        marker = this.create(node);
        this.markers.set(id, marker);
      }

      const cost = candidate?.cost ?? -1;
      const affordable = candidate ? this.world.expansionCapacity >= candidate.cost : false;
      if (marker.drawnCost !== cost || marker.drawnAffordable !== affordable) {
        marker.drawnCost = cost;
        marker.drawnAffordable = affordable;
        this.draw(marker, affordable, candidate !== undefined);
        marker.cost.setText(candidate ? String(candidate.cost) : '');
        marker.cost.setColor(affordable ? '#3a3125' : '#8b8272');
        // A surveyed site is a note on the map, not a call to action: its
        // name stays faint until the frontier actually offers it.
        marker.label.setAlpha(candidate ? 0.9 : 0.4);
      }

      const target = this.hovered === node ? 1.18 : 1;
      marker.scale += (target - marker.scale) * k;

      // Anything the realm could afford right now breathes gently, so a
      // player who has banked enough capacity notices without being told.
      marker.pulse += dt;
      const breath = affordable ? 1 + Math.sin(marker.pulse * 2.2) * 0.045 : 1;
      marker.container.setScale(marker.scale * breath);
    }
  }

  private create(node: ResourceNode): Marker {
    const container = this.scene.add.container(node.position.x, node.position.y).setDepth(DEPTH.sites - 1);

    const body = this.scene.add.graphics();
    container.add(body);

    const cost = this.scene.add.text(0, -COST_OFFSET, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      color: '#3a3125',
    });
    cost.setOrigin(0.5).setLetterSpacing(1);
    container.add(cost);

    const label = this.scene.add.text(0, MARKER_RADIUS + 8, RESOURCE_LABELS[node.resource], {
      fontFamily: FONT_FAMILY,
      fontSize: '9px',
      color: '#6b5f4b',
    });
    label.setOrigin(0.5, 0).setLetterSpacing(2).setAlpha(0.9);
    container.add(label);

    return { node, container, body, cost, label, drawnCost: -1, drawnAffordable: null, scale: 1, pulse: 0 };
  }

  /**
   * A diamond rather than the circle every owned site uses, outlined rather
   * than filled — unclaimed ground reads as a marking on the map, not as a
   * working part of the civilisation.
   */
  private draw(marker: Marker, affordable: boolean, offered: boolean): void {
    const g = marker.body;
    g.clear();

    const tint = RESOURCE_COLORS[marker.node.resource];

    // Surveyed but not offered: a small open ring with a dot, at low weight.
    // Deliberately a different *shape family* from both the owned circle and
    // the offered diamond, and small enough that thirty of them across the
    // map read as annotation rather than as thirty things demanding a
    // decision. What the player should take from it is "there is iron that
    // way", which is exactly as much as the realm actually knows.
    if (!offered) {
      const rs = SURVEYED_RADIUS;
      g.lineStyle(1.6, tint, 0.42);
      g.strokeCircle(0, 0, rs);
      g.fillStyle(tint, 0.34);
      g.fillCircle(0, 0, 2.2);
      return;
    }

    const r = MARKER_RADIUS;
    const points = [
      { x: 0, y: -r },
      { x: r, y: 0 },
      { x: 0, y: r },
      { x: -r, y: 0 },
    ];

    g.fillStyle(COLORS.parchmentLight, affordable ? 0.9 : 0.55);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
    g.fillPath();

    g.lineStyle(affordable ? 2.4 : 1.4, tint, affordable ? 0.95 : 0.5);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
    g.strokePath();

    g.fillStyle(tint, affordable ? 0.95 : 0.45);
    g.fillCircle(0, 0, 3.4);
  }
}
