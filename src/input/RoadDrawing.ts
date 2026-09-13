import { catmullRom, dist, simplify, type Vec2 } from '../sim/geometry';
import type { Anchor } from '../sim/roadNetwork';
import type { World } from '../sim/world';

/** Cursor movement needed before another point joins the drawn path. */
const SAMPLE_SPACING = 9;
const MIN_LENGTH = 60;

/**
 * Freehand road drawing. Collects cursor positions between a valid start and
 * end anchor; the network does the smoothing and welding when it is committed.
 */
export class RoadDrawing {
  private points: Vec2[] = [];
  private start: Anchor | null = null;
  private end: Anchor | null = null;
  /** Cached while dragging: a path over water can never become a road. */
  private passable = true;

  get active(): boolean {
    return this.start !== null;
  }

  /**
   * A drag makes a road if it starts on the network and crosses ground a
   * villager could walk. Where it *ends* is up to the player: on a site, on
   * another road, or simply out in open country — see `RoadNetwork.addRoad`
   * for why a road into the unknown had to become a legal move.
   */
  get valid(): boolean {
    if (!this.start) return false;
    if (!this.passable) return false;
    if (this.length < MIN_LENGTH) return false;
    // Ending on the same site you began at would connect nothing.
    return !(
      this.start.kind === 'site' &&
      this.end?.kind === 'site' &&
      this.start.site === this.end.site
    );
  }

  get path(): Vec2[] {
    return this.points;
  }

  /** Smoothed version of the drawn path, for the preview line. */
  get smoothed(): Vec2[] {
    if (this.points.length < 2) return this.points;
    const control = simplify(this.points, 26);
    return catmullRom(control, 6);
  }

  get snapPoint(): Vec2 | null {
    return this.end?.point ?? null;
  }

  private get length(): number {
    let total = 0;
    for (let i = 0; i < this.points.length - 1; i++) total += dist(this.points[i], this.points[i + 1]);
    return total;
  }

  begin(world: World, point: Vec2): boolean {
    const anchor = world.anchorAt(point);
    if (!anchor) return false;

    this.start = anchor;
    this.end = null;
    this.points = [{ ...anchor.point }];
    this.passable = true;
    return true;
  }

  extend(world: World, point: Vec2): void {
    if (!this.start) return;

    const last = this.points[this.points.length - 1];
    if (dist(last, point) >= SAMPLE_SPACING) {
      this.points.push({ ...point });
      if (this.passable) this.passable = world.canLayAlong([last, point]);
    }

    this.end = world.anchorAt(point);
  }

  /** Commit the drawing. Returns the path to build, or null to cancel. */
  finish(world: World, point: Vec2): Vec2[] | null {
    if (!this.start) return null;

    this.extend(world, point);
    const endAnchor = world.anchorAt(point);
    this.end = endAnchor;

    if (!this.valid) {
      this.cancel();
      return null;
    }

    const path = [...this.points];
    // Snap onto whatever the cursor was over, if anything; otherwise the road
    // simply finishes where the player let go.
    path[path.length - 1] = endAnchor ? { ...endAnchor.point } : { ...point };
    this.cancel();
    return path;
  }

  cancel(): void {
    this.start = null;
    this.end = null;
    this.points = [];
    this.passable = true;
  }
}
