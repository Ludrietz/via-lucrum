import Phaser from 'phaser';

const MAX_ZOOM = 2.2;
const ZOOM_STEP = 0.0016;

/**
 * Drag to pan, wheel to zoom towards the cursor. Zoom eases so the map never
 * snaps; panning is direct so dragging feels like moving paper.
 */
export class CameraController {
  private readonly cam: Phaser.Cameras.Scene2D.Camera;

  private targetZoom: number;
  private anchorScreen: Phaser.Math.Vector2 | null = null;
  private anchorWorld: Phaser.Math.Vector2 | null = null;

  private panning = false;
  private panOrigin = new Phaser.Math.Vector2();
  private scrollOrigin = new Phaser.Math.Vector2();

  private minZoom: number;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly worldWidth: number,
    private readonly worldHeight: number,
  ) {
    this.cam = scene.cameras.main;
    this.cam.setBounds(0, 0, worldWidth, worldHeight);
    this.cam.setBackgroundColor('#d9c9a3');

    this.minZoom = this.coverZoom();
    const start = Phaser.Math.Clamp(this.minZoom * 1.6, this.minZoom, MAX_ZOOM);
    this.cam.setZoom(start);
    this.targetZoom = start;
    this.cam.centerOn(worldWidth / 2, worldHeight / 2);

    scene.input.on(Phaser.Input.Events.POINTER_WHEEL, this.onWheel, this);
    scene.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
  }

  /** Smallest zoom that still keeps the paper covering the whole viewport. */
  private coverZoom(): number {
    return Math.max(this.cam.width / this.worldWidth, this.cam.height / this.worldHeight);
  }

  private onResize(): void {
    this.minZoom = this.coverZoom();
    if (this.targetZoom < this.minZoom) {
      this.targetZoom = this.minZoom;
      this.cam.setZoom(this.minZoom);
    }
  }

  /** Put a world position in the middle of the view. */
  centerOn(point: { x: number; y: number }): void {
    this.cam.centerOn(point.x, point.y);
  }

  get zoom(): number {
    return this.cam.zoom;
  }

  get isPanning(): boolean {
    return this.panning;
  }

  beginPan(pointer: Phaser.Input.Pointer): void {
    this.panning = true;
    this.panOrigin.set(pointer.x, pointer.y);
    this.scrollOrigin.set(this.cam.scrollX, this.cam.scrollY);
  }

  updatePan(pointer: Phaser.Input.Pointer): void {
    if (!this.panning) return;
    this.cam.setScroll(
      this.scrollOrigin.x - (pointer.x - this.panOrigin.x) / this.cam.zoom,
      this.scrollOrigin.y - (pointer.y - this.panOrigin.y) / this.cam.zoom,
    );
  }

  endPan(): void {
    this.panning = false;
  }

  update(dt: number): void {
    if (Math.abs(this.targetZoom - this.cam.zoom) < 0.0005) {
      this.cam.setZoom(this.targetZoom);
      this.anchorScreen = null;
      return;
    }

    const next = Phaser.Math.Linear(this.cam.zoom, this.targetZoom, 1 - Math.exp(-14 * dt));
    this.cam.setZoom(next);

    // Keep the point under the cursor pinned while the zoom eases in.
    if (this.anchorScreen && this.anchorWorld) {
      const halfW = this.cam.width / 2;
      const halfH = this.cam.height / 2;
      this.cam.setScroll(
        this.anchorWorld.x - halfW - (this.anchorScreen.x - halfW) / next,
        this.anchorWorld.y - halfH - (this.anchorScreen.y - halfH) / next,
      );
    }
  }

  private onWheel(pointer: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number): void {
    this.anchorScreen = new Phaser.Math.Vector2(pointer.x, pointer.y);
    const world = this.cam.getWorldPoint(pointer.x, pointer.y);
    this.anchorWorld = new Phaser.Math.Vector2(world.x, world.y);

    this.targetZoom = Phaser.Math.Clamp(
      this.targetZoom * (1 - dy * ZOOM_STEP),
      this.minZoom,
      MAX_ZOOM,
    );
  }

  destroy(): void {
    this.scene.input.off(Phaser.Input.Events.POINTER_WHEEL, this.onWheel, this);
    this.scene.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
  }
}
