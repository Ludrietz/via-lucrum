/**
 * Headless playtest. Runs the whole simulation with no Phaser and no window,
 * driven by `Surveyor` standing in for a player, and prints a readout of what
 * the civilisation actually did.
 *
 * Usage:
 *   node tools/run-playtest.mjs --seed 1234 --days 200 --policy greedy
 */

import { shortage, sustainablePopulation, throughputPerMin, wealthIncomePerMin } from '../src/sim/economy';
import { housingCapacity } from '../src/sim/housing';
import { createWorldConfig } from '../src/sim/map';
import { TIER_LABELS } from '../src/sim/tier';
import { ResourceType, VillagerRole } from '../src/sim/types';
import { World, type WorldConfig } from '../src/sim/world';
import { Surveyor } from './surveyor';

const HOURS_PER_DAY = 24;
/** Sim step. The world clamps at 0.1; smaller is more faithful, slower to run. */
const DT = 1 / 20;

export interface PlaytestOptions {
  seed: number;
  days: number;
  policy: 'greedy' | 'measured';
  roadInterval: number;
  /** In-game days between report lines. */
  reportEvery: number;
  verbose: boolean;
  /**
   * The world to run. Omitted, the harness generates one from `seed` — which
   * is what every balance question has always been asked against. Supplied,
   * it runs whatever it was given, which is how an authored map gets
   * exercised by the same stand-in player and reported in the same columns
   * as a procedural one. Comparing the two is most of the point.
   */
  config?: WorldConfig;
}

export interface Snapshot {
  day: number;
  population: number;
  populationTarget: number;
  workers: number;
  transporters: number;
  idle: number;
  dependents: number;
  settlements: number;
  connectedNodes: number;
  visibleNodes: number;
  operationalNodes: number;
  totalNodes: number;
  meanNodeLevel: number;
  roadEdges: number;
  roadLength: number;
  junctions: number;
  industryWorkers: number;
  wealth: number;
  wealthIncome: number;
  foodThroughput: number;
  foodShortage: number;
  woodShortage: number;
  stoneShortage: number;
  ironShortage: number;
  toolsShortage: number;
  investedNodes: number;
  capacity: number;
  capacityRate: number;
  claimed: number;
  offers: number;
  housing: number;
  topTier: string;
}

export function snapshot(world: World): Snapshot {
  const villagers = world.villagers;
  const nodes = world.nodes;
  const connected = nodes.filter((n) => n.isConnected);
  const levels = connected.map((n) => n.level);

  let roadLength = 0;
  for (const edge of world.network.edges) roadLength += edge.length;

  const worst = (r: ResourceType) => Math.max(0, ...world.traders.map((t) => shortage(t, r)));

  return {
    day: world.day,
    population: villagers.length,
    populationTarget: world.populationTarget,
    workers: villagers.filter((v) => v.role === VillagerRole.Worker).length,
    transporters: villagers.filter((v) => v.role === VillagerRole.Transporter).length,
    idle: villagers.filter((v) => v.role === VillagerRole.Idle && !v.isDependent).length,
    dependents: villagers.filter((v) => v.isDependent).length,
    settlements: world.settlements.length,
    connectedNodes: connected.length,
    visibleNodes: world.visibleNodes.length,
    operationalNodes: nodes.filter((n) => n.workers.length > 0).length,
    totalNodes: nodes.length,
    meanNodeLevel: levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0,
    roadEdges: world.network.edges.length,
    roadLength,
    junctions: world.network.nodes.filter((n) => n.isJunction).length,
    industryWorkers: world.traders.reduce((s, t) => s + t.industries.reduce((n, i) => n + i.workers.length, 0), 0),
    wealth: world.traders.reduce((s, t) => s + t.wealth, 0),
    wealthIncome: world.traders.reduce((s, t) => s + wealthIncomePerMin(t), 0),
    foodThroughput: world.traders.reduce((s, t) => s + throughputPerMin(t, ResourceType.Food), 0),
    foodShortage: worst(ResourceType.Food),
    woodShortage: worst(ResourceType.Wood),
    stoneShortage: worst(ResourceType.Stone),
    ironShortage: worst(ResourceType.Iron),
    toolsShortage: worst(ResourceType.Tools),
    investedNodes: nodes.filter((n) => n.investedResource > 0).length,
    capacity: world.expansionCapacity,
    capacityRate: world.capacityRate.total,
    claimed: nodes.filter((n) => n.isClaimed).length,
    offers: world.frontier.length,
    housing: world.traders.reduce((s, t) => s + housingCapacity(t), 0),
    topTier: TIER_LABELS[
      world.traders.reduce((a, b) => (a.development >= b.development ? a : b)).tier
    ],
  };
}

export function runPlaytest(options: PlaytestOptions): { world: World; surveyor: Surveyor; timeline: Snapshot[] } {
  const world = new World(options.config ?? createWorldConfig(options.seed));
  const surveyor = new Surveyor({
    roadInterval: options.roadInterval,
    policy: options.policy,
    verbose: options.verbose,
  });

  const timeline: Snapshot[] = [];
  const totalSeconds = options.days * HOURS_PER_DAY;
  let nextReport = 0;

  for (let t = 0; t < totalSeconds; t += DT) {
    world.update(DT);
    surveyor.update(world, DT);
    world.drainEvents();
    world.drainUncoveredChunks();

    if (t >= nextReport) {
      timeline.push(snapshot(world));
      nextReport += options.reportEvery * HOURS_PER_DAY;
    }
  }

  timeline.push(snapshot(world));
  return { world, surveyor, timeline };
}

// ---------------------------------------------------------------- reporting

const pad = (v: string | number, w: number) => String(v).padStart(w);
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

export function printTimeline(timeline: Snapshot[]): void {
  // eslint-disable-next-line no-console
  const log = console.log;
  log(
    ' day  pop (tgt)  wrk trn idl dep | setl | cap  +/min ofr | nodes clm/con/op lvl | roads len   junc | ind | wealth  inc | food/min shortages f/w/s/i/T',
  );
  for (const s of timeline) {
    log(
      `${pad(s.day, 4)} ${pad(s.population, 4)} (${pad(f1(s.populationTarget), 5)}) ${pad(s.workers, 3)} ${pad(
        s.transporters,
        3,
      )} ${pad(s.idle, 3)} ${pad(s.dependents, 3)} | ${pad(s.settlements, 4)} | ${pad(f1(s.capacity), 5)} ${pad(f1(s.capacityRate), 5)} ${pad(s.offers, 3)} | ${pad(s.claimed, 5)}/${pad(
        s.connectedNodes,
        3,
      )}/${pad(s.operationalNodes, 3)} ${f1(s.meanNodeLevel)} | ${pad(s.roadEdges, 5)} ${pad(
        Math.round(s.roadLength),
        6,
      )} ${pad(s.junctions, 4)} | ${pad(s.industryWorkers, 3)} | ${pad(Math.round(s.wealth), 6)} ${pad(
        f1(s.wealthIncome),
        4,
      )} | ${pad(f1(s.foodThroughput), 6)}  ${f2(s.foodShortage)}/${f2(s.woodShortage)}/${f2(s.stoneShortage)}/${f2(
        s.ironShortage,
      )}/${f2(s.toolsShortage)}`,
    );
  }
}

export function printPlaces(world: World): void {
  // eslint-disable-next-line no-console
  const log = console.log;
  log('\nPLACES');
  log('  name              tier        pop  dev     wealth  inc/min  food  wood  stone  iron  plk  blk  tls  ind');
  for (const trader of world.traders) {
    const industries = trader.industries.filter((i) => i.workers.length > 0).map((i) => i.type).join(',');
    log(
      `  ${trader.name.padEnd(17)} ${TIER_LABELS[trader.tier].padEnd(11)} ${pad(trader.population, 3)} ${pad(
        Math.round(trader.development),
        6,
      )} ${pad(Math.round(trader.wealth), 8)} ${pad(f1(wealthIncomePerMin(trader)), 7)} ${pad(
        Math.round(trader.storage[ResourceType.Food]),
        5,
      )} ${pad(Math.round(trader.storage[ResourceType.Wood]), 5)} ${pad(
        Math.round(trader.storage[ResourceType.Stone]),
        6,
      )} ${pad(Math.round(trader.storage[ResourceType.Iron]), 5)} ${pad(
        Math.round(trader.storage[ResourceType.Planks]),
        4,
      )} ${pad(Math.round(trader.storage[ResourceType.StoneBlocks]), 4)} ${pad(
        Math.round(trader.storage[ResourceType.Tools]),
        4,
      )} ${industries}`,
    );
  }
  log(`  civ sustainable population: ${f1(world.traders.reduce((s, t) => s + sustainablePopulation(t), 0))}`);
}

export function printNodes(world: World): void {
  // eslint-disable-next-line no-console
  const log = console.log;
  const connected = world.nodes.filter((n) => n.isConnected);
  log(`\nNODES  (${world.nodes.length} generated, ${world.visibleNodes.length} visible, ${connected.length} connected)`);
  log('  name                    res     lvl  wkrs  stored  lifetime  invested/next  state');
  for (const node of connected.sort((a, b) => b.cumulativeCollected - a.cumulativeCollected)) {
    log(
      `  ${node.name.padEnd(23)} ${node.resource.padEnd(7)} ${pad(node.level, 3)} ${pad(node.workers.length, 5)}/${
        node.workerCapacity
      } ${pad(Math.round(node.stored), 6)} ${pad(Math.round(node.cumulativeCollected), 9)} ${pad(
        Math.round(node.investedResource),
        8,
      )}/${node.investmentProgress.next ?? '-'}  ${node.state}`,
    );
  }
  const byResource = new Map<string, number>();
  for (const node of world.nodes) byResource.set(node.resource, (byResource.get(node.resource) ?? 0) + 1);
  log(`  generated mix: ${[...byResource].map(([r, n]) => `${r}=${n}`).join(' ')}`);
}

export function printRoads(world: World, surveyor: Surveyor): void {
  // eslint-disable-next-line no-console
  const log = console.log;
  const branched = surveyor.roads.filter((r) => r.branched).length;
  let length = 0;
  for (const edge of world.network.edges) length += edge.length;
  const degrees = world.network.nodes.map((n) => n.edges.length);
  const forks = degrees.filter((d) => d >= 3).length;
  const deadEnds = world.network.nodes.filter((n) => n.isJunction && n.edges.length === 1).length;

  log('\nROADS');
  log(
    `  drawn: ${surveyor.roads.length} — ${branched} branched off an existing road, ${
      surveyor.roads.length - branched
    } from a site`,
  );
  log(`  live stretches: ${world.network.edges.length}, total length ${Math.round(length)}u`);
  log(`  graph nodes: ${world.network.nodes.length} (${forks} forks of degree 3+, ${deadEnds} open ends)`);

  // What the network actually looks like: if traffic concentrates into a few
  // heavily-walked trunks with quiet spurs hanging off them, wear should be
  // very unevenly spread. A starburst of equal spokes reads as flat.
  const wear = world.network.edges.map((e) => world.wearOf(e)).sort((a, b) => b - a);
  if (wear.length > 0) {
    const trunkLength = world.network.edges
      .filter((e) => world.wearOf(e) >= wear[0] * 0.5)
      .reduce((sum, e) => sum + e.length, 0);
    log(
      `  wear: max ${f2(wear[0])}, median ${f2(wear[Math.floor(wear.length / 2)])}, min ${f2(wear[wear.length - 1])}`,
    );
    log(
      `  trunk share: ${Math.round((100 * trunkLength) / Math.max(1, length))}% of road length carries at least half the busiest stretch's traffic`,
    );
  }
}

export function printClaims(surveyor: Surveyor): void {
  // eslint-disable-next-line no-console
  const log = console.log;
  log(`\nEXPANSION  (${surveyor.claims.length} claims)`);
  const byResource = new Map<string, number>();
  for (const c of surveyor.claims) byResource.set(c.resource, (byResource.get(c.resource) ?? 0) + 1);
  log(`  by kind: ${[...byResource].map(([r, n]) => `${r}=${n}`).join(' ') || 'none'}`);
  for (const c of surveyor.claims.slice(-12)) {
    log(`  day ${pad(Math.floor(c.hours / HOURS_PER_DAY) + 1, 4)}  ${c.name.padEnd(22)} ${c.resource.padEnd(6)} ${pad(c.cost, 4)}`);
  }
}
