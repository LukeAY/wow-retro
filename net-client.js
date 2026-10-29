/* =========================================================================
 * Loot Council — client UI (online and local mode)
 * Renders whatever view it's given and sends intents. Online, that's the
 * server over WebSocket; in local mode (?mode=local) it's the same room
 * engine running in this tab (local-mode.js). Either way the rules come from
 * shared/, so the two modes can't drift.
 * ========================================================================= */

import {
  RARITIES, RARITY, TACTIC_DAMAGE, rarityRank, tierLabel, BOSS_STATUS,
  RALLY_EPIC, RALLY_LEGENDARY, TEAM_ACTION_BUDGET, MIN_BAG_SLOTS, TACTIC_RALLY_UNCOMMON, TACTIC_RALLY_LEGENDARY, RACE_CLASSES, FACTION, CLASS_NAMES, BOSS_TIERS, tierForThreat,
} from "./shared/rules.js";
import { PHASES, PHASE_LABEL } from "./shared/engine.js";
import { icon, svgIcon, ICON_PATHS, raceIcon, classIcon, factionIcon } from "./icons.js";

const LOCAL = new URLSearchParams(location.search).get("mode") === "local";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------------- Display constants ---------------- */

// Short words for rarity-as-priority, used in pickers and tags.
const PRIORITY = { poor: "trivial", common: "low", uncommon: "medium", rare: "high", epic: "critical", legendary: "top" };

const CLASS_COLORS = {
  "Death Knight": "#c41e3a", "Demon Hunter": "#a330c9", "Druid": "#ff7c0a",
  "Evoker": "#33937f", "Hunter": "#aad372", "Mage": "#3fc7eb", "Monk": "#00ff98",
  "Paladin": "#f48cba", "Priest": "#ffffff", "Rogue": "#fff468", "Shaman": "#2e8fff",
  "Warlock": "#8788ee", "Warrior": "#c69b6d",
};
const FACTION_COLOR = { Alliance: "#6aa1f0", Horde: "#ff5c6c" };
const TIER_COLOR = { normal: "#b8c0cc", elite: "#c27bff", raid: "#ff8c1a" };

/* ---------------- Connection (WebSocket or local engine) ---------------- */

let view = null;      // last state received
let prevView = null;  // the one before, for working out what changed
let transport = null;

function createWsTransport() {
  let ws = null;
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.addEventListener("open", () => {
      setStatus("connected");
      const room = roomFromUrl();
      if (room) transport.send({ type: "join", room });
      else showScreen("lobby");
    });
    ws.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "state") onState(msg);
      else if (msg.type === "error") onError(msg.message);
      else if (msg.type === "ledger") showLedger(msg.text);
      else if (msg.type === "left") leaveRoom();
      else if (msg.type === "kicked") {
        toast({ kind: "error", iconName: "warning", heading: "Removed from your slot",
          title: `The host freed the "${msg.memberName}" slot. You can claim an open slot again.` });
      }
    });
    ws.addEventListener("close", () => {
      setStatus("disconnected");
      setTimeout(connect, 1500);
    });
    ws.addEventListener("error", () => ws.close());
  }
  return {
    start: connect,
    send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
  };
}

const send = (msg) => transport.send(msg);

// The dot is decorative; the words carry the state. The status region only
// changes when the state does, so reconnect retries aren't re-announced.
const CONN_TEXT = { connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected" };
function setStatus(state) {
  const el = $("#conn-status");
  if (el.dataset.state === state) return;
  el.dataset.state = state;
  $("#conn-text").textContent = CONN_TEXT[state];
}

// A shared invite link is net.html?room=ABCD. Codes are A–Z / 0–9, four long.
const cleanCode = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
const roomFromUrl = () => cleanCode(new URLSearchParams(location.search).get("room"));
const inviteLink = (code) => `${location.origin}${location.pathname}?room=${code}`;

function onError(message) {
  // A refused action can leave a control showing the change (a ticked box,
  // a picked option) while the markup string is unchanged: redraw it all.
  htmlCache = new WeakMap();
  if (view && !$("#game").classList.contains("hidden")) withFocusKept(render);
  if (!view && !LOCAL) showScreen("lobby"); // e.g. a link to a room that no longer exists
  $("#lobby-joining").classList.toggle("hidden", true);
  if (!$("#lobby").classList.contains("hidden")) { $("#lobby-error").textContent = message; return; }
  if (!$("#create-char").classList.contains("hidden")) { $("#char-error").textContent = message; return; }
  toast({ kind: "error", iconName: "warning", heading: "You can't do that", title: message });
}

/* ---------------- Screens ---------------- */

let addingMember = false;  // local mode: the host is adding another party member
let editingChar = false;   // Edit my character: the character screen, prefilled

function showScreen(name) {
  for (const s of ["lobby", "create-char", "game"]) $(`#${s}`).classList.toggle("hidden", s !== name);
  // the lobby hero carries the name (as the page h1), so the top bar drops it
  $("#brand").classList.toggle("hidden", name === "lobby");
  for (const id of ["#room-chip", "#you-wrap"]) $(id).classList.toggle("hidden", name === "lobby");
  if (name === "lobby") { $("#bar-tools").classList.toggle("hidden", true); $("#phase-tracker").classList.toggle("hidden", true); setYouPanel(false); }
}

function onState(msg) {
  const firstRoom = !view || view.room !== msg.room;
  prevView = firstRoom ? null : view;
  view = msg;

  if (!LOCAL && firstRoom) {
    const url = new URL(location.href);
    url.searchParams.set("room", msg.room);
    history.replaceState({}, "", url);
  }

  // After End Raid everyone sees the Raid Summary, with or without a character.
  if (view.ended) addingMember = editingChar = false;
  if (editingChar && !view.you.memberId) editingChar = false;
  if ((!view.you.memberId || addingMember || editingChar) && !view.ended) {
    showScreen("create-char");
    renderTopbar(false);
    renderCreateChar();
    return;
  }
  showScreen("game");
  renderTopbar(true);
  withFocusKept(render);
  announceChanges();
}

/* ---------------- Rendering ---------------- */

// Every state update re-renders, but most sections haven't changed. Writing
// identical markup still rebuilds the DOM and relayouts the page (slow in
// Safari) and throws away what's in a field, such as a half-typed timer
// length. So a write is skipped when the markup is the same as last time.
let htmlCache = new WeakMap();
function setHtml(el, html) {
  if (htmlCache.get(el) === html) return;
  htmlCache.set(el, html);
  el.innerHTML = html;
}
// Same for plain text and class names: rewriting identical values still
// counts as a change and invalidates style and layout.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function setClass(el, cls) {
  if (el.className !== cls) el.className = cls;
}

const isHost = () => !!view && view.you.role === "facilitator";

// Re-rendering replaces markup, which would drop keyboard focus whenever
// anyone else acts. Remember what had focus and put it back.
function withFocusKept(fn) {
  const el = document.activeElement;
  let key = null;
  if (el && el !== document.body) {
    if (el.id) key = `#${CSS.escape(el.id)}`;
    else {
      const attrs = [...el.attributes].filter((a) => a.name.startsWith("data-"));
      if (attrs.length) key = attrs.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join("");
    }
  }
  fn();
  if (key && !document.contains(el)) {
    const again = document.querySelector(key);
    if (again) again.focus({ preventScroll: true });
  }
}

function render() {
  $("#game").classList.toggle("raid-over", !!view.ended);
  $("#raid-summary").classList.toggle("hidden", !view.ended);
  if (view.ended) {
    renderSummary();
    refreshOpenModals();
    return;
  }
  renderPhaseBar();
  for (const p of PHASES) $(`#phase-${p}`).classList.toggle("hidden", view.phase !== p);
  if (view.phase === "achievements") renderAchievements();
  if (view.phase === "scouting") renderMobList("#scout-mob-list", false);
  if (view.phase === "voting") renderVoting();
  if (view.phase === "encounters") renderEncounters();
  renderParty();
  renderLog();
  renderAccountability();
  refreshOpenModals();
  updateTimers();
}

// The member a viewer plays (in local mode, whoever the screen acts as).
const me = () => (view && view.members.find((m) => m.id === view.you.memberId)) || null;

function setAvatar(el, m) {
  el.style.setProperty("--member-color", m ? (CLASS_COLORS[m.cls] || "#c8aa6e") : "var(--gold)");
  setHtml(el, m ? (raceIcon(m.race) || escapeHtml(m.name.slice(0, 2).toUpperCase())) : icon("person"));
}

function renderTopbar(inGame) {
  const host = isHost();
  const ended = !!view.ended;
  const m = me();

  // room chip: the code and (for the host) the invite link; local mode has neither
  $("#room-chip").classList.toggle("local", LOCAL);
  setText($("#room-code"), LOCAL ? "Single screen" : view.room);
  $("#btn-copy-invite").classList.toggle("hidden", LOCAL || !host);

  // status stack: plain text, the dot is extra
  $("#conn-status").classList.toggle("hidden", LOCAL);
  $("#save-status").classList.toggle("hidden", false);
  setText($("#save-text"), LOCAL ? (view.persist ? "Kept in this browser" : "This tab only") : (view.persist ? "Saved" : "Not saved"));
  setText($("#save-tip"), LOCAL
    ? (view.persist ? "This session is kept in this browser until you disband the group." : "This session is lost when this tab closes. Tick Keep after the tab closes in the menu to keep it.")
    : (view.persist ? "This room is saved on the server and survives a restart." : "This room isn't saved: it's gone if the server restarts, or a day after everyone leaves."));

  // everyday tools, shown by phase and role as before
  $("#bar-tools").classList.toggle("hidden", !inGame);
  const tools = {
    mobs: inGame && !ended && view.phase !== "achievements",
    roster: inGame && host && !(ended && LOCAL), // online the host can still kick or hand over after the end
    export: inGame,
    config: inGame && !ended && host,
  };
  $("#btn-mobs").classList.toggle("hidden", !tools.mobs);
  $("#btn-roster").classList.toggle("hidden", !tools.roster);
  $("#btn-export").classList.toggle("hidden", !tools.export);
  for (const b of $$("#you-panel [data-tool]")) {
    if (b.dataset.tool in tools) b.closest("li").classList.toggle("hidden", !tools[b.dataset.tool]);
  }

  // you: avatar, name and "Real name · Race Class · Facilitator"
  const sub = m ? [m.realName, `${m.race} ${m.cls}`, host && !LOCAL ? "Facilitator" : ""].filter(Boolean).join(" · ")
    : (host && !LOCAL ? "Facilitator" : "");
  for (const [av, name, line] of [["#you-avatar", "#you-name", "#you-sub"], ["#menu-avatar", "#menu-name", "#menu-sub"]]) {
    setAvatar($(av), m);
    setText($(name), m ? m.name : "No character");
    setText($(line), sub);
    $(line).classList.toggle("hidden", !sub);
  }
  setAvatar($("#bar-avatar"), m);
  $("#bar-avatar").classList.toggle("hidden", !m);
  setText($("#menu-status"), [LOCAL ? "Single screen" : `Room ${view.room}`, LOCAL ? "" : $("#conn-text").textContent, $("#save-text").textContent].filter(Boolean).join(" · "));
  $("#btn-edit-char").closest("li").classList.toggle("hidden", !m || ended || editingChar || addingMember);
  setText($("#btn-leave"), LOCAL ? "Disband group" : "Leave group");

  // local mode: switch who the screen acts as, and whether the session is kept
  $("#keep-wrap").classList.toggle("hidden", !LOCAL);
  $("#keep-session").checked = !!view.persist;
  const acting = LOCAL && view.members.length > 0 && !ended;
  $("#acting-as-wrap").classList.toggle("hidden", !acting);
  if (acting) {
    setHtml($("#acting-as"), view.members.map((x) => {
      const on = x.id === view.you.memberId;
      return `<li><button class="you-item acting-item" data-act-as="${x.id}" aria-pressed="${on}">${on ? icon("check") : `<span class="check-gap" aria-hidden="true"></span>`} ${escapeHtml(x.name)}</button></li>`;
    }).join("") + `<li><button class="you-item acting-item" data-act-as="__add"><span class="check-gap" aria-hidden="true"></span> + Add a party member</button></li>`);
  }
  renderTracker(inGame);
}

/* ----- disclosure panels (the character menu and the save-status tip) ----- */
// Disclosure pattern, not role="menu": a button with aria-expanded controls a
// plain list. Escape closes and returns focus; clicking outside closes.

function setYouPanel(open, { returnFocus = false } = {}) {
  const panel = $("#you-panel");
  const wasOpen = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
  for (const id of ["#btn-char", "#btn-menu"]) $(id).setAttribute("aria-expanded", String(open));
  if (!open && wasOpen && returnFocus) visibleTrigger().focus();
}
// whichever of the two triggers this screen width shows
const visibleTrigger = () => ($("#btn-menu").offsetParent ? $("#btn-menu") : $("#btn-char"));

function setSaveTip(open) {
  $("#save-tip").classList.toggle("hidden", !open);
  $("#btn-save-info").setAttribute("aria-expanded", String(open));
}

/* ----- phase tracker ----- */

const TRACK = [...PHASES, "summary"];
const TRACK_LABEL = { achievements: "Achievements", scouting: "Scout", voting: "Threat", encounters: "Bosses", summary: "Summary" };
const PHASE_HINT = {
  achievements: "Post what went well and rally behind each other's wins",
  scouting: "Add the topics you want to discuss",
  voting: "Spread your threat across the topics, in secret",
  encounters: "Propose tactics and claim them to defeat each boss",
  summary: "The raid is over: review and export",
};

function renderTracker(inGame) {
  $("#phase-tracker").classList.toggle("hidden", !inGame);
  if (!inGame) return;
  const current = view.ended ? "summary" : view.phase;
  const at = TRACK.indexOf(current);
  setHtml($("#phase-steps"), TRACK.map((p, i) => {
    const state = i < at ? "done" : i === at ? "current" : "todo";
    const chevron = i < TRACK.length - 1 ? `<span class="phase-chev" aria-hidden="true">&#8250;</span>` : "";
    return `<li class="phase-step ${state}"${state === "current" ? ' aria-current="step"' : ""}>
        <span class="phase-pill">${state === "done" ? icon("check") : ""}<span class="phase-name">${TRACK_LABEL[p]}</span>${state === "done" ? `<span class="sr-only">, done</span>` : state === "current" ? `<span class="sr-only">, current phase</span>` : ""}</span>${chevron}
      </li>`;
  }).join(""));
  setText($("#phase-now"), TRACK_LABEL[current]);
  setText($("#phase-count"), `Phase ${at + 1} of ${TRACK.length}`);
  setHtml($("#phase-segments"), TRACK.map((p, i) => `<span class="seg ${i < at ? "done" : i === at ? "current" : ""}"></span>`).join(""));
  setText($("#phase-hint"), PHASE_HINT[current]);
}

/* ----- phase bar and timers ----- */

const NEXT_LABEL = {
  achievements: "Close Achievements",
  scouting: "Start Threat Voting",
  voting: "Start Boss Encounters",
};

// The facilitator row under the tracker: the phase timer (everyone sees a
// running one) and the host's Back / Next / End Raid.
function renderPhaseBar() {
  const at = PHASES.indexOf(view.phase);
  const host = isHost();
  $("#host-bar").classList.toggle("hidden", !host && !view.phaseTimer);
  $("#phase-controls").classList.toggle("hidden", !host);
  $("#btn-phase-back").disabled = at === 0;
  $("#btn-phase-next").classList.toggle("hidden", at === PHASES.length - 1);
  setText($("#btn-phase-next"), NEXT_LABEL[view.phase] || "");
  renderTimer($("#phase-timer"), "phase", view.phaseTimer, host, "Phase timer");
}

// Live countdowns tick locally between state updates.
const timers = {}; // target -> { deadline, paused, remainingMs, upAnnounced }

function renderTimer(slot, target, t, canControl, label) {
  const prev = timers[target];
  if (t) {
    timers[target] = {
      deadline: performance.now() + t.remainingMs, paused: t.paused, remainingMs: t.remainingMs,
      upAnnounced: prev && prev.durationMs === t.durationMs ? prev.upAnnounced : t.remainingMs === 0,
      durationMs: t.durationMs, label,
    };
  } else {
    delete timers[target];
  }
  if (!t && !canControl) { setHtml(slot, ""); return; }
  const controls = !canControl ? "" : t
    ? `<button class="btn btn-ghost btn-small" data-timer="${target}" data-timer-action="${t.paused ? "resume" : "pause"}">${t.paused ? "Resume" : "Pause"}</button>
       <button class="btn btn-ghost btn-small" data-timer="${target}" data-timer-action="extend" data-minutes="1">+1 min</button>
       <button class="btn btn-ghost btn-small" data-timer="${target}" data-timer-action="extend" data-minutes="5">+5 min</button>
       <button class="btn btn-ghost btn-small" data-timer="${target}" data-timer-action="clear">Clear</button>`
    : `<label class="timer-set"><span>${label}</span>
         <input type="number" min="1" max="120" value="${target === "enrage" ? 10 : 5}" id="timer-min-${target}" aria-label="${label} length in minutes" />
         <span aria-hidden="true">min</span></label>
       <button class="btn btn-ghost btn-small" data-timer="${target}" data-timer-action="set">Start</button>`;
  setHtml(slot, `<div class="timer${t && t.paused ? " paused" : ""}">
      ${t ? `${icon("hourglass")}<span class="timer-left" role="timer" data-timer-left="${target}"></span>` : ""}
      ${controls}
    </div>`);
}

function formatClock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function updateTimers() {
  for (const [target, t] of Object.entries(timers)) {
    const left = t.paused ? t.remainingMs : Math.max(0, t.deadline - performance.now());
    const label = target === "enrage" ? "until enrage" : "left";
    const text = t.paused ? `Paused, ${formatClock(left)} ${label}` : left > 0 ? `${formatClock(left)} ${label}` : (target === "enrage" ? "Enraging…" : "Time's up");
    for (const el of $$(`[data-timer-left="${target}"]`)) {
      setText(el, text);
      el.parentElement.classList.toggle("expired", left === 0 && !t.paused);
    }
    if (left === 0 && !t.paused && !t.upAnnounced && target === "phase") {
      t.upAnnounced = true;
      toast({ kind: "neutral", iconName: "hourglass", heading: "Time's up", title: `${PHASE_LABEL[view.phase]} timer has run out.` });
    }
  }
}
setInterval(() => { if (view) updateTimers(); }, 1000);

/* ----- achievements ----- */

function renderAchievements() {
  const open = view.phase === "achievements";
  const hasChar = !!view.you.memberId;
  setText($("#ach-intro"), `Post what went well. If someone already posted yours, rally behind theirs instead: rallies raise an achievement from Rare to Epic (${Math.round(RALLY_EPIC * 100)}% of the rest of the party) to Legendary (${Math.round(RALLY_LEGENDARY * 100)}%).`
    + (LOCAL ? " Use Acting as at the top to post or rally as each person." : ""));
  $("#ach-form").classList.toggle("hidden", !open || !hasChar);
  setText($("#ach-count"), plural(view.achievements.length, "achievement", "achievements"));

  const sorted = view.achievements
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rarityRank(y.a.rarity) - rarityRank(x.a.rarity) || x.i - y.i)
    .map((x) => x.a);
  setHtml($("#ach-board"), sorted.length ? sorted.map((a) => {
    const r = RARITY[a.rarity];
    const posters = a.posters.map((p) => escapeHtml(p.realName || p.name)).join(", ");
    const rally = open && hasChar && !a.mine
      ? `<button class="btn ${a.rallied ? "btn-primary" : "btn-ghost"} btn-small" data-rally="${a.id}" aria-pressed="${a.rallied}">${a.rallied ? "&#10003; Rallied" : "Rally"}<span class="sr-only"> behind ${escapeHtml(a.title)}</span></button>`
      : "";
    const remove = (isHost() || (a.mine && open))
      ? `<button class="li-remove" data-remove-ach="${a.id}" aria-label="Remove ${escapeHtml(a.title)}">&times;</button>` : "";
    return `<li class="ach-card r-${a.rarity}">
        <div class="ach-badge">${icon("trophy")}<span class="rarity-tag tag-${a.rarity}">${r.label}</span></div>
        <div class="ach-main">
          <div class="ach-title">${escapeHtml(a.title)}</div>
          ${a.detail ? `<div class="ach-detail">${escapeHtml(a.detail)}</div>` : ""}
          <div class="ach-by">Posted by ${posters}${a.mine ? " (you)" : ""}</div>
        </div>
        <div class="ach-actions">${rally}${remove}</div>
      </li>`;
  }).join("") : `<li class="empty-row muted">No achievements yet. Post the first one above.</li>`);

  const merge = $("#merge-bar");
  merge.classList.toggle("hidden", !isHost() || view.achievements.length < 2);
  if (isHost() && view.achievements.length >= 2) {
    const opts = view.achievements.map((a) => `<option value="${a.id}">${escapeHtml(a.title)}</option>`).join("");
    const keep = [$("#merge-source").value, $("#merge-target").value];
    setHtml($("#merge-source"), opts);
    setHtml($("#merge-target"), opts);
    if (view.achievements.some((a) => a.id === keep[0])) $("#merge-source").value = keep[0];
    if (view.achievements.some((a) => a.id === keep[1])) $("#merge-target").value = keep[1];
    else $("#merge-target").selectedIndex = 1;
  }
}

/* ----- the Mob List (scouting phase and the Mob List dialog) ----- */

function renderMobList(sel, inDialog) {
  const host = isHost();
  const canPull = inDialog && host && view.phase === "encounters" && !(view.boss && view.boss.status === "active");
  setText($("#scout-count"), plural(view.mobList.length, "topic", "topics") + " scouted");
  setHtml($(sel), view.mobList.length ? view.mobList.map((m) => {
    const by = m.addedReal ? `${m.addedBy} (${m.addedReal})` : m.addedBy;
    const threat = m.threat === null ? "" : ` &middot; ${plural(m.threat, "threat", "threat")}${m.threat === 0 ? " (won't be pulled automatically)" : ""}`;
    return `<li>
        <span class="mob-main">
          <span class="li-name">${escapeHtml(m.name)}</span>
          ${m.desc ? `<span class="mob-desc">${escapeHtml(m.desc)}</span>` : ""}
          <span class="li-sub">Scouted by ${escapeHtml(by)}${threat}</span>
        </span>
        ${canPull ? `<button class="btn btn-primary btn-small" data-pull-mob="${m.id}">Pull<span class="sr-only"> ${escapeHtml(m.name)}</span></button>` : ""}
        ${host || m.addedById === view.you.memberId ? `<button class="li-remove" data-remove-mob="${m.id}" aria-label="Remove ${escapeHtml(m.name)} from the Mob List">&times;</button>` : ""}
      </li>`;
  }).join("") : `<li class="empty-row muted">No topics scouted yet. Add the first one above.</li>`);
}

function addMobFrom(form) {
  const name = form.querySelector("[name=mob-name]");
  const desc = form.querySelector("[name=mob-desc]");
  if (!name.value.trim()) { name.focus(); return; }
  send({ type: "addMob", name: name.value, desc: desc.value });
  name.value = ""; desc.value = "";
  name.focus();
}

/* ----- threat voting ----- */

let ballotOpenFor = null; // local mode: whose private ballot is on screen

// A topic's name with its scouted description, so voters know what they're
// weighing. The stepper buttons point at the description for screen readers.
function ballotTopic(m) {
  return `<span class="ballot-topic">
      <span class="ballot-name">${escapeHtml(m.name)}</span>
      ${m.desc ? `<span class="ballot-desc" id="ballot-desc-${m.id}">${escapeHtml(m.desc)}</span>` : ""}
    </span>`;
}
const describedBy = (m) => (m.desc ? ` aria-describedby="ballot-desc-${m.id}"` : "");

function renderVoting() {
  const t = view.threat;
  const me = view.members.find((m) => m.id === view.you.memberId);
  setText($("#vote-count"), `${t.voters} of ${view.members.length} voted`);
  setText($("#vote-intro"), t.revealed
    ? "Threat is revealed. Bosses are pulled highest threat first, and threat sets their tier: the bigger the boss, the more of its plan the party must own. Topics with no threat won't be pulled."
    : `Each player has ${t.budget} threat to spread across the topics. Put it on whatever worries you most; you can stack it all on one. Ballots stay hidden until the host reveals them.`);

  const gate = $("#ballot-gate");
  const showGate = LOCAL && !t.revealed && me && ballotOpenFor !== me.id;
  gate.classList.toggle("hidden", !showGate);
  if (showGate) {
    setHtml(gate, `<p>Ballots are private. Hand the screen to <b>${escapeHtml(me.name)}</b>${me.hasThreatVoted ? " (already voted; they can change it)" : ""}.</p>
      <button class="btn btn-primary" data-open-ballot="${me.id}">I'm ${escapeHtml(me.name)}: show my ballot</button>`);
  }
  $("#ballot").classList.toggle("hidden", showGate);
  $("#ballot-done").classList.toggle("hidden", !(LOCAL && !t.revealed));

  const ballot = view.you.myBallot;
  const spent = Object.values(ballot).reduce((a, b) => a + b, 0);
  const left = t.budget - spent;
  const top = Math.max(0, ...view.mobList.map((m) => m.threat || 0));

  if (t.revealed) {
    setText($("#ballot-budget"), "");
    const ranked = [...view.mobList].sort((a, b) => b.threat - a.threat);
    setHtml($("#ballot-list"), ranked.length ? ranked.map((m) => {
      return `<li class="ballot-row revealed">
          ${ballotTopic(m)}
          <span class="ballot-total">${plural(m.threat, "threat", "threat")}</span>
          <span class="ballot-hp">${m.threat ? tierPreview(tierForThreat(m.threat, top)) : "Not pulled"}</span>
        </li>`;
    }).join("") : `<li class="empty-row muted">No topics on the Mob List.</li>`);
  } else if (!me) {
    setText($("#ballot-budget"), "Create a character to vote.");
    setHtml($("#ballot-list"), "");
  } else {
    setText($("#ballot-budget"), `${left} of ${t.budget} threat left${LOCAL ? ` for ${me.name}` : ""}.`);
    setHtml($("#ballot-list"), view.mobList.length ? view.mobList.map((m) => {
      const n = ballot[m.id] || 0;
      return `<li class="ballot-row">
          ${ballotTopic(m)}
          <span class="stepper">
            <button class="btn btn-ghost btn-step" data-threat="${m.id}" data-delta="-1" ${n === 0 ? "disabled" : ""} aria-label="Remove threat from ${escapeHtml(m.name)}"${describedBy(m)}>&minus;</button>
            <span class="stepper-value" aria-label="${escapeHtml(m.name)}: ${plural(n, "threat", "threat")}">${n}</span>
            <button class="btn btn-ghost btn-step" data-threat="${m.id}" data-delta="1" ${left === 0 ? "disabled" : ""} aria-label="Add threat to ${escapeHtml(m.name)}"${describedBy(m)}>+</button>
          </span>
        </li>`;
    }).join("") : `<li class="empty-row muted">No topics on the Mob List yet. The host can step back to Scouting.</li>`);
  }

  $("#vote-controls").classList.toggle("hidden", !isHost());
  $("#btn-reveal").classList.toggle("hidden", t.revealed);
  $("#btn-reopen").classList.toggle("hidden", !t.revealed);
}

function changeThreat(mobId, delta) {
  const ballot = { ...view.you.myBallot };
  ballot[mobId] = Math.max(0, (ballot[mobId] || 0) + delta);
  send({ type: "castThreat", ballot });
}

/* ----- boss encounters ----- */

function renderEncounters() {
  renderStageControls();
  renderBoss();
  renderActiveDrop();
  renderMyVote();
  renderTally();
  renderResult();
}

const live = () => !!view.boss && view.boss.status === "active";
// Preparation: the party plans before the fight, and HP doesn't exist yet.
const preparing = () => live() && view.boss.phase === "prep";
const tierPreview = (tier) => `${tierLabel(tier)} &middot; needs ${plural(BOSS_TIERS[tier].minTactics, "tactic", "tactics")}`;
const voteOpen = () => !!view.activeDrop && !view.resolved;

function renderStageControls() {
  const host = isHost();
  $("#facilitator-controls").classList.toggle("hidden", !host);
  const anyThreat = view.mobList.some((m) => m.threat > 0);
  $("#btn-pull-boss").classList.toggle("hidden", live());
  $("#btn-pull-boss").disabled = !anyThreat;
  // preparing: Engage (once the plan is big enough); fighting: drops and victory
  const prep = preparing();
  const need = prep ? BOSS_TIERS[view.boss.tier].minTactics - view.boss.tactics.length : 0;
  $("#btn-engage").classList.toggle("hidden", !prep);
  $("#btn-engage").disabled = need > 0;
  $("#engage-hint").classList.toggle("hidden", !prep || need <= 0);
  setText($("#engage-hint"), need > 0 ? `Needs ${plural(need, "more proposed tactic", "more proposed tactics")}` : "");
  for (const id of ["#btn-drop-random", "#btn-drop-manual", "#btn-tactical"]) $(id).classList.toggle("hidden", !live() || prep);
  $("#btn-tactical").disabled = voteOpen();
  $("#btn-clear-stage").classList.toggle("hidden", !view.boss || live());
  $("#tactic-composer").classList.toggle("hidden", !live());
}

const STATUS_LINE = {
  tactical: (name, boss) => `${icon("flag")} Tactical Victory over ${name}! ${boss.note ? `Note: ${escapeHtml(boss.note)}.` : "The room agreed the problem is handled."}`,
  abandoned: (name) => `${icon("flag")} ${name} was abandoned: the raid ended mid-fight.`,
  enraged: (name) => `${icon("hourglass")} ${name} enrages! Time ran out, so the encounter wraps up here.`,
};

function renderBoss() {
  const el = $("#boss");
  const boss = view.boss;
  if (!boss) { el.classList.toggle("hidden", true); return; }
  const prep = boss.phase === "prep";
  const pct = boss.hpMax == null ? 100 : Math.max(0, Math.round((boss.hp / boss.hpMax) * 100));
  const looted = view.log.filter((t) => t.bossId === boss.id && !t.passedOver).length;
  setClass(el, `boss status-${boss.status}`);
  el.style.setProperty("--boss-color", TIER_COLOR[boss.tier] || TIER_COLOR.normal);
  const hpText = boss.hpMax == null ? "??? HP" : `${Math.ceil(boss.hp)} / ${boss.hpMax} HP`;
  const status = boss.status === "active" ? hpText
    : boss.status === "slain" ? BOSS_STATUS.slain.toUpperCase()
    : `${BOSS_STATUS[boss.status].toUpperCase()} · ${hpText}`; // what was left when it ended
  let line;
  if (boss.status === "slain") line = slainLine(boss.name, looted);
  else if (boss.status !== "active") line = `${STATUS_LINE[boss.status](escapeHtml(boss.name), boss)} ${plural(looted, "piece", "pieces")} of loot claimed.`;
  else if (prep) {
    const need = BOSS_TIERS[boss.tier].minTactics;
    line = `Prepare: propose tactics and rally behind the best. The boss's HP is set from your plan when the host engages. `
      + `${plural(boss.tactics.length, "tactic", "tactics")} proposed &middot; needs ${need} to engage.`;
  } else line = `Every tactic someone owns damages the boss. Owning ${Math.round(BOSS_TIERS[boss.tier].hpPct * 100)}% of the plan's damage brings it down; new tactics add to its HP.`;
  setHtml(el, `
    <span class="boss-glow" aria-hidden="true"></span>
    <div class="boss-head">
      <h3 class="boss-name"><span class="skull">${boss.status === "slain" ? icon("swords") : icon("skull")}</span>${escapeHtml(boss.name)}</h3>
      <div class="boss-tier">${tierLabel(boss.tier)}</div>
    </div>
    ${boss.desc ? `<div class="boss-desc-text">${escapeHtml(boss.desc)}</div>` : ""}
    <div class="boss-scout">${boss.scoutedBy ? `Scouted by ${escapeHtml(boss.scoutedBy)} &middot; ` : ""}${plural(boss.threat || 0, "threat", "threat")}</div>
    ${prep
      // no value to measure yet, so plain text rather than a meter
      ? `<div class="boss-hpwrap unknown">
          <div class="boss-hp" style="width:100%;"></div>
          <div class="boss-hptext" aria-hidden="true">${status}</div>
          <span class="sr-only">Boss health: unknown until the party engages.</span>
        </div>`
      : `<div class="boss-hpwrap" role="meter" aria-label="Boss health" aria-valuemin="0" aria-valuemax="${boss.hpMax}" aria-valuenow="${Math.ceil(boss.hp)}" aria-valuetext="${status}">
          <div class="boss-hp" style="width:${pct}%;"></div>
          <div class="boss-hptext" aria-hidden="true">${status}</div>
        </div>`}
    <div class="${boss.status === "active" ? "boss-sub" : "boss-slain-line"}">${line}</div>
    <div id="enrage-timer" class="timer-slot"></div>
    ${renderTactics(boss)}`);
  if (boss.status === "active" && !prep) renderTimer($("#enrage-timer"), "enrage", boss.enrage, isHost(), "Enrage timer");
  else delete timers.enrage;
}

function rarityOptions(selected, withDamage) {
  return RARITIES.map((r) => `<option value="${r}"${r === selected ? " selected" : ""}>${RARITY[r].label} (${PRIORITY[r]})${withDamage ? ` &middot; ${TACTIC_DAMAGE[r]} dmg` : ""}</option>`).join("");
}

// A rarity shown as text, so it never relies on colour alone.
function rarityTag(item) {
  const from = item.rarityFrom ? ` <span class="rarity-from">(changed from ${RARITY[item.rarityFrom].label})</span>` : "";
  return `<span class="rarity-tag tag-${item.rarity}">${RARITY[item.rarity].label}</span>${from}`;
}

function renderTactics(boss) {
  const tactics = boss.tactics || [];
  if (tactics.length === 0) return "";
  const host = isHost();
  const hasChar = !!view.you.memberId;
  const activeId = view.activeDrop ? view.activeDrop.item.id : null;
  const rows = tactics.map((s) => {
    const owned = view.log.find((t) => t.tacticId === s.id && !t.passedOver);
    const onTable = s.id === activeId;
    let statusCls, statusText;
    if (owned) { statusCls = "owned"; statusText = `${icon("person")} ${escapeHtml(owned.ownerReal || owned.ownerName)}`; }
    else if (onTable) { statusCls = "ontable"; statusText = view.resolved ? "unowned" : "on the table"; }
    else if (s.dropped) { statusCls = "unowned"; statusText = "unowned"; }
    else { statusCls = "proposed"; const who = s.proposedReal || s.proposedBy; statusText = who ? `proposed by ${escapeHtml(who)}` : "proposed"; }

    // The host checks rarity before dropping a tactic, then drops it. Online,
    // "Rallies decide" hands an overridden tactic back to the party's rallies.
    const canEdit = host && !s.dropped && live();
    const earned = s.rarityFrom || s.rarity;
    const ralliesOption = s.rallyable
      ? `<option value="rallies"${s.overridden ? "" : " selected"}>Rallies decide: ${RARITY[earned].label}</option>` : "";
    const rarity = canEdit
      ? `<label class="sr-only" for="rarity-${s.id}">Rarity for ${escapeHtml(s.name)}</label>
         <select id="rarity-${s.id}" class="rarity-select" data-tactic-rarity="${s.id}">${ralliesOption}${rarityOptions(s.rallyable && !s.overridden ? null : s.rarity, true)}</select>
         ${s.rarityFrom ? `<span class="rarity-from">(${s.rallyable ? "rallies say" : "was"} ${RARITY[s.rarityFrom].label})</span>` : ""}`
      : rarityTag(s);
    let rally = "";
    if (s.rallyable && hasChar && s.mine) rally = `<span class="tactic-yours muted">Yours</span>`;
    else if (s.rallyable && hasChar) {
      rally = `<button class="btn ${s.rallied ? "btn-primary" : "btn-ghost"} btn-small" data-rally-tactic="${s.id}" aria-pressed="${s.rallied}">${s.rallied ? "&#10003; Rallied" : "Rally"}<span class="sr-only"> behind ${escapeHtml(s.name)}</span></button>`;
    }
    const drop = canEdit && !preparing() // nothing drops until the boss is engaged
      ? `<button class="btn btn-primary btn-small" data-drop-tactic="${s.id}" ${voteOpen() ? "disabled" : ""}>Drop<span class="sr-only"> ${escapeHtml(s.name)}</span></button>` : "";
    return `<li class="tactic ${statusCls}">
        <span class="tactic-name r-${s.rarity}">${escapeHtml(s.name)}</span>
        <span class="tactic-rarity">${rarity}</span>
        <span class="tactic-status">${statusText}</span>
        ${rally}${drop}
      </li>`;
  }).join("");
  const pending = tactics.filter((s) => !s.dropped).length;
  return `<div class="tactics">
      <h4 class="tactic-head">Tactics &mdash; ${plural(tactics.length, "tactic", "tactics")} proposed${pending ? ` &mdash; ${pending} awaiting a drop` : ""}</h4>
      ${host && pending && voteOpen() ? `<p class="muted field-hint">Resolve the current drop before dropping another.</p>` : ""}
      <ul class="tactic-list">${rows}</ul>
    </div>`;
}

function renderActiveDrop() {
  const el = $("#active-drop");
  const drop = view.activeDrop;
  if (!drop) {
    const host = isHost();
    const waiting = view.mobList.filter((m) => m.threat > 0).length;
    const left = waiting ? `${plural(waiting, "topic", "topics")} with threat left.` : "No topics with threat left.";
    let hint;
    if (!view.boss) hint = host ? `The dungeon is quiet. ${left} ${waiting ? "Pull a Boss takes the highest threat first." : "Pull one by hand from the Mob List."}` : `The dungeon is quiet. ${left} Waiting for the host to pull a boss…`;
    else if (!live()) hint = host ? `The encounter is over. ${left} Pull the next boss, or clear the stage.` : `The encounter is over. Waiting for the host…`;
    else if (preparing()) hint = host ? "The party is preparing. When the plan is ready, Engage sets the boss's HP and the fight begins." : "The party is preparing: propose tactics above and rally behind the best. The host engages when the plan is ready.";
    else hint = host ? "The boss is engaged! Check a proposed tactic's rarity, then drop it to roll for it." : "The boss is engaged! Propose a tactic above, or rally behind one; the host drops proposed tactics for the roll.";
    setClass(el, "active-drop empty");
    setHtml(el, `<p class="empty-hint">${hint}</p>`);
    return;
  }
  const r = drop.item.rarity;
  setClass(el, "active-drop filled");
  setHtml(el, `
    <div class="drop-icon r-${r}">${icon("gem")}</div>
    <div class="drop-meta">
      <h3 class="r-${r}">${escapeHtml(drop.item.name)}</h3>
      <div class="drop-rarity">${rarityTag(drop.item)}</div>
      ${drop.item.desc ? `<div class="drop-desc">${escapeHtml(drop.item.desc)}</div>` : ""}
    </div>`);
}

function renderMyVote() {
  const bar = $("#my-vote");
  // local mode votes from each party panel instead
  if (LOCAL || !voteOpen()) { bar.classList.toggle("hidden", true); return; }
  bar.classList.toggle("hidden", false);
  const me = view.members.find((m) => m.id === view.you.memberId);
  const full = !!me && me.slotsUsed >= view.bagSize;
  for (const b of $$("[data-mychoice]")) {
    const choice = b.dataset.mychoice;
    const on = view.you.myChoice === choice;
    b.disabled = !me || (full && choice !== "pass");
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
    setHtml(b, `${on ? "&#10003; " : ""}${cap(choice)}`);
  }
  setText($("#my-vote-hint"), !me ? "Claim a party slot to vote."
    : full ? bagsFullMessage(me.slotsUsed, view.bagSize)
    : view.you.myChoice ? `You chose ${cap(view.you.myChoice)}. Select it again to undo.`
    : "Your choice is hidden from others until the host resolves.");
}

function renderTally() {
  const bar = $("#resolve-bar");
  if (!voteOpen()) { bar.classList.toggle("hidden", true); return; }
  bar.classList.toggle("hidden", false);
  const t = view.tally;
  setHtml($("#vote-tally"), `<span>Need <b>${t.need}</b></span><span>Greed <b>${t.greed}</b></span>
    <span>Pass <b>${t.pass}</b></span><span class="muted">Undecided <b>${t.undecided}</b></span>`);
  $("#btn-resolve").classList.toggle("hidden", !isHost());
}

function renderResult() {
  const el = $("#result-banner");
  const res = view.lastResult;
  if (!view.resolved || !res) { el.classList.toggle("hidden", true); return; }
  el.classList.toggle("hidden", false);
  const r = res.rarity;
  const headline = res.winnerId
    ? `<span class="r-${r}">${escapeHtml(res.winnerName)}</span>${res.winnerReal ? ` <span class="real-name">(${escapeHtml(res.winnerReal)})</span>` : ""} wins <b class="r-${r}">${escapeHtml(res.itemName)}</b> (${RARITY[r].label}) by <b>${res.winnerContext}</b> roll!`
    : `Everyone passed on <b class="r-${r}">${escapeHtml(res.itemName)}</b> (${RARITY[r].label}). It lies unclaimed.`;
  const rows = res.rolls.map((rw) => {
    const win = rw.memberId === res.winnerId ? ` <span class="win-tag">&#9733; WIN</span>` : "";
    const who = rw.realName ? ` <span class="real-name">(${escapeHtml(rw.realName)})</span>` : "";
    const txt = rw.choice === "pass" ? (rw.bagsFull ? "passed (bags full)" : "passed")
      : rw.roll === null ? `${cap(rw.choice)} &mdash; didn't roll (${res.winnerContext} takes priority)`
      : `${cap(rw.choice)} &mdash; rolled <b>${rw.roll}</b>`;
    return `<div class="roll-row">${escapeHtml(rw.name)}${who}: ${txt}${win}</div>`;
  }).join("");
  setHtml(el, `<div class="winner-line">${headline}</div>${damageLine(res)}<div class="roll-detail">${rows}</div>`);
}

/* ----- party, quest log and loot log ----- */

// A player's bags: `max` slots, filled with their open tasks. Each filled
// slot shows a loot bag plus the rarity's initial, so it isn't colour alone.
const seenBagTasks = new Set();
// Bag size follows the party size, so it can shrink below what someone
// already holds. Nothing is taken away: the extra bags are drawn outside the
// limit and the player can't win more until they're back under it.
function bagSlots(tasks, size) {
  const used = tasks.length;
  let html = "";
  for (let i = 0; i < Math.max(size, used); i++) {
    const t = tasks[i];
    const over = i >= size ? " over" : "";
    if (!t) { html += `<span class="bag-slot"></span>`; continue; }
    const fresh = !seenBagTasks.has(t.id);
    seenBagTasks.add(t.id);
    html += `<span class="bag-slot filled r-${t.rarity}${over}${fresh ? " fresh" : ""}">${svgIcon("bag-icon", ICON_PATHS.lootbag)}<span class="bag-letter" aria-hidden="true">${RARITY[t.rarity].label[0]}</span></span>`;
  }
  const state = used > size ? "over" : used >= size ? "full" : "";
  const word = used > size ? " &mdash; over the limit" : used >= size ? " &mdash; full" : "";
  return `<div class="bag-slots${state ? ` ${state}` : ""}" aria-hidden="true">${html}</div>
    <div class="member-bags-label${state ? ` ${state}` : ""}">Bags ${used}/${size}${word}</div>`;
}

function bagsFullMessage(used, size) {
  const toFree = plural(used - size + 1, "task", "tasks");
  return used > size
    ? `Your bags are over the limit (${used}/${size}) since the party grew. Complete ${toFree} to win more.`
    : `Your bags are full (${used}/${size}). Complete a task to free a slot.`;
}

function renderParty() {
  setHtml($("#party-count"), `${plural(view.members.length, "member", "members")}${LOCAL ? "" : ` &middot; ${hostCrown()} Host &middot; ${youStar()} You`}`);
  const grid = $("#party-grid");
  setHtml(grid, view.members.map((m) => {
    const color = CLASS_COLORS[m.cls] || "#c8aa6e";
    const mine = view.you.memberId === m.id;
    const initials = m.name.trim().slice(0, 2).toUpperCase() || "??";
    let status;
    if (view.resolved && view.lastResult) {
      const rw = view.lastResult.rolls.find((x) => x.memberId === m.id);
      status = !rw ? "" : rw.choice === "pass" ? (rw.bagsFull ? "Passed (bags full)" : "Passed")
        : rw.roll === null ? `${cap(rw.choice)} (didn't roll)`
        : `${cap(rw.choice)} roll: ${rw.roll}${rw.memberId === view.lastResult.winnerId ? ` <span class="win-tag">&#9733; WON</span>` : ""}`;
    } else if (view.activeDrop) {
      status = m.hasVoted ? "Vote locked in" : "Deciding…";
    } else if (view.phase === "voting" && !view.threat.revealed) {
      status = m.hasThreatVoted ? "Threat voted" : "Hasn't voted yet";
    } else {
      status = m.claimed && m.connected ? "Ready" : m.held ? "Away" : m.proxy ? "Proxy slot" : "Open slot";
    }
    const tasks = view.log.filter((t) => t.ownerId === m.id);
    const full = m.slotsUsed >= view.bagSize;
    const crest = m.faction
      ? `<span class="faction-crest crest-${m.faction.toLowerCase()}">${factionIcon(m.faction)}<span class="sr-only">${m.faction}</span></span>` : "";

    // local mode: every panel votes for its own member on the shared screen
    let choiceRow = "";
    if (LOCAL && voteOpen()) {
      const current = view.choices ? view.choices[m.id] : null;
      choiceRow = `<div class="choice-row" role="group" aria-label="${escapeHtml(m.name)}'s call">${["need", "greed", "pass"].map((c) => {
        const on = current === c;
        const off = full && c !== "pass";
        return `<button class="choice-btn${on ? " active" : ""}" data-choice="${c}" data-member="${m.id}" aria-pressed="${on}" ${off ? "disabled" : ""}>${on ? "&#10003; " : ""}${cap(c)}</button>`;
      }).join("")}</div>`;
    }
    const claim = !LOCAL && !m.claimed && !view.you.memberId
      ? `<button class="btn btn-primary btn-small" data-claim="${m.id}">Claim this slot</button>` : "";
    return `<div class="member${m.faction ? ` faction-${m.faction.toLowerCase()}` : ""}" style="--member-color:${color}">
        <div class="member-head">
          <div class="member-avatar" aria-hidden="true">${raceIcon(m.race) || escapeHtml(initials)}</div>
          <div class="member-headtext">
            <h3 class="member-name">${crest}${escapeHtml(m.name)}${m.isHost ? hostCrown() : ""}${mine && !LOCAL ? youStar() : ""}</h3>
            <div class="member-class">${escapeHtml(`${m.race} ${m.cls}`)}</div>
            ${m.realName ? `<div class="member-real">${icon("person")} ${escapeHtml(m.realName)}</div>` : ""}
          </div>
        </div>
        ${choiceRow}
        <div class="member-roll">${status}</div>
        <div class="member-bags">
          ${bagSlots(tasks.filter((t) => !t.done), view.bagSize)}
        </div>
        ${claim}
        <ul class="member-tasks">
          ${tasks.map((t) => `<li class="mini-task ${t.done ? "done" : ""}">
              <input type="checkbox" id="mini-${t.id}" data-task="${t.id}" ${t.done ? "checked" : ""}/>
              <label for="mini-${t.id}">${escapeHtml(t.name)} <span class="rarity-tag tag-${t.rarity}">${RARITY[t.rarity].label}</span></label>
            </li>`).join("")}
        </ul>
      </div>`;
  }).join(""));
}

// Who owns how many open vs. done tasks (keyed by real name for accountability).
function renderAccountability() {
  const section = $("#accountability");
  const byOwner = new Map();
  for (const t of view.log) {
    if (t.passedOver) continue;
    const key = t.ownerReal || t.ownerName;
    if (!byOwner.has(key)) byOwner.set(key, { key, character: t.ownerName, open: 0, done: 0 });
    byOwner.get(key)[t.done ? "done" : "open"]++;
  }
  section.classList.toggle("hidden", byOwner.size === 0);
  if (byOwner.size === 0) return;
  const rows = [...byOwner.values()].sort((a, b) => (b.open - a.open) || (b.open + b.done - a.open - a.done));
  setText($("#accountability-sub"), `${rows.reduce((n, r) => n + r.open, 0)} open across ${plural(rows.length, "person", "people")}`);
  setHtml($("#accountability-list"), rows.map((r) => {
    const total = r.open + r.done;
    const charHint = r.key !== r.character ? ` <span class="acc-char">as ${escapeHtml(r.character)}</span>` : "";
    return `<li class="accountability-row${r.open === 0 ? " all-clear" : ""}">
        <span class="acc-name">${icon("person")} ${escapeHtml(r.key)}${charHint}</span>
        <span class="acc-counts">
          <span class="acc-open">${r.open} open</span>
          <span class="acc-done">${r.done} done</span>
          <span class="acc-bar" aria-hidden="true">${total ? `<span class="acc-bar-done" style="width:${Math.round((r.done / total) * 100)}%"></span>` : ""}</span>
        </span>
      </li>`;
  }).join(""));
}

function renderLog() {
  const looted = view.log.filter((t) => !t.passedOver).length;
  const passed = view.log.length - looted;
  setText($("#log-count"), `${plural(looted, "item", "items")} looted${passed ? `, ${passed} passed over` : ""}`);
  setHtml($("#loot-log-list"), view.log.length ? [...view.log].reverse().map((t) => {
    const name = `<span class="log-name r-${t.rarity}">${escapeHtml(t.name)}</span> ${rarityTag(t)}`;
    if (t.passedOver) {
      return `<li class="passed-over"><span class="log-text">${name}</span><span class="log-owner log-passed">&#8856; passed over</span></li>`;
    }
    return `<li class="${t.done ? "done" : ""}">
        <input type="checkbox" id="log-${t.id}" data-task="${t.id}" ${t.done ? "checked" : ""} aria-label="Done: ${escapeHtml(t.name)}"/>
        <span class="log-text">${name}</span>
        <span class="log-owner">${icon("person")} ${escapeHtml(t.ownerReal || t.ownerName)}${t.ownerReal ? ` <span class="log-char">as ${escapeHtml(t.ownerName)}</span>` : ""}</span>
      </li>`;
  }).join("") : `<li class="empty-row muted">No loot has dropped yet.</li>`);
}

/* ---------------- Character creation ---------------- */

let chosenRace = "Human";
let chosenClass = "Warrior";

function renderCreateChar() {
  const local = LOCAL;
  if (editingChar) {
    setText($("#char-title"), "Edit Your Character");
    setText($("#char-intro"), "Change your name, real name, race or class. Your loot stays with you.");
    $("#btn-cancel-char").classList.remove("hidden");
    setText($("#btn-create-char"), "Save Changes");
    $("#reclaim").classList.toggle("hidden", true);
    ensureValidClass();
    renderFactionPicker(); renderRacePicker(); renderClassPicker();
    return;
  }
  setText($("#char-title"), local ? "Add a Party Member" : "Create Your Character");
  setText($("#char-intro"), local
    ? "Add each person at the table. Use Acting as at the top to switch who's posting, rallying or voting."
    : "Pick a name and class. This becomes your own panel — no need to wait for the host.");
  $("#btn-cancel-char").classList.toggle("hidden", !(local && view.members.length));
  setText($("#btn-create-char"), local ? "Add to Party" : "Create Character");
  renderReclaim();
  ensureValidClass();
  renderFactionPicker();
  renderRacePicker();
  renderClassPicker();
}

// Open characters (nobody connected to them) that a returning player can take back.
function renderReclaim() {
  const open = LOCAL ? [] : view.members.filter((m) => !m.claimed);
  $("#reclaim").classList.toggle("hidden", open.length === 0);
  setHtml($("#reclaim-list"), open.map((m) => {
    const tasks = view.log.filter((t) => t.ownerId === m.id && !t.passedOver && !t.done).length;
    return `<button class="reclaim-option" data-reclaim="${m.id}" style="--member-color:${CLASS_COLORS[m.cls] || "#c8aa6e"}">
        <span class="member-avatar" aria-hidden="true">${raceIcon(m.race)}</span>
        <span class="reclaim-text">
          <span class="reclaim-name">${escapeHtml(m.name)}</span>
          <span class="reclaim-sub">${escapeHtml(`${m.race} ${m.cls}`)}${m.realName ? ` &middot; ${escapeHtml(m.realName)}` : ""}</span>
          <span class="reclaim-sub">${plural(tasks, "open task", "open tasks")}</span>
        </span>
      </button>`;
  }).join(""));
}

const checkMark = (on) => (on ? `<span class="pick-check" aria-hidden="true">&#10003;</span>` : "");

function renderFactionPicker() {
  const chosen = FACTION[chosenRace];
  setHtml($("#faction-picker"), ["Alliance", "Horde"].map((f) => `
    <button class="faction-option${f === chosen ? " active" : ""}" data-faction="${f}" aria-pressed="${f === chosen}" style="--faction-color:${FACTION_COLOR[f]}">
      ${checkMark(f === chosen)}${factionIcon(f, "faction-icon")}<span class="pick-label">${f}</span>
    </button>`).join(""));
}

function renderRacePicker() {
  const faction = FACTION[chosenRace];
  setHtml($("#race-picker"), Object.keys(RACE_CLASSES).filter((r) => FACTION[r] === faction).map((race) => `
    <button class="race-option${race === chosenRace ? " active" : ""}" data-race="${race}" aria-pressed="${race === chosenRace}" style="--faction-color:${FACTION_COLOR[faction]}">
      ${checkMark(race === chosenRace)}${raceIcon(race)}<span class="pick-label">${race}</span>
    </button>`).join(""));
}

function renderClassPicker() {
  setHtml($("#class-picker"), (RACE_CLASSES[chosenRace] || []).map((name) => `
    <button class="class-option${name === chosenClass ? " active" : ""}" data-cls="${name}" aria-pressed="${name === chosenClass}" style="--class-color:${CLASS_COLORS[name] || "#c8aa6e"}">
      ${checkMark(name === chosenClass)}${classIcon(name)}<span class="pick-label">${name}</span>
    </button>`).join(""));
}

// Switching faction moves you to its first race (and a class that race allows).
function selectFaction(faction) {
  if (FACTION[chosenRace] === faction) return;
  const race = Object.keys(RACE_CLASSES).find((r) => FACTION[r] === faction);
  if (race) selectRace(race);
}

function selectRace(race) {
  if (!RACE_CLASSES[race]) return;
  chosenRace = race;
  ensureValidClass();
  withFocusKept(() => { renderFactionPicker(); renderRacePicker(); renderClassPicker(); });
}

function ensureValidClass() {
  const legal = RACE_CLASSES[chosenRace] || [];
  if (!legal.includes(chosenClass)) chosenClass = legal[0] || "Warrior";
}

function submitCharacter() {
  const name = $("#char-name").value.trim();
  const realName = $("#char-realname").value.trim();
  if (!name) { $("#char-error").textContent = "Enter a character name."; $("#char-name").focus(); return; }
  if (!realName) { $("#char-error").textContent = "Enter a real name (for accountability)."; $("#char-realname").focus(); return; }
  $("#char-error").textContent = "";
  if (editingChar) {
    editingChar = false;
    send({ type: "editCharacter", name, realName, cls: chosenClass, race: chosenRace });
  } else {
    addingMember = false;
    send({ type: "createCharacter", name, realName, cls: chosenClass, race: chosenRace });
  }
  $("#char-name").value = ""; $("#char-realname").value = "";
}

/* ---------------- Toasts and announcements ---------------- */

// Visual toasts are aria-hidden; this polite live region reads them out
// without moving focus. Messages arriving together are read together.
let pendingAnnouncements = [];
function announce(text) {
  pendingAnnouncements.push(text);
  if (pendingAnnouncements.length > 1) return;
  setTimeout(() => {
    const el = $("#announcer");
    el.textContent = "";
    const message = pendingAnnouncements.join(" ");
    pendingAnnouncements = [];
    setTimeout(() => { el.textContent = message; }, 30);
  }, 60);
}

// kind: a rarity (poor…legendary), "neutral" or "error".
function toast({ kind, iconName, heading, title, lines = [], life = 5000 }) {
  const spoken = [heading, title && title.replace(/^\[|\]$/g, ""), ...lines.map(stripTags)]
    .filter(Boolean).map((t) => t.trim().replace(/[.!?:]$/, (m) => (m === ":" ? "" : m)))
    .map((t) => (/[.!?]$/.test(t) ? t : `${t}.`));
  announce(spoken.join(" "));
  const el = document.createElement("div");
  el.className = `loot-toast t-${kind}`;
  setHtml(el, `
    <div class="toast-icon">${icon(iconName)}</div>
    <div class="toast-body">
      <div class="toast-received">${escapeHtml(heading)}</div>
      ${title ? `<div class="toast-item">${escapeHtml(title)}</div>` : ""}
      ${lines.map((l) => `<div class="toast-value">${l}</div>`).join("")}
    </div>`);
  $("#toast-stack").appendChild(el);
  const remove = () => {
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  };
  setTimeout(remove, life);
}

// Compare with the previous view and announce what changed, on every screen.
function announceChanges() {
  const prev = prevView;
  if (!prev) return;
  if (!prev.ended && view.ended) {
    toast({ kind: "neutral", iconName: "trophy", heading: "The raid has ended", title: "Raid Summary", life: 5000 });
    $("#summary-title").focus(); // the screen it was on is gone
    return;
  }
  if (prev.ended && !view.ended) {
    toast({ kind: "neutral", iconName: "flag", heading: "The raid was reopened", title: PHASE_LABEL[view.phase], life: 4000 });
    $("#host-bar").querySelector("button:not(.hidden):not([disabled])")?.focus();
    return;
  }
  if (view.ended) return;
  if (prev.bagSize !== view.bagSize && view.members.length) {
    toast({ kind: "neutral", iconName: "lootbag", heading: "Bag size changed", title: `Bags now hold ${view.bagSize}`,
      lines: [`Party of ${view.partySize}: ${TEAM_ACTION_BUDGET} actions shared, at least ${MIN_BAG_SLOTS} each.`], life: 4500 });
  }
  if (prev.phase !== view.phase) {
    toast({ kind: "neutral", iconName: "flag", heading: "New phase", title: PHASE_LABEL[view.phase], life: 3500 });
  }
  for (const a of view.achievements) {
    const before = prev.achievements.find((x) => x.id === a.id);
    const by = a.posters.map((p) => p.name).join(", ");
    if (!before) {
      toast({ kind: a.rarity, iconName: "trophy", heading: "Achievement Earned", title: `[${a.title}]`, lines: [`<span class="rarity-label">${RARITY[a.rarity].label}</span> posted by ${escapeHtml(by)}`] });
    } else if (rarityRank(a.rarity) > rarityRank(before.rarity)) {
      toast({ kind: a.rarity, iconName: "trophy", heading: `Achievement upgraded to ${RARITY[a.rarity].label}!`, title: `[${a.title}]`, life: 6000 });
    }
  }
  if (view.boss && prev.boss && view.boss.id === prev.boss.id) {
    for (const t of view.boss.tactics) {
      const before = prev.boss.tactics.find((x) => x.id === t.id);
      if (before && t.rallyable && !t.overridden && rarityRank(t.rarity) > rarityRank(before.rarity)) {
        toast({ kind: t.rarity, iconName: "swords", heading: `Tactic upgraded to ${RARITY[t.rarity].label}!`, title: `[${t.name}]`, life: 5000 });
      }
    }
  }
  const res = view.lastResult;
  if (view.resolved && res && (!prev.lastResult || prev.lastResult.dropId !== res.dropId)) {
    if (res.winnerId) {
      toast({ kind: res.rarity, iconName: "gem", heading: "You receive loot:", title: `[${res.itemName}]`,
        lines: [`<span class="rarity-label">${RARITY[res.rarity].label}</span> <span class="coins">${formatGold(RARITY[res.rarity].value)}</span>`, `Won by <b>${escapeHtml(res.winnerName)}</b>`],
        life: res.rarity === "legendary" ? 6500 : 5000 });
    } else {
      announce(`Everyone passed on ${res.itemName}.`);
    }
  }
  const boss = view.boss;
  const before = prev.boss;
  if (boss && boss.status === "active" && (!before || before.id !== boss.id)) {
    toast({ kind: boss.tier === "raid" ? "legendary" : boss.tier === "elite" ? "epic" : "common", iconName: "skull",
      heading: "A boss approaches:", title: `[${boss.name}]`,
      lines: [`<span class="rarity-label">${tierLabel(boss.tier)}</span> Prepare your tactics`] });
  }
  if (boss && before && before.id === boss.id && before.phase === "prep" && boss.phase === "fight" && boss.status === "active") {
    toast({ kind: boss.tier === "raid" ? "legendary" : boss.tier === "elite" ? "epic" : "common", iconName: "swords",
      heading: "Boss engaged!", title: `[${boss.name}]`, lines: [`${boss.hpMax} HP, built from ${plural(boss.tactics.length, "tactic", "tactics")}`] });
  }
  if (boss && before && before.id === boss.id && before.status === "active" && boss.status !== "active") {
    const looted = view.log.filter((t) => t.bossId === boss.id && !t.passedOver).length;
    if (boss.status === "slain") {
      toast({ kind: "legendary", iconName: "swords", heading: "Boss slain:", title: `[${boss.name}]`, lines: [`${plural(looted, "item", "items")} looted. Victory!`], life: 6500 });
    } else if (boss.status === "tactical") {
      // a soft win: blue and a banner, where a full kill is orange and swords
      toast({ kind: "rare", iconName: "flag", heading: "Tactical Victory!", title: `[${boss.name}]`,
        lines: [`The room agreed it's handled, with ${Math.ceil(boss.hp)} HP left. ${plural(looted, "action", "actions")} claimed.`], life: 6500 });
    } else if (boss.status === "abandoned") {
      toast({ kind: "neutral", iconName: "flag", heading: "Boss abandoned", title: `[${boss.name}]`, lines: ["The raid ended mid-fight."], life: 5000 });
    } else {
      toast({ kind: "neutral", iconName: "hourglass", heading: "The boss enrages", title: `[${boss.name}]`, lines: ["Time's up: the encounter wraps up here."], life: 6000 });
    }
  }
}

/* ---------------- Raid Summary ---------------- */
// Team totals only: no per-player counts, gold, rankings or "most" anything.
// Character sheets come from the engine sorted by real name.

const whoText = (p) => (p.realName ? `${escapeHtml(p.realName)} (${escapeHtml(p.name)})` : escapeHtml(p.name));
const names = (list) => list.map(whoText).join(", ");

function renderSummary() {
  const sum = view.summary;
  const host = isHost();
  $("#btn-reopen-raid").classList.toggle("hidden", !host);
  const note = $("#summary-unsaved");
  note.classList.toggle("hidden", !!view.persist);
  setText(note, LOCAL
    ? "This session isn't kept, so the Raid Summary disappears when this tab closes. Export the Loot Ledger to keep a copy, or tick Keep after the tab closes."
    : "This room isn't saved, so the Raid Summary disappears when the room closes. Export the Loot Ledger to keep a copy.");

  const t = sum.totals;
  const banner = `<section class="summary-section" aria-labelledby="sum-totals">
      <h3 id="sum-totals">Party totals</h3>
      <dl class="summary-totals">
        <div><dt>Bosses slain</dt><dd>${t.bossesSlain}</dd></div>
        <div><dt>Tactical victories</dt><dd>${t.tacticalVictories}</dd></div>
        <div><dt>Tactics owned</dt><dd>${t.tacticsOwned}</dd></div>
        <div><dt>Achievements earned</dt><dd>${t.achievements}</dd></div>
        <div><dt>Gold value of owned loot</dt><dd class="coins">${formatGold(t.gold)}</dd></div>
      </dl>
    </section>`;

  const tacticLine = (a) => {
    const state = a.owner ? `Owner: ${whoText(a.owner)}${a.done ? " &middot; done" : ""}`
      : a.state === "passed" ? "Passed over" : "Never dropped";
    return `<li class="summary-tactic"><span class="r-${a.rarity}">${escapeHtml(a.name)}</span> ${rarityTag(a)} <span class="muted">&mdash; ${state}</span></li>`;
  };
  const encounters = sum.encounters.map((e) => {
    const facts = e.pulled
      ? [e.tierLabel, e.hpMax == null ? "HP never set" : e.status === "slain" || e.status === "active" ? `${e.hpMax} HP` : `${e.hpLeft} of ${e.hpMax} HP left`,
         e.threat !== null ? plural(e.threat, "threat", "threat") : "",
         e.actionsTotal ? `${e.actionsOpen} of ${e.actionsTotal} actions open` : "no actions"]
      : [e.threat !== null ? plural(e.threat, "threat", "threat") : "", `raised by ${whoText(e.raisedBy)}`];
    const tactics = e.tactics.length
      ? `<ul class="summary-list">${e.tactics.map(tacticLine).join("")}</ul>`
      : e.pulled ? `<p class="muted">No tactics proposed.</p>` : "";
    return `<li class="summary-encounter status-${e.status}">
        <h4>${escapeHtml(e.name)}</h4>
        <p class="summary-status"><span class="status-tag">${e.statusLabel}</span> ${facts.filter(Boolean).join(" &middot; ")}</p>
        ${e.desc ? `<p class="summary-desc">${escapeHtml(e.desc)}</p>` : ""}
        ${e.note ? `<p class="summary-note"><b>Note:</b> ${escapeHtml(e.note)}</p>` : ""}
        ${e.status === "abandoned" ? `<p class="summary-note">The raid ended mid-fight.</p>` : ""}
        ${tactics}
      </li>`;
  }).join("");
  const other = sum.otherLoot.length
    ? `<h4>Other looted items</h4><ul class="summary-list">${sum.otherLoot.map((x) => tacticLine({ ...x, state: "owned" })).join("")}</ul>` : "";

  const achievements = sum.achievements.length ? `<ul class="summary-list summary-achievements">${sum.achievements.map((a) => `<li>
        <span class="summary-ach-title r-${a.rarity}">${escapeHtml(a.title)}</span> ${rarityTag(a)}
        ${a.detail ? `<p class="summary-desc">${escapeHtml(a.detail)}</p>` : ""}
        <p class="muted">Posted by ${names(a.posters)}${a.rallies.length ? `. Rallied by ${names(a.rallies)}` : ""}.</p>
      </li>`).join("")}</ul>` : `<p class="muted">No achievements were posted.</p>`;

  const itemList = (items, label, empty) => `<h5>${label}</h5>${items.length
    ? `<ul class="summary-list">${items.map((x) => `<li><span class="r-${x.rarity}">${escapeHtml(x.name || x.title)}</span> ${rarityTag(x)}${x.done ? ` <span class="muted">&middot; done</span>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted">${empty}</p>`}`;
  const characters = sum.characters.length ? sum.characters.map((c) => `<li class="summary-character">
      <h4>${escapeHtml(c.realName || c.name)}${c.realName ? ` <span class="muted">as ${escapeHtml(c.name)}</span>` : ""}</h4>
      <p class="member-class">${c.faction ? `${c.faction} &middot; ` : ""}${escapeHtml(`${c.race} ${c.cls}`)}</p>
      ${itemList(c.owned, "Tactics owned", "None")}
      ${itemList(c.posted, "Achievements posted", "None")}
      ${itemList(c.rallied, "Rallied behind", "None")}
    </li>`).join("") : `<li class="empty-row muted">No party members.</li>`;

  setHtml($("#summary-body"), `${banner}
    <section class="summary-section" aria-labelledby="sum-encounters">
      <h3 id="sum-encounters">Encounters</h3>
      ${sum.encounters.length ? `<ul class="summary-encounters">${encounters}</ul>` : `<p class="muted">No topics were scouted.</p>`}
      ${other}
    </section>
    <section class="summary-section" aria-labelledby="sum-achievements">
      <h3 id="sum-achievements">Achievements</h3>
      ${achievements}
    </section>
    <section class="summary-section" aria-labelledby="sum-characters">
      <h3 id="sum-characters">Character sheets</h3>
      <ul class="summary-characters">${characters}</ul>
    </section>`);
}

/* ---------------- Dialogs ---------------- */
// Focus moves into a dialog, Tab cycles inside it, Escape closes it, and
// focus returns to whatever opened it.

let dialogReturn = null;

function openModal(sel) {
  if (sel === "#modal-config") renderLootTableModal();
  if (sel === "#modal-roster") renderRosterModal();
  if (sel === "#modal-manual") renderManualDropModal();
  if (sel === "#modal-mobs") renderMobList("#modal-mob-list", true);
  closeModals(false);
  dialogReturn = document.activeElement;
  $(sel).classList.remove("hidden");
  const first = focusables($(sel))[0];
  if (first) first.focus();
}

function closeModals(restore = true) {
  const wasOpen = $$(".modal").some((m) => !m.classList.contains("hidden"));
  $$(".modal").forEach((m) => m.classList.toggle("hidden", true));
  if (wasOpen && restore && dialogReturn && document.contains(dialogReturn)) dialogReturn.focus();
  if (restore) confirmResolve(false);
}

function focusables(root) {
  return [...root.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

document.addEventListener("keydown", (e) => {
  const modal = $$(".modal").find((m) => !m.classList.contains("hidden"));
  if (!modal) return;
  if (e.key === "Escape") { e.preventDefault(); closeModals(); return; }
  if (e.key !== "Tab") return;
  const items = focusables(modal);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

let confirmResolver = null;
function confirmResolve(answer) {
  if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(answer); }
}
// withNote shows an optional note field; read it from #confirm-note.
function confirmDialog(text, yesLabel = "Confirm", { withNote = false } = {}) {
  $("#confirm-note-wrap").classList.toggle("hidden", !withNote);
  $("#confirm-note").value = "";
  $("#confirm-text").textContent = text;
  $("#btn-confirm-yes").textContent = yesLabel;
  openModal("#modal-confirm");
  $("#btn-confirm-no").focus(); // start on the safe choice
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function refreshOpenModals() {
  if (!$("#modal-config").classList.contains("hidden")) renderLootTableModal();
  if (!$("#modal-roster").classList.contains("hidden")) renderRosterModal();
  if (!$("#modal-manual").classList.contains("hidden")) renderManualDropModal();
  if (!$("#modal-mobs").classList.contains("hidden")) renderMobList("#modal-mob-list", true);
}

function renderLootTableModal() {
  if (!$("#loot-rarity").options.length) $("#loot-rarity").innerHTML = rarityOptions("uncommon", false);
  setHtml($("#loot-table-list"), view.lootTable.length ? view.lootTable.map((l) => `<li>
      <span class="li-name r-${l.rarity}">${escapeHtml(l.name)}</span>
      <span class="li-sub">${rarityTag(l)}${l.desc ? ` &middot; ${escapeHtml(l.desc)}` : ""}</span>
      <button class="li-remove" data-remove-loot="${l.id}" aria-label="Remove ${escapeHtml(l.name)}">&times;</button>
    </li>`).join("") : `<li class="empty-row muted">No loot defined yet.</li>`);
}

function renderRosterModal() {
  setText($("#roster-intro"), LOCAL
    ? "Everyone at the table. Add people with the Acting as menu, or a quick slot here."
    : "Players create their own characters when they join. Use this only to add a proxy slot for someone who isn't online, or to kick / reassign.");
  setHtml($("#roster-list"), view.members.length ? view.members.map((m) => {
    const isMe = m.id === view.you.memberId;
    const word = isMe ? "you" : m.claimed ? "claimed" : m.held ? "away" : m.proxy ? "proxy" : "open";
    // An away player still counts towards bag size; Kick releases their slot.
    const kick = !LOCAL && (m.claimed || m.held) && !isMe
      ? `<button class="btn btn-ghost btn-small" data-kick="${m.id}">Kick<span class="sr-only"> ${escapeHtml(m.name)}</span></button>` : "";
    const reassign = !LOCAL && m.claimed && !isMe
      ? `<button class="btn btn-ghost btn-small" data-reassign="${m.id}">Make host<span class="sr-only">: ${escapeHtml(m.name)}</span></button>` : "";
    const mgmt = kick + reassign;
    return `<li>
        <span class="li-name">${escapeHtml(m.name)}${m.isHost ? hostCrown() : ""}</span>
        <span class="li-sub">${escapeHtml(m.cls)}${LOCAL ? "" : ` &middot; ${word}`}</span>
        ${mgmt}
        ${isMe && !LOCAL ? "" : `<button class="li-remove" data-remove-member="${m.id}" aria-label="Remove ${escapeHtml(m.name)} from the party">&times;</button>`}
      </li>`;
  }).join("") : `<li class="empty-row muted">No party members yet.</li>`);
  const sel = $("#member-class");
  if (!sel.options.length) sel.innerHTML = CLASS_NAMES.map((c) => `<option>${c}</option>`).join("");
}

function renderManualDropModal() {
  const claimed = new Set(view.log.filter((t) => !t.passedOver).map((t) => t.tacticId));
  const pool = view.lootTable.filter((l) => !claimed.has(l.id));
  setHtml($("#manual-drop-list"), pool.length ? pool.map((l) => `<li>
      <span class="li-name r-${l.rarity}">${escapeHtml(l.name)}</span>
      <span class="li-sub">${rarityTag(l)}</span>
      <button class="btn btn-primary btn-small" data-drop-loot="${l.id}">Drop<span class="sr-only"> ${escapeHtml(l.name)}</span></button>
    </li>`).join("")
    : `<li class="empty-row muted">${view.lootTable.length ? "Every backlog item has already been claimed." : "Add items to the loot table first."}</li>`);
}

/* ---------------- Loot Ledger ---------------- */

function showLedger(text) {
  $("#ledger-text").value = text;
  $("#ledger-status").textContent = "";
  openModal("#modal-ledger");
}

/* ---------------- Helpers ---------------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function stripTags(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
function formatGold(copper) {
  const g = Math.floor(copper / 10000), s = Math.floor((copper % 10000) / 100), c = copper % 100;
  const parts = [];
  if (g) parts.push(`<span class="coin gold">${g}g</span>`);
  if (s || g) parts.push(`<span class="coin silver">${s}s</span>`);
  parts.push(`<span class="coin copper">${c}c</span>`);
  return parts.join(" ");
}
// Gold crown marking the host; star marking your own character. Both carry
// their meaning as text for screen readers, and the party header has a key.
function hostCrown() {
  return `<span class="host-crown" title="Host: runs the session">${icon("crown")}<span class="sr-only"> (host)</span></span>`;
}
function youStar() {
  return `<span class="you-star" title="This is you" aria-hidden="true">&#9733;</span><span class="sr-only"> (you)</span>`;
}
function damageLine(res) {
  if (res.damage == null) return "";
  if (!res.damage) return `<div class="damage-line muted">No damage. Nobody took ownership of it.</div>`;
  return `<div class="damage-line">${icon("swords")} Dealt <b>${res.damage}</b> damage</div>`;
}
function slainLine(bossName, looted) {
  const name = escapeHtml(bossName);
  return looted
    ? `&#9733; ${name} has been slain! The party claimed ${plural(looted, "piece", "pieces")} of loot.`
    : `&#9733; ${name} has been slain, but the party left empty-handed.`;
}

/* ---------------- Event wiring ---------------- */

const persistHint = () => {
  $("#create-persist-hint").textContent = $("#create-persist").checked
    ? "Saved: the room is written to the server's disk and comes back after a restart."
    : "Not saved (default): the room lives in memory only. Nothing is written to disk, and it's gone if the server restarts.";
};
$("#create-persist").addEventListener("change", persistHint);
persistHint();

$("#btn-create").addEventListener("click", () => {
  $("#lobby-error").textContent = "";
  send({ type: "create", persist: $("#create-persist").checked });
});

// Room code: uppercase A–Z / 0–9 only, four characters, whatever was typed or pasted.
function syncJoinCode() {
  const input = $("#join-code");
  const link = input.value.match(/[?&]room=([a-z0-9]{4})/i); // a pasted invite link
  const clean = cleanCode(link ? link[1] : input.value);
  if (input.value !== clean) input.value = clean;
  $("#btn-join").disabled = clean.length !== 4;
}
$("#join-code").addEventListener("input", syncJoinCode);
$("#join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-join").click(); });
$("#btn-join").addEventListener("click", () => {
  const code = cleanCode($("#join-code").value);
  if (code.length !== 4) return;
  $("#lobby-error").textContent = "";
  send({ type: "join", room: code });
});

$("#lobby-toggle").addEventListener("click", () => {
  const open = $("#lobby-toggle").getAttribute("aria-expanded") !== "true";
  $("#lobby-toggle").setAttribute("aria-expanded", String(open));
  $("#lobby-lead").classList.toggle("hidden", !open);
});
$("#btn-how-to-play").addEventListener("click", () => openModal("#modal-howto"));

// Copy text to the clipboard. The async clipboard API only exists on secure
// origins (HTTPS or localhost), so plain-HTTP LAN addresses fall back to the
// older copy command. Returns false if neither worked.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
  const back = document.activeElement;
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  back?.focus();
  return ok;
}

$("#btn-copy-invite").addEventListener("click", async () => {
  const label = $("#btn-copy-invite .room-copy-label");
  const tail = $("#btn-copy-invite .room-copy-tail");
  const link = inviteLink(view.room);
  if (await copyText(link)) {
    label.textContent = "Link copied"; tail.textContent = "";
    announce("Invite link copied");
    clearTimeout(label._reset);
    label._reset = setTimeout(() => { label.textContent = "Copy invite"; tail.textContent = " link"; }, 2000);
  } else {
    // last resort: show the link, selected, for copying by hand
    $("#invite-link").value = link;
    openModal("#modal-invite");
    $("#invite-link").select();
  }
});

async function leaveGroup() {
  if (LOCAL) {
    if (await confirmDialog("Disband the group? This wipes the whole session: party, achievements, Mob List, bosses and loot.", "Disband")) {
      transport.disband();
    }
    return;
  }
  // Tell the server we're giving up our slot (so it stops counting towards
  // bag size), then go once it confirms, or after a moment regardless.
  send({ type: "leave" });
  setTimeout(leaveRoom, 800);
}

function leaveRoom() {
  const url = new URL(location.href); url.searchParams.delete("room");
  location.href = url.toString();
}

// the character menu and the save-status tip
for (const id of ["#btn-char", "#btn-menu"]) {
  $(id).addEventListener("click", () => setYouPanel($("#you-panel").classList.contains("hidden")));
}
$("#btn-save-info").addEventListener("click", () => setSaveTip($("#save-tip").classList.contains("hidden")));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#you-panel").classList.contains("hidden")) { setYouPanel(false, { returnFocus: true }); e.stopPropagation(); }
  if (!$("#save-tip").classList.contains("hidden")) { setSaveTip(false); $("#btn-save-info").focus(); }
}, true);
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#you-wrap")) setYouPanel(false);
  if (!e.target.closest("#save-status")) setSaveTip(false);
});
// Tabbing out closes them too, so focus never lands on page content hidden
// under an open panel (WCAG 2.4.11).
$("#you-wrap").addEventListener("focusout", (e) => {
  if (e.relatedTarget && !e.relatedTarget.closest("#you-wrap")) setYouPanel(false);
});
$("#save-status").addEventListener("focusout", (e) => {
  if (e.relatedTarget && !e.relatedTarget.closest("#save-status")) setSaveTip(false);
});
// panel items act, then the panel closes (dialogs return focus to the trigger)
$("#you-panel").addEventListener("click", (e) => {
  const item = e.target.closest("button.you-item");
  if (!item) return;
  if (item.dataset.actAs) {
    if (item.dataset.actAs === "__add") { setYouPanel(false); addingMember = true; onState(view); $("#char-name").focus(); return; }
    ballotOpenFor = null;
    transport.setActingAs(item.dataset.actAs);
    return; // stays open so you can see who's selected
  }
  const tool = item.dataset.tool;
  if (!tool) return;
  // focus the trigger first, so the dialog hands focus back to it on close
  setYouPanel(false);
  visibleTrigger().focus();
  if (tool === "leave") leaveGroup();
  else if (tool === "edit") startEditCharacter();
  else if (tool === "export") send({ type: "ledger" });
  else openModal({ mobs: "#modal-mobs", roster: "#modal-roster", config: "#modal-config", howto: "#modal-howto" }[tool]);
});
function startEditCharacter() {
  const m = me();
  if (!m) return;
  editingChar = true;
  $("#char-name").value = m.name;
  $("#char-realname").value = m.realName;
  chosenRace = m.race; chosenClass = m.cls;
  onState(view);
  $("#char-name").focus();
}
$("#keep-session").addEventListener("change", (e) => transport.setKeep(e.target.checked));

$("#btn-create-char").addEventListener("click", submitCharacter);
$("#btn-cancel-char").addEventListener("click", () => {
  const wasEditing = editingChar;
  addingMember = editingChar = false;
  $("#char-name").value = ""; $("#char-realname").value = "";
  onState(view);
  if (wasEditing) visibleTrigger().focus();
});
for (const id of ["#char-name", "#char-realname"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") submitCharacter(); });

$("#btn-phase-next").addEventListener("click", () => send({ type: "setPhase", phase: PHASES[PHASES.indexOf(view.phase) + 1] }));
$("#btn-end-raid").addEventListener("click", async () => {
  if (await confirmDialog("End the raid? Everyone moves to the Raid Summary and the room becomes read-only. A boss still being fought is abandoned.", "End Raid")) {
    send({ type: "endRaid" });
  }
});
$("#btn-reopen-raid").addEventListener("click", async () => {
  if (await confirmDialog("Reopen the raid? Everyone goes back to the session and can make changes again.", "Reopen Raid")) {
    send({ type: "reopenRaid" });
  }
});
$("#btn-summary-export").addEventListener("click", () => send({ type: "ledger" }));
$("#btn-phase-back").addEventListener("click", () => send({ type: "setPhase", phase: PHASES[PHASES.indexOf(view.phase) - 1] }));

$("#btn-post-ach").addEventListener("click", () => {
  const title = $("#ach-title-input");
  if (!title.value.trim()) { title.focus(); return; }
  send({ type: "postAchievement", title: title.value, detail: $("#ach-detail-input").value });
  title.value = ""; $("#ach-detail-input").value = "";
  title.focus();
});
$("#ach-title-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-post-ach").click(); });
$("#btn-merge").addEventListener("click", async () => {
  const sourceId = $("#merge-source").value, targetId = $("#merge-target").value;
  const title = (id) => (view.achievements.find((a) => a.id === id) || {}).title;
  if (sourceId === targetId) { onError("Pick two different achievements to merge."); return; }
  if (await confirmDialog(`Merge "${title(sourceId)}" into "${title(targetId)}"? Their posters and ralliers combine.`, "Merge")) {
    send({ type: "mergeAchievements", sourceId, targetId });
  }
});

$("#btn-reveal").addEventListener("click", () => send({ type: "revealThreat" }));
$("#btn-reopen").addEventListener("click", () => send({ type: "reopenVoting" }));
$("#btn-hide-ballot").addEventListener("click", () => { ballotOpenFor = null; render(); $("[data-open-ballot]")?.focus(); });

$("#btn-pull-boss").addEventListener("click", () => send({ type: "pullBoss" }));
$("#btn-mobs").addEventListener("click", () => openModal("#modal-mobs"));
$("#btn-tactical").addEventListener("click", async () => {
  if (await confirmDialog("Declare a Tactical Victory? The room agrees this problem is handled, even though the boss isn't fully beaten. Owned actions stay on the plan.", "Tactical Victory", { withNote: true })) {
    send({ type: "tacticalVictory", note: $("#confirm-note").value });
  }
});
$("#btn-clear-stage").addEventListener("click", () => send({ type: "clearStage" }));
$("#btn-engage").addEventListener("click", () => send({ type: "engageBoss" }));
$("#btn-drop-random").addEventListener("click", () => send({ type: "drop" }));
$("#btn-drop-manual").addEventListener("click", () => openModal("#modal-manual"));
// Online, every tactic starts at Common and rallies raise it. Local mode has
// no separate players to rally, so the proposer picks a rarity instead.
$("#tc-rarity").innerHTML = rarityOptions("common", true);
for (const el of $$("[data-local-only]")) el.classList.toggle("hidden", !LOCAL);
$("#tc-hint").textContent = LOCAL
  ? "Adds it to this boss's tactics. The facilitator can still change its rarity, then drops it onto the table for Need / Greed / Pass."
  : `Adds it to this boss's tactics at Common. The rest of the party can rally behind it to raise its rarity: Uncommon at ${Math.round(TACTIC_RALLY_UNCOMMON * 100)}% of them, up to Legendary at ${Math.round(TACTIC_RALLY_LEGENDARY * 100)}%. The facilitator checks its rarity, then drops it onto the table for Need / Greed / Pass.`;
$("#btn-propose-tactic").addEventListener("click", () => {
  const name = $("#tc-name");
  if (!name.value.trim()) { name.focus(); return; }
  send({ type: "proposeTactic", name: name.value, desc: $("#tc-desc").value, ...(LOCAL ? { rarity: $("#tc-rarity").value } : {}) });
  name.value = ""; $("#tc-desc").value = "";
});
for (const id of ["#tc-name", "#tc-desc"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-propose-tactic").click(); });
$("#btn-resolve").addEventListener("click", () => send({ type: "resolve" }));
$("#btn-roster").addEventListener("click", () => openModal("#modal-roster"));
$("#btn-export").addEventListener("click", () => send({ type: "ledger" }));

$("#btn-copy-ledger").addEventListener("click", async () => {
  if (await copyText($("#ledger-text").value)) {
    $("#ledger-status").textContent = "Copied to the clipboard.";
  } else {
    $("#ledger-text").select();
    $("#ledger-status").textContent = "Couldn't copy automatically. The text is selected: press Ctrl+C or Cmd+C.";
  }
});
$("#btn-download-ledger").addEventListener("click", () => {
  const blob = new Blob([$("#ledger-text").value], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "loot-ledger.md"; a.click();
  URL.revokeObjectURL(a.href);
  $("#ledger-status").textContent = "Downloaded loot-ledger.md.";
});

$("#btn-add-loot").addEventListener("click", () => {
  send({ type: "addLoot", name: $("#loot-name").value, rarity: $("#loot-rarity").value, desc: $("#loot-desc").value });
  $("#loot-name").value = ""; $("#loot-desc").value = "";
});
$("#btn-add-member").addEventListener("click", () => {
  send({ type: "addMember", name: $("#member-name").value, cls: $("#member-class").value });
  $("#member-name").value = "";
});
$("#btn-confirm-yes").addEventListener("click", () => { const r = confirmResolver; confirmResolver = null; closeModals(); if (r) r(true); });

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, .modal");
  if (!t) return;
  if (t.matches("[data-close]") || (t.classList.contains("modal") && e.target === t)) { closeModals(); return; }
  if (t.disabled) return;
  const d = t.dataset;
  if (d.reclaim) return send({ type: "claimMember", memberId: d.reclaim });
  if (d.faction) return selectFaction(d.faction);
  if (d.race) return selectRace(d.race);
  if (d.cls) { chosenClass = d.cls; return withFocusKept(renderClassPicker); }
  if (d.mychoice) return send({ type: "setChoice", choice: d.mychoice });
  if (d.choice) return send({ type: "setChoice", choice: d.choice, asMember: d.member });
  if (d.claim) return send({ type: "claimMember", memberId: d.claim });
  if (d.rally) return send({ type: "rally", achievementId: d.rally });
  if (d.rallyTactic) return send({ type: "rally", tacticId: d.rallyTactic });
  if (d.removeAch) {
    const a = view.achievements.find((x) => x.id === d.removeAch);
    if (a && await confirmDialog(`Remove "${a.title}" from the board?`, "Remove")) send({ type: "removeAchievement", achievementId: a.id });
    return;
  }
  if (d.openBallot) { ballotOpenFor = d.openBallot; render(); $(".btn-step:not([disabled])")?.focus(); return; }
  if (d.threat) return changeThreat(d.threat, Number(d.delta));
  if (d.timer) {
    const minutes = d.timerAction === "set" ? Number($(`#timer-min-${d.timer}`).value) : Number(d.minutes) || undefined;
    return send({ type: "timer", target: d.timer, action: d.timerAction, minutes });
  }
  if (d.addMob !== undefined) return addMobFrom(t.closest("[data-mob-form]"));
  if (d.removeMob) return send({ type: "removeMob", mobId: d.removeMob });
  if (d.pullMob) { send({ type: "pullBoss", mobId: d.pullMob }); return closeModals(); }
  if (d.dropTactic) return send({ type: "dropTactic", tacticId: d.dropTactic });
  if (d.dropLoot) { send({ type: "drop", lootId: d.dropLoot }); return closeModals(); }
  if (d.removeLoot) return send({ type: "removeLoot", lootId: d.removeLoot });
  if (d.removeMember) {
    const m = view.members.find((x) => x.id === d.removeMember);
    if (m && await confirmDialog(`Remove ${m.name} from the party?`, "Remove")) send({ type: "removeMember", memberId: m.id });
    return;
  }
  if (d.kick) {
    const m = view.members.find((x) => x.id === d.kick);
    if (m && await confirmDialog(`Kick the player holding "${m.name}"? The slot stays open for someone to reclaim and stops counting towards bag size.`, "Kick")) send({ type: "kickMember", memberId: m.id });
    return;
  }
  if (d.reassign) {
    const m = view.members.find((x) => x.id === d.reassign);
    if (m && await confirmDialog(`Hand host control to the player in "${m.name}"? You'll become a regular player.`, "Make host")) send({ type: "reassignFacilitator", memberId: m.id });
  }
});

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-task]")) send({ type: "toggleTask", taskId: e.target.dataset.task });
  if (e.target.matches("[data-tactic-rarity]")) send({ type: "setTacticRarity", tacticId: e.target.dataset.tacticRarity, rarity: e.target.value });
});
for (const input of $$("[data-mob-form] [name=mob-name]")) {
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") addMobFrom(input.closest("[data-mob-form]")); });
}

// The tactic composer can be collapsed to a slim bar during a fight; each
// viewer's choice is remembered in this browser.
const TC_COLLAPSED_KEY = "wow-retro-composer-collapsed";
function setComposerCollapsed(collapsed) {
  $("#tactic-composer").classList.toggle("collapsed", collapsed);
  $("[data-tc-toggle]").setAttribute("aria-expanded", String(!collapsed));
  try { localStorage.setItem(TC_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* not remembered */ }
}
$("[data-tc-toggle]").addEventListener("click", () => {
  const collapsed = !$("#tactic-composer").classList.contains("collapsed");
  setComposerCollapsed(collapsed);
  if (!collapsed) $("#tc-name").focus();
});
try { setComposerCollapsed(localStorage.getItem(TC_COLLAPSED_KEY) === "1"); } catch { /* start open */ }

// --header-h is the sticky header's height (0 when it scrolls away, as on
// phones), so toasts sit below it and focused elements aren't hidden under it.
function trackHeaderHeight() {
  const bar = $("#topbar");
  const sticky = getComputedStyle(bar).position === "sticky";
  document.documentElement.style.setProperty("--header-h", `${sticky ? bar.offsetHeight : 0}px`);
}
new ResizeObserver(trackHeaderHeight).observe($("#topbar"));
addEventListener("resize", trackHeaderHeight); // stickiness changes at the breakpoints

/* ---------------- Boot ---------------- */

if (LOCAL) {
  $("#conn-status").classList.toggle("hidden", true);
  const { createLocalTransport } = await import("./local-mode.js");
  transport = createLocalTransport({ onState, onError, onLedger: showLedger });
} else {
  transport = createWsTransport();
  // An invite link joins straight away; show which room meanwhile, with the
  // code filled in so a dead link can be corrected and retried.
  const room = roomFromUrl();
  if (room) {
    $("#join-code").value = room;
    syncJoinCode();
    $("#lobby-joining").textContent = `Joining room ${room}…`;
    $("#lobby-joining").classList.remove("hidden");
    showScreen("lobby");
  }
}
transport.start();
