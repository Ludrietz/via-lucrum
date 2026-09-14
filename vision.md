# Via Lucrum — Vision

This is the north star for the simulation. Code changes, tuning passes, and
new systems should be judged against this document, not against whatever the
most recent bug report happened to say. It is a living document — amend it
deliberately when the vision itself changes, not silently as a side effect of
a bug fix.

## Core premise

The player draws roads, and chooses where the realm grows. Nothing else is
placed by hand — no build menu, no unit orders, no direct control over any
villager. Everything else — where people live, what they produce, what they
carry, whether a hut by the road becomes a market town — is the *consequence*
of the road network the player drew, the ground it was drawn across, and the
economy that grows on top of it.

The player's entire vocabulary is two verbs:

- **Draw a road** (and erase one). Free, unrestricted infrastructure. Roads
  answer "can we connect these places?" and nothing else — they grant no
  ground and reveal no country.
- **Claim a frontier site.** Paid for out of Expansion Capacity the
  civilisation has earned. This answers "are we willing to take this place
  in?" — and only that. What comes of it is the simulation's business.

This used to be one verb. The second was added deliberately, and only because
the alternative was worse: with roads alone, the only thing that could decide
where a civilisation grew was a formula, and any formula good enough to grow
the realm sensibly also grew it *without being asked*. Expansion was
automatic and the player was a spectator to their own strategy. See
"Expansion: how the realm grows" below.

The bar for a third verb is exactly as high as the bar for the second was.
Every other feature has to sit upstream of these two (something that changes
what a road is worth drawing, or what a place is worth taking) or downstream
of them (something that makes the consequences legible and interesting to
watch).

## What "done" looks like

A believable medieval economy, watched rather than managed:

- **Labor** moves to where it's needed, resists more supervision than "post
  a worker at a site", and behaves like people — going hungry pulls them
  toward the granary, comfort lets them build something for the future.
- **Processing industries** turn raw goods into more valuable ones (wood →
  planks, stone → blocks, iron → tools), and exist because there's demand for
  the refined good, not because the player unlocked a tech.
- **Demand** is real: population eats, builds, wants tools and blocks, and a
  place's economy is legible as a balance of what it makes against what it
  needs.
- **Development** — a place's tier, its skyline, its name changing from
  hamlet to town — is a *readout* of how well an economy is actually doing
  (population fed, wealth flowing), never a number a place can coast on
  independent of its residents.
- **Wealth** is earned, not spawned: selling a genuine surplus, or running an
  industry that turns cheap goods into dear ones.
- **Trade** — the single best shipment for a villager to make right now — is
  one continuously-weighed decision across every source and every need in
  the civilization, not a set of hardcoded pipelines per resource.
- **Procedural geography**: terrain shapes what roads cost, what they're
  worth building, and — eventually — where the map itself comes from. The
  hand-placed map is a proof of concept, not the ceiling.
- **Built in stages**: every one of the above should work believably on its
  own before the next is layered on. A stage that only works because the next
  stage hasn't stressed it yet isn't actually done.

A civilization that looks alive when left running for an hour, not just for
the first five minutes: population that grows because it's fed and housed,
places that specialize because of what's actually near them, industries that
switch on and off with real demand, and a map that keeps opening up as the
player's roads and the world's own towns reach further out.

## Design pillars

1. **Two verbs, and no more.** Draw a road; claim a frontier site. If a
   feature seems to need a third, look much harder for a way to make it an
   emergent consequence of those two first — that search is what produced
   every system in this game worth keeping.
2. **Nothing is placed by hand.** Settlements, industries, trade
   specializations — all of it grows out of usage, or it isn't in the spirit
   of this game.
3. **Every number is a readout, not a lever the player pulls directly.**
   Population, tier, wealth, a node's level — all consequences, never
   settings.
4. **Believability over completeness.** A smaller set of systems that
   produce behavior a player would believe of a real medieval economy beats
   a larger set that technically "work" but produce nonsense (0-population
   Major Cities, a village hoarding stone while starving, a settlement that
   spawns and stays a ghost town forever).
5. **Watchable, not just correct.** The simulation exists to be watched. A
   correct-on-paper system that produces a screen full of numbers nobody can
   read from the state of the world is a failure of this game specifically,
   even if the math is right.

## Expansion: how the realm grows

The player's second decision, alongside drawing roads — and the one that
decides *where* the civilisation invests its future.

**Expansion Capacity** is earned continuously by the civilisation doing well
(population, wealth income, and how well-supplied its places actually are —
see `expansion.ts`). It is deliberately not money: wealth already measures
trade going well, and if expansion cost coin then the best economic play and
the best territorial play would be the same play, which is no choice at all.

The **frontier** offers a handful of sites just beyond the border, priced.
Nothing else out there is visible. Offers are chosen for variety, not
proximity — at most one per resource, spread apart — so each slot is a
different kind of decision ("timber now, or hold out for the iron") rather
than four versions of the same one.

**Claiming** spends the capacity and takes the site, *and the ground between
it and the realm*, into the territory. It does not connect it, staff it,
settle it, or deliver anything from it: a claimed deposit with no road to it
produces exactly nothing. The player buys the right to develop somewhere; the
simulation decides what comes of it.

**Territory** (`territory.ts`) is the set of those deliberate acts — the
founding seat, every claim, every settlement that has grown inside the border
— rendered as one merged scalar field traced with marching squares. It moves
only when something is incorporated.

The loop:

```
civilisation prospers → capacity accrues → frontier offers appear
→ player chooses → capacity spent → border grows to meet the site
→ roads, workers, trade, maybe a settlement → civilisation prospers
```

Three rules hold this together and should not be quietly relaxed:

1. **Roads are free and grant nothing.** They connect, and they *look* —
   the corridor a road runs through is surveyed, so a track drawn toward
   nothing in particular still finds what it passes. What they never do is
   create territory or confer any right: a road may not anchor on an
   unclaimed site, and nothing it finds may be worked until it has been paid
   for. This is what the old system got wrong twice over.

   **Water is the one thing they cannot simply ignore.** A road may *bridge*
   a river — any crossing a bridge could really make (`MAX_BRIDGE_SPAN`) — and
   may not run along water for longer than that. Crossing is dear
   (`BRIDGE_COST`, steeper than mountains), so a network prefers to go round
   and crosses where it must, which is exactly why real towns grew at the
   fords. This is still "free and unrestricted": nothing is spent and nothing
   is unlocked. It is the ground arguing, not the rules.

   Water used to be flatly impassable, and the rule was fine for as long as
   water meant a procedural lake — something large, round, and obviously to
   be walked around. It broke the moment a map of a real river valley turned
   up, where "no bridges" means a creek a person could wade cuts a town off
   from its own fields. A river should be an argument about where a road
   goes, and it could only ever be a wall.

   This rule used to read "they do not reveal", which sat in flat
   contradiction with the failure-mode entry below celebrating the fix that
   made roads reveal their corridor — the territory redesign added the
   sentence at the top and left the entry underneath, and the code then
   quietly followed the stricter reading and dropped corridor reveal
   altogether. Resolved deliberately in favour of revealing, because the two
   halves are not the same grant: knowing where the iron is buys nothing, and
   a game in which the player cannot look before committing has no decision
   in it. See "Knowledge is not ownership" below.
2. **Claiming is not exploiting.** Incorporation is permission, not
   production.
3. **The world exists first.** The frontier *selects* from what generation
   already placed; nothing is ever spawned because the player needs it.

### Knowledge is not ownership

Four different questions were once answered by one radius, and the territory
redesign correctly separated three of them — roads for connectivity, capacity
for commitment, territory for ownership. It missed the fourth. "What do we
know is out there?" was left to the frontier offer list, which meant the
player could see exactly the two-to-four sites currently priced and nothing
else, and a site that stopped being offered went dark again.

That is not a smaller version of the right thing; it is a different thing.
An offer list is the realm's current *attention*, and attention is properly
narrow and properly fickle. Knowledge has to be broad and monotone, because
its entire job is to let the player hold an opinion about where to grow — and
"which way should the realm reach?" is the one decision this whole design
exists to pose. Asked with three of eight compass directions dark, it is not
a decision, it is a coin flip.

So there is now a fourth thing (`survey.ts`), and it obeys its own rules:

- **It is monotone.** Somewhere surveyed stays surveyed. A scouting track
  that later grows over leaves its discoveries behind, which is precisely why
  such a track is worth drawing.
- **It grants nothing**, which is what makes it safe to be generous with, and
  is the exact distinction the old influence system failed to draw. A
  surveyed site cannot be worked, routed to, or built on, and still costs
  full price.
- **It comes from presence.** Seats survey the country around them (further
  as they grow), claims survey their own valley, roads survey their corridor.

Seeing further as you prosper is the very feedback loop influence was killed
for, and it is harmless here for one reason only: seeing further no longer
*does* anything by itself. It widens the menu, not the realm.

The frontier then offers from surveyed country and nowhere else, which is
what makes scouting strategically real — run a road out and the frontier has
something new to say, in that direction.

### What the border is for

A border that only prices claims and bounds chunk generation is a decoration:
before this, nothing the player could see or feel ever consulted it. It now
has two jobs, both chosen because they sit on things the player already
watches rather than adding a system.

- **People settle on the realm's own ground, and nowhere else.** This is what
  makes a claim mean "we have opened a province the realm can grow into", and
  it closes the loop the two verbs are meant to form: prosper, earn capacity,
  take in country, *have somewhere for a town to appear*, prosper. Before, the
  middle link was missing entirely — towns appeared wherever traffic was busy,
  whether or not the player had expanded at all.
- **The realm keeps up its roads; the wilderness takes them back.** A stretch
  outside the border has to be several times busier to avoid growing over.
  This is the second half of the scouting loop: a track into unclaimed country
  is worth drawing and does its job, but keeping it means either giving it
  real traffic or claiming the ground it crosses. It also makes the border
  legible in the one thing the player actually draws.

### What this replaced, and why

The old model was *influence*: every place projected a radius read off its
tier, and any resource site falling inside it became the civilisation's to
use, free, forever. That made expansion automatic — a village that prospered
reached further, which took in a deposit, which made it prosper further — and
the player was never asked anything. Worse, it had been extended so that
roads projected influence too, which turned the one free verb in the game
into a scouting exploit: draw a cheap road at nothing in particular, collect
territory.

The lesson worth keeping: when a system is being gamed, look at whether two
different ideas have been collapsed into one number. "How far can we see",
"what do we own", "what can we reach" and "where is worth going" were all
being answered by a single radius. Separating them — roads for connectivity,
capacity for commitment, territory for ownership, frontier for attention —
removed the exploit without any of the anti-exploit special cases that were
starting to accumulate.


## What has actually shipped (as of this writing)

This section is a snapshot, not a spec — read the code and `README.md` for
ground truth on any given day, and update this list when it drifts too far.

- **Road network**: freehand drawing, splines, junctions, wear-based road
  quality that lives in the *ground* rather than on the road object,
  terrain-priced routing, abandonment of unused stretches.
- **Population**: one shared, mobile pool of villagers (not owned per-place);
  home is wherever someone actually settled, decided by where they work, not
  where they were born; everyone is available to work as soon as they're
  born.
- **Labor market**: one unified priority-based dispatcher for every resource
  node and every industry, weighing worst civilization-wide shortage,
  scaled hard toward food during a genuine famine, with a scaled-back
  logistics reserve so transport doesn't collapse under a hiring burst.
- **Trade/transport**: one continuously-weighed "what's the single best
  shipment right now" decision across node production, trader surplus, and
  node investment, discounted (not hard-gated) by whether something's
  actually needed.
- **Convoys — porter, carter, caravan** (`villager.ts`): how much one person
  moves in one trip is decided by the road, not by the person. The *weakest*
  stretch of the delivery route, plus a minimum haul distance, picks the
  class: a track carries a man with a sack (3), a packed road a cart (9), a
  made trunk road a train of them (24), at a modest cost in pace. This is
  deliberately not a job — nobody is hired as a caravaneer and the labour
  market is never told, because every stall this simulation has produced came
  from adding another claimant to the same small pool of people. It is the
  loop the road system now turns on: use packs the ground, packed ground
  carries heavier loads, heavier loads pack it harder still. Bounded because
  wear per *unit of goods moved* rises monotonically with class (2.80 → 3.30
  → 3.82), so upgrading a route can never make it decay — which would have
  been an oscillation — and because there is only ever as much to carry as
  the country grows. Weakest-link rather than average is what makes a
  half-finished trunk road behave properly: it does nothing until the last
  gap is closed, then everything at once.
- **Resource nodes**: level up two independent ways — worked enough
  (lifetime collected) and invested-in enough (a shipped-in resource) —
  taking the lower of the two, so a node can stall on logistics even while
  it's being worked hard.
- **Industries** (Sawmill, Masonry, Smithy, Joinery, Bakery): convert raw goods to
  processed ones, and processed ones into finished ones. A workshop has to be
  *built*, out of material carried in, and only gets built where the realm is
  short of the worked good and this place has the inputs going spare — so both
  whether a sawmill exists and how many hands it holds are consequences of
  supply and demand rather than of a table. Two of the four want more than one
  thing: a smithy needs ore *and* fuel, a joinery sawn plank *and* finished
  tools, so neither can stand anywhere both chains do not reach. That is what
  makes a place specialise instead of quietly becoming a copy of every other
  place. See "Building" below.
- **Crafts**: a villager follows a trade, gets better at it with the years,
  and loses most of that on taking up another — so the labour market pays a
  price for churn and a realm settles into specialists on its own
  (`craft.ts`).
- **Wealth & development**: wealth earned from the *margin* an industry adds
  (output value less the input it consumed) and from genuine exports, never
  from raw production landing at a trader; a place's development is the
  standing fabric it has built and keeps in repair, and its tier the lower of
  what that fabric and its own headcount support — so a wealthy ghost town
  and a crowded but unbuilt place both fail to develop.
- **Housing & building**: what a place can house is read off dwellings it
  actually built, out of wood, stone, planks or blocks drawn from genuine
  surplus; worked material goes further and lasts longer; upkeep is a
  standing charge that keeps a big place a permanent market for the
  processing economy (`construction.ts`).
- **Settlements**: emerge from sustained, meaningful road traffic near real
  resource work (never from pure traffic with no occupation nearby), inherit
  their first residents from whoever's already working nearby when they
  found, and take their trade identity from whatever good actually moves
  through them.
- **Procedural world generation**: terrain is coherent noise (elevation,
  moisture, temperature, and a short-wavelength detail layer, all
  independently seeded fBm — see `noise.ts`/`terrain.ts`), not hand-placed
  brushes — large, irregular-edged forests, hill country and mountain ranges
  emerge from the fields rather than being drawn, and every point carries
  continuous characteristics (fertility, forest density, rockiness, wetness)
  alongside its terrain type, so a hill can be forested and a forest can be
  fertile. Generated in 1024-unit chunks, lazily and cached, entirely as a
  pure function of one world seed plus coordinates — the same seed always
  produces the same world, down to the cell, and there's no upfront pass
  over a fixed-size map. Resource nodes are a second, independent layer on
  top, and they come in *deposits*, not one per cell: a sparse lattice of
  candidate deposit centres (1300 units apart, heavily jittered, most cells
  empty) each scattering two to five sites around itself, weighted by the
  terrain's own characteristics and by a broad "rich country / poor
  country" field well above the scale of any one deposit. An earlier
  version placed at most one node per 260-unit cell at up to 60% occupancy
  and the lattice was legible straight off the map — dozens of sites within
  the opening influence ring, evenly spaced in every direction, and no
  reason to ever go anywhere. The shape to aim for is Manor Lords: a
  handful of sites in reach at the start (typically three to five, food and
  wood), long genuinely empty stretches, and stone and iron far enough out
  (commonly 1500-3000) that hauling them home is absurd and the answer is a
  settlement that grows out there instead. Spacing is enforced by a rule
  that peeks at neighbouring candidates without needing their chunks
  generated, so results are identical regardless of generation order.
  Generation is driven by the **influence border** and nothing else — never
  the camera, since panning is looking, not expanding — staying a fixed
  margin ahead of every place the civilisation reaches from, so ground is
  always decided well before an influence ring arrives to reveal it. The one sanctioned
  exception to "the world is what it is": a freshly founded village gets a
  small, real food (and smaller wood) stockpile sized off the game's own
  demand rate, plus a strictly time-boxed (not stock-based) grace period on
  the population target itself, so the first couple of minutes aren't a
  starvation countdown that starts before a road could possibly exist —
  everywhere else, and every other seed's quirks, are left exactly as rich,
  poor, or awkward as the noise made them.

## Land: places occupy ground, and ground runs out

Until this shipped, nothing on this map took up any room. A place was a point
with a radius attached, and every radius in the game was a *distance test* —
how far to draw the glyph, how far to hit-test a click, how far the realm's
border bulged. A village of sixty and a hamlet of three occupied exactly the
same amount of the world: none. A forest was a pin, not a wood.

That missing constraint was quietly behind a whole class of behaviour the
design asks for and could not produce. If growth costs no ground, then nothing
about *where* a place is can shape *what* it becomes — every village is the
same village with a different number on it, and the map is scenery. And with
no area to a deposit, "the town expanded into the forest" is not an event that
can happen, let alone one with a consequence.

So ground is now held, cell by cell, and by exactly one claimant at a time
(`landUse.ts`):

- **Settled ground** is what a place is built over and farms from — tofts,
  closes, in-fields. It grows with population, sub-linearly, which is the
  whole of what "urbanising" physically means here: the extra people go in
  denser and buy more of their food than they grow.
- **Worked ground** is a resource site's area of operation — the stretch of
  wood actually being felled and replanted, the fields actually ploughed. It
  grows with the node's level. The node itself stays one point, exactly as
  before: still where workers muster, still where a transporter loads. What is
  new is that the production behind that point has somewhere it happens.

Neither is a circle, and neither is drawn as one. A parcel grows one cell at a
time, always taking the best ground it can reach, so it runs up a fertile
valley and stops at the water, the crag, and the neighbour's fence. The
distance term only says roughly how far is reasonable; the terrain says which
way. This is the same technique the realm's border already used and for the
same reason — a shape that came out of the country reads as a place, and a
circle reads as a radius.

### The one asymmetry everything rests on

A town may build over a working. A working may never grow back over a town,
and no working may take ground from another.

That single rule is the engine. A village hemmed in by its own resource sites
has two options and both of them cost: expand into the workings it lives on,
which measurably reduces what they yield (`ResourceNode.productionInterval`
now divides by `groundQuality`), or stop growing, because houses need ground
to stand on (`housing.ts`'s `hasRoomToBuild`). Nothing anywhere says "a rural
village may not become a city". It simply costs what it would really cost, and
the simulation charges it.

That gate is two readings of one fact, and the second is there because the
first is nearly unreachable on its own. A parcel only reports `starved` when a
growth pass finds *nothing* worth taking anywhere on its edge, which needs the
place walled in on every side at once; a place can be comprehensively out of
room while still creeping onto the odd poor cell, and the honest signal for
that is simply failing to keep up with the acreage its own population already
implies. Ordinary growth never comes near it — parcels lay out ground several
times faster than population asks for it — so falling behind means genuinely
losing the race for ground.

### Rural and urban, as a readout of the country

`urbanity` is read off two things, and population is deliberately not one of
them — population is what this *causes*, via housing and industry, and keying
it on population too would close that loop on itself the way tier-driven
industry capacity once did. What it reads is the ground: how much free,
settleable country surrounds the place, and whether it actually managed to
take the ground it wanted.

It then does exactly two things, both on systems the player already watches:

- **Industry capacity scales with it** (`industry.ts`). In a village most of
  the population is out on the ground it lives off and a workshop is one man
  and his son; in a town that ground is somebody else's and the hands are
  indoors. This is what turns "room to grow" into "planks, blocks and tools",
  which is where the wealth is — so an open-country town urbanises *and*
  specialises upward, and a works-ringed village stays a works-ringed village
  making raw goods.
- **Housing stalls when a place is boxed in**, as above. Population levels
  off, `tier.ts`'s population bar does the rest, and a rural place keeps a
  rural label without anything having to award it one.

Two hooks, no new subsystem, and the interesting half — that a place's fate is
decided by the country it was founded in — falls out of them.

### Founding looks at room, not just at ground underfoot

The settlement score gained a `room` term (`settlementSystem.ts`), because
`terrain` only ever answered "what is this one cell like". A crossroads on a
perfect acre wedged between a mountain, a lake and three working woods scored
full marks on `terrain` and had no future. `room` asks the wider question the
founder actually asks — and since the same reading later decides how urban the
place becomes, a settlement founded with room around it is a settlement that
can take it.

### What this also fixed, almost incidentally

A place's click target is now the place. A town covering a quarter of the
screen with a twenty-pixel hit box in the middle of it was only ever
defensible while a town covered nothing at all — see `World.placeAt`, kept
deliberately separate from `siteAt` because a road still anchors on a place's
*centre* and always should.

### Calibrate these against measurements, not against intuition

The first cut of `urbanity` read 100% at every place in the realm — not
because anything was broken but because the band was a guess and the
distribution was nothing like it. Over a parish-sized hinterland of ordinary
procedural country, openness lands in the eighties and nineties, so a band
running from 0.25 to 0.70 saturated everywhere and the readout said nothing.
The same mistake was quietly sitting in the settlement score's new `room`
term, which was being fed the raw share and therefore contributed nearly its
full weight at every candidate on the map.

This is the identical lesson `industry.ts`'s `INDUSTRY_INPUT_LINE` records at
length, and it has now cost this project twice: *a threshold's meaning depends
entirely on the distribution it is compared against*. Measure what the
quantity actually settles at before drawing a line across it. The tuning
harness prints openness, buildable share and works share per place for exactly
this reason — when these numbers need changing, change them against a run, not
against a feeling.

### Where this is knowingly a simplification

Only claimed sites hold ground. A deposit beyond the border works nothing,
which means a town inside the border can quietly sprawl over country a
frontier offer would one day have wanted. That is left in on purpose: it is a
real consequence of leaving an offer on the table, and it is consistent with
"claiming is not exploiting" — but it is a consequence the player currently
cannot see coming, and it should probably be surfaced before it bites anyone.

## Building: what a place is, is what it built

The three questions this answers used to be answered by three numbers that
nothing in the world could feel: a development score that accrued for being
comfortable, a housing ladder that accrued for being crowded, and an industry
capacity table keyed on how many people happened to live somewhere. All three
are gone. A place now has exactly one thing that makes it what it is — its
**fabric**: the houses and workshops it has actually put up, bought with
material somebody carried down a road the player drew.

**Nothing is eaten that isn't eaten.** People eat grain and burn firewood.
That is the whole of subsistence. Stone, iron and every worked good are drawn
by *building*, and by nothing else. This is the single change that made a
processing economy possible at all, and the diagnosis is the most instructive
thing in this section, because everything looked correct right up until you
measured it: every raw good used to be a per-capita sink at a rate that scaled
with population, while the stock a place *wants* scales with population too —
so a shelf converged to its own buffer and stayed there, by construction,
forever. An industry may only work material above `WORKING_RESERVE` of that
buffer. Measured on seed 1234 at day 61 with a hundred residents: **one plank
existed in the entire realm**, no blocks, no tools, and the tools shortage had
read 1.00 without interruption since the first tick. The gates were not too
strict. There was structurally never anything spare to put through them, no
matter how rich the country got. A villager chewing on a block of limestone
was never believable anyway.

**Worked goods are worth building with, and that is their reward.** Two wood
make a plank and a plank lays three fabric; two stone make a block worth 3.6.
So a sawmill multiplies a forest's worth by half again — in houses raised, in
trees *not* hauled, and therefore in hands not spent walking. A place built in
plank and dressed stone also decays more slowly and reads grander for the same
acreage. The reward for refining is paid in the two currencies this game
actually runs on, labour and road traffic, rather than in a score.

**Demand is what somebody actually wants.** A place's appetite for material
is how much building it has in front of it, not how many people live there.
That one line is what makes the market real: a finished capital sitting on
ninety-six planks reads as *surplus* and ships them to the five hamlets trying
to build, where a flat per-capita target had it reading as the hungriest place
in the realm because it was the biggest. Nothing had to be added to the trade
system to get this; it was already asking the right question and being told
the wrong answer.

**A place has to keep what it built.** Fabric decays, and upkeep is a first
charge on a place's effort — before anything new is begun. That is what keeps
the processed economy a permanent market rather than a phase a realm passes
through, and it is what stops a place coasting on one good decade. A town that
loses its timber supply genuinely shrinks. The floor (`FREE_FABRIC`) is what
keeps that from being a death spiral at the bottom: huts people put up out of
what is lying about need no supply line and cannot be lost.

**And a workshop is a building.** A sawmill exists where the realm is short of
planks *and* this place has timber going spare — supply and demand, both
halves required — and it exists by being built, out of material, like
everything else. This replaced the last table in the simulation that handed
out economic capacity by category: a village of sixteen could host three
sawyers and one of fifteen could host two, on a map where nothing looked any
different either side of the line. The population floor that gated industry is
gone too, and nothing replaced it: a pair of huts with no timber surplus has no
sawmill to staff, not because a rule forbids it but because nobody ever built
one.

**Bread is the food side of the same idea.** A county with more farmland than
it could eat had nowhere to put the surplus — food is not a building material,
so the only sink was the population already there and the excess decayed off
the shelf. Two measures of grain and the fuel to fire an oven make one loaf,
and a loaf feeds three: baking returns half again as much eating as the grain
went in with, exactly as milling returns half again as much building as the
timber did. It buys a second thing that may matter more in a game about roads:
grain is bulky, and feeding a town in bread is a third of the cart-loads of
feeding it in grain. A realm that bakes near its farms and ships loaves gets
those hands back for something else. And because a bakery wants fuel as well
as grain, it lands in both the places it should — out among the farms where
the grain is spare, and in a town where grain from a dozen farms is already
being centralised and the firewood is already arriving.


### People take up a trade

A villager was a body. The labour market posted whoever was nearest to
whatever the realm was shortest on, and took them back out the moment some
other good's shortage crept a fraction ahead — because nothing in the
simulation knew the difference between a woodcutter of thirty years and a man
who was hoeing turnips this morning. The only brake was one flat margin that
had to be small enough to let a real famine win and large enough to stop two
openings trading the same pair of hands forever. It cannot be both.

A **craft** (`craft.ts`) fixes that where the problem lives, in people rather
than thresholds. Working a trade makes you better at it, worth real output.
Changing trade throws most of that away. So the labour market has to want it
more the deeper someone is in — a green hand moves for very little, a master
only for a famine — and a realm settles into specialists without anything
deciding that it should. A site gives up its greenest hand first, and an idle
tradesman is worth going out of the way to fetch back to their own trade.

The general lesson, and it is the one this project keeps paying for: when a
threshold has to be two different values at once, it is answering two
different questions, and the fix is two rules rather than a better number.
That diagnosis produced the split between subsistence and building, the split
between expanding and maintaining, and the craft system, all in one pass.

### Two kinds of water, and only one of them answered

A river on an authored map is not wet cells in the terrain raster. It is a
*line with a width* (`river.ts`), because a real river is usually narrower
than a terrain cell and rasterising it would either lose it or turn a stream
into a lake. That is the right model and it is not the bug.

The bug was that only one system ever asked it. `canLayAlong` consults the
river network directly, so roads have always priced their crossings correctly.
Everything else asked `terrain.isPassable`, which is dry along every river in
the game. Measured on the Kuttenberg pack: ninety-two rivers, and of the wet
points found around the founding village, **every single one read as dry
ground to the raster**. The consequences were exactly as invisible as that
suggests:

- **No bridge was ever drawn over a river.** The road renderer decides which
  stretches are decked by asking whether the ground beneath is passable, so
  roads crossed rivers as though they were not there — which is precisely the
  reading the bridge mechanic exists to correct, and the reason the crossing
  did not look like the expensive, deliberate thing it is.
- **Parcels laid their fields straight across.** A village's closes and a
  wood's cutting ground scored cells off the terrain sample alone, so the
  river was not an argument about where a place could spread; it was not
  anything at all.

Both now go through `RiverNetwork.widthAt`, which answers the question the
raster cannot. The general lesson is the familiar one in a new place: when a
fact about the world lives in two representations, every consumer has to be
able to ask about both, or the quieter representation silently stops existing
for everything except whoever wrote it.

While fixing it, water stopped being *impossible* for a parcel and became
merely dear — the same correction roads got when they learned to bridge. A
town may now straddle its own river once it has taken the dry ground either
side, which is what towns on rivers actually do; a working may not, because a
field cannot be ploughed through running water. And clearing gained a price:
`clearingPenalty` scales a cell's worth by the timber standing on it, so a
village prefers scrub to old woodland and pays real acreage for the wood it
fells — except a forester, who is not clearing at all and for whom dense
timber is the asset.

That change also caught a latent trap worth recording. Settlement founding
gated on `terrain > 0`, which was only ever the same test as "can anything
stand here" because water happened to score exactly zero. Making water dear
rather than forbidden would have allowed a town to be founded on open water.
Suitability is a preference; existence is a different question, and the gate
now asks the one that means what it says.

## Prices, not gates: what actually limits the economy

A recurring question worth having a written answer to: can this economy
develop however it turns out to be most efficient, or is it walking inside a
fence of constants? Both, and the distinction that matters is **whether a
number is a price or a gate**.

A *price* is a term in a score. It says "this is worth less than that", and
anything sufficiently valuable can outbid it. `laborPriority`'s famine bonus,
`routeScore`'s distance term, `REASSIGN_MARGIN`, the investment discounts in
`trade.ts` — all prices. The economy is free to do the expensive thing when
the expensive thing is worth it, which is the whole point.

A *gate* is an early `return`. Nothing outbids it. Every gate is a statement
that some outcome is forbidden regardless of how much the simulation would
like it, so each one needs to be saying something true about the world rather
than something convenient about the code.

The gates that remain, and what each claims:

- **A works only gets so big** (`MAX_WORKS_SLOTS`). A mill is a building, not
  an industry. A realm wanting more planks than one mill can cut has to find
  somewhere else worth putting one — which is why industry spreads across a
  realm instead of piling into the capital.
- **A deposit only holds so many hands** (`NODE_LEVELS`). The seam is only so
  wide. Measured at day 151 the realm was using roughly four fifths of its
  total node capacity, so this is close to binding and worth watching.
- **A place needs ground to build on** (`hasRoomToBuild`). This is the land
  system, and it is the intended brake on a valley that has run out of valley.
- **A civilisation earns its next village** (`POPULATION_PER_PLACE`). In the
  long run this pins settlement count at about population over nine, which is
  a real constraint on how the realm spreads and is doing so deliberately —
  the alternative is scattering hamlets nobody will ever fill.
- **Nothing settles on top of a works, or on its neighbour's doorstep**
  (`resourceExclusion`, `minimumSpacing`). Geometry.
- **Someone has to be free to carry** (`haulageDemand` in
  `WorkforceSystem.post`). The most suspect one on this list: it is derived
  from real quantities (production rate, route length, Little's law) but it
  prices only *node-to-trader* trips, and the trade system also runs
  trader-to-trader redistribution and node investment runs. See the open
  entry about goods piling up.

And two that were measured and turned out not to be doing what they looked
like they were doing:

- **The dispatch interval** (`MAX_DISPATCH_RATE`) reads like a hard ceiling on
  how much trade a civilisation can conduct, and the comment above it records
  a previous version that genuinely was one. Raised fivefold on seed 1234 over
  150 days it moved nothing worth reporting: 356 residents either way, 66
  carriers against 70, wealth within three percent. It is a budget on how often
  an expensive question gets asked, and at present the answer is not what the
  economy is short of.
- **The stand-in player's appetite gate** was, and it was pointed the wrong
  way. See the failure-mode entry; this one is in the harness rather than the
  game, which made it worse rather than better.

The working rule going forward: reach for a price first. If a gate is genuinely
needed, write down what fact about the world it asserts, and check by
measurement whether it binds — a gate nobody ever reaches costs nothing and a
gate everybody sits against is running the economy.

## Failure modes we've already been burned by

These aren't hypothetical — every one of these has actually happened during
development, been diagnosed, and been fixed (or is being actively managed).
Keep this list current; it's the sharpest tool for catching a regression
before a player does.

- **The test harness's stand-in player stopped playing whenever the economy
  did well, and it silently graded every experiment.** `surveyor.ts` refused
  to connect any site whose good scored under 0.5 on its own appetite scale,
  and that scale starts at 0.2 for stone and iron — so an ore deposit needed a
  realm-wide shortage of about 0.35 before a "measured" player would run a
  road to it. The consequence is the nastiest shape a measurement bug can
  take: **any change that genuinely improved supply pushed shortages down,
  which switched expansion off, which showed up in the report as the change
  having broken the game.** Measured directly — the same seed, the same 150
  days, a change that took iron shortage from 1.00 to 0.22 — connected
  deposits went from seventy-three to twenty-two, settlements from
  thirty-two to thirteen, and two thousand Expansion Capacity sat banked with
  nothing bought. Two separate experiments were run and drew the wrong
  conclusion before the cause was found, and they had produced byte-identical
  output, which is what finally gave it away: whatever those runs were
  measuring, it was not the thing being varied.

  Fixed by deleting the threshold and leaving appetite as what it always
  should have been, a weight on *which* site to connect next. The judgement
  the gate was reaching for — do not connect a site the realm cannot service
  — already exists as `strained`, and that one asks about the network rather
  than about whether the larder happens to be full this week.

  Two lessons. A harness whose bias points the same direction every time is
  worse than no harness, because the bias is invisible in the columns and
  reads as a result. And the "player" in a playtest harness needs the same
  scrutiny as the simulation: it is a decision-making agent inside the
  experiment, not part of the apparatus.

- **A cart needed a road firmer than the model says ground can get, so
  nothing ever used one.** The convoy ladder priced every rung as a fraction
  of `ROAD_DEVELOPED` (18), which put a carter's requirement at 5.4 — above
  `WEAR_FULL` (4.5), the wear at which the simulation itself says soil has
  finished packing and stops changing. Measured on seed 1234 at day 120,
  across every connected deposit's road home: weakest-stretch wear ran p10
  0.00, median 0.38, p90 4.08. **Fifty-seven of sixty-one hauls were long
  enough to want a cart and could not have one**, and the realm ran forty
  porters averaging a two-thousand-seven-hundred-unit round — the exact
  "why is nobody using a waggon" the whole convoy system was built to avoid.

  Fixed by asking the two rungs against the two scales this project had
  already separated for precisely these two meanings. A **cart** needs firm
  ground, which is a question about soil, so it is priced against `WEAR_FULL`
  and saturates where soil does. A **waggon train** needs standing in the
  network rather than dry mud, so it stays on `ROAD_DEVELOPED` and keeps
  answering long after the ground has stopped changing. Afterwards: median
  edge wear 0.78 → 3.23, porters' mean route halved to 1273 while carters took
  over the long hauls at 2526, food actually arriving up 17% and the worst
  food shortage 0.43 → 0.26.

  Two smaller things fell out of the same measurement. The class was decided
  by the road alone while the *load* was capped separately by whatever the
  source had spare, so a caravan regularly formed to carry four units: a
  waggon train harnessed up to move a porter's load, at three quarters of a
  porter's pace, packing the road no harder for it — strictly worse than
  walking, every time. And a site's own workers had all but stopped carrying
  their backlog out: the fallback was a global serial queue (one worker
  anywhere in the realm every three hours, fine for six deposits and no rate
  at all for sixty) whose timer additionally reset whenever *anyone* claimed a
  single unit, which on a long haul is most of the time. That one matters
  beyond its own throughput, because a distant deposit generates no traffic
  until somebody walks its road, and settlements grow out of traffic near real
  work.

- **A whole economic layer that could never once run, because two correct
  rules multiplied.** Demand for every raw good was per-capita and scaled with
  population; the stock a place *wants* was also per-capita and scaled with
  population; an industry may only work material above a fraction of that
  want. Each of those is defensible alone. Together they mean a shelf
  converges to its own buffer and stays there no matter how rich the country
  gets, so "genuine surplus" is a set that is *always empty*. Measured on seed
  1234 at day 61 with a hundred residents and fourteen worked deposits: one
  plank in the entire realm, no blocks, no tools, and a tools shortage that
  had read 1.00 since the first tick. Three separate passes had already been
  spent loosening the industry gates, each correctly identifying a gate and
  none of them able to help, because the gate was not the problem — the
  distribution it was compared against was. Fixed by making people eat only
  what people eat (`SUBSISTENCE`) and letting building draw the rest. The
  general form: when a threshold never fires, plot the quantity before you
  move the line.
- **Wealth minted rather than earned, and invisible for as long as nobody
  earned any.** An industry was credited the full `BASE_VALUE` of its output
  and charged nothing for the input it consumed. Harmless while industries
  never ran; the single largest number in the economy the moment they did —
  wealth income went from 51 a minute to 516, and because Expansion Capacity
  is driven substantially by prosperity, the realm began taking in frontier
  sites about three times as fast on identical production. Fixed by crediting
  the margin. Worth noting that the *symptom* would have read as "expansion is
  too cheap" and invited a tuning pass on `expansion.ts`, which was blameless.
  A dormant subsystem can hide a bug indefinitely; switching one on is a good
  moment to re-read everything downstream of it.
- **One threshold asked to be two, and moving it just trades the failures.**
  A single occupancy figure decided both "is this place crowded enough to
  build more houses" and "is it worth keeping the houses it has". At 0.55 a
  half-empty capital let its roofs fall in — a hundred and twenty-five places
  for fifty-eight residents, losing fabric daily with material sitting on its
  own shelves. At 0.35 the same capital built two hundred and fifty-seven
  places for ninety people and swallowed every scrap of material in the realm:
  it never built a masonry or a smithy at all, and the deposits the
  civilisation managed to connect *fell from twenty to eight*. The fix is not
  a third number between them. Upkeep is a first charge on effort and asks no
  question; expansion keeps the high bar. Same shape as `WEAR_FULL` above, and
  worth recognising by the symptom: if a threshold is wrong in both directions,
  it is answering two questions.
- **The worst tail standing in for the distribution.** `worksWant` first asked
  "how short is the worst-off place in the realm of tools?" to decide whether
  a place should build a smithy. One three-person hamlet founded last week
  with an empty shelf pinned that at 1.00 permanently, so *every* place in the
  civilisation wanted a smithy: eleven of fourteen had built one by day 91,
  several of them villages of six sitting on fifteen tools with nobody to sell
  them to. The labour market asks the worst-case question on purpose — a
  famine anywhere is an emergency everywhere — but "where should a workshop
  stand" is the opposite kind of question. Third time this exact trap has been
  hit (see the saturation entry below); the tell is a realm-wide figure that
  never comes down.

- **One constant answering two questions, and every road in the realm
  clamped at maximum because of it.** `WEAR_FULL` (4.5) meant both "the
  ground is as packed as it gets" and "this is the scale a road's width and
  colour are drawn against". Those are not the same quantity and they had
  drifted an order of magnitude apart: measured on seed 1234 at day 120, the
  *median* live road carried wear of 5.7 and the busiest 19.2 — so from
  roughly the first week of any game, every road on the map was pinned at the
  top of its own scale. That is the real reason roads all looked alike, why
  nothing ever read as "a path that grew into a road", and why successive
  passes on the *drawing* of roads kept failing to fix it: the renderer had a
  twenty-fold dynamic range available and was being handed a saturated one.
  Fixed by splitting the constant — `WEAR_FULL` keeps the physical meaning
  and keeps its early clamp (a well-used lane really is as easy to walk, and
  as good to settle beside, as a highway, and `wearEffort`/`routeScore`/
  settlement emergence are all tuned that way), while `ROAD_DEVELOPED` (18)
  is the traffic scale that appearance and convoy class are read against.
  The general lesson is the one this list keeps relearning: when a number is
  used by two systems for two different reasons, it will eventually be right
  for neither, and the symptom shows up in the system nobody was editing.
  *Calibrate against a measurement — the medians above came from the headless
  playtest, not from looking at the screen.*
- **A world with no stated scale, and a walking speed a fifth of what it
  should have been.** Every distance in the game was tuned by feel against
  every other distance, which is fine until something outside the game has an
  opinion. An imported map of the country around Kutná Hora had one: it knew
  exactly how far the nearest wood was. Written down, the game's own numbers
  turned out to agree almost perfectly on **four metres to the world unit** —
  a hamlet's footprint is 1.7km, a claim holds 1.5km, deposits sit 5km apart,
  the procedural world is 160km across. Every one of those is a figure a
  medieval geographer would recognise, and not one was chosen with metres in
  mind.

  `WALK_SPEED` was the single number that disagreed, by a factor of four and
  a half. At 82 units an hour a villager covered eight kilometres in a day,
  so a round trip to the parish wood cost most of a day and the economy was
  built on top of that: nearly half the workforce permanently on the road,
  not because hauling three kilometres is genuinely that dear, but because
  everyone was walking at the pace of a slow tortoise. Correcting it to a
  day's journey (35km, `scale.ts`) roughly doubled every civilisation the
  harness has ever measured — seed 1234 went from 83 residents to 175, and
  the Kuttenberg import from 16 to 125.

  The lesson is not about speed. It is that a simulation meant to be checked
  against reality has to say what its units mean, or a number can sit four
  and a half times wrong for the whole life of a project and read as a
  balance problem every time it is looked at.
- **A correct simulation running at an unreadable speed.** The companion
  mistake to the one above, and it only surfaced once that one was fixed.
  With `WALK_SPEED` corrected to a day's journey, and the wall clock still
  feeding `World.update` one in-game hour per real second, a villager crossed
  the whole Kutná Hora basin in a few seconds. Nothing was out of balance —
  the model was right and the projector was running fast.

  The tempting fix is to slow walking down again, which would put the units
  back to being wrong. The actual fix is one number outside the model:
  `REAL_SECONDS_PER_HOUR` (`scale.ts`, applied in `GameScene` and nowhere
  else). Every rate in the simulation is per in-game hour, so stretching the
  hour slows walking, production, wear and migration together and changes no
  balance whatsoever; the existing 10x button lands back on the old pace.

  Two things had to follow it, both of the same kind: anything that had been
  written in seconds while meaning hours had to say which it meant (the
  road draw-in flourish), and the villager stride animation had to be paced
  off ground covered instead of elapsed time — time-paced legs churn at a
  fixed rate no matter what the body is doing, and came adrift the moment the
  clock changed. Pacing them by distance also makes a villager labouring up a
  hill take slower steps for free.
- **0-population settlements/cities.** Tier or existence decoupled from
  actual residents. Caught a second, subtler instance of this: industry
  worker *capacity* was keyed to a trader's tier, but tier is itself driven
  substantially by that same industry's wealth — so a couple of workers
  hired during a population peak could push tier up, which unlocked room for
  more workers than the (since-shrunk) population could plausibly spare,
  compounding into a several-worker industry propping up a population
  handful all the way to "Major City." Fixed by keying industry capacity to
  the owner's own current population instead of tier (`industry.ts`), and by
  gating tier itself on population directly, not only on development
  (`tier.ts`'s `TIER_POPULATION_THRESHOLDS`) — the same "whichever of two
  ladders is behind" idiom `nodeLevel.ts` already used for a node's level.
- **Permanent stalls.** A node's investment (or anything else with a
  threshold) gets outcompeted forever by a scoring rule that always favors
  something else — usually "favor whoever needs it most" quietly starving
  whoever's closest to finishing. Also shows up as a phantom assignment: a
  villager dispatched toward a node/industry who's later diverted to a
  *different* job type (a one-off delivery detour, a fresh hire elsewhere)
  without both `workplace` and `industryWorkplace` being cleared leaves the
  original target's `incomingWorkers` count stuck non-zero forever — the
  opening reads as "already being filled" and nobody is ever dispatched to
  it again. Observed directly: a mine sat unstaffed beside a population-zero
  settlement for 80+ in-game days this way. Fixed at the root — `release()`
  (the one place a villager becomes properly idle) now always clears both
  fields, instead of trusting each of the several call sites that hire or
  free a villager to remember to (`villager.ts`).
- **Population death spirals.** Any new claim on a scarce resource (wood is
  the recurring offender) that competes with existing production/investment
  flows can tip the whole economy into a self-reinforcing collapse — watch
  for this *specifically* whenever a new system consumes a shared resource
  directly from storage rather than through the weighed trade system.
- **Metric artifacts that quietly cap growth.** `sustainablePopulation` is
  throughput-based, not stock-based — a *well-managed* food supply (fully
  stocked, so few new deliveries dispatch) can read as "unsustainable" and
  throttle population even though nobody's hungry. Know which of your
  metrics measure the real thing and which measure a proxy that can diverge
  from it under success. Turned out sharper than that framing suggests: raw
  food is deliberately never consumed from storage (see `consume`'s doc
  comment in `economy.ts`), so once a trader's shelf happens to be topped
  up, `shortage()` — the signal hiring actually watches — reads comfortable
  *forever*, even if every farm has since gone unstaffed and throughput has
  flatlined. Nothing was ever going to deplete the storage that kept making
  the shortage look fine, so this wasn't a throttle, it was a permanent
  blind spot: population crashed toward zero (observed dropping from 18 to
  a target under 1) while every farm sat idle and nobody staffing them ever
  looked urgent. Fixed by feeding a civilisation-wide "is throughput actually
  keeping up with population" reading into food's hiring priority alongside
  (not instead of) ordinary storage shortage, so a real production stoppage
  is visible to the labour market even when the shelf still looks fine
  (`systems.ts`'s `foodThroughputDeficit`).
- **Bootstrapping vs. runaway priority.** A bonus that fires once (to get
  something started) and never turns off can cause oscillation and
  starvation elsewhere; a bonus that scales with live severity self-corrects
  but has to keep a floor for the "everything's fine but this is a coin
  flip" case, or a tie-break extinction becomes possible again. Also: a flat
  bonus doesn't survive *multiple* simultaneous claimants — several
  settlements bootstrapping at once all get the identical nudge, so the tie
  is actually broken by whichever resource is scarcer civilisation-wide
  (usually food), and a mine or quarry bootstrapping a different settlement
  can lose that tie forever. Fixed by growing the bonus the longer a
  specific opening sits passed over, the same "scale with live severity"
  shape as the food bonus above, so whichever bootstrapping settlement has
  waited longest eventually wins regardless of what its site produces, and
  the timer clears the moment it's staffed (`systems.ts`'s `bootstrapWait`).
- **A temporary, legitimate absence reading as a real vacancy.** The
  fallback where a worker personally carries off their own node's backlog
  (`WorkerDeliverySystem`, for when nobody else is coming to collect it)
  used to take them fully off the node's roster for the trip and route them
  back through the general idle pool afterwards. Both ends of that were
  actually the same bug: while they were out, the post read as genuinely
  open, so a second person routinely got hired into a job whose original
  holder was still just walking a delivery — and coming home through the
  idle pool meant even a worker who wanted their old post back had no
  particular claim on it if someone else had taken it in the meantime.
  Fixed by keeping them on the node's roster the entire trip (`workplace`
  and the node's `workers` entry both stay put) and having them resume the
  same post directly on return (`TransportSystem`'s `resumePost`), instead
  of treating "stepped out for ten minutes" as "the job is vacant." Doing
  this safely also meant closing a real hazard it opened: `rebalance` and
  the poach in `WorkforceSystem.post` used to assume anyone in a node's or
  industry's `workers` array was actually standing at their post and free
  to reassign — no longer true once someone can be listed there while
  genuinely off making a delivery, mid-trip with cargo and a pledge riding
  on them. Both now filter to workers actually present (`systems.ts`'s
  `isAtPost`) before picking a donor to pull.
- **A ratio you can only correct by touching production is not worth
  keeping.** The population/dependent split (`WORKING_POPULATION_SHARE`)
  tried to hold near 30/70 as population rose and fell, but the removal
  side of a shrink event can only safely take whoever's actually idle — and
  since a dependent could never be anything else, they were almost always
  the only one idle, so repeated shrink-then-regrow cycles (population's
  normal state) drove the dependent share toward zero over a long run. The
  tempting direct fix — forcibly vacate a *working* non-dependent's post
  instead, when the ratio calls for it — was tried and immediately produced
  a real death spiral: pulling a farm worker to fix a bookkeeping ratio cut
  food throughput, which shrank the population target further, which pulled
  another worker. A debt ledger (`dependentDebt`) that leaned future births
  the other way papered over the drift, but the underlying rule was still
  fighting itself every cycle for a distinction (child vs. adult) the
  simulation never modeled anywhere else — no ageing, no lifespan, nothing
  that would make "dependent" mean more than "the person a shrink is
  allowed to take." Removed the split entirely: every villager is available
  to work the moment they're born. The labour-starvation and
  transport-share tests this was protecting against are covered by other,
  real bottlenecks (housing, haulage capacity) instead of an invented one.
- **A comfort/development formula that only counts cash wealth.** A solo,
  self-sufficient village (or a settlement with nobody else to trade with,
  and no spare population to staff an industry) can never earn a single
  point of wealth *income* no matter how well it's actually doing —
  everyone's fed, population's growing — and treating that as "zero
  comfort" crashed development to the fastest possible decline for the
  entire early game, before a second trading partner exists, regardless of
  play. Fixed by blending "is it fed" in alongside "is it earning"
  (`development.ts`'s `comfort`), so a well-fed but wealth-less place holds
  a slow, steady climb instead of an unavoidable slide — wealth is what
  pushes it into the fast lane, not a precondition for not declining.
- **A metric that saturates is a dead metric.** `MigrationSystem`'s
  `opportunity` — the entire basis for anyone ever moving house — was the
  max shortage across *every* tracked good. That includes the processed
  ones, and planks, stone blocks and tools sit at a flat 1.0 shortage at
  every place in the game until industries are running. So every trader
  scored exactly 1.0, no destination could ever clear `MIGRATION_MARGIN`
  over any home, and migration had quietly never relocated a single
  villager in its entire existence. Nothing looked broken: people simply
  stayed where they were born, which is indistinguishable from "nobody
  wanted to move". It only surfaced when settlements founded next to
  distant deposits stayed hamlets of three forever. Check that a score
  actually *discriminates* between its candidates before trusting it —
  print the distribution, not just the winner.
- **Signals that are consequences of the thing you're steering oscillate.**
  Replacing that with "how much uncollected stock is piling up in this
  place's catchment" was the obvious fix and read beautifully — a full shed
  nobody has come for is exactly the inefficiency the rule exists to answer.
  It also swung settlements between twenty residents and zero, repeatedly:
  backlog is *caused by* where people live, so the population moved to the
  worst backlog, cleared it between them, watched the draw collapse, and
  left again. Fixed by measuring what the catchment *generates* (production
  rate — a property of the geography, which doesn't evaporate when help
  arrives) and by measuring it **per resident**, so a place's pull falls
  smoothly as people actually get there. Equilibrium is then "work per head
  is even everywhere", which is both stable and the efficient answer.
- **Generation that ignores what a resource is *for* produces a plausible,
  deadlocked world.** Terrain-weighted placement gave a mix that mirrored
  the terrain — plains are the commonest ground, plains grow food, so half
  of all deposits were farms and stone was 12%. It looks right. But stone
  is the upgrade material for *both* forests and farms (`nodeLevel.ts`) and
  the masonry's input, so one quarry was serving sixteen nodes that each
  needed twenty-five units: nothing ever levelled, node worker capacity
  stayed at one, settlements could never grow past their neighbours' single
  posts, influence never widened, and the map never opened. The world was
  beautiful and completely stuck. `RESOURCE_BALANCE` now weights the
  *choice* between plausible options by what the economy actually consumes,
  without ever making an implausible one possible.
- **A ladder that isn't monotonic.** `TIER_INFLUENCE` had Hamlet at 960 and
  Village at 660 — a one-off fix for a slow opening, left in place — so the
  first promotion a place ever earned *shrank* its reach by a third. Nothing
  errored (revealed nodes stay revealed), it just quietly inverted the loop
  the ladder exists for, where growing is what lets you reach further. If a
  table is supposed to be a progression, assert that it actually ascends.
- **A threshold calibrated against the wrong zero.** `terrain.ts`'s
  forest-vs-plains split was first written as `forestScore > 0.08`, with
  `forestScore` built out of raw 0-1 moisture and temperature — whose actual
  mean sits around 0.45, not 0. The result wasn't a subtle bias, it was
  total: a scan of the starting region found forest on 69% of ground and
  plains on *none* of it, because nearly every lowland cell cleared a
  threshold sitting nowhere near the distribution it was meant to split.
  Fixed by rebuilding the score entirely out of terms recentred on their own
  midpoint (`moisture - 0.5`, not `moisture`), so its mean is genuinely zero
  and a small threshold is a real, legible bias rather than a number
  fighting the formula's own scale. Worth remembering generally: a
  threshold's meaning depends entirely on what distribution it's being
  compared against — check the actual mean, don't assume a 0-1 signal
  centres on 0.
- **A permanent-stock exception can't be reused as a temporary one.**
  Wanted: a founding village's population shouldn't crash before the player
  could possibly have built a road. Tried first: let a genuine food
  *stockpile* prop up `sustainablePopulation` (which is deliberately
  throughput-only — see the metric-artifact entry above) alongside real
  throughput. This technically worked for the founding reserve, but the fix
  doesn't know the difference between a two-minute starting stockpile and
  ordinary storage a real settlement accumulates over play — and since raw
  food is never consumed (again, see above), *any* healthy stockpile would
  have permanently propped up the reading, silently reopening the exact
  blind spot already fixed once this same session (a farm can go fully
  unstaffed and the metric would never notice, because storage never
  runs out to prove it wrong). Fixed by making the grace period wall-clock
  instead: a fixed floor for a fixed number of seconds after founding,
  tracked by its own countdown, with no reference to storage at all. The
  general lesson: a fix scoped to "the founding case" has to actually be
  unreachable outside it, not just unlikely — if the same code path can be
  reached by ordinary play, it will be.
- **Hard gates vs. soft discounts.** Repeatedly, a hard "skip this entirely"
  rule has looked correct in isolation and then produced worse behavior than
  a steep-but-soft discount on the same rule, because a hard gate can
  starve something permanently the moment conditions are *always* slightly
  on the wrong side of the gate. Default to discounting, reach for a hard
  gate only when the two options are truly mutually exclusive (a resource
  site and a settlement cannot occupy the same ground).

- **A world that can be born unplayable.** Nothing ever checked that the
  founding village stood on land a road could leave. Across 200 seeds, 19
  put Oakridge in open water — every road out failed `crossesImpassable` on
  its first sample, and the game ended around day 10 having never accepted a
  single input — and 35 put a *starting* resource in water, which is the
  same dead end wearing a friendlier face (`forcePlacement` explicitly
  exempted Food from its water check, presumably meaning fishing). Fixed in
  three places, all in `worldgen.ts`: `habitableSite` sites the village on
  the nearest ground with enough connected dry land around it to work from;
  the start guarantee now refuses any site that isn't *walkable from the
  village* (`walkableFrom`), so a farm across a bay no longer counts toward
  the quota and stops the search; and a deposit that rolls onto water is
  beached on the adjacent shore (`ashore`) rather than dropped, which keeps
  the fishing-village flavour and makes it something a road can reach. The
  general lesson: a guarantee that isn't checked against the thing that
  actually blocks play — here, "can a road get there" — is not a guarantee.
- **Two tables for the same quantity, one of them switched off.** Demand,
  target stock, "how many people can this feed" and actual consumption were
  read from two separate per-capita tables that disagreed by roughly a
  factor of two — and because the larger one drained faster than production
  could keep up, raw-good consumption was simply disabled. That produced the
  single worst economic bug found in this project: **raw food was never
  taken off a shelf by anything**, so the moment a larder filled to its
  target, `shortage(food)` read zero *permanently*. Food then never scored
  as worth shipping, the trade system quietly stopped carrying it in favour
  of iron and stone, and population — which reads the delivery *rate*, not
  the shelf — starved beside a full granary nothing would ever empty. Fixed
  by deriving consumption from `DEMAND_PER_CAPITA_PER_MIN` and applying it
  to every good: one number for what a person gets through, so the shelf and
  the flow cannot tell different stories. Watch for this shape generally —
  two constants that mean the same thing will drift, and the one that gets
  turned off takes a feedback loop with it.
- **A subsystem whose own damage is what keeps feeding it.** An industry's
  hiring priority was the civilisation-wide shortage of its *output*. But a
  processed good sits at shortage 1.0 everywhere until an industry actually
  runs, so "how short are we of planks" read *maximal* precisely when the
  sawmill had no wood — i.e. exactly when nobody should be sent to one. The
  mills then ate whatever timber did arrive (`hasInput` needed only two
  units, so they ran the shelf to zero on every delivery), which kept wood
  pinned at full shortage, which starved node investment, which froze every
  deposit at level one and capped raw production at one worker per site,
  which left industry as the only place labour could go. Observed at day
  150: thirty of forty-four residents milling nothing, eight connected
  deposits unstaffed, every raw shelf reading zero. Fixed by pricing an
  opening on the *supply chain* rather than on its own output alone
  (`systems.ts`'s `sitePriority` discounts an industry by the scarcity of
  its input, so a mill ranks below the forest that would fix it) and by
  making an industry work only genuinely spare material (`industry.ts`'s
  `INDUSTRY_INPUT_LINE` — a miller works the surplus grain, not the seed
  corn).
- **An arbitrary reserve that hiring drives straight to.** The share of the
  workforce held back for carrying was a flat 15%, and hiring stopped
  exactly at it — so the civilisation sat pinned to that floor forever,
  running seven carriers at forty-four residents whether the deposits were
  next door or half a map away. Nothing about "one in seven people" follows
  from anything in the world. Replaced with `haulageDemand`: Little's law
  over the network the player actually drew — goods appear at a rate, each
  round trip takes as long as the road makes it take, one person is on one
  trip at a time. This is also the change that makes road-building matter in
  the most direct possible sense: a shorter, better-placed road is fewer
  people spent walking, and more left to produce. Built deliberately from
  production *rate* and route *length* (geography and staffing) rather than
  from the pile of uncollected goods, which is a consequence of the carrier
  count and would oscillate against it — the same trap
  `MigrationSystem.workDraw` had to be pulled out of.
- **A global serial queue as a growth ceiling.** `TransportSystem` dispatched
  at most one load every 0.7s no matter how large the civilisation got,
  capping *all* trade everywhere at a few hundred units a minute. Two
  hundred residents comfortably outgrew it, at which point eighty of them
  stood idle while the shelves emptied around them. The interval exists so a
  village's carriers don't set off in one clump; it now scales with how many
  people are actually waiting for work, because a busier place genuinely does
  send more of them.
- **A three-zone step function with its cliff under the common case.**
  Development moved at one of three flat rates, with the worst decline more
  than four times the best growth, and the boundary between "slow climb" and
  "fastest decline" sat exactly where a perfectly-fed, wealth-less place
  landed (comfort 0.5 against a `STRUGGLING` threshold of 0.5). The founding
  village — structurally guaranteed to earn no wealth, since it is where
  everything is carried *to* rather than sold *from* — therefore lived at
  the development floor with sixty-seven well-fed residents, labelled a
  hamlet. Fixed twice over: comfort now reads demand-weighted `provision`
  across the *raw* goods rather than food alone (the worked goods are left
  out on purpose — they saturate at full shortage early and would make every
  place read identically badly, the same saturation trap that made
  migration's opportunity score inert), and `developmentRate` is a straight
  line through a break-even point instead of three zones. A readout should
  move smoothly with the thing it reads.
- **Population gated on grain alone.** `sustainablePopulation` counted food
  and nothing else. Farmland is the commonest ground on any map, so food
  sites outnumbered woodland better than two to one, and population grew on
  grain until it was three times what the forests could supply: wood sat at
  maximum shortage permanently, industries had nothing to work, and eighty
  of two hundred and thirty residents had nothing to do. It is now the lower
  of what the grain feeds and what the timber keeps warm — the same
  "whichever ladder is behind" idiom `nodeLevel` and `tier` already use. Two
  follow-on traps came with it. It has to be computed as the minimum of the
  civilisation-wide *totals*, not the sum of each place's own minimum:
  summing per-place minimums demands every settlement be independently
  self-sufficient in both necessities, which is precisely what a trade
  network exists to make unnecessary, and it reported a starving
  civilisation sitting on a surplus of everything (population 233 → 27). And
  it exposed that `RESOURCE_BALANCE` weighted stone — a fifth of food's
  per-capita draw — at nearly twice timber, which is three fifths of it.
  Generation has to be balanced against what the economy *eats*, not only
  against what gates an upgrade.
- **Settlements founded faster than there were people to fill them.**
  Nothing checked that the civilisation could populate a new place. Once the
  network got busy enough for several patches to clear the potential
  threshold at once, settlements appeared at whatever rate traffic allowed —
  fourteen of them for a civilisation of thirty, four sitting at population
  zero and the development floor forever, wearing a name and a tier label.
  This is the "0-population settlement" failure at its source, and no amount
  of tuning migration fixes it, because the place should never have existed
  yet. `settlementSystem.ts` now requires roughly a Village's worth of
  residents per existing place before another may found: places are founded
  by people.
- **An expensive global decision re-asked every tick.** Both
  `findBestShipment` and `MigrationSystem.relocate` set their cooldown only
  on *success*, so in the ordinary case — nothing worth moving, nobody worth
  relocating — they re-ran their full scan on the very next tick, and every
  tick after. Migration's scan is a route lookup per idle villager per
  destination, so its cost grows with the square of how well the
  civilisation is doing; at a hundred residents it was the most expensive
  thing in the game. Both now charge the cooldown up front. A decision
  nobody could act on more often than every N seconds should not be computed
  more often than that either.
- **A shrink that could only ever take dependents, and then couldn't take
  anyone.** Removal preferred "a free dependent, else anyone free" — but a
  dependent was *always* free, so a population oscillating around its food
  supply ground the dependent share to literally zero, silently inflating
  the labour force by half against the 70/30 split it was meant to hold.
  Worse, once every working adult held a post there was nobody free at all
  and nothing could leave: the civilisation froze at forty-four people
  living off food for thirty, indefinitely, with the readout plainly saying
  so. The dependent/working split has since been removed altogether (see
  above), which also removes this failure mode at the root — there is no
  ratio left to grind toward zero. Removal still prefers whoever's free, and
  as a last resort closes an *industry* — discretionary work by definition —
  rather than letting the shortfall stand forever; taking someone off a
  resource node remains forbidden, since that was tried before and is a
  real death spiral.
- **The player could not reach toward anything.** A design gap rather than a
  bug, and it quietly capped the whole game. A road had to start *and end*
  on something already known; sites only became visible inside an influence
  ring; and rings only sat on places already reached. So the only ground a
  player could ever reveal was a disc around somewhere they had already got
  to — and once the nearest undiscovered deposit sat beyond one such disc,
  no sequence of legal moves could ever find it. Measured at day 150: a
  hundred and thirty people still working the twelve deposits found in their
  first fortnight, with forty-five more generated and permanently invisible
  a short way beyond. Fixed by letting a road end nowhere in particular
  (`RoadNetwork.addRoad`, `RoadDrawing.valid`) and by making the road itself
  reveal the corridor it crosses (`World.roadCentres`). Neither adds a verb
  — the vocabulary is still "draw a road, erase a road" — but together they
  make "roads open the world" literally true rather than merely stated, and
  they make a long trunk road pay for itself twice: in what it connects, and
  in everything it finds along the way. A scouting track that leads nowhere
  still grows over, which is exactly right.
- **A cost model that only sees "how big is the realm", never "what shape is
  it".** `expansionCost`'s only anti-runaway term was a per-holding tax
  (`COST_PER_HOLDING`) applied to the realm's total holding count, and its
  only distance term was `distanceOutside` — distance to the nearest
  *holding*, of any kind. Both are blind to shape: a single-file line of
  claims, each one just beyond the last, prices identically to a compact
  blob of the same count, because "nearest holding" for a chain's tip is
  always the previous link, however far that link sits from anywhere anyone
  lives. Reported directly: a long chain of claimed sites with only one
  settlement, that settlement close to the founding village, and every
  worker on the far end of the chain routing all the way back to the
  village to be re-homed — the near settlement never came within reach.
  Fixed by charging a `remotenessFactor` in `expansionCost`, keyed off the
  *gap* between distance-to-nearest-holding and
  `Territory.distanceFromNearestSeat` (nearest *seat* — a village or a
  settlement, not a bare claim). That gap is zero for any claim made
  directly off a seat — which covers the entire opening game, so ordinary
  play isn't taxed twice for the same distance — and opens, and keeps
  widening, only once a chain's tip is anchored on ground that is itself far
  from any seat. A compact cluster growing outward from a settlement never
  opens the gap, however large it gets, because its edge always stays a
  claim or two from that settlement. Verified with a purpose-built
  adversarial scenario (`tools/snaketest.ts`) that always claims whichever
  affordable offer continues the established heading and drags one
  unoptimised road segment to it: before the fix, a hundred-and-fifty-day
  chain reached population 93 with every settlement bunched within 2000
  units of the village while claimed sites ran out to 8500; after, the same
  scenario spreads settlements out to 4800+ units, and a worker at the tip
  commutes a few hundred to low-thousands of units to the *nearest* one
  instead of four to five thousand back to the capital.
- **A gate that quietly asked for triple.** The settlement-founding
  population gate (added to fix the 0-population-settlements entry above)
  read `ctx.population < (places + 1) * POPULATION_PER_PLACE`, where
  `places` already equals "settlements that would exist after this one" —
  so the `+ 1` counted the settlement being founded a second time. At the
  constant in place (12) that demanded population 24 to found the *first*
  settlement, above even the Town population bar (18), and every settlement
  after it got stricter twice as fast as the comment above the constant
  actually claims. A civilisation whose economy was already strained by a
  long haul (see the entry above) never generated enough surplus population
  to clear the inflated gate, and sat at one settlement for the entire run.
  Fixed by removing the double-count (`places * POPULATION_PER_PLACE`) and
  recalibrating the constant to 9, matching the comment's own stated intent
  of tracking the Village tier's population bar (8). Whenever a gate's
  comment states an intended value, that value is worth checking the actual
  arithmetic against — a formula can drift from its own documentation
  without a single line of it looking wrong in isolation.
- **A founding hand-off with nothing to hand off.** A new settlement gets
  its first residents by re-homing whichever villager is already working
  the nearest site to it (`World.foundSettlement`) — necessary, since a node
  only re-homes its worker once, at hire time. The founding gate checked
  `resources` (is there *claimed ground* worth working nearby) but not
  whether anyone was actually *working* it yet: a patch could clear every
  threshold and found while its nearest resource site sat claimed and
  connected but not yet staffed, and the hand-off then had nobody to hand
  off. Tightened by requiring a genuinely staffed site
  (`workers.length > 0`) in the same range `resources` already checks
  (`settlementSystem.ts`'s `hasNearbyWorkedSite`) — the gate now checks the
  thing the hand-off it exists to support actually needs. Left open: a
  worked site *can* still exist nearby and still fail to populate the new
  settlement, if that site's worker's home was already the nearest
  *existing* seat rather than the new one — re-homing only ever happens
  once, at founding, and never retroactively reconsiders. See "Known and
  still open".

- **A threshold above the ceiling the quantity can actually reach.** The
  industry input line asked for `0.9 × targetStock + inputPerOutput` on the
  shelf before a mill could run. But deliveries are driven by `shortage`,
  which stops calling for more the instant a shelf reaches `targetStock`, and
  `consume` draws it back down continuously — so a place doing perfectly well
  oscillates *just under* its target and never above it. The gate was not
  strict, it was unreachable. Measured at day 111 on seed 1234: every industry
  at all five places read `hasInput = false`, including sawmills and masonries
  at places whose own shortage of the input was exactly 0.00. An entire pillar
  of the design — raw goods becoming worked goods — had therefore never run
  once, on any seed, in the project's history; not one tool had ever been
  forged, which is why every playtest ever printed reported a tools shortage
  of 1.00 forever. Fixed at 0.6 (`industry.ts`). The lesson is one this
  project keeps relearning in new clothes: a threshold's meaning depends
  entirely on the distribution it is compared against, so check what the
  quantity actually settles at before drawing a line across it.
- **A gate that gets harder to pass the better the game goes.** Industry
  staffing required a *per-place* population of 15, in a game whose entire
  design spreads population across many small places. At day 111 on seed 1234
  a healthy civilisation of thirty-four across five places had a mean
  population under seven and *zero* places clearing the bar — and the loop ran
  backwards, since every new settlement a prospering realm founded divided the
  population further. Succeeding made industry strictly less likely, forever.
  The thing the floor was protecting ("don't pull the last farmer into the
  mill") was already handled better by `openingScore`, which ranks every raw
  opening against every industry opening by live civilisation-wide need.
  Dropped to 6 — "is this a village at all", which is the only question the
  sort cannot answer for itself.
- **Distance doing two jobs at once.** The frontier scored offers by
  `1 - beyond / reach` against a hard `reach` ceiling, so distance both ranked
  the offers and decided which existed. The second job quietly guaranteed a
  monoculture: generation deliberately puts stone and iron far out (1500-3000)
  and food and wood near, so any ceiling near the deposit scale offers nothing
  but the common goods however badly the realm needs the rare ones. Measured
  at day 150 on seed 1234: sixty-two deposits visible, forty-one of them
  stone, exactly one stone ever offered or claimed, and a flat 1.00 stone
  shortage from day a hundred on — which freezes every node at level one,
  stone being what farms and forests upgrade with. Nearness is now a
  preference and the survey is the boundary; `expansionCost` was already
  charging for distance, so a far offer is simply a dear one. This also
  deleted the four-step reach-widening ladder outright: it only ever existed
  as a proxy for "how far has anyone looked", and there is now a real answer
  to that question.
- **A threshold calibrated at exactly the spacing of the thing it reveals.**
  The survey horizon opened at 1400 and deposit clusters sit roughly 1300
  apart, which makes "can this realm see anything at all?" a coin flip on the
  seed rather than a property of the design. Two of six seeds opened with
  their nearest unclaimed deposit at 1667 and 1849 units, saw nothing beyond
  their founding sites, and — since the frontier only offers surveyed country
  — could never claim, never move the border, and never widen the horizon. A
  dead game from turn one, on a third of seeds. Horizons now open at nearly
  two rings of deposits. Same family as the forest-threshold bug above: know
  the distribution before you draw a line across it.
- **A gate that checked something adjacent to what its beneficiary needed.**
  `hasNearbyWorkedSite` asked "is somebody working nearby", but the founding
  hand-off it exists to serve re-homes a villager only if the new settlement
  becomes *the nearest trader to their workplace*. Since `crowding`'s minimum
  spacing (360) is smaller than `resourceRange` (520), there is always a band
  where a site is "nearby" for a new settlement and nearer still to an older
  one — so a settlement could clear every gate, found, and catch nobody.
  Re-homing runs once and is never reconsidered, so such a place sits at zero
  forever. Observed twice in a single hundred-and-fifty-day run, both still at
  population zero and at the development floor at the end of it. The gate now
  asks the hand-off's own question, which closes the gap exactly and adds no
  fourth spacing constant to keep in sync with the other three. (This
  discharges the second "Known and still open" item below.)
- **A harness that could not see half of what it was testing.** The stand-in
  player only ever drew roads to *claimed, unconnected* sites, so every
  stretch of road in every playtest ran between two things the realm already
  owned. Both the corridor survey and territory-dependent road abandonment
  therefore measured as perfect no-ops across every seed — byte-identical
  output — not because they did nothing but because nothing in the harness
  ever put a road where they applied. `Surveyor.scout` now runs tracks out
  toward the compass sector the realm knows least about, which is what a
  player does constantly. On the seeds measured this moved visible deposits
  from 26 to 47 and offer coverage from three compass sectors to eight. When a
  change reads as an exact no-op, suspect the harness before believing the
  result.
- **A landscape that kept confessing it was a grid.** The terrain is stored
  on cells because pathfinding needs it to be, but elevation and moisture are
  samples of continuous fields — the grid is how the world is *kept*, not what
  it is. The old renderer drew one rectangle per cell, so the sampling lattice
  was the most legible thing on screen: you could read the cell size straight
  off the picture. Interpolating the readings back into a surface is the
  obvious repair, and it took three goes, because the grid kept coming back
  through a different door each time.

  Linear interpolation left creases along the cell diagonals. Easing the
  weights with a smoothstep fixed those and quietly did something worse:
  smoothstep has zero derivative at both ends, so the reconstructed surface is
  *flat along every cell line*. Nothing looked wrong until it was
  differentiated — and hillshading is exactly a differentiation — at which
  point the whole countryside came out combed into a faint plaid at precisely
  cell spacing. The lattice had moved out of the values and into their slope.
  Only a filter whose derivative keeps varying across sample boundaries
  (Catmull-Rom, `field.ts`) actually removed it. Meanwhile the coastline was
  quantised to whatever the texel grid happened to be, because a hard test on
  `elevation < WATER_LEVEL` always is; that one needed the waterline measured
  as a distance in world units and blended across a texel, after which extra
  resolution stopped being needed at all.

  Three lessons, all the same shape. An artefact removed from a quantity can
  reappear in its derivative, so check the thing you are actually going to
  display. Resolution postpones a quantisation artefact and never fixes one.
  And the grid in the data was never the problem — every one of these was the
  *renderer* choosing to treat samples as tiles.
- **Trees that grew where the classifier said there was no forest.** Scatter
  gated on `forestDensity`, which reads like the right field and is not: it
  measures how wooded ground *could* be, and a plains cell carries 0.5 of it
  as happily as a forest cell does. The result was woodland over open country
  and, at the thresholds first chosen, over most of the map. The field was
  never wrong; using it as a yes/no when the classifier's own forest/plains
  decision was the yes/no was. That decision is a threshold on a continuous
  score, so exporting the score (`woodlandScore`) let the canopy ask the same
  question the classifier asks, at a tree's exact position rather than at its
  cell's centre — agreeing with the simulation *and* giving a treeline that
  wanders sub-cell. Where a renderer needs a finer grain than a cell, share
  the quantity the classifier thresholds; do not proxy it with a neighbour.
- **A river stored in the wrong shape, and a dilation to paper over it.** A
  watercourse is three orders of magnitude longer than it is wide. Stored as
  "which cells are wet", the Kuttenberg map's rivers came out at a
  hundred-and-twenty-eight-metre floor against a drawn width of five — and had
  to, because a one-cell river running diagonally is a chain of cells touching
  only at their corners, which nothing in this game can be stopped by, so
  `thickenWater()` dilated every stream to two cells to close the gap. That
  floor was structural, not a resolution problem: the dilation is needed
  because of how cells connect, so refining the grid would have cost
  twenty-eight times the cells and still left a floor with a five-metre brook
  out of reach. Rivers are lines now (`river.ts`), crossing is a segment
  intersection, and the diagonal bug disappeared rather than being widened
  around. Lakes stayed in the raster, because a lake genuinely is areal. When
  a fix has to make something *bigger than life* to stay consistent, the
  representation is wrong, not the parameter.
- **Three plausible explanations for one tracing bug, and only the picture
  settled it.** Tracing those rivers out of the drawing produced six thousand
  fragments averaging under two pixels. Diagnosis one: the colour classifier
  returns a dotted line, so morphological closing was added. Diagnosis two:
  thinning leaves whiskers that read as junctions, so spur pruning was added.
  Both were reasonable, both helped a little, and neither was the cause — the
  longest traced watercourse stayed at *exactly* 514 metres across six very
  different settings. An invariant that survives changes to its inputs is a
  cap in the code, not a fact about the data. Dumping the mask as a PNG showed
  a clean, continuous dendritic network and ended the guessing in one look:
  the fault was that Zhang-Suen leaves staircase pixels with three
  eight-connected neighbours, so the walk saw a junction every few pixels and
  cut there. Following the straightest continuation instead took the network
  from 8.9km to 25km. Look at the artefact before theorising about it.
- **The same category error, run backwards, on ponds.** Having moved rivers
  out of the cell raster because a line is not an area, the obvious next step
  looked like moving ponds out too — they are small enough that the ground
  bake draws them as smudges, and having half the water crisp geometry and
  half of it blurred raster is a seam wherever the two meet. So ponds were
  given the river treatment: a centreline and a width. A pond's centreline is
  two points, and a two-point ribbon is a rectangle, so every pond on the map
  drew as a hard blue box — worse than the smudge it replaced. A ribbon
  describes a line. A pond is an area. Forcing one into the other is exactly
  the mistake that put rivers in the raster, with the arguments reversed, and
  "we just moved the other thing, move this too" is what made it feel
  reasonable. Areal water stays in the raster until it has an areal
  representation of its own.
- **Water claimed by one renderer and drawn by neither.** Splitting water
  between a raster and a geometry pass needs one invariant — every drop is
  drawn by exactly one of them — and the first version broke it in the
  quietest possible way. The tracer marked a component's pixels as "mine, do
  not rasterise" *before* checking whether its traced paths survived
  filtering, so any water that was claimed and then filtered out vanished from
  the map entirely. It presented as ponds disappearing, which read like a
  rendering bug and was really a bookkeeping one. When two systems divide a
  responsibility, the handover has to be the last step, not the first.
- **Translucency applied per shape instead of per union.** The soft rim that
  made rivers stop looking stuck on was drawn as two semi-transparent bands
  around each watercourse — and wherever two watercourses overlapped, which is
  every confluence on the map, the bands composited twice and left a dark
  bruise. The rule is that alpha belongs to the *union* of a thing, not to each
  piece of it, and there is no cheap way to union these polygons. So nothing in
  the water layer is translucent any more: each band is opaque and is given a
  colour worked out from the ground it will sit on (`bankTone`), which paints
  over itself without changing shade. A confluence, a crossing and a river
  running into a pond now all come out exactly the tone of a single stretch.
  Whenever soft edges are built by stacking transparencies, ask what happens
  where two of them meet.
- **Water drawn by two renderers with two palettes.** Rivers left the raster
  and got their own layer, which promptly chose its own blue and its own dark
  outline — close enough to the bake's water to look deliberate, far enough to
  look wrong, so a stream changed substance where it reached a pond. Two
  renderers is a fact about resolution and cannot be helped: a cell raster can
  hold a lake and cannot hold a five-metre brook. Two *palettes* was a choice.
  The colours now live in one place (`WATER` in `land.ts`), areal water is
  traced from the same bicubic reconstruction the bake shades with, and the
  bake stops painting water entirely on any map whose water layer is drawing
  it — because leaving half of it to each is what produced the seam in the
  first place.
- **A picture is not a survey, and things in front of a river hide it.** The
  Kuttenberg map's watercourses are read off a drawing, and the drawing has
  trees painted over them — so the colour test returned rivers with stretches
  simply missing, which became separate rivers with gaps between them. Wrong on
  the map, and worse in the simulation, where a road walks through the gap
  without crossing anything. The tempting fix is more morphological closing,
  and it is the wrong one: a radius big enough to bridge a stand of trees welds
  every parallel feature together and inflates every width. Gaps are bridged
  *selectively* instead — a single flood from every piece of water at once,
  each carrying the component it came from, so that where two floods meet is
  the shortest crossing between that pair; then shortest-first, one bridge per
  pair, at the width of the water either side. The network went from 25km in 80
  fragments to 43km, with the longest unbroken watercourse rising from 1.0km to
  3.4km and not one width changing. Verified by dumping the mask with the
  bridges coloured differently: every one sits inline along a stream, none
  wires two unrelated streams together.
- **Simplifying a shape threw away what the shape was carrying.** River
  centrelines are simplified with Douglas-Peucker, which measures how far a
  point strays from the line between its neighbours — and a watercourse running
  dead straight through a pond strays not at all. So the pond's points were
  dropped, the river came out the same width from end to end, and the pond
  vanished from a river it had just been successfully merged into. The geometry
  was perfect and the *width profile* it carried was gone. The same test now
  runs a second time over the widths. A simplifier only preserves what it is
  told to measure; anything else riding along on those points is silently lost.
- **Two renderers sharing a job, and only one of them told.** Water is drawn
  either by the ground bake or by the water layer, never both, and which one
  is decided by a single flag (`RiverNetwork.drawsOwnWater`). The bake was
  wired to it; the water layer's *body tracing* was not, so on a procedural
  world — which says no, because its water is elevation below a line and the
  bake paints that seamlessly across an endless map — the layer went ahead and
  traced anyway. It produced 463 lakes, drew every one of them on top of the
  bake's, and to do it walked a forty-thousand-unit square at load, forcing the
  generation of every terrain chunk in the world before the first frame. It
  did not look obviously wrong, which is the danger: a double-drawn lake is
  still a lake. Found by checking the procedural map after a change that only
  concerned an imported one. When a flag decides which of two systems owns
  something, every part of both has to read it, and the cheapest way to catch
  a miss is to run the path the change was not about.
- **A test that only sampled steady states could not see the bug.** The ripple
  overlay is a screen-covering quad slid through a tiling texture to keep the
  pattern still in the world. Twice it was declared correct on the strength of
  screenshots taken at one fixed zoom and then another, and twice it was
  visibly swimming the moment anyone actually zoomed. The cause was that
  `camera.worldView`, `midPoint` and the camera matrix are all computed in
  `preRender`, which runs *after* `scene.update` — so positioning the quad
  during an update used the previous frame's camera. Still camera, no error
  visible; moving camera, every frame wrong. Anything that has to be kept in
  step with the camera by hand has to be tested *while the camera is moving*,
  and the fix is better still: put the thing in world space so the camera
  transforms it through the same matrix as everything else and there is no
  hand-written correction left to be wrong.
- **Measuring the thing that was suspected instead of the thing that was
  slow.** The water layer was costing most of the frame, and the ripple overlay
  laid on top of it was the obvious suspect. Measured by alternating each layer
  on and off within one run — absolute timings in an instrumented loop proved
  worthless, but interleaved differences were stable — the overlay was 3-4ms
  and the water `Graphics` underneath it 57ms, against about 10ms for the whole
  rest of the scene. A Phaser `Graphics` re-walks its command list and
  re-triangulates every filled shape on every frame, so ninety pieces of water
  in four bands are paid for sixty times a second. Halving the ribbon vertices
  changed nothing at all, because the cost is in the number of fills and not
  their size — worth knowing before optimising the obvious thing twice.
- **Asking the most expensive question in the game from scratch, several
  times a second, to produce one answer.** By day 75 on seed 1234 a tick took
  **49ms** — three frames — and the realm was a handful of villages. It was
  not the renderer and it was not any one system: it was that four things
  which are *properties of the world* were being recomputed as though they
  were properties of the question being asked.

  `findBestShipment` weighs every source against every need, which is the
  design and is right (see "Trade is one continuous decision"). But every
  pairing asked `routeBetween` for a fresh graph search, every edge that
  search relaxed re-averaged the wear along that road's whole polyline, every
  route it returned deep-copied a few hundred points and built a
  cumulative-length table, and the world separately ran two hundred-odd
  single-source searches out of the *same* village to answer one question
  about reachability. Nothing was quadratic in an obvious place; five
  linear-looking things were multiplying.

  The fixes are all the same fix, stated four times — **measure a thing where
  it lives, once, and let everyone read it**:

  - a road's mean wear belongs to the road (`RoadEdge.wear`, stamped against
    `TrafficField.revision`), not to whoever asked the pathfinder;
  - a route between two places belongs to the network, cached for as long as
    the network has not moved — the same bargain `routeCache` had always made
    for village-to-node routes, extended to every other pair;
  - one Dijkstra out of a place answers *every* destination from it, so a
    cache row is a shortest-path tree (`RouteTree`) rather than two hundred
    unrelated answers;
  - and a route that is only being *priced* never needs its geometry at all,
    so the polyline is assembled on first demand. Pricing a trip and walking
    one are different questions; only the winner gets walked.

  Same tick, same seed, same day: **3.8ms**, and the trajectory was
  bit-identical — same population, same deposits, same roads, same holdings at
  every checkpoint. That is the tell that these were caches and not tuning.
  Two smaller ones of the same shape followed: the survey's "can anything see
  this?" was walking every road's polyline for every deposit (a bounding box
  rejects almost all of them for nothing), and the dispatcher was re-deriving
  the same list of nodes-waiting-on-materials once per candidate source.

  The general lesson, and the reason this sits in this list rather than in a
  commit message: **a design that is deliberately global is not the same thing
  as a design that must be recomputed globally.** The dispatcher should go on
  weighing everything against everything. What it was actually paying for was
  re-deriving a road network that had not changed since the last time it
  asked.
- **The one "free" optimisation in that pass that was not free, and how it
  got caught.** Decaying the traffic field is an exponential, and integrating
  an exponential in coarse steps is *exactly* the same answer as integrating
  it in fine ones — so batching the per-tick sweep onto a half-second timer
  looked like a few percent of the tick for nothing. It shipped alongside the
  caches above and it was the only one that changed the game.

  What the identity misses is that decay is not the only thing happening to a
  patch. Deliveries keep packing wear *in* between sweeps, so a longer gap
  leaves a little more of it standing — a bias well under one percent. Places
  emerge on a **threshold** of how busy a patch reads, and a permanent thumb
  on a threshold does not blur an outcome, it tips whichever junctions were
  already sitting near the line. Across six seeds at day 60: mean settlements
  **5.3 against 4.2 on the same mean population**, so the same realm spread
  across more and smaller places, and one seed grew a ghost town where the
  baseline had none in six.

  Two things worth keeping. **A per-seed diff would have called this a pass** —
  population, claims, offers, visible sectors and ghost count all matched on
  the first seed, and the settlement count looked like ordinary variance until
  it was equal-or-higher on every seed and the mean moved. This is what
  `batch.ts` is for, and it is why a performance change gets the same
  multi-seed treatment a balance change does. And **"mathematically identical"
  is a claim about one term, not about the system it sits in** — the algebra
  was right and the conclusion was still wrong, because the quantity being
  integrated was being written to by something else in between.

## Known and still open

- **A finite map runs out of frontier, and nothing says so.** Procedural
  generation always has more country: the frontier can always offer
  something, so "the offers list is empty" only ever means "not just now".
  An authored map (`pack.ts`) has a fixed number of sites, and once they are
  all claimed the list is empty *forever* — observed on the Testvale fixture
  by day 71, with Expansion Capacity climbing past 450 and nothing on earth
  to spend it on. Nothing crashes and the economy carries on, so this is a
  missing ending rather than a bug, but a civilisation quietly accruing a
  currency that can no longer buy anything is the same shape of dead end as
  a stall. Wants a real answer — an end state, a victory readout, or
  something else capacity converts into — before authored maps are the
  default way to play.
- **Goods still do not reach the smallest places, once the realm is large.**
  *Substantially improved, not closed.* Most of it was that `haulageDemand`
  priced only node-to-trader trips and was blind to the second hop the
  processing economy created — a worked good is made at a workshop and then
  has to travel again, to whoever is building with it. The reserve held back
  for carrying was therefore sized for about half the freight actually being
  moved, and the labour market kept posting people to workplaces long past the
  point where another pair of hands on the road was worth more. Pricing the
  second hop the same way (Little's law over workshop output rate and the road
  out) lifted food actually arriving by thirty percent and wealth income by
  fifty on seed 1234 at day 151, at identical population, and took the
  population-weighted food shortage from 0.25 to 0.17 across *more* places
  rather than fewer.

  What is left is a tail. Sixteen or so of thirty-odd places still sit below
  their own import line for food while the realm produces enough for twice its
  population, and they are consistently the small, remote, recently-founded
  ones. A shipment goes to whichever destination scores highest — demand times
  how good the road is — and a hamlet at the end of a track loses that contest
  to a town on a trunk road almost every time, however hungry it is. Worth
  looking at whether a place that has been passed over should accumulate a
  claim the way a full node already does (`fullSince` in `trade.ts`): the
  machinery for "being ignored is itself a reason to be served" exists, and is
  currently only applied at the supply end.

- **The small-population walking trap** (needs re-measuring). On a sparse
  seed (1234's neighbour seed 5 reproduces it), a civilisation of four can
  end up with every last
  person listed as a node worker but permanently *out* on their own
  `WorkerDeliverySystem` run, because nobody else is free to come and collect.
  Production then runs at roughly a third of what those same four people
  could manage, which supports a population of four, which is why nobody is
  free. Every part of it behaves as designed — the labour market correctly
  decides that a spread-out network needs everyone carrying — and it is
  stable rather than fatal, but it is a stall: a hundred days at population
  four with twelve connected deposits and every shortage reading zero. The
  escape a bigger civilisation uses is founding a settlement out by the
  distant deposits so the hauls get short, and that is gated on having
  people to found it with, so a poor seed cannot reach it. Worth solving,
  probably at the "how far is it worth connecting something" end rather than
  by special-casing small populations.

  *Since the walking-speed correction above, seed 5 measures 53 residents at
  day 91 rather than the four this entry describes, and the mechanism it
  names — everyone permanently out carrying — was substantially an artefact
  of that same wrong number. Re-measure before working on it; what is left
  of the trap, if anything, is a smaller thing than this entry claims.*
- ~~**A settlement can still found near real, staffed work and open at zero.**~~
  *Closed* — see the hand-off entry in the list above. `hasNearbyWorkedSite`
  now asks the hand-off's own question ("would founding here actually win that
  worker?") rather than the weaker one, which was the second of the two fixes
  this entry proposed. Kept here for the record because the diagnosis below is
  still the clearest statement of the shape of the bug.
  Even with `hasNearbyWorkedSite` requiring an actual worker nearby (see
  above), that worker's *home* might already be a different, closer
  existing seat — `crowding`'s minimum spacing (360) is smaller than
  `resourceProximity`'s range (520), so a worked site up to 160 units past
  another settlement's crowding radius can still count as "nearby" for a
  brand-new settlement while that worker has been calling the older place
  home the whole time. The hand-off in `foundSettlement` only ever runs
  once, at the moment of founding, so a settlement that opens without
  catching anyone stays empty until ordinary hiring or migration happens to
  reach it — which, being driven by the same civilisation-wide population
  numbers this document keeps returning to, can take a long time or never
  quite arrive. Observed directly: a settlement still at zero population
  thirty-six days after founding, next to a site that had a worker the
  entire time. Worth solving by either shrinking the gap between the two
  radii, or by making `hasNearbyWorkedSite` check that the worker's current
  home is actually *farther* from the candidate position than the candidate
  itself would be — i.e., that founding here would actually win the
  hand-off, not just that a worker happens to exist somewhere in range.

## Explicitly not in scope (for now)

Combat, quests, tech trees, direct player-to-villager control, buildings the
player places, multiplayer. Anything on this list is a candidate for later,
once the systems above are solid enough that adding it wouldn't just be
another compensating subsystem for something already shaky.

(Procedural map generation used to head this list. It shipped — see
`worldgen.ts` and the "what has actually shipped" section above — and the
line was left here long enough to start misleading. Take a list like this
off the shelf when the work lands.)
