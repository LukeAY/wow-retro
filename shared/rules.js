/* =========================================================================
 * Loot Council — game rules (shared)
 * Pure constants and functions used by the server, the room engine and the
 * browser, so online and local mode can't drift. Nothing here touches the
 * network, storage or the DOM. Randomness is passed in, so tests can pin it.
 * ========================================================================= */

/* ---------------- Rarity = priority = value ---------------- */

export const RARITIES = ["poor", "common", "uncommon", "rare", "epic", "legendary"];

// Each rarity carries a WoW-style vendor value (in copper) and the damage an
// owned tactic of that rarity deals to the boss.
export const RARITY = {
  poor:      { label: "Poor",      value: 150 },       // 1s 50c
  common:    { label: "Common",    value: 2500 },      // 25s
  uncommon:  { label: "Uncommon",  value: 42000 },     // 4g 20s
  rare:      { label: "Rare",      value: 185000 },    // 18g 50s
  epic:      { label: "Epic",      value: 1250000 },   // 125g
  legendary: { label: "Legendary", value: 10000000 },  // 1000g
};

export function rarityRank(rarity) {
  return RARITIES.indexOf(rarity);
}

/* ---------------- Boss HP and damage ---------------- */

// Damage a resolved tactic deals, by its rarity: heavier fixes hit harder.
// Only owned tactics count; one everyone passed on deals no damage.
export const TACTIC_DAMAGE = { poor: 15, common: 30, uncommon: 50, rare: 80, epic: 120, legendary: 200 };

export function tacticDamage(rarity, owned) {
  return owned ? (TACTIC_DAMAGE[rarity] || TACTIC_DAMAGE.uncommon) : 0;
}

// Boss HP slides with the threat the party voted onto its topic:
// HP = HP_BASE + (votes / topVotes) * HP_RANGE, so the top topic always has
// HP_BASE + HP_RANGE and an unvoted topic has HP_BASE.
export const HP_BASE = 60;
export const HP_RANGE = 440;

export function bossHp(votes, topVotes) {
  if (!topVotes || !(votes > 0)) return HP_BASE;
  return Math.round(HP_BASE + (Math.min(votes, topVotes) / topVotes) * HP_RANGE);
}

// Tier labels are cosmetic bands derived from HP (highest band first).
export const TIER_BANDS = [
  { tier: "raid",   label: "Raid Boss", minHp: 380 },
  { tier: "elite",  label: "Elite",     minHp: 200 },
  { tier: "normal", label: "Normal",    minHp: 0 },
];

export function tierForHp(hp) {
  return TIER_BANDS.find((b) => hp >= b.minHp) || TIER_BANDS[TIER_BANDS.length - 1];
}

export function tierLabel(tier) {
  const band = TIER_BANDS.find((b) => b.tier === tier);
  return band ? band.label : "Normal";
}

// How an encounter ended (or that it hasn't).
export const BOSS_STATUS = {
  active:    "In progress",
  slain:     "Slain",
  retreated: "Retreated",
  enraged:   "Enraged",
};

/* ---------------- Threat voting ---------------- */

// Threat each player spreads across Mob List topics (can stack on one topic).
export const THREAT_PER_PLAYER = 3;

// Validate a ballot ({ topicId: points }) against the topics on offer and the
// budget. Zero entries are dropped, so the returned ballot is clean.
export function validateThreatBallot(ballot, topicIds, budget = THREAT_PER_PLAYER) {
  if (!ballot || typeof ballot !== "object" || Array.isArray(ballot)) {
    return { ok: false, error: "That ballot isn't valid." };
  }
  const known = new Set(topicIds);
  const clean = {};
  let total = 0;
  for (const [id, points] of Object.entries(ballot)) {
    if (!known.has(id)) return { ok: false, error: "That topic isn't on the Mob List." };
    if (!Number.isInteger(points) || points < 0) return { ok: false, error: "Threat must be a whole number, 0 or more." };
    if (points === 0) continue;
    clean[id] = points;
    total += points;
  }
  if (total > budget) return { ok: false, error: `You only have ${budget} threat to spend.` };
  return { ok: true, ballot: clean, total };
}

// Sum every player's ballot into { topicId: totalThreat }.
export function tallyThreat(ballots) {
  const totals = {};
  for (const ballot of Object.values(ballots || {})) {
    for (const [id, points] of Object.entries(ballot)) totals[id] = (totals[id] || 0) + points;
  }
  return totals;
}

// The next topic to pull: highest threat first, ties broken at random.
// Topics with no threat are skipped (returns null when none are left).
export function nextBossByThreat(topics, totals, rand = Math.random) {
  let best = [];
  let top = 0;
  for (const t of topics) {
    const votes = totals[t.id] || 0;
    if (votes <= 0) continue;
    if (votes > top) { top = votes; best = [t]; }
    else if (votes === top) best.push(t);
  }
  if (best.length === 0) return null;
  return best[Math.min(best.length - 1, Math.floor(rand() * best.length))];
}

/* ---------------- Rallies ---------------- */

// Rallies raise rarity by the share of *eligible* party members (everyone
// but the item's own posters or proposer) who rallied behind it. A ladder
// lists [share, rarity] pairs, highest first; below them it stays at base.
export function rallyRarity(rallies, eligible, ladder, base) {
  if (!(eligible > 0)) return base;
  const share = rallies / eligible;
  const rung = ladder.find(([min]) => share >= min - 1e-9); // 3/5 is exactly 60%
  return rung ? rung[1] : base;
}

// Achievements start at Rare.
export const RALLY_EPIC = 0.4;
export const RALLY_LEGENDARY = 0.75;

export function achievementRarity(rallies, eligible) {
  return rallyRarity(rallies, eligible, [[RALLY_LEGENDARY, "legendary"], [RALLY_EPIC, "epic"]], "rare");
}

// Tactics start at Common. Only the facilitator can make one Poor.
export const TACTIC_RALLY_UNCOMMON = 0.2;
export const TACTIC_RALLY_RARE = 0.4;
export const TACTIC_RALLY_EPIC = 0.6;
export const TACTIC_RALLY_LEGENDARY = 0.8;

export function tacticRarity(rallies, eligible) {
  return rallyRarity(rallies, eligible, [
    [TACTIC_RALLY_LEGENDARY, "legendary"],
    [TACTIC_RALLY_EPIC, "epic"],
    [TACTIC_RALLY_RARE, "rare"],
    [TACTIC_RALLY_UNCOMMON, "uncommon"],
  ], "common");
}

/* ---------------- Bags ---------------- */

// Bag slots: the most open (not done) tasks one player can own at once.
// The team shares a budget of actions, split across everyone in the party,
// so bags shrink as the party grows (never below MIN_BAG_SLOTS). Completing
// a task frees its slot. A full player can't Need/Greed.
export const TEAM_ACTION_BUDGET = 10;
export const MIN_BAG_SLOTS = 3;

export function bagSize(partySize) {
  if (!(partySize > 0)) return TEAM_ACTION_BUDGET;
  return Math.max(MIN_BAG_SLOTS, Math.ceil(TEAM_ACTION_BUDGET / partySize));
}

export function slotsUsed(log, memberId) {
  return log.filter((t) => t.ownerId === memberId && !t.passedOver && !t.done).length;
}

// If bags shrank below what someone already holds, nothing is taken away:
// they just count as full until they're back under the limit.
export function bagsFull(log, memberId, size) {
  return slotsUsed(log, memberId) >= size;
}

/* ---------------- Need / Greed / Pass ---------------- */

export const CHOICES = ["need", "greed", "pass"];

/**
 * Resolve a drop under WoW group loot rules.
 *  - If anyone Needs, only Needers roll 1-100; highest wins.
 *  - Else if anyone Greeds, only Greeders roll.
 *  - Else it's unclaimed.
 *  - Ties on the top roll re-roll amongst the tied players only.
 * `entrants` is [{ memberId, choice, ...anything }]; `rollD(100)` returns 1..100.
 * Returns the entrants with a `roll` (null for passers), the winner and why.
 */
export function resolveRolls(entrants, rollD) {
  const rolls = entrants.map((e) => ({ ...e, roll: null }));
  const needers = rolls.filter((r) => r.choice === "need");
  const greeders = rolls.filter((r) => r.choice === "greed");
  const contenders = needers.length ? needers : greeders;
  const context = needers.length ? "Need" : greeders.length ? "Greed" : "";
  if (contenders.length === 0) return { rolls, winner: null, context };

  contenders.forEach((c) => (c.roll = rollD(100)));
  let pool = contenders;
  for (let guard = 0; guard < 50; guard++) {
    const top = Math.max(...pool.map((c) => c.roll));
    const tied = pool.filter((c) => c.roll === top);
    if (tied.length === 1) return { rolls, winner: tied[0], context };
    tied.forEach((c) => (c.roll = rollD(100)));
    pool = tied;
  }
  return { rolls, winner: pool[0], context };
}

/* ---------------- Races and classes (WoW: Forever) ---------------- */

/**
 * World of Warcraft: Forever race/class matrix (single source of truth).
 * Classic's 8 races + the two Skyborne allied-race variants, including the
 * six Forever additions (Human Hunter, Dwarf Shaman, Gnome Priest, Orc Mage,
 * Troll Warlock, Undead Paladin). Skyborne is modelled as its two
 * faction-specific variants: High Order (Alliance) and Windshaper (Horde).
 */
export const RACE_CLASSES = {
  // Alliance
  "Human":      ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Mage", "Warlock"],
  "Dwarf":      ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Shaman"],
  "Night Elf":  ["Warrior", "Hunter", "Rogue", "Priest", "Druid"],
  "Gnome":      ["Warrior", "Rogue", "Priest", "Mage", "Warlock"],
  "High Order": ["Warrior", "Hunter", "Rogue", "Druid", "Mage"],
  // Horde
  "Orc":        ["Warrior", "Hunter", "Rogue", "Shaman", "Warlock", "Mage"],
  "Tauren":     ["Warrior", "Hunter", "Shaman", "Druid"],
  "Troll":      ["Warrior", "Hunter", "Rogue", "Priest", "Mage", "Shaman", "Warlock"],
  "Undead":     ["Warrior", "Rogue", "Priest", "Mage", "Warlock", "Paladin"],
  "Windshaper": ["Warrior", "Hunter", "Rogue", "Druid", "Shaman"],
};

export const FACTION = {
  "Human": "Alliance", "Dwarf": "Alliance", "Night Elf": "Alliance",
  "Gnome": "Alliance", "High Order": "Alliance",
  "Orc": "Horde", "Tauren": "Horde", "Troll": "Horde",
  "Undead": "Horde", "Windshaper": "Horde",
};

export const RACE_NAMES = Object.keys(RACE_CLASSES);

export const CLASS_NAMES = [...new Set(Object.values(RACE_CLASSES).flat())];

// Is this class legal for this race under Forever rules?
export function isValidCombo(race, cls) {
  return !!RACE_CLASSES[race] && RACE_CLASSES[race].includes(cls);
}

/* ---------------- Input limits ---------------- */

export const LIMITS = {
  characterName: 24,
  realName: 40,
  topicName: 60,
  topicDesc: 500,
  achievementTitle: 60,
  achievementDetail: 500,
  tacticName: 120,
  tacticDesc: 500,
  lootName: 120,
  lootDesc: 500,
  timerMinutes: 120,
};
