/** Why is no industry ever running? Print every gate, per place, at depth. */
import { shortage, targetStock } from '../src/sim/economy';
import { createWorldConfig } from '../src/sim/map';
import { World } from '../src/sim/world';
import { ResourceType } from '../src/sim/types';
import { Surveyor } from './surveyor';

const seed = Number(process.argv[2] ?? 1234);
const days = Number(process.argv[3] ?? 110);
const world = new World(createWorldConfig(seed));
const surveyor = new Surveyor({ roadInterval: 6, policy: 'measured', verbose: false });
for (let t = 0; t < days * 24; t += 1 / 20) {
  world.update(1 / 20);
  surveyor.update(world, 1 / 20);
  world.drainEvents();
  world.drainUncoveredChunks();
}

const traders = world.traders;
const worst = (r: ResourceType) => Math.max(...traders.map((t) => shortage(t, r)));
console.log(`day ${world.day}  pop ${world.villagers.length}  places ${traders.length}`);
console.log(
  'civ worst shortage: ' +
    [ResourceType.Food, ResourceType.Wood, ResourceType.Stone, ResourceType.Iron]
      .map((r) => `${r}=${worst(r).toFixed(2)}`)
      .join(' '),
);
console.log('\nplace              pop  food  wood stone  iron | industries (hasInput, workers/cap, own input shortage)');
for (const t of traders) {
  const inds = t.industries
    .map((i) => {
      const spare = t.storage[i.recipe.input] - targetStock(t, i.recipe.input) * 0.9;
      return `${i.type}[in=${i.hasInput ? 'Y' : 'n'} ${i.workers.length}/${i.workerCapacity} spare=${spare.toFixed(
        1,
      )} ownShort=${shortage(t, i.recipe.input).toFixed(2)}]`;
    })
    .join(' ');
  console.log(
    `${t.name.padEnd(17)} ${String(t.population).padStart(3)} ${t.storage[ResourceType.Food].toFixed(0).padStart(5)} ${t.storage[
      ResourceType.Wood
    ]
      .toFixed(0)
      .padStart(5)} ${t.storage[ResourceType.Stone].toFixed(0).padStart(5)} ${t.storage[ResourceType.Iron]
      .toFixed(0)
      .padStart(5)} | ${inds}`,
  );
}
const ironNodes = world.nodes.filter((n) => n.resource === ResourceType.Iron);
console.log(
  `\niron nodes: ${ironNodes.length} generated, ${ironNodes.filter((n) => n.isVisible).length} visible, ` +
    `${ironNodes.filter((n) => n.isClaimed).length} claimed, ${ironNodes.filter((n) => n.isConnected).length} connected, ` +
    `${ironNodes.filter((n) => n.workers.length > 0).length} worked`,
);
console.log(`places at/above the industry population floor (15): ${traders.filter((t) => t.population >= 15).length} of ${traders.length}`);
