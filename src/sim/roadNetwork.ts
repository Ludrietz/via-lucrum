import {
  catmullRom,
  closestPointOnPolyline,
  cumulativeLengths,
  dist,
  polylineLength,
  samplePolyline,
  segmentIntersection,
  simplify,
  splitPolyline,
  type SampleResult,
  type Vec2,
} from './geometry';
import type { ResourceNode } from './resourceNode';
import type { Settlement } from './settlement';
import { wearEffort } from './traffic';
import type { Village } from './village';

/** Anything a road can start or end at. */
export type Site = Village | ResourceNode | Settlement;

/** Distance under which two points are considered the same place. */
const WELD_DISTANCE = 14;
/** How close the cursor must be to a road to grab it. */
export const ROAD_GRAB_DISTANCE = 18;
const MIN_ROAD_LENGTH = 40;
/** How far a place may sit from the road it grew on. */
const PLACEMENT_REACH = 120;

export class GraphNode {
  readonly id: number;
  readonly position: Vec2;
  /** Set when something stands here rather than roads merely meeting. */
  site: Site | null;
  readonly edges: RoadEdge[] = [];

  constructor(id: number, position: Vec2, site: Site | null) {
    this.id = id;
    this.position = { ...position };
    this.site = site;
  }

  get isJunction(): boolean {
    return this.site === null;
  }
}

/** One stretch of road between two graph nodes, drawn as a polyline. */
export class RoadEdge {
  readonly id: number;
  readonly a: GraphNode;
  readonly b: GraphNode;
  readonly points: Vec2[];
  readonly length: number;

  usage = 0;
  /** 0..1 while the road draws itself in. */
  buildProgress = 0;
  /**
   * How hard this stretch is to walk, from the ground it was laid across:
   * 1 on the flat, more through forest, hills and mountains. This is what
   * makes one route cheaper than another, not its raw length.
   */
  difficulty = 1;

  constructor(id: number, a: GraphNode, b: GraphNode, points: Vec2[], usage = 0) {
    this.id = id;
    this.a = a;
    this.b = b;
    this.points = points;
    this.length = polylineLength(points);
    this.usage = usage;
  }

  get isBuilt(): boolean {
    return this.buildProgress >= 1;
  }

  other(node: GraphNode): GraphNode {
    return node === this.a ? this.b : this.a;
  }

  /** What it costs a villager to walk this stretch end to end. */
  get resistance(): number {
    return this.length * this.difficulty;
  }

  /** Points oriented so they start at `from`. */
  pointsFrom(from: GraphNode): Vec2[] {
    return from === this.a ? this.points : [...this.points].reverse();
  }
}

/** A concrete walkable route: one polyline plus the edges it crosses. */
export class Route {
  readonly points: Vec2[];
  readonly edges: RoadEdge[];
  readonly cum: number[];
  /** Geometric length, which is what movement along the road uses. */
  readonly length: number;
  /** Terrain-weighted effort, which is what choosing between routes uses. */
  readonly resistance: number;

  constructor(points: Vec2[], edges: RoadEdge[]) {
    this.points = points;
    this.edges = edges;
    this.cum = cumulativeLengths(points);
    this.length = this.cum[this.cum.length - 1];
    this.resistance = edges.reduce((sum, edge) => sum + edge.resistance, 0);
  }

  /** Mean difficulty of the ground this route crosses. */
  get difficulty(): number {
    return this.length > 0 ? this.resistance / this.length : 1;
  }

  sample(distance: number): SampleResult {
    return samplePolyline(this.points, this.cum, distance);
  }

  reversed(): Route {
    return new Route([...this.points].reverse(), [...this.edges].reverse());
  }
}

export type Anchor =
  | { kind: 'site'; site: Site; point: Vec2 }
  | { kind: 'node'; node: GraphNode; point: Vec2 }
  | { kind: 'edge'; edge: RoadEdge; index: number; t: number; point: Vec2 };

/**
 * The road graph. Player-drawn paths are smoothed, welded onto whatever they
 * start and end on, and split wherever they cross an existing road, so what
 * comes out is one connected network rather than a pile of separate lines.
 */
export class RoadNetwork {
  readonly nodes: GraphNode[] = [];
  readonly edges: RoadEdge[] = [];

  /** Bumped on every structural change so caches know to recompute. */
  version = 0;

  private nextNodeId = 1;
  private nextEdgeId = 1;
  /**
   * How worn a stretch of ground is, so routing can prefer a busy road over
   * a fresher-but-shorter one. Set once by `World` after its traffic field
   * exists — field-initializer ordering means it can't be passed in at
   * construction — and defaults to "untouched" so a network with nothing
   * wired up yet still routes purely on terrain, as before.
   */
  private wearAlong: (points: Vec2[]) => number = () => 0;

  setWearLookup(fn: (points: Vec2[]) => number): void {
    this.wearAlong = fn;
  }

  // ------------------------------------------------------------------ lookup

  nodeForSite(site: Site): GraphNode | null {
    return this.nodes.find((n) => n.site === site) ?? null;
  }

  /** What the cursor is over: a site, an existing junction, or a road. */
  anchorAt(point: Vec2, sites: Site[]): Anchor | null {
    for (const site of sites) {
      const radius = 'radius' in site ? site.radius : 24;
      if (dist(site.position, point) <= radius + 10) {
        return { kind: 'site', site, point: { ...site.position } };
      }
    }

    for (const node of this.nodes) {
      if (node.isJunction && dist(node.position, point) <= WELD_DISTANCE) {
        return { kind: 'node', node, point: { ...node.position } };
      }
    }

    let best: Anchor | null = null;
    let bestDistance = ROAD_GRAB_DISTANCE;
    for (const edge of this.edges) {
      const hit = closestPointOnPolyline(edge.points, point);
      if (hit.distance < bestDistance) {
        bestDistance = hit.distance;
        best = { kind: 'edge', edge, index: hit.index, t: hit.t, point: hit.point };
      }
    }

    return best;
  }

  /**
   * Put a place onto an existing road: the road is split where the place
   * stands and the resulting node stops being a plain junction, so routes run
   * through it and new roads can be drawn to it. This is how a settlement
   * joins the network it grew out of.
   */
  placeSiteOn(point: Vec2, site: Site): GraphNode | null {
    let target: { edge: RoadEdge; index: number; t: number; point: Vec2 } | null = null;
    let bestDistance = Infinity;

    for (const edge of this.edges) {
      const hit = closestPointOnPolyline(edge.points, point);
      if (hit.distance < bestDistance) {
        bestDistance = hit.distance;
        target = { edge, index: hit.index, t: hit.t, point: hit.point };
      }
    }

    if (!target || bestDistance > PLACEMENT_REACH) return null;

    const node = this.splitEdgeAt(target.edge, target.index, target.t);
    node.site = site;
    this.version++;
    return node;
  }

  // ---------------------------------------------------------------- building

  /**
   * Turn a drawn path into road. The road is exactly what the player drew,
   * smoothed. Returns the created edges, or null if the path does not start
   * and end on something connectable.
   */
  addRoad(rawPoints: Vec2[], sites: Site[]): RoadEdge[] | null {
    if (rawPoints.length < 2) return null;

    const last = rawPoints[rawPoints.length - 1];
    const startAnchor = this.anchorAt(rawPoints[0], sites);
    const endProbe = this.anchorAt(last, sites);

    // Check both ends before touching the graph, so a road that connects
    // nothing cannot leave a stray junction behind.
    if (!startAnchor || !endProbe) return null;
    if (startAnchor.kind === 'site' && endProbe.kind === 'site' && startAnchor.site === endProbe.site) {
      return null;
    }

    const startNode = this.materialize(startAnchor);

    // Re-resolve the far end afterwards: materialising the start may have split
    // the very edge the end anchor pointed at.
    const endAnchor = this.anchorAt(last, sites) ?? endProbe;
    const endNode = this.materialize(endAnchor);

    if (startNode === endNode) return null;

    const path = this.smoothPath(rawPoints, startNode.position, endNode.position);
    if (polylineLength(path) < MIN_ROAD_LENGTH) return null;

    const created = this.layPath(path, startNode, endNode);
    this.version++;
    return created;
  }

  /** Smooth the sampled cursor positions and pin both ends to their nodes. */
  private smoothPath(rawPoints: Vec2[], start: Vec2, end: Vec2): Vec2[] {
    const control = simplify(rawPoints, 26);
    control[0] = { ...start };
    control[control.length - 1] = { ...end };

    const smoothed = catmullRom(control, 8);
    smoothed[0] = { ...start };
    smoothed[smoothed.length - 1] = { ...end };
    return smoothed;
  }

  /**
   * Walk the path, cutting it at the first crossing with an existing road each
   * time and welding a junction there, until what is left reaches the end node.
   */
  private layPath(path: Vec2[], startNode: GraphNode, endNode: GraphNode): RoadEdge[] {
    const created: RoadEdge[] = [];
    let remaining = path;
    let from = startNode;
    let guard = 0;

    while (guard++ < 40) {
      const crossing = this.firstCrossing(remaining, created);
      if (!crossing) break;

      const junction = this.splitEdgeAt(crossing.edge, crossing.edgeIndex, crossing.edgeT);
      const [head, tail] = splitPolyline(remaining, crossing.index, crossing.t);
      head[head.length - 1] = { ...junction.position };
      tail[0] = { ...junction.position };

      created.push(this.connect(from, junction, head));
      from = junction;
      remaining = tail;
    }

    created.push(this.connect(from, endNode, remaining));
    return created;
  }

  /** Earliest point along `path` where it crosses a road it did not just create. */
  private firstCrossing(
    path: Vec2[],
    exclude: RoadEdge[],
  ): { edge: RoadEdge; edgeIndex: number; edgeT: number; index: number; t: number } | null {
    const total = polylineLength(path);
    let travelled = 0;

    for (let i = 0; i < path.length - 1; i++) {
      const segLength = dist(path[i], path[i + 1]);

      for (const edge of this.edges) {
        if (exclude.includes(edge)) continue;

        for (let j = 0; j < edge.points.length - 1; j++) {
          const hit = segmentIntersection(path[i], path[i + 1], edge.points[j], edge.points[j + 1]);
          if (!hit) continue;

          // Ignore grazes at either tip of the new path; those are the welds we
          // already made at the start and end nodes.
          const along = travelled + segLength * hit.t;
          if (along < WELD_DISTANCE || along > total - WELD_DISTANCE) continue;

          return { edge, edgeIndex: j, edgeT: hit.u, index: i, t: hit.t };
        }
      }

      travelled += segLength;
    }

    return null;
  }

  /** Resolve an anchor into a graph node, splitting a road if it points at one. */
  private materialize(anchor: Anchor): GraphNode {
    switch (anchor.kind) {
      case 'site':
        return this.nodeForSite(anchor.site) ?? this.createNode(anchor.site.position, anchor.site);
      case 'node':
        return anchor.node;
      case 'edge':
        return this.splitEdgeAt(anchor.edge, anchor.index, anchor.t);
    }
  }

  /** Cut an edge in two and return the junction between them. */
  private splitEdgeAt(edge: RoadEdge, index: number, t: number): GraphNode {
    const [head, tail, cut] = splitPolyline(edge.points, index, t);

    // Snap to an end node when the cut lands on top of one.
    if (dist(cut, edge.a.position) < WELD_DISTANCE) return edge.a;
    if (dist(cut, edge.b.position) < WELD_DISTANCE) return edge.b;

    const junction = this.createNode(cut, null);
    this.removeEdge(edge);
    this.connect(edge.a, junction, head, edge.usage, edge.buildProgress).difficulty = edge.difficulty;
    this.connect(junction, edge.b, tail, edge.usage, edge.buildProgress).difficulty = edge.difficulty;
    return junction;
  }

  private createNode(position: Vec2, site: Site | null): GraphNode {
    const node = new GraphNode(this.nextNodeId++, position, site);
    this.nodes.push(node);
    return node;
  }

  private connect(
    a: GraphNode,
    b: GraphNode,
    points: Vec2[],
    usage = 0,
    buildProgress = 0,
  ): RoadEdge {
    const edge = new RoadEdge(this.nextEdgeId++, a, b, points, usage);
    edge.buildProgress = buildProgress;
    this.edges.push(edge);
    a.edges.push(edge);
    b.edges.push(edge);
    return edge;
  }

  /**
   * Take a road off the map and tidy up any junction it leaves stranded.
   * Site nodes stay; a village with no roads is still a village.
   */
  abandon(edge: RoadEdge): void {
    this.removeEdge(edge);

    for (const node of [edge.a, edge.b]) {
      if (!node.isJunction) continue;

      if (node.edges.length === 0) this.dropNode(node);
      // A fork that has lost a prong is no longer a fork: heal the two halves
      // back into one stretch, so a stretch always means a run of road with no
      // choices in it.
      else if (node.edges.length === 2) this.mergeThrough(node);
    }

    this.version++;
  }

  /** Splice the two roads meeting at a junction back into a single stretch. */
  private mergeThrough(node: GraphNode): void {
    const [first, second] = node.edges;
    const from = first.other(node);
    const to = second.other(node);

    // A road that loops straight back where it came from cannot be spliced.
    if (from === to || from === node || to === node) return;

    const points = [...first.pointsFrom(from), ...second.pointsFrom(node).slice(1)];
    const totalLength = first.length + second.length;

    this.removeEdge(first);
    this.removeEdge(second);
    this.dropNode(node);

    const merged = this.connect(from, to, points, Math.max(first.usage, second.usage));
    merged.buildProgress = Math.min(first.buildProgress, second.buildProgress);
    merged.difficulty =
      totalLength > 0
        ? (first.difficulty * first.length + second.difficulty * second.length) / totalLength
        : first.difficulty;
  }

  private dropNode(node: GraphNode): void {
    const i = this.nodes.indexOf(node);
    if (i >= 0) this.nodes.splice(i, 1);
  }

  private removeEdge(edge: RoadEdge): void {
    const drop = (list: RoadEdge[]) => {
      const i = list.indexOf(edge);
      if (i >= 0) list.splice(i, 1);
    };
    drop(this.edges);
    drop(edge.a.edges);
    drop(edge.b.edges);
  }

  // ----------------------------------------------------------------- routing

  /** Shortest route between two sites, following the actual road curves. */
  routeBetween(from: Site, to: Site): Route | null {
    // A route from a place to itself is meaningless for dispatch — nobody
    // has to walk anywhere — and `findRoute` treats start === goal as an
    // already-solved search, which produces a route with no edges and too
    // few points for anything that samples it. Callers already treat a
    // null route as "nothing to do here", which is exactly right.
    if (from === to) return null;

    const a = this.nodeForSite(from);
    const b = this.nodeForSite(to);
    if (!a || !b) return null;
    return this.findRoute(a, b);
  }

  private findRoute(start: GraphNode, goal: GraphNode): Route | null {
    const best = new Map<GraphNode, number>([[start, 0]]);
    const cameFrom = new Map<GraphNode, { node: GraphNode; edge: RoadEdge }>();
    const open: GraphNode[] = [start];
    const closed = new Set<GraphNode>();

    while (open.length > 0) {
      // Small graphs, so a linear scan beats maintaining a heap.
      let index = 0;
      for (let i = 1; i < open.length; i++) {
        if ((best.get(open[i]) ?? Infinity) < (best.get(open[index]) ?? Infinity)) index = i;
      }
      const current = open.splice(index, 1)[0];
      if (current === goal) break;
      closed.add(current);

      for (const edge of current.edges) {
        if (!edge.isBuilt) continue;
        const next = edge.other(current);
        if (closed.has(next)) continue;

        // Weighted by the ground, not the map: villagers take the road of
        // least resistance, which may well be the longer one — and a road
        // that's seen heavy traffic is genuinely easier going than a fresh
        // one cut through the same terrain, so it can win out over a
        // shorter but untouched alternative.
        const cost = (best.get(current) ?? Infinity) + edge.resistance * wearEffort(this.wearAlong(edge.points));
        if (cost < (best.get(next) ?? Infinity)) {
          best.set(next, cost);
          cameFrom.set(next, { node: current, edge });
          if (!open.includes(next)) open.push(next);
        }
      }
    }

    if (start !== goal && !cameFrom.has(goal)) return null;

    const edges: RoadEdge[] = [];
    const chain: GraphNode[] = [goal];
    let cursor = goal;
    while (cursor !== start) {
      const step = cameFrom.get(cursor);
      if (!step) return null;
      edges.unshift(step.edge);
      chain.unshift(step.node);
      cursor = step.node;
    }

    const points: Vec2[] = [{ ...start.position }];
    for (let i = 0; i < edges.length; i++) {
      const oriented = edges[i].pointsFrom(chain[i]);
      points.push(...oriented.slice(1).map((p) => ({ ...p })));
    }

    return new Route(points, edges);
  }

  // ------------------------------------------------------------------ update

  update(dt: number, buildTime: number): void {
    for (const edge of this.edges) {
      if (edge.buildProgress < 1) {
        edge.buildProgress = Math.min(1, edge.buildProgress + dt / buildTime);
        if (edge.buildProgress >= 1) this.version++;
      }
    }
  }
}

