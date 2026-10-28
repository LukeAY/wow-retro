/* =========================================================================
 * Loot Council — icon set
 * Low-fi 24x24 line-art SVGs drawn in currentColor, shared by both pages.
 * Load before app.js / net-client.js. Static markup can use
 * <span data-icon="name"></span>, which is filled in on load.
 * ========================================================================= */

const ICON_PATHS = {
  swords:  `<path d="M3 3l2.5.5L16 14l-2 2L3.5 5.5zM21 3l-2.5.5L8 14l2 2 10.5-10.5z"/><path d="M12.5 17.5l5-5M15.5 15.5 19 19M6.5 12.5l5 5M8.5 15.5 5 19"/><circle cx="20" cy="20" r="1"/><circle cx="4" cy="20" r="1"/>`,
  skull:   `<path d="M5 11a7 7 0 0 1 14 0v3l-2 1.5V19H7v-3.5L5 14z"/><circle cx="9.3" cy="11.3" r="1.6" fill="currentColor"/><circle cx="14.7" cy="11.3" r="1.6" fill="currentColor"/><path d="M12 14l-1 1.8h2zM10 19v-2M14 19v-2"/>`,
  gem:     `<path d="M7 3h10l4 6-9 12L3 9z"/><path d="M3 9h18M12 21 8.5 9 12 3l3.5 6z"/>`,
  shield:  `<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z"/><path d="M12 6v12M7.5 10h9"/>`,
  person:  `<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.5 3.5-7 8-7s8 2.5 8 7"/>`,
  warning: `<path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17h.01"/>`,
  lootbag: `<path d="M8.5 8.5C5 11 3.5 14.5 3.5 17c0 2.5 1.8 4 4.5 4h8c2.7 0 4.5-1.5 4.5-4 0-2.5-1.5-6-5-8.5z"/><path d="M8.5 8.5 7 4.5c1.8-.8 3.2.4 5 .4s3.2-1.2 5-.4l-1.5 4"/><path d="M8.5 8.5h7"/><circle cx="12" cy="15" r="2.3"/>`,
};

// Race portraits, used for party avatars and the race picker.
const RACE_ICON_PATHS = {
  "Human":      `<circle cx="12" cy="13" r="6"/><path d="M6 12c0-4 2.5-6.5 6-6.5s6 2.5 6 6.5c-2-1.5-4-2-6-2s-4 .5-6 2z"/><path d="M10 14h.01M14 14h.01"/>`,
  "Dwarf":      `<path d="M6.5 10a5.5 5.5 0 0 1 11 0z"/><path d="M12 10v3M10 12h.01M14 12h.01"/><path d="M7 11v4c0 4 2.5 7 5 7s5-3 5-7v-4"/><path d="M10 16v3M14 16v3"/>`,
  "Night Elf":  `<ellipse cx="12" cy="13" rx="4.5" ry="6"/><path d="M7.6 12 2 5l5.8 5.2M16.4 12 22 5l-5.8 5.2"/><path d="M9.5 13l1.5.5M14.5 13l-1.5.5"/>`,
  "Gnome":      `<circle cx="12" cy="13" r="7"/><circle cx="9.5" cy="11" r="2"/><circle cx="14.5" cy="11" r="2"/><path d="M5 11h2.5M16.5 11H19M9 16q3 2 6 0M9 6l1-2.5 1.5 2 1.5-2.5 1 2.5"/>`,
  "High Order": `<circle cx="12" cy="13" r="5"/><ellipse cx="12" cy="5" rx="4" ry="1.3"/><path d="M7 12C3 11 2 8 2 6c2 2 4 2.5 5.5 4M17 12c4-1 5-4 5-6-2 2-4 2.5-5.5 4"/><path d="M10 13h.01M14 13h.01"/>`,
  "Orc":        `<path d="M6 9c0-3 3-5 6-5s6 2 6 5v5c0 4-3 7-6 7s-6-3-6-7z"/><path d="M12 4V2M8 10.5l3 1M16 10.5l-3 1M9 18l-.5-3M15 18l.5-3"/>`,
  "Tauren":     `<path d="M7 8C4 8 2 6.5 2 3.5c1.5 1.5 3 2 5.5 2.5M17 8c3 0 5-1.5 5-4.5-1.5 1.5-3 2-5.5 2.5"/><path d="M7 7h10v6c0 3-2 4-2 7H9c0-3-2-4-2-7z"/><circle cx="12" cy="20.5" r="1.2"/><path d="M10 11h.01M14 11h.01M11 16h.01M13 16h.01"/>`,
  "Troll":      `<ellipse cx="12" cy="13" rx="5" ry="6"/><path d="M10 7c0-2 1-4.5 2-4.5s2 2.5 2 4.5"/><path d="M7.2 11 1 9l6.3 4M16.8 11 23 9l-6.3 4"/><path d="M9.5 17.5c-1.5-.5-2.5-2-2.5-3.5M14.5 17.5c1.5-.5 2.5-2 2.5-3.5M10 12h.01M14 12h.01"/>`,
  "Undead":     `<path d="M6 11a6 6 0 0 1 12 0v3l-2 1v3H8v-3l-2-1z"/><circle cx="9.5" cy="11.5" r="1.5" fill="currentColor"/><circle cx="14.5" cy="11.5" r="1.5" fill="currentColor"/><path d="M12 13.5l-.8 1.5h1.6zM10 18v-2M12 18v-2M14 18v-2M8 18v2.5h8V18"/>`,
  "Windshaper": `<circle cx="12" cy="13" r="5"/><path d="M9 8C8 5.5 8.5 3.5 10 2M12 8V2.5M15 8c1-2.5.5-4.5-1-6"/><path d="M1.5 12h3c1.5 0 1.5-2 0-2M1.5 15.5h3.5c1.5 0 1.5 2 0 2M22.5 14H19"/><path d="M10 13h.01M14 13h.01"/>`,
};

function svgIcon(cls, paths) {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Inline UI icon, sized to the surrounding text.
function icon(name) {
  return ICON_PATHS[name] ? svgIcon("ui-icon", ICON_PATHS[name]) : "";
}

// A player's bags: `max` slots, filled left to right with their open tasks.
// Each filled slot shows a loot bag in the task's rarity colour. Slots for
// tasks this page hasn't shown before get a one-off "picked up" pop.
const seenBagTasks = new Set();
function bagSlots(tasks, max) {
  const full = tasks.length >= max;
  let html = "";
  for (let i = 0; i < max; i++) {
    const t = tasks[i];
    if (!t) { html += `<span class="bag-slot"></span>`; continue; }
    const fresh = !seenBagTasks.has(t.id);
    seenBagTasks.add(t.id);
    html += `<span class="bag-slot filled r-${t.rarity}${fresh ? " fresh" : ""}" title="${escapeHtml(t.name)}">${svgIcon("bag-icon", ICON_PATHS.lootbag)}</span>`;
  }
  return `<div class="bag-slots${full ? " full" : ""}" aria-label="Bags ${tasks.length} of ${max}${full ? ", full" : ""}">${html}</div>`;
}

function raceIcon(race) {
  return RACE_ICON_PATHS[race] ? svgIcon("race-icon", RACE_ICON_PATHS[race]) : "";
}

document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
