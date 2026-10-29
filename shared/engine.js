/* =========================================================================
 * Loot Council — room engine (shared)
 * Every change to a room's game state happens here, so the server (online
 * mode) and the browser (local mode) run exactly the same game. The engine
 * knows nothing about sockets or storage: callers pass in who is acting and
 * the clock/randomness to use, and read back a per-viewer view.
 *
 *   act(room, actor, msg, ctx) -> { error } | { ok: true }
 *     actor = { memberId: string|null, facilitator: boolean }
 *     ctx   = { uuid(), rollD(max), rand(), now }
 *   tick(room, now)            -> true if a timer changed the room
 *   viewFor(room, viewer, now) -> what that viewer is allowed to see
 *   buildLedger(room)          -> the Loot Ledger markdown
 * ========================================================================= */

import {
  RARITIES, RARITY, rarityRank, tacticDamage, bossHp, tierForHp, tierLabel, BOSS_STATUS,
  THREAT_PER_PLAYER, validateThreatBallot, tallyThreat, nextBossByThreat,
  achievementRarity, tacticRarity, bagSize, bagsFull, slotsUsed, CHOICES, resolveRolls,
  RACE_CLASSES, RACE_NAMES, CLASS_NAMES, FACTION, isValidCombo, LIMITS,
} from "./rules.js";

/* ---------------- Phases ---------------- */

export const PHASES = ["achievements", "scouting", "voting", "encounters"];
export const PHASE_LABEL = {
  achievements: "Achievements",
  scouting: "Scouting",
  voting: "Threat Voting",
  encounters: "Boss Encounters",
};

/* ---------------- Room shape ---------------- */

export function createRoom({ code, persist = false, tacticRallies = true, now = Date.now() }) {
  return {
    code,
    persist,                 // saved rooms survive a server restart
    tacticRallies,           // false in local mode: one screen picks rarity instead
    phase: "achievements",
    phaseTimer: null,        // optional countdown for the current phase
    members: [],             // [{ id, name, realName, cls, race, proxy, held }]
    achievements: [],        // [{ id, title, detail, posters[], rallies[], rarity }]
    mobList: [],             // topics waiting to be pulled
    threat: { ballots: {}, revealed: false, totals: {} },
    lootTable: [],           // optional backlog of droppable items
    boss: null,              // the active encounter, with its tactics[]
    bossLog: [],             // archived encounters, in pull order
    activeDrop: null,        // { id, item, choices: { memberId: choice } }
    lastResult: null,        // result of the current/previous drop
    log: [],                 // loot log: owned tasks and passed-over items
    lastActivity: now,
  };
}

/**
 * Bring a room saved by an older version up to date: tier names, encounter
 * status, the phase model and the HP scale have all changed over time.
 */
export function migrateRoom(saved) {
  const room = { ...createRoom({ code: saved.code, persist: saved.persist !== false }), ...saved };
  room.threat = { ballots: {}, revealed: false, totals: {}, ...(saved.threat || {}) };
  room.mobList = (saved.mobList || []).map(({ tier, ...mob }) => mob); // scouts no longer pick a tier
  room.achievements = saved.achievements || [];
  // Proxy slots (added by the host) were the only ones without a real name.
  room.members = (saved.members || []).map((m) => {
    const proxy = typeof m.proxy === "boolean" ? m.proxy : !m.realName;
    return { ...m, proxy, held: typeof m.held === "boolean" ? m.held : !proxy };
  });
  const fixBoss = (b) => {
    if (!b) return b;
    const out = { ...b };
    if (out.tier === "trash") out.tier = "normal";
    if (!out.status) out.status = out.slain ? "slain" : (b === saved.boss ? "active" : "retreated");
    delete out.slain;
    // bosses from before HP was in hit points had 1/2/4 "drops to kill"
    if (out.hpMax && out.hpMax <= 4) {
      const old = { normal: 100, elite: 220, raid: 500 }[out.tier] || 220;
      out.hp = Math.round((out.hp / out.hpMax) * old);
      out.hpMax = old;
    }
    if (!("enrage" in out)) out.enrage = null;
    return out;
  };
  room.boss = fixBoss(saved.boss || null);
  room.bossLog = (saved.bossLog || []).map(fixBoss);
  for (const b of [room.boss, ...room.bossLog]) if (b) migrateTactics(b);
  room.log = (saved.log || []).map(({ stepId, ...t }) => ({ ...t, tacticId: t.tacticId || stepId || null }));
  if (typeof saved.tacticRallies !== "boolean") room.tacticRallies = true;
  if (!saved.phase) room.phase = (room.boss || room.bossLog.length) ? "encounters" : "achievements";
  return room;
}

// Remediation steps became tactics. Their rarity was picked by the proposer,
// so it's kept as-is (rallies don't apply) and any host change is an override.
function migrateTactics(boss) {
  const steps = boss.tactics || boss.remediation || [];
  delete boss.remediation;
  boss.tactics = steps.map((t) => {
    if (t.rallies) return t;
    const base = t.rarityFrom || t.rarity;
    return { ...t, proposedById: null, rallies: [], base, override: t.rarityFrom ? t.rarity : null, legacy: true };
  });
}

/* ---------------- Timers ---------------- */
// A timer is { durationMs, endsAt, remainingMs, paused }. While paused,
// remainingMs is authoritative; while running, endsAt is.

function makeTimer(minutes, now) {
  const ms = minutes * 60000;
  return { durationMs: ms, endsAt: now + ms, remainingMs: ms, paused: false };
}

export function timerRemaining(t, now) {
  if (!t) return 0;
  return t.paused ? t.remainingMs : Math.max(0, t.endsAt - now);
}

function updateTimer(t, action, minutes, now) {
  if (action === "set") return makeTimer(minutes, now);
  if (action === "clear" || !t) return null;
  const left = timerRemaining(t, now);
  if (action === "pause") return t.paused ? t : { ...t, paused: true, remainingMs: left };
  if (action === "resume") return t.paused ? { ...t, paused: false, endsAt: now + t.remainingMs } : t;
  if (action === "extend") {
    const ms = minutes * 60000;
    return t.paused
      ? { ...t, durationMs: t.durationMs + ms, remainingMs: left + ms }
      : { ...t, durationMs: t.durationMs + ms, endsAt: now + left + ms };
  }
  return t;
}

function timerView(t, now) {
  return t ? { remainingMs: timerRemaining(t, now), durationMs: t.durationMs, paused: t.paused } : null;
}

/* ---------------- Helpers ---------------- */

const findMember = (room, id) => room.members.find((m) => m.id === id) || null;
const isLive = (boss) => !!boss && boss.status === "active";
const isResolved = (room) =>
  !!room.lastResult && !!room.activeDrop && room.lastResult.dropId === room.activeDrop.id;
const liveVote = (room) => !!room.activeDrop && !isResolved(room);
const err = (error) => ({ error });
const OK = { ok: true };

function text(value, max, label, required = false) {
  const v = String(value ?? "").trim();
  if (required && !v) return { error: `Enter ${label}.` };
  if (v.length > max) return { error: `${cap(label)} is too long (${max} max).` };
  return { value: v };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const person = (m) => ({ memberId: m.id, name: m.name, realName: m.realName || "" });

/* ---------------- Rallies ---------------- */
// Achievements and tactics share one rally mechanic: you can't rally behind
// your own, rallying again takes it back, and rarity comes from the share of
// the rest of the party who rallied.

function toggleRally(item, me, ownerIds, ownError) {
  if (ownerIds.includes(me.id)) return err(ownError);
  const i = item.rallies.findIndex((r) => r.memberId === me.id);
  if (i >= 0) item.rallies.splice(i, 1);
  else item.rallies.push(person(me));
  return OK;
}

// Rallies from people who are still members, out of every member who isn't
// one of the owners.
function rallyShare(room, item, ownerIds) {
  const ids = new Set(room.members.map((m) => m.id));
  const owners = new Set(ownerIds);
  return {
    rallies: item.rallies.filter((r) => ids.has(r.memberId) && !owners.has(r.memberId)).length,
    eligible: room.members.filter((m) => !owners.has(m.id)).length,
  };
}

const achievementOwners = (a) => a.posters.map((p) => p.memberId);
const tacticOwners = (t) => (t.proposedById ? [t.proposedById] : []);

function refreshAchievements(room) {
  for (const a of room.achievements) {
    const { rallies, eligible } = rallyShare(room, a, achievementOwners(a));
    a.rarity = achievementRarity(rallies, eligible);
  }
}

// A tactic's rarity comes from rallies (or, in local mode, the picked
// starting rarity) unless the facilitator overrode it. Once it's dropped,
// it's locked. The backlog copy follows along.
function refreshTactics(room) {
  if (!isLive(room.boss)) return;
  for (const t of room.boss.tactics) {
    if (t.dropped) continue;
    let earned = t.base;
    if (room.tacticRallies && !t.legacy) {
      const { rallies, eligible } = rallyShare(room, t, tacticOwners(t));
      earned = tacticRarity(rallies, eligible);
    }
    t.rarity = t.override || earned;
    t.rarityFrom = t.override && t.override !== earned ? earned : null;
    const item = room.lootTable.find((l) => l.id === t.id);
    if (item) Object.assign(item, { rarity: t.rarity, rarityFrom: t.rarityFrom });
  }
}

function refreshRarities(room) {
  refreshAchievements(room);
  refreshTactics(room);
}

function topThreat(room) {
  return Math.max(0, ...Object.values(room.threat.totals));
}

function revealThreat(room) {
  room.threat.totals = tallyThreat(room.threat.ballots);
  room.threat.revealed = true;
}

// Archive the active boss so the export survives pulling the next one.
function archiveBoss(room) {
  const boss = room.boss;
  if (!boss || room.bossLog.some((b) => b.id === boss.id)) return;
  room.bossLog.push({ ...boss, enrage: null });
}

function endEncounter(room, status) {
  room.boss.status = status;
  room.boss.enrage = null;
}

// An enrage that ran out mid-vote waits for that drop to be resolved.
function checkEnrage(room, now) {
  const boss = room.boss;
  if (!isLive(boss) || !boss.enrage || boss.enrage.paused) return false;
  if (timerRemaining(boss.enrage, now) > 0 || liveVote(room)) return false;
  endEncounter(room, "enraged");
  return true;
}

/* ---------------- Characters ---------------- */

export function validateCharacter(msg) {
  const name = text(msg.name, LIMITS.characterName, "a character name", true);
  if (name.error) return name;
  // Real name is who's accountable for looted tasks. Required.
  const realName = text(msg.realName, LIMITS.realName, "your real name (for accountability)", true);
  if (realName.error) return realName;
  const race = RACE_NAMES.includes(msg.race) ? msg.race : "Human";
  // Enforce the Forever race/class matrix so a tampered client can't cheat it.
  if (!isValidCombo(race, msg.cls)) return err(`A ${race} cannot be a ${msg.cls || "—"} in WoW: Forever.`);
  return { fields: { name: name.value, realName: realName.value, race, cls: msg.cls } };
}

/* ---------------- Party size and bags ---------------- */
// A slot is in the party if it's a proxy (added by the host for someone who
// isn't online) or someone holds it. A player who drops their connection
// still holds their slot ("Away") until they leave or are kicked; open slots
// don't count. Bag size follows the party size live.

export const inParty = (m) => !!(m.proxy || m.held);

export function partySize(room) {
  return room.members.filter(inParty).length;
}

export function roomBagSize(room) {
  return bagSize(partySize(room));
}

// The server marks a slot held when someone claims it, and released when
// they leave or are kicked.
export function setHeld(room, memberId, held) {
  const member = findMember(room, memberId);
  if (member) member.held = !!held;
}

export function addMember(room, fields, uuid) {
  const member = { id: uuid(), proxy: false, held: true, ...fields };
  room.members.push(member);
  refreshRarities(room);
  return member;
}

export function updateMember(room, member, fields) {
  Object.assign(member, fields);
}

/* ---------------- Actions ---------------- */

const actions = {
  /* ----- party ----- */

  // Facilitator adds a proxy slot for someone who isn't online.
  addMember(room, actor, msg, ctx) {
    if (!actor.facilitator) return err("Only the host can add party slots.");
    const name = text(msg.name, LIMITS.characterName, "a name", true);
    if (name.error) return name;
    const cls = CLASS_NAMES.includes(msg.cls) ? msg.cls : "Warrior";
    const race = RACE_NAMES.find((r) => RACE_CLASSES[r].includes(cls));
    addMember(room, { name: name.value, realName: "", race, cls, proxy: true, held: false }, ctx.uuid);
    return OK;
  },

  removeMember(room, actor, msg) {
    if (!actor.facilitator) return err("Only the host can remove party slots.");
    room.members = room.members.filter((m) => m.id !== msg.memberId);
    if (room.activeDrop) delete room.activeDrop.choices[msg.memberId];
    delete room.threat.ballots[msg.memberId];
    refreshRarities(room);
    return OK;
  },

  /* ----- phases and timers ----- */

  setPhase(room, actor, msg) {
    if (!actor.facilitator) return err("Only the host can change the phase.");
    if (!PHASES.includes(msg.phase)) return err("Unknown phase.");
    if (msg.phase === room.phase) return OK;
    // moving on to the fight reveals any threat that hasn't been revealed yet
    if (msg.phase === "encounters" && !room.threat.revealed) revealThreat(room);
    room.phase = msg.phase;
    room.phaseTimer = null;
    return OK;
  },

  // target: "phase" | "enrage"; action: set | pause | resume | extend | clear
  timer(room, actor, msg, ctx) {
    if (!actor.facilitator) return err("Only the host can run timers.");
    const needsMinutes = msg.action === "set" || msg.action === "extend";
    if (!["set", "pause", "resume", "extend", "clear"].includes(msg.action)) return err("Unknown timer action.");
    if (needsMinutes && !(Number.isInteger(msg.minutes) && msg.minutes >= 1 && msg.minutes <= LIMITS.timerMinutes)) {
      return err(`Timers run from 1 to ${LIMITS.timerMinutes} minutes.`);
    }
    if (msg.target === "phase") {
      room.phaseTimer = updateTimer(room.phaseTimer, msg.action, msg.minutes, ctx.now);
    } else if (msg.target === "enrage") {
      if (!isLive(room.boss)) return err("There's no boss engaged.");
      room.boss.enrage = updateTimer(room.boss.enrage, msg.action, msg.minutes, ctx.now);
    } else {
      return err("Unknown timer.");
    }
    return OK;
  },

  /* ----- achievements ----- */

  postAchievement(room, actor, msg, ctx) {
    if (room.phase !== "achievements") return err("Achievements are closed.");
    const me = findMember(room, actor.memberId);
    if (!me) return err("Create a character before posting achievements.");
    const title = text(msg.title, LIMITS.achievementTitle, "a title", true);
    if (title.error) return title;
    const detail = text(msg.detail, LIMITS.achievementDetail, "the detail");
    if (detail.error) return detail;
    const key = title.value.toLowerCase();
    if (room.achievements.some((a) => a.title.toLowerCase() === key)) {
      return err(`"${title.value}" is already on the board. Rally behind it instead.`);
    }
    room.achievements.push({
      id: ctx.uuid(), title: title.value, detail: detail.value,
      posters: [person(me)], rallies: [], rarity: "rare",
    });
    refreshAchievements(room);
    return OK;
  },

  // Rally (or un-rally) behind someone else's achievement or tactic.
  rally(room, actor, msg) {
    const me = findMember(room, actor.memberId);
    if (!me) return err("Create a character before rallying.");
    let result;
    if (msg.tacticId) {
      if (!room.tacticRallies) return err("Pick a tactic's rarity when proposing it instead.");
      const t = isLive(room.boss) && room.boss.tactics.find((x) => x.id === msg.tacticId);
      if (!t) return err("That tactic no longer exists.");
      if (t.dropped) return err("That tactic has already been dropped.");
      if (t.legacy) return err("That tactic's rarity was set before rallies.");
      result = toggleRally(t, me, tacticOwners(t), "You can't rally behind your own tactic.");
    } else {
      if (room.phase !== "achievements") return err("Achievements are closed.");
      const a = room.achievements.find((x) => x.id === msg.achievementId);
      if (!a) return err("That achievement no longer exists.");
      result = toggleRally(a, me, achievementOwners(a), "You can't rally behind your own achievement.");
    }
    refreshRarities(room);
    return result;
  },

  // Facilitator folds a near-duplicate into another: posters and ralliers combine.
  mergeAchievements(room, actor, msg) {
    if (!actor.facilitator) return err("Only the host can merge achievements.");
    const target = room.achievements.find((a) => a.id === msg.targetId);
    const source = room.achievements.find((a) => a.id === msg.sourceId);
    if (!target || !source) return err("That achievement no longer exists.");
    if (target === source) return err("Pick two different achievements to merge.");
    for (const p of source.posters) {
      if (!target.posters.some((x) => x.memberId === p.memberId)) target.posters.push(p);
    }
    const posterIds = new Set(target.posters.map((p) => p.memberId));
    const rallies = [...target.rallies, ...source.rallies];
    target.rallies = rallies.filter((r, i) =>
      !posterIds.has(r.memberId) && rallies.findIndex((x) => x.memberId === r.memberId) === i);
    if (source.detail && source.detail !== target.detail) {
      target.detail = target.detail ? `${target.detail}\n\n${source.detail}` : source.detail;
    }
    room.achievements = room.achievements.filter((a) => a !== source);
    refreshAchievements(room);
    return OK;
  },

  // A poster can withdraw their own while the phase is open; the host, any time.
  removeAchievement(room, actor, msg) {
    const a = room.achievements.find((x) => x.id === msg.achievementId);
    if (!a) return OK;
    const mine = a.posters.some((p) => p.memberId === actor.memberId);
    if (!actor.facilitator && !(mine && room.phase === "achievements")) {
      return err("Only the poster (while achievements are open) or the host can remove it.");
    }
    room.achievements = room.achievements.filter((x) => x !== a);
    return OK;
  },

  /* ----- scouting ----- */

  addMob(room, actor, msg, ctx) {
    if (room.phase === "achievements") return err("Scouting hasn't opened yet.");
    const me = findMember(room, actor.memberId);
    if (!me && !actor.facilitator) return err("Create a character before scouting topics.");
    const name = text(msg.name, LIMITS.topicName, "the topic (boss name)", true);
    if (name.error) return name;
    const desc = text(msg.desc, LIMITS.topicDesc, "the description");
    if (desc.error) return desc;
    const key = name.value.toLowerCase();
    if (room.mobList.some((m) => m.name.toLowerCase() === key)) {
      return err(`"${name.value}" is already on the Mob List.`);
    }
    room.mobList.push({
      id: ctx.uuid(), name: name.value, desc: desc.value,
      addedById: me ? me.id : null,
      addedBy: me ? me.name : "Facilitator",
      addedReal: me ? (me.realName || "") : "",
    });
    return OK;
  },

  removeMob(room, actor, msg) {
    const mob = room.mobList.find((m) => m.id === msg.mobId);
    if (!mob) return OK;
    if (!actor.facilitator && mob.addedById !== actor.memberId) {
      return err("Only the scout who added it (or the host) can remove it.");
    }
    room.mobList = room.mobList.filter((m) => m !== mob);
    for (const ballot of Object.values(room.threat.ballots)) delete ballot[mob.id];
    return OK;
  },

  /* ----- threat voting ----- */

  castThreat(room, actor, msg) {
    if (room.phase !== "voting") return err("Threat voting isn't open.");
    if (room.threat.revealed) return err("Threat has been revealed; voting is closed.");
    if (!findMember(room, actor.memberId)) return err("Create a character before voting.");
    const check = validateThreatBallot(msg.ballot, room.mobList.map((m) => m.id), THREAT_PER_PLAYER);
    if (!check.ok) return err(check.error);
    if (check.total === 0) delete room.threat.ballots[actor.memberId];
    else room.threat.ballots[actor.memberId] = check.ballot;
    return OK;
  },

  revealThreat(room, actor) {
    if (!actor.facilitator) return err("Only the host can reveal threat.");
    if (room.phase !== "voting") return err("Threat voting isn't open.");
    revealThreat(room);
    return OK;
  },

  reopenVoting(room, actor) {
    if (!actor.facilitator) return err("Only the host can reopen voting.");
    room.threat.revealed = false;
    room.phase = "voting";
    return OK;
  },

  /* ----- encounters ----- */

  // Pull a specific topic (mobId), or the highest-threat one left.
  pullBoss(room, actor, msg, ctx) {
    if (!actor.facilitator) return err("Only the host can pull a boss.");
    if (room.phase !== "encounters") return err("Move on to Boss Encounters first.");
    if (isLive(room.boss)) return err("Finish the current boss first.");
    let topic;
    if (msg.mobId) {
      topic = room.mobList.find((m) => m.id === msg.mobId);
      if (!topic) return err("That topic is no longer on the Mob List.");
    } else {
      topic = nextBossByThreat(room.mobList, room.threat.totals, ctx.rand);
      if (!topic) return err("No topics with threat are left. Pull one by hand from the Mob List.");
    }
    room.mobList = room.mobList.filter((m) => m !== topic);
    archiveBoss(room);
    const threat = room.threat.totals[topic.id] || 0;
    const hpMax = bossHp(threat, topThreat(room));
    room.boss = {
      id: ctx.uuid(), mobId: topic.id, name: topic.name, desc: topic.desc,
      scoutedBy: topic.addedBy || "", threat, hpMax, hp: hpMax, tier: tierForHp(hpMax).tier,
      status: "active", tactics: [], enrage: null,
    };
    room.activeDrop = null;
    room.lastResult = null;
    return OK;
  },

  // The room agrees the problem is covered: the boss retreats.
  callIt(room, actor) {
    if (!actor.facilitator) return err("Only the host can call it.");
    if (!isLive(room.boss)) return err("There's no boss engaged.");
    if (liveVote(room)) return err("Resolve the current drop first.");
    endEncounter(room, "retreated");
    return OK;
  },

  // Clear a finished encounter off the stage.
  clearStage(room, actor) {
    if (!actor.facilitator) return err("Only the host can clear the stage.");
    if (!room.boss) return OK;
    if (isLive(room.boss)) return err("The boss is still engaged. Call it first.");
    archiveBoss(room);
    room.boss = null;
    room.activeDrop = null;
    room.lastResult = null;
    return OK;
  },

  // Anyone can propose a tactic for the live boss. Online it starts at
  // Common and rallies raise it; in local mode the proposer picks a rarity.
  proposeTactic(room, actor, msg, ctx) {
    if (!isLive(room.boss)) return err("Pull a boss before proposing a tactic.");
    const name = text(msg.name, LIMITS.tacticName, "a tactic", true);
    if (name.error) return name;
    const desc = text(msg.desc, LIMITS.tacticDesc, "the detail");
    if (desc.error) return desc;
    const base = !room.tacticRallies && RARITIES.includes(msg.rarity) ? msg.rarity : "common";
    const me = findMember(room, actor.memberId);
    const tactic = {
      id: ctx.uuid(), name: name.value, desc: desc.value,
      proposedById: me ? me.id : null,
      proposedBy: me ? me.name : "Facilitator",
      proposedReal: me ? (me.realName || "") : "",
      rallies: [], base, override: null, rarity: base, rarityFrom: null,
      dropped: false,
    };
    room.boss.tactics.push(tactic);
    // also add it to the backlog so it's reusable; it shares the tactic's id
    room.lootTable.push({ id: tactic.id, name: tactic.name, rarity: base, desc: tactic.desc });
    refreshTactics(room);
    return OK;
  },

  // Facilitator's rarity check before a tactic is dropped. The override
  // sticks until they hand it back to rallies (rarity: "rallies"); the log
  // shows what rallies had made it.
  setTacticRarity(room, actor, msg) {
    if (!actor.facilitator) return err("Only the host can change a tactic's rarity.");
    const backToRallies = msg.rarity === "rallies";
    if (!backToRallies && !RARITIES.includes(msg.rarity)) return err("Unknown rarity.");
    const tactic = isLive(room.boss) && room.boss.tactics.find((t) => t.id === msg.tacticId);
    if (!tactic) return err("That tactic no longer exists.");
    if (tactic.dropped) return err("That tactic has already been dropped.");
    tactic.override = backToRallies ? null : msg.rarity;
    refreshTactics(room);
    return OK;
  },

  dropTactic(room, actor, msg, ctx) {
    if (!actor.facilitator) return err("Only the host can drop loot.");
    if (!isLive(room.boss)) return err("No live boss to attack.");
    if (liveVote(room)) return err("Resolve the current drop before dropping another.");
    const tactic = room.boss.tactics.find((t) => t.id === msg.tacticId);
    if (!tactic) return err("That tactic no longer exists.");
    if (tactic.dropped) return err("That tactic has already been dropped.");
    tactic.dropped = true;
    room.activeDrop = { id: ctx.uuid(), item: dropItem(tactic), choices: {} };
    room.lastResult = null;
    return OK;
  },

  addLoot(room, actor, msg, ctx) {
    if (!actor.facilitator) return err("Only the host can edit the loot table.");
    const name = text(msg.name, LIMITS.lootName, "an item name", true);
    if (name.error) return name;
    const desc = text(msg.desc, LIMITS.lootDesc, "the description");
    if (desc.error) return desc;
    const rarity = RARITIES.includes(msg.rarity) ? msg.rarity : "common";
    room.lootTable.push({ id: ctx.uuid(), name: name.value, rarity, desc: desc.value });
    return OK;
  },

  removeLoot(room, actor, msg) {
    if (!actor.facilitator) return err("Only the host can edit the loot table.");
    room.lootTable = room.lootTable.filter((l) => l.id !== msg.lootId);
    return OK;
  },

  // Drop a backlog item (a specific one, or a random unclaimed one).
  drop(room, actor, msg, ctx) {
    if (!actor.facilitator) return err("Only the host can drop loot.");
    if (!isLive(room.boss)) return err("Pull a boss before dropping loot.");
    if (liveVote(room)) return err("Resolve the current drop before dropping another.");
    if (room.lootTable.length === 0) return err("The loot table is empty.");
    const pool = unclaimedLoot(room);
    if (pool.length === 0) return err("Every backlog item has already been claimed.");
    const item = msg.lootId
      ? pool.find((l) => l.id === msg.lootId)
      : pool[Math.min(pool.length - 1, Math.floor(ctx.rand() * pool.length))];
    if (!item) return err("That item has already been claimed or no longer exists.");
    room.activeDrop = { id: ctx.uuid(), item: { ...item }, choices: {} };
    room.lastResult = null;
    const tactic = room.boss.tactics.find((t) => t.id === item.id);
    if (tactic) tactic.dropped = true;
    return OK;
  },

  // A player sets their own Need/Greed/Pass; picking it again clears it.
  setChoice(room, actor, msg) {
    if (!room.activeDrop || isResolved(room)) return err("There's nothing to vote on.");
    const memberId = actor.memberId;
    if (!findMember(room, memberId)) return err("Claim a party slot before voting.");
    if (!CHOICES.includes(msg.choice)) return err("Unknown choice.");
    const size = roomBagSize(room);
    if (msg.choice !== "pass" && bagsFull(room.log, memberId, size)) {
      return err(`Your bags are full (${slotsUsed(room.log, memberId)}/${size}). Complete a task to free a slot.`);
    }
    const choices = room.activeDrop.choices;
    if (choices[memberId] === msg.choice) delete choices[memberId];
    else choices[memberId] = msg.choice;
    return OK;
  },

  resolve(room, actor, msg, ctx) {
    if (!actor.facilitator) return err("Only the host can resolve a drop.");
    if (!liveVote(room)) return err("There's nothing to resolve.");
    resolveDrop(room, ctx);
    return OK;
  },

  toggleTask(room, actor, msg) {
    const t = room.log.find((x) => x.id === msg.taskId && !x.passedOver);
    if (!t) return err("That task no longer exists.");
    t.done = !t.done;
    return OK;
  },

  // Start over with the same party.
  resetSession(room, actor) {
    if (!actor.facilitator) return err("Only the host can reset the session.");
    const fresh = createRoom({ code: room.code, persist: room.persist, tacticRallies: room.tacticRallies });
    for (const key of Object.keys(fresh)) if (key !== "members") room[key] = fresh[key];
    return OK;
  },
};

// Backlog items nobody owns yet (passed-over items stay droppable).
export function unclaimedLoot(room) {
  const claimed = new Set(room.log.filter((t) => !t.passedOver).map((t) => t.tacticId));
  return room.lootTable.filter((l) => !claimed.has(l.id));
}

// What goes on the table: the item, without who rallied behind it.
function dropItem(tactic) {
  const { id, name, desc, rarity, rarityFrom } = tactic;
  return { id, name, desc, rarity, rarityFrom };
}

function resolveDrop(room, ctx) {
  const drop = room.activeDrop;
  // A player whose bags filled up (or shrank) after voting is treated as
  // passing, so nobody can go over the bag size.
  const size = roomBagSize(room);
  const entrants = room.members.map((m) => {
    const full = bagsFull(room.log, m.id, size);
    return {
      memberId: m.id, name: m.name, realName: m.realName || "",
      choice: full ? "pass" : (drop.choices[m.id] || "pass"),
      bagsFull: full,
    };
  });
  const { rolls, winner, context } = resolveRolls(entrants, ctx.rollD);

  room.lastResult = {
    dropId: drop.id,
    itemName: drop.item.name,
    rarity: drop.item.rarity,
    rolls,
    winnerId: winner ? winner.memberId : null,
    winnerName: winner ? winner.name : null,
    winnerReal: winner ? winner.realName : null,
    winnerContext: context,
    damage: null, // set below if a live boss took the hit
  };

  // Owned tasks and passed-over items both go in the log, so the register
  // keeps a trace of everything that was discussed.
  room.log.push({
    id: ctx.uuid(),
    name: drop.item.name,
    rarity: drop.item.rarity,
    rarityFrom: drop.item.rarityFrom || null, // set if the host changed it
    ownerId: winner ? winner.memberId : null,
    ownerName: winner ? winner.name : "",
    ownerReal: winner ? winner.realName : "",
    bossId: room.boss ? room.boss.id : null,
    tacticId: drop.item.id || null,
    passedOver: !winner,
    done: false,
  });

  if (isLive(room.boss)) {
    const damage = tacticDamage(drop.item.rarity, !!winner);
    room.boss.hp = Math.max(0, room.boss.hp - damage);
    room.lastResult.damage = damage;
    if (room.boss.hp <= 0) endEncounter(room, "slain");
    else checkEnrage(room, ctx.now);
  }
}

export function act(room, actor, msg, ctx) {
  const handler = actions[msg && msg.type];
  if (!handler) return err("Unknown action.");
  const result = handler(room, actor, msg, ctx);
  if (result && result.ok) room.lastActivity = ctx.now;
  return result;
}

export function hasAction(type) {
  return Object.prototype.hasOwnProperty.call(actions, type);
}

// Run timers. Returns true if the room changed (a boss enraged).
export function tick(room, now) {
  return checkEnrage(room, now);
}

/* ---------------- Views (what each viewer may see) ---------------- */

/**
 * While a drop is unresolved only a tally of Need/Greed/Pass is shared, and
 * threat ballots stay secret until revealed. Rally names and counts never
 * leave the engine except in the Loot Ledger; the board only shows rarity.
 * `revealChoices` exposes everyone's Need/Greed/Pass (single-screen local mode).
 */
export function viewFor(room, viewer, now, { revealChoices = false } = {}) {
  const resolved = isResolved(room);
  const drop = room.activeDrop;
  const tally = { need: 0, greed: 0, pass: 0, undecided: 0 };
  if (drop) {
    for (const m of room.members) {
      const c = drop.choices[m.id];
      if (c) tally[c]++; else tally.undecided++;
    }
  }
  const ballots = room.threat.ballots;
  const totals = room.threat.totals;

  return {
    type: "state",
    room: room.code,
    persist: room.persist,
    phase: room.phase,
    phaseTimer: timerView(room.phaseTimer, now),
    you: {
      memberId: viewer.memberId,
      facilitator: !!viewer.facilitator,
      myChoice: drop && viewer.memberId ? (drop.choices[viewer.memberId] || null) : null,
      myBallot: (viewer.memberId && ballots[viewer.memberId]) || {},
    },
    members: room.members.map((m) => ({
      id: m.id, name: m.name, realName: m.realName || "", cls: m.cls, race: m.race,
      faction: FACTION[m.race] || null,
      hasVoted: drop ? !!drop.choices[m.id] : false,
      hasThreatVoted: !!ballots[m.id],
      slotsUsed: slotsUsed(room.log, m.id),
      proxy: !!m.proxy,
      held: !!m.held,
    })),
    achievements: room.achievements.map((a) => ({
      id: a.id, title: a.title, detail: a.detail, rarity: a.rarity,
      posters: a.posters.map((p) => ({ name: p.name, realName: p.realName })),
      mine: a.posters.some((p) => p.memberId === viewer.memberId),
      rallied: a.rallies.some((r) => r.memberId === viewer.memberId),
    })),
    mobList: room.mobList.map((m) => ({ ...m, threat: room.threat.revealed ? (totals[m.id] || 0) : null })),
    threat: {
      budget: THREAT_PER_PLAYER,
      revealed: room.threat.revealed,
      voters: Object.keys(ballots).length,
    },
    boss: room.boss ? { ...bossView(room, room.boss, viewer), enrage: timerView(room.boss.enrage, now) } : null,
    bossLog: room.bossLog.map((b) => bossView(room, b, viewer)),
    lootTable: room.lootTable,
    activeDrop: drop ? { id: drop.id, item: drop.item } : null,
    choices: revealChoices && drop && !resolved ? { ...drop.choices } : null,
    tally,
    resolved,
    lastResult: resolved ? room.lastResult : null,
    log: room.log,
    partySize: partySize(room),
    bagSize: roomBagSize(room),
  };
}

function bossView(room, boss, viewer) {
  return {
    ...boss,
    tactics: boss.tactics.map(({ rallies, base, override, legacy, ...t }) => ({
      ...t,
      mine: !!viewer.memberId && t.proposedById === viewer.memberId,
      rallied: rallies.some((r) => r.memberId === viewer.memberId),
      overridden: !!override,
      rallyable: room.tacticRallies && !legacy && !t.dropped && isLive(boss),
    })),
  };
}

/* ---------------- Loot Ledger export ---------------- */

const who = (p) => (p.realName ? `${p.realName} (${p.name})` : p.name);
const rarityText = (item) => {
  const label = (RARITY[item.rarity] || RARITY.uncommon).label;
  return item.rarityFrom ? `${label} (changed from ${RARITY[item.rarityFrom].label})` : label;
};

export function buildLedger(room) {
  // Plain language for sharing outside the retro: tactics are "actions".
  const out = ["# Retro Action Plan"];

  if (room.achievements.length) {
    out.push("", "## Achievements");
    const sorted = room.achievements
      .map((a, i) => ({ a, i }))
      .sort((x, y) => rarityRank(y.a.rarity) - rarityRank(x.a.rarity) || x.i - y.i)
      .map((x) => x.a);
    for (const a of sorted) {
      const rallied = a.rallies.length ? `; rallied by ${a.rallies.map(who).join(", ")}` : "";
      out.push(`- **${a.title}** (${RARITY[a.rarity].label}) — posted by ${a.posters.map(who).join(", ")}${rallied}`);
      if (a.detail) out.push(`  ${a.detail.replace(/\n+/g, " ")}`);
    }
  }

  const bosses = [...room.bossLog];
  if (room.boss && !bosses.some((b) => b.id === room.boss.id)) bosses.push(room.boss);
  for (const b of bosses) {
    const actions = room.log.filter((t) => t.bossId === b.id && !t.passedOver);
    const open = actions.filter((t) => !t.done).length;
    const count = actions.length ? `${open} of ${actions.length} actions open` : "no actions";
    const threat = room.threat.revealed || b.threat ? `, ${b.threat || 0} threat` : "";
    const hp = b.hpMax ? ` (${b.hpMax} HP${threat})` : "";
    out.push("", `## ${b.name} — ${tierLabel(b.tier)}${hp} — ${BOSS_STATUS[b.status] || "In progress"}, ${count}`);
    if (b.desc) out.push(`_${b.desc}_`);
    const tactics = b.tactics || [];
    if (tactics.length === 0) { out.push("_No actions proposed._"); continue; }
    for (const a of tactics) {
      const owned = room.log.find((t) => t.tacticId === a.id && !t.passedOver);
      const passed = !owned && room.log.some((t) => t.tacticId === a.id && t.passedOver);
      const rallied = a.rallies.length ? `; rallied by ${a.rallies.map(who).join(", ")}` : "";
      if (owned) out.push(`- [${owned.done ? "x" : " "}] ${a.name} — ${rarityText(a)} — owner: ${who({ name: owned.ownerName, realName: owned.ownerReal })}${rallied}`);
      else out.push(`- [ ] ${a.name} — ${rarityText(a)} — _${passed ? "passed over" : "proposed, unowned"}_${rallied}`);
    }
  }

  if (room.mobList.length) {
    out.push("", "## Not pulled");
    for (const m of room.mobList) {
      const threat = room.threat.revealed ? ` — ${room.threat.totals[m.id] || 0} threat` : "";
      out.push(`- ${m.name}${threat} — raised by ${who({ name: m.addedBy, realName: m.addedReal })}`);
    }
  }

  const known = new Set(bosses.flatMap((b) => (b.tactics || []).map((a) => a.id)));
  const orphans = room.log.filter((t) => !t.passedOver && !known.has(t.tacticId));
  if (orphans.length) {
    out.push("", "## Other looted items");
    for (const t of orphans) {
      out.push(`- [${t.done ? "x" : " "}] ${t.name} — ${rarityText(t)} — owner: ${who({ name: t.ownerName, realName: t.ownerReal })}`);
    }
  }
  return out.join("\n") + "\n";
}
