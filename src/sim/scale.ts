/**
 * What a world unit and an in-game hour actually mean.
 *
 * For a long time nothing in this project said. Distances were tuned by feel
 * against each other, which works right up until something outside the game
 * has an opinion — an imported map of a real place, say, which knows exactly
 * how far it is from Kutná Hora to the nearest wood. At that point every
 * unstated assumption has to be stated, and it turns out they very nearly all
 * agreed already:
 *
 *   MIN_NODE_DISTANCE      165u   660m   two works in one parish
 *   CLAIM_RADIUS           380u   1.5km  the land a claimed site holds
 *   TIER_FOOTPRINT hamlet  430u   1.7km  a village and its fields
 *   STARTING_RESOURCE_REACH 850u  3.4km  the outlying wood
 *   deposit spacing       1300u   5.2km  the next village over
 *   the procedural world 40000u   160km  a principality
 *
 * Every one of those lands somewhere a medieval geographer would recognise at
 * four metres to the unit, and none of them was chosen with metres in mind.
 * So this is not a new scale imposed on the game — it is the scale the game
 * already had, written down so the next number can be checked against it.
 */

/** The scale everything in the simulation is implicitly built at. */
export const METRES_PER_UNIT = 4;

/**
 * Real metres one unit of `elevation` stands for — the vertical companion to
 * `METRES_PER_UNIT`, and stated here for exactly the same reason.
 *
 * It was already decided, just not written down. `tools/importmap.ts` maps a
 * region's measured relief onto the elevation band at 500 metres across the
 * land range (-0.3 to 1.0), which is 385 metres to the unit; the renderer
 * separately picked a vertical exaggeration of 520 out of the air to make
 * hillshading look right. Two vertical scales, neither aware of the other,
 * one of them not a scale at all. That is the same shape of mistake as
 * `WALK_SPEED` sitting four and a half times wrong for the life of the
 * project, and it is caught the same way: write the number down so the next
 * thing that needs it has something to check against.
 *
 * Worth knowing what it implies, because it is not flattering and it is not
 * wrong. Elevation spans -1 to 1, so the whole procedural world is 770 metres
 * from its deepest water to its highest peak — and `MOUNTAIN_LEVEL` sits about
 * 320 metres above the valley floor. That is a substantial hill, not a
 * mountain. The band names are what a road makes of the ground, not
 * altitudes; `importmap.ts` has said so for a while, and now the arithmetic
 * says so too. If genuine alpine country is ever wanted, this is the number
 * to raise.
 */
export const METRES_PER_ELEVATION = 385;

/** In-game hours in a day. The simulation runs one in-game hour per real second. */
export const HOURS_PER_DAY = 24;

/**
 * How far someone carrying goods gets in a day — a day's journey, the unit
 * medieval travel was actually reckoned in.
 *
 * Expressed per *day* rather than per hour on purpose, because the simulation
 * never stops: a villager here walks through the night, and a real one did
 * not. An instantaneous pace of 4km/h is the right figure for a person and
 * the wrong figure for this model, which would have them covering ninety-six
 * kilometres between dawns. A day's journey already has the resting in it.
 *
 * 35km is the low end of what is usually quoted for a day on foot, which is
 * the right end for someone under a load on medieval roads. Production is
 * reckoned the same continuous way — a woodcutter here also works all night —
 * so the two are consistent.
 */
export const DAYS_JOURNEY_METRES = 35_000;

/**
 * Real seconds one in-game hour takes at 1× speed — the one place the wall
 * clock meets the simulation clock.
 *
 * For the life of the project this was 1, implicitly: `World.update` was fed
 * the real frame delta and treated it as hours. That was survivable while
 * distances were tuned by feel, and stopped being survivable the moment
 * `WALK_SPEED` was corrected to a real day's journey (see `villager.ts`).
 * A villager now covers 365 units an hour, so at one hour per second they
 * crossed the whole of Kutná Hora's basin in a few seconds — the simulation
 * was correct and completely unreadable.
 *
 * The fix is not to slow walking down again. Walking is right; the projector
 * was running fast. Everything in the simulation is reckoned per in-game
 * hour — production, consumption, wear, migration — so stretching the hour
 * slows all of it together and changes no balance at all. The speed buttons
 * then mean what they say: 10× puts the game back at the pace it used to run.
 *
 * Ten is a readability figure, not a physical one. At a working zoom a
 * villager crosses the view in about a minute, which is the pace a person
 * walking reads as. Making it literal — 4km/h against a 160km principality —
 * would leave them visibly motionless. This is the number to turn if the
 * game ever feels hurried or sluggish; nothing else needs to move with it.
 */
export const REAL_SECONDS_PER_HOUR = 10;
