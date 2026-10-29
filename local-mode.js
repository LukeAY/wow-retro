/* =========================================================================
 * Loot Council — local (single-screen) mode
 * Runs the same room engine as the server, in the browser, behind the same
 * send()/onState() interface the online client uses over WebSocket. One
 * screen drives the whole party: the facilitator picks who they're "acting
 * as" for posting, rallying and threat voting.
 *
 * By default the session lives in sessionStorage (gone when the tab closes),
 * matching online mode's default of not saving. Ticking "Keep after the tab
 * closes" moves it to localStorage instead.
 * ========================================================================= */

import {
  createRoom, migrateRoom, act, tick, viewFor, buildLedger,
  validateCharacter, addMember, hasAction,
} from "./shared/engine.js";
import { RACE_CLASSES, CLASS_NAMES } from "./shared/rules.js";

const KEY = "wow-retro-loot-council-v2";
const OLD_KEY = "wow-retro-loot-council-v1"; // the pre-engine local mode

// Storage can throw (private windows, blocked site data); the session then
// simply isn't remembered.
function read(store, key) {
  try { return JSON.parse(store.getItem(key)); } catch { return null; }
}
function write(store, key, value) {
  try { store.setItem(key, value); } catch { /* not remembered */ }
}
function remove(store, key) {
  try { store.removeItem(key); } catch { /* nothing to remove */ }
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID(); // secure contexts only
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function rand() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}
const ctx = () => ({ uuid, rand, rollD: (max) => 1 + Math.floor(rand() * max), now: Date.now() });

// The old local mode kept a "party" without races; give each a legal race.
function fromOldLocal(old) {
  const members = (old.party || []).map((p) => {
    const cls = CLASS_NAMES.includes(p.cls) ? p.cls : "Warrior";
    const race = Object.keys(RACE_CLASSES).find((r) => RACE_CLASSES[r].includes(cls));
    return { id: p.id, name: p.name, realName: "", cls, race };
  });
  return migrateRoom({ ...old, code: "LOCAL", persist: true, tacticRallies: false, members });
}

export function createLocalTransport({ onState, onError, onLedger }) {
  let keep = false;
  let room;
  let actingAs = null;

  const kept = read(localStorage, KEY);
  const tab = read(sessionStorage, KEY);
  const old = !kept && !tab && read(localStorage, OLD_KEY);
  if (kept) { keep = true; room = migrateRoom(kept.room); actingAs = kept.actingAs; }
  else if (tab) { room = migrateRoom(tab.room); actingAs = tab.actingAs; }
  else if (old) { keep = true; room = fromOldLocal(old); actingAs = room.members[0] ? room.members[0].id : null; }
  else room = createRoom({ code: "LOCAL", tacticRallies: false });
  // One screen has no separate players to rally, so the proposer picks a
  // tactic's rarity instead.
  room.tacticRallies = false;
  if (!room.members.some((m) => m.id === actingAs)) actingAs = room.members[0] ? room.members[0].id : null;

  function save() {
    const data = JSON.stringify({ room, actingAs });
    if (keep) { write(localStorage, KEY, data); remove(sessionStorage, KEY); }
    else { write(sessionStorage, KEY, data); remove(localStorage, KEY); }
  }

  function emit() {
    const view = viewFor(room, { memberId: actingAs, facilitator: true }, Date.now(), { revealChoices: true });
    view.you.role = "facilitator";
    view.you.local = true;
    view.persist = keep;
    view.members = view.members.map((m) => ({ ...m, claimed: true, connected: true, isHost: false }));
    onState(view);
  }

  function send(msg) {
    if (msg.type === "ledger") return onLedger(buildLedger(room));
    if (msg.type === "createCharacter") {
      const check = validateCharacter(msg);
      if (check.error) return onError(check.error);
      actingAs = addMember(room, check.fields, uuid).id;
    } else {
      if (!hasAction(msg.type)) return onError("Unknown action.");
      // one screen drives everyone: a party panel can vote for its own member
      const actor = { memberId: msg.asMember || actingAs, facilitator: true };
      const result = act(room, actor, msg, ctx());
      if (result.error) return onError(result.error);
      if (!room.members.some((m) => m.id === actingAs)) actingAs = room.members[0] ? room.members[0].id : null;
    }
    save();
    emit();
  }

  // Enrage timers run here, as they do on the server.
  setInterval(() => {
    if (tick(room, Date.now())) { save(); emit(); }
  }, 1000);

  return {
    start() { save(); emit(); },
    send,
    setActingAs(id) {
      if (!room.members.some((m) => m.id === id)) return;
      actingAs = id;
      save();
      emit();
    },
    setKeep(value) {
      keep = !!value;
      save();
      emit();
    },
    // Wipe the session entirely (both storages) and start fresh.
    disband() {
      remove(localStorage, KEY);
      remove(sessionStorage, KEY);
      room = createRoom({ code: "LOCAL", tacticRallies: false });
      actingAs = null;
      keep = false;
      save();
      emit();
    },
  };
}
