import Phaser from 'phaser';
import { totalResourceWeight } from '../sim/worldgen';
import { TERRAIN_COSTS, TERRAIN_LABELS, TerrainType, type TerrainSample } from '../sim/terrain';
import { WALK_SPEED } from '../sim/villager';
import type { World } from '../sim/world';
import { DEPTH, FONT_FAMILY } from './theme';

const CELL_TINTS: Record<TerrainType, { color: number; alpha: number }> = {
  [TerrainType.Plains]: { color: 0x7ea86a, alpha: 0.18 },
  [TerrainType.Forest]: { color: 0x2f6b3a, alpha: 0.3 },
  [TerrainType.Hills]: { color: 0xc08a3e, alpha: 0.34 },
  [TerrainType.Mountains]: { color: 0x8c3b2f, alpha: 0.46 },
  [TerrainType.Water]: { color: 0x2b6ea8, alpha: 0.5 },
};

const ROUTE_COLOR = 0x8c2f2f;
/** Above this many visible cells, the per-cell grid stops trying to redraw — see `updateGrid`. */
const MAX_GRID_CELLS = 20_000;

/** Every overlay the debug view can show. Cycle with the number keys. */
type DebugMode = 'cost' | 'elevation' | 'moisture' | 'fertility' | 'forest' | 'resources';

const MODES: readonly { mode: DebugMode; label: string }[] = [
  { mode: 'cost', label: 'TERRAIN / COST' },
  { mode: 'elevation', label: 'ELEVATION' },
  { mode: 'moisture', label: 'MOISTURE' },
  { mode: 'fertility', label: 'FERTILITY' },
  { mode: 'forest', label: 'FOREST DENSITY' },
  { mode: 'resources', label: 'RESOURCE POTENTIAL' },
];

/** Low (blue) to high (red), for every continuous field below. */
const RAMP = [0x2b52a8, 0x2b9ea8, 0x3fae4c, 0xd9c23e, 0xb8452f];

function rampColor(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  const r = Math.round(((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * f));
  const g = Math.round(((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * f));
  const bl = Math.round((a & 255) + (((b & 255) - (a & 255)) * f));
  return (r << 16) | (g << 8) | bl;
}

/**
 * Toggled with D. Shows the ground the villagers are actually pricing: the
 * terrain grid, what each road stretch costs to walk, and which way round the
 * network they currently choose — plus, with the number keys, the raw
 * procedural layers underneath (elevation, moisture, fertility, forest
 * density, overall resource potential), for tuning generation itself.
 * Hidden by default. Drawn against the camera's current view rather than the
 * whole world, since there is no longer a fixed-size grid to draw once —
 * ground keeps being generated as the civilisation's reach grows.
 */
export class DebugLayer {
  private readonly grid: Phaser.GameObjects.Graphics;
  private readonly routes: Phaser.GameObjects.Graphics;
  private readonly panel: HTMLElement;
  private readonly legend: HTMLElement;

  private readonly roadLabels: Phaser.GameObjects.Text[] = [];

  private enabled = false;
  private mode: DebugMode = 'cost';
  private drawnVersion = -1;
  private lastGridKey = '';
  private gridTooCoarse = false;

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {
    this.grid = scene.add.graphics().setDepth(DEPTH.debugGrid).setVisible(false);
    this.routes = scene.add.graphics().setDepth(DEPTH.debugPath).setVisible(false);
    this.panel = document.getElementById('debug')!;
    this.legend = document.getElementById('debug-legend')!;

    this.renderLegend();
  }

  toggle(): void {
    this.enabled = !this.enabled;
    this.grid.setVisible(this.enabled);
    this.routes.setVisible(this.enabled);
    this.panel.classList.toggle('hidden', !this.enabled);
    for (const label of this.roadLabels) label.setVisible(this.enabled);

    if (this.enabled) {
      this.drawnVersion = -1;
      this.lastGridKey = '';
      this.update();
    }
  }

  /** Switch which layer the grid shows, 1-indexed to match the number keys. */
  setMode(index: number): void {
    const entry = MODES[index - 1];
    if (!entry || entry.mode === this.mode) return;
    this.mode = entry.mode;
    this.lastGridKey = '';
    this.renderLegend();
    this.update();
  }

  update(): void {
    if (!this.enabled) return;

    this.updateGrid();

    if (this.drawnVersion === this.world.network.version) return;
    this.drawnVersion = this.world.network.version;
    this.drawRoutes();
    this.updatePanel();
  }

  /**
   * Tint whatever the camera can currently see. Cheap enough to redo on
   * every camera move — a screen's worth of 32px cells is a few hundred
   * rects — so this just tracks the last view it drew and skips repeats.
   */
  private updateGrid(): void {
    const grid = this.world.terrain;
    const view = this.scene.cameras.main.worldView;
    const margin = grid.cellSize * 4;
    const col0 = grid.colAt(view.x - margin);
    const col1 = grid.colAt(view.x + view.width + margin);
    const row0 = grid.rowAt(view.y - margin);
    const row1 = grid.rowAt(view.y + view.height + margin);

    const key = `${col0}:${row0}:${col1}:${row1}:${this.mode}`;
    if (key === this.lastGridKey) return;
    this.lastGridKey = key;

    const g = this.grid;
    g.clear();

    // This used to iterate the whole (fixed-size) map once at boot, which
    // bounded it automatically. Now it redraws whatever the camera can see,
    // every time the view changes — safe at any working zoom, but a world
    // this size can be zoomed out far enough to ask for the better part of a
    // million cells in one call, which stalls the frame it lands on. Bail
    // out rather than ever trying.
    this.gridTooCoarse = (col1 - col0 + 1) * (row1 - row0 + 1) > MAX_GRID_CELLS;
    if (this.gridTooCoarse) {
      this.updatePanel();
      return;
    }

    const size = grid.cellSize;
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const sample = grid.sampleAtCell(col, row);
        const tint = this.tintFor(sample);
        g.fillStyle(tint.color, tint.alpha);
        g.fillRect(col * size, row * size, size - 1, size - 1);
      }
    }
  }

  private tintFor(sample: TerrainSample): { color: number; alpha: number } {
    switch (this.mode) {
      case 'cost':
        return CELL_TINTS[sample.type];
      case 'elevation':
        return { color: rampColor((sample.elevation + 1) / 2), alpha: 0.55 };
      case 'moisture':
        return { color: rampColor(sample.moisture), alpha: 0.55 };
      case 'fertility':
        return { color: rampColor(sample.fertility), alpha: 0.55 };
      case 'forest':
        return { color: rampColor(sample.forestDensity), alpha: 0.55 };
      case 'resources':
        return { color: rampColor(Math.min(1, totalResourceWeight(sample))), alpha: 0.55 };
    }
  }

  /**
   * Every road gets its walking cost, and the route villagers currently pick
   * to each connected site is traced on top of the network.
   */
  private drawRoutes(): void {
    const g = this.routes;
    g.clear();

    for (const label of this.roadLabels) label.destroy();
    this.roadLabels.length = 0;

    for (const edge of this.world.network.edges) {
      const mid = edge.points[Math.floor(edge.points.length / 2)];
      const label = this.scene.add.text(mid.x, mid.y - 16, `×${edge.difficulty.toFixed(2)}`, {
        fontFamily: FONT_FAMILY,
        fontSize: '13px',
        color: '#2b2419',
        backgroundColor: 'rgba(243,234,213,0.8)',
        padding: { x: 3, y: 1 },
      });
      label.setOrigin(0.5).setDepth(DEPTH.debugPath).setVisible(this.enabled);
      this.roadLabels.push(label);
    }

    for (const node of this.world.nodes) {
      const route = this.world.routeTo(node);
      if (!route) continue;

      g.lineStyle(2.5, ROUTE_COLOR, 0.7);
      g.beginPath();
      g.moveTo(route.points[0].x, route.points[0].y);
      for (const p of route.points.slice(1)) g.lineTo(p.x, p.y);
      g.strokePath();
    }
  }

  private updatePanel(): void {
    const rows = [
      `<div class="row"><span class="label">SEED</span><span class="value">${this.world.seed}</span></div>`,
      `<div class="row"><span class="label">CELL</span><span class="value">${this.world.terrain.cellSize}px</span></div>`,
    ];

    if (this.gridTooCoarse) rows.push('<div class="note">Zoomed out too far to show the grid — zoom in.</div>');

    const connected = this.world.nodes.filter((n) => n.isConnected);
    if (connected.length === 0) {
      rows.push('<div class="note">Draw a road to compare routes.</div>');
    } else {
      rows.push('<div class="note">CHOSEN ROUTES &middot; ONE WAY</div>');
      for (const node of connected) {
        const route = this.world.routeTo(node);
        if (!route) continue;
        rows.push(
          `<div class="row"><span class="label">${node.name}</span>` +
            `<span class="value">${Math.round(route.length)}px ×${route.difficulty.toFixed(2)}` +
            ` = ${(route.resistance / WALK_SPEED).toFixed(1)}h</span></div>`,
        );
      }
    }

    this.panel.innerHTML = `<div class="name">TERRAIN DEBUG</div>${rows.join('')}`;
    this.panel.appendChild(this.legend);
  }

  private renderLegend(): void {
    const header = `<div class="note">${MODES.map((m, i) => (m.mode === this.mode ? `[${i + 1}] ${m.label}` : `${i + 1}`)).join(' &middot; ')}</div>`;

    if (this.mode === 'cost') {
      this.legend.innerHTML =
        header +
        Object.values(TerrainType)
          .map((type) => {
            const tint = CELL_TINTS[type];
            const cost = TERRAIN_COSTS[type];
            const swatch = `#${tint.color.toString(16).padStart(6, '0')}`;
            return `<div class="swatch"><i style="background:${swatch}"></i>${TERRAIN_LABELS[type]} ${
              Number.isFinite(cost) ? `×${cost.toFixed(1)}` : '∞'
            }</div>`;
          })
          .join('');
    } else {
      const stops = RAMP.map((c) => `#${c.toString(16).padStart(6, '0')}`).join(', ');
      this.legend.innerHTML =
        header +
        `<div class="swatch"><i style="background:linear-gradient(90deg, ${stops}); width:64px;"></i>low &rarr; high</div>`;
    }

    this.updatePanel();
  }
}
