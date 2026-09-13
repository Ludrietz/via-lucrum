import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseMapPack, type MapPack, type Raw16Terrain } from '../src/sim/pack';

/**
 * Reading a pack off disk, for the tools.
 *
 * The node-side twin of `packLoader.ts`: same two files, same parser, a
 * different way of getting the bytes. Both exist so `parseMapPack` never has
 * to know whether it is in a browser.
 */
export function readMapPack(path: string): MapPack {
  const full = path.endsWith('.json') ? path : `public/maps/${path}.json`;
  const json: unknown = JSON.parse(readFileSync(full, 'utf8'));

  const terrain = (json as { terrain?: Raw16Terrain })?.terrain;
  const binary =
    terrain?.encoding === 'raw16'
      ? new Uint8Array(readFileSync(resolve(dirname(full), terrain.data)))
      : undefined;

  return parseMapPack(json, binary);
}
