import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRolls, bossHp, tierForHp, HP_BASE, HP_RANGE,
  achievementRarity, RALLY_EPIC, RALLY_LEGENDARY, tacticRarity,
  TACTIC_RALLY_UNCOMMON, TACTIC_RALLY_RARE, TACTIC_RALLY_EPIC, TACTIC_RALLY_LEGENDARY,
  slotsUsed, bagsFull, bagSize, TEAM_ACTION_BUDGET, MIN_BAG_SLOTS, tacticDamage, TACTIC_DAMAGE,
  validateThreatBallot, tallyThreat, nextBossByThreat, THREAT_PER_PLAYER,
  isValidCombo,
} from "../shared/rules.js";

// A dice stub that returns the given rolls in order.
function dice(...values) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("ran out of scripted rolls");
    return values[i++];
  };
}

/* ---------------- Roll resolution ---------------- */

test("Need beats Greed: only Needers roll", () => {
  const { rolls, winner, context } = resolveRolls(
    [{ memberId: "a", choice: "greed" }, { memberId: "b", choice: "need" }, { memberId: "c", choice: "need" }],
    dice(40, 70),
  );
  assert.equal(context, "Need");
  assert.equal(winner.memberId, "c");
  assert.equal(rolls.find((r) => r.memberId === "a").roll, null);
});

test("Greeders roll when nobody Needs", () => {
  const { winner, context } = resolveRolls(
    [{ memberId: "a", choice: "greed" }, { memberId: "b", choice: "pass" }],
    dice(12),
  );
  assert.equal(context, "Greed");
  assert.equal(winner.memberId, "a");
});

test("everyone passing leaves the item unclaimed", () => {
  const { winner, context } = resolveRolls(
    [{ memberId: "a", choice: "pass" }, { memberId: "b", choice: "pass" }],
    dice(),
  );
  assert.equal(winner, null);
  assert.equal(context, "");
});

test("a tie re-rolls only the tied players", () => {
  // a and b tie on 90, c is out on 10; a and b re-roll 20 vs 60, so b wins
  const { rolls, winner } = resolveRolls(
    [{ memberId: "a", choice: "need" }, { memberId: "b", choice: "need" }, { memberId: "c", choice: "need" }],
    dice(90, 90, 10, 20, 60),
  );
  assert.equal(winner.memberId, "b");
  assert.equal(rolls.find((r) => r.memberId === "c").roll, 10, "c keeps its losing roll");
});

test("repeated ties keep re-rolling until broken", () => {
  const { winner } = resolveRolls(
    [{ memberId: "a", choice: "need" }, { memberId: "b", choice: "need" }],
    dice(50, 50, 33, 33, 8, 9),
  );
  assert.equal(winner.memberId, "b");
});

/* ---------------- HP and damage ---------------- */

test("boss HP slides with threat: top topic is base + range", () => {
  assert.equal(bossHp(9, 9), HP_BASE + HP_RANGE);
  assert.equal(bossHp(9, 9), 500);
});

test("boss HP rounds the proportional share", () => {
  assert.equal(bossHp(1, 3), Math.round(60 + 440 / 3)); // 207
  assert.equal(bossHp(2, 3), Math.round(60 + 880 / 3)); // 353
});

test("no threat (or nobody voted) gives base HP", () => {
  assert.equal(bossHp(0, 5), HP_BASE);
  assert.equal(bossHp(0, 0), HP_BASE);
  assert.equal(bossHp(3, 0), HP_BASE);
});

test("tier bands come from HP", () => {
  assert.equal(tierForHp(60).label, "Normal");
  assert.equal(tierForHp(199).label, "Normal");
  assert.equal(tierForHp(200).label, "Elite");
  assert.equal(tierForHp(379).label, "Elite");
  assert.equal(tierForHp(380).label, "Raid Boss");
  assert.equal(tierForHp(500).label, "Raid Boss");
});

test("only owned tactics deal damage, scaled by rarity", () => {
  assert.equal(tacticDamage("rare", true), TACTIC_DAMAGE.rare);
  assert.equal(tacticDamage("legendary", false), 0);
});

/* ---------------- Achievement rarity ---------------- */

test("achievements start at Rare", () => {
  assert.equal(achievementRarity(0, 5), "rare");
});

test("Epic at the epic threshold, Legendary at the legendary threshold", () => {
  assert.equal(RALLY_EPIC, 0.4);
  assert.equal(RALLY_LEGENDARY, 0.75);
  assert.equal(achievementRarity(1, 5), "rare");      // 20%
  assert.equal(achievementRarity(2, 5), "epic");      // 40% exactly
  assert.equal(achievementRarity(3, 5), "epic");      // 60%
  assert.equal(achievementRarity(3, 4), "legendary"); // 75% exactly
  assert.equal(achievementRarity(5, 5), "legendary");
});

/* ---------------- Tactic rarity ---------------- */

test("tactics start at Common and never fall to Poor from rallies", () => {
  assert.equal(tacticRarity(0, 4), "common");
  assert.equal(tacticRarity(0, 0), "common");
});

test("each tactic threshold is reached at exactly its share (5 others)", () => {
  assert.deepEqual([TACTIC_RALLY_UNCOMMON, TACTIC_RALLY_RARE, TACTIC_RALLY_EPIC, TACTIC_RALLY_LEGENDARY], [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => tacticRarity(n, 5)),
    ["common", "uncommon", "rare", "epic", "legendary", "legendary"]);
});

test("small parties skip rarities (3 others: 33%, 67%, 100%)", () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => tacticRarity(n, 3)),
    ["common", "uncommon", "epic", "legendary"]);
});

test("rarity drops again when rallies are withdrawn", () => {
  assert.equal(achievementRarity(3, 4), "legendary");
  assert.equal(achievementRarity(2, 4), "epic");
  assert.equal(achievementRarity(1, 4), "rare");
});

test("with no other party members an achievement stays Rare", () => {
  assert.equal(achievementRarity(0, 0), "rare");
});

/* ---------------- Bags ---------------- */

const task = (ownerId, extra = {}) => ({ ownerId, passedOver: false, done: false, ...extra });

test("only open, owned tasks use bag slots", () => {
  const log = [task("a"), task("a", { done: true }), task(null, { passedOver: true }), task("b")];
  assert.equal(slotsUsed(log, "a"), 1);
  assert.equal(slotsUsed(log, "b"), 1);
});

test("bag size splits the team budget across the party, never below the minimum", () => {
  assert.equal(TEAM_ACTION_BUDGET, 10);
  assert.equal(MIN_BAG_SLOTS, 3);
  const sizes = [1, 2, 3, 4, 5, 6, 8, 12].map((n) => [n, bagSize(n)]);
  assert.deepEqual(sizes, [[1, 10], [2, 5], [3, 4], [4, 3], [5, 3], [6, 3], [8, 3], [12, 3]]);
});

test("an empty party gets the whole budget", () => {
  assert.equal(bagSize(0), TEAM_ACTION_BUDGET);
});

test("bags are full at the bag size, and stay full when over it", () => {
  const log = Array.from({ length: 4 }, () => task("a"));
  assert.equal(bagsFull(log, "a", 5), false);
  log.push(task("a"));
  assert.equal(bagsFull(log, "a", 5), true);
  assert.equal(bagsFull(log, "a", 3), true, "5 held after shrinking to 3: full, nothing removed");
  assert.equal(slotsUsed(log, "a"), 5);
  log[0].done = true; // finishing a task frees a slot
  assert.equal(bagsFull(log, "a", 5), false);
});

/* ---------------- Threat voting ---------------- */

test("a ballot can stack the whole budget on one topic", () => {
  const r = validateThreatBallot({ t1: THREAT_PER_PLAYER }, ["t1", "t2"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ballot, { t1: THREAT_PER_PLAYER });
});

test("over-budget, negative, fractional and unknown votes are rejected", () => {
  assert.equal(validateThreatBallot({ t1: 2, t2: 2 }, ["t1", "t2"]).ok, false);
  assert.equal(validateThreatBallot({ t1: -1 }, ["t1"]).ok, false);
  assert.equal(validateThreatBallot({ t1: 1.5 }, ["t1"]).ok, false);
  assert.equal(validateThreatBallot({ nope: 1 }, ["t1"]).ok, false);
  assert.equal(validateThreatBallot(null, ["t1"]).ok, false);
});

test("threat is tallied across ballots and pulled highest first, skipping zero", () => {
  const totals = tallyThreat({ a: { t1: 1, t2: 2 }, b: { t2: 1 } });
  assert.deepEqual(totals, { t1: 1, t2: 3 });
  const topics = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
  assert.equal(nextBossByThreat(topics, totals).id, "t2");
  assert.equal(nextBossByThreat([{ id: "t3" }], totals), null);
});

test("ties on threat are broken by the random source", () => {
  const topics = [{ id: "t1" }, { id: "t2" }];
  const totals = { t1: 2, t2: 2 };
  assert.equal(nextBossByThreat(topics, totals, () => 0).id, "t1");
  assert.equal(nextBossByThreat(topics, totals, () => 0.99).id, "t2");
});

/* ---------------- Races and classes ---------------- */

test("the Forever race/class matrix is enforced", () => {
  assert.equal(isValidCombo("Undead", "Paladin"), true);
  assert.equal(isValidCombo("Night Elf", "Mage"), false);
  assert.equal(isValidCombo("Tauren", "Paladin"), false);
});
