import { shortage, targetStock, WORKING_RESERVE, type Trader } from './economy';
import { hasRoomToBuild, housingCapacity } from './housing';
import type { Industry } from './industry';
import { ResourceType } from './types';

/**
 * What a place has actually built, and what it costs to keep standing.
 *
 * This is where the processed economy finally *ends up*. Before this module
 * existed, planks, blocks and tools were consumed by a flat per-capita
 * appetite — people simply ate them, the same way they ate grain — and the
 * only thing that came of running an industry was a wealth number that fed a
 * development score that nothing else in the world could feel. A pillar of
 * the design ("processing industries exist because there's demand for the
 * refined good") was technically present and, in practice, decorative.
 *
 * The fix is not another subsystem on top of the industries. It is to give
 * the goods somewhere to *go*: a place's houses and its workshops are a
 * single accumulated stock — its **fabric** — bought with real material
 * carried down real roads, and everything a place is read off that stock.
 * How many people it can house, how many hands its sawmill can host, what
 * tier it wears: all of it is now "what did these villagers actually
 * build", not a number that accrued for being comfortable.
 *
 * Three properties make this safe, and each of them is a lesson this project
 * already paid for:
 *
 * - **It spends surplus, never seed corn.** Raw wood and stone are drawn only
 *   above the same working reserve an industry respects (`WORKING_RESERVE`).
 *   Housing drawing wood was tried twice before and reverted twice, both
 *   times because it competed head-on with ordinary demand and tipped the
 *   timber economy into a starvation spiral. A claim that can only ever eat
 *   genuine surplus cannot do that: at worst it builds nothing.
 * - **Worked goods are strictly better, and are what the chain is for.**
 *   Two wood make a plank and a plank is worth three wood of building; two
 *   stone make a block worth 3.6. So milling multiplies a forest's worth by
 *   half again — in houses built, in trees *not* hauled, and in the hands
 *   that would otherwise have been out carrying them. That is the reward for
 *   building in planks rather than logs, and it is paid in the currency this
 *   game actually cares about: labour and road traffic.
 * - **It is not a one-way ratchet.** Fabric decays. A town of eighty needs a
 *   steady trickle of material simply to stand still, which is what keeps
 *   the processed economy a permanent market rather than a phase a realm
 *   passes through — and what stops a place coasting forever on what it
 *   built during one good decade. Decay is slower the better the material,
 *   which is the second half of the same reward.
 */

/** One thing a place can build out of, best first. */
export interface Material {
  resource: ResourceType;
  /** Fabric one unit lays down. */
  yield: number;
  /**
   * How finished this material is, 0 (rough) to 1 (fine). Decides how grand
   * the standing fabric reads and how slowly it decays — see `fabricQuality`.
   */
  grade: number;
  /**
   * Whether somebody else has a claim on this. Wood and stone are also fuel,
   * industry feedstock and node investment, so building may only take what is
   * genuinely spare; the worked goods exist for nothing *but* building, so a
   * place spends them down to the last one.
   *
   * Planks and tools are worked goods that are *also* a joinery's feedstock,
   * and they are deliberately still unreserved here. Building is the terminal
   * sink and should win: a joinery then runs exactly where planks and tools
   * arrive faster than the place can put them up, which is a timber town with
   * ore reaching it — and that is the right place for one.
   */
  reserved: boolean;
}

export const MATERIALS: readonly Material[] = [
  { resource: ResourceType.Fittings, yield: 10, grade: 1, reserved: false },
  { resource: ResourceType.StoneBlocks, yield: 3.6, grade: 0.6, reserved: false },
  { resource: ResourceType.Planks, yield: 3, grade: 0.6, reserved: false },
  { resource: ResourceType.Stone, yield: 1.2, grade: 0, reserved: true },
  { resource: ResourceType.Wood, yield: 1, grade: 0, reserved: true },
];

/**
 * Fabric one resident can lay down per minute, at full effort.
 *
 * A ceiling, not a rate: in practice construction is limited by what material
 * is actually spare, which is the whole point. This only says that a hamlet
 * of three cannot throw up a town in an afternoon if a caravan happens to
 * arrive, and that a big place builds faster than a small one because there
 * are more hands in it. Deliberately *not* a labour-market claim — nobody is
 * hired as a mason, and the workforce is never told — because every stall
 * this simulation has produced came from adding another claimant to the same
 * small pool of people.
 */
const BUILD_PER_CAPITA_PER_MIN = 0.6;

/**
 * How much fabric a place keeps for free — the huts and sheds people put up
 * out of what is lying about, which need no supply line and cannot be lost.
 *
 * Without a floor, decay is a death spiral waiting for a bad week: fabric
 * falls, housing falls, population falls, production falls, less material
 * arrives, fabric falls further. With one, the bottom of the ladder is
 * exactly as forgiving as it is today — a small place with no trade to speak
 * of simply sits at its free level indefinitely — and everything above it is
 * the part that has to be earned and kept.
 */
const FREE_FABRIC = 8;

/**
 * In-game hours for the standing stock to decay by most of the way, if
 * nothing is ever done to it and it was all built out of rough material.
 * Roughly forty days, doubled for a place built in dressed stone and sawn
 * plank — which is the difference between needing a shipment every week and
 * needing one every fortnight.
 */
const UPKEEP_TAU = 900;

/** Tools consumed per point of fabric laid, and how much faster they make the work. */
const TOOLS_PER_FABRIC = 0.03;
const TOOLS_SPEEDUP = 0.5;

/** Fabric one worker's place at an industry costs to build. */
export const WORKS_PER_SLOT = 12;

/**
 * The most any *one* workshop can hold — and the one limit here that is a
 * deliberate structural statement rather than a consequence.
 *
 * It says a mill only gets so big, and that a realm which wants more planks
 * than one mill can cut has to have somewhere *else* worth putting one. That
 * is the behaviour to want: measured on seed 1234 at day 151, twenty-five of
 * thirty-three places were running industries of their own rather than one
 * capital doing all the milling for everybody. Without a cap the first place
 * to get a timber surplus would simply absorb every plank in the realm's
 * future, since nothing else competes for that material once its own houses
 * are up.
 *
 * Keyed to the workshop rather than to its owner's population on purpose.
 * Population-keyed capacity is the thing this system replaced, and its
 * failure mode is worth not re-inventing: it made industry *less* likely the
 * better the game went, because a prospering realm founds settlements and
 * every settlement divides the population further.
 */
export const MAX_WORKS_SLOTS = 4;

/**
 * How strongly a place's own crowding argues for more housing, against the
 * realm's hunger for a worked good arguing for more workshop. Both land in
 * the same 0-1-ish range so they can simply be compared.
 */
const CROWDING_WANT = 1.1;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** How much of a material is genuinely available to build with right now. */
export function availableMaterial(trader: Trader, material: Material): number {
  const stock = trader.storage[material.resource];
  if (!material.reserved) return Math.max(0, stock);
  return Math.max(0, stock - targetStock(trader, material.resource) * WORKING_RESERVE);
}

/** Everything on hand, in fabric — what the place could lay down today if it had the hands. */
export function materialOnHand(trader: Trader): number {
  let total = 0;
  for (const material of MATERIALS) total += availableMaterial(trader, material) * material.yield;
  return total;
}

/**
 * How badly this place wants more room to live in: a straight reading of how
 * full its houses are, and nothing at all if it has no ground left to put
 * them on. Land is what makes the rural/urban split real (see `housing.ts`
 * and `landUse.ts`), and it has to hold here too, or a hemmed-in village
 * could simply build its way past the valley it sits in.
 */
function dwellingWant(trader: Trader): number {
  if (trader.population <= 0) return 0;
  if (!hasRoomToBuild(trader)) return 0;
  const occupancy = trader.population / housingCapacity(trader);
  return CROWDING_WANT * clamp01((occupancy - CROWDING_STARTS) / (1 - CROWDING_STARTS));
}

/**
 * How full a place has to be before *more* room is worth building. Only
 * expansion consults this: keeping the roofs on what already stands is a
 * first charge on a place's effort and asks no such question (see
 * `advanceConstruction`).
 *
 * Those two were briefly the same question, and it went wrong in both
 * directions inside one afternoon. At 0.55 a comfortably-under-half-occupied
 * capital simply let its roofs fall in — a hundred and twenty-five places for
 * fifty-eight residents, losing four fabric a day with a hundred and
 * twenty-five fabric of material on its own shelves. Dropping the bar to 0.35
 * to fix that made the same capital build until it had two hundred and
 * fifty-seven places for ninety people, swallowing every scrap of material in
 * the realm: it never built a masonry or a smithy at all, and the number of
 * deposits the civilisation managed to connect *fell from twenty to eight*.
 *
 * Which is the general shape: when one threshold is answering two questions,
 * moving it trades one failure for the other, and the fix is two rules rather
 * than a better number.
 */
const CROWDING_STARTS = 0.55;

/**
 * How badly the realm wants another pair of hands at this workshop, expressed
 * as a reason to *build* one rather than to staff one.
 *
 * This is the whole answer to "why is there a sawmill here". Not a tier, not
 * an unlock, not a per-place headcount table: a place builds a sawmill when
 * the realm is short of planks and this particular place is sitting on timber
 * it does not need. Both halves are required, and they are the two halves of
 * supply and demand — a wood-rich hamlet with nobody wanting planks builds
 * nothing, and neither does a plank-starved town with no timber to work.
 *
 * The realm's shortage rather than this place's own, deliberately: a timber
 * hamlet has almost no appetite for planks of its own, and it is exactly
 * where the mill belongs. Trade's job is to carry them to whoever asked.
 *
 * The scarcest input decides, which is what gives a two-input recipe its
 * teeth: a smithy asks for ore *and* fuel, and a joinery for sawn plank *and*
 * finished tools, so neither will be built anywhere that only one of the two
 * chains reaches. That is the whole mechanism behind places specialising
 * rather than each quietly becoming a copy of every other.
 */
function worksWant(industry: Industry, demand: RealmDemand): number {
  if (industry.built >= MAX_WORKS_SLOTS * WORKS_PER_SLOT) return 0;
  let inputSpare = 1;
  for (const { resource, per } of industry.recipe.inputs) {
    inputSpare = Math.min(inputSpare, clamp01(availableMaterialFor(industry.owner, resource) / (per * 4)));
  }
  if (inputSpare <= 0) return 0;
  return (demand[industry.resource] ?? 0) * inputSpare;
}

/**
 * How short the realm as a whole is of a good, weighted by where the people
 * are — not how short the single worst-off place is.
 *
 * The labour market deliberately asks the worst-case question, because a
 * famine anywhere is an emergency everywhere and one hungry place should be
 * able to pull a hand off any job in the realm. Deciding where to *build a
 * workshop* is the opposite kind of question, and asking it the worst-case
 * way produced exactly the pathology you would predict: one three-person
 * hamlet founded last week with no tools on its shelf pinned "the realm wants
 * tools" at 1.00, permanently, and every place in the civilisation therefore
 * wanted a smithy. Measured on seed 1234 at day 91, eleven of fourteen places
 * had built one, several of them villages of six sitting on fifteen tools
 * apiece with nobody to sell them to.
 *
 * This is the saturation trap this codebase has hit twice before — once in
 * `MigrationSystem`'s opportunity score, once in `development.ts`'s provision
 * term — and it has the same fix both times: ask about the distribution, not
 * its worst tail. Weighted by population because a city going short of planks
 * is a bigger fact about the realm than a hamlet doing the same.
 */
export type RealmDemand = Partial<Record<ResourceType, number>>;

/** The goods somebody might build a workshop to make — the only ones `realmDemand` has to price. */
const WORKED_GOODS: readonly ResourceType[] = [
  ResourceType.Planks,
  ResourceType.StoneBlocks,
  ResourceType.Tools,
  ResourceType.Fittings,
  ResourceType.Bread,
];

/**
 * Asked once a tick for the whole realm rather than once per workshop.
 * Every place weighs every other place's shortage, so asking it inside
 * `worksWant` is quadratic in settlements times three industries — cheap at
 * five places and not at forty, which is exactly the size a realm reaches
 * when this system is working. Only the worked goods, because they are the
 * only things anybody decides to build a workshop for.
 */
export function realmDemand(traders: readonly Trader[]): RealmDemand {
  const out: RealmDemand = {};
  let weight = 0;
  for (const trader of traders) weight += 1 + trader.population;
  if (weight <= 0) return out;

  for (const resource of WORKED_GOODS) {
    let short = 0;
    for (const trader of traders) short += (1 + trader.population) * shortage(trader, resource);
    out[resource] = short / weight;
  }
  return out;
}

/** Raw input genuinely spare at a place — the same line construction and industry both respect. */
function availableMaterialFor(trader: Trader, resource: ResourceType): number {
  return Math.max(0, trader.storage[resource] - targetStock(trader, resource) * WORKING_RESERVE);
}

/**
 * How many hands a workshop can host, read straight off what has been built
 * into it.
 *
 * Rounded rather than floored, because fabric decays: floored, a full mill
 * losing a tenth of a point overnight would shed a whole man's place until it
 * was topped back up, and the labour market would spend its time evicting and
 * rehiring the same sawyer. Rounding puts the boundary half a slot away from
 * wherever maintenance holds the number, which is where a boundary in a
 * decaying quantity belongs.
 */
export function builtSlots(built: number): number {
  return Math.min(MAX_WORKS_SLOTS, Math.round(built / WORKS_PER_SLOT));
}

/**
 * A place spends a tick of its people's effort and its spare material on
 * whichever single thing it most needs: more room to live in, or more room to
 * work in. One decision, so the two can never quietly bid against each other
 * and stall — and so what a place is building is always a readable fact about
 * it rather than a spread across five ledgers.
 */
export function advanceConstruction(trader: Trader, demand: RealmDemand, dt: number): void {
  const before = trader.dwellings + totalWorks(trader);
  const upkeep = decay(trader, dt);

  const perHour = (BUILD_PER_CAPITA_PER_MIN / 60) * trader.population;
  let effort = perHour * dt * toolBoost(trader);

  // Upkeep first, always, and before anything new is begun. Nobody raises a
  // second barn while the first one's roof is open, and — mechanically — a
  // place whose expansion trigger is also its repair trigger has to choose
  // between letting half-empty towns rot and letting every town build three
  // times the housing it needs. Neither is a tuning problem; they are the two
  // halves of one conflated rule.
  if (upkeep > 0 && effort > 0 && trader.population > 0) {
    const mended = spend(trader, Math.min(upkeep, effort));
    if (mended > 0) {
      restore(trader, mended);
      effort -= mended;
    }
  }

  let best: { want: number; build: (amount: number) => void } | null = null;
  const consider = (want: number, build: (amount: number) => void): void => {
    if (want > 0 && (best === null || want > best.want)) best = { want, build };
  };

  consider(dwellingWant(trader), (amount) => {
    trader.dwellings += amount;
  });
  for (const industry of trader.industries) {
    consider(worksWant(industry, demand), (amount) => {
      industry.built += amount;
    });
  }

  if (effort > 0 && best !== null) {
    const project = best as { want: number; build: (amount: number) => void };
    const laid = spend(trader, effort);
    if (laid > 0) project.build(laid);
  }

  // How much building this place actually has in front of it, which is what
  // decides how much material it wants delivered (see `economy.ts`'s
  // `demandPerMin`). Never below what simply holding the place up costs: a
  // finished town still needs a steady trickle to keep its roofs on, and a
  // finished town that stopped asking for one would quietly fall down while
  // reading as comfortable.
  const project = (best as { want: number } | null)?.want ?? 0;
  const maintenance = perHour > 0 && dt > 0 ? upkeep / dt / perHour : 0;
  trader.buildAppetite = clamp01(Math.max(project, maintenance));

  trader.fabricRate = dt > 0 ? (trader.dwellings + totalWorks(trader) - before) / dt : 0;
}

export function totalWorks(trader: Trader): number {
  let total = 0;
  for (const industry of trader.industries) total += industry.built;
  return total;
}

/**
 * Everything a place is holding up, less what it gets for free. Upkeep is
 * charged against the whole of it — houses and workshops alike — because a
 * roof is a roof, and because a place that lets its mill fall in should lose
 * the mill, not merely stop expanding it.
 */
function decay(trader: Trader, dt: number): number {
  const tau = UPKEEP_TAU * (1 + trader.fabricQuality);
  const standing = trader.dwellings + totalWorks(trader);
  const perishable = Math.max(0, standing - FREE_FABRIC);
  if (perishable <= 0) return 0;

  const lost = Math.min(perishable, (perishable / tau) * dt);
  // Shared out in proportion, so nothing is favoured and the free allowance
  // protects whatever the place happens to have rather than one ledger of it.
  const share = lost / standing;
  trader.dwellings -= trader.dwellings * share;
  for (const industry of trader.industries) industry.built -= industry.built * share;
  return lost;
}

/** Put back what the weather took, in the proportions it took it. */
function restore(trader: Trader, mended: number): void {
  const standing = trader.dwellings + totalWorks(trader);
  if (standing <= 0) {
    trader.dwellings += mended;
    return;
  }
  const share = mended / standing;
  trader.dwellings += trader.dwellings * share;
  for (const industry of trader.industries) industry.built += industry.built * share;
}

/**
 * Tools do not go into a wall; they make the work go faster. That is the one
 * job a smithy's output has never had — before this, tools were made, shipped,
 * and then eaten by nothing in particular — and it is why a realm with iron
 * genuinely outbuilds one without, rather than merely reading a larger number
 * on a wealth panel.
 */
function toolBoost(trader: Trader): number {
  const target = targetStock(trader, ResourceType.Tools);
  if (target <= 0) return 1;
  return 1 + TOOLS_SPEEDUP * clamp01(trader.storage[ResourceType.Tools] / (target * WORKING_RESERVE));
}

/**
 * Draw up to `want` fabric's worth of material off the shelf, best first, and
 * remember what it was built out of. Returns the fabric actually laid — which
 * is zero, and harmlessly so, at a place with nothing spare.
 */
function spend(trader: Trader, want: number): number {
  let remaining = want;
  let laid = 0;
  let graded = 0;

  for (const material of MATERIALS) {
    if (remaining <= 0) break;
    const available = availableMaterial(trader, material);
    if (available <= 0) continue;
    const units = Math.min(available, remaining / material.yield);
    trader.storage[material.resource] -= units;
    const fabric = units * material.yield;
    laid += fabric;
    graded += fabric * material.grade;
    remaining -= fabric;
  }

  if (laid <= 0) return 0;

  trader.storage[ResourceType.Tools] = Math.max(0, trader.storage[ResourceType.Tools] - laid * TOOLS_PER_FABRIC);

  // The composition of the *standing* stock, not of this tick's work: a town
  // that rebuilt half of itself in stone is half a stone town, and grows more
  // durable as the rest follows. Weighted by fabric, so a single plank landing
  // at a log-built village barely moves it.
  const standing = trader.dwellings + totalWorks(trader);
  trader.fabricQuality += (graded / laid - trader.fabricQuality) * (laid / (standing + laid));

  return laid;
}
