# Via Lucrum — Vision

This is the north star for the simulation. Code changes, tuning passes, and
new systems should be judged against this document, not against whatever the
most recent bug report happened to say. It is a living document — amend it
deliberately when the vision itself changes, not silently as a side effect of
a bug fix.

## Core premise

The player draws roads. Nothing else is placed by hand — no build menu, no
unit orders, no direct control over any villager. Everything else — where
people live, what they produce, what they carry, whether a hut by the road
becomes a market town — is the *consequence* of the road network the player
drew, the terrain it crosses, and the economy that grows on top of it.

The player's entire vocabulary is: draw a road, erase a road. Every feature
this game ever gets has to either sit upstream of that verb (something that
changes what a road is worth drawing) or downstream of it (something that
makes the consequences of a drawn network legible and interesting to watch).

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

1. **The player only draws roads.** If a feature requires a new player verb,
   look harder for a way to make it an emergent consequence of the road
   network first.
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

## What has actually shipped (as of this writing)

This section is a snapshot, not a spec — read the code and `README.md` for
ground truth on any given day, and update this list when it drifts too far.

- **Road network**: freehand drawing, splines, junctions, wear-based road
  quality that lives in the *ground* rather than on the road object,
  terrain-priced routing, abandonment of unused stretches.
- **Population**: one shared, mobile pool of villagers (not owned per-place);
  home is wherever someone actually settled, decided by where they work, not
  where they were born; dependents vs. working-age split at birth.
- **Labor market**: one unified priority-based dispatcher for every resource
  node and every industry, weighing worst civilization-wide shortage,
  scaled hard toward food during a genuine famine, with a scaled-back
  logistics reserve so transport doesn't collapse under a hiring burst.
- **Trade/transport**: one continuously-weighed "what's the single best
  shipment right now" decision across node production, trader surplus, and
  node investment, discounted (not hard-gated) by whether something's
  actually needed.
- **Resource nodes**: level up two independent ways — worked enough
  (lifetime collected) and invested-in enough (a shipped-in resource) —
  taking the lower of the two, so a node can stall on logistics even while
  it's being worked hard.
- **Industries** (Sawmill, Masonry, Smithy): convert raw goods to processed
  ones, staffed only once a place has real spare population, inert until
  there's genuine demand for their output. Worker capacity scales with the
  owner's own current population, not its tier — tier is itself downstream
  of an industry's wealth, so keying capacity to tier let the two feed each
  other into a small population running an oversized industry.
- **Wealth & development**: wealth earned from industry output and genuine
  exports (never from raw production landing at a trader); tier is a
  function of population *and* wealth-per-capita comfort, so a wealthy ghost
  town and a crowded but unproductive place both fail to develop — and,
  separately from the development *score*, a place's population has to
  directly clear each tier's own bar too, so a tiny population propped up by
  legacy wealth can't wear a city-sized label its headcount doesn't support.
- **Housing**: a population cap per place that grows on its own — via
  accumulated "under pressure" time, not a resource draw — when a place is
  genuinely crowded, and stops once relieved.
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

## Failure modes we've already been burned by

These aren't hypothetical — every one of these has actually happened during
development, been diagnosed, and been fixed (or is being actively managed).
Keep this list current; it's the sharpest tool for catching a regression
before a player does.

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
- **Fixing an accounting drift by touching production is worse than the
  drift.** The population/dependent split (`WORKING_POPULATION_SHARE`) is
  meant to hold near 30/70 as population rises and falls, but the removal
  side of a shrink event can only safely take whoever's actually idle — and
  since a dependent can never be anything else, they're almost always the
  only one idle, so repeated shrink-then-regrow cycles (population's normal
  state) drove the dependent share toward zero over a long run. The
  tempting direct fix — forcibly vacate a *working* non-dependent's post
  instead, when the ratio calls for it — was tried and immediately produced
  a real death spiral: pulling a farm worker to fix a bookkeeping ratio cut
  food throughput, which shrank the population target further, which pulled
  another worker. A ratio, however wrong, was never worth risking the
  production population actually depends on. Fixed by leaving removal alone
  (still takes whoever's free) and instead banking the imbalance as a debt
  that leans the next several *births* the other way (`world.ts`'s
  `dependentDebt`) — corrects the same drift, but only ever through people
  who don't exist yet, never by touching someone already at work.
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

## Explicitly not in scope (for now)

Procedural map generation (the hand-placed map is a stand-in), combat,
quests, tech trees, direct player-to-villager control, buildings the player
places, multiplayer. Anything on this list is a candidate for later, once the
systems above are solid enough that adding it wouldn't just be another
compensating subsystem for something already shaky.
