/**
 * Reproduce the reported "snake" play pattern directly, instead of hoping the
 * general-purpose surveyor stumbles into it.
 *
 * A real player who finds one promising line of deposits (a river valley, a
 * forest edge) tends to follow it: claim whichever frontier offer keeps
 * heading the way they were already going, then drag one more road segment
 * onward from the tip. This script does exactly that — no branching, no
 * "which is cheapest overall", just "keep going the way I was going" — and
 * reports what it costs and what happens to population, settlements, and how
 * far workers end up commuting.
 */
import { dist } from '../src/sim/geometry';
import { createWorldConfig } from '../src/sim/map';
import { World } from '../src/sim/world';
import { nearestTrader } from '../src/sim/systems';
import { VillagerRole } from '../src/sim/types';

const seed = Number(process.argv[2] ?? '1234');
const days = Number(process.argv[3] ?? '150');
const DT = 1 / 20;
const HOURS_PER_DAY = 24;

const world = new World(createWorldConfig(seed));

// The founding farm and woodlot are claimed automatically but not roaded —
// a real player draws those two roads in their first few seconds (it's the
// tutorial hint). Do the same here, or the village starves before turn one.
for (const n of world.nodes.filter((n) => n.isClaimed)) {
  world.buildRoad([{ ...world.village.position }, { ...n.position }]);
}

// Establish an initial heading: away from the village, toward whatever the
// first frontier offer suggests.
let heading = { x: 1, y: 0 };
let tip = world.village.position;

function pickNext(): { node: (typeof world.frontier)[number]['node']; cost: number } | null {
  const offers = world.frontier;
  if (offers.length === 0) return null;

  // "Keep going the way I was going": among affordable offers, prefer the
  // one whose direction from the current tip best matches the established
  // heading. If nothing is affordable, wait.
  const affordable = offers.filter((o) => world.expansionCapacity >= o.cost);
  if (affordable.length === 0) return null;

  let best = affordable[0];
  let bestDot = -Infinity;
  for (const o of affordable) {
    const dx = o.node.position.x - tip.x;
    const dy = o.node.position.y - tip.y;
    const len = Math.hypot(dx, dy) || 1;
    const dot = (dx / len) * heading.x + (dy / len) * heading.y;
    if (dot > bestDot) {
      bestDot = dot;
      best = o;
    }
  }
  return { node: best.node, cost: best.cost };
}

interface LogRow {
  day: number;
  claims: number;
  cost: number;
  totalSpent: number;
  population: number;
  settlements: number;
  capacity: number;
  farthestClaimDist: number;
  transporterShare: number;
}

const log: LogRow[] = [];
let claims = 0;
let totalSpent = 0;
let lastClaimDay = 0;

const totalSeconds = days * HOURS_PER_DAY;
for (let t = 0; t < totalSeconds; t += DT) {
  world.update(DT);

  // Once a second (sim-time), consider claiming and extending the road.
  if (Math.floor(t) !== Math.floor(t - DT)) {
    const pick = pickNext();
    if (pick && world.claim(pick.node)) {
      claims++;
      totalSpent += pick.cost;
      lastClaimDay = world.day;

      // Update heading to point from the old tip to the new claim, and drag
      // a road directly from the tip to it — a real player just extends the
      // line they were already drawing, not routing through the whole
      // network for the cheapest terrain.
      const dx = pick.node.position.x - tip.x;
      const dy = pick.node.position.y - tip.y;
      const len = Math.hypot(dx, dy) || 1;
      heading = { x: dx / len, y: dy / len };

      const path = [{ ...tip }, { ...pick.node.position }];
      world.buildRoad(path);
      tip = { ...pick.node.position };
    }
  }

  world.drainEvents();
  world.drainUncoveredChunks();

  if (Math.abs(t % (10 * HOURS_PER_DAY)) < DT / 2) {
    const working = world.villagers.filter((v) => !v.isDependent).length;
    const transporting = world.villagers.filter((v) => v.role === VillagerRole.Transporter).length;
    const claimedDistances = world.nodes.filter((n) => n.isClaimed).map((n) => dist(n.position, world.village.position));
    log.push({
      day: world.day,
      claims,
      cost: 0,
      totalSpent: Math.round(totalSpent),
      population: world.villagers.length,
      settlements: world.settlements.length,
      capacity: Math.round(world.expansionCapacity),
      farthestClaimDist: Math.round(Math.max(0, ...claimedDistances)),
      transporterShare: working > 0 ? Math.round((100 * transporting) / working) : 0,
    });
  }
}

console.log(`=== Snake test  seed=${seed} days=${days} ===`);
console.log(
  ' day  claims  spent  pop  setl  cap  farthestClaim  transporter%',
);
for (const r of log) {
  console.log(
    `${String(r.day).padStart(4)}  ${String(r.claims).padStart(6)}  ${String(r.totalSpent).padStart(5)}  ${String(
      r.population,
    ).padStart(3)}  ${String(r.settlements).padStart(4)}  ${String(r.capacity).padStart(3)}  ${String(
      r.farthestClaimDist,
    ).padStart(13)}  ${String(r.transporterShare).padStart(12)}`,
  );
}

console.log(`\nLast claim on day ${lastClaimDay}. Total claims: ${claims}. Total spent: ${Math.round(totalSpent)}.`);
console.log(`Average cost per claim: ${claims > 0 ? Math.round(totalSpent / claims) : 0}`);

// Where do workers at the tip of the snake actually commute?
const tipNodes = world.nodes
  .filter((n) => n.isClaimed && n.workers.length > 0)
  .sort((a, b) => dist(b.position, world.village.position) - dist(a.position, world.village.position))
  .slice(0, 5);
console.log('\nFarthest worked sites and who they commute to:');
for (const n of tipNodes) {
  const home = nearestTrader(n.position, world.traders);
  console.log(
    `  ${n.name.padEnd(20)} dist-from-village=${Math.round(dist(n.position, world.village.position))
      .toString()
      .padStart(6)}  homeTrader=${home.name}  distToHome=${Math.round(dist(n.position, home.position))}`,
  );
}

console.log(`\nSettlements founded: ${world.settlements.length}`);
for (const s of world.settlements) {
  console.log(`  ${s.name.padEnd(16)} pop=${s.population} dist-from-village=${Math.round(dist(s.position, world.village.position))}`);
}
