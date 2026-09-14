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
import { wearEffort, type TrafficField } from './traffic';
import type { Village } from './village';

/** Anything a road can start or end at. */
export type Site = Village | ResourceNode | Settlement;

/** Distance under which two points are considered the same place. */
const WELD_DISTANCE = 14;
/** How close the cursor must be to a road to grab it. */
export const ROAD_GRAB_DISTANCE = 18;
/** How near a fork the cursor has to be to be pointing at the fork rather than at one of its arms. */
export const JUNCTION_GRAB_DISTANCE = 20;
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

  /** Last `TrafficField.revision` `wearMean` was measured against. */
  private wearStamp = -1;
  private wearMean = 0;

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

  /**
   * How packed down this stretch is, averaged along it.
   *
   * A road's wear is a property of the road and the ground, not of whoever is
   * asking — so it is measured once per change to the traffic field and read
   * back from there. The pathfinder asks this for every edge it relaxes, of
   * every search, and there are thousands of searches in a tick; sampling the
   * polyline afresh each time made the mean wear of forty-odd roads the single
   * most expensive thing in the simulation, at better than a quarter of the
   * whole tick.
   */
  wear(traffic: TrafficField): number {
    if (this.wearStamp !== traffic.revision) {
      this.wearStamp = traffic.revision;
      this.wearMean = traffic.wearAlong(this.points);
    }
    return this.wearMean;
  }

  /** Points oriented so they start at `from`. */
  pointsFrom(from: GraphNode): Vec2[] {
    return from === this.a ? this.points : [...this.points].reverse();
  }
}

/** A route's polyline, deferred until something actually walks or draws it. */
interface DeferredGeometry {
  length: number;
  assemble: () => Vec2[];
}

/**
 * A concrete walkable route: one polyline plus the edges it crosses.
 *
 * **Pricing a trip and walking one are different questions, and only the
 * second needs geometry.** Every route the dispatcher considers is scored on
 * two numbers — how much effort the ground costs and how worn it is — both of
 * which come from the edges. Only the single route that actually wins gets
 * walked, sampled, or deposited along. So the polyline is assembled on first
 * demand rather than in the constructor: the losing thousands never pay for a
 * few hundred copied points and a cumulative-length table apiece, which on its
 * own was running a third of the tick into the garbage collector.
 */
export class Route {
  readonly edges: RoadEdge[];
  /** Geometric length, which is what movement along the road uses. */
  readonly length: number;
  /** Terrain-weighted effort, which is what choosing between routes uses. */
  readonly resistance: number;

  /** How to assemble the polyline, until somebody asks for it. */
  private assemble: (() => Vec2[]) | null = null;
  private builtPoints: Vec2[] | null = null;
  private builtCum: number[] | null = null;
  private wearStamp = -1;
  private wearMean = 0;
  private weakestStamp = -1;
  private weakestValue = 0;

  /**
   * Either the polyline itself, or — for a route the pathfinder has just found
   * and nobody has yet decided to walk — how to build it and how long it is.
   *
   * The deferred length is the sum of the edges' own, which is exact rather
   * than an estimate: an edge's points are pinned to its endpoints, so
   * stringing them together shares those points and adds no length at a joint.
   */
  constructor(geometry: Vec2[] | DeferredGeometry, edges: RoadEdge[]) {
    this.edges = edges;
    this.resistance = edges.reduce((sum, edge) => sum + edge.resistance, 0);

    if (Array.isArray(geometry)) {
      this.builtPoints = geometry;
      this.assemble = null;
      this.length = polylineLength(geometry);
    } else {
      this.builtPoints = null;
      this.assemble = geometry.assemble;
      this.length = geometry.length;
    }
  }

  get points(): Vec2[] {
    if (this.builtPoints === null) this.builtPoints = this.assemble!();
    return this.builtPoints;
  }

  get cum(): number[] {
    if (this.builtCum === null) this.builtCum = cumulativeLengths(this.points);
    return this.builtCum;
  }

  /**
   * How worn the ground along this route is.
   *
   * A route's points are its edges' points strung together, so the mean over
   * the route is the mean over its edges weighted by how many points each
   * contributes — and every edge already knows its own. That turns a walk over
   * a few hundred polyline points into a sum over the three or four roads the
   * route actually uses, and it comes out of the same cache the pathfinder
   * fills, so a busy tick measures each road once however many routes cross it.
   *
   * The one difference from sampling the route's own polyline is that a point
   * where two roads meet is counted once for each of them rather than once for
   * the route. That is a couple of points in a few hundred, on a reading that
   * then goes through `0.4 + 0.6 * quality`; it is not worth keeping a second,
   * per-route sampling path alive to avoid.
   */
  wear(traffic: TrafficField): number {
    if (this.wearStamp === traffic.revision) return this.wearMean;
    this.wearStamp = traffic.revision;

    if (this.edges.length === 0) {
      this.wearMean = traffic.wearAlong(this.points);
      return this.wearMean;
    }

    let weighted = 0;
    let count = 0;
    for (const edge of this.edges) {
      weighted += edge.wear(traffic) * edge.points.length;
      count += edge.points.length;
    }
    this.wearMean = count > 0 ? weighted / count : 0;
    return this.wearMean;
  }

  /**
   * How packed down the *worst* stretch of this route is.
   *
   * The average says whether a route is broadly good; this says whether it can
   * be relied on, which is a different question and the one that decides what
   * can travel it (see `convoyFor`). A route that is highway for nine tenths
   * of its length and a bog for the last stretch is a bog: a cart that cannot
   * get through the gap does not care how fine the rest of it was.
   *
   * Measured per edge rather than by sampling the polyline, so it costs the
   * same cached per-edge readings `wear` already uses and never forces a
   * route's points to be assembled.
   */
  weakestWear(traffic: TrafficField): number {
    if (this.weakestStamp === traffic.revision) return this.weakestValue;
    this.weakestStamp = traffic.revision;

    if (this.edges.length === 0) {
      this.weakestValue = traffic.weakestAlong(this.points);
      return this.weakestValue;
    }

    let weakest = Infinity;
    for (const edge of this.edges) weakest = Math.min(weakest, edge.wear(traffic));
    this.weakestValue = Number.isFinite(weakest) ? weakest : 0;
    return this.weakestValue;
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

  /** Whether the polyline has actually been needed yet — for tests and probes. */
  get isAssembled(): boolean {
    return this.builtPoints !== null;
  }
}

/**
 * Walks a finished search back from a goal to the route that reaches it.
 *
 * The polyline is left deferred — see `Route` — so a reconstruction costs
 * only the handful of edges the route actually crosses.
 */
function buildRoute(
  start: GraphNode,
  goal: GraphNode,
  cameFrom: Map<GraphNode, { node: GraphNode; edge: RoadEdge }>,
): Route | null {
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

  return new Route(
    {
      length: edges.reduce((sum, edge) => sum + edge.length, 0),
      assemble: () => {
        const points: Vec2[] = [{ ...start.position }];
        for (let i = 0; i < edges.length; i++) {
          const oriented = edges[i].pointsFrom(chain[i]);
          for (let p = 1; p < oriented.length; p++) points.push({ ...oriented[p] });
        }
        return points;
      },
    },
    edges,
  );
}

/** The result of one full search: every route out of a single place. */
export class RouteTree {
  constructor(
    private readonly network: RoadNetwork,
    private readonly start: GraphNode,
    private readonly cameFrom: Map<GraphNode, { node: GraphNode; edge: RoadEdge }>,
  ) {}

  /**
   * A route to one place, or null if it is not on the network or is where the
   * search started — the same two answers `routeBetween` gives, for the same
   * reasons.
   */
  to(site: Site): Route | null {
    const goal = this.network.nodeForSite(site);
    if (!goal || goal === this.start) return null;
    return buildRoute(this.start, goal, this.cameFrom);
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
  private traffic: TrafficField | null = null;

  setTraffic(field: TrafficField): void {
    this.traffic = field;
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

    // The *start* must join the network, so a road can never be an island.
    // The far end need not: a road is allowed to simply stop somewhere, which
    // is how anybody has ever found anything.
    //
    // Requiring both ends to land on something already known was quietly the
    // most limiting rule in the game. The player's only verb is drawing a
    // road; sites only become visible inside an influence ring; and rings
    // only ever sat on places already reached. So the player could never
    // reach *toward* anything — only between things the world had already
    // handed them — and the moment the nearest undiscovered deposit sat
    // outside one ring's reach, no sequence of legal moves existed that could
    // ever find it. Measured over 150 in-game days, a civilisation of a
    // hundred and thirty people was still working the same twelve deposits it
    // found in its first fortnight, with dozens more a short way beyond.
    //
    // A track into open country is a real decision with a real cost: it earns
    // nothing on its own, and if nothing comes of it the traffic never
    // arrives and it grows over again (see `World.pruneAbandonedRoads`). But
    // it is a move, and the game badly needed the player to have one.
    if (!startAnchor) return null;
    if (endProbe && startAnchor.kind === 'site' && endProbe.kind === 'site' && startAnchor.site === endProbe.site) {
      return null;
    }
    // Length is checked here, before anything touches the graph. It used to
    // be checked after both ends had been materialised, which was harmless
    // only because both ends were guaranteed to already exist; now that a
    // free end *creates* a node, bailing out later would strand it.
    if (polylineLength(rawPoints) < MIN_ROAD_LENGTH) return null;

    const startNode = this.materialize(startAnchor);

    // Re-resolve the far end afterwards: materialising the start may have split
    // the very edge the end anchor pointed at.
    const endAnchor = this.anchorAt(last, sites) ?? endProbe;
    const endNode = endAnchor ? this.materialize(endAnchor) : this.createNode(last, null);

    if (startNode === endNode) return null;

    const path = this.smoothPath(rawPoints, startNode.position, endNode.position);
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

  /**
   * Every route out of one place, from a single search.
   *
   * Dijkstra already visits the whole reachable network on the way to any one
   * goal, so asking it separately for each of two hundred destinations throws
   * away almost all of its work two hundred times. Every caller that wants
   * more than one route out of the same place — the world's reachability
   * sweep, and the trade dispatcher pricing one source against every
   * destination in the realm — wants this instead.
   */
  routeTree(from: Site): RouteTree | null {
    const start = this.nodeForSite(from);
    if (!start) return null;
    return new RouteTree(this, start, this.search(start, null));
  }

  private findRoute(start: GraphNode, goal: GraphNode): Route | null {
    return buildRoute(start, goal, this.search(start, goal));
  }

  /**
   * Cheapest known way to every node, stopping early once `goal` is settled.
   * Pass `null` for a goal to expand the whole reachable network.
   */
  private search(
    start: GraphNode,
    goal: GraphNode | null,
  ): Map<GraphNode, { node: GraphNode; edge: RoadEdge }> {
    const best = new Map<GraphNode, number>([[start, 0]]);
    const cameFrom = new Map<GraphNode, { node: GraphNode; edge: RoadEdge }>();
    const open: GraphNode[] = [start];
    const queued = new Set<GraphNode>([start]);
    const closed = new Set<GraphNode>();

    while (open.length > 0) {
      // Small graphs, so a linear scan beats maintaining a heap.
      let index = 0;
      for (let i = 1; i < open.length; i++) {
        if ((best.get(open[i]) ?? Infinity) < (best.get(open[index]) ?? Infinity)) index = i;
      }
      const current = open.splice(index, 1)[0];
      queued.delete(current);
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
        const wear = this.traffic ? edge.wear(this.traffic) : 0;
        const cost = (best.get(current) ?? Infinity) + edge.resistance * wearEffort(wear);
        if (cost < (best.get(next) ?? Infinity)) {
          best.set(next, cost);
          cameFrom.set(next, { node: current, edge });
          if (!queued.has(next)) {
            queued.add(next);
            open.push(next);
          }
        }
      }
    }

    return cameFrom;
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

