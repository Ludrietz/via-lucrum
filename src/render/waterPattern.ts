import Phaser from 'phaser';
import type { Vec2 } from '../sim/geometry';
import { WATER } from './land';

/**
 * The wavy hatching that tells you, at a glance, that a shape is water.
 *
 * It is the oldest convention in cartography and it survives because it does
 * something colour cannot: it says which way the *map* is oriented. Ripples
 * run along the page, not along the stream, so a lake and a river and a
 * millpond all carry the same horizontal ruling and the eye reads them as one
 * substance seen from above. Drawing the ripples along each watercourse
 * instead would be a picture of flow, which is a different and much less
 * legible thing.
 *
 * ## One quad, not one pattern per river
 *
 * The pattern is a single tiling sprite laid over the whole viewport and then
 * clipped to the water by a stencil. That arrangement is doing three jobs at
 * once, all of which the obvious per-shape approach gets wrong.
 *
 * It keeps the hatching in the map's frame rather than each river's, which is
 * the whole point of the convention.
 *
 * It makes the pattern continuous across shapes. A stream running into a pond
 * shares the ruling with it, unbroken, because both are windows onto the same
 * sheet of ripples — nothing has to be matched up at the join.
 *
 * And it is the one place in this layer where transparency is safe. Every
 * other piece of water had to be drawn opaque, because translucent shapes
 * drawn over each other darken where they overlap and every confluence grew a
 * bruise. A single quad cannot overlap itself, so the ripples can be as faint
 * as they need to be.
 *
 * ## Where the water comes from
 *
 * Deliberately nowhere in particular. This is handed a list of polygons and
 * knows nothing about rivers, packs or terrain — so the day a procedural world
 * grows water worth hatching, it supplies its own shapes to the same overlay
 * and the pattern works unchanged.
 */

/** World units across one tile of the pattern. */
const TILE_UNITS = 64;

/**
 * Texture pixels per world unit.
 *
 * The pattern is defined in world units so it zooms with the map, but a
 * texture of one pixel per unit would be a blocky forty-eight-pixel square by
 * the time anyone looked closely. Four keeps the curves smooth without the
 * texture being worth worrying about — the whole tile is 192px.
 */
const PIXELS_PER_UNIT = 4;

/** Ripple lines per tile, and sine periods per tile. Both must be whole, or the pattern will not tile. */
const ROWS = 8;
const PERIODS = 4;

const AMPLITUDE_UNITS = 1.4;
const LINE_UNITS = 0.8;

const TEXTURE_KEY = 'water:ripples';

function createRippleTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(TEXTURE_KEY)) return;

  const size = TILE_UNITS * PIXELS_PER_UNIT;
  const texture = scene.textures.createCanvas(TEXTURE_KEY, size, size)!;
  const ctx = texture.context;

  const amplitude = AMPLITUDE_UNITS * PIXELS_PER_UNIT;
  const spacing = size / ROWS;
  const line = LINE_UNITS * PIXELS_PER_UNIT;

  ctx.lineCap = 'round';

  for (let row = 0; row < ROWS; row++) {
    // Every other row is offset half a wavelength, so the ruling reads as
    // water rather than as corrugated iron.
    const phase = row % 2 === 0 ? 0 : Math.PI;
    const centre = (row + 0.5) * spacing;

    // A dark line with a pale one just beneath it: the same trick an engraver
    // uses, and enough to suggest a trough and a crest without either being
    // drawn.
    for (const pass of [
      { offset: 0, width: line, colour: 'rgba(34,60,78,0.45)' },
      { offset: line * 1.6, width: line * 0.8, colour: 'rgba(232,244,248,0.32)' },
    ]) {
      ctx.strokeStyle = pass.colour;
      ctx.lineWidth = pass.width;
      ctx.beginPath();
      for (let x = 0; x <= size; x++) {
        const y = centre + pass.offset + Math.sin((x / size) * PERIODS * Math.PI * 2 + phase) * amplitude;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  texture.refresh();
}

export class WaveOverlay {
  private readonly sprite: Phaser.GameObjects.TileSprite;
  private readonly clip: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, depth: number) {
    createRippleTexture(scene);

    const camera = scene.cameras.main;
    this.sprite = scene.add
      .tileSprite(0, 0, camera.width, camera.height, TEXTURE_KEY)
      .setOrigin(0, 0)
      // An ordinary world-space object, transformed by exactly the same camera
      // matrix as the water it sits on. That is the whole trick: anything with
      // its own idea of where the screen is has to be kept in step with the
      // camera by hand, and will be wrong on any frame the camera is moving.
      .setScrollFactor(1)
      .setDepth(depth)
      .setVisible(false);

    // Never rendered itself; it exists to be drawn into the stencil buffer.
    // Phaser is explicit that a mask's Graphics need not be on the display
    // list, which is what lets this stay entirely private to the overlay.
    this.clip = scene.make.graphics({}, false);
    this.sprite.setMask(new Phaser.Display.Masks.GeometryMask(scene, this.clip));
  }

  /**
   * Set the water the ripples show through. Polygons are in world units, and
   * are expected to be the *water* itself — not its banks, which have no
   * ripples on them.
   */
  setShapes(shapes: Vec2[][]): void {
    this.clip.clear();
    this.clip.fillStyle(WATER.shallow, 1);

    let any = false;
    for (const shape of shapes) {
      if (shape.length < 3) continue;
      this.clip.fillPoints(shape, true);
      any = true;
    }

    this.sprite.setVisible(any);
  }

  /**
   * Park the quad over whatever the camera is looking at, and slide it through
   * the sheet of ripples by the same amount, so the pattern sits still in the
   * world while the view moves across it.
   *
   * ## Why the camera is recomputed here rather than read
   *
   * `camera.worldView`, `midPoint` and the camera matrix are all worked out in
   * `preRender`, which runs *after* `scene.update` — so anything that reads
   * them during an update is reading the previous frame. That is invisible
   * while the camera is still and unmissable while it is moving: the ripples
   * held their place perfectly at any fixed zoom and visibly swam during the
   * zoom easing, because every frame of the animation positioned them for the
   * zoom before it. A test that only samples steady states cannot see this,
   * which is exactly why the first two attempts passed.
   *
   * So the view rectangle is derived from the zoom and scroll as they are now,
   * by the same arithmetic `preRender` will shortly use.
   *
   * ## Why the quad is in world space
   *
   * The earlier version pinned it to the screen and undid the camera's zoom by
   * hand. `setScrollFactor(0)` stops a camera scrolling an object but not
   * zooming one, so that correction had to reproduce Phaser's zoom-about-the-
   * midpoint exactly, and any error in it showed up as the pattern sliding.
   * Placed in world space instead, the camera transforms the ripples and the
   * water through the same matrix and no correction exists to get wrong.
   *
   * The quad stays *sized* in screen pixels and is scaled down to cover the
   * view, because Phaser rebuilds a tile sprite's backing canvas to its own
   * width and height on every render — a quad measured in world units would
   * try to allocate a canvas the size of the map.
   */
  update(camera: Phaser.Cameras.Scene2D.Camera): void {
    if (this.sprite.width !== camera.width || this.sprite.height !== camera.height) {
      this.sprite.setSize(camera.width, camera.height);
    }

    const zoom = Math.max(camera.zoom, 0.001);
    const viewX = camera.scrollX + camera.width / 2 - camera.width / zoom / 2;
    const viewY = camera.scrollY + camera.height / 2 - camera.height / zoom / 2;

    this.sprite.setPosition(viewX, viewY);
    this.sprite.setScale(1 / zoom);

    // The quad is `camera.width` wide in its own units and each of those is
    // `1 / zoom` of a world unit, so a tile of `TILE_UNITS` world units must
    // span `TILE_UNITS * zoom` of them — and the texture is `PIXELS_PER_UNIT`
    // times bigger than the world region it stands for.
    this.sprite.tileScaleX = zoom / PIXELS_PER_UNIT;
    this.sprite.tileScaleY = zoom / PIXELS_PER_UNIT;
    this.sprite.tilePositionX = viewX * PIXELS_PER_UNIT;
    this.sprite.tilePositionY = viewY * PIXELS_PER_UNIT;
  }

  destroy(): void {
    this.sprite.destroy();
    this.clip.destroy();
  }
}
