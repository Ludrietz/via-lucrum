# Playtest harness

Runs the whole simulation with no Phaser and no window, driven by a stand-in
player, and prints what the civilisation actually did. A hundred and fifty
in-game days take under a minute, which is the point: balance questions that
would take an hour of watching can be asked in a batch across a dozen seeds.

```bash
node_modules/.bin/esbuild tools/main.ts --bundle --platform=node --format=esm \
  --outfile=tools/.build/playtest.mjs --log-level=warning

node tools/.build/playtest.mjs --seed 1234 --days 120 --policy measured --map
```

| flag | meaning |
| --- | --- |
| `--seed N` | world seed, same one `?seed=N` uses in the game |
| `--pack ID` | run an authored map from `public/maps/ID.json` instead of a generated world (same as `?pack=ID` in the game); a path ending in `.json` works too |
| `--days N` | in-game days to run |
| `--policy greedy\|measured` | how recklessly the stand-in player expands |
| `--reportEvery N` | days between timeline rows |
| `--verbose` | log every road as it is drawn |
| `--map` | write an SVG of the finished network (`--map-out path`) |

## The stand-in player

`surveyor.ts` is **not** an AI meant to beat the game. It exists so the
simulation gets exercised by a network shaped like one a person would draw,
because a starburst of straight lines from the village never tests
wear-based routing, junction-driven settlement emergence, or corridor
traffic — and those are most of what this game is.

Three things give it that shape:

- **Roads branch off whatever is already built.** A single multi-source A*
  expands outward from *every* point of the existing network at once, with
  road cells costing nothing to travel. So the cheapest way to a far-off
  deposit is "follow the trunk, then cut across", and trunks with spurs fall
  out of the cost model rather than being scripted.
- **Roads follow the cheap ground.** The search is priced on real terrain
  cost, and refuses cells near water so the game's own spline smoothing
  cannot bulge a road across a shoreline.
- **It spends Expansion Capacity like a player deciding where to grow.**
  Every frontier offer is valued by how badly the civilisation wants that
  resource right now, against what it costs; `measured` will hold capacity
  back for a substantially better offer rather than spend the instant it can
  afford something, `greedy` spends the moment it can.

`greedy` connects whatever is cheapest to reach and claims whatever is
affordable first. `measured` additionally weighs the *permanent* cost of a
connection — how far the goods will have to be carried, forever, to the
nearest place that can receive them — and stops adding sites once most of the
workforce is already out walking. Comparing the two is how over-expansion
gets tested.

### Scouting

The stand-in player also runs tracks out into country nobody has looked at,
toward whichever compass sector the realm currently knows least about. This
is not decoration. Without it every road in a playtest ran between two things
the realm already owned, which made the harness structurally blind to half of
what roads are for — both corridor survey (`survey.ts`) and territory-
dependent road abandonment measured as byte-identical no-ops across every
seed, not because they did nothing but because nothing here ever put a road
where they applied. Most scouting tracks correctly grow back over once
they have done their looking; on a 150-day run, 123 drawn and 49 still
standing is the expected shape, not a bug.

## Files

- `main.ts` — CLI entry.
- `playtest.ts` — runs the sim, collects snapshots, prints the report.
- `surveyor.ts` — the stand-in player: draws roads, scouts, and claims
  frontier sites.
- `batch.ts` — one line per seed across many seeds, so a change is judged
  against the distribution rather than against whichever seed happened to be
  open. Reports what the player can actually *see*: visible deposits, how many
  of eight compass sectors they fall in, how many frontier slots are filled,
  ghost towns, and deposits still hidden close to home. Run with
  `node tools/.build/batch.mjs --seeds 8 --days 75`.
- `probe.ts` — the same questions for a single seed, over time.
- `indprobe.ts` — every industry gate at every place, for when the processing
  economy is not running and it is not obvious which of the several gates is
  the one saying no.
- `perf.ts` — milliseconds per tick as the realm grows.
- `mapdump.ts` — renders a finished run as an SVG.
- `snaketest.ts` — a narrower, adversarial scenario: always claim whichever
  affordable frontier offer continues heading the way expansion was already
  going, and drag one road segment from the previous claim to the new one
  (no branching, no route optimisation). This is what a player chasing one
  promising line of deposits actually does, and it is the shape the
  Expansion Capacity cost model (`expansion.ts`) has to price sensibly:
  every hop should get dearer the further it sits from an actual settlement,
  or the game rewards a thousand-unit single-file "snake" exactly as well as
  compact growth around a town. Run with `node tools/.build/snaketest.mjs
  <seed> <days>` after building it the same way as `main.ts`. Reports the
  claim cadence, how far the farthest worked site actually is from the
  nearest place its workers call home (this is what should stay small — a
  worker at the tip of a long chain should have a nearby settlement to live
  in, not a commute back to the capital), and which settlements founded
  where.

## importmap.ts — turning a real place into a map pack

Fetches public elevation and OpenStreetMap data for a rectangle of the world
and writes a playable map pack into `public/maps`. Run it once, by hand, and
check the output in; the game itself never touches the network.

```bash
node_modules/.bin/esbuild tools/importmap.ts --bundle --platform=node --format=esm \
  --outfile=tools/.build/importmap.mjs --log-level=warning

node tools/.build/importmap.mjs --span 34 --out kuttenberg --name Kuttenberg \
  --village 49.948,15.268 --village-at 0.80,0.78 --max-nodes 160
```

| flag | meaning |
| --- | --- |
| `--centre lat,lon` | middle of the region to import |
| `--span KM` or `--span KMx,KMy` | how many kilometres across; one number is a square |
| `--out ID` | writes `public/maps/ID.json` and `ID.bin`; play with `?pack=ID` |
| `--name TEXT` | what the map is called in-game |
| `--village lat,lon` | where the first village stands; defaults to the most significant OSM settlement near the centre |
| `--village-at fx,fy` | place that village at a fraction of the map and derive the centre from it — `0.80,0.78` puts it in the bottom-right with the country opening away north and west |
| `--metres-per-unit M` | real metres per world unit (default 4) — see "scale" below |
| `--cell U` | world units per terrain cell (default 32) |
| `--relief M` | metres of local relief that fill the whole land elevation band (default 500) |
| `--max-nodes N` | cap on resource sites (default 80), shared out evenly between the four trades *and* across districts of the map |
| `--no-rivers` | skip `waterway=river`, for a region a river would otherwise cut in half |
| `--population N`, `--seed N` | passed into the pack |

### Sources

Elevation comes from the Terrarium tiles on AWS Open Data (SRTM/Copernicus
derivatives); land cover, water, mines, quarries and place names come from
OpenStreetMap via Overpass. Both are free, both cover the whole planet, and
both are queried the same way regardless of where you point the tool — an
Earth map is this command with different arguments, which is the reason the
importer is built around real data rather than around any one game's map.

Overpass is a shared free service with a per-IP quota. The importer backs off
and retries rather than failing the run, and caches each response under
`tools/.cache` keyed by the exact query — so iterating on how the data is
*translated* costs nothing. Delete that directory to re-fetch.

### The two judgement calls

**`--relief`** decides whether a region reads as rolling or as alpine. It has
to be a setting, because the game's elevation band is a gameplay scale, not an
altitude: "mountains" means ground a road hates, not ground above 2000m.
Stretching each region's own min-to-max across the band — the tempting
automatic answer — would make a flat region exactly as mountainous as the Alps
and would mean two neighbouring imports disagreed about what a hill is.

**Scale.** Every import prints a scale check, which is worth reading. At the
default 4 m/unit a hamlet's footprint covers 1.7 km and the opening resource
reach 3.4 km, both about right for medieval village lands — but the same
setting has a villager walking 0.32 km/h against a real 4 km/h. The spatial
relationships and the travel times cannot both be right until villager speed
is retuned; the map is not the thing that is wrong.

### What it will not do

It translates measurements into the three readings `classifyTerrain` takes,
and stops. It never writes a terrain type, never writes a road cost, and never
places a resource site that is not standing on something OSM actually records.
See the note at the top of `src/sim/pack.ts` for why that line is drawn there.

The practical consequence is that a region can import to something unplayable
— OSM maps every field around a town and hardly ever maps where the stone came
from, so a thin region can come out with no stone at all, which deadlocks node
upgrades. `packWorldConfig` refuses such a pack at load with a list of what is
missing. Widen `--span` before reaching for anything cleverer.

## importimage.ts — turning a drawn map into a map pack

The sibling of `importmap.ts`. That one reads measurements of a real place;
this one reads a *picture* of one. They meet at the pack format and nowhere
else.

```bash
node_modules/.bin/esbuild tools/importimage.ts --bundle --platform=node --format=esm \
  --outfile=tools/.build/importimage.mjs --log-level=warning

node tools/.build/importimage.mjs --image kuttenberg_region.png --span 12 \
  --out kcd-kuttenberg --name Kuttenberg --sites tools/source/kcd-minerals.json --check
```

| flag | meaning |
| --- | --- |
| `--image PATH` | the drawn map |
| `--span KM` | how many kilometres the image is across; height follows its aspect |
| `--out ID` | writes `public/maps/ID.json` and `ID.bin` |
| `--village fx,fy` | where the first village stands, as fractions of the image; defaults to the largest built-up area found |
| `--sites PATH` | extra hand-placed sites, in image fractions — see "minerals" below |
| `--metres-per-unit M` | real metres per world unit (default 4) — the one knob that sets how big the map is in world units; see scale below |
| `--hills F` | share of the map that should be hill country (default 0.18) |
| `--rivers water|fordable` | whether narrow watercourses are real water (default, bridgeable) or crossable wet ground |
| `--max-nodes N` | cap on resource sites (default 120) |
| `--check` | also write `tools/.build/ID-cover.png`, a picture of what the importer thinks it read |

**Use `--check`.** No amount of staring at percentages tells you whether the
forests landed in the right places; one look at the cover image against the
original answers it in a second. Every bug found while building this was found
that way.

### What a drawn map can and cannot give

This kind of art is flat-lit and colour-coded by land use rather than shaded
for realism, which makes it much closer to a thematic map than to a
photograph — the artist has already done the classification. Woodland, plough,
water, roads and roofs all separate cleanly once the page's sepia wash and
edge vignette are divided out (a seven-term illumination model per channel,
fitted by least squares; it can follow the lighting and cannot follow a
forest).

Two things colour cannot carry:

- **Elevation.** The hill shading in this art is stylistic; reading height out
  of it would mostly recover how dark the tree stipple is. Relief is instead
  *synthesised* from the map's own drainage and cover — ground rises away from
  watercourses and under woodland, because in this country the plough is on
  the valley floors and the trees are left on the higher, poorer ground. The
  result agrees with the picture instead of contradicting it. It is not a
  survey, and the pack's `source` line says so.
- **Minerals.** A quarry and a wheatfield are both just ground. For
  Kuttenberg this was solved by projecting the *real* workings around Kutná
  Hora — from the OSM data `importmap.ts` already had cached — onto the
  image using the town as the anchor. That is how Důl Osel ends up beside
  Kuttenberg, where it actually is. The run says plainly if a trade is
  missing entirely.

### Scale

A map is `span / (metres-per-unit × cell)` world units across, and the
simulation's own distances — a village footprint, the reach a new village has
for food and timber — are fixed in world units. So lowering
`--metres-per-unit` does not just enlarge the map, it shrinks the realm
relative to it. For this 12km image:

| `--metres-per-unit` | world units | nearest food / wood to Kuttenberg | start viable? |
| --- | --- | --- | --- |
| 4 | 3008 x 2368 | 381, 437 / 424, 430 | yes |
| 2 | 6016 x 4736 | 457, 539 / 397, 633 | yes |
| 1 | 12000 x 9504 | 571, 896 / 1066, 1332 | **no** |

A new village needs two food and one timber site within 850 units and
reachable on foot. At 1m per unit that is 850m of the drawn map, and a town
centre simply does not have a wood within 850m of it — which is true of real
town centres too. The pack is refused at load rather than opening into a
civilisation that starves on day twenty.

### Rivers

Watercourses are traced from the drawing and then **widened to at least two
cells**. A river one cell wide that runs diagonally is not a river: it is a
staircase of cells meeting at their corners, and since nothing in this game
moves diagonally, two cells joined at a corner are not touching — a road can
thread the gap and cross the river without ever meeting it. The picture says
there is a river and the simulation says there is not.

A 2x2 dilation fixes both the look and the behaviour, and is the smallest
thing that does: offsetting one cell right and down widens a line to exactly
two and leaves a broad river broad, where a symmetric 3x3 would turn every
stream into something three cells across. A second pass closes the handful of
corner-only joins the dilation leaves behind, preferring not to flood a
settlement.

Rivers are impassable water, and roads bridge them — see `MAX_BRIDGE_SPAN`
and `BRIDGE_COST` in `src/sim/terrain.ts`. Crossings wider than a bridge can
span genuinely wall the valley, which is the point; about a quarter of the
crossings on the Kuttenberg map are too wide, so the river shapes where roads
run rather than being scenery.

### The two lessons worth keeping

**Vote per cell, but not for everything.** A cell is twenty-odd pixels on a
side, so a plain majority is right for areas and badly wrong for lines: a
river drawn two pixels wide never wins a vote, and the first run produced a
map with no water on it at all — on a region whose every village sits on a
stream. Water claims a cell at five percent; towns, being areas, need a
quarter.

**Density, not topology, for sites.** Connected components are the obvious way
to find woodlots and they fail here, because two thirds of the map is one
connected forest. The question is not how many separate woods exist, it is
where a woodcutter could usefully stand — so candidates sit on a lattice and
are scored by how much of the class surrounds them.
