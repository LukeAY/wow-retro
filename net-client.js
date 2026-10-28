/* =========================================================================
 * Loot Council — networked client
 * Talks to server/server.js over WebSocket. The server is authoritative:
 * this client only renders the view it's given and sends intents.
 * ========================================================================= */

// Each rarity carries a WoW-style vendor value (in copper) that scales with
// its "worth" / priority — used to show how valuable a looted task is.
const RARITY = {
  poor:      { label: "Poor",      cls: "poor",      value: 150 },       // 1s 50c
  common:    { label: "Common",    cls: "common",    value: 2500 },      // 25s
  uncommon:  { label: "Uncommon",  cls: "uncommon",  value: 42000 },     // 4g 20s
  rare:      { label: "Rare",      cls: "rare",      value: 185000 },    // 18g 50s
  epic:      { label: "Epic",      cls: "epic",      value: 1250000 },   // 125g
  legendary: { label: "Legendary", cls: "legendary", value: 10000000 }, // 1000g
};

// Boss tiers — labels/colors for rendering. The server owns the HP math and
// the slain flag; the client only displays what it's told.
const BOSS_TIERS = {
  trash: { label: "Trash mob", color: "#9aa4b2" },
  elite: { label: "Elite",     color: "#a335ee" },
  raid:  { label: "Raid boss", color: "#ff8000" },
};

// Format a copper amount as WoW gold/silver/copper markup.
function formatGold(copper) {
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  const parts = [];
  if (g) parts.push(`<span class="coin gold">${g}g</span>`);
  if (s || g) parts.push(`<span class="coin silver">${s}s</span>`);
  parts.push(`<span class="coin copper">${c}c</span>`);
  return parts.join(" ");
}

const CLASSES = {
  "Death Knight": "#c41e3a", "Demon Hunter": "#a330c9", "Druid": "#ff7c0a",
  "Evoker": "#33937f", "Hunter": "#aad372", "Mage": "#3fc7eb", "Monk": "#00ff98",
  "Paladin": "#f48cba", "Priest": "#ffffff", "Rogue": "#fff468", "Shaman": "#0070dd",
  "Warlock": "#8788ee", "Warrior": "#c69b6d",
};

// Faction crests (icons come from icons.js).
const FACTION_CREST = { Alliance: icon("shield"), Horde: icon("swords") };

// Race/class matrix + faction map — populated from the server's `meta` message
// so the client never diverges from the authoritative WoW: Forever rules.
let RACE_CLASSES = {};
let FACTION = {};

const $ = (s) => document.querySelector(s);

/* ---------------- Connection ---------------- */
let ws = null;
let view = null;            // last state from server
let lastShownResultId = null; // so we only toast a given resolve once
let lastSlainBossId = null;   // so we only toast a given boss defeat once
let lastPulledBossId = null;  // so we only toast a given boss pull once

// Rooms this tab has finished scouting, so a refresh doesn't re-show the screen.
const SCOUTED_KEY = "wow-retro-scouted-rooms";
const scoutedThisTab = new Set();
function hasScouted(room) {
  try { return JSON.parse(sessionStorage.getItem(SCOUTED_KEY) || "[]").includes(room); }
  catch { return false; }
}
function markScouted(room) {
  try {
    const rooms = JSON.parse(sessionStorage.getItem(SCOUTED_KEY) || "[]");
    if (!rooms.includes(room)) sessionStorage.setItem(SCOUTED_KEY, JSON.stringify([...rooms, room]));
  } catch { /* storage unavailable: the screen just shows again next time */ }
  scoutedThisTab.add(room);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener("open", () => {
    setStatus("connected", true);
    // auto-rejoin if a room code is in the URL
    const params = new URLSearchParams(location.search);
    const room = params.get("room");
    if (room) send({ type: "join", room });
  });

  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "meta") { RACE_CLASSES = msg.raceClasses || {}; FACTION = msg.faction || {}; }
    else if (msg.type === "state") onState(msg);
    else if (msg.type === "error") { showLobbyError(msg.message); $("#scout-error").textContent = msg.message; flashError(msg.message); }
    else if (msg.type === "kicked") {
      alert(`You were removed from the "${msg.memberName}" slot by the facilitator. You can claim an open slot again.`);
    }
  });

  ws.addEventListener("close", () => {
    setStatus("disconnected — retrying…", false);
    setTimeout(connect, 1500);
  });
  ws.addEventListener("error", () => ws.close());
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setStatus(text, ok) {
  const el = $("#conn-status");
  el.textContent = text;
  el.style.color = ok ? "var(--uncommon)" : "var(--need)";
}

function showLobbyError(msg) {
  const el = $("#lobby-error");
  if (el) el.textContent = msg || "";
}

/* ---------------- State handling ---------------- */

function onState(msg) {
  const firstRoom = !view || view.room !== msg.room;
  view = msg;

  $("#lobby").classList.add("hidden");
  $("#room-badge").textContent = `Room ${msg.room}`;
  $("#btn-leave").classList.remove("hidden");

  // put room in URL for easy refresh/reconnect + sharing
  if (firstRoom) {
    lastPulledBossId = msg.boss ? msg.boss.id : null; // don't toast a boss already up when we join
    const url = new URL(location.href);
    url.searchParams.set("room", msg.room);
    history.replaceState({}, "", url);
  }

  const hasCharacter = !!msg.you.memberId;

  // Before the game: character creation, then scouting topics for the mob list.
  const scouting = hasCharacter && !scoutedThisTab.has(msg.room) && !hasScouted(msg.room);
  if (!hasCharacter || scouting) {
    $("#create-char").classList.toggle("hidden", hasCharacter);
    $("#scout").classList.toggle("hidden", !scouting);
    $("#game").classList.add("hidden");
    ["#btn-mobs", "#btn-config", "#btn-roster", "#btn-export"].forEach((b) => $(b).classList.add("hidden"));
    if (scouting) renderMobLists();
    else { ensureValidClass(); renderRacePicker(); renderClassPicker(); }
    return;
  }

  // Has a character and has scouted -> enter the game.
  $("#create-char").classList.add("hidden");
  $("#scout").classList.add("hidden");
  $("#game").classList.remove("hidden");
  $("#btn-export").classList.remove("hidden");
  $("#btn-mobs").classList.remove("hidden");

  const isFacilitator = msg.you.role === "facilitator";
  $("#btn-config").classList.toggle("hidden", !isFacilitator);
  $("#btn-roster").classList.toggle("hidden", !isFacilitator);
  $("#facilitator-controls").classList.toggle("hidden", !isFacilitator);
  $("#btn-resolve").classList.toggle("hidden", !isFacilitator);

  render();
}

/* ---------------- Character creation ---------------- */
let chosenRace = "Human";
let chosenClass = "Warrior";

const FACTION_COLOR = { Alliance: "#3a7bd5", Horde: "#c8102e" };

// Build the race picker as buttons, grouped by faction, from the server matrix.
function renderRacePicker() {
  const picker = $("#race-picker");
  if (!picker) return;
  const byFaction = { Alliance: [], Horde: [] };
  Object.keys(RACE_CLASSES).forEach((race) => {
    (byFaction[FACTION[race]] || (byFaction[FACTION[race]] = [])).push(race);
  });

  picker.innerHTML = "";
  ["Alliance", "Horde"].forEach((faction) => {
    const races = byFaction[faction];
    if (!races || !races.length) return;
    const color = FACTION_COLOR[faction] || "var(--gold)";

    const group = document.createElement("div");
    group.className = "race-group";
    group.innerHTML = `<div class="race-group-label" style="--faction-color:${color}">${FACTION_CREST[faction] || ""} ${faction}</div>`;

    const row = document.createElement("div");
    row.className = "race-options";
    races.forEach((race) => {
      const btn = document.createElement("button");
      btn.className = "race-option" + (race === chosenRace ? " active" : "");
      btn.dataset.race = race;
      btn.style.setProperty("--faction-color", color);
      btn.innerHTML = `${raceIcon(race) || `<span class="dot"></span>`}<span>${race}</span>`;
      row.appendChild(btn);
    });
    group.appendChild(row);
    picker.appendChild(group);
  });
}

function selectRace(race) {
  if (!RACE_CLASSES[race]) return;
  chosenRace = race;
  ensureValidClass();
  renderRacePicker();
  renderClassPicker();
}

// If the current class isn't legal for the chosen race, pick the first legal one.
function ensureValidClass() {
  const legal = RACE_CLASSES[chosenRace] || [];
  if (!legal.includes(chosenClass)) chosenClass = legal[0] || "Warrior";
}

// Class picker shows ONLY the classes valid for the chosen race.
function renderClassPicker() {
  const picker = $("#class-picker");
  picker.innerHTML = "";
  const legal = RACE_CLASSES[chosenRace] || [];
  legal.forEach((name) => {
    const color = CLASSES[name] || "#c8aa6e";
    const btn = document.createElement("button");
    btn.className = "class-option" + (name === chosenClass ? " active" : "");
    btn.dataset.cls = name;
    btn.style.setProperty("--class-color", color);
    btn.innerHTML = `<span class="dot"></span><span>${name}</span>`;
    picker.appendChild(btn);
  });
  // show which faction this race belongs to
  const hint = $("#faction-hint");
  if (hint) {
    const f = FACTION[chosenRace];
    hint.innerHTML = f ? `${FACTION_CREST[f]} ${f}` : "";
  }
}

function submitCharacter() {
  const name = $("#char-name").value.trim();
  if (!name) { $("#char-error").textContent = "Enter a character name."; return; }
  const realName = $("#char-realname").value.trim();
  if (!realName) { $("#char-error").textContent = "Enter your real name (for accountability)."; return; }
  ensureValidClass();
  if (!RACE_CLASSES[chosenRace] || !RACE_CLASSES[chosenRace].includes(chosenClass)) {
    $("#char-error").textContent = "Pick a valid race and class.";
    return;
  }
  $("#char-error").textContent = "";
  send({ type: "createCharacter", name, realName, cls: chosenClass, race: chosenRace });
}

function render() {
  renderMobLists();
  renderBoss();
  renderStageControls();
  renderActiveDrop();
  renderMyVote();
  renderTally();
  renderResult();
  renderParty();
  renderLog();
  renderAccountability();
  maybeToast();
  refreshOpenModals();
}

// Who owns how many open vs. done tasks (keyed by real name for accountability).
function renderAccountability() {
  const section = $("#accountability");
  const list = $("#accountability-list");
  if (!section || !list) return;

  // tally per owner: key on real name when present, else character name
  const byOwner = new Map();
  view.log.forEach((t) => {
    if (t.passedOver) return; // passed-over items have no owner and aren't tasks
    const key = (t.ownerReal && t.ownerReal.trim()) ? t.ownerReal : t.ownerName;
    if (!byOwner.has(key)) byOwner.set(key, { key, character: t.ownerName, open: 0, done: 0 });
    const entry = byOwner.get(key);
    if (t.done) entry.done++; else entry.open++;
  });

  if (byOwner.size === 0) { // nothing owned yet (empty, or only passed-over)
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  const rows = [...byOwner.values()].sort((a, b) => (b.open - a.open) || (b.open + b.done - a.open - a.done));
  const totalOpen = rows.reduce((n, r) => n + r.open, 0);
  $("#accountability-sub").textContent =
    `${totalOpen} open across ${rows.length} ${rows.length === 1 ? "person" : "people"}`;

  list.innerHTML = "";
  rows.forEach((r) => {
    const total = r.open + r.done;
    const li = document.createElement("li");
    li.className = "accountability-row" + (r.open === 0 ? " all-clear" : "");
    // character hint only when the owner key is a real name distinct from character
    const charHint = (r.key !== r.character) ? ` <span class="acc-char">as ${escapeHtml(r.character)}</span>` : "";
    li.innerHTML = `
      <span class="acc-name">${icon("person")} ${escapeHtml(r.key)}${charHint}</span>
      <span class="acc-counts">
        <span class="acc-open" title="Open tasks">${r.open} open</span>
        <span class="acc-done" title="Completed tasks">${r.done} done</span>
        <span class="acc-bar" aria-hidden="true">${
          total ? `<span class="acc-bar-done" style="width:${Math.round((r.done / total) * 100)}%"></span>` : ""
        }</span>
      </span>`;
    list.appendChild(li);
  });
}

// Show the right facilitator stage buttons depending on boss state.
function renderStageControls() {
  const boss = view.boss;
  const fighting = !!boss && !boss.slain;
  const isFac = view.you.role === "facilitator";
  // these live inside #facilitator-controls (already hidden for players)
  $("#btn-pull-boss").classList.toggle("hidden", !isFac || fighting);
  $("#btn-drop-random").classList.toggle("hidden", !isFac || !fighting);
  $("#btn-drop-manual").classList.toggle("hidden", !isFac || !fighting);
  $("#btn-end-boss").classList.toggle("hidden", !isFac || !boss);
  // ANYONE can propose a remediation step while a boss is up.
  const composer = $("#remediation-composer");
  if (composer) composer.classList.toggle("hidden", !fighting);
}

function renderBoss() {
  const el = $("#boss");
  const boss = view.boss;
  if (!boss) { el.classList.add("hidden"); return; }
  const tier = BOSS_TIERS[boss.tier] || BOSS_TIERS.elite;
  const pct = Math.max(0, Math.round((boss.hp / boss.hpMax) * 100));
  const looted = view.log.filter((t) => t.bossId === boss.id && !t.passedOver).length;
  el.classList.remove("hidden");
  el.className = "boss" + (boss.slain ? " slain" : "");
  el.style.setProperty("--boss-color", tier.color);
  el.innerHTML = `
    <div class="boss-head">
      <div class="boss-name"><span class="skull">${boss.slain ? icon("swords") : icon("skull")}</span>${escapeHtml(boss.name)}</div>
      <div class="boss-tier">${tier.label}</div>
    </div>
    ${boss.desc ? `<div class="boss-desc-text">${escapeHtml(boss.desc)}</div>` : ""}
    ${boss.scoutedBy ? `<div class="boss-scout">Scouted by ${escapeHtml(boss.scoutedBy)}</div>` : ""}
    <div class="boss-hpwrap">
      <div class="boss-hp" style="width:${pct}%;"></div>
      <div class="boss-hptext">${boss.slain ? "DEFEATED" : `${Math.ceil(boss.hp)} / ${boss.hpMax} HP`}</div>
    </div>
    ${boss.slain
      ? `<div class="boss-slain-line">${slainLine(boss.name, looted)}</div>`
      : `<div class="boss-sub">Propose remediation steps. Every step someone owns damages the boss, and weightier fixes hit harder.</div>`}
    ${renderRemediationPlan(boss)}`;
}

// Render the boss's remediation plan: every step proposed for this problem,
// flagged by whether it became an owned task (won) or was passed on.
function renderRemediationPlan(boss) {
  const steps = boss.remediation || [];
  if (steps.length === 0) return "";
  const isFac = view.you.role === "facilitator";
  const activeStepId = view.activeDrop ? view.activeDrop.item.id : null;
  const liveUnresolved = !!view.activeDrop && !view.resolved;

  const rows = steps.map((s) => {
    const r = RARITY[s.rarity] || RARITY.common;
    const owned = view.log.find((t) => t.stepId === s.id && !t.passedOver);
    const onTable = s.id === activeStepId;

    // status: owned (won) > unowned (resolved pass) > on the table now > proposed
    let statusCls, statusText;
    if (owned) {
      statusCls = "owned";
      statusText = `${icon("person")} ${escapeHtml(owned.ownerReal || owned.ownerName)}`;
    } else if (onTable) {
      statusCls = "ontable";
      statusText = view.resolved ? "unowned" : "on the table";
    } else if (s.dropped) {
      statusCls = "unowned";
      statusText = "unowned";
    } else {
      statusCls = "proposed";
      const who = s.proposedReal || s.proposedBy || "";
      statusText = who ? `proposed by ${escapeHtml(who)}` : "proposed";
    }

    // facilitator gets a Drop button for steps not yet dropped (and not blocked
    // by a live unresolved drop)
    const dropBtn = (isFac && !s.dropped)
      ? `<button class="btn btn-primary rem-drop" data-drop-step="${s.id}" ${liveUnresolved ? "disabled title='Resolve the current drop first'" : ""}>Drop</button>`
      : "";

    return `
      <li class="rem-step ${statusCls}">
        <span class="log-rarity-dot bg-${r.cls}"></span>
        <span class="rem-name r-${r.cls}">${escapeHtml(s.name)}</span>
        <span class="rem-status">${statusText}</span>
        ${dropBtn}
      </li>`;
  }).join("");

  const pending = steps.filter((s) => !s.dropped).length;
  const sub = pending ? ` &mdash; ${pending} awaiting a drop` : "";
  return `
    <div class="rem-plan">
      <div class="rem-plan-head">Remediation plan &mdash; ${plural(steps.length, "step", "steps")} proposed${sub}</div>
      <ul class="rem-plan-list">${rows}</ul>
    </div>`;
}

// keep any open facilitator modal in sync with live state
function refreshOpenModals() {
  if (!$("#modal-config").classList.contains("hidden")) renderLootTableModal();
  if (!$("#modal-roster").classList.contains("hidden")) renderRosterModal();
  if (!$("#modal-manual").classList.contains("hidden")) renderManualDropModal();
}

function renderActiveDrop() {
  const el = $("#active-drop");
  const drop = view.activeDrop;
  if (!drop) {
    const boss = view.boss;
    const isFac = view.you.role === "facilitator";
    let hint;
    const mobs = view.mobList.length;
    const lurking = mobs
      ? `${plural(mobs, "mob lurks", "mobs lurk")} on the Mob List.`
      : "The Mob List is empty.";
    if (!boss) {
      hint = isFac
        ? `The dungeon is quiet. ${lurking} ${mobs ? "Pull a Boss to draw one at random." : "Scout some topics, or Pull a Boss to name one on the spot."}`
        : `The dungeon is quiet. ${lurking} Waiting for the facilitator to pull a boss…`;
    } else if (boss.slain) {
      hint = isFac
        ? `The boss lies slain. ${lurking} Pull the next one, or end the encounter.`
        : `The boss lies slain. ${lurking} Waiting for the facilitator…`;
    } else {
      hint = isFac
        ? "The boss is engaged! Anyone can propose remediation steps; drop one from the plan below (or from the backlog) to roll for it."
        : "The boss is engaged! Propose a remediation step above — the facilitator drops proposed steps for the roll.";
    }
    el.className = "active-drop empty";
    el.innerHTML = `<p class="empty-hint">${hint}</p>`;
    return;
  }
  const r = RARITY[drop.item.rarity];
  el.className = "active-drop filled";
  el.innerHTML = `
    <div class="drop-icon r-${r.cls}">${icon("gem")}</div>
    <div class="drop-meta">
      <h3 class="r-${r.cls}">${escapeHtml(drop.item.name)}</h3>
      <div class="drop-rarity r-${r.cls}">${r.label}</div>
      ${drop.item.desc ? `<div class="drop-desc">${escapeHtml(drop.item.desc)}</div>` : ""}
    </div>`;
}

function renderMyVote() {
  const bar = $("#my-vote");
  const hint = $("#my-vote-hint");
  const canVote = view.activeDrop && !view.resolved;

  if (!canVote) { bar.classList.add("hidden"); return; }

  if (!view.you.memberId) {
    bar.classList.remove("hidden");
    bar.querySelectorAll("[data-mychoice]").forEach((b) => (b.disabled = true));
    hint.textContent = "Claim a party slot (click your panel below) to vote.";
    return;
  }

  bar.classList.remove("hidden");
  const me = view.members.find((m) => m.id === view.you.memberId);
  const bagsFull = !!me && me.slotsUsed >= view.maxSlots;
  bar.querySelectorAll("[data-mychoice]").forEach((b) => {
    b.disabled = bagsFull && b.getAttribute("data-mychoice") !== "pass";
    b.classList.toggle("active", view.you.myChoice === b.getAttribute("data-mychoice"));
  });
  hint.textContent = bagsFull
    ? `Your bags are full (${view.maxSlots}/${view.maxSlots}). Complete a task to free a slot.`
    : view.you.myChoice
      ? `You chose ${cap(view.you.myChoice)}. Click again to undo.`
      : "Your choice is hidden from others until the facilitator resolves.";
}

function renderTally() {
  const bar = $("#resolve-bar");
  if (!view.activeDrop || view.resolved) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const t = view.tally;
  $("#vote-tally").innerHTML = `
    <span>Need <b>${t.need}</b></span>
    <span>Greed <b>${t.greed}</b></span>
    <span>Pass <b>${t.pass}</b></span>
    <span class="muted">Undecided <b>${t.undecided}</b></span>`;
}

function renderResult() {
  const el = $("#result-banner");
  const res = view.lastResult;
  if (!view.resolved || !res) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const r = RARITY[res.rarity];

  let headline;
  if (res.winnerId) {
    const who = res.winnerReal ? ` <span class="real-name">(${escapeHtml(res.winnerReal)})</span>` : "";
    headline = `<span class="r-${r.cls}">${escapeHtml(res.winnerName)}</span>${who} wins
      <b class="r-${r.cls}">${escapeHtml(res.itemName)}</b> by <b>${res.winnerContext}</b> roll!`;
  } else {
    headline = `Everyone passed on <b class="r-${r.cls}">${escapeHtml(res.itemName)}</b>. It lies unclaimed.`;
  }
  const rows = res.rolls.map((rw) => {
    const win = rw.memberId === res.winnerId ? ` <span class="win-tag">&#9733; WIN</span>` : "";
    const who = rw.realName ? ` <span class="real-name">(${escapeHtml(rw.realName)})</span>` : "";
    const txt = rw.choice === "pass" ? (rw.bagsFull ? "passed (bags full)" : "passed")
      : `${cap(rw.choice)} &mdash; rolled <b>${rw.roll}</b>`;
    return `<div class="roll-row">${escapeHtml(rw.name)}${who}: ${txt}${win}</div>`;
  }).join("");
  el.innerHTML = `<div class="winner-line">${headline}</div>${damageLine(res)}<div class="roll-detail">${rows}</div>`;
}

function renderParty() {
  $("#party-count").textContent = `${view.members.length} member${view.members.length === 1 ? "" : "s"}`;
  const grid = $("#party-grid");
  grid.innerHTML = "";

  view.members.forEach((m) => {
    const color = CLASSES[m.cls] || "#c8aa6e";
    const mine = view.you.memberId === m.id;
    const panel = document.createElement("div");
    panel.className = "member" + (m.faction ? ` faction-${m.faction.toLowerCase()}` : "");
    panel.style.setProperty("--member-color", color);
    const initials = m.name.trim().slice(0, 2).toUpperCase() || "??";

    // status line under the name
    let status = "";
    if (view.resolved && view.lastResult) {
      const rw = view.lastResult.rolls.find((x) => x.memberId === m.id);
      if (rw) {
        status = rw.choice === "pass" ? (rw.bagsFull ? "Passed (bags full)" : "Passed")
          : `${cap(rw.choice)} roll: ${rw.roll}` + (rw.memberId === view.lastResult.winnerId ? ` <span class="win-tag">&#9733; WON</span>` : "");
      }
    } else if (view.activeDrop) {
      status = m.hasVoted ? "Vote locked in" : "Deciding…";
    } else {
      status = m.claimed ? (m.connected ? "Ready" : "Away") : "Open slot";
    }

    // claim button when the slot is free and this client has no slot yet
    const claimBtn = (!m.claimed && !view.you.memberId)
      ? `<button class="btn btn-primary" data-claim="${m.id}" style="font-size:12px;padding:6px 0;width:100%;">Claim this slot</button>`
      : (mine ? `<div class="muted" style="font-size:11px;text-align:center;">This is you</div>` : "");

    const myTasks = view.log.filter((t) => t.ownerId === m.id);
    const openCount = myTasks.filter((t) => !t.done).length;
    const doneCount = myTasks.length - openCount;

    // hover tooltip: who this is + their loot workload
    const tipParts = [
      m.name,
      m.realName ? `Real name: ${m.realName}` : null,
      `${(m.race ? m.race + " " : "")}${m.cls}`,
      m.faction || null,
      `Loot: ${openCount} open, ${doneCount} done`,
      `Bags: ${m.slotsUsed}/${view.maxSlots}`,
    ].filter(Boolean);
    panel.title = tipParts.join(" \u2022 ");

    const crest = m.faction
      ? `<span class="faction-crest crest-${m.faction.toLowerCase()}" title="${m.faction}">${FACTION_CREST[m.faction] || ""}</span>`
      : "";

    panel.innerHTML = `
      <div class="member-head">
        <div class="member-avatar">${raceIcon(m.race) || escapeHtml(initials)}</div>
        <div class="member-headtext">
          <div class="member-name">${crest}${escapeHtml(m.name)}${mine ? " &#9733;" : ""}</div>
          <div class="member-class">${escapeHtml((m.race ? m.race + " " : "") + m.cls)}</div>
          ${m.realName ? `<div class="member-real">${icon("person")} ${escapeHtml(m.realName)}</div>` : ""}
        </div>
      </div>
      <div class="member-roll">${status}</div>
      <div class="member-bags">
        ${bagSlots(myTasks.filter((t) => !t.done), view.maxSlots)}
        ${m.slotsUsed >= view.maxSlots ? `<div class="member-bags-label full">Bags full &mdash; complete a task to free a slot</div>` : ""}
      </div>
      ${claimBtn}
      <div class="member-tasks">
        ${myTasks.map((t) => `
          <div class="mini-task ${t.done ? "done" : ""}">
            <input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""}/>
            <span>${escapeHtml(t.name)}</span>
          </div>`).join("")}
      </div>`;
    grid.appendChild(panel);
  });
}

function renderLog() {
  const looted = view.log.filter((t) => !t.passedOver).length;
  const passed = view.log.length - looted;
  $("#log-count").textContent =
    `${looted} item${looted === 1 ? "" : "s"} looted` + (passed ? `, ${passed} passed over` : "");
  const list = $("#loot-log-list");
  list.innerHTML = "";
  if (view.log.length === 0) {
    list.innerHTML = `<li class="muted" style="justify-content:center;">No loot has dropped yet.</li>`;
    return;
  }
  [...view.log].reverse().forEach((t) => {
    const r = RARITY[t.rarity];
    const li = document.createElement("li");
    if (t.passedOver) {
      // no owner, not a task — just a record that it was dropped on
      li.className = "passed-over";
      li.innerHTML = `
        <span class="log-rarity-dot bg-${r.cls}"></span>
        <span class="log-name r-${r.cls}">${escapeHtml(t.name)}</span>
        <span class="log-owner log-passed">&#8856; passed over</span>`;
    } else {
      li.className = t.done ? "done" : "";
      li.innerHTML = `
        <span class="log-rarity-dot bg-${r.cls}"></span>
        <input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""}/>
        <span class="log-name r-${r.cls}">${escapeHtml(t.name)}</span>
        <span class="log-owner">${icon("person")} ${escapeHtml(t.ownerReal || t.ownerName)}${t.ownerReal ? ` <span class="log-char">as ${escapeHtml(t.ownerName)}</span>` : ""}</span>`;
    }
    list.appendChild(li);
  });
}

/* ---------------- Toast (fires on everyone's screen at resolve) ---------------- */

function maybeToast() {
  const res = view.lastResult;
  if (view.resolved && res && res.winnerId && res.dropId !== lastShownResultId) {
    lastShownResultId = res.dropId;
    showLootToast(res.itemName, res.rarity, res.winnerName);
  }
  // announce each newly pulled boss once
  const boss = view.boss;
  if (boss && !boss.slain && boss.id !== lastPulledBossId) {
    lastPulledBossId = boss.id;
    showPullToast(boss);
  }
  // fire a victory toast once per boss when the server marks it slain
  if (boss && boss.slain && boss.id !== lastSlainBossId) {
    lastSlainBossId = boss.id;
    showBossToast(boss);
  }
}

// A victory toast when a boss (topic) is fully defeated — fires on everyone.
// Toast colour per boss tier, matching the tier colours.
const TIER_TOAST = { trash: "common", elite: "epic", raid: "legendary" };

function showPullToast(boss) {
  const stack = $("#toast-stack");
  if (!stack) return;
  const tier = BOSS_TIERS[boss.tier] || BOSS_TIERS.elite;
  const toast = document.createElement("div");
  toast.className = `loot-toast t-${TIER_TOAST[boss.tier] || "epic"}`;
  toast.innerHTML = `
    <div class="toast-icon">${icon("skull")}</div>
    <div class="toast-body">
      <div class="toast-received">A boss approaches:</div>
      <div class="toast-item">[${escapeHtml(boss.name)}]</div>
      <div class="toast-value"><span class="rarity-label">${tier.label}</span></div>
      ${boss.scoutedBy ? `<div class="toast-winner">Scouted by <b>${escapeHtml(boss.scoutedBy)}</b></div>` : ""}
    </div>`;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 500);
  }, 4500);
}

function showBossToast(boss) {
  const stack = $("#toast-stack");
  if (!stack) return;
  const tier = BOSS_TIERS[boss.tier] || BOSS_TIERS.elite;
  const looted = view.log.filter((t) => t.bossId === boss.id && !t.passedOver).length;
  const toast = document.createElement("div");
  toast.className = "loot-toast t-legendary";
  toast.innerHTML = `
    <div class="toast-icon">${icon("swords")}</div>
    <div class="toast-body">
      <div class="toast-received">Boss defeated:</div>
      <div class="toast-item">[${escapeHtml(boss.name)}]</div>
      <div class="toast-value">
        <span class="rarity-label">${tier.label}</span>
        <span class="coins">${plural(looted, "item", "items")} looted</span>
      </div>
      <div class="toast-winner">Victory!</div>
    </div>`;
  stack.appendChild(toast);
  const remove = () => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 500);
  };
  const timer = setTimeout(remove, 6500);
  toast.style.pointerEvents = "auto";
  toast.style.cursor = "pointer";
  toast.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

function showLootToast(itemName, rarity, winnerName) {
  const stack = $("#toast-stack");
  if (!stack) return;
  const r = RARITY[rarity] || RARITY.common;
  const toast = document.createElement("div");
  toast.className = `loot-toast t-${r.cls}`;
  toast.innerHTML = `
    <div class="toast-icon">${icon("gem")}</div>
    <div class="toast-body">
      <div class="toast-received">You receive loot:</div>
      <div class="toast-item">[${escapeHtml(itemName)}]</div>
      <div class="toast-value">
        <span class="rarity-label">${r.label}</span>
        <span class="coins">${formatGold(r.value)}</span>
      </div>
      <div class="toast-winner">Won by <b>${escapeHtml(winnerName)}</b></div>
    </div>`;
  stack.appendChild(toast);
  const life = rarity === "legendary" ? 6500 : 5000;
  const remove = () => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 500);
  };
  const timer = setTimeout(remove, life);
  toast.style.pointerEvents = "auto";
  toast.style.cursor = "pointer";
  toast.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

// transient error toast for in-game errors (slot taken, etc.)
function flashError(message) {
  if (!message || $("#game").classList.contains("hidden")) return;
  const stack = $("#toast-stack");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = "loot-toast t-poor";
  toast.style.setProperty("--toast-color", "var(--need)");
  toast.innerHTML = `
    <div class="toast-icon">${icon("warning")}</div>
    <div class="toast-body">
      <div class="toast-received">You can't do that</div>
      <div class="toast-item" style="white-space:normal;">${escapeHtml(message)}</div>
    </div>`;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 500);
  }, 3500);
}

/* ---------------- Modals (facilitator) ---------------- */

function openModal(sel) {
  if (sel === "#modal-config") renderLootTableModal();
  if (sel === "#modal-roster") renderRosterModal();
  if (sel === "#modal-manual") renderManualDropModal();
  $(sel).classList.remove("hidden");
}
function closeModals() { document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden")); }

function renderLootTableModal() {
  const list = $("#loot-table-list");
  list.innerHTML = view.lootTable.length ? "" : `<li class="muted" style="justify-content:center;">No loot defined yet.</li>`;
  view.lootTable.forEach((l) => {
    const r = RARITY[l.rarity];
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="log-rarity-dot bg-${r.cls}"></span>
      <span class="li-name r-${r.cls}">${escapeHtml(l.name)}</span>
      <span class="li-sub">${r.label}${l.desc ? " &middot; " + escapeHtml(l.desc) : ""}</span>
      <button class="li-remove" data-remove-loot="${l.id}" title="Remove">&times;</button>`;
    list.appendChild(li);
  });
}

// The shared mob list, rendered on the scout screen and in the Mob List modal.
// Scouts can remove their own mobs; the facilitator can remove any, and pull a
// specific one from the modal when no boss is engaged.
const TIER_ORDER = { trash: 0, elite: 1, raid: 2 };
function renderMobLists() {
  const mobs = [...view.mobList].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  const isFac = view.you.role === "facilitator";
  const fighting = !!view.boss && !view.boss.slain;
  $("#scout-count").textContent = plural(mobs.length, "mob", "mobs") + " scouted";
  [["#scout-mob-list", false], ["#modal-mob-list", isFac]].forEach(([sel, canPull]) => {
    const list = $(sel);
    list.innerHTML = mobs.length ? ""
      : `<li class="muted" style="justify-content:center;">No mobs scouted yet. Add the first topic above.</li>`;
    mobs.forEach((m) => {
      const tier = BOSS_TIERS[m.tier] || BOSS_TIERS.elite;
      const by = m.addedReal ? `${m.addedBy} (${m.addedReal})` : m.addedBy;
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="mob-tier-dot" style="--mob-color:${tier.color}"></span>
        <span class="mob-main">
          <span class="li-name">${escapeHtml(m.name)}</span>
          ${m.desc ? `<span class="mob-desc">${escapeHtml(m.desc)}</span>` : ""}
          <span class="li-sub">${tier.label} &middot; scouted by ${escapeHtml(by)}</span>
        </span>
        ${canPull ? `<button class="btn btn-primary li-drop" data-pull-mob="${m.id}" ${fighting ? "disabled title=\"Finish the current boss first\"" : ""}>Pull</button>` : ""}
        ${isFac || m.addedById === view.you.memberId ? `<button class="li-remove" data-remove-mob="${m.id}" title="Remove from the mob list">&times;</button>` : ""}`;
      list.appendChild(li);
    });
  });
}

function addMobFrom(form) {
  const name = form.querySelector("[name=mob-name]");
  const desc = form.querySelector("[name=mob-desc]");
  if (!name.value.trim()) { name.focus(); return; }
  $("#scout-error").textContent = "";
  send({ type: "addMob", name: name.value, desc: desc.value, tier: form.querySelector("[name=mob-tier]").value });
  name.value = ""; desc.value = "";
  name.focus();
}

function renderRosterModal() {
  const list = $("#roster-list");
  list.innerHTML = view.members.length ? "" : `<li class="muted" style="justify-content:center;">No party members yet.</li>`;
  view.members.forEach((m) => {
    const color = CLASSES[m.cls] || "#c8aa6e";
    const li = document.createElement("li");
    const statusWord = m.claimed ? (m.connected ? "claimed" : "away") : "open";
    const mgmt = m.claimed
      ? `<button class="btn btn-ghost li-drop" data-kick="${m.id}" title="Free this slot">Kick</button>
         <button class="btn btn-ghost li-drop" data-reassign="${m.id}" title="Make this player the facilitator">Make host</button>`
      : "";
    li.innerHTML = `
      <span class="log-rarity-dot" style="background:${color}"></span>
      <span class="li-name">${escapeHtml(m.name)}</span>
      <span class="li-sub">${escapeHtml(m.cls)} &middot; ${statusWord}</span>
      ${mgmt}
      <button class="li-remove" data-remove-member="${m.id}" title="Remove slot">&times;</button>`;
    list.appendChild(li);
  });
  const sel = $("#member-class");
  if (sel.options.length === 0) {
    Object.keys(CLASSES).forEach((c) => {
      const o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o);
    });
  }
}

function renderManualDropModal() {
  const list = $("#manual-drop-list");
  // hide items someone already owns (the server enforces this too)
  const claimed = new Set(view.log.filter((t) => !t.passedOver).map((t) => t.stepId));
  const pool = view.lootTable.filter((l) => !claimed.has(l.id));
  list.innerHTML = pool.length ? ""
    : `<li class="muted" style="justify-content:center;">${view.lootTable.length ? "Every backlog item has already been claimed." : "Add items to the loot table first."}</li>`;
  pool.forEach((l) => {
    const r = RARITY[l.rarity];
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="log-rarity-dot bg-${r.cls}"></span>
      <span class="li-name r-${r.cls}">${escapeHtml(l.name)}</span>
      <span class="li-sub">${r.label}</span>
      <button class="btn btn-primary li-drop" data-drop-loot="${l.id}">Drop</button>`;
    list.appendChild(li);
  });
}

/* ---------------- Export ---------------- */
// Build a markdown report grouped by problem (boss): each problem lists its
// remediation plan, with owned steps as owned checklist items and unowned
// steps noted as proposals.
function buildExport() {
  const bosses = [...(view.bossLog || [])];
  if (view.boss && !bosses.some((b) => b.id === view.boss.id)) {
    bosses.push({
      id: view.boss.id, name: view.boss.name, desc: view.boss.desc || "", tier: view.boss.tier,
      slain: view.boss.slain, remediation: view.boss.remediation || [],
    });
  }
  const tierLabel = (t) => (BOSS_TIERS[t] ? BOSS_TIERS[t].label : "Elite");
  const ownedFor = (stepId) => view.log.find((t) => t.stepId === stepId && !t.passedOver);
  const ownerStr = (t) => (t.ownerReal ? `${t.ownerReal} (${t.ownerName})` : t.ownerName);

  const sections = bosses.map((b) => {
    const header = `## ${b.name} — ${tierLabel(b.tier)}${b.slain ? " ✓ addressed" : ""}`;
    const descLine = b.desc ? `\n_${b.desc}_\n` : "";
    const steps = b.remediation || [];
    if (steps.length === 0) return `${header}${descLine}\n_No remediation steps proposed._`;
    const lines = steps.map((s) => {
      const owned = ownedFor(s.id);
      const rarity = RARITY[s.rarity] ? RARITY[s.rarity].label : "Uncommon";
      return owned
        ? `${owned.done ? "[x]" : "[ ]"} ${s.name} — ${rarity} — owner: ${ownerStr(owned)}`
        : `[ ] ${s.name} — ${rarity} — _(proposed, unowned)_`;
    });
    return `${header}${descLine}\n${lines.join("\n")}`;
  });

  const orphans = view.log.filter((t) =>
    !t.passedOver &&
    (!t.stepId || !bosses.some((b) => (b.remediation || []).some((s) => s.id === t.stepId)))
  );
  if (orphans.length) {
    const lines = orphans.map((t) =>
      `${t.done ? "[x]" : "[ ]"} ${t.name} — ${RARITY[t.rarity].label} — owner: ${ownerStr(t)}`
    );
    sections.push(`## Other looted items\n\n${lines.join("\n")}`);
  }
  return `# Retro Remediation Plan\n\n${sections.join("\n\n")}\n`;
}

function exportTasks() {
  if (!view || view.log.length === 0) { alert("No looted tasks to export yet."); return; }
  const text = buildExport();
  navigator.clipboard?.writeText(text).then(
    () => alert("Tasks copied to clipboard!\n\n" + text),
    () => downloadText("retro-loot-tasks.md", text)
  ) || downloadText("retro-loot-tasks.md", text);
}
function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- Helpers ---------------- */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
// "Dealt N damage" under a resolved drop, or nothing if no live boss was hit.
function damageLine(res) {
  if (res.damage == null) return "";
  if (!res.damage) return `<div class="damage-line muted">No damage. Nobody took ownership of it.</div>`;
  return `<div class="damage-line">${icon("swords")} Dealt <b>${res.damage}</b> damage</div>`;
}
// Victory line under a slain boss, worded as loot rather than tasks.
function slainLine(bossName, looted) {
  const name = escapeHtml(bossName);
  return looted
    ? `&#9733; ${name} has been slain! The party claimed ${plural(looted, "piece", "pieces")} of loot.`
    : `&#9733; ${name} has been slain, but the party left empty-handed.`;
}

/* ---------------- Event wiring ---------------- */

$("#btn-create").addEventListener("click", () => { showLobbyError(""); send({ type: "create" }); });
$("#btn-join").addEventListener("click", () => {
  const code = $("#join-code").value.trim().toUpperCase();
  if (code.length < 3) return showLobbyError("Enter the room code.");
  showLobbyError("");
  send({ type: "join", room: code });
});
$("#join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-join").click(); });

$("#btn-leave").addEventListener("click", () => {
  const url = new URL(location.href); url.searchParams.delete("room");
  location.href = url.toString(); // simplest clean reset
});

$("#btn-create-char").addEventListener("click", submitCharacter);
$("#char-name").addEventListener("keydown", (e) => { if (e.key === "Enter") submitCharacter(); });
$("#char-realname").addEventListener("keydown", (e) => { if (e.key === "Enter") submitCharacter(); });

// Pull a Boss draws from the mob list at random; with nothing scouted, name one on the spot.
$("#btn-pull-boss").addEventListener("click", () => {
  if (view.mobList.length) send({ type: "pullBoss", random: true });
  else openModal("#modal-boss");
});
$("#btn-mobs").addEventListener("click", () => openModal("#modal-mobs"));
$("#btn-enter-dungeon").addEventListener("click", () => { markScouted(view.room); onState(view); });
document.querySelectorAll("[data-mob-form] [name=mob-name]").forEach((input) =>
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") addMobFrom(input.closest("[data-mob-form]")); })
);
$("#btn-confirm-boss").addEventListener("click", () => {
  send({ type: "pullBoss", name: $("#boss-name").value, desc: $("#boss-desc").value, tier: $("#boss-tier").value });
  $("#boss-name").value = "";
  $("#boss-desc").value = "";
  closeModals();
});
$("#boss-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-confirm-boss").click(); });
$("#btn-end-boss").addEventListener("click", () => {
  const boss = view && view.boss;
  if (!boss) return;
  if (boss.slain || confirm("End this encounter? The boss isn't defeated yet — any undistributed drop will be cleared.")) {
    send({ type: "endBoss" });
  }
});
$("#btn-drop-random").addEventListener("click", () => send({ type: "drop" }));
$("#btn-drop-manual").addEventListener("click", () => openModal("#modal-manual"));
$("#btn-drop-step").addEventListener("click", () => {
  send({ type: "proposeStep", name: $("#rc-name").value, rarity: $("#rc-rarity").value, desc: $("#rc-desc").value });
  $("#rc-name").value = ""; $("#rc-desc").value = "";
});
$("#rc-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-drop-step").click(); });
$("#rc-desc").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-drop-step").click(); });
$("#btn-resolve").addEventListener("click", () => send({ type: "resolve" }));
$("#btn-config").addEventListener("click", () => openModal("#modal-config"));
$("#btn-roster").addEventListener("click", () => openModal("#modal-roster"));
$("#btn-export").addEventListener("click", exportTasks);

$("#btn-add-loot").addEventListener("click", () => {
  send({ type: "addLoot", name: $("#loot-name").value, rarity: $("#loot-rarity").value, desc: $("#loot-desc").value });
  $("#loot-name").value = ""; $("#loot-desc").value = "";
});
$("#btn-add-member").addEventListener("click", () => {
  send({ type: "addMember", name: $("#member-name").value, cls: $("#member-class").value });
  $("#member-name").value = "";
});

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.matches("[data-close]") || t.classList.contains("modal")) { closeModals(); return; }
  const raceOpt = t.closest && t.closest(".race-option");
  if (raceOpt) { selectRace(raceOpt.dataset.race); return; }
  const classOpt = t.closest && t.closest(".class-option");
  if (classOpt) { chosenClass = classOpt.dataset.cls; renderClassPicker(); return; }
  if (t.matches("[data-mychoice]")) { if (!t.disabled) send({ type: "setChoice", choice: t.getAttribute("data-mychoice") }); return; }
  if (t.matches("[data-claim]")) { send({ type: "claimMember", memberId: t.getAttribute("data-claim") }); return; }
  if (t.matches("[data-remove-loot]")) { send({ type: "removeLoot", lootId: t.getAttribute("data-remove-loot") }); return; }
  if (t.matches("[data-remove-member]")) { send({ type: "removeMember", memberId: t.getAttribute("data-remove-member") }); return; }
  if (t.matches("[data-kick]")) {
    const m = view.members.find((x) => x.id === t.getAttribute("data-kick"));
    if (m && confirm(`Kick the player holding "${m.name}"? The slot stays open for someone to reclaim.`)) send({ type: "kickMember", memberId: m.id });
    return;
  }
  if (t.matches("[data-reassign]")) {
    const m = view.members.find((x) => x.id === t.getAttribute("data-reassign"));
    if (m && confirm(`Hand facilitator (host) control to the player in "${m.name}"? You'll become a regular player.`)) send({ type: "reassignFacilitator", memberId: m.id });
    return;
  }
  if (t.matches("[data-add-mob]")) { addMobFrom(t.closest("[data-mob-form]")); return; }
  if (t.matches("[data-remove-mob]")) { send({ type: "removeMob", mobId: t.getAttribute("data-remove-mob") }); return; }
  if (t.matches("[data-pull-mob]")) { if (!t.disabled) { send({ type: "pullBoss", mobId: t.getAttribute("data-pull-mob") }); closeModals(); } return; }
  if (t.matches("[data-drop-loot]")) { send({ type: "drop", lootId: t.getAttribute("data-drop-loot") }); closeModals(); return; }
  if (t.matches("[data-drop-step]")) { if (!t.disabled) send({ type: "dropStep", stepId: t.getAttribute("data-drop-step") }); return; }
});

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-task]")) send({ type: "toggleTask", taskId: e.target.getAttribute("data-task") });
});

/* ---------------- Boot ---------------- */
connect();
