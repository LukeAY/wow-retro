/* =========================================================================
 * Loot Council — icon set
 * Low-fi 24x24 line-art SVGs drawn in currentColor (an ES module).
 * Static markup can use <span data-icon="name"></span>, which is filled in
 * when this module loads. Icons are decorative (aria-hidden); whatever they
 * mean is always given in text alongside them.
 * ========================================================================= */

export const ICON_PATHS = {
  swords:  `<path d="M3 3l2.5.5L16 14l-2 2L3.5 5.5zM21 3l-2.5.5L8 14l2 2 10.5-10.5z"/><path d="M12.5 17.5l5-5M15.5 15.5 19 19M6.5 12.5l5 5M8.5 15.5 5 19"/><circle cx="20" cy="20" r="1"/><circle cx="4" cy="20" r="1"/>`,
  skull:   `<path d="M5 11a7 7 0 0 1 14 0v3l-2 1.5V19H7v-3.5L5 14z"/><circle cx="9.3" cy="11.3" r="1.6" fill="currentColor"/><circle cx="14.7" cy="11.3" r="1.6" fill="currentColor"/><path d="M12 14l-1 1.8h2zM10 19v-2M14 19v-2"/>`,
  gem:     `<path d="M7 3h10l4 6-9 12L3 9z"/><path d="M3 9h18M12 21 8.5 9 12 3l3.5 6z"/>`,
  shield:  `<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z"/><path d="M12 6v12M7.5 10h9"/>`,
  person:  `<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.5 3.5-7 8-7s8 2.5 8 7"/>`,
  warning: `<path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17h.01"/>`,
  trophy:  `<path d="M7.5 3.5h9v5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 5H4.5c0 3 1.3 4.5 3.3 4.8M16.5 5h3c0 3-1.3 4.5-3.3 4.8M12 13v3.5M8.5 20.5h7M9.5 20.5l.5-4h4l.5 4"/>`,
  hourglass: `<path d="M6.5 3h11M6.5 21h11M7.5 3c0 4.5 4.5 6 4.5 9s-4.5 4.5-4.5 9M16.5 3c0 4.5-4.5 6-4.5 9s4.5 4.5 4.5 9"/><path d="M9.5 18.5h5" />`,
  flag:    `<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>`,
  crown:   `<path d="M3.5 8.5 8 12l4-6.5 4 6.5 4.5-3.5-1.8 9.5H5.3z" fill="currentColor" fill-opacity=".25"/><path d="M5.3 20.5h13.4"/><circle cx="3.5" cy="8.5" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="20.5" cy="8.5" r="1"/>`,
  lootbag: `<path d="M8.5 8.5C5 11 3.5 14.5 3.5 17c0 2.5 1.8 4 4.5 4h8c2.7 0 4.5-1.5 4.5-4 0-2.5-1.5-6-5-8.5z"/><path d="M8.5 8.5 7 4.5c1.8-.8 3.2.4 5 .4s3.2-1.2 5-.4l-1.5 4"/><path d="M8.5 8.5h7"/><circle cx="12" cy="15" r="2.3"/>`,
  check:   `<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>`,
  info:    `<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".6" fill="currentColor"/>`,
  menu:    `<path d="M4 6.5h16M4 12h16M4 17.5h16"/>`,
  link:    `<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>`,
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

// Class emblems for the class picker (classes in the Forever race matrix).
const CLASS_ICON_PATHS = {
  "Warrior": `<path d="M12 2.5 13.6 5v9.5h-3.2V5z"/><path d="M7 14.5h10M12 14.5V20"/><circle cx="12" cy="21" r="1"/>`,
  "Paladin": `<rect x="4.5" y="3" width="15" height="6.5" rx="1"/><path d="M12 9.5V21M9.5 21h5M12 4.5v3.5M10.2 6.2h3.6"/>`,
  "Hunter":  `<path d="M7 3c7.5 4 7.5 14 0 18"/><path d="M7 3v18"/><path d="M3 12h16M16.5 9.5 19 12l-2.5 2.5M3 10.5 4.5 12 3 13.5"/>`,
  "Rogue":   `<path d="M20 4 18.3 9.3 12.3 15.3 8.7 11.7 14.7 5.7z"/><path d="M7.3 10.3l6.4 6.4M10 15l-5 5"/><circle cx="4.3" cy="20.3" r="1.1"/>`,
  "Priest":  `<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>`,
  "Shaman":  `<path d="M13.5 2 5 13.5h6L9.5 22 19 9.5h-6.5z"/>`,
  "Mage":    `<circle cx="15.5" cy="7.5" r="3.5"/><path d="M13 10 4.5 21"/><path d="M20 2.5v2.5M21.3 3.8h-2.6M5 5.5v2M6 6.5H4M20.5 14v2M21.5 15h-2"/>`,
  "Warlock": `<path d="M12 2.5c.5 3.5 6 6 6 11.5a6 6 0 0 1-12 0c0-3 1.7-4.5 2-7 1.3 1.2 2 2.6 2 4.5 1-2.4 2-5 2-9z"/><path d="M12 20a2.5 2.5 0 0 1-2.5-2.5c0-1.6 1.5-2.5 2.5-4.5 1 2 2.5 2.9 2.5 4.5A2.5 2.5 0 0 1 12 20z"/>`,
  "Druid":   `<path d="M5 19C5 10 11 4 20 4c0 9-6 15-15 15z"/><path d="M5 19 15 9M10 14h4M12 12V8.5"/>`,
};

// Original faction emblems: a crowned shield and a tusked, spiked crest.
const FACTION_ICON_PATHS = {
  Alliance: `<path d="M12 3.5 4.5 6.5V12c0 4.8 3.3 7.8 7.5 9.5 4.2-1.7 7.5-4.7 7.5-9.5V6.5z"/><path d="M8 10.5l1.8 1.8L12 9l2.2 3.3 1.8-1.8-.8 4.5H8.8z"/>`,
  Horde:    `<path d="M3.5 4 8 6.5l4-3.5 4 3.5L20.5 4 19 13c-.8 4.3-3.6 7-7 8.5-3.4-1.5-6.2-4.2-7-8.5z"/><path d="M8.5 11h7M9.3 11l1.2 4.5M14.7 11l-1.2 4.5"/>`,
};

export function svgIcon(cls, paths) {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Inline UI icon, sized to the surrounding text.
export function icon(name) {
  return ICON_PATHS[name] ? svgIcon("ui-icon", ICON_PATHS[name]) : "";
}

export function classIcon(cls) {
  return CLASS_ICON_PATHS[cls] ? svgIcon("class-icon", CLASS_ICON_PATHS[cls]) : "";
}

export function factionIcon(faction, cls = "ui-icon") {
  return FACTION_ICON_PATHS[faction] ? svgIcon(cls, FACTION_ICON_PATHS[faction]) : "";
}

export function raceIcon(race) {
  return RACE_ICON_PATHS[race] ? svgIcon("race-icon", RACE_ICON_PATHS[race]) : "";
}

document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
