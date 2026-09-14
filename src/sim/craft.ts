import type { ResourceType } from './types';
import type { Villager } from './villager';

/**
 * The trade a person has taken up, and how far into it they are.
 *
 * Before this, a villager was a body. The labour market picked whichever
 * opening the civilisation was shortest on, posted whoever happened to be
 * nearest, and would take that same person back out again the moment some
 * other good's shortage crept a fraction ahead. Nothing anywhere in the
 * simulation knew the difference between a woodcutter of thirty years and a
 * man who was hoeing turnips this morning, so nothing had any reason not to
 * swap them — and the only brake on churn was `REASSIGN_MARGIN`, one flat
 * number that had to be small enough to let a genuinely urgent shortage win
 * and large enough to stop two openings trading the same pair of hands
 * forever. It cannot be both, and a medieval economy in which everyone
 * retrains weekly is not one anybody would recognise.
 *
 * A craft fixes that at the level the problem actually lives at: people, not
 * thresholds. Three rules, and they are all the same rule seen from
 * different sides —
 *
 * - **Working a trade makes you better at it.** Skill is worth real output
 *   (see `crewSkill`), so a settled crew genuinely outproduces a shuffled
 *   one. This is the reward for leaving people alone.
 * - **Changing trade throws most of that away.** Not all — a man who has
 *   swung an axe can swing a pick — but enough that it is a real loss, borne
 *   by the civilisation rather than paid out of a balance sheet.
 * - **So the labour market has to want it more, the deeper in someone is**
 *   (see `systems.ts`'s reassignment margin). A green hand is cheap to move
 *   and a master is very dear, which is exactly the gradient that makes a
 *   civilisation settle into specialists without anyone deciding it should.
 *
 * Deliberately keyed on the *good*, not the workplace: a woodcutter who moves
 * from one forest to the next is still a woodcutter, and a sawyer who is
 * pulled from a mill and sent to another place's mill loses nothing. What
 * costs is genuinely changing what you do for a living.
 */

/** In-game hours of working a trade to go from raw hand to master of it. */
const MASTERY_HOURS = 2200;

/**
 * How much of a lifetime's skill survives taking up a different trade. Low
 * enough to be a genuine cost, not so low that a necessary reassignment is
 * ruinous — and it is the same number whether the move is a promotion or a
 * famine.
 */
const CRAFT_SWITCH_KEEP = 0.2;

/** In-game hours for an unpractised skill to fade by most of the way. */
const IDLE_DECAY_TAU = 9000;

/**
 * How much more a master produces than a raw hand. Bounded, and bounded
 * tightly: this is a *positive feedback* on a crew that is already staffed
 * (skill → output → less shortage → less reason to move anyone → more skill),
 * and this project has been burned before by loops whose ceiling was somebody
 * else's variable. A flat 35% never compounds into anything.
 */
const MASTERY_BONUS = 0.35;

/** How much of one villager's working life has gone into their present trade, 0 to 1. */
export function skillOf(villager: Villager): number {
  return villager.experience;
}

/**
 * The output multiplier for a crew, from the average of what its people
 * actually know. An average rather than a sum, so hiring a second, greener
 * hand never *lowers* a site's output — that would be an oscillation, and a
 * nasty one, since the labour market would then be rewarded for unstaffing
 * things.
 */
export function crewSkill(workers: readonly Villager[]): number {
  if (workers.length === 0) return 1;
  let total = 0;
  for (const worker of workers) total += worker.experience;
  return 1 + MASTERY_BONUS * (total / workers.length);
}

/**
 * Take up a trade. Returning to one you already follow costs nothing at all,
 * which is what makes a worker moving between two forests — or being sent
 * home and rehired — free, while genuinely changing trade is not.
 */
export function takeUpCraft(villager: Villager, resource: ResourceType): void {
  if (villager.craft === resource) return;
  villager.experience *= CRAFT_SWITCH_KEEP;
  villager.craft = resource;
}

/** A working hour at one's own trade. */
export function practise(villager: Villager, dt: number): void {
  villager.experience = Math.min(1, villager.experience + dt / MASTERY_HOURS);
}

/** Hands out of the trade — idling, or out on the road — lose their edge slowly. */
export function forget(villager: Villager, dt: number): void {
  villager.experience *= Math.exp(-dt / IDLE_DECAY_TAU);
}

/**
 * How much the civilisation would be throwing away by moving this person to
 * a different trade, in the same units `sitePriority` is measured in. This is
 * what the reassignment margin is scaled by — see `systems.ts`.
 */
export function commitmentOf(villager: Villager, resource: ResourceType): number {
  return villager.craft === resource ? 0 : villager.experience;
}
