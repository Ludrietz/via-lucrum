/**
 * Does the simulation put settlements where the work actually is?
 *
 * The reported failure: a patch of ground ringed by several claimed deposits,
 * a long way from anywhere anyone lives, never founds anything — its potential
 * climbs and then sits there. Workers keep commuting back to a distant seat
 * forever, which is the same shape as the haulage problems `vision.md` keeps
 * returning to.
 *
 * `snaketest.ts` asks whether *expansion* is priced sensibly. This asks the
 * next question along: given ground the civilisation has already taken in, does
 * a place grow where the deposits are dense enough to deserve one?
 *
 * The measure is deliberately geometric rather than a count of settlements. A
 * run that founds six settlements in a huddle around the capital is worse than
 * one that founds three out where the deposits are, so what gets reported is:
 *
 *  - **clusters**: claimed-node clusters (a node with enough claimed company
 *    inside `resourceRange` to be worth a place of its own), and how many have
 *    a seat near them. An unserved cluster is the reported bug, made countable.
 *  - **commute**: how far a worked site sits from the nearest seat. This is
 *    what an unserved cluster costs, in the currency the economy actually pays.
 *  - **stalls**: candidate ground the emergence system is still watching, with
 *    the term breakdown behind its potential and which founding gate it fails.
 *    This is where "hovering at 65-75%" becomes a specific diagnosis.
 *
 * Run with `node tools/.build/clustertest.mjs --seeds 1234,5,77 --days 150`.
 */
import { dist, type Vec2 } from '../src/sim/geometry';
import { createWorldConfig } from '../src/sim/map';
import { SETTLEMENT_TUNING } from '../src/sim/settlementSystem';
import { World } from '../src/sim/world';
import { Surveyor } from './surveyor';

const HOURS_PER_DAY = 24;
const DT = 1 / 20;

/** Matches `settlementSystem.ts`'s own gate; recomputed here, not imported, so
 * this tool reports what the rule *would* say without the sim having to tell it. */
const POPULATION_PER_PLACE = 9;

/**
 * Claimed neighbours (counting itself) inside `resourceRange` that make a spot
 * worth a place of its own. Two is a pair of sites a single road serves; three
 * is a genuine concentration, which is the case the report is about.
 */
const CLUSTER_MEMBERS = 3;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Seat {
  name: string;
  position: Vec2;
}

interface Cluster {
  centre: Vec2;
  members: number;
  /** Distance from the cluster centre to the nearest seat. */
  toSeat: number;
  seat: string;
  served: boolean;
  /**
   * What the emergence system sees at this ground. `goods` below
   * `minimumGoods` means the patch is never scored at all — the cluster is
   * not losing a contest, it is not in one.
   *
   * Measured on the busiest *road* ground within range of the cluster rather
   * than at its centroid: a settlement can only ever found on a road (see
   * `World.foundSettlement`, which needs `placeSiteOn` to split one), and the
   * centroid of three deposits routinely sits in open country the road runs
   * past rather than through. Asking at the centroid would report "no
   * traffic" for a cluster with a busy road round the corner.
   */
  goods: number;
  potential: number;
  parts: Record<string, number>;
  /** How much of the cluster is actually plugged in and staffed. */
  connected: number;
  worked: number;
  /** Whether any road at all comes within range. */
  roaded: boolean;
}

interface SeedResult {
  seed: number;
  day: number;
  population: number;
  settlements: number;
  clusters: number;
  served: number;
  /** The clusters with no seat of their own — the reported bug, itemised. */
  unserved: Cluster[];
  meanCommute: number;
  maxCommute: number;
  workedSites: number;
  stalls: Stall[];
  sites: WorkedSite[];
}

/**
 * One staffed deposit, for testing whether the traffic field is distance-biased.
 * If `goods` falls away with `toSeat` even where `collected` holds up, then
 * settlement emergence cannot see remote production — not because it is
 * judging it harshly, but because the signal it judges on has decayed.
 */
interface WorkedSite {
  toSeat: number;
  /** Only ever incremented by `collect()` — this is what was *carried away*,
   * not what was produced. A node nobody visits reads zero however hard its
   * worker has been going. */
  collected: number;
  goods: number;
  /** `produce()` returns nothing at all once `isFull`, so a shed nobody empties
   * stops the work rather than queueing it. */
  stored: number;
  capacity: number;
  full: boolean;
  /**
   * Seconds this node has sat full with nobody even dispatched toward it.
   * Large here means "passed over again and again", not "only just claimed" —
   * which is exactly what separates a starved site from a young one.
   */
  fullSince: number;
}

interface Stall {
  potential: number;
  parts: Record<string, number>;
  blockedBy: string;
  toSeat: number;
}

function seatsOf(world: World): Seat[] {
  return [
    { name: world.village.name, position: world.village.position },
    ...world.settlements.map((s) => ({ name: s.name, position: s.position })),
  ];
}

function nearestSeat(point: Vec2, seats: Seat[]): { seat: Seat; d: number } {
  let best = seats[0];
  let bestD = Infinity;
  for (const seat of seats) {
    const d = dist(seat.position, point);
    if (d < bestD) {
      bestD = d;
      best = seat;
    }
  }
  return { seat: best, d: bestD };
}

/**
 * The busiest road ground within settlement range of a point — i.e. the spot
 * that would actually become the settlement, if one were ever going to.
 * Returns null when no road comes near at all.
 */
function busiestRoadNear(world: World, centre: Vec2): { point: Vec2; goods: number } | null {
  let best: { point: Vec2; goods: number } | null = null;

  for (const edge of world.network.edges) {
    for (const point of edge.points) {
      if (dist(point, centre) > SETTLEMENT_TUNING.resourceRange) continue;
      const goods = world.traffic.totalGoodsAtIndex(world.traffic.indexAt(point));
      if (!best || goods > best.goods) best = { point, goods };
    }
  }

  return best;
}

/**
 * Claimed deposits grouped into the concentrations a settlement would serve.
 * Greedy: take the node with the most claimed company left unassigned, absorb
 * everything inside `resourceRange` of it, repeat. Good enough to count
 * "how many distinct places deserve a town", which is all this needs to do.
 */
function clustersOf(world: World, seats: Seat[]): Cluster[] {
  const claimed = world.nodes.filter((n) => n.isClaimed);
  const taken = new Set<number>();
  const clusters: Cluster[] = [];

  for (;;) {
    let best: { node: (typeof claimed)[number]; near: (typeof claimed)[number][] } | null = null;
    for (const node of claimed) {
      if (taken.has(node.id)) continue;
      const near = claimed.filter(
        (other) => !taken.has(other.id) && dist(other.position, node.position) <= SETTLEMENT_TUNING.resourceRange,
      );
      if (!best || near.length > best.near.length) best = { node, near };
    }
    if (!best || best.near.length < CLUSTER_MEMBERS) break;

    for (const n of best.near) taken.add(n.id);
    const centre = {
      x: best.near.reduce((s, n) => s + n.position.x, 0) / best.near.length,
      y: best.near.reduce((s, n) => s + n.position.y, 0) / best.near.length,
    };
    const { seat, d } = nearestSeat(centre, seats);
    const busiest = busiestRoadNear(world, centre);
    clusters.push({
      centre,
      members: best.near.length,
      toSeat: d,
      seat: seat.name,
      // A seat inside the same range the cluster was built from is serving it.
      served: d <= SETTLEMENT_TUNING.resourceRange,
      goods: busiest ? busiest.goods : 0,
      potential: busiest ? world.potentialAt(busiest.point) : 0,
      parts: busiest ? world.potentialBreakdown(busiest.point) : {},
      connected: best.near.filter((n) => n.isConnected).length,
      worked: best.near.filter((n) => n.workers.length > 0).length,
      roaded: busiest !== null,
    });
  }

  return clusters;
}

/**
 * Why a candidate patch has not founded. Recomputes `tryFound`'s gates from
 * public world state rather than instrumenting the sim, so this stays a
 * measurement tool and the rules stay in one place.
 */
function blockedBy(position: Vec2, parts: Record<string, number>, world: World): string {
  if ((parts.resources ?? 0) < SETTLEMENT_TUNING.minimumResourceProximity) return 'resources';

  const worked = world.nodes.some((n) => {
    if (!n.isClaimed || n.workers.length === 0) return false;
    const d = dist(n.position, position);
    return d >= SETTLEMENT_TUNING.resourceExclusion && d <= SETTLEMENT_TUNING.resourceRange;
  });
  if (!worked) return 'no-worked-site';

  const places = world.settlements.length + 1;
  if (world.villagers.length < places * POPULATION_PER_PLACE) {
    return `population(${world.villagers.length}/${places * POPULATION_PER_PLACE})`;
  }

  // Everything `tryFound` checks passes, so the only thing left is potential
  // not yet having eased up to a stage above Site.
  return 'potential';
}

function run(seed: number, days: number, policy: 'greedy' | 'measured'): SeedResult {
  const world = new World(createWorldConfig(seed));
  const surveyor = new Surveyor({ roadInterval: 25, policy, verbose: false });

  const totalSeconds = days * HOURS_PER_DAY;
  for (let t = 0; t < totalSeconds; t += DT) {
    world.update(DT);
    surveyor.update(world, DT);
    world.drainEvents();
    world.drainUncoveredChunks();
  }

  const seats = seatsOf(world);
  const clusters = clustersOf(world, seats);

  const worked = world.nodes.filter((n) => n.isClaimed && n.workers.length > 0);
  const commutes = worked.map((n) => nearestSeat(n.position, seats).d);
  const sites: WorkedSite[] = worked.map((n) => {
    const busiest = busiestRoadNear(world, n.position);
    return {
      toSeat: nearestSeat(n.position, seats).d,
      collected: n.cumulativeCollected,
      goods: busiest ? busiest.goods : 0,
      stored: n.stored,
      capacity: n.capacity,
      full: n.isFull,
      fullSince: n.fullSince,
    };
  });

  const stalls: Stall[] = world.watchedSites
    .filter((c) => c.potential > 0.2)
    .map((c) => ({
      potential: c.potential,
      parts: c.parts,
      blockedBy: blockedBy(c.position, c.parts, world),
      toSeat: nearestSeat(c.position, seats).d,
    }));

  return {
    seed,
    day: world.day,
    population: world.villagers.length,
    settlements: world.settlements.length,
    clusters: clusters.length,
    served: clusters.filter((c) => c.served).length,
    unserved: clusters.filter((c) => !c.served),
    meanCommute: commutes.length ? commutes.reduce((a, b) => a + b, 0) / commutes.length : 0,
    maxCommute: commutes.length ? Math.max(...commutes) : 0,
    workedSites: commutes.length,
    stalls,
    sites,
  };
}

// ---------------------------------------------------------------------- main

const seeds = arg('seeds', '1234,5,77,2026,404')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((s) => Number.isFinite(s));
const days = Number(arg('days', '150'));
const policy = arg('policy', 'measured') as 'greedy' | 'measured';
const label = arg('label', 'run');

const pad = (v: string | number, w: number) => String(v).padStart(w);
const f2 = (v: number) => v.toFixed(2);

console.log(`=== Cluster test [${label}]  seeds=${seeds.join(',')} days=${days} policy=${policy} ===`);
console.log(' seed  pop  setl | clusters served unserved | commute mean   max | worked');

const results: SeedResult[] = [];
for (const seed of seeds) {
  const r = run(seed, days, policy);
  results.push(r);
  console.log(
    `${pad(r.seed, 5)} ${pad(r.population, 4)} ${pad(r.settlements, 5)} | ${pad(r.clusters, 8)} ${pad(
      r.served,
      6,
    )} ${pad(r.clusters - r.served, 8)} | ${pad(Math.round(r.meanCommute), 12)} ${pad(
      Math.round(r.maxCommute),
      5,
    )} | ${pad(r.workedSites, 6)}`,
  );
}

const sum = (f: (r: SeedResult) => number) => results.reduce((s, r) => s + f(r), 0);
const clusters = sum((r) => r.clusters);
const served = sum((r) => r.served);
// Commute is averaged over sites, not over seeds, so a seed with two worked
// sites does not weigh as much as one with twenty.
const commuteTotal = sum((r) => r.meanCommute * r.workedSites);
const workedTotal = sum((r) => r.workedSites);

console.log(`\nTOTALS [${label}]`);
console.log(`  population        ${sum((r) => r.population)}`);
console.log(`  settlements       ${sum((r) => r.settlements)}`);
console.log(
  `  clusters served   ${served}/${clusters}  (${clusters ? Math.round((100 * served) / clusters) : 0}%)`,
);
console.log(`  mean commute      ${Math.round(commuteTotal / Math.max(1, workedTotal))}u over ${workedTotal} worked sites`);
console.log(`  worst commute     ${Math.round(Math.max(0, ...results.map((r) => r.maxCommute)))}u`);

console.log('\nUNSERVED CLUSTERS  (claimed deposits dense enough to deserve a place, with none near)');
console.log('  (goods/pot measured on the busiest road ground within range — where a place would actually stand)');
console.log('  seed  sites  con  wrk  toSeat  goods   pot  why');
for (const r of results) {
  for (const c of r.unserved) {
    const p = c.parts;
    const why = !c.roaded
      ? 'no road within range — nothing to found on'
      : c.goods < SETTLEMENT_TUNING.minimumGoods
        ? `too quiet to be scored at all (needs ${SETTLEMENT_TUNING.minimumGoods})`
        : `scored: traffic=${f2(p.traffic ?? 0)} junction=${f2(p.junction ?? 0)} resources=${f2(
            p.resources ?? 0,
          )} terrain=${f2(p.terrain ?? 0)} crowd=${f2(p.crowding ?? 0)}`;
    console.log(
      `  ${pad(r.seed, 4)} ${pad(c.members, 6)} ${pad(c.connected, 4)} ${pad(c.worked, 4)} ${pad(
        Math.round(c.toSeat),
        7,
      )} ${pad(f2(c.goods), 6)} ${pad(f2(c.potential), 5)}  ${why}`,
    );
  }
}

// The decisive test for a distance-biased signal. Production is a property of
// the ground and should not care how far from a town it sits; goods on the
// road is what emergence actually reads. If the first holds up across the
// buckets while the second collapses, the signal is the problem.
console.log('\nIS THE TRAFFIC SIGNAL DISTANCE-BIASED?  (staffed sites, bucketed by distance to nearest seat)');
console.log('  distance band   sites   mean collected   mean goods on road   scoreable (goods>=4)   shed full   mean fullSince');
const bands: Array<[string, number, number]> = [
  ['0-360      ', 0, 360],
  ['360-520    ', 360, 520],
  ['520-1000   ', 520, 1000],
  ['1000-2000  ', 1000, 2000],
  ['2000+      ', 2000, Infinity],
];
const allSites = results.flatMap((r) => r.sites);
for (const [name, lo, hi] of bands) {
  const inBand = allSites.filter((s) => s.toSeat >= lo && s.toSeat < hi);
  if (inBand.length === 0) continue;
  const meanCollected = inBand.reduce((s, x) => s + x.collected, 0) / inBand.length;
  const meanGoods = inBand.reduce((s, x) => s + x.goods, 0) / inBand.length;
  const scoreable = inBand.filter((s) => s.goods >= SETTLEMENT_TUNING.minimumGoods).length;
  const full = inBand.filter((s) => s.full).length;
  const meanFullSince = inBand.reduce((s, x) => s + x.fullSince, 0) / inBand.length;
  console.log(
    `  ${name}   ${pad(inBand.length, 5)}   ${pad(Math.round(meanCollected), 14)}   ${pad(
      f2(meanGoods),
      18,
    )}   ${pad(`${scoreable}/${inBand.length}`, 20)}   ${pad(`${full}/${inBand.length}`, 9)}   ${pad(Math.round(meanFullSince), 13)}`,
  );
}

console.log('\nSTALLED CANDIDATES  (ground still being watched at the end of the run)');
console.log('  seed   pot  toSeat  blockedBy        traffic quality junction resources terrain crowd');
for (const r of results) {
  for (const s of r.stalls) {
    const p = s.parts;
    console.log(
      `  ${pad(r.seed, 5)} ${pad(f2(s.potential), 5)} ${pad(Math.round(s.toSeat), 7)}  ${s.blockedBy.padEnd(16)} ${pad(
        f2(p.traffic ?? 0),
        7,
      )} ${pad(f2(p.quality ?? 0), 7)} ${pad(f2(p.junction ?? 0), 8)} ${pad(f2(p.resources ?? 0), 9)} ${pad(
        f2(p.terrain ?? 0),
        7,
      )} ${pad(f2(p.crowding ?? 0), 5)}`,
    );
  }
}
