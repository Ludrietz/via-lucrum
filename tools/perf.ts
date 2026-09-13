/** Where does the tick go, as the realm grows? */
import { createWorldConfig } from '../src/sim/map';
import { World } from '../src/sim/world';
import { Surveyor } from './surveyor';

const seed = Number(process.argv[2] ?? 1234);
const days = Number(process.argv[3] ?? 90);
const world = new World(createWorldConfig(seed));
const surveyor = new Surveyor({ roadInterval: 6, policy: 'measured', verbose: false });
const DT = 1 / 20;
let bucket = 0;
let ticks = 0;
let nextDay = 15;
for (let t = 0; t < days * 24; t += DT) {
  const t0 = performance.now();
  world.update(DT);
  surveyor.update(world, DT);
  world.drainEvents();
  world.drainUncoveredChunks();
  bucket += performance.now() - t0;
  ticks++;
  if (world.day >= nextDay) {
    console.log(
      `day ${String(world.day).padStart(3)}  ${(bucket / ticks).toFixed(3)} ms/tick  ` +
        `pop=${world.villagers.length} nodes=${world.nodes.length} edges=${world.network.edges.length} ` +
        `holdings=${world.territory.all.length}`,
    );
    bucket = 0;
    ticks = 0;
    nextDay += 15;
  }
}
