# Via Lucrum — Prototype 0.3

You build the roads. The economy builds the settlements.

You draw a network across a country; the landscape decides which parts of it
get used; and where enough goods move for long enough, towns appear on their
own and become centres in their own right.

```bash
npm install
npm run dev
```

The dev server binds to every interface, so it prints a Network URL alongside
the local one — open that on another machine on the same network and it plays
there with no further setup.

To put it in front of someone off the network, it is a static build with no
backend, so any static host works:

```bash
npm run build      # typechecks, then writes dist/
npm run preview    # serve dist/ locally to check it before publishing
```

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on every push
to `main`; set Pages to "GitHub Actions" once in the repository settings.
Asset paths are relative (`base: './'`), so the same build works at a domain
root, at a Pages project subpath, or opened straight off disk.

## The loop

Oakridge sits in the middle of a wilderness with eight resource sites scattered
around it. Only what falls inside the village's **influence** exists on the map
at all.

1. Drag from a site to draw a curved road. Roads are free, always — they
   connect places, and that is *all* they do. A road may start anywhere the
   network already reaches and end wherever you let go.
2. A villager walks out and becomes a lumberjack, miner, stonecutter or farmer.
   They stay there for good.
3. The site starts producing, and goods pile up on site.
4. Villagers who are *not* posted to a workplace automatically become
   transporters: they walk the network, load, come back, and deposit.
5. Food and timber together let the population grow — a place needs both, and
   whichever is scarcer is the one setting the ceiling. Stone and iron are
   what it builds and arms itself with.
6. A civilisation doing well earns **Expansion Capacity**. Beyond your border
   sit a few frontier sites, each with a price. Spend the capacity on one and
   the realm grows out to take it in — and a fresh set of opportunities
   appears past the new border.

Claiming a site gives you the ground, not the goods. It still needs a road,
and it still needs people who think working it is worth their time. You decide
where the civilisation invests its future; the simulation decides how that
turns out.

The one thing that never gets easier is labour. Every worker you post is a
villager who is no longer carrying anything, and the village refuses to staff a
site if it would leave too few hands for the roads.

| Level | Population | Influence | Workers per site |
| --- | --- | --- | --- |
| 1 | 5 | 330 | 1 |
| 2 | 8 | 470 | 1 |
| 3 | 13 | 630 | 2 |
| 4 | 20 | 820 | 2 |

## Settlements

Nothing is ever placed by hand. There is no build button. A settlement is what
happens when a stretch of road stays useful for long enough.

Every delivery leaves two marks on the ground it crossed: wear, and a record of
**what was carried**. A patch is then scored continuously on five things —
how much moves through it, how good the road is, whether routes meet there,
what it is near, and what it is standing on — with crowding from the village
and existing towns scaling the whole result down. That score is only a target:
potential eases towards it over about a minute and a half, so a place has to
stay worth something before anything appears, and slides back if the traffic
dries up.

```
site → roadside → hamlet → settlement
```

A well-served spoke settles around 0.50-0.55 potential, which comfortably makes
a **hamlet** but cannot make a **settlement** — the last step needs the junction
term, so a place becomes a settlement by becoming a *hub*. Draw another road
through your hamlet and watch it grow.

A settlement takes its trade from whatever dominates the traffic that made it:
Timberton on a wood route, Ironford on ore, Grainham on grain, Crossroads where
nothing dominates. The trade is re-read as traffic changes, so a timber town on
a route that shifts to mixed cargo becomes a market town. Only raw goods exist
today, but a trade is modelled as "a craft that grew out of a good" so milling,
smelting and the rest can slot in later without moving anything.

Once founded, a settlement is a **real node**: it splits the road it grew on,
routes run through it, you can draw new roads to and from it, and — from hamlet
upward — it opens up the country around it the way the first village does. That
is what makes the map expand. Oakridge can see 900 at its largest, which is
about a fifth of the world; everything past that is reached by growing a second
centre out towards it, then a third.

Sites are never built over: a forest stays a forest, and nothing may take hold
within 150 of a resource node.

**Reading it:** hover a road for its traffic, its goods mix, its settlement
potential and a WHY breakdown of which factors are carrying it — including when
crowding is holding it at zero. Hover a settlement for its trade, origin, age
and standing.

## Terrain

The map is procedurally generated, not hand-painted: elevation, moisture,
temperature and a short-wavelength detail layer are each an independently
seeded coherent noise field (`sim/noise.ts`), sampled directly in world
coordinates and combined into a terrain type plus a set of continuous
characteristics — fertility, forest density, rockiness, wetness — so a hill
can be forested and a forest can be fertile rather than one label excluding
every other property (`sim/terrain.ts`). Generation happens in 1024-unit
chunks, lazily and cached, entirely as a function of one world seed: the
same seed always produces the same ground, and there is no upfront pass
over a fixed-size map. `?seed=12345` in the URL reproduces an exact world;
the seed in use is always logged to the console and shown in the debug
panel.

Resource nodes are a second, independent layer on top of the terrain, not
the other way around — and they come in **deposits**, not one per cell. A
sparse, heavily jittered lattice decides where a deposit might be (most
cells hold nothing); the ones that do scatter two to five sites around a
wandering centre, weighted by the terrain's characteristics under each site
and by a broad "rich country / poor country" field, then filtered by a real
minimum-spacing rule (`sim/worldgen.ts`). The intended shape is a handful of
sites in reach at the start — food and wood — long genuinely empty
stretches, and stone and iron far enough out that hauling them home is
absurd and the answer is a settlement growing out there instead.

Generation is driven by the **influence border** and nothing else, never by
the camera: panning around is looking, not expanding. The world stays
generated a fixed margin ahead of everywhere the civilisation reaches
from — the village, every settlement, every connected node's own
influence — so ground is always decided well before an influence ring
arrives to reveal it. A freshly founded
village gets a small, believable stockpile of food (and a little wood) and
a strictly time-boxed grace period on its population target, so the first
couple of minutes of a game are never an unavoidable starvation countdown;
everywhere and everything else is left exactly as rich, sparse, or awkward
as the seed made it.

Terrain does not bend the roads you draw. It decides what they cost to cross:

| Ground | Cost |
| --- | --- |
| Plains | ×1.0 |
| Forest | ×1.4 |
| Hills | ×2.0 |
| Mountains | ×3.2 |
| Water | impassable |

That cost lands in two places, and they agree with each other:

- **Pace.** A villager's speed is `82 / cost` at the ground under their feet,
  sampled as they walk — 82px/s striding over plains, 59 through forest, 26 up a
  mountain road. You can see them labour and then pick up again.
- **Route choice.** Each road inherits the average cost of the ground it was
  drawn across, and routing through the network is weighted by
  `length × difficulty` instead of length. Because pace uses the same numbers,
  that weight *is* travel time: a route's `resistance / 82` predicts its walk to
  a tenth of a second. Villagers take the road they actually cover fastest,
  which is often the longer one on the map.

Against the massif between Oakridge and Ironhollow: straight over is 424px but
14.0s, the sweep through the forest is 588px and 11.7s, and they take the sweep.
A detour of up to about 1.75× the direct distance is worth it to stay off the
mountains; past that they take the mountain road after all.

Water is the one hard rule: roads cannot cross it, and the drag preview greys
out as soon as your line touches the river or the lake. There are no bridges yet.

Press **D** for the debug overlay: the terrain grid tinted and priced, each
road's difficulty, and the route villagers currently choose to every connected
site traced in red, with its one-way walking time. With the overlay open, the
number keys 1-6 switch what the grid shows — terrain/cost, elevation,
moisture, fertility, forest density, overall resource potential — for tuning
generation itself.

Sites are placed to match their ground, not the other way around: a mine
sits in real hill or mountain country, a farm out on the open plain, because
the terrain is generated first and resource placement reads it — see
"Terrain" above.

## Drawing roads

Start a drag on the village, on a site, or **on an existing road**, sweep the
cursor where you want the road to run, and release on another site or road. The
road goes exactly where you drew it: the path is smoothed with a Catmull-Rom
spline, welded to whatever it started and ended on, and split wherever it
crosses an existing road — the crossing becomes a real junction that
transporters route through. Releasing over empty
ground cancels; the graph is checked before it is touched, so a cancelled road
leaves nothing behind.

## Removing roads

**Right-drag to erase.** The stretch under the cursor is outlined as you hover,
and sweeping the right button across the network takes out every stretch you
touch.

A *stretch* is one run of road between two junctions or sites, and that is
deliberately the unit of removal. There are no choices inside a stretch — every
route that enters one traverses all of it — so erasing half of one and erasing
all of it have exactly the same effect on traffic; the partial version just
leaves a stump that does nothing and then rots. Finer control is available when
you want it, because branching splits a stretch at the junction: draw a trunk
with three spurs and each spur, and the trunk, can go independently.

The converse holds too. Erase a spur and the fork it left behind is no longer a
fork, so the two halves of the trunk are spliced back into one stretch — a
stretch always means a run of road with no decisions in it.

Cutting a site off is allowed. Its workers stay and keep producing, its stock
fills up with nobody to carry it, and the panel shows it as NOT CONNECTED until
you lay a road back. Because wear lives in the ground, rebuilding along the old
line picks up where you left off: the replacement road is a packed road from its
first day, not a fresh track.

## Wear

Roads are not levelled up as objects. Wear is recorded in the **ground**, on a
48px grid, and every completed delivery packs down each patch it passes through.
A road's width is then read back from the ground beneath it, sample by sample —
so one road is a highway where the traffic converges and a track at its far end.

Because wear belongs to the place rather than the road, roads that merely run
near each other share it. Seven separate spokes out of Oakridge have no edges in
common, yet after five minutes every one of them reads ~4.0 at the village end
and ~0.6 at the far end: the settlement's approaches pack into a broad highway
that frays into tracks as it reaches out. Branch a spur off a trunk and only the
ground past the fork stays quiet.

Wear also fades — about 2% a second, a 35 second half-life. A road that carries
traffic holds its width; one that stops earning its keep thins, and when its
weakest stretch drops below a threshold it is abandoned and fades off the map.
Two rules keep that safe: anything on a current route to a connected site is
spared, as is anything a villager is standing on, so pruning can only ever
remove network the player has stopped using. Draw a redundant loop and it will
be gone in about two minutes; draw the only road to a distant mine and it stays
however sparse its traffic.

Judging abandonment uses the *weakest* stretch rather than the average. Wherever
a road meets another it shares that patch of ground, so its ends stay worn no
matter how dead its middle is — a road is gone when any part of it has gone.

**On size:** this is one float per patch, and only patches somebody has walked
on are kept. A fully connected eight-site map after five minutes of traffic
holds wear in 84 patches out of a possible 2200 — a sparse list of a few dozen
index/value pairs, rather than a record per road segment. The cost is bounded by
the size of the map, not by how much road has been drawn.

## Architecture

```
simulation (src/sim)     pure TypeScript, no Phaser
    ↓
world state              village, villagers, resource nodes, road graph
    ↓
renderer (src/render)    Phaser layers that only read the world
    ↓
browser
```

| File | Role |
| --- | --- |
| `sim/world.ts` | Orchestrates time, discovery, production, growth, levelling |
| `sim/roadNetwork.ts` | The road graph: welding, splitting, junctions, Dijkstra routing |
| `sim/terrain.ts` | Chunked, lazily-generated terrain field; the cost table, water rules |
| `sim/noise.ts` | Seeded coherent (value) noise and fractal sums — no game knowledge |
| `sim/worldgen.ts` | Resource weighting, node placement and spacing, starting-area guarantees |
| `sim/traffic.ts` | The ground's memory: wear, goods carried, decay |
| `sim/settlement.ts` | Settlement entity, stages, trades and names |
| `sim/settlementSystem.ts` | Scoring, potential, emergence. All tuning in one block |
| `sim/geometry.ts` | Splines, intersections, polyline sampling |
| `sim/systems.ts` | `TransportSystem` and `WorkforceSystem` |
| `sim/village.ts` `villager.ts` `resourceNode.ts` | Entity state |
| `sim/map.ts` | The world config factory — seed in, starting village and bounds out |
| `input/RoadDrawing.ts` | Freehand path capture and validity |
| `render/*Layer.ts` | Terrain, influence, roads, sites, villagers, effects |
| `render/DebugLayer.ts` | The D overlay: grid, costs, chosen routes |
| `render/SettlementLayer.ts` | Huts, hamlets and halls, coloured by trade |
| `ui/Hud.ts` | DOM HUD and inspection panels |

`src/sim` imports nothing from Phaser. `World.update(delta)` advances the whole
simulation and queues one-shot `WorldEvent`s that the scene drains each frame to
play effects. Systems see the world only through the small `SimContext`
interface, so adding another one does not mean touching `World`.

In dev, `window.world` and `window.scene` are exposed:

```js
for (let i = 0; i < 1800; i++) world.update(1 / 30); // fast-forward 60 seconds
```

## Deliberately not in scope

Procedural generation, combat, quests, tech trees, trading, buildings, saves,
audio, multiplayer. 0.2 exists to answer five questions: does expanding
influence make progression interesting, is drawing a branching network
satisfying, does posting villagers make the world feel alive, is watching goods
move enjoyable, and does the village growing make you want to keep going.
