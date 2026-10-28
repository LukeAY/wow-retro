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

// Faction crest emoji (simple, dependency-free).
const FACTION_CREST = { Alliance: "&#128737;", Horde: "&#9876;" }; // 🛡️ / ⚔️

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
    else if (msg.type === "error") { showLobbyError(msg.message); flashError(msg.message); }
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
    const url = new URL(location.href);
    url.searchParams.set("room", msg.room);
    history.replaceState({}, "", url);
  }

  const hasCharacter = !!msg.you.memberId;

  // No character yet -> show the creation screen, hide the game.
  if (!hasCharacter) {
    $("#create-char").classList.remove("hidden");
    $("#game").classList.add("hidden");
    $("#btn-config").classList.add("hidden");
    $("#btn-roster").classList.add("hidden");
    $("#btn-export").classList.add("hidden");
    renderRaceSelect();
    ensureValidClass();
    renderClassPicker();
    return;
  }

  // Has a character -> enter the game.
  $("#create-char").classList.add("hidden");
  $("#game").classList.remove("hidden");
  $("#btn-export").classList.remove("hidden");

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

// Build the race dropdown, grouped by faction, from the server matrix.
function renderRaceSelect() {
  const sel = $("#char-race");
  if (sel.childElementCount > 0) return; // build once
  const byFaction = { Alliance: [], Horde: [] };
  Object.keys(RACE_CLASSES).forEach((race) => {
    (byFaction[FACTION[race]] || (byFaction[FACTION[race]] = [])).push(race);
  });
  ["Alliance", "Horde"].forEach((faction) => {
    if (!byFaction[faction] || !byFaction[faction].length) return;
    const group = document.createElement("optgroup");
    group.label = faction;
    byFaction[faction].forEach((race) => {
      const o = document.createElement("option");
      o.value = race; o.textContent = race;
      group.appendChild(o);
    });
    sel.appendChild(group);
  });
  sel.value = chosenRace;
  // keep the class picker valid whenever the race changes
  sel.addEventListener("change", () => {
    chosenRace = sel.value;
    ensureValidClass();
    renderClassPicker();
  });
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
  ensureValidClass();
  if (!RACE_CLASSES[chosenRace] || !RACE_CLASSES[chosenRace].includes(chosenClass)) {
    $("#char-error").textContent = "Pick a valid race and class.";
    return;
  }
  $("#char-error").textContent = "";
  send({ type: "createCharacter", name, cls: chosenClass, race: chosenRace });
}

function render() {
  renderBoss();
  renderStageControls();
  renderActiveDrop();
  renderMyVote();
  renderTally();
  renderResult();
  renderParty();
  renderLog();
  maybeToast();
  refreshOpenModals();
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
}

function renderBoss() {
  const el = $("#boss");
  const boss = view.boss;
  if (!boss) { el.classList.add("hidden"); return; }
  const tier = BOSS_TIERS[boss.tier] || BOSS_TIERS.elite;
  const pct = Math.max(0, Math.round((boss.hp / boss.hpMax) * 100));
  const looted = view.log.filter((t) => t.bossId === boss.id).length;
  el.classList.remove("hidden");
  el.className = "boss" + (boss.slain ? " slain" : "");
  el.style.setProperty("--boss-color", tier.color);
  el.innerHTML = `
    <div class="boss-head">
      <div class="boss-name"><span class="skull">${boss.slain ? "&#9876;" : "&#128128;"}</span>${escapeHtml(boss.name)}</div>
      <div class="boss-tier">${tier.label}</div>
    </div>
    <div class="boss-hpwrap">
      <div class="boss-hp" style="width:${pct}%;"></div>
      <div class="boss-hptext">${boss.slain ? "DEFEATED" : `${pct}% HP`}</div>
    </div>
    ${boss.slain
      ? `<div class="boss-slain-line">&#9733; Boss defeated! The party looted ${looted} item(s) from this topic.</div>`
      : `<div class="boss-sub">Attack by dropping loot. Every resolved drop damages the boss — won items hit hardest.</div>`}`;
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
    if (!boss) {
      hint = isFac ? "No boss pulled. Pull a boss (a retro topic) to start the encounter." : "No boss pulled yet. Waiting for the facilitator…";
    } else if (boss.slain) {
      hint = isFac ? "Boss defeated. Pull the next boss, or end the encounter." : "Boss defeated. Waiting for the facilitator…";
    } else {
      hint = isFac ? "Boss is up. Attack by dropping loot — each drop you resolve damages it." : "Boss is up. Waiting for the facilitator to drop loot…";
    }
    el.className = "active-drop empty";
    el.innerHTML = `<p class="empty-hint">${hint}</p>`;
    return;
  }
  const r = RARITY[drop.item.rarity];
  el.className = "active-drop filled";
  el.innerHTML = `
    <div class="drop-icon r-${r.cls}">&#128142;</div>
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
  bar.querySelectorAll("[data-mychoice]").forEach((b) => {
    b.disabled = false;
    b.classList.toggle("active", view.you.myChoice === b.getAttribute("data-mychoice"));
  });
  hint.textContent = view.you.myChoice
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
    headline = `<span class="r-${r.cls}">${escapeHtml(res.winnerName)}</span> wins
      <b class="r-${r.cls}">${escapeHtml(res.itemName)}</b> by <b>${res.winnerContext}</b> roll!`;
  } else {
    headline = `Everyone passed on <b class="r-${r.cls}">${escapeHtml(res.itemName)}</b>. Unclaimed.`;
  }
  const rows = res.rolls.map((rw) => {
    const win = rw.memberId === res.winnerId ? ` <span class="win-tag">&#9733; WIN</span>` : "";
    const txt = rw.choice === "pass" ? "passed" : `${cap(rw.choice)} &mdash; rolled <b>${rw.roll}</b>`;
    return `<div class="roll-row">${escapeHtml(rw.name)}: ${txt}${win}</div>`;
  }).join("");
  el.innerHTML = `<div class="winner-line">${headline}</div><div class="roll-detail">${rows}</div>`;
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
        status = rw.choice === "pass" ? "Passed"
          : `${cap(rw.choice)} roll: ${rw.roll}` + (rw.memberId === view.lastResult.winnerId ? ` <span class="win-tag">&#9733; WON</span>` : "");
      }
    } else if (view.activeDrop) {
      status = m.hasVoted ? "Vote locked in" : "Deciding…";
    } else {
      status = m.claimed ? (m.connected ? "Ready" : "Away") : "Open slot";
    }

    // claim button when the slot is free and this client has no slot yet
    const claimBtn = (!m.claimed && !view.you.memberId)
      ? `<button class="btn btn-gold" data-claim="${m.id}" style="font-size:12px;padding:6px 0;width:100%;">Claim this slot</button>`
      : (mine ? `<div class="muted" style="font-size:11px;text-align:center;">This is you</div>` : "");

    const myTasks = view.log.filter((t) => t.ownerId === m.id);

    const crest = m.faction
      ? `<span class="faction-crest crest-${m.faction.toLowerCase()}" title="${m.faction}">${FACTION_CREST[m.faction] || ""}</span>`
      : "";

    panel.innerHTML = `
      <div class="member-head">
        <div class="member-avatar">${escapeHtml(initials)}</div>
        <div class="member-headtext">
          <div class="member-name">${crest}${escapeHtml(m.name)}${mine ? " &#9733;" : ""}</div>
          <div class="member-class">${escapeHtml((m.race ? m.race + " " : "") + m.cls)}</div>
        </div>
      </div>
      <div class="member-roll">${status}</div>
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
  $("#log-count").textContent = `${view.log.length} item${view.log.length === 1 ? "" : "s"} looted`;
  const list = $("#loot-log-list");
  list.innerHTML = "";
  if (view.log.length === 0) {
    list.innerHTML = `<li class="muted" style="justify-content:center;">No loot distributed yet.</li>`;
    return;
  }
  [...view.log].reverse().forEach((t) => {
    const r = RARITY[t.rarity];
    const li = document.createElement("li");
    li.className = t.done ? "done" : "";
    li.innerHTML = `
      <span class="log-rarity-dot bg-${r.cls}"></span>
      <input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""}/>
      <span class="log-name r-${r.cls}">${escapeHtml(t.name)}</span>
      <span class="log-owner">&#128100; ${escapeHtml(t.ownerName)}</span>`;
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
  // fire a victory toast once per boss when the server marks it slain
  const boss = view.boss;
  if (boss && boss.slain && boss.id !== lastSlainBossId) {
    lastSlainBossId = boss.id;
    showBossToast(boss);
  }
}

// A victory toast when a boss (topic) is fully defeated — fires on everyone.
function showBossToast(boss) {
  const stack = $("#toast-stack");
  if (!stack) return;
  const tier = BOSS_TIERS[boss.tier] || BOSS_TIERS.elite;
  const looted = view.log.filter((t) => t.bossId === boss.id).length;
  const toast = document.createElement("div");
  toast.className = "loot-toast t-legendary";
  toast.innerHTML = `
    <div class="toast-icon">&#9876;</div>
    <div class="toast-body">
      <div class="toast-received">Boss defeated:</div>
      <div class="toast-item">[${escapeHtml(boss.name)}]</div>
      <div class="toast-value">
        <span class="rarity-label">${tier.label}</span>
        <span class="coins">${looted} item(s) looted</span>
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
    <div class="toast-icon">&#128142;</div>
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
    <div class="toast-icon">&#9888;</div>
    <div class="toast-body">
      <div class="toast-received">Heads up</div>
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
  list.innerHTML = view.lootTable.length ? "" : `<li class="muted" style="justify-content:center;">Add items to the loot table first.</li>`;
  view.lootTable.forEach((l) => {
    const r = RARITY[l.rarity];
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="log-rarity-dot bg-${r.cls}"></span>
      <span class="li-name r-${r.cls}">${escapeHtml(l.name)}</span>
      <span class="li-sub">${r.label}</span>
      <button class="btn btn-gold li-drop" data-drop-loot="${l.id}">Drop</button>`;
    list.appendChild(li);
  });
}

/* ---------------- Export ---------------- */
function exportTasks() {
  if (!view || view.log.length === 0) { alert("No looted tasks to export yet."); return; }
  const lines = view.log.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.name} — ${RARITY[t.rarity].label} — owner: ${t.ownerName}`);
  const text = `# Retro Action Items (Loot)\n\n${lines.join("\n")}\n`;
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

$("#btn-pull-boss").addEventListener("click", () => openModal("#modal-boss"));
$("#btn-confirm-boss").addEventListener("click", () => {
  send({ type: "pullBoss", name: $("#boss-name").value, tier: $("#boss-tier").value });
  $("#boss-name").value = "";
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
  if (t.matches("[data-drop-loot]")) { send({ type: "drop", lootId: t.getAttribute("data-drop-loot") }); closeModals(); return; }
});

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-task]")) send({ type: "toggleTask", taskId: e.target.getAttribute("data-task") });
});

/* ---------------- Boot ---------------- */
connect();
