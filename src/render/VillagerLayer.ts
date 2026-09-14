import Phaser from 'phaser';
import { REAL_SECONDS_PER_HOUR } from '../sim/scale';
import { SiteType, VillagerRole } from '../sim/types';
import { Convoy, WALK_SPEED, type Villager } from '../sim/villager';
import type { World } from '../sim/world';
import { COLORS, DEPTH, RESOURCE_COLORS, SITE_COLORS } from './theme';

interface VillagerView {
  villager: Villager;
  container: Phaser.GameObjects.Container;
  gfx: Phaser.GameObjects.Graphics;
  /**
   * The waggons, kept apart from the person so they can be turned.
   *
   * A person is drawn the same whichever way they are walking — at this size a
   * cloak has no front — but a cart is *behind* its driver, and behind depends
   * on where they are going. Drawn into the same object as the walker it would
   * have to be redrawn every frame to follow the heading; in its own object it
   * is drawn once and simply rotated.
   */
  loadGfx: Phaser.GameObjects.Graphics;
  key: string;
  /** Stride phase, advanced by the ground this villager actually covers. */
  phase: number;
  /** Where they were drawn last frame, so the stride can be paced off distance. */
  last: { x: number; y: number } | null;
  /** The pass this view was last matched to a living villager on. */
  seen: number;
}

/**
 * The people. Workers make one journey and then stay put at their site;
 * transporters shuttle. Both are drawn the same size so the difference the
 * player reads is behaviour, not iconography.
 */
/** How far outside the view a villager is still drawn, so nobody pops in at the edge. */
const CULL_MARGIN = 48;

/**
 * Radians of stride per world unit covered.
 *
 * Paced off distance rather than elapsed time on purpose. Time-paced legs
 * churn at the same rate whatever the body is doing, so they came adrift the
 * moment the simulation clock slowed (see scale.ts) and again
 * whenever a villager laboured up a hill. Distance-paced legs cannot: a
 * villager on a slow stretch of ground takes slower steps, and the speed
 * buttons quicken the walk without anyone's feet needing to be told.
 *
 * The figure is the cadence the game has always drawn — 13 rad/s at full pace
 * on level ground — restated per unit of ground so it survives a change of
 * clock.
 */
const STRIDE_PER_UNIT = 13 / (WALK_SPEED / REAL_SECONDS_PER_HOUR);
/** A jump bigger than this is a villager being re-placed, not walking. */
const STRIDE_MAX_STEP = 24;

export class VillagerLayer {
  private readonly views = new Map<number, VillagerView>();
  private pass = 0;

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {}

  update(): void {
    const pass = ++this.pass;
    const seen = this.scene.cameras.main.worldView;
    const left = seen.x - CULL_MARGIN;
    const right = seen.right + CULL_MARGIN;
    const top = seen.y - CULL_MARGIN;
    const bottom = seen.bottom + CULL_MARGIN;

    for (const villager of this.world.villagers) {
      const view = this.views.get(villager.id) ?? this.createView(villager);
      view.seen = pass;

      // Off-screen people are still simulated — they are simply not drawn.
      // Phaser skips an invisible object outright, and a realm of any size has
      // far more people walking country the camera is not looking at than in
      // front of it.
      const { x, y } = villager.position;
      const onScreen = x >= left && x <= right && y >= top && y <= bottom;
      view.container.setVisible(onScreen);
      if (!onScreen) continue;

      const key = this.appearanceKey(villager);
      if (key !== view.key) {
        view.key = key;
        this.draw(view);
      }

      const moved = view.last ? Math.hypot(x - view.last.x, y - view.last.y) : 0;
      if (view.last) {
        view.last.x = x;
        view.last.y = y;
      } else view.last = { x, y };
      // Local +y is drawn as "behind", so this turns the train to trail back
      // down the road its driver is coming along.
      view.loadGfx.setRotation(villager.heading + Math.PI / 2);
      if (villager.isWalking) view.phase += Math.min(moved, STRIDE_MAX_STEP) * STRIDE_PER_UNIT;
      const bob = villager.isWalking ? Math.sin(view.phase + villager.id * 1.7) * 1.1 : 0;
      view.container.setPosition(x, y + bob);
      view.container.setAlpha(villager.role === VillagerRole.Idle ? 0.55 : 1);
    }

    // People do leave — a shrinking place loses residents, and `World` takes
    // them off its roster. Nothing took their picture off the map with them,
    // so every departure left a motionless villager standing where they were
    // last seen, for the rest of the game.
    if (this.views.size > this.world.villagers.length) this.forgetDeparted(pass);
  }

  private forgetDeparted(pass: number): void {
    for (const [id, view] of this.views) {
      if (view.seen === pass) continue;
      view.container.destroy(true);
      this.views.delete(id);
    }
  }

  private appearanceKey(villager: Villager): string {
    const site = villager.workplace?.type ?? SiteType.Village;
    return `${villager.role}:${site}:${villager.cargo?.resource ?? '-'}:${villager.convoy}`;
  }

  private createView(villager: Villager): VillagerView {
    const container = this.scene.add
      .container(villager.position.x, villager.position.y)
      .setDepth(DEPTH.villagers);
    const loadGfx = this.scene.add.graphics();
    const gfx = this.scene.add.graphics();
    // Waggons behind the driver in the display list as well as on the ground.
    container.add(loadGfx);
    container.add(gfx);

    const view: VillagerView = { villager, container, gfx, loadGfx, key: '', phase: 0, last: null, seen: 0 };
    this.views.set(villager.id, view);
    return view;
  }

  private draw(view: VillagerView): void {
    const { villager, gfx } = view;
    const g = gfx;
    g.clear();
    view.loadGfx.clear();

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

    if (villager.cargo) this.drawLoad(view, villager);
  }

  /**
   * What this person is moving goods *with*.
   *
   * A porter carries a crate on their back and is drawn as they always were.
   * A carter walks beside a two-wheeled cart; a caravaneer leads a train of
   * them. Which one appears is not a property of the person — it is the road
   * speaking (see `convoyFor`), and it is the one place in the game where the
   * state of a road is legible in something other than the road itself. A
   * player who sees waggons on a route knows that route is carrying the
   * realm, and knows it without reading a number.
   */
  private drawLoad(view: VillagerView, villager: Villager): void {
    const crate = RESOURCE_COLORS[villager.cargo!.resource];

    if (villager.convoy === Convoy.Porter) {
      const g = view.gfx;
      g.fillStyle(crate, 1);
      g.fillRect(-4, -13, 8, 6);
      g.lineStyle(1, COLORS.parchmentLight, 0.9);
      g.strokeRect(-4, -13, 8, 6);
      return;
    }

    // Waggons trail *behind* the walker, along the road they came down, so a
    // train reads as one thing moving rather than a row of separate carts.
    const g = view.loadGfx;
    const waggons = villager.convoy === Convoy.Caravan ? 3 : 1;
    for (let i = 0; i < waggons; i++) {
      const y = 9 + i * 9;

      g.fillStyle(COLORS.ink, 0.14);
      g.fillEllipse(0, y + 3.5, 12, 4);

      g.fillStyle(crate, 1);
      g.fillRect(-5, y - 4, 10, 7);
      g.lineStyle(1.2, COLORS.ink, 0.85);
      g.strokeRect(-5, y - 4, 10, 7);

      // Wheels, and the shaft up to whatever is pulling it.
      g.fillStyle(COLORS.ink, 0.9);
      g.fillCircle(-5.5, y + 3, 2.2);
      g.fillCircle(5.5, y + 3, 2.2);
      g.lineStyle(1.2, COLORS.ink, 0.7);
      g.beginPath();
      g.moveTo(0, y - 4);
      g.lineTo(0, y - 8);
      g.strokePath();
    }
  }
}
