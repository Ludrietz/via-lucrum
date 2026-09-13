/**
 * Multi-seed summary. One line per seed, so a change can be judged against
 * the distribution rather than against whichever seed happened to be open —
 * this project has been burned more than once by a fix that looked decisive
 * on seed 1234 and did nothing, or harm, everywhere else.
 */
import { NodeState } from '../src/sim/types';
import { createWorldConfig } from '../src/sim/map';
import { World } from '../src/sim/world';
import { Surveyor } from './surveyor';

const args = process.argv.slice(2);
const arg = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const days = arg('days', 60);
const count = arg('seeds', 6);
const first = arg('from', 1234);
const DT = 1 / 20;

const sector = (dx: number, dy: number, n = 8) =>
  Math.floor((((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * n);

const rows: Record<string, number>[] = [];
console.log('seed   pop  setl clm  vis/gen  visSec offSec  ofr gho  reach  nearHidden');

for (let s = 0; s < count; s++) {
  const seed = first + s * 7;
  const world = new World(createWorldConfig(seed));
  const surveyor = new Surveyor({ roadInterval: 6, policy: 'measured', verbose: false });
  for (let t = 0; t < days * 24; t += DT) {
    world.update(DT);
    surveyor.update(world, DT);
    world.drainEvents();
    world.drainUncoveredChunks();
  }

  const seat = world.village.position;
  const d = (p: { x: number; y: number }) => Math.hypot(p.x - seat.x, p.y - seat.y);
  const visible = world.nodes.filter((n) => n.isVisible);
  const visSec = new Set(visible.map((n) => sector(n.position.x - seat.x, n.position.y - seat.y))).size;
  const offSec = new Set(
    world.nodes
      .filter((n) => n.state === NodeState.Frontier)
      .map((n) => sector(n.position.x - seat.x, n.position.y - seat.y)),
  ).size;
  const near = world.nodes.filter((n) => d(n.position) < 2500);
  const row = {
    seed,
    pop: world.villagers.length,
    setl: world.settlements.length,
    clm: world.nodes.filter((n) => n.isClaimed).length,
    vis: visible.length,
    gen: world.nodes.length,
    visSec,
    offSec,
    ofr: world.frontier.length,
    ghosts: world.settlements.filter((s) => s.population === 0).length,
    reach: Math.round(Math.max(0, ...visible.map((n) => d(n.position)))),
    nearHidden: near.filter((n) => !n.isVisible).length,
  };
  rows.push(row);
  console.log(
    `${String(row.seed).padEnd(6)} ${String(row.pop).padStart(4)} ${String(row.setl).padStart(4)} ${String(
      row.clm,
    ).padStart(4)} ${String(row.vis).padStart(4)}/${String(row.gen).padStart(4)} ${String(row.visSec).padStart(
      6,
    )} ${String(row.offSec).padStart(6)} ${String(row.ofr).padStart(4)} ${String(row.ghosts).padStart(3)} ${String(row.reach).padStart(6)} ${String(
      row.nearHidden,
    ).padStart(11)}`,
  );
}

const mean = (k: string) => (rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(1);
console.log(
  `MEAN   ${mean('pop').padStart(4)} ${mean('setl').padStart(4)} ${mean('clm').padStart(4)} ${mean('vis').padStart(
    4,
  )}/${mean('gen').padStart(4)} ${mean('visSec').padStart(6)} ${mean('offSec').padStart(6)} ${mean('ofr').padStart(4)} ${mean('ghosts').padStart(3)} ${mean('reach').padStart(6)} ${mean('nearHidden').padStart(11)}`,
);
