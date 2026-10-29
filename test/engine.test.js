import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRoom, migrateRoom, act, tick, viewFor, buildLedger, addMember, setHeld, partySize, roomBagSize,
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

test("bosses are pulled highest threat first with sliding HP; zero threat is skipped", () => {
  const s = setup();
  const [ci, reviews] = toVoting(s);
  s.run(s.as(s.m[1]), { type: "castThreat", ballot: { [ci]: 3 } });
  s.run(s.as(s.m[2]), { type: "castThreat", ballot: { [ci]: 1, [reviews]: 2 } });
  s.run(s.host, { type: "setPhase", phase: "encounters" }); // reveals automatically
  s.run(s.host, { type: "pullBoss" });
  assert.equal(s.room.boss.name, "Flaky CI");
  assert.equal(s.room.boss.hpMax, 500);
  assert.equal(s.room.boss.tier, "raid");
  s.run(s.host, { type: "callIt" });
  s.run(s.host, { type: "pullBoss" });
  assert.equal(s.room.boss.name, "Slow reviews");
  assert.equal(s.room.boss.hpMax, Math.round(60 + (2 / 4) * 440)); // 280, Elite
  assert.equal(s.room.boss.tier, "elite");
  s.run(s.host, { type: "callIt" });
  const none = act(s.room, s.host, { type: "pullBoss" }, s.ctx);
  assert.match(none.error, /No topics with threat/);
  assert.match(buildLedger(s.room), /## Not pulled\n- Standup — 0 threat/);
});

/* ---------------- Encounters ---------------- */

function toFight(s) {
  toVoting(s);
  s.run(s.host, { type: "setPhase", phase: "encounters" });
  s.run(s.host, { type: "pullBoss", mobId: s.room.mobList[0].id });
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

test("calling it makes the boss retreat; the ledger shows status and open actions", () => {
  const s = setup();
  toFight(s);
  s.run(s.as(s.m[1]), { type: "proposeTactic", name: "Fix it" });
  s.run(s.host, { type: "dropTactic", tacticId: s.room.boss.tactics[0].id });
  s.run(s.as(s.m[1]), { type: "setChoice", choice: "need" });
  s.run(s.host, { type: "resolve" });
  s.run(s.host, { type: "callIt" });
  assert.equal(s.room.boss.status, "retreated");
  assert.match(buildLedger(s.room), /— Retreated, 1 of 1 actions open/);
});

test("an enrage that runs out mid-vote waits for the drop to resolve", () => {
  const s = setup();
  toFight(s);
  s.run(s.host, { type: "timer", target: "enrage", action: "set", minutes: 1 });
  s.run(s.as(s.m[1]), { type: "proposeTactic", name: "Fix it" });
  s.run(s.host, { type: "dropTactic", tacticId: s.room.boss.tactics[0].id });
  assert.equal(tick(s.room, 61_000), false, "doesn't enrage during a live vote");
  s.ctx.now = 61_000;
  s.run(s.host, { type: "resolve" });
  assert.equal(s.room.boss.status, "enraged");
});

test("a paused enrage timer doesn't run out", () => {
  const s = setup();
  toFight(s);
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
  s.run(s.as(s.m[1]), { type: "castThreat", ballot: { [topic]: 3 } }); // 500 HP: survives the test
  s.run(s.host, { type: "setPhase", phase: "encounters" });
  s.run(s.host, { type: "pullBoss", mobId: s.room.mobList[0].id });
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

test("rooms saved before bag sizing treat slots without a real name as proxies", () => {
  const room = migrateRoom({ code: "OLD3", members: [
    { id: "a", name: "Ana", realName: "Ana R", race: "Human", cls: "Warrior" },
    { id: "p", name: "Proxy", realName: "", race: "Human", cls: "Warrior" },
  ], log: [] });
  assert.deepEqual(room.members.map((m) => [m.proxy, m.held]), [[false, true], [true, false]]);
  assert.equal(roomBagSize(room), 5);
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
  assert.equal(room.boss.hpMax, 100);
  assert.equal(room.boss.hp, 50);
  assert.equal(room.bossLog[0].status, "slain");
  assert.doesNotThrow(() => buildLedger(room));
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
