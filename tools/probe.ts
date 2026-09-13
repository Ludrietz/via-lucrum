/**
 * Reveal probe. Asks one question the ordinary playtest report cannot: how
 * much of the world does the player ever actually get to *see*, and in how
 * many directions from the realm?
 *
 * "A handful of nodes, all in one place" and "sites in most directions from
 * the border" are both statements about the distribution of what is visible,
 * not about how many nodes exist — so measure the distribution.
 */
import { ResourceType, NodeState } from '../src/sim/types';
import { createWorldConfig } from '../src/sim/map';
import { World } from '../src/sim/world';
import { Surveyor } from './surveyor';

const args = process.argv.slice(2);
const arg = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

const seed = arg('seed', 1234);
const days = arg('days', 60);
const DT = 1 / 20;

const world = new World(createWorldConfig(seed));
const surveyor = new Surveyor({ roadInterval: 6, policy: 'measured', verbose: false });

/** Which 45-degree sector of the compass a point sits in, seen from the realm's heart. */
function sector(dx: number, dy: number): number {
  return Math.floor((((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)));
}

const report = (label: string) => {
  const seat = world.village.position;
  const visible = world.nodes.filter((n) => n.isVisible);
  const claimed = world.nodes.filter((n) => n.isClaimed);
  const sectorsVisible = new Set(visible.map((n) => sector(n.position.x - seat.x, n.position.y - seat.y)));
  const sectorsFrontier = new Set(
    world.nodes.filter((n) => n.state === NodeState.Frontier).map((n) => sector(n.position.x - seat.x, n.position.y - seat.y)),
  );
  const byRes = new Map<string, number>();
  for (const n of visible) byRes.set(n.resource, (byRes.get(n.resource) ?? 0) + 1);
  console.log(
    `${label.padEnd(9)} gen=${String(world.nodes.length).padStart(4)} vis=${String(visible.length).padStart(3)}` +
      ` frontier=${String(world.frontier.length)} clm=${String(claimed.length).padStart(3)}` +
      ` | vis-sectors=${sectorsVisible.size}/8 offer-sectors=${sectorsFrontier.size}/8` +
      ` | pop=${String(world.villagers.length).padStart(3)} setl=${world.settlements.length}` +
      ` cap=${world.expansionCapacity.toFixed(0)}` +
      ` | mix ${[...byRes].map(([r, n]) => `${r}=${n}`).join(' ')}`,
  );
};

let nextReport = 0;
for (let t = 0; t < days * 24; t += DT) {
  world.update(DT);
  surveyor.update(world, DT);
  world.drainEvents();
  world.drainUncoveredChunks();
  if (t >= nextReport) {
    report(`day ${world.day}`);
    nextReport += 10 * 24;
  }
}
report(`FINAL`);

// How far out does the player ever see, against how far the world was decided?
const seat = world.village.position;
const d = (n: { position: { x: number; y: number } }) => Math.hypot(n.position.x - seat.x, n.position.y - seat.y);
const visible = world.nodes.filter((n) => n.isVisible);
const gen = world.nodes.map(d).sort((a, b) => a - b);
const vis = visible.map(d).sort((a, b) => a - b);
console.log(
  `\nreach: generated nodes out to ${Math.round(gen[gen.length - 1] ?? 0)}u;` +
    ` ever-visible out to ${Math.round(vis[vis.length - 1] ?? 0)}u` +
    ` (median visible ${Math.round(vis[Math.floor(vis.length / 2)] ?? 0)}u)`,
);
console.log(
  `hidden inside 2000u of the seat: ${world.nodes.filter((n) => d(n) < 2000 && n.state === NodeState.Hidden).length}` +
    ` of ${world.nodes.filter((n) => d(n) < 2000).length}`,
);
