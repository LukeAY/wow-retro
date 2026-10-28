/* =========================================================================
 * Loot Council — networked server
 * Express serves the client; a ws server holds sessions keyed by room code.
 * The server is the source of truth and does the hidden Need/Greed/Pass rolls,
 * so choices and roll values stay secret until a resolve is broadcast.
 * ========================================================================= */

import express from "express";
import { WebSocketServer } from "ws";
import { randomUUID, randomInt } from "node:crypto";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "rooms.json");

/* ---------------- Static client ---------------- */
const app = express();
// serve the whole retros folder so both the local page and networked client work
app.use(express.static(path.join(__dirname, "..")));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ---------------- In-memory session store ---------------- */
/**
 * rooms: Map<code, Room>
 * Room = {
 *   code, facilitatorId,
 *   lootTable: [{id,name,rarity,desc}],
 *   mobList:   [{id,name,desc,tier,addedById,addedBy,addedReal}], // topics waiting to be pulled
 *   members:   [{id, name, cls, clientId|null, connected}],
 *   boss: { id, name, tier, hpMax, hp, slain } | null,  // active encounter
 *   activeDrop: { id, item, choices:{memberId:'need'|'greed'|'pass'} } | null,
 *   lastResult: {...} | null,
 *   log: [{id,name,rarity,ownerId,ownerName,done}],
 *   clients: Map<clientId, { ws, role:'facilitator'|'player', memberId|null }>
 * }
 */
const rooms = new Map();

const RARITIES = ["poor", "common", "uncommon", "rare", "epic", "legendary"];

/**
 * Boss tiers (shared with the local client). A boss is a retro topic with a
 * pool of hit points. Each resolved step damages it by the step's rarity, so
 * a raid boss needs several weighty fixes while a trash mob falls to one.
 */
const BOSS_TIERS = {
  trash: { label: "Trash mob", hp: 100 },
  elite: { label: "Elite",     hp: 220 },
  raid:  { label: "Raid boss", hp: 500 },
};
// Damage a resolved step deals, by its rarity (priority): heavier fixes hit
// harder. Only owned steps count; one everyone passed on deals no damage.
const STEP_DAMAGE = { poor: 15, common: 30, uncommon: 50, rare: 80, epic: 120, legendary: 200 };
function stepDamage(rarity, owned) {
  return owned ? (STEP_DAMAGE[rarity] || STEP_DAMAGE.uncommon) : 0;
}
// Bosses saved before health was in hit points (1/2/4 "drops to kill") are
// rescaled to the current pools, keeping the same fraction of health left.
function rescaleBoss(boss) {
  if (!boss || !BOSS_TIERS[boss.tier] || boss.hpMax > 4) return boss;
  const hpMax = BOSS_TIERS[boss.tier].hp;
  return { ...boss, hpMax, hp: Math.round((boss.hp / boss.hpMax) * hpMax) };
}
/**
 * Pulling from the mob list is weighted by tier. The first pulls lean on these
 * opening odds (mostly trash, the odd raid boss), then every tier's weight
 * slides toward 1 as the list empties, so later pulls are an even shuffle.
 */
const OPENING_WEIGHTS = { trash: 6, elite: 3, raid: 1 };
function pickMob(room) {
  // bosses pulled so far, including the current one if it isn't archived yet
  const pulled = room.bossLog.length +
    (room.boss && !room.bossLog.some((b) => b.id === room.boss.id) ? 1 : 0);
  const progress = pulled / (pulled + room.mobList.length);
  const weights = room.mobList.map((m) => 1 + (OPENING_WEIGHTS[m.tier] - 1) * (1 - progress));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return room.mobList[i];
  }
  return room.mobList[room.mobList.length - 1];
}
// Bag slots: the most open (not done) tasks one player can own at once.
// Completing a task frees its slot. A full player can't Need/Greed.
const MAX_SLOTS = 6;
function slotsUsed(room, memberId) {
  return room.log.filter((t) => t.ownerId === memberId && !t.passedOver && !t.done).length;
}
// Backlog items nobody owns yet. Owned log entries carry the item's id as
// stepId; passed-over items have no owner, so they stay droppable.
function unclaimedLoot(room) {
  const claimed = new Set(room.log.filter((t) => !t.passedOver).map((t) => t.stepId));
  return room.lootTable.filter((l) => !claimed.has(l.id));
}
/**
 * World of Warcraft: Forever race/class matrix (single source of truth).
 * Classic's 8 races + the two Skyborne allied-race variants, including the
 * six Forever additions (Human Hunter, Dwarf Shaman, Gnome Priest, Orc Mage,
 * Troll Warlock, Undead Paladin). Skyborne is modelled as its two
 * faction-specific variants: High Order (Alliance) and Windshaper (Horde).
 */
const RACE_CLASSES = {
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
const FACTION = {
  "Human": "Alliance", "Dwarf": "Alliance", "Night Elf": "Alliance",
  "Gnome": "Alliance", "High Order": "Alliance",
  "Orc": "Horde", "Tauren": "Horde", "Troll": "Horde",
  "Undead": "Horde", "Windshaper": "Horde",
};
const RACE_NAMES = Object.keys(RACE_CLASSES);

// Is this class legal for this race under Forever rules?
function isValidCombo(race, cls) {
  return !!RACE_CLASSES[race] && RACE_CLASSES[race].includes(cls);
}

/* ---------------- Persistence (survives server restarts) ---------------- */
/**
 * We persist only durable room state to disk. Live sockets, connection flags,
 * and slot claims are transient and rebuilt as clients reconnect, so we strip
 * them before saving and reset them on load.
 */

function serializeRoom(room) {
  return {
    code: room.code,
    facilitatorId: room.facilitatorId, // kept so a refresh can reclaim the role
    lootTable: room.lootTable,
    mobList: room.mobList,
    members: room.members.map((m) => ({ id: m.id, name: m.name, realName: m.realName || "", cls: m.cls, race: m.race || "Human" })),
    boss: room.boss,
    bossLog: room.bossLog || [],
    activeDrop: room.activeDrop,
    lastResult: room.lastResult,
    log: room.log,
    lastActivity: room.lastActivity || Date.now(),
  };
}

let saveTimer = null;
function persist() {
  // debounce: coalesce bursts of changes into one write
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = [...rooms.values()].map(serializeRoom);
      const tmp = DATA_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DATA_FILE); // atomic-ish replace
    } catch (err) {
      console.error("persist failed:", err.message);
    }
  }, 300);
}

function loadRooms() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, "utf8");
  } catch {
    return; // no saved state yet
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("rooms.json is corrupt; starting fresh");
    return;
  }
  for (const r of data) {
    rooms.set(r.code, {
      code: r.code,
      facilitatorId: r.facilitatorId || null, // reclaimable by whoever presents it
      lootTable: r.lootTable || [],
      mobList: r.mobList || [],
      members: (r.members || []).map((m) => ({
        id: m.id, name: m.name, realName: m.realName || "", cls: m.cls, race: m.race || "Human",
        clientId: null, connected: false, // nobody is connected after a restart
      })),
      boss: rescaleBoss(r.boss) || null,
      bossLog: r.bossLog || [],
      activeDrop: r.activeDrop || null,
      lastResult: r.lastResult || null,
      log: r.log || [],
      lastActivity: r.lastActivity || Date.now(),
      clients: new Map(),
    });
  }
  console.log(`  Restored ${rooms.size} room(s) from disk.`);
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

// A fresh room starts with an empty backlog — the party fills it by proposing
// remediation steps (or adding items to the Loot Table) during the session.
function seededLootTable() {
  return [];
}

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    facilitatorId: null,
    lootTable: seededLootTable(),
    mobList: [],
    members: [],
    boss: null,
    bossLog: [],      // archived problems (id, name, tier, slain, remediation[])
    activeDrop: null,
    lastResult: null,
    log: [],
    lastActivity: Date.now(),
    clients: new Map(),
  };
  rooms.set(code, room);
  return room;
}

// Archive the active boss's identity + remediation plan so a per-problem
// export survives pulling the next boss, ending the encounter, or a restart.
function archiveBoss(room) {
  const boss = room.boss;
  if (!boss) return;
  if (!Array.isArray(room.bossLog)) room.bossLog = [];
  if (room.bossLog.some((b) => b.id === boss.id)) return;
  room.bossLog.push({
    id: boss.id,
    name: boss.name,
    desc: boss.desc || "",
    tier: boss.tier,
    slain: boss.slain,
    remediation: boss.remediation || [],
  });
}

/* ---------------- State views (what each client is allowed to see) ---------------- */

/**
 * Build the state a given client should receive.
 * While a drop is unresolved we expose only a TALLY of choices (counts),
 * never who chose what, and no roll values — those are revealed on resolve.
 */
function viewFor(room, client) {
  const resolved =
    room.lastResult && room.activeDrop && room.lastResult.dropId === room.activeDrop.id;

  // tally of choices (safe to show live)
  const tally = { need: 0, greed: 0, pass: 0, undecided: 0 };
  let myChoice = null;
  if (room.activeDrop) {
    room.members.forEach((m) => {
      const c = room.activeDrop.choices[m.id];
      if (c) tally[c]++;
      else tally.undecided++;
      if (client.memberId && m.id === client.memberId) myChoice = c || null;
    });
  }

  return {
    type: "state",
    room: room.code,
    you: {
      clientId: client.id,
      role: client.role,
      memberId: client.memberId,
      myChoice,
    },
    lootTable: room.lootTable,
    mobList: room.mobList,
    maxSlots: MAX_SLOTS,
    members: room.members.map((m) => ({
      id: m.id,
      name: m.name,
      realName: m.realName || "",
      cls: m.cls,
      race: m.race || "Human",
      faction: FACTION[m.race] || null,
      connected: m.connected,
      claimed: !!m.clientId,
      // only reveal a member's own choice to that member; others just see "has voted"
      hasVoted: room.activeDrop ? !!room.activeDrop.choices[m.id] : false,
      slotsUsed: slotsUsed(room, m.id),
    })),
    boss: room.boss,
    bossLog: room.bossLog || [],
    activeDrop: room.activeDrop
      ? { id: room.activeDrop.id, item: room.activeDrop.item }
      : null,
    tally,
    resolved: !!resolved,
    // lastResult (with all rolls) is ONLY included once resolved
    lastResult: resolved ? room.lastResult : null,
    log: room.log,
  };
}

function broadcast(room) {
  for (const client of room.clients.values()) {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(viewFor(room, client)));
    }
  }
  persist(); // durable state changed; schedule a save
}

function sendError(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message }));
}

/* ---------------- Roll resolution (authoritative, server-side) ---------------- */

function rollD(max) {
  return randomInt(1, max + 1); // 1..max inclusive
}

function breakTies(contenders) {
  let pool = contenders.slice();
  let guard = 0;
  while (guard++ < 50) {
    const top = Math.max(...pool.map((c) => c.roll));
    const tied = pool.filter((c) => c.roll === top);
    if (tied.length === 1) return tied[0];
    tied.forEach((c) => (c.roll = rollD(100)));
    pool = tied;
  }
  return pool[0];
}

function resolveDrop(room) {
  const drop = room.activeDrop;
  if (!drop) return;

  // A player whose bags filled up after voting (e.g. a task un-ticked) is
  // treated as passing, so nobody can exceed MAX_SLOTS.
  const rolls = room.members.map((m) => {
    const bagsFull = slotsUsed(room, m.id) >= MAX_SLOTS;
    return {
      memberId: m.id,
      name: m.name,
      realName: m.realName || "",
      choice: bagsFull ? "pass" : (drop.choices[m.id] || "pass"),
      bagsFull,
      roll: null,
    };
  });

  const needers = rolls.filter((r) => r.choice === "need");
  const greeders = rolls.filter((r) => r.choice === "greed");

  let contenders = [];
  let winnerContext = "";
  if (needers.length > 0) { contenders = needers; winnerContext = "Need"; }
  else if (greeders.length > 0) { contenders = greeders; winnerContext = "Greed"; }

  let winner = null;
  if (contenders.length > 0) {
    contenders.forEach((c) => (c.roll = rollD(100)));
    winner = breakTies(contenders);
  }

  room.lastResult = {
    dropId: drop.id,
    itemName: drop.item.name,
    rarity: drop.item.rarity,
    rolls,
    winnerId: winner ? winner.memberId : null,
    winnerName: winner ? winner.name : null,
    winnerReal: winner ? (winner.realName || "") : null,
    winnerContext,
    damage: null, // set below if a live boss took the hit
  };

  if (winner) {
    room.log.push({
      id: randomUUID(),
      name: drop.item.name,
      rarity: drop.item.rarity,
      ownerId: winner.memberId,
      ownerName: winner.name,
      ownerReal: winner.realName || "",
      bossId: room.boss ? room.boss.id : null,
      stepId: drop.item.id || null, // ties an owned task back to its remediation step
      passedOver: false,
      done: false,
    });
  } else {
    // Nobody wanted it: record a "passed over" entry so the register keeps a
    // trace that the item was discussed and consciously dropped. No owner, not
    // an actionable task.
    room.log.push({
      id: randomUUID(),
      name: drop.item.name,
      rarity: drop.item.rarity,
      ownerId: null,
      ownerName: "",
      ownerReal: "",
      bossId: room.boss ? room.boss.id : null,
      stepId: drop.item.id || null,
      passedOver: true,
      done: false,
    });
  }

  // Damage the active boss by the step's rarity. Passed-over steps deal none.
  if (room.boss && !room.boss.slain) {
    const damage = stepDamage(drop.item.rarity, !!winner);
    room.boss.hp = Math.max(0, room.boss.hp - damage);
    room.lastResult.damage = damage;
    if (room.boss.hp <= 0) room.boss.slain = true;
  }
}

/* ---------------- Message handlers ---------------- */

// Validate a boss topic (name / description / tier) from a client message.
function readTopic(msg, fallbackName = "") {
  const name = (msg.name || "").trim() || fallbackName;
  if (!name) return { error: "Name the boss (the topic to discuss)." };
  if (name.length > 60) return { error: "Topic name is too long (60 max)." };
  const desc = (msg.desc || "").trim();
  if (desc.length > 500) return { error: "Description is too long (500 max)." };
  const tier = BOSS_TIERS[msg.tier] ? msg.tier : "elite";
  return { name, desc, tier };
}

function isFacilitator(room, client) {
  return client.role === "facilitator" && room.facilitatorId === client.id;
}

const handlers = {
  // Create a brand-new room; sender becomes facilitator.
  create(ws, client, msg) {
    const room = createRoom();
    attach(room, ws, client, "facilitator");
    room.facilitatorId = client.id;
    broadcast(room);
  },

  // Join an existing room. If nobody is currently acting as facilitator
  // (e.g. the room was restored from disk, or the facilitator dropped), the
  // first joiner is promoted so a restored session stays controllable.
  join(ws, client, msg) {
    const room = rooms.get((msg.room || "").toUpperCase());
    if (!room) return sendError(ws, "Room not found. Check the code.");
    const facilitatorLive =
      room.facilitatorId && room.clients.has(room.facilitatorId);
    const role = facilitatorLive ? "player" : "facilitator";
    attach(room, ws, client, role);
    if (role === "facilitator") room.facilitatorId = client.id;
    broadcast(room);
  },

  // Player claims an open party slot (becomes that member's panel owner).
  claimMember(ws, client, msg) {
    const room = client.room;
    if (!room) return;
    const member = room.members.find((m) => m.id === msg.memberId);
    if (!member) return sendError(ws, "That member no longer exists.");
    if (member.clientId && member.clientId !== client.id)
      return sendError(ws, "That party slot is already taken.");
    // release any previous claim by this client
    room.members.forEach((m) => { if (m.clientId === client.id) { m.clientId = null; m.connected = false; } });
    member.clientId = client.id;
    member.connected = true;
    client.memberId = member.id;
    broadcast(room);
  },

  // A player creates their OWN character and immediately owns it.
  // No host setup required. If a matching unclaimed character already exists
  // (e.g. the same person returning after a server restart), re-bind to it
  // instead of creating a duplicate.
  createCharacter(ws, client, msg) {
    const room = client.room;
    if (!room) return;
    const name = (msg.name || "").trim();
    if (!name) return sendError(ws, "Enter a character name.");
    if (name.length > 24) return sendError(ws, "Name is too long (24 max).");
    // Real name is who's accountable for the looted task. Required.
    const realName = (msg.realName || "").trim();
    if (!realName) return sendError(ws, "Enter your real name (for accountability).");
    if (realName.length > 40) return sendError(ws, "Real name is too long (40 max).");
    const race = RACE_NAMES.includes(msg.race) ? msg.race : "Human";
    // Enforce the Forever race/class matrix: reject illegal combos outright so
    // the server stays the source of truth even if a client is tampered with.
    let cls = msg.cls;
    if (!isValidCombo(race, cls)) {
      return sendError(ws, `A ${race} cannot be a ${cls || "—"} in WoW: Forever.`);
    }

    // already have a character this session? just rename/reclass/re-race it.
    const mine = room.members.find((m) => m.clientId === client.id);
    if (mine) {
      mine.name = name;
      mine.realName = realName;
      mine.cls = cls;
      mine.race = race;
      return broadcast(room);
    }

    // reclaim a matching open slot (returning player after restart/kick)
    const existing = room.members.find(
      (m) => !m.clientId && m.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      existing.realName = realName;
      existing.cls = cls;
      existing.race = race;
      existing.clientId = client.id;
      existing.connected = true;
      client.memberId = existing.id;
      return broadcast(room);
    }

    // otherwise create a brand-new character owned by this client
    const member = {
      id: randomUUID(),
      name,
      realName,
      cls,
      race,
      clientId: client.id,
      connected: true,
    };
    room.members.push(member);
    client.memberId = member.id;
    broadcast(room);
  },

  // Facilitator adds a party member (an open slot players can claim).
  // Kept for proxy/absent teammates; players normally self-create instead.
  addMember(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    const name = (msg.name || "").trim();
    if (!name) return;
    room.members.push({ id: randomUUID(), name, cls: msg.cls || "Warrior", race: msg.race || "Human", clientId: null, connected: false });
    broadcast(room);
  },

  removeMember(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    room.members = room.members.filter((m) => m.id !== msg.memberId);
    if (room.activeDrop) delete room.activeDrop.choices[msg.memberId];
    for (const c of room.clients.values()) if (c.memberId === msg.memberId) c.memberId = null;
    broadcast(room);
  },

  // Facilitator kicks whoever holds a slot: the slot stays but becomes OPEN,
  // so the same person can reclaim it or someone else can take it. Any vote
  // that player cast on the current (unresolved) drop is cleared too.
  kickMember(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    const member = room.members.find((m) => m.id === msg.memberId);
    if (!member) return;
    const heldBy = member.clientId;
    member.clientId = null;
    member.connected = false;
    if (heldBy) {
      const kicked = room.clients.get(heldBy);
      if (kicked) {
        kicked.memberId = null;
        if (kicked.ws.readyState === kicked.ws.OPEN) {
          kicked.ws.send(JSON.stringify({ type: "kicked", memberName: member.name }));
        }
      }
    }
    const resolved = room.lastResult && room.activeDrop && room.lastResult.dropId === room.activeDrop.id;
    if (room.activeDrop && !resolved) delete room.activeDrop.choices[member.id];
    broadcast(room);
  },

  // Facilitator hands the facilitator role to a connected client that owns a
  // given member slot (or to themselves). Useful if the facilitator is leaving.
  reassignFacilitator(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    const member = room.members.find((m) => m.id === msg.memberId);
    if (!member || !member.clientId) return sendError(ws, "That slot has no connected player.");
    const target = room.clients.get(member.clientId);
    if (!target) return sendError(ws, "That player is no longer connected.");
    client.role = "player";
    target.role = "facilitator";
    room.facilitatorId = target.id;
    broadcast(room);
  },

  addLoot(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    const name = (msg.name || "").trim();
    if (!name) return;
    const rarity = RARITIES.includes(msg.rarity) ? msg.rarity : "common";
    room.lootTable.push({ id: randomUUID(), name, rarity, desc: (msg.desc || "").trim() });
    broadcast(room);
  },

  removeLoot(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    room.lootTable = room.lootTable.filter((l) => l.id !== msg.lootId);
    broadcast(room);
  },

  // Facilitator pulls a boss (names the retro topic + picks a difficulty).
  // Pull the next boss: a specific mob (mobId), a weighted-random mob from the
  // list (random), or a topic named on the spot (name/desc/tier).
  pullBoss(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    let topic;
    if (msg.mobId || msg.random) {
      if (room.mobList.length === 0) return sendError(ws, "The mob list is empty. Scout some topics first.");
      topic = msg.mobId ? room.mobList.find((m) => m.id === msg.mobId) : pickMob(room);
      if (!topic) return sendError(ws, "That mob is no longer on the list.");
      room.mobList = room.mobList.filter((m) => m !== topic);
    } else {
      topic = readTopic(msg, "Unnamed Topic");
      if (topic.error) return sendError(ws, topic.error);
    }
    archiveBoss(room);
    const hpMax = BOSS_TIERS[topic.tier].hp;
    room.boss = {
      id: randomUUID(), name: topic.name, desc: topic.desc, tier: topic.tier,
      scoutedBy: topic.addedBy || "", hpMax, hp: hpMax, slain: false, remediation: [],
    };
    room.activeDrop = null;
    room.lastResult = null;
    broadcast(room);
  },
  // Anyone with a character (or the facilitator) can scout a topic onto the
  // shared mob list. Exact duplicates are refused; near-duplicates are left to
  // the room, since everyone can see the list.
  addMob(ws, client, msg) {
    const room = client.room;
    if (!room) return;
    const me = client.memberId ? room.members.find((m) => m.id === client.memberId) : null;
    if (!me && !isFacilitator(room, client)) return sendError(ws, "Create a character before scouting topics.");
    const topic = readTopic(msg);
    if (topic.error) return sendError(ws, topic.error);
    const key = topic.name.toLowerCase();
    if (room.mobList.some((m) => m.name.toLowerCase() === key)) {
      return sendError(ws, `"${topic.name}" is already on the mob list.`);
    }
    room.mobList.push({
      id: randomUUID(), ...topic,
      addedById: me ? me.id : null,
      addedBy: me ? me.name : "Facilitator",
      addedReal: me ? (me.realName || "") : "",
    });
    broadcast(room);
  },
  // The scout who added a mob, or the facilitator, can take it off the list.
  removeMob(ws, client, msg) {
    const room = client.room;
    if (!room) return;
    const mob = room.mobList.find((m) => m.id === msg.mobId);
    if (!mob) return;
    if (!isFacilitator(room, client) && mob.addedById !== client.memberId) {
      return sendError(ws, "Only the scout who added it (or the facilitator) can remove it.");
    }
    room.mobList = room.mobList.filter((m) => m !== mob);
    broadcast(room);
  },

  // Facilitator ends the current encounter (clears the boss + any open drop).
  endBoss(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    archiveBoss(room);
    room.boss = null;
    room.activeDrop = null;
    room.lastResult = null;
    broadcast(room);
  },

  // ANYONE in the room can propose a remediation step for the live boss. It's
  // added to the boss's remediation plan as a suggestion (not yet on the
  // table). The facilitator later drops it for the roll via `dropStep`.
  proposeStep(ws, client, msg) {
    const room = client.room;
    if (!room) return;
    if (!room.boss || room.boss.slain) return sendError(ws, "Pull a boss before proposing a step.");
    const name = (msg.name || "").trim();
    if (!name) return sendError(ws, "Enter a remediation step.");
    if (name.length > 120) return sendError(ws, "Step name is too long (120 max).");
    const rarity = RARITIES.includes(msg.rarity) ? msg.rarity : "uncommon";
    // attribute the proposal to the proposer's character/real name when known
    const me = client.memberId ? room.members.find((m) => m.id === client.memberId) : null;
    const step = {
      id: randomUUID(),
      name,
      rarity,
      desc: (msg.desc || "").trim(),
      proposedBy: me ? me.name : "Facilitator",
      proposedReal: me ? (me.realName || "") : "",
      dropped: false, // becomes true once the facilitator drops it for the roll
    };
    if (!Array.isArray(room.boss.remediation)) room.boss.remediation = [];
    room.boss.remediation.push(step);
    // Also add it to the backlog (loot table) so it's reusable later and shows
    // up in the Loot Table. Shares the step's id so the two stay linked.
    room.lootTable.push({ id: step.id, name: step.name, rarity: step.rarity, desc: step.desc });
    broadcast(room);
  },

  // Facilitator drops a previously-proposed remediation step onto the table
  // for Need/Greed/Pass. Can't drop over a live unresolved drop.
  dropStep(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    if (!room.boss || room.boss.slain) return sendError(ws, "No live boss to attack.");
    const resolved = room.lastResult && room.activeDrop && room.lastResult.dropId === room.activeDrop.id;
    if (room.activeDrop && !resolved) return sendError(ws, "Resolve the current drop before dropping another.");
    const step = (room.boss.remediation || []).find((s) => s.id === msg.stepId);
    if (!step) return sendError(ws, "That step no longer exists.");
    if (step.dropped) return sendError(ws, "That step has already been dropped.");
    step.dropped = true;
    room.activeDrop = { id: randomUUID(), item: { ...step }, choices: {} };
    room.lastResult = null;
    broadcast(room);
  },

  // Facilitator drops loot (random or a specific item id).
  drop(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    if (!room.boss || room.boss.slain) return sendError(ws, "Pull a boss before dropping loot.");
    if (room.lootTable.length === 0) return sendError(ws, "Loot table is empty.");
    const pool = unclaimedLoot(room);
    if (pool.length === 0) return sendError(ws, "Every backlog item has already been claimed.");
    let item;
    if (msg.lootId) item = pool.find((l) => l.id === msg.lootId);
    else item = pool[randomInt(pool.length)];
    if (!item) return sendError(ws, "That item has already been claimed or no longer exists.");
    room.activeDrop = { id: randomUUID(), item: { ...item }, choices: {} };
    room.lastResult = null;
    // if this backlog item corresponds to a remediation step, mark it dropped
    if (room.boss && Array.isArray(room.boss.remediation)) {
      const step = room.boss.remediation.find((s) => s.id === item.id);
      if (step) step.dropped = true;
    }
    broadcast(room);
  },

  // A player sets their own Need/Greed/Pass (can only set their own slot).
  setChoice(ws, client, msg) {
    const room = client.room;
    if (!room || !room.activeDrop) return;
    if (room.lastResult && room.lastResult.dropId === room.activeDrop.id) return; // resolved
    // facilitator may vote only if they've claimed a member slot
    const memberId = client.memberId;
    if (!memberId) return sendError(ws, "Claim a party slot before voting.");
    const valid = ["need", "greed", "pass"];
    if (!valid.includes(msg.choice)) return;
    if (msg.choice !== "pass" && slotsUsed(room, memberId) >= MAX_SLOTS) {
      return sendError(ws, `Your bags are full (${MAX_SLOTS}/${MAX_SLOTS}). Complete a task to free a slot.`);
    }
    const current = room.activeDrop.choices[memberId];
    if (current === msg.choice) delete room.activeDrop.choices[memberId]; // toggle off
    else room.activeDrop.choices[memberId] = msg.choice;
    broadcast(room);
  },

  // Facilitator resolves the current drop (server rolls, then reveal).
  resolve(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client) || !room.activeDrop) return;
    if (room.lastResult && room.lastResult.dropId === room.activeDrop.id) return;
    resolveDrop(room);
    broadcast(room);
  },

  toggleTask(ws, client, msg) {
    const room = client.room;
    if (!room) return;
    const t = room.log.find((x) => x.id === msg.taskId);
    if (t) { t.done = !t.done; broadcast(room); }
  },

  resetSession(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    room.lootTable = seededLootTable();
    room.mobList = [];
    room.boss = null;
    room.bossLog = [];
    room.activeDrop = null;
    room.lastResult = null;
    room.log = [];
    // keep members but clear votes
    broadcast(room);
  },
};

function attach(room, ws, client, role) {
  // if this client was in another room, detach first
  if (client.room && client.room !== room) detach(client);
  client.room = room;
  client.role = role;
  room.clients.set(client.id, client);
}

function detach(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  // free any member slot this client claimed
  room.members.forEach((m) => { if (m.clientId === client.id) { m.clientId = null; m.connected = false; } });
  // if the facilitator left, promote the next connected client (if any)
  if (room.facilitatorId === client.id) {
    const next = [...room.clients.values()][0];
    if (next) { room.facilitatorId = next.id; next.role = "facilitator"; }
  }
  client.room = null;
  // Keep empty rooms alive (in memory and on disk) so a session survives
  // everyone briefly disconnecting or a server restart. Stale rooms are
  // pruned by age (see pruneStaleRooms). Mark last-activity for pruning.
  room.lastActivity = Date.now();
  broadcast(room);
}

/* ---------------- Stale-room cleanup ---------------- */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // keep abandoned rooms for 24h
function pruneStaleRooms() {
  const now = Date.now();
  let pruned = 0;
  for (const room of [...rooms.values()]) {
    const empty = room.clients.size === 0;
    const last = room.lastActivity || 0;
    if (empty && now - last > ROOM_TTL_MS) {
      rooms.delete(room.code);
      pruned++;
    }
  }
  if (pruned > 0) persist();
}

/* ---------------- Connection lifecycle ---------------- */

wss.on("connection", (ws) => {
  const client = { id: randomUUID(), ws, room: null, role: null, memberId: null };

  // send the race/class matrix once so the client can drive its pickers
  // from the same source of truth the server validates against.
  ws.send(JSON.stringify({ type: "meta", raceClasses: RACE_CLASSES, faction: FACTION }));

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const handler = handlers[msg.type];
    if (handler) {
      try { handler(ws, client, msg); }
      catch (err) { console.error("handler error", msg.type, err); sendError(ws, "Server error."); }
    }
  });

  ws.on("close", () => detach(client));
  ws.on("error", () => {});
});

loadRooms();
setInterval(pruneStaleRooms, 60 * 60 * 1000).unref(); // hourly cleanup

server.listen(PORT, () => {
  console.log(`\n  Loot Council server running`);
  console.log(`  Local:    http://localhost:${PORT}/net.html`);
  console.log(`  Network:  share your LAN IP, e.g. http://<your-ip>:${PORT}/net.html`);
  console.log(`  (single-screen local mode still at /index.html)\n`);
});
