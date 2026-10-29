/* =========================================================================
 * Loot Council — networked server
 * Express serves the client; a ws server holds sessions keyed by room code.
 * The game itself lives in shared/engine.js (also used by local mode). This
 * file adds what only a server has: connections, the host role, slot claims,
 * saving rooms to disk and running timers. The server is authoritative, so
 * hidden choices, ballots and rolls stay secret until they're revealed.
 * ========================================================================= */

import express from "express";
import { WebSocketServer } from "ws";
import { randomUUID, randomInt } from "node:crypto";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createRoom, migrateRoom, act, tick, viewFor, buildLedger,
  validateCharacter, addMember, updateMember, hasAction, setHeld,
} from "../shared/engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "rooms.json");

/* ---------------- Static client ---------------- */
// Serve only the client files. Everything else in the repo (including the
// saved rooms in server/data, which hold real names) stays private.
const app = express();
const PUBLIC_FILES = ["index.html", "net.html", "styles.css", "icons.js", "net-client.js", "local-mode.js"];
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "index.html")));
for (const file of PUBLIC_FILES) app.get(`/${file}`, (_req, res) => res.sendFile(path.join(ROOT, file)));
app.use("/fonts", express.static(path.join(ROOT, "fonts")));
app.use("/shared", express.static(path.join(ROOT, "shared")));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ---------------- In-memory session store ---------------- */
/**
 * rooms: Map<code, Room>. A Room is the engine's room state plus:
 *   facilitatorId: clientId of the host
 *   clients: Map<clientId, { ws, role: 'facilitator'|'player', memberId|null }>
 *   members[].clientId / connected: who is playing each character right now
 */
const rooms = new Map();

const ctxFor = () => ({
  uuid: randomUUID,
  rollD: (max) => randomInt(1, max + 1), // 1..max inclusive
  rand: () => randomInt(0, 2 ** 32) / 2 ** 32,
  now: Date.now(),
});

/* ---------------- Persistence (saved rooms survive restarts) ---------------- */
/**
 * Only rooms created with "save this room" are written to disk. Unsaved rooms
 * live in memory and are gone if the server restarts. Live sockets and slot
 * claims are transient, so they're stripped before saving.
 */
function serializeRoom(room) {
  const { clients, ...state } = room;
  return {
    ...state,
    members: room.members.map(({ clientId, connected, ...m }) => m),
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
      const data = [...rooms.values()].filter((r) => r.persist).map(serializeRoom);
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
  for (const saved of data) {
    const room = migrateRoom(saved);
    room.facilitatorId = saved.facilitatorId || null; // reclaimable by whoever presents it
    room.members = room.members.map((m) => ({ ...m, clientId: null, connected: false }));
    room.clients = new Map();
    tick(room, Date.now()); // a boss whose enrage ran out while we were down
    rooms.set(room.code, room);
  }
  console.log(`  Restored ${rooms.size} saved room(s) from disk.`);
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

/* ---------------- Views ---------------- */

// The engine decides what's secret; the server adds who is connected and who hosts.
function serverView(room, client) {
  const view = viewFor(room, { memberId: client.memberId, facilitator: isFacilitator(room, client) }, Date.now());
  view.you.clientId = client.id;
  view.you.role = client.role;
  view.members = view.members.map((m) => {
    const member = room.members.find((x) => x.id === m.id);
    return {
      ...m,
      claimed: !!member.clientId,
      connected: !!member.connected,
      isHost: !!member.clientId && member.clientId === room.facilitatorId,
    };
  });
  return view;
}

function broadcast(room) {
  for (const client of room.clients.values()) {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(serverView(room, client)));
    }
  }
  if (room.persist) persist(); // durable state changed; schedule a save
}

function sendError(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message }));
}

function isFacilitator(room, client) {
  return client.role === "facilitator" && room.facilitatorId === client.id;
}

/* ---------------- Connection-level handlers ---------------- */
// Everything else is a game action and goes straight to the engine.

const handlers = {
  // Create a brand-new room; the sender becomes the facilitator.
  create(ws, client, msg) {
    const room = createRoom({ code: makeRoomCode(), persist: msg.persist === true });
    room.facilitatorId = null;
    room.clients = new Map();
    rooms.set(room.code, room);
    attach(room, client, "facilitator");
    room.facilitatorId = client.id;
    broadcast(room);
  },

  // Join an existing room. If nobody is currently acting as facilitator
  // (e.g. the room was restored from disk, or the facilitator dropped), the
  // first joiner is promoted so a restored session stays controllable.
  join(ws, client, msg) {
    const room = rooms.get(String(msg.room || "").toUpperCase());
    if (!room) return sendError(ws, "Room not found. Check the code.");
    const facilitatorLive = room.facilitatorId && room.clients.has(room.facilitatorId);
    const role = facilitatorLive ? "player" : "facilitator";
    attach(room, client, role);
    if (role === "facilitator") room.facilitatorId = client.id;
    broadcast(room);
  },

  // Player claims an open party slot (a character nobody is playing).
  claimMember(ws, client, msg) {
    const room = client.room;
    if (!room) return;
    const member = room.members.find((m) => m.id === msg.memberId);
    if (!member) return sendError(ws, "That member no longer exists.");
    if (member.clientId && member.clientId !== client.id) return sendError(ws, "That party slot is already taken.");
    leaveSlot(room, client);
    member.clientId = client.id;
    member.connected = true;
    setHeld(room, member.id, true);
    client.memberId = member.id;
    broadcast(room);
  },

  // A player creates their OWN character and immediately owns it. A returning
  // player who re-enters their name re-takes their open slot instead.
  createCharacter(ws, client, msg) {
    const room = client.room;
    if (!room) return;
    if (room.ended) return sendError(ws, "The raid has ended. You can still view the Raid Summary.");
    const check = validateCharacter(msg);
    if (check.error) return sendError(ws, check.error);
    const { fields } = check;
    const mine = room.members.find((m) => m.clientId === client.id);
    if (mine) { updateMember(room, mine, fields); return broadcast(room); }
    const existing = room.members.find((m) => !m.clientId && m.name.toLowerCase() === fields.name.toLowerCase());
    const member = existing || addMember(room, fields, randomUUID);
    if (existing) updateMember(room, existing, fields);
    member.clientId = client.id;
    member.connected = true;
    setHeld(room, member.id, true);
    client.memberId = member.id;
    broadcast(room);
  },

  // Kick whoever holds a slot: the slot stays but becomes open. Any vote they
  // cast on the current drop is cleared too.
  kickMember(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    const member = room.members.find((m) => m.id === msg.memberId);
    if (!member) return;
    const kicked = member.clientId && room.clients.get(member.clientId);
    member.clientId = null;
    member.connected = false;
    setHeld(room, member.id, false); // an open slot no longer counts towards bag size
    if (kicked) {
      kicked.memberId = null;
      if (kicked.ws.readyState === kicked.ws.OPEN) {
        kicked.ws.send(JSON.stringify({ type: "kicked", memberName: member.name }));
      }
    }
    if (room.activeDrop && !(room.lastResult && room.lastResult.dropId === room.activeDrop.id)) {
      delete room.activeDrop.choices[member.id];
    }
    broadcast(room);
  },

  // Hand the host role to the connected player in another slot.
  reassignFacilitator(ws, client, msg) {
    const room = client.room;
    if (!room || !isFacilitator(room, client)) return;
    const member = room.members.find((m) => m.id === msg.memberId);
    if (!member || !member.clientId) return sendError(ws, "That slot has no connected player.");
    const target = room.clients.get(member.clientId);
    if (!target) return sendError(ws, "That player is no longer connected.");
    if (target === client) return sendError(ws, "You're already the host.");
    client.role = "player";
    target.role = "facilitator";
    room.facilitatorId = target.id;
    broadcast(room);
  },

  // The Loot Ledger is built here because it names who rallied, which the
  // live board deliberately never shows.
  // Leave Group: unlike a dropped connection, this gives the slot up, so it
  // stops counting towards bag size. The client navigates away on "left".
  leave(ws, client) {
    const room = client.room;
    if (room) {
      leaveSlot(room, client);
      detach(client);
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "left" }));
  },

  ledger(ws, client) {
    const room = client.room;
    if (!room || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "ledger", text: buildLedger(room) }));
  },
};

// A dropped connection releases the character for reclaiming, but the
// player still holds their place in the party ("Away") until they leave.
function releaseSlot(room, client) {
  room.members.forEach((m) => { if (m.clientId === client.id) { m.clientId = null; m.connected = false; } });
}

function leaveSlot(room, client) {
  for (const m of room.members) if (m.clientId === client.id) setHeld(room, m.id, false);
  releaseSlot(room, client);
  client.memberId = null;
}

function attach(room, client, role) {
  if (client.room && client.room !== room) detach(client);
  client.room = room;
  client.role = role;
  room.clients.set(client.id, client);
}

function detach(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  releaseSlot(room, client); // a dropped player's character becomes reclaimable
  // if the facilitator left, promote the next connected client (if any)
  if (room.facilitatorId === client.id) {
    const next = [...room.clients.values()][0];
    if (next) { room.facilitatorId = next.id; next.role = "facilitator"; }
  }
  client.room = null;
  // Keep empty rooms alive so a session survives everyone briefly
  // disconnecting; stale rooms are pruned by age.
  room.lastActivity = Date.now();
  broadcast(room);
}

/* ---------------- Timers and stale-room cleanup ---------------- */

// Enrage timers are checked every second; a boss whose timer ran out enrages.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) if (tick(room, now)) broadcast(room);
}, 1000).unref();

const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // keep abandoned rooms for 24h
function pruneStaleRooms() {
  const now = Date.now();
  let pruned = 0;
  for (const room of [...rooms.values()]) {
    if (room.clients.size === 0 && now - (room.lastActivity || 0) > ROOM_TTL_MS) {
      rooms.delete(room.code);
      pruned++;
    }
  }
  if (pruned > 0) persist();
}

/* ---------------- Connection lifecycle ---------------- */

wss.on("connection", (ws) => {
  const client = { id: randomUUID(), ws, room: null, role: null, memberId: null };

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    try {
      if (Object.prototype.hasOwnProperty.call(handlers, msg.type)) return handlers[msg.type](ws, client, msg);
      if (!client.room || !hasAction(msg.type)) return;
      const room = client.room;
      const actor = { memberId: client.memberId, facilitator: isFacilitator(room, client) };
      const result = act(room, actor, msg, ctxFor());
      if (result.error) return sendError(ws, result.error);
      // a removed character can't stay attached to whoever was playing it
      if (msg.type === "removeMember") {
        for (const c of room.clients.values()) if (c.memberId === msg.memberId) c.memberId = null;
      }
      broadcast(room);
    } catch (err) {
      console.error("handler error", msg.type, err);
      sendError(ws, "Server error.");
    }
  });

  ws.on("close", () => detach(client));
  ws.on("error", () => {});
});

loadRooms();
setInterval(pruneStaleRooms, 60 * 60 * 1000).unref(); // hourly cleanup

server.listen(PORT, () => {
  console.log(`\n  Loot Council server running`);
  console.log(`  Online:   http://localhost:${PORT}/net.html`);
  console.log(`  Network:  share your LAN IP, e.g. http://<your-ip>:${PORT}/net.html`);
  console.log(`  Local (single screen): http://localhost:${PORT}/index.html\n`);
});
