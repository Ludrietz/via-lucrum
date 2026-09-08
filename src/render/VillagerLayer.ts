import Phaser from 'phaser';
import { SiteType, VillagerRole } from '../sim/types';
import { WALK_SPEED, type Villager } from '../sim/villager';
import type { World } from '../sim/world';
import { COLORS, DEPTH, RESOURCE_COLORS, SITE_COLORS } from './theme';

interface VillagerView {
  villager: Villager;
  container: Phaser.GameObjects.Container;
  gfx: Phaser.GameObjects.Graphics;
  key: string;
  /** Stride phase, advanced by how fast this villager is actually moving. */
  phase: number;
}

/**
 * The people. Workers make one journey and then stay put at their site;
 * transporters shuttle. Both are drawn the same size so the difference the
 * player reads is behaviour, not iconography.
 */
export class VillagerLayer {
  private readonly views = new Map<number, VillagerView>();

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {}

  update(dt: number): void {

    for (const villager of this.world.village.villagers) {
      const view = this.views.get(villager.id) ?? this.createView(villager);

      const key = this.appearanceKey(villager);
      if (key !== view.key) {
        view.key = key;
        this.draw(view);
      }

      view.phase += dt * 13 * (villager.isWalking ? villager.speed / WALK_SPEED : 0);
      const bob = villager.isWalking ? Math.sin(view.phase + villager.id * 1.7) * 1.1 : 0;
      view.container.setPosition(villager.position.x, villager.position.y + bob);
      view.container.setAlpha(villager.role === VillagerRole.Idle ? 0.55 : 1);
    }
  }

  private appearanceKey(villager: Villager): string {
    const site = villager.workplace?.type ?? SiteType.Village;
    return `${villager.role}:${site}:${villager.cargo?.resource ?? '-'}`;
  }

  private createView(villager: Villager): VillagerView {
    const container = this.scene.add
      .container(villager.position.x, villager.position.y)
      .setDepth(DEPTH.villagers);
    const gfx = this.scene.add.graphics();
    container.add(gfx);

    const view: VillagerView = { villager, container, gfx, key: '', phase: 0 };
    this.views.set(villager.id, view);
    return view;
  }

  private draw(view: VillagerView): void {
    const { villager, gfx } = view;
    const g = gfx;
    g.clear();

    const color =
      villager.role === VillagerRole.Worker && villager.workplace
        ? SITE_COLORS[villager.workplace.type]
        : villager.role === VillagerRole.Idle
          ? COLORS.inkSoft
          : COLORS.ink;

    g.fillStyle(COLORS.ink, 0.12);
    g.fillEllipse(0, 6, 11, 4);

    // Cloak and head: just enough shape to read as a person at map scale.
    g.fillStyle(COLORS.parchmentLight, 1);
    g.fillTriangle(0, -3, -4.5, 6, 4.5, 6);
    g.lineStyle(1.6, color, 1);
    g.beginPath();
    g.moveTo(-4.5, 6);
    g.lineTo(0, -3);
    g.lineTo(4.5, 6);
    g.strokePath();

    g.fillStyle(color, 1);
    g.fillCircle(0, -5.5, 2.6);

    if (villager.cargo) {
      const crate = RESOURCE_COLORS[villager.cargo.resource];
      g.fillStyle(crate, 1);
      g.fillRect(-4, -13, 8, 6);
      g.lineStyle(1, COLORS.parchmentLight, 0.9);
      g.strokeRect(-4, -13, 8, 6);
    }
  }
}
