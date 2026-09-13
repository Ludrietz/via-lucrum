import { parseMapPack, type MapPack, type Raw16Terrain } from './pack';
import { packWorldConfig } from './packSource';
import type { WorldConfig } from './world';

/**
 * Fetching a pack in the browser.
 *
 * Deliberately the only asynchronous thing in the whole map-pack path.
 * `parseMapPack` is pure, `PackNodes` is pure, and `World` stays synchronous
 * the way it has always been — because the moment world construction can
 * await something, every caller of it becomes async too, the playtest
 * harness included, and a simulation that cannot be stepped without an event
 * loop is a worse thing to own than one extra await at start-up.
 *
 * Packs are served as static files out of `public/maps`, so `test` resolves
 * to `/maps/test.json`. Nothing here goes to the network: an imported map is
 * data checked in beside the code, not something fetched at runtime from
 * somewhere that might be down or might have changed.
 */
export async function fetchMapPack(id: string): Promise<MapPack> {
  const base = `${import.meta.env.BASE_URL}maps/`;
  const url = `${base}${id}.json`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`map pack "${id}" not found at ${url} (${response.status})`);

  // A dev server answers a missing path with the app's own index.html and a
  // cheerful 200, so "not ok" is not the test that catches a typo in the
  // pack name — "this is not JSON" is. Say which, rather than letting a
  // parser error about "<" reach the player.
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`map pack "${id}" is not there — ${url} did not answer with JSON`);
  }

  // A surveyed pack keeps its readings in a sidecar file beside the JSON.
  // Fetched here rather than inside the parser so parsing stays pure and
  // environment-free — see `parseMapPack`.
  const terrain = (json as { terrain?: Raw16Terrain })?.terrain;
  let binary: Uint8Array | undefined;
  if (terrain?.encoding === 'raw16') {
    const dataUrl = `${base}${terrain.data}`;
    const dataResponse = await fetch(dataUrl);
    if (!dataResponse.ok) {
      throw new Error(`map pack "${id}" needs ${dataUrl}, which is not there (${dataResponse.status})`);
    }
    binary = new Uint8Array(await dataResponse.arrayBuffer());
  }

  return parseMapPack(json, binary);
}

/** `fetchMapPack`, then straight into something `World` can be built from. */
export async function fetchPackWorldConfig(id: string): Promise<WorldConfig> {
  return packWorldConfig(await fetchMapPack(id));
}
