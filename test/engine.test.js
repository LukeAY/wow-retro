import { test } from "node:test";
import assert from "node:assert/strict";
import { BOSS_TIERS } from "../shared/rules.js";
import {
  createRoom, migrateRoom, act, tick, viewFor, buildLedger, buildSummary, addMember, setHeld, partySize, roomBagSize,
} from "../shared/engine.js";

// A deterministic context: sequential ids, scripted dice, a settable clock.
function setup(names = ["Ana", "Ben", "Cy", "Di", "Ed"]) {
  let n = 0;
  const ctx = { uuid: () => `id${++n}`, rollD: () => 50, rand: () => 0, now: 0 };
  const room = createRoom({ code: "TEST", now: 0 });
  const m = names.map((name) => addMember(room, { name, realName: `${name} R`, race: "Human", cls: "Warrior" }, ctx.uuid));
  const host = { memberId: m[0].id, facilitator: true };
  const as = (member) => ({ memberId: member.id, facilitator: false });
  const run = (actor, msg) => {
    const r = act(room, actor, msg, ctx);
    assert.ok(r.ok, `${msg.type} failed: ${r.error}`);
    return r;
  };
  return { room, ctx, m, host, as, run };
}

/* ---------------- Achievements ---------------- */

test("rallies raise achievement rarity and un-rallying lowers it", () => {
  const { room, m, as, run } = setup(); // 5 members: 4 others per achievement
  run(as(m[0]), { type: "postAchievement", title: "Shipped search" });
  const id = room.achievements[0].id;
  assert.equal(room.achievements[0].rarity, "rare");
  run(as(m[1]), { type: "rally", achievementId: id });
  assert.equal(room.achievements[0].rarity, "rare");      // 1/4
  run(as(m[2]), { type: "rally", achievementId: id });
  assert.equal(room.achievements[0].rarity, "epic");      // 2/4 = 50%
  run(as(m[3]), { type: "rally", achievementId: id });
  assert.equal(room.achievements[0].rarity, "legendary"); // 3/4 = 75%
  run(as(m[3]), { type: "rally", achievementId: id });    // un-rally
  assert.equal(room.achievements[0].rarity, "epic");
});

test("you can't rally your own achievement, and duplicates are refused", () => {
  const { room, ctx, m, as, run } = setup();
  run(as(m[0]), { type: "postAchievement", title: "Shipped search" });
  const own = act(room, as(m[0]), { type: "rally", achievementId: room.achievements[0].id }, ctx);
  assert.match(own.error, /own/);
  const dup = act(room, as(m[1]), { type: "postAchievement", title: "shipped SEARCH" }, ctx);
  assert.match(dup.error, /already on the board/);
});

test("merging combines posters and ralliers, then recalculates rarity", () => {
  const { room, m, host, as, run } = setup();
  run(as(m[0]), { type: "postAchievement", title: "Shipped search" });
  run(as(m[1]), { type: "postAchievement", title: "Search went live" });
  const [a, b] = room.achievements;
  run(as(m[2]), { type: "rally", achievementId: a.id });
  run(as(m[3]), { type: "rally", achievementId: b.id });
  run(as(m[0]), { type: "rally", achievementId: b.id }); // poster of a rallies b
  run(host, { type: "mergeAchievements", targetId: a.id, sourceId: b.id });
  assert.equal(room.achievements.length, 1);
  const merged = room.achievements[0];
  assert.deepEqual(merged.posters.map((p) => p.name), ["Ana", "Ben"]);
  // Ana is now a poster, so her rally drops out; Cy and Di remain: 2 of 3 others
  assert.deepEqual(merged.rallies.map((r) => r.name).sort(), ["Cy", "Di"]);
  assert.equal(merged.rarity, "epic");
});

test("the board never shows who rallied, only rarity; the ledger names them", () => {
  const { room, m, as, run } = setup();
  run(as(m[0]), { type: "postAchievement", title: "Shipped search" });
  run(as(m[1]), { type: "rally", achievementId: room.achievements[0].id });
  const view = viewFor(room, as(m[2]), 0);
  assert.equal(JSON.stringify(view.achievements).includes("Ben"), false);
  assert.match(buildLedger(room), /rallied by Ben R \(Ben\)/);
});

/* ---------------- Threat voting and HP ---------------- */

function toVoting(s) {
  s.run(s.host, { type: "setPhase", phase: "scouting" });
  for (const name of ["Flaky CI", "Slow reviews", "Standup"]) s.run(s.host, { type: "addMob", name });
  s.run(s.host, { type: "setPhase", phase: "voting" });
  return s.room.mobList.map((t) => t.id);
}

test("ballots are secret until reveal, and over-budget ballots are rejected", () => {
  const s = setup();
  const [ci, reviews] = toVoting(s);
  s.run(s.as(s.m[1]), { type: "castThreat", ballot: { [ci]: 3 } });
  const over = act(s.room, s.as(s.m[2]), { type: "castThreat", ballot: { [ci]: 2, [reviews]: 2 } }, s.ctx);
  assert.match(over.error, /only have 3/);
  const peek = viewFor(s.room, s.as(s.m[2]), 0);
  assert.equal(peek.mobList[0].threat, null);
  assert.equal(peek.members[1].hasThreatVoted, true);
  assert.deepEqual(peek.you.myBallot, {});
  s.run(s.host, { type: "revealThreat" });
  assert.equal(viewFor(s.room, s.as(s.m[2]), 0).mobList[0].threat, 3);
});

test("bosses are pulled highest threat first, tiered by threat share; zero threat is skipped", () => {
  const s = setup();
  const [ci, reviews] = toVoting(s);
  s.run(s.as(s.m[1]), { type: "castThreat", ballot: { [ci]: 3 } });
  s.run(s.as(s.m[2]), { type: "castThreat", ballot: { [ci]: 1, [reviews]: 2 } });
  s.run(s.host, { type: "setPhase", phase: "encounters" }); // reveals automatically
  s.run(s.host, { type: "pullBoss" });
  assert.equal(s.room.boss.name, "Flaky CI");
  assert.equal(s.room.boss.tier, "raid");
  assert.deepEqual([s.room.boss.phase, s.room.boss.hp, s.room.boss.hpMax], ["prep", null, null]);
  engage(s);
  s.run(s.host, { type: "tacticalVictory" });
  s.run(s.host, { type: "pullBoss" });
  assert.equal(s.room.boss.name, "Slow reviews");
  assert.equal(s.room.boss.tier, "elite"); // 2 of the top 4 threat
  engage(s);
  s.run(s.host, { type: "tacticalVictory" });
  const none = act(s.room, s.host, { type: "pullBoss" }, s.ctx);
  assert.match(none.error, /No topics with threat/);
  assert.match(buildLedger(s.room), /## Not pulled\n- Standup — 0 threat/);
});

/* ---------------- Encounters ---------------- */

// Pull the first topic (no threat, so a Normal boss), still in preparation.
function toFight(s) {
  toVoting(s);
  s.run(s.host, { type: "setPhase", phase: "encounters" });
  s.run(s.host, { type: "pullBoss", mobId: s.room.mobList[0].id });
}
// Engage the live boss, first proposing Common filler tactics up to its minimum.
function engage(s) {
  const need = BOSS_TIERS[s.room.boss.tier].minTactics;
  for (let i = s.room.boss.tactics.length; i < need; i++) s.run(s.host, { type: "proposeTactic", name: `Plan ${i}` });
  s.run(s.host, { type: "engageBoss" });
}

test("tactics start at Common; rallies from the others raise them and un-rallying lowers them", () => {
  const s = setup(); // Ana proposes; 4 others are eligible
  toFight(s);
  s.run(s.as(s.m[0]), { type: "proposeTactic", name: "Quarantine flaky tests", rarity: "legendary" });
  const t = s.room.boss.tactics[0];
  assert.equal(t.rarity, "common", "the proposer can't pick a rarity online");
  const rally = (i) => s.run(s.as(s.m[i]), { type: "rally", tacticId: t.id });
  rally(1); assert.equal(t.rarity, "uncommon");  // 25%
  rally(2); assert.equal(t.rarity, "rare");      // 50%
  rally(3); assert.equal(t.rarity, "epic");      // 75%
  rally(4); assert.equal(t.rarity, "legendary"); // 100%
  rally(4); assert.equal(t.rarity, "epic");      // un-rally
  const own = act(s.room, s.as(s.m[0]), { type: "rally", tacticId: t.id }, s.ctx);
  assert.match(own.error, /your own tactic/);
  assert.equal(s.room.lootTable.find((l) => l.id === t.id).rarity, "epic", "the backlog copy follows");
});

test("the board never sees who rallied a tactic or how many", () => {
  const s = setup();
  toFight(s);
  s.run(s.as(s.m[0]), { type: "proposeTactic", name: "Fix it" });
  const id = s.room.boss.tactics[0].id;
  s.run(s.as(s.m[1]), { type: "rally", tacticId: id });
  for (const viewer of [s.as(s.m[1]), s.as(s.m[2]), s.host]) {
    const v = viewFor(s.room, viewer, 0);
    const json = JSON.stringify(v.boss) + JSON.stringify(v.bossLog);
    assert.doesNotMatch(json, /rallies|Ben R/);
  }
  const ben = viewFor(s.room, s.as(s.m[1]), 0).boss.tactics[0];
  assert.equal(ben.rallied, true);
  assert.equal(ben.mine, false);
  assert.equal(ben.rallyable, true);
  assert.equal(viewFor(s.room, s.as(s.m[0]), 0).boss.tactics[0].mine, true);
  assert.match(buildLedger(s.room), /Fix it — Uncommon — _proposed, unowned_; rallied by Ben R \(Ben\)/);
});

test("rarity locks when a tactic is dropped", () => {
  const s = setup();
  toFight(s);
  s.run(s.as(s.m[0]), { type: "proposeTactic", name: "Fix it" });
  const t = s.room.boss.tactics[0];
  s.run(s.as(s.m[1]), { type: "rally", tacticId: t.id });
  engage(s);
  s.run(s.host, { type: "dropTactic", tacticId: t.id });
  const late = act(s.room, s.as(s.m[2]), { type: "rally", tacticId: t.id }, s.ctx);
  assert.match(late.error, /already been dropped/);
  s.run(s.host, { type: "removeMember", memberId: s.m[1].id }); // would change the share
  assert.equal(t.rarity, "uncommon");
  assert.equal(s.room.activeDrop.item.rarity, "uncommon");
  assert.equal("rallies" in s.room.activeDrop.item, false);
});

test("the host's override sticks over rallies until handed back, and is logged", () => {
  const s = setup();
  toFight(s);
  s.run(s.as(s.m[0]), { type: "proposeTactic", name: "Quarantine flaky tests" });
  const t = s.room.boss.tactics[0];
  s.run(s.as(s.m[1]), { type: "rally", tacticId: t.id }); // Uncommon
  s.run(s.host, { type: "setTacticRarity", tacticId: t.id, rarity: "poor" });
  assert.equal(t.rarity, "poor");
  s.run(s.as(s.m[2]), { type: "rally", tacticId: t.id }); // rallies would make it Rare
  assert.equal(t.rarity, "poor");
  assert.equal(t.rarityFrom, "rare");
  s.run(s.host, { type: "setTacticRarity", tacticId: t.id, rarity: "rallies" });
  assert.equal(t.rarity, "rare");
  assert.equal(t.rarityFrom, null);
  s.run(s.host, { type: "setTacticRarity", tacticId: t.id, rarity: "epic" });
  engage(s);
  s.run(s.host, { type: "dropTactic", tacticId: t.id });
  s.run(s.as(s.m[1]), { type: "setChoice", choice: "need" });
  s.run(s.host, { type: "resolve" });
  const logged = s.room.log[0];
  assert.equal(logged.rarity, "epic");
  assert.equal(logged.rarityFrom, "rare");
  assert.equal(logged.tacticId, t.id);
  assert.match(buildLedger(s.room), /Epic \(changed from Rare\)/);
  const bad = act(s.room, s.as(s.m[1]), { type: "setTacticRarity", tacticId: t.id, rarity: "rare" }, s.ctx);
  assert.match(bad.error, /Only the host/);
});

test("local mode picks a starting rarity and has no tactic rallies", () => {
  let n = 0;
  const ctx = { uuid: () => `id${++n}`, rollD: () => 50, rand: () => 0, now: 0 };
  const room = createRoom({ code: "LOCAL", tacticRallies: false });
  const m = ["Ana", "Ben"].map((name) => addMember(room, { name, realName: "", race: "Human", cls: "Warrior" }, ctx.uuid));
  const host = (member) => ({ memberId: member.id, facilitator: true });
  act(room, host(m[0]), { type: "setPhase", phase: "encounters" }, ctx);
  act(room, host(m[0]), { type: "addMob", name: "Topic" }, ctx);
  assert.ok(act(room, host(m[0]), { type: "pullBoss", mobId: room.mobList[0].id }, ctx).ok);
  act(room, host(m[0]), { type: "proposeTactic", name: "Fix it", rarity: "poor" }, ctx);
  const t = room.boss.tactics[0];
  assert.equal(t.rarity, "poor");
  assert.equal(t.rarityFrom, null, "a picked rarity isn't a change");
  assert.match(act(room, host(m[1]), { type: "rally", tacticId: t.id }, ctx).error, /Pick a tactic's rarity/);
  act(room, host(m[0]), { type: "setTacticRarity", tacticId: t.id, rarity: "rare" }, ctx);
  assert.equal(t.rarityFrom, "poor");
  act(room, host(m[0]), { type: "resetSession" }, ctx);
  assert.equal(room.tacticRallies, false);
});

// Pull a boss of the given tier: "raid" is the top-threat topic, "elite" has
// half its threat, "normal" has none.
function pullTier(s, tier) {
  const [top, half] = toVoting(s);
  s.run(s.as(s.m[1]), { type: "castThreat", ballot: { [top]: 3 } });
  s.run(s.as(s.m[2]), { type: "castThreat", ballot: { [top]: 1, [half]: 2 } }); // half: 2 of 4
  s.run(s.host, { type: "setPhase", phase: "encounters" });
  const mobId = { raid: top, elite: half, normal: s.room.mobList[2].id }[tier];
  s.run(s.host, { type: "pullBoss", mobId });
  assert.equal(s.room.boss.tier, tier);
}
// Propose tactics of the given rarities (setting each one's rarity).
function propose(s, rarities) {
  return rarities.map((rarity, i) => {
    s.run(s.host, { type: "proposeTactic", name: `${rarity} fix ${s.room.boss.tactics.length}` });
    const t = s.room.boss.tactics.at(-1);
    if (rarity !== "common") s.run(s.host, { type: "setTacticRarity", tacticId: t.id, rarity });
    return t;
  });
}
// Drop a tactic and have the winner Need it (or everyone pass); returns the damage.
function play(s, tactic, winner) {
  s.run(s.host, { type: "dropTactic", tacticId: tactic.id });
  if (winner) s.run(s.as(winner), { type: "setChoice", choice: "need" });
  s.run(s.host, { type: "resolve" });
  return s.room.lastResult.damage;
}

test("a boss is prepared first: no HP, no drops, no victory, until the host engages", () => {
  const s = setup();
  pullTier(s, "elite");
  const boss = s.room.boss;
  assert.equal(boss.phase, "prep");
  const [t] = propose(s, ["uncommon"]);
  assert.match(act(s.room, s.host, { type: "dropTactic", tacticId: t.id }, s.ctx).error, /Engage the boss/);
  s.run(s.host, { type: "addLoot", name: "Backlog item", rarity: "rare" });
  assert.match(act(s.room, s.host, { type: "drop" }, s.ctx).error, /Engage the boss/);
  assert.match(act(s.room, s.host, { type: "tacticalVictory" }, s.ctx).error, /Engage the boss first/);
  assert.match(act(s.room, s.host, { type: "timer", target: "enrage", action: "set", minutes: 5 }, s.ctx).error, /Engage the boss/);
  assert.match(act(s.room, s.host, { type: "engageBoss" }, s.ctx).error, /at least 2 tactics/);
  propose(s, ["uncommon"]);
  assert.match(act(s.room, s.as(s.m[1]), { type: "engageBoss" }, s.ctx).error, /Only the host/);
  // nobody can read HP from the state before Engage, the host included
  for (const viewer of [s.host, s.as(s.m[1])]) {
    const v = viewFor(s.room, viewer, 0).boss;
    assert.deepEqual([v.hp, v.hpMax, v.phase], [null, null, "prep"]);
  }
  s.run(s.host, { type: "engageBoss" });
  assert.deepEqual([boss.phase, boss.hpMax, boss.hp], ["fight", 65, 65]); // ceil(100 x 0.65)
  assert.equal(viewFor(s.room, s.as(s.m[1]), 0).boss.hp, 65);
  assert.match(act(s.room, s.host, { type: "engageBoss" }, s.ctx).error, /already engaged/);
});

test("an Elite with 3 Uncommon tactics has 98 HP: owning 2 of them kills it", () => {
  const s = setup();
  pullTier(s, "elite");
  const [a, b] = propose(s, ["uncommon", "uncommon", "uncommon"]);
  s.run(s.host, { type: "engageBoss" });
  assert.equal(s.room.boss.hpMax, 98); // ceil(150 x 0.65)
  assert.equal(play(s, a, s.m[1]), 50);
  play(s, b, s.m[2]);
  assert.equal(s.room.boss.status, "slain");
});

test("a Raid Boss with 5 Uncommon tactics has 200 HP: owning 4 kills it; a passed one does nothing", () => {
  const s = setup();
  pullTier(s, "raid");
  const ts = propose(s, ["uncommon", "uncommon", "uncommon", "uncommon", "uncommon"]);
  s.run(s.host, { type: "engageBoss" });
  assert.equal(s.room.boss.hpMax, 200); // ceil(250 x 0.8)
  assert.equal(play(s, ts[0], null), 0, "everyone passed");
  assert.equal(s.room.boss.hp, 200);
  for (let i = 1; i < 4; i++) play(s, ts[i], s.m[i]);
  assert.equal(s.room.boss.hp, 50);
  play(s, ts[4], s.m[4]);
  assert.equal(s.room.boss.status, "slain");
  assert.match(buildLedger(s.room), /— Slain, 4 of 4 actions open/);
});

test("a Normal boss with one Poor tactic has 20 HP and falls to it", () => {
  const s = setup();
  pullTier(s, "normal");
  const [t] = propose(s, ["poor"]);
  s.run(s.host, { type: "engageBoss" });
  assert.equal(s.room.boss.hpMax, 20); // ceil(40 x 0.5)
  play(s, t, s.m[1]);
  assert.equal(s.room.boss.status, "slain");
});

test("once engaged, late tactics, backlog drops and rarity changes move HP with the plan", () => {
  const s = setup();
  pullTier(s, "raid");
  const ts = propose(s, ["uncommon", "uncommon", "uncommon"]);
  s.run(s.host, { type: "engageBoss" });
  const boss = s.room.boss;
  assert.deepEqual([boss.hp, boss.hpMax], [120, 120]); // ceil(150 x 0.8)
  play(s, ts[0], s.m[1]);                               // 70 / 120
  const [late] = propose(s, ["common"]);                // + ceil(45 x 0.8) = 36
  assert.deepEqual([boss.hp, boss.hpMax], [106, 156]);
  s.run(s.host, { type: "setTacticRarity", tacticId: late.id, rarity: "legendary" }); // +ceil(45 x 0.8)
  assert.deepEqual([boss.hp, boss.hpMax], [142, 192]);
  s.run(s.host, { type: "setTacticRarity", tacticId: late.id, rarity: "common" });    // and back
  assert.deepEqual([boss.hp, boss.hpMax], [106, 156]);
  s.run(s.host, { type: "addLoot", name: "Backlog item", rarity: "rare" });
  s.run(s.host, { type: "drop", lootId: s.room.lootTable.at(-1).id });              // + ceil(60 x 0.8) = 48
  assert.deepEqual([boss.hp, boss.hpMax], [154, 204]);
  s.run(s.host, { type: "resolve" });
  s.run(s.host, { type: "drop", lootId: ts[1].id });   // one of this boss's own tactics: no change
  assert.deepEqual([boss.hp, boss.hpMax], [154, 204]);
});

test("a Tactical Victory ends an engaged boss at any HP; the ledger shows what was left", () => {
  const s = setup();
  pullTier(s, "raid");
  const ts = propose(s, ["uncommon", "uncommon", "uncommon"]);
  s.run(s.host, { type: "engageBoss" });
  play(s, ts[0], s.m[1]);
  assert.match(act(s.room, s.as(s.m[1]), { type: "tacticalVictory" }, s.ctx).error, /Only the host/);
  s.run(s.host, { type: "dropTactic", tacticId: ts[1].id });
  assert.match(act(s.room, s.host, { type: "tacticalVictory" }, s.ctx).error, /Resolve the current drop/);
  s.run(s.host, { type: "resolve" });
  s.run(s.host, { type: "tacticalVictory", note: "Good enough for now" });
  assert.equal(s.room.boss.status, "tactical");
  assert.equal(s.room.boss.hp, 70);
  assert.match(act(s.room, s.host, { type: "tacticalVictory" }, s.ctx).error, /no boss engaged/);
  const ledger = buildLedger(s.room);
  assert.match(ledger, /— Tactical Victory \(70 of 120 HP left\), 1 of 1 actions open/);
  assert.match(ledger, /> Note: Good enough for now/);
  s.run(s.host, { type: "clearStage" });
  assert.equal(s.room.bossLog[0].status, "tactical", "archived with its outcome");
});

test("an enrage that runs out mid-vote waits for the drop to resolve", () => {
  const s = setup();
  toFight(s);
  s.run(s.as(s.m[1]), { type: "proposeTactic", name: "Fix it" });
  engage(s);
  s.run(s.host, { type: "timer", target: "enrage", action: "set", minutes: 1 });
  s.run(s.host, { type: "dropTactic", tacticId: s.room.boss.tactics[0].id });
  assert.equal(tick(s.room, 61_000), false, "doesn't enrage during a live vote");
  s.ctx.now = 61_000;
  s.run(s.host, { type: "resolve" });
  assert.equal(s.room.boss.status, "enraged");
});

test("a paused enrage timer doesn't run out", () => {
  const s = setup();
  toFight(s);
  engage(s);
  s.run(s.host, { type: "timer", target: "enrage", action: "set", minutes: 1 });
  s.ctx.now = 30_000;
  s.run(s.host, { type: "timer", target: "enrage", action: "pause" });
  assert.equal(tick(s.room, 120_000), false);
  s.ctx.now = 120_000;
  s.run(s.host, { type: "timer", target: "enrage", action: "resume" });
  assert.equal(tick(s.room, 149_000), false);
  assert.equal(tick(s.room, 150_000), true);
  assert.equal(s.room.boss.status, "enraged");
});

/* ---------------- Characters ---------------- */

test("players edit their own character, under the same rules as creating one", () => {
  const s = setup(["Ana", "Ben"]);
  s.run(s.as(s.m[1]), { type: "editCharacter", name: "Benedict", realName: "Ben Q", race: "Tauren", cls: "Druid" });
  assert.deepEqual(
    (({ name, realName, race, cls }) => ({ name, realName, race, cls }))(s.room.members[1]),
    { name: "Benedict", realName: "Ben Q", race: "Tauren", cls: "Druid" });
  assert.equal(s.room.members[0].name, "Ana", "only your own");
  assert.match(act(s.room, s.as(s.m[1]), { type: "editCharacter", name: "B", realName: "B", race: "Night Elf", cls: "Mage" }, s.ctx).error, /cannot be a Mage/);
  assert.match(act(s.room, s.as(s.m[1]), { type: "editCharacter", name: "", realName: "B", race: "Human", cls: "Warrior" }, s.ctx).error, /character name/);
  assert.match(act(s.room, { memberId: null, facilitator: false }, { type: "editCharacter", name: "X", realName: "X", race: "Human", cls: "Warrior" }, s.ctx).error, /Create a character/);
  s.run(s.host, { type: "endRaid" });
  assert.match(act(s.room, s.as(s.m[1]), { type: "editCharacter", name: "Late", realName: "B", race: "Human", cls: "Warrior" }, s.ctx).error, /raid has ended/);
});

/* ---------------- Bags ---------------- */

test("held and proxy slots count towards bag size; open slots don't", () => {
  const s = setup(["Ana", "Ben"]);                 // created characters are held
  assert.equal(roomBagSize(s.room), 5);
  s.run(s.host, { type: "addMember", name: "Cy" });  // proxy for someone offline
  assert.equal(partySize(s.room), 3);
  assert.equal(roomBagSize(s.room), 4);
  setHeld(s.room, s.m[1].id, false);                // Ben kicked or left: slot open
  assert.equal(partySize(s.room), 2);
  assert.equal(roomBagSize(s.room), 5);
  const proxy = s.room.members.find((m) => m.name === "Cy");
  setHeld(s.room, proxy.id, false);                 // a proxy counts until removed
  assert.equal(partySize(s.room), 2);
  s.run(s.host, { type: "removeMember", memberId: proxy.id });
  assert.equal(roomBagSize(s.room), 10);
  setHeld(s.room, s.m[1].id, true);                 // Ben reclaims
  const v = viewFor(s.room, s.as(s.m[0]), 0);
  assert.equal(v.partySize, 2);
  assert.equal(v.bagSize, 5);
});

// Win `count` drops for one member at the room's current size.
function winDrops(s, winner, count) {
  for (let i = 0; i < count; i++) {
    s.run(s.host, { type: "proposeTactic", name: `Fix ${winner.name} ${i}` });
    s.run(s.host, { type: "dropTactic", tacticId: s.room.boss.tactics.at(-1).id });
    s.run(s.as(winner), { type: "setChoice", choice: "need" });
    s.run(s.host, { type: "resolve" });
  }
}

test("when bags shrink, nothing is taken away but you can't win more until under the limit", () => {
  const s = setup(["Ana", "Ben"]); // bag size 5
  const [topic] = toVoting(s);
  s.run(s.as(s.m[1]), { type: "castThreat", ballot: { [topic]: 3 } });
  s.run(s.host, { type: "setPhase", phase: "encounters" });
  s.run(s.host, { type: "pullBoss", mobId: s.room.mobList[0].id });
  engage(s); // each won drop deals more than it adds, so the boss outlasts the test
  winDrops(s, s.m[1], 5);
  for (const name of ["Cy", "Di"]) addMember(s.room, { name, realName: `${name} R`, race: "Human", cls: "Warrior" }, s.ctx.uuid);
  assert.equal(roomBagSize(s.room), 3);           // party of 4
  const ben = () => viewFor(s.room, s.host, 0).members.find((m) => m.id === s.m[1].id);
  assert.equal(ben().slotsUsed, 5, "Ben keeps all 5");

  s.run(s.host, { type: "proposeTactic", name: "One more" });
  s.run(s.host, { type: "dropTactic", tacticId: s.room.boss.tactics.at(-1).id });
  assert.match(act(s.room, s.as(s.m[1]), { type: "setChoice", choice: "need" }, s.ctx).error, /bags are full \(5\/3\)/);
  s.run(s.as(s.m[1]), { type: "setChoice", choice: "pass" });
  s.run(s.host, { type: "resolve" });
  assert.equal(ben().slotsUsed, 5);

  // Need, then the bags shrink before the roll: Ben counts as passing.
  s.room.log.filter((t) => t.ownerId === s.m[1].id).slice(0, 3).forEach((t) => { t.done = true; });
  assert.equal(ben().slotsUsed, 2);              // back under 3: can win again
  s.run(s.host, { type: "proposeTactic", name: "Under the limit" });
  s.run(s.host, { type: "dropTactic", tacticId: s.room.boss.tactics.at(-1).id });
  s.run(s.as(s.m[1]), { type: "setChoice", choice: "need" });
  addMember(s.room, { name: "Ed", realName: "Ed R", race: "Human", cls: "Warrior" }, s.ctx.uuid);
  assert.equal(roomBagSize(s.room), 3);          // party of 5 is still 3
  s.run(s.host, { type: "resolve" });
  assert.equal(s.room.lastResult.winnerId, s.m[1].id);
  assert.equal(ben().slotsUsed, 3);
});

test("characters saved with a removed race keep their class and faction under a new race", () => {
  const room = migrateRoom({ code: "OLD5", members: [
    { id: "a", name: "Sky", realName: "A", race: "High Order", cls: "Mage" },
    { id: "b", name: "Wind", realName: "B", race: "Windshaper", cls: "Druid" },
    { id: "c", name: "Plain", realName: "C", race: "Dwarf", cls: "Priest" },
  ], log: [] });
  assert.deepEqual(room.members.map((m) => `${m.race} ${m.cls}`), ["Human Mage", "Tauren Druid", "Dwarf Priest"]);
  const s = setup(["Ana"]);
  assert.match(act(s.room, s.as(s.m[0]), { type: "editCharacter", name: "X", realName: "X", race: "Windshaper", cls: "Druid" }, s.ctx).error, /cannot be a Druid/);
});

test("rooms saved before bag sizing treat slots without a real name as proxies", () => {
  const room = migrateRoom({ code: "OLD3", members: [
    { id: "a", name: "Ana", realName: "Ana R", race: "Human", cls: "Warrior" },
    { id: "p", name: "Proxy", realName: "", race: "Human", cls: "Warrior" },
  ], log: [] });
  assert.deepEqual(room.members.map((m) => [m.proxy, m.held]), [[false, true], [true, false]]);
  assert.equal(roomBagSize(room), 5);
});

/* ---------------- End Raid and the Raid Summary ---------------- */

// A small finished session: Ben owns a Rare and an Uncommon, Cy a Common.
function playedRaid() {
  const s = setup(["Ana", "Ben", "Cy", "Di"]);
  s.room.members[3].realName = "aaron"; // sorts first, case-insensitively
  s.run(s.as(s.m[1]), { type: "postAchievement", title: "Shipped it" });
  s.run(s.as(s.m[2]), { type: "rally", achievementId: s.room.achievements[0].id });
  const [topic] = toVoting(s);
  s.run(s.as(s.m[1]), { type: "castThreat", ballot: { [topic]: 3 } });
  s.run(s.host, { type: "setPhase", phase: "encounters" });
  s.run(s.host, { type: "pullBoss" });
  const plan = ["rare", "uncommon", "common"].map((rarity) => {
    s.run(s.host, { type: "proposeTactic", name: `${rarity} fix` });
    const t = s.room.boss.tactics.at(-1);
    s.run(s.host, { type: "setTacticRarity", tacticId: t.id, rarity });
    return t;
  });
  s.run(s.host, { type: "engageBoss" });
  s.run(s.host, { type: "proposeTactic", name: "later idea" }); // never dropped: keeps the boss standing
  for (const [t, member] of [[plan[0], s.m[1]], [plan[1], s.m[1]], [plan[2], s.m[2]]]) {
    s.run(s.host, { type: "dropTactic", tacticId: t.id });
    s.run(s.as(member), { type: "setChoice", choice: "need" });
    s.run(s.host, { type: "resolve" });
  }
  s.run(s.host, { type: "tacticalVictory", note: "Covered by the CI rewrite" });
  return s;
}

test("only the host can end the raid, and not while a vote is open", () => {
  const s = setup();
  toFight(s);
  assert.match(act(s.room, s.as(s.m[1]), { type: "endRaid" }, s.ctx).error, /Only the host/);
  s.run(s.host, { type: "proposeTactic", name: "Fix it" });
  engage(s);
  s.run(s.host, { type: "dropTactic", tacticId: s.room.boss.tactics[0].id });
  assert.match(act(s.room, s.host, { type: "endRaid" }, s.ctx).error, /Resolve the current drop/);
  s.run(s.host, { type: "resolve" });
  s.run(s.host, { type: "endRaid" });
  assert.equal(s.room.boss.status, "abandoned", "a boss still being fought is abandoned");
  assert.match(buildLedger(s.room), /— Abandoned \(\d+ of \d+ HP left\)/);
});

test("a boss still in preparation when the raid ends is abandoned with no HP", () => {
  const s = setup();
  toFight(s);
  s.run(s.host, { type: "endRaid" });
  assert.equal(s.room.boss.status, "abandoned");
  assert.match(buildLedger(s.room), /— Normal \(HP never set, 0 threat\) — Abandoned, no actions/);
  assert.equal(viewFor(s.room, s.host, 0).summary.encounters[0].hpLeft, null);
});

test("after End Raid the room is read-only until the host reopens it", () => {
  const s = playedRaid();
  s.run(s.host, { type: "endRaid" });
  const attempts = [
    [s.as(s.m[1]), { type: "postAchievement", title: "Late" }],
    [s.as(s.m[1]), { type: "rally", achievementId: s.room.achievements[0].id }],
    [s.as(s.m[1]), { type: "addMob", name: "Late topic" }],
    [s.host, { type: "pullBoss" }],
    [s.host, { type: "setPhase", phase: "voting" }],
    [s.host, { type: "drop" }],
    [s.host, { type: "addMember", name: "Late" }],
    [s.as(s.m[1]), { type: "toggleTask", taskId: s.room.log[0].id }],
    [s.host, { type: "timer", target: "phase", action: "set", minutes: 5 }],
    [s.host, { type: "resetSession" }],
  ];
  for (const [actor, msg] of attempts) {
    assert.match(act(s.room, actor, msg, s.ctx).error, /raid has ended/, msg.type);
  }
  assert.match(act(s.room, s.as(s.m[1]), { type: "reopenRaid" }, s.ctx).error, /Only the host/);
  s.run(s.host, { type: "reopenRaid" });
  s.run(s.as(s.m[1]), { type: "toggleTask", taskId: s.room.log[0].id });
});

test("the summary has team totals only, and character sheets sorted by real name", () => {
  const s = playedRaid();
  assert.equal(viewFor(s.room, s.host, 0).summary, null, "no summary before the end");
  s.run(s.host, { type: "endRaid" });
  const sum = viewFor(s.room, s.as(s.m[3]), 0).summary;
  assert.deepEqual(sum.totals, {
    bossesSlain: 0, tacticalVictories: 1, tacticsOwned: 3, achievements: 1,
    gold: 185000 + 42000 + 2500, // Rare + Uncommon + Common vendor values
  });
  const [boss] = sum.encounters;
  assert.equal(boss.statusLabel, "Tactical Victory");
  assert.equal(boss.note, "Covered by the CI rewrite");
  assert.deepEqual(boss.tactics.map((t) => [t.name, t.rarity, t.owner?.realName ?? null]),
    [["rare fix", "rare", "Ben R"], ["uncommon fix", "uncommon", "Ben R"], ["common fix", "common", "Cy R"], ["later idea", "common", null]]);
  assert.deepEqual(sum.encounters.slice(1).map((e) => [e.name, e.statusLabel]), [["Slow reviews", "Not pulled"], ["Standup", "Not pulled"]]);
  assert.deepEqual(sum.achievements[0].rallies.map((r) => r.realName), ["Cy R"], "achievement ralliers are shown");
  assert.equal("rallies" in boss.tactics[0], false, "tactic ralliers stay private");

  assert.deepEqual(sum.characters.map((c) => c.realName), ["aaron", "Ana R", "Ben R", "Cy R"]);
  const ben = sum.characters.find((c) => c.realName === "Ben R");
  assert.deepEqual(ben.owned.map((t) => t.name), ["rare fix", "uncommon fix"]);
  assert.deepEqual(ben.posted.map((a) => a.title), ["Shipped it"]);
  assert.deepEqual(sum.characters.find((c) => c.realName === "Cy R").rallied.map((a) => a.title), ["Shipped it"]);
  // nothing per player that could rank people
  for (const c of sum.characters) {
    assert.deepEqual(Object.keys(c).sort(), ["cls", "faction", "id", "name", "owned", "posted", "race", "rallied", "realName"]);
  }
  assert.match(buildLedger(s.room), /> Note: Covered by the CI rewrite/);
});

test("the full summary keeps tactic rallies for the Loot Ledger", () => {
  const s = setup();
  toFight(s);
  s.run(s.as(s.m[0]), { type: "proposeTactic", name: "Fix it" });
  s.run(s.as(s.m[1]), { type: "rally", tacticId: s.room.boss.tactics[0].id });
  assert.equal(buildSummary(s.room).encounters[0].tactics[0].rallies[0].realName, "Ben R");
});

/* ---------------- Migration ---------------- */

test("rooms saved by older versions are migrated", () => {
  const room = migrateRoom({
    code: "OLD1",
    mobList: [{ id: "m1", name: "Topic", desc: "", tier: "raid" }],
    boss: { id: "b1", name: "Legacy", tier: "trash", hpMax: 4, hp: 2, slain: false, remediation: [] },
    bossLog: [{ id: "b0", name: "Older", tier: "elite", slain: true }],
    members: [], log: [],
  });
  assert.equal(room.phase, "encounters");
  assert.equal(room.persist, true);
  assert.equal("tier" in room.mobList[0], false);
  assert.equal(room.boss.tier, "normal");
  assert.equal(room.boss.status, "active");
  assert.equal(room.boss.hpMax, 100); // 1 of 4 drops was 100 HP
  assert.equal(room.boss.hp, 50);
  assert.equal(room.boss.phase, "fight", "bosses from before preparation were already fighting");
  assert.equal(room.bossLog[0].status, "slain");
  assert.doesNotThrow(() => buildLedger(room));
});

test("bosses saved before preparation load mid-fight with their HP untouched and stay fightable", () => {
  let n = 0;
  const ctx = { uuid: () => `n${++n}`, rollD: () => 50, rand: () => 0, now: 0 };
  const room = migrateRoom({
    code: "OLD4", phase: "encounters", persist: true, hpScale: 2,
    members: [{ id: "a", name: "Ana", realName: "Ana R", race: "Human", cls: "Warrior" }],
    threat: { ballots: {}, revealed: true, totals: { t1: 6, t2: 3 } },
    boss: { id: "b1", name: "Top", threat: 6, hpMax: 250, hp: 125, tier: "raid", status: "active",
      tactics: [{ id: "x", name: "Old plan", rarity: "rare", rarityFrom: null, dropped: false, rallies: [], base: "common", override: "rare", proposedById: null }] },
    bossLog: [
      { id: "bx", name: "Called", threat: 3, hpMax: 145, hp: 73, tier: "elite", status: "retreated", note: "done", tactics: [] },
      { id: "by", name: "Cut short", threat: 3, hpMax: 145, hp: 36, tier: "elite", status: "retreated", endedMidFight: true, tactics: [] },
    ],
    lootTable: [{ id: "x", name: "Old plan", rarity: "rare" }], log: [],
  });
  assert.deepEqual([room.boss.phase, room.boss.hpMax, room.boss.hp], ["fight", 250, 125]);
  assert.equal("hpScale" in room, false);
  assert.deepEqual(room.bossLog.map((b) => b.status), ["tactical", "abandoned"]);
  assert.ok(act(room, { memberId: "a", facilitator: true }, { type: "dropTactic", tacticId: "x" }, ctx).ok, "still fightable");
  act(room, { memberId: "a", facilitator: false }, { type: "setChoice", choice: "need" }, ctx);
  act(room, { memberId: "a", facilitator: true }, { type: "resolve" }, ctx);
  assert.equal(room.boss.hp, 65);
  const again = migrateRoom(JSON.parse(JSON.stringify(room)));
  assert.deepEqual([again.boss.phase, again.boss.hp], ["fight", 65]);
});

test("remediation steps migrate to tactics, keeping their picked rarity", () => {
  let n = 0;
  const ctx = { uuid: () => `new${++n}`, rollD: () => 50, rand: () => 0, now: 0 };
  const room = migrateRoom({
    code: "OLD2", phase: "encounters",
    members: [{ id: "a", name: "Ana", realName: "Ana R", race: "Human", cls: "Warrior" },
              { id: "b", name: "Ben", realName: "Ben R", race: "Human", cls: "Warrior" }],
    boss: { id: "b1", name: "Live", tier: "elite", hpMax: 300, hp: 300, status: "active", remediation: [
      { id: "s1", name: "Picked rare", rarity: "rare", rarityFrom: null, proposedBy: "Ana", dropped: false },
      { id: "s2", name: "Host changed", rarity: "epic", rarityFrom: "common", proposedBy: "Ben", dropped: true },
    ] },
    lootTable: [{ id: "s1", name: "Picked rare", rarity: "rare" }],
    log: [{ id: "t1", name: "Host changed", rarity: "epic", rarityFrom: "common", stepId: "s2", ownerId: "a", ownerName: "Ana", ownerReal: "Ana R", bossId: "b1", passedOver: false, done: false }],
  });
  assert.equal("remediation" in room.boss, false);
  assert.equal(room.boss.tactics.length, 2);
  assert.equal(room.log[0].tacticId, "s2");
  assert.equal("stepId" in room.log[0], false);
  assert.equal(room.tacticRallies, true);
  const [picked] = room.boss.tactics;
  assert.match(act(room, { memberId: "b", facilitator: false }, { type: "rally", tacticId: picked.id }, ctx).error, /before rallies/);
  act(room, { memberId: "a", facilitator: true }, { type: "addMember", name: "Cy" }, ctx);
  assert.equal(picked.rarity, "rare", "rallies don't reset a picked rarity");
  act(room, { memberId: "a", facilitator: true }, { type: "setTacticRarity", tacticId: picked.id, rarity: "uncommon" }, ctx);
  assert.equal(picked.rarityFrom, "rare");
  const ledger = buildLedger(room);
  assert.match(ledger, /^# Retro Action Plan/);
  assert.match(ledger, /Host changed — Epic \(changed from Common\) — owner: Ana R \(Ana\)/);
});
