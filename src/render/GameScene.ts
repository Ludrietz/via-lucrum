import Phaser from 'phaser';
import { RoadDrawing } from '../input/RoadDrawing';

import type { ResourceNode } from '../sim/resourceNode';
import type { Site } from '../sim/roadNetwork';
import { World, type WorldConfig } from '../sim/world';
import { Hud } from '../ui/Hud';
import { SpeedControl } from '../ui/SpeedControl';
import { CameraController } from './CameraController';
import { DebugLayer } from './DebugLayer';
import { FrontierLayer } from './FrontierLayer';
import { FxLayer } from './FxLayer';
import { InfluenceLayer } from './InfluenceLayer';
import { RiverLayer } from './RiverLayer';
import { RoadLayer } from './RoadLayer';
import { SettlementLayer } from './SettlementLayer';
import { SettlementPotentialLayer } from './SettlementPotentialLayer';
import { SiteLayer } from './SiteLayer';
import { TerrainLayer } from './TerrainLayer';
import { VillagerLayer } from './VillagerLayer';

/**
 * Owns input and the render layers. All gameplay state lives in `World`;
 * this scene only reads it and draws it.
 */
export class GameScene extends Phaser.Scene {
  private world!: World;
  private camera!: CameraController;
  private terrainLayer!: TerrainLayer;
  private riverLayer!: RiverLayer;
  private influence!: InfluenceLayer;
  private settlementPotential!: SettlementPotentialLayer;
  private frontier!: FrontierLayer;
  private roads!: RoadLayer;
  private sites!: SiteLayer;
  private settlements!: SettlementLayer;
  private villagers!: VillagerLayer;
  private fx!: FxLayer;
  private debug!: DebugLayer;
  private hud!: Hud;
  private speedControl!: SpeedControl;

  private readonly drawing = new RoadDrawing();
  /** True while the right button is sweeping roads off the map. */
  private erasing = false;
  private hovered: Site | null = null;
  private selected: Site | null = null;
  /** Where on the network the cursor is, when it is over a road. */
  private hoveredRoadPoint: { x: number; y: number } | null = null;

  /**
   * The world is handed in already built, rather than constructed here.
   * `main.ts` owns that choice because an authored map has to be fetched
   * first — see the note there.
   */
  constructor(private readonly config: WorldConfig) {
    super('game');
  }

  create(): void {
    this.world = new World(this.config);
    // A handle on the simulation while developing, so the world can be poked
    // and inspected from the browser console. Stripped from a production
    // build by the bundler along with the branch itself.
    if (import.meta.env.DEV) (window as unknown as { world: World }).world = this.world;

    this.terrainLayer = new TerrainLayer(this, this.world);
    this.riverLayer = new RiverLayer(this, this.world);
    this.influence = new InfluenceLayer(this, this.world);
    this.settlementPotential = new SettlementPotentialLayer(this, this.world);
    this.roads = new RoadLayer(this, this.world);
    this.sites = new SiteLayer(this, this.world);
    this.frontier = new FrontierLayer(this, this.world);
    this.settlements = new SettlementLayer(this, this.world);
    this.villagers = new VillagerLayer(this, this.world);
    this.fx = new FxLayer(this);
    this.debug = new DebugLayer(this, this.world);
    this.hud = new Hud(this.world);
    this.speedControl = new SpeedControl(document.getElementById('timescale')!);

    this.camera = new CameraController(this, this.world.width, this.world.height);
    this.camera.centerOn(this.world.village.position);

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.onPointerUp, this);
    this.input.on(Phaser.Input.Events.GAME_OUT, () => this.cancelDrawing());
    this.input.keyboard?.on('keydown-D', () => this.debug.toggle());
    for (let n = 1; n <= 6; n++) {
      this.input.keyboard?.on(`keydown-${n}`, () => this.debug.setMode(n));
    }
    // The right button erases, so the browser menu has to stay out of the way.
    this.input.mouse?.disableContextMenu();

    // Handy while prototyping: poke at the simulation from the dev console.
    if (import.meta.env.DEV) {
      const globals = window as unknown as { world: World; scene: GameScene };
      globals.world = this.world;
      globals.scene = this;
    }
  }

  override update(_time: number, delta: number): void {
    const dt = delta / 1000;

    // Simulation speed runs the sim in extra steps of the same size rather
    // than a few huge ones, so every timer and cooldown inside it still sees
    // normal-sized ticks — nothing gets skipped, it just happens more often.
    // Rendering stays on the real frame delta, so motion never looks jumpy.
    for (let i = 0; i < this.speedControl.speed; i++) this.world.update(dt);
    this.fx.handle(this.world.drainEvents());

    this.camera.update(dt);
    this.terrainLayer.update();
    this.riverLayer.update(this.cameras.main);
    this.influence.update(dt, this.cameras.main.zoom);
    this.settlementPotential.update(dt);
    this.roads.update(dt);
    this.sites.update(dt);
    this.frontier.update(dt);
    this.settlements.update(dt);
    this.villagers.update(dt);
    this.debug.update();
    this.hud.update(this.hovered ?? this.selected, this.hoveredRoadPoint);
  }

  // ------------------------------------------------------------------ input

  /** The frontier offer under a point, if any — generous, since markers are small. */
  private frontierAt(point: { x: number; y: number }): ResourceNode | null {
    for (const candidate of this.world.frontier) {
      const d = Math.hypot(candidate.node.position.x - point.x, candidate.node.position.y - point.y);
      if (d <= candidate.node.radius + 14) return candidate.node;
    }
    return null;
  }

  private worldPoint(pointer: Phaser.Input.Pointer): { x: number; y: number } {
    const p = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return { x: p.x, y: p.y };
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    const point = this.worldPoint(pointer);

    if (pointer.rightButtonDown()) {
      this.erasing = true;
      this.world.eraseRoadAt(point);
      return;
    }

    // A frontier marker is not connectable, so it can never start a road —
    // clicking one selects it instead, and the selection has to *stick*: the
    // Claim button lives in the panel across the screen, and the player has
    // to be able to move the cursor off the marker to reach it without the
    // panel closing behind them.
    const frontier = this.frontierAt(point);
    if (frontier) {
      this.selected = frontier;
      return;
    }

    if (this.drawing.begin(this.world, point)) {
      this.selected = this.world.siteAt(point);
      this.refreshPreview();
      return;
    }

    this.selected = null;
    this.camera.beginPan(pointer);
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const point = this.worldPoint(pointer);

    this.hovered = this.world.siteAt(point);
    this.sites.setHovered(this.hovered);
    this.frontier.setHovered(this.frontierAt(point));
    this.settlements.setHovered(this.hovered);

    if (this.erasing && pointer.rightButtonDown()) {
      this.world.eraseRoadAt(point);
      this.roads.setHighlight(this.world.roadAt(point), true);
      this.setCursor('crosshair');
      return;
    }

    // Show which stretch is under the cursor: that is the unit an erase takes.
    const road = this.hovered ? null : this.world.roadAt(point);
    this.roads.setHighlight(road, false);
    this.hoveredRoadPoint = road ? point : null;

    if (this.drawing.active) {
      this.drawing.extend(this.world, point);
      this.refreshPreview();
      this.setCursor('crosshair');
      return;
    }

    this.camera.updatePan(pointer);
    this.setCursor(
      this.world.anchorAt(point) ? 'crosshair' : this.camera.isPanning ? 'grabbing' : 'grab',
    );
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    this.camera.endPan();

    if (this.erasing) {
      this.erasing = false;
      return;
    }

    if (!this.drawing.active) return;

    const path = this.drawing.finish(this.world, this.worldPoint(pointer));
    if (path) this.world.buildRoad(path);

    this.roads.setPreview(null);
  }

  private cancelDrawing(): void {
    this.drawing.cancel();
    this.erasing = false;
    this.roads.setPreview(null);
    this.roads.setHighlight(null, false);
  }

  private refreshPreview(): void {
    this.roads.setPreview({
      points: this.drawing.smoothed,
      valid: this.drawing.valid,
      snap: this.drawing.valid ? this.drawing.snapPoint : null,
    });
  }

  private setCursor(cursor: string): void {
    const canvas = this.input.manager.canvas;
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }
}
