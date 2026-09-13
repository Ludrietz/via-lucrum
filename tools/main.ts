import { packWorldConfig } from '../src/sim/packSource';
import { readMapPack } from './packFile';
import type { WorldConfig } from '../src/sim/world';
import { printClaims, printNodes, printPlaces, printRoads, printTimeline, runPlaytest } from './playtest';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const seed = Number(arg('seed', '1234'));
const days = Number(arg('days', '150'));
const policy = arg('policy', 'greedy') as 'greedy' | 'measured';
const roadInterval = Number(arg('roadInterval', '25'));
const reportEvery = Number(arg('reportEvery', '10'));
const verbose = process.argv.includes('--verbose');

/**
 * `--pack test` runs the authored map in `public/maps/test.json` instead of a
 * generated world; `--pack some/path.json` runs one from anywhere. The rest
 * of the harness does not change at all, which is the point — an imported
 * map is reported in the same columns as a procedural one, by the same
 * stand-in player, so the two are directly comparable.
 */
const packArg = arg('pack', '');
let config: WorldConfig | undefined;
let label = `seed=${seed}`;
if (packArg) {
  const pack = readMapPack(packArg);
  config = packWorldConfig(pack);
  label = `pack=${pack.name} (${pack.cols}x${pack.rows} cells, ${pack.width}x${pack.height} units, ${pack.nodes.length} sites)`;
}

console.log(`=== Via Lucrum playtest  ${label} days=${days} policy=${policy} roadInterval=${roadInterval}s ===`);
const started = Date.now();
const { world, surveyor, timeline } = runPlaytest({ seed, days, policy, roadInterval, reportEvery, verbose, config });
printTimeline(timeline);
printPlaces(world);
printNodes(world);
printRoads(world, surveyor);
printClaims(surveyor);
console.log(`\n(ran in ${((Date.now() - started) / 1000).toFixed(1)}s wall clock)`);

// A picture of the finished network, for judging whether it looks like
// something a person would have drawn.
if (process.argv.includes('--map')) {
  const { renderMap } = await import('./mapdump');
  const { writeFileSync } = await import('node:fs');
  const path = arg('map-out', `tools/.build/map-${packArg || seed}-${policy}.svg`);
  writeFileSync(path, renderMap(world, `Via Lucrum — ${label}, ${policy}, day ${world.day}`));
  console.log(`map written to ${path}`);
}
