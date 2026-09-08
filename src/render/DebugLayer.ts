import Phaser from 'phaser';
import { TERRAIN_COSTS, TERRAIN_LABELS, TerrainType } from '../sim/terrain';
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

/**
 * Toggled with D. Shows the ground the villagers are actually pricing: the
 * terrain grid, what each road stretch costs to walk, and which way round the
 * network they currently choose. Hidden by default.
 */
export class DebugLayer {
  private readonly grid: Phaser.GameObjects.Graphics;
  private readonly routes: Phaser.GameObjects.Graphics;
  private readonly panel: HTMLElement;
  private readonly legend: HTMLElement;

  private readonly roadLabels: Phaser.GameObjects.Text[] = [];

  private enabled = false;
  private gridBuilt = false;
  private drawnVersion = -1;

  constructor(private readonly scene: Phaser.Scene, private readonly world: World) {
    this.grid = scene.add.graphics().setDepth(DEPTH.debugGrid).setVisible(false);
    this.routes = scene.add.graphics().setDepth(DEPTH.debugPath).setVisible(false);
    this.panel = document.getElementById('debug')!;
    this.legend = document.getElementById('debug-legend')!;

    this.renderLegend();
  }

  toggle(): void {
    this.enabled = !this.enabled;
    // The grid is tens of thousands of cells; build it the first time it is
    // actually wanted rather than at boot.
    if (this.enabled && !this.gridBuilt) {
      this.gridBuilt = true;
      this.drawGrid();
    }
    this.grid.setVisible(this.enabled);
    this.routes.setVisible(this.enabled);
    this.panel.classList.toggle('hidden', !this.enabled);
    for (const label of this.roadLabels) label.setVisible(this.enabled);

    if (this.enabled) {
      this.drawnVersion = -1;
      this.update();
    }
  }

  update(): void {
    if (!this.enabled) return;
    if (this.drawnVersion === this.world.network.version) return;
    this.drawnVersion = this.world.network.version;

    this.drawRoutes();
    this.updatePanel();
  }

  /** The terrain as the simulation stores it, tinted and priced. */
  /**
   * The grid the pathfinder sees, tinted by what it costs to cross. The
   * legend carries the numbers: a label per cell would be eighteen hundred
   * text objects on a map this size, which the renderer walks every frame.
   */
  private drawGrid(): void {
    const grid = this.world.terrain;
    const size = grid.cellSize;
    const g = this.grid;

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const tint = CELL_TINTS[grid.typeAtCell(col, row)];
        g.fillStyle(tint.color, tint.alpha);
        g.fillRect(col * size, row * size, size - 1, size - 1);
      }
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
    const grid = this.world.terrain;
    const rows = [
      `<div class="row"><span class="label">GRID</span><span class="value">${grid.cols} × ${grid.rows} @ ${grid.cellSize}px</span></div>`,
    ];

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
            ` = ${(route.resistance / WALK_SPEED).toFixed(1)}s</span></div>`,
        );
      }
    }

    this.panel.innerHTML = `<div class="name">TERRAIN DEBUG</div>${rows.join('')}`;
    this.panel.appendChild(this.legend);
  }

  private renderLegend(): void {
    this.legend.innerHTML = Object.values(TerrainType)
      .map((type) => {
        const tint = CELL_TINTS[type];
        const cost = TERRAIN_COSTS[type];
        const swatch = `#${tint.color.toString(16).padStart(6, '0')}`;
        return `<div class="swatch"><i style="background:${swatch}"></i>${TERRAIN_LABELS[type]} ${
          Number.isFinite(cost) ? `×${cost.toFixed(1)}` : '∞'
        }</div>`;
      })
      .join('');
    this.updatePanel();
  }
}
