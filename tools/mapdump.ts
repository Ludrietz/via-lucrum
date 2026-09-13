/**
 * Draw a finished playtest as an SVG. The whole point of this project is that
 * the simulation is watched rather than read, and a table of counts cannot
 * tell you whether a road network looks like something a person would draw.
 */

import type { Vec2 } from '../src/sim/geometry';
import { TerrainType } from '../src/sim/terrain';
import { NodeState, ResourceType } from '../src/sim/types';
import { TIER_LABELS } from '../src/sim/tier';
import type { World } from '../src/sim/world';

const TERRAIN_FILL: Record<TerrainType, string> = {
  [TerrainType.Water]: '#2d4a63',
  [TerrainType.Plains]: '#8a9a5b',
  [TerrainType.Forest]: '#4a6741',
  [TerrainType.Hills]: '#8f8168',
  [TerrainType.Mountains]: '#6e6a63',
};

const RESOURCE_FILL: Record<string, string> = {
  [ResourceType.Wood]: '#3f7d20',
  [ResourceType.Food]: '#d8b23c',
  [ResourceType.Stone]: '#9aa0a6',
  [ResourceType.Iron]: '#b5651d',
};

/** Longest side of the rendered image, in pixels. Scale follows from it. */
const MAX_PIXELS = 1600;
/** World units per sampled terrain cell. Coarse: this is a map, not the game view. */
const TERRAIN_STEP = 96;
/** How far beyond everything the frame extends. */
const PAD = 300;

export function renderMap(world: World, title: string): string {
  const points: Vec2[] = [world.village.position];
  for (const node of world.nodes) if (node.state !== NodeState.Hidden) points.push(node.position);
  for (const s of world.settlements) points.push(s.position);
  for (const edge of world.network.edges) points.push(...edge.points);

  const minX = Math.min(...points.map((p) => p.x)) - PAD;
  const maxX = Math.max(...points.map((p) => p.x)) + PAD;
  const minY = Math.min(...points.map((p) => p.y)) - PAD;
  const maxY = Math.max(...points.map((p) => p.y)) + PAD;

  const SCALE = Math.max(maxX - minX, maxY - minY) / MAX_PIXELS;
  const w = Math.round((maxX - minX) / SCALE);
  const h = Math.round((maxY - minY) / SCALE);
  const px = (x: number) => ((x - minX) / SCALE).toFixed(1);
  const py = (y: number) => ((y - minY) / SCALE).toFixed(1);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui, sans-serif">`);
  out.push(`<rect width="${w}" height="${h}" fill="#1b1f22"/>`);

  // Terrain, sampled coarsely and run-length encoded along each row. Emitting
  // one rect per sample produced a thirty-megabyte file; terrain is coherent
  // by construction, so most rows are a handful of runs.
  out.push('<g shape-rendering="crispEdges">');
  for (let y = minY; y < maxY; y += TERRAIN_STEP) {
    let runStart = minX;
    let runType = world.terrain.typeAt({ x: minX + TERRAIN_STEP / 2, y: y + TERRAIN_STEP / 2 });

    const flush = (end: number) => {
      out.push(
        `<rect x="${px(runStart)}" y="${py(y)}" width="${((end - runStart) / SCALE).toFixed(1)}" height="${(
          TERRAIN_STEP / SCALE
        ).toFixed(1)}" fill="${TERRAIN_FILL[runType]}"/>`,
      );
    };

    for (let x = minX + TERRAIN_STEP; x < maxX; x += TERRAIN_STEP) {
      const type = world.terrain.typeAt({ x: x + TERRAIN_STEP / 2, y: y + TERRAIN_STEP / 2 });
      if (type === runType) continue;
      flush(x);
      runStart = x;
      runType = type;
    }
    flush(maxX);
  }
  out.push('</g>');

  // Roads, drawn at a width that follows how packed down they are — the same
  // reading the game itself uses, so a trunk is visibly a trunk.
  for (const edge of world.network.edges) {
    const wear = world.wearOf(edge);
    const width = (1 + Math.min(1, wear / 4.5) * 4.5).toFixed(1);
    const shade = Math.round(120 + Math.min(1, wear / 4.5) * 100);
    const d = edge.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x)},${py(p.y)}`).join(' ');
    out.push(`<path d="${d}" fill="none" stroke="rgb(${shade},${shade - 20},${shade - 60})" stroke-width="${width}" stroke-linecap="round"/>`);
  }

  // Junctions and open ends, so branching is visible as branching.
  for (const node of world.network.nodes) {
    if (!node.isJunction) continue;
    const open = node.edges.length === 1;
    out.push(
      `<circle cx="${px(node.position.x)}" cy="${py(node.position.y)}" r="${open ? 2 : 3}" fill="${
        open ? '#7a6a55' : '#e8dcc0'
      }"/>`,
    );
  }

  for (const node of world.nodes) {
    if (node.state === NodeState.Hidden) continue;
    const fill = RESOURCE_FILL[node.resource] ?? '#ccc';
    const worked = node.workers.length > 0;
    out.push(
      `<circle cx="${px(node.position.x)}" cy="${py(node.position.y)}" r="${worked ? 6 : 4}" fill="${fill}" stroke="${
        node.isConnected ? '#fff' : '#000'
      }" stroke-width="${worked ? 1.5 : 0.8}" opacity="${node.isConnected ? 1 : 0.55}"/>`,
    );
    if (node.level > 1) {
      out.push(
        `<text x="${px(node.position.x)}" y="${(Number(py(node.position.y)) - 8).toFixed(1)}" fill="#fff" font-size="8" text-anchor="middle">${node.level}</text>`,
      );
    }
  }

  for (const trader of world.traders) {
    const isVillage = trader === world.village;
    out.push(
      `<circle cx="${px(trader.position.x)}" cy="${py(trader.position.y)}" r="${isVillage ? 11 : 9}" fill="#c0392b" stroke="#fff" stroke-width="2"/>`,
    );
    out.push(
      `<text x="${px(trader.position.x)}" y="${(Number(py(trader.position.y)) + 22).toFixed(1)}" fill="#fff" font-size="11" text-anchor="middle">${
        trader.name
      } · ${TIER_LABELS[trader.tier]} · ${trader.population}</text>`,
    );
  }

  out.push(`<text x="12" y="22" fill="#fff" font-size="15">${title}</text>`);
  out.push(
    `<text x="12" y="40" fill="#cfc9bd" font-size="11">circles: resource sites (filled ring = worked, number = level) · road width = how packed down it is · pale dots = junctions</text>`,
  );
  out.push('</svg>');
  return out.join('\n');
}
