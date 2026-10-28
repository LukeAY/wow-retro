/* =========================================================================
 * Loot Council — WoW-themed retro loot roller
 * Need / Greed / Pass group loot, each party member has their own panel.
 * No backend: state persists to localStorage. Facilitator-driven.
 * ========================================================================= */

const STORAGE_KEY = "wow-retro-loot-council-v1";

const RARITY = {
  poor:      { label: "Poor",      cls: "poor",      value: 150 },
  common:    { label: "Common",    cls: "common",    value: 2500 },
  uncommon:  { label: "Uncommon",  cls: "uncommon",  value: 42000 },
  rare:      { label: "Rare",      cls: "rare",      value: 185000 },
  epic:      { label: "Epic",      cls: "epic",      value: 1250000 },
  legendary: { label: "Legendary", cls: "legendary", value: 10000000 },
};
const RARITY_ORDER = ["poor", "common", "uncommon", "rare", "epic", "legendary"];

/**
 * Boss tiers (shared mechanic). A boss is a retro topic. Its health is a
 * number of "drops to kill" — each resolved drop damages it. Looted (won)
 * drops hit harder than ones everyone passed on, so a productive discussion
 * fells the boss faster. Tougher tiers expect heavier action items.
 */
const BOSS_TIERS = {
  trash: { label: "Trash mob", hp: 1, color: "#9aa4b2" },
  elite: { label: "Elite",     hp: 2, color: "#a335ee" },
  raid:  { label: "Raid boss", hp: 4, color: "#ff8000" },
};
// A looted (won) drop deals a full hit; an unclaimed drop only chips away.
const DMG_LOOTED = 1;
const DMG_UNCLAIMED = 0.5;

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

// WoW classes -> representative class colors (used for member panels)
const CLASSES = {
  "Death Knight": "#c41e3a",
  "Demon Hunter": "#a330c9",
  "Druid":        "#ff7c0a",
  "Evoker":       "#33937f",
  "Hunter":       "#aad372",
  "Mage":         "#3fc7eb",
  "Monk":         "#00ff98",
  "Paladin":      "#f48cba",
  "Priest":       "#ffffff",
  "Rogue":        "#fff468",
  "Shaman":       "#0070dd",
  "Warlock":      "#8788ee",
  "Warrior":      "#c69b6d",
};

/* ---------------- State ---------------- */

function defaultState() {
  return {
    // Start empty — the party fills the backlog by proposing remediation steps
    // (or adding items to the Loot Table) during the session.
    lootTable: [],
    party: [
      { id: uid(), name: "Tank", cls: "Warrior" },
      { id: uid(), name: "Healer", cls: "Priest" },
      { id: uid(), name: "DPS", cls: "Rogue" },
    ],
    boss: null,         // { id, name, tier, hpMax, hp, slain, remediation[] } — the active encounter
    bossLog: [],        // [{ id, name, tier, slain, remediation[] }] — past problems (for per-problem export)
    activeDrop: null,   // { item, choices: {memberId: 'need'|'greed'|'pass'} }
    lastResult: null,   // resolved result for the current/previous drop
    log: [],            // [{ id, name, rarity, ownerId, ownerName, bossId, stepId, passedOver, done }]
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ---------------- DOM refs ---------------- */
const $ = (sel) => document.querySelector(sel);
const bossEl = $("#boss");
const activeDropEl = $("#active-drop");
const resolveBar = $("#resolve-bar");
const voteTallyEl = $("#vote-tally");
const resultBanner = $("#result-banner");
const partyGrid = $("#party-grid");
const partyCount = $("#party-count");
const lootLogList = $("#loot-log-list");
const logCount = $("#log-count");

/* ---------------- Rendering ---------------- */

function render() {
  renderBoss();
  renderActiveDrop();
  renderParty();
  renderLog();
  renderStageControls();
  refreshOpenModals();
  save();
}

// Keep any open modal in sync with live state (e.g. a step proposed while the
// Loot Table is open should appear immediately).
function refreshOpenModals() {
  if (!$("#modal-config").classList.contains("hidden")) renderLootTableModal();
  if (!$("#modal-roster").classList.contains("hidden")) renderRosterModal();
  if (!$("#modal-manual").classList.contains("hidden")) renderManualDropModal();
}

// Show the right set of stage buttons depending on whether a boss is up.
function renderStageControls() {
  const boss = state.boss;
  const fighting = !!boss && !boss.slain;
  $("#btn-pull-boss").classList.toggle("hidden", fighting);
  $("#btn-drop-random").classList.toggle("hidden", !fighting);
  $("#btn-drop-manual").classList.toggle("hidden", !fighting);
  $("#btn-end-boss").classList.toggle("hidden", !boss);
  const composer = $("#remediation-composer");
  if (composer) composer.classList.toggle("hidden", !fighting);
}

function renderBoss() {
  const boss = state.boss;
  if (!boss) { bossEl.classList.add("hidden"); return; }
  const tier = BOSS_TIERS[boss.tier] || BOSS_TIERS.elite;
  const pct = Math.max(0, Math.round((boss.hp / boss.hpMax) * 100));
  bossEl.classList.remove("hidden");
  bossEl.className = "boss" + (boss.slain ? " slain" : "");
  bossEl.style.setProperty("--boss-color", tier.color);
  bossEl.innerHTML = `
    <div class="boss-head">
      <div class="boss-name"><span class="skull">${boss.slain ? "&#9876;" : "&#128128;"}</span>${escapeHtml(boss.name)}</div>
      <div class="boss-tier">${tier.label}</div>
    </div>
    ${boss.desc ? `<div class="boss-desc-text">${escapeHtml(boss.desc)}</div>` : ""}
    <div class="boss-hpwrap">
      <div class="boss-hp" style="width:${pct}%;"></div>
      <div class="boss-hptext">${boss.slain ? "DEFEATED" : `${pct}% HP`}</div>
    </div>
    ${boss.slain
      ? `<div class="boss-slain-line">&#9733; Problem addressed! The party committed ${countBossLoot(boss.id)} owned remediation step(s).</div>`
      : `<div class="boss-sub">Propose remediation steps. Every resolved step damages the boss — owned fixes hit hardest.</div>`}
    ${renderRemediationPlan(boss)}
  `;
}

// How many log entries were looted during this boss encounter (owned only;
// passed-over items are recorded but don't count as loot).
function countBossLoot(bossId) {
  return state.log.filter((t) => t.bossId === bossId && !t.passedOver).length;
}

// Render the boss's remediation plan: every step proposed for this problem,
// flagged by whether it became an owned task (won) or was passed on.
function renderRemediationPlan(boss) {
  const steps = boss.remediation || [];
  if (steps.length === 0) return "";
  const rows = steps.map((s) => {
    const r = RARITY[s.rarity] || RARITY.common;
    const owned = state.log.find((t) => t.stepId === s.id && !t.passedOver);
    const statusCls = owned ? "owned" : "unowned";
    const statusText = owned
      ? `&#128100; ${escapeHtml(owned.ownerName)}`
      : `unowned`;
    return `
      <li class="rem-step ${statusCls}">
        <span class="log-rarity-dot bg-${r.cls}"></span>
        <span class="rem-name r-${r.cls}">${escapeHtml(s.name)}</span>
        <span class="rem-status">${statusText}</span>
      </li>`;
  }).join("");
  return `
    <div class="rem-plan">
      <div class="rem-plan-head">Remediation plan &mdash; ${steps.length} step(s) proposed</div>
      <ul class="rem-plan-list">${rows}</ul>
    </div>`;
}

function renderActiveDrop() {
  const drop = state.activeDrop;
  if (!drop) {
    const boss = state.boss;
    const hint = !boss
      ? "No problem pulled. Pull a boss (a problem to address) to start the encounter."
      : boss.slain
        ? "Problem addressed. Pull the next boss, or end the encounter."
        : "Boss is up. Propose a remediation step above (or drop from the backlog) — each resolved drop damages it.";
    activeDropEl.className = "active-drop empty";
    activeDropEl.innerHTML = `<p class="empty-hint">${hint}</p>`;
    resolveBar.classList.add("hidden");
    if (!state.lastResult) resultBanner.classList.add("hidden");
    return;
  }

  const item = drop.item;
  const r = RARITY[item.rarity];
  activeDropEl.className = "active-drop filled";
  activeDropEl.innerHTML = `
    <div class="drop-icon r-${r.cls}">&#128142;</div>
    <div class="drop-meta">
      <h3 class="r-${r.cls}">${escapeHtml(item.name)}</h3>
      <div class="drop-rarity r-${r.cls}">${r.label}</div>
      ${item.desc ? `<div class="drop-desc">${escapeHtml(item.desc)}</div>` : ""}
    </div>
  `;

  // Resolve bar visible only while the drop is unresolved
  if (state.lastResult && state.lastResult.dropId === drop.id) {
    resolveBar.classList.add("hidden");
  } else {
    resolveBar.classList.remove("hidden");
    renderTally();
  }
  renderResult();
}

function renderTally() {
  const counts = { need: 0, greed: 0, pass: 0, undecided: 0 };
  state.party.forEach((m) => {
    const c = state.activeDrop.choices[m.id];
    if (c) counts[c]++;
    else counts.undecided++;
  });
  voteTallyEl.innerHTML = `
    <span>Need <b>${counts.need}</b></span>
    <span>Greed <b>${counts.greed}</b></span>
    <span>Pass <b>${counts.pass}</b></span>
    <span class="muted">Undecided <b>${counts.undecided}</b></span>
  `;
}

function renderResult() {
  const res = state.lastResult;
  if (!res || !state.activeDrop || res.dropId !== state.activeDrop.id) {
    if (!res) resultBanner.classList.add("hidden");
    return;
  }
  resultBanner.classList.remove("hidden");
  const r = RARITY[res.rarity];

  let headline;
  if (res.winnerId) {
    headline = `<span class="r-${r.cls}">${escapeHtml(res.winnerName)}</span> wins
      <b class="r-${r.cls}">${escapeHtml(res.itemName)}</b>
      by <b>${res.winnerContext}</b> roll!`;
  } else {
    headline = `Everyone passed on <b class="r-${r.cls}">${escapeHtml(res.itemName)}</b>.
      It goes to the sharded pile (unclaimed).`;
  }

  const rollRows = res.rolls
    .map((rw) => {
      const win = rw.memberId === res.winnerId ? ` <span class="win-tag">&#9733; WIN</span>` : "";
      const choiceLabel = rw.choice.charAt(0).toUpperCase() + rw.choice.slice(1);
      const rollText = rw.choice === "pass" ? "passed" : `${choiceLabel} &mdash; rolled <b>${rw.roll}</b>`;
      return `<div class="roll-row">${escapeHtml(rw.name)}: ${rollText}${win}</div>`;
    })
    .join("");

  resultBanner.innerHTML = `
    <div class="winner-line">${headline}</div>
    <div class="roll-detail">${rollRows}</div>
  `;
}

function renderParty() {
  partyCount.textContent = `${state.party.length} member${state.party.length === 1 ? "" : "s"}`;
  partyGrid.innerHTML = "";

  state.party.forEach((m) => {
    const color = CLASSES[m.cls] || "#c8aa6e";
    const choice = state.activeDrop ? state.activeDrop.choices[m.id] : null;
    const resolved = state.lastResult && state.activeDrop && state.lastResult.dropId === state.activeDrop.id;
    const votingOpen = !!state.activeDrop && !resolved;

    const panel = document.createElement("div");
    panel.className = "member";
    panel.style.setProperty("--member-color", color);

    const initials = m.name.trim().slice(0, 2).toUpperCase() || "??";

    // roll line after resolve
    let rollLine = "";
    if (resolved) {
      const rw = state.lastResult.rolls.find((x) => x.memberId === m.id);
      if (rw) {
        if (rw.choice === "pass") rollLine = "Passed";
        else rollLine = `${cap(rw.choice)} roll: ${rw.roll}` + (rw.memberId === state.lastResult.winnerId ? ` <span class="win-tag">&#9733; WON</span>` : "");
      }
    }

    const myTasks = state.log.filter((t) => t.ownerId === m.id);

    panel.innerHTML = `
      <div class="member-head">
        <div class="member-avatar">${escapeHtml(initials)}</div>
        <div>
          <div class="member-name">${escapeHtml(m.name)}</div>
          <div class="member-class">${escapeHtml(m.cls)}</div>
        </div>
      </div>
      <div class="choice-row">
        <button class="choice-btn ${choice === "need" ? "active" : ""}" data-choice="need" data-member="${m.id}" ${votingOpen ? "" : "disabled"}>Need</button>
        <button class="choice-btn ${choice === "greed" ? "active" : ""}" data-choice="greed" data-member="${m.id}" ${votingOpen ? "" : "disabled"}>Greed</button>
        <button class="choice-btn ${choice === "pass" ? "active" : ""}" data-choice="pass" data-member="${m.id}" ${votingOpen ? "" : "disabled"}>Pass</button>
      </div>
      <div class="member-roll">${rollLine}</div>
      <div class="member-tasks">
        ${myTasks.map((t) => `
          <div class="mini-task ${t.done ? "done" : ""}">
            <input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""}/>
            <span>${escapeHtml(t.name)}</span>
          </div>`).join("")}
      </div>
    `;
    partyGrid.appendChild(panel);
  });
}

function renderLog() {
  const looted = state.log.filter((t) => !t.passedOver).length;
  const passed = state.log.length - looted;
  logCount.textContent =
    `${looted} item${looted === 1 ? "" : "s"} looted` + (passed ? `, ${passed} passed over` : "");
  lootLogList.innerHTML = "";
  if (state.log.length === 0) {
    lootLogList.innerHTML = `<li class="muted" style="justify-content:center;">No loot distributed yet.</li>`;
    return;
  }
  [...state.log].reverse().forEach((t) => {
    const r = RARITY[t.rarity];
    const li = document.createElement("li");
    if (t.passedOver) {
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
        <span class="log-owner">&#128100; ${escapeHtml(t.ownerName)}</span>`;
    }
    lootLogList.appendChild(li);
  });
}

/* ---------------- Core actions ---------------- */

/* ---------------- Boss encounter lifecycle ---------------- */

// Archive the active boss's identity + remediation plan so per-problem export
// survives pulling the next boss or ending the encounter.
function archiveBoss() {
  const boss = state.boss;
  if (!boss) return;
  if (!state.bossLog) state.bossLog = [];
  if (state.bossLog.some((b) => b.id === boss.id)) return;
  state.bossLog.push({
    id: boss.id,
    name: boss.name,
    desc: boss.desc || "",
    tier: boss.tier,
    slain: boss.slain,
    remediation: boss.remediation || [],
  });
}

function pullBoss(name, tier, desc) {
  archiveBoss();
  const t = BOSS_TIERS[tier] ? tier : "elite";
  const hpMax = BOSS_TIERS[t].hp;
  state.boss = {
    id: uid(),
    name: name.trim() || "Unnamed Problem",
    desc: (desc || "").trim(), // what the problem is / why it matters
    tier: t,
    hpMax,
    hp: hpMax,
    slain: false,
    remediation: [], // [{ id, name, rarity, desc }] — the fix plan, authored live
  };
  state.activeDrop = null;
  state.lastResult = null;
  render();
}

/**
 * Author a remediation step for the active boss and drop it on the table in a
 * single action. The step is recorded on the boss's remediation plan (so the
 * encounter owns its fix list) and becomes the active drop for Need/Greed/Pass.
 * This is the primary way to attack a boss: turn discussion into an owned fix.
 */
function dropRemediationStep(name, rarity, desc) {
  const boss = state.boss;
  if (!boss || boss.slain) return;
  if (!name.trim()) return;
  const step = {
    id: uid(),
    name: name.trim(),
    rarity: RARITY[rarity] ? rarity : "uncommon",
    desc: (desc || "").trim(),
  };
  if (!Array.isArray(boss.remediation)) boss.remediation = []; // guard old saved state
  boss.remediation.push(step);
  // Also add it to the backlog (loot table) so it's reusable and visible there.
  state.lootTable.push({ id: step.id, name: step.name, rarity: step.rarity, desc: step.desc });
  dropItem(step);
}

function endBoss() {
  archiveBoss();
  state.boss = null;
  state.activeDrop = null;
  state.lastResult = null;
  render();
}

// Damage the active boss after a drop resolves. Won drops hit full; passes chip.
function damageBoss(amount) {
  const boss = state.boss;
  if (!boss || boss.slain) return;
  boss.hp = Math.max(0, boss.hp - amount);
  // flash the health bar
  bossEl.classList.remove("hit");
  void bossEl.offsetWidth; // reflow so the animation can replay
  bossEl.classList.add("hit");
  if (boss.hp <= 0) {
    boss.slain = true;
    showBossToast(boss);
  }
}

function dropItem(item) {
  if (!state.boss || state.boss.slain) return; // must have a live boss to attack
  state.activeDrop = {
    id: uid(),
    item: { ...item },
    choices: {},
  };
  state.lastResult = null;
  render();
}

function dropRandom() {
  if (state.lootTable.length === 0) {
    openModal("#modal-config");
    return;
  }
  const item = state.lootTable[Math.floor(Math.random() * state.lootTable.length)];
  dropItem(item);
}

function setChoice(memberId, choice) {
  if (!state.activeDrop) return;
  if (state.lastResult && state.lastResult.dropId === state.activeDrop.id) return; // already resolved
  const current = state.activeDrop.choices[memberId];
  // clicking the same choice again clears it (undecided)
  state.activeDrop.choices[memberId] = current === choice ? undefined : choice;
  if (state.activeDrop.choices[memberId] === undefined) delete state.activeDrop.choices[memberId];
  render();
}

/**
 * Resolve Need/Greed/Pass per WoW group loot rules:
 *  - If any Need, only Needers roll; highest wins.
 *  - Else if any Greed, only Greeders roll; highest wins.
 *  - Else unclaimed.
 *  - Ties on the top roll re-roll amongst the tied players only.
 */
function resolveDrop() {
  const drop = state.activeDrop;
  if (!drop) return;

  const rolls = state.party.map((m) => ({
    memberId: m.id,
    name: m.name,
    choice: drop.choices[m.id] || "pass",
    roll: null,
  }));

  const needers = rolls.filter((r) => r.choice === "need");
  const greeders = rolls.filter((r) => r.choice === "greed");

  let contenders = [];
  let winnerContext = "";
  if (needers.length > 0) {
    contenders = needers;
    winnerContext = "Need";
  } else if (greeders.length > 0) {
    contenders = greeders;
    winnerContext = "Greed";
  }

  let winner = null;
  if (contenders.length > 0) {
    // assign rolls
    contenders.forEach((c) => (c.roll = rollD(100)));
    winner = breakTies(contenders);
  }

  state.lastResult = {
    dropId: drop.id,
    itemName: drop.item.name,
    rarity: drop.item.rarity,
    rolls,
    winnerId: winner ? winner.memberId : null,
    winnerName: winner ? winner.name : null,
    winnerContext,
  };

  // Record the task if someone won it; otherwise log it as passed over.
  if (winner) {
    state.log.push({
      id: uid(),
      name: drop.item.name,
      rarity: drop.item.rarity,
      ownerId: winner.memberId,
      ownerName: winner.name,
      bossId: state.boss ? state.boss.id : null,
      stepId: drop.item.id || null, // ties an owned task back to its remediation step
      passedOver: false,
      done: false,
    });
    showLootToast(drop.item.name, drop.item.rarity, winner.name);
  } else {
    // Nobody wanted it: keep a trace in the register that it was dropped on.
    state.log.push({
      id: uid(),
      name: drop.item.name,
      rarity: drop.item.rarity,
      ownerId: null,
      ownerName: "",
      bossId: state.boss ? state.boss.id : null,
      stepId: drop.item.id || null,
      passedOver: true,
      done: false,
    });
  }

  // Damage the boss: a won drop lands a full hit, an all-pass only chips away.
  damageBoss(winner ? DMG_LOOTED : DMG_UNCLAIMED);

  render();
}

/* ---------------- Loot toast (WoW-style popup) ---------------- */

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
    </div>
  `;
  stack.appendChild(toast);

  // auto-dismiss (legendary lingers a little longer)
  const life = rarity === "legendary" ? 6500 : 5000;
  const remove = () => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    // fallback in case animationend doesn't fire
    setTimeout(() => toast.remove(), 500);
  };
  const timer = setTimeout(remove, life);

  // click to dismiss early
  toast.style.pointerEvents = "auto";
  toast.style.cursor = "pointer";
  toast.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

// A victory toast when a boss (topic) is fully defeated.
function showBossToast(boss) {
  const stack = $("#toast-stack");
  if (!stack) return;
  const tier = BOSS_TIERS[boss.tier] || BOSS_TIERS.elite;
  const looted = countBossLoot(boss.id);
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
    </div>
  `;
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

function rollD(max) {
  return Math.floor(Math.random() * max) + 1;
}

// Highest roll wins; re-roll only the tied top players until broken.
function breakTies(contenders) {
  let pool = contenders.slice();
  let guard = 0;
  while (guard++ < 50) {
    const top = Math.max(...pool.map((c) => c.roll));
    const tied = pool.filter((c) => c.roll === top);
    if (tied.length === 1) {
      return tied[0];
    }
    // re-roll tied players (and show the new roll value)
    tied.forEach((c) => (c.roll = rollD(100)));
    pool = tied;
  }
  return pool[0];
}

function toggleTask(taskId) {
  const t = state.log.find((x) => x.id === taskId);
  if (t) {
    t.done = !t.done;
    render();
  }
}

/* ---------------- Loot table & roster management ---------------- */

function addLoot(name, rarity, desc) {
  if (!name.trim()) return;
  state.lootTable.push({ id: uid(), name: name.trim(), rarity, desc: desc.trim() });
  save();
  renderLootTableModal();
}
function removeLoot(id) {
  state.lootTable = state.lootTable.filter((l) => l.id !== id);
  save();
  renderLootTableModal();
}

function addMember(name, cls) {
  if (!name.trim()) return;
  state.party.push({ id: uid(), name: name.trim(), cls });
  render();
  renderRosterModal();
}
function removeMember(id) {
  state.party = state.party.filter((m) => m.id !== id);
  if (state.activeDrop) delete state.activeDrop.choices[id];
  render();
  renderRosterModal();
}

/* ---------------- Modals ---------------- */

function openModal(sel) {
  if (sel === "#modal-config") renderLootTableModal();
  if (sel === "#modal-roster") renderRosterModal();
  if (sel === "#modal-manual") renderManualDropModal();
  $(sel).classList.remove("hidden");
}
function closeModals() {
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
}

function renderLootTableModal() {
  const list = $("#loot-table-list");
  list.innerHTML = "";
  if (state.lootTable.length === 0) {
    list.innerHTML = `<li class="muted" style="justify-content:center;">No loot defined yet.</li>`;
  }
  state.lootTable.forEach((l) => {
    const r = RARITY[l.rarity];
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="log-rarity-dot bg-${r.cls}"></span>
      <span class="li-name r-${r.cls}">${escapeHtml(l.name)}</span>
      <span class="li-sub">${r.label}${l.desc ? " &middot; " + escapeHtml(l.desc) : ""}</span>
      <button class="li-remove" data-remove-loot="${l.id}" title="Remove">&times;</button>
    `;
    list.appendChild(li);
  });
}

function renderRosterModal() {
  const list = $("#roster-list");
  list.innerHTML = "";
  if (state.party.length === 0) {
    list.innerHTML = `<li class="muted" style="justify-content:center;">No party members yet.</li>`;
  }
  state.party.forEach((m) => {
    const color = CLASSES[m.cls] || "#c8aa6e";
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="log-rarity-dot" style="background:${color}"></span>
      <span class="li-name">${escapeHtml(m.name)}</span>
      <span class="li-sub">${escapeHtml(m.cls)}</span>
      <button class="li-remove" data-remove-member="${m.id}" title="Remove">&times;</button>
    `;
    list.appendChild(li);
  });

  // populate class dropdown once
  const sel = $("#member-class");
  if (sel.options.length === 0) {
    Object.keys(CLASSES).forEach((c) => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    });
  }
}

function renderManualDropModal() {
  const list = $("#manual-drop-list");
  list.innerHTML = "";
  if (state.lootTable.length === 0) {
    list.innerHTML = `<li class="muted" style="justify-content:center;">Add items to the loot table first.</li>`;
    return;
  }
  state.lootTable.forEach((l) => {
    const r = RARITY[l.rarity];
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="log-rarity-dot bg-${r.cls}"></span>
      <span class="li-name r-${r.cls}">${escapeHtml(l.name)}</span>
      <span class="li-sub">${r.label}</span>
      <button class="btn btn-gold li-drop" data-drop-loot="${l.id}">Drop</button>
    `;
    list.appendChild(li);
  });
}

/* ---------------- Export ---------------- */

// Build a markdown report grouped by problem (boss). Each problem lists its
// remediation plan: owned steps become checklist items with an owner, and
// steps nobody owned are noted as unowned proposals.
function buildExport() {
  // every boss we know about: archived ones plus the current one
  const bosses = [...(state.bossLog || [])];
  if (state.boss && !bosses.some((b) => b.id === state.boss.id)) {
    bosses.push({
      id: state.boss.id,
      name: state.boss.name,
      desc: state.boss.desc || "",
      tier: state.boss.tier,
      slain: state.boss.slain,
      remediation: state.boss.remediation || [],
    });
  }

  const tierLabel = (t) => (BOSS_TIERS[t] ? BOSS_TIERS[t].label : "Elite");
  const ownedFor = (stepId) => state.log.find((t) => t.stepId === stepId && !t.passedOver);

  const sections = bosses.map((b) => {
    const header = `## ${b.name} — ${tierLabel(b.tier)}${b.slain ? " ✓ addressed" : ""}`;
    const descLine = b.desc ? `\n_${b.desc}_\n` : "";
    const steps = b.remediation || [];
    if (steps.length === 0) {
      return `${header}${descLine}\n_No remediation steps proposed._`;
    }
    const lines = steps.map((s) => {
      const owned = ownedFor(s.id);
      const rarity = RARITY[s.rarity] ? RARITY[s.rarity].label : "Uncommon";
      if (owned) {
        return `${owned.done ? "[x]" : "[ ]"} ${s.name} — ${rarity} — owner: ${owned.ownerName}`;
      }
      return `[ ] ${s.name} — ${rarity} — _(proposed, unowned)_`;
    });
    return `${header}${descLine}\n${lines.join("\n")}`;
  });

  // any looted tasks not tied to a known problem/step (e.g. backlog drops) go
  // last; passed-over items are not actionable tasks, so exclude them
  const orphans = state.log.filter((t) => {
    if (t.passedOver) return false;
    if (!t.stepId) return true;
    return !bosses.some((b) => (b.remediation || []).some((s) => s.id === t.stepId));
  });
  if (orphans.length) {
    const lines = orphans.map((t) =>
      `${t.done ? "[x]" : "[ ]"} ${t.name} — ${RARITY[t.rarity].label} — owner: ${t.ownerName}`
    );
    sections.push(`## Other looted items\n\n${lines.join("\n")}`);
  }

  return `# Retro Remediation Plan\n\n${sections.join("\n\n")}\n`;
}

function exportTasks() {
  if (state.log.length === 0) {
    alert("No looted tasks to export yet.");
    return;
  }
  const text = buildExport();
  navigator.clipboard?.writeText(text).then(
    () => alert("Tasks copied to clipboard!\n\n" + text),
    () => downloadText("retro-loot-tasks.md", text)
  ) || downloadText("retro-loot-tasks.md", text);
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- Helpers ---------------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------------- Event wiring ---------------- */

$("#btn-pull-boss").addEventListener("click", () => openModal("#modal-boss"));
$("#btn-confirm-boss").addEventListener("click", () => {
  pullBoss($("#boss-name").value, $("#boss-tier").value, $("#boss-desc").value);
  $("#boss-name").value = "";
  $("#boss-desc").value = "";
  closeModals();
});
$("#btn-end-boss").addEventListener("click", () => {
  if (!state.boss) return;
  const done = state.boss.slain;
  if (done || confirm("End this encounter? The boss isn't defeated yet — any undistributed drop will be cleared.")) {
    endBoss();
  }
});
$("#btn-drop-random").addEventListener("click", dropRandom);
$("#btn-drop-manual").addEventListener("click", () => openModal("#modal-manual"));
$("#btn-drop-step").addEventListener("click", () => {
  dropRemediationStep($("#rc-name").value, $("#rc-rarity").value, $("#rc-desc").value);
  $("#rc-name").value = "";
  $("#rc-desc").value = "";
});
$("#rc-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-drop-step").click(); });
$("#rc-desc").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-drop-step").click(); });
$("#btn-resolve").addEventListener("click", resolveDrop);
$("#btn-config").addEventListener("click", () => openModal("#modal-config"));
$("#btn-roster").addEventListener("click", () => openModal("#modal-roster"));
$("#btn-export").addEventListener("click", exportTasks);

$("#btn-reset").addEventListener("click", () => {
  if (confirm("Reset everything — loot table, party, and loot log — to defaults?")) {
    state = defaultState();
    render();
  }
});

$("#btn-add-loot").addEventListener("click", () => {
  addLoot($("#loot-name").value, $("#loot-rarity").value, $("#loot-desc").value);
  $("#loot-name").value = "";
  $("#loot-desc").value = "";
});

$("#btn-add-member").addEventListener("click", () => {
  addMember($("#member-name").value, $("#member-class").value);
  $("#member-name").value = "";
});

// Delegated clicks
document.addEventListener("click", (e) => {
  const t = e.target;

  if (t.matches("[data-close]")) { closeModals(); return; }
  if (t.classList.contains("modal")) { closeModals(); return; } // backdrop click

  if (t.matches("[data-choice]")) {
    setChoice(t.getAttribute("data-member"), t.getAttribute("data-choice"));
    return;
  }
  if (t.matches("[data-remove-loot]")) { removeLoot(t.getAttribute("data-remove-loot")); return; }
  if (t.matches("[data-remove-member]")) { removeMember(t.getAttribute("data-remove-member")); return; }
  if (t.matches("[data-drop-loot]")) {
    const item = state.lootTable.find((l) => l.id === t.getAttribute("data-drop-loot"));
    if (item) { dropItem(item); closeModals(); }
    return;
  }
});

// Checkbox changes (task done toggles)
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.matches("[data-task]")) toggleTask(t.getAttribute("data-task"));
});

// Enter key to add in forms
$("#loot-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-add-loot").click(); });
$("#loot-desc").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-add-loot").click(); });
$("#member-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-add-member").click(); });
$("#boss-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-confirm-boss").click(); });

/* ---------------- Boot ---------------- */
render();
