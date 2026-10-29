# Loot Council — WoW-themed Retro

A World of Warcraft themed retro tool. A session runs like a dungeon:

1. **Achievements** — celebrate what went well, and rally behind each other's wins.
2. **Scouting** — everyone adds the topics they want to discuss to a shared **Mob List**.
3. **Threat Voting** — everyone spreads threat across the topics, in secret.
4. **Boss Encounters** — the most threatening topics become bosses. You fight
   each one by proposing **tactics** (loot), rallying behind the best ones and
   distributing them with WoW **Need / Greed / Pass** rules. Won tactics become
   tasks with an owner.

At the end, the **Loot Ledger** exports the whole session as a markdown
action plan.

## Running it

```bash
npm install
npm start
```

Then open:

- **Online mode** (everyone on their own laptop): `http://localhost:3000/net.html`
- **Local mode** (one shared screen): `http://localhost:3000/` or `/index.html`

During development, `npm run dev` restarts the server whenever you edit it.

Both modes need to be served (by `npm start` or any static web server). Opening
`index.html` straight from disk no longer works, because the game rules are
shared ES modules and browsers don't load modules from `file://`.

### Tests

```bash
npm test
```

Uses Node's built-in test runner (no extra dependencies). `test/rules.test.js`
covers the rules: roll resolution and ties, boss HP and tier bands,
achievement and tactic rally thresholds, threat ballots, and bag size for
different party sizes.
`test/engine.test.js` covers whole flows: achievement and tactic rallies,
merges, secret ballots, pull order, the facilitator's rarity override, Call it,
enrage timers, who counts towards bag size, bags shrinking below what someone
holds, and migrating old saved rooms.

## Online mode

1. One person clicks **Create a Room** and becomes the **facilitator** (host).
   They choose whether to **save the room** (see below), and get a 4-letter code.
2. Everyone else joins with the code and creates a character: a character
   name, their **real name** (who's accountable for loot they win), then a
   faction, a race from that faction and a class that race can be.
3. The facilitator moves the session through its phases with the bar at the
   top of the screen. Everyone sees the current phase.

### Saved and unsaved rooms

When creating a room, the facilitator chooses whether to save it. **The default
is not to save.**

- **Unsaved rooms** live in the server's memory only. Nothing is written to
  disk, and the room is gone if the server restarts.
- **Saved rooms** are written to `server/data/rooms.json` (debounced on every
  change) and reload after a restart. Everyone rejoins with the same code and
  reclaims their character; the first person back becomes the facilitator.

The top bar shows **Saved room** or **Not saved**. Abandoned rooms (empty for
24 hours) are pruned either way.

### Playing with remote teammates

The server listens on your LAN, so people on the same network can use your
machine's IP (e.g. `http://192.168.1.42:3000/net.html`). For remote folks,
expose it with a tunnel such as `npx ngrok http 3000`; the client switches to
`wss` automatically over HTTPS.

The server only serves the client files (the pages, scripts, styles, fonts
and `shared/`). Saved rooms, the server code and everything else in the repo
stay private.

### Managing players

The **Party** dialog (facilitator only) can add a proxy slot for someone who
isn't online, **Kick** a player (their slot stays open to reclaim, and stops
counting towards [bag size](#bag-size)), **Make host** to hand over the
facilitator role, or remove a slot. If the facilitator
closes their tab, the next connected person is promoted. The host has a crown
on their panel, and your own character has a star.

If you drop out (a closed tab, a refresh, a flaky connection), your panel shows
**Away** and you keep your place in the party. The character screen lists
characters nobody is playing under **Returning? Reclaim your character**; click
yours to carry on with your loot intact. **Leave Group** gives your slot up
instead.

## Local mode

Local mode runs the **same page and the same game engine** in the browser, for
a team around one screen. The facilitator adds each person with **Acting as →
Add a party member**, then uses **Acting as** to post achievements, rally and
vote as each person.

- **Threat ballots stay private** by passing the screen around: each person
  selects their name, opens their ballot, votes, then hides it again.
- **Need / Greed / Pass** buttons appear on every party panel.
- There are no tactic rallies (nobody else is at their own screen to rally),
  so whoever proposes a tactic picks its rarity instead.
- The session lives in `sessionStorage` by default, so it's cleared when the
  tab closes. Tick **Keep after the tab closes** to keep it in `localStorage`
  instead. **Disband Group** wipes it.

A session saved by the old local mode is migrated automatically.

## 1. Achievements

Anyone can post an achievement (a short title and an optional detail). It
appears on everyone's board and fires an **Achievement Earned** toast.

- Exact duplicate titles are refused. Instead of duplicating, **Rally** behind
  someone else's achievement. You can't rally your own, and you can un-rally
  while the phase is open.
- Rallies raise an achievement's **rarity**. It starts at **Rare**, becomes
  **Epic** when 40% of the other party members have rallied, and **Legendary**
  at 75%. Rarity drops again if people un-rally. When an achievement upgrades,
  everyone gets an "Achievement upgraded to Epic!" toast.
- The board never shows rally counts or who rallied, only the rarity. The
  Loot Ledger lists who rallied.
- The facilitator can **merge** near-duplicates: posters and ralliers combine
  and rarity is recalculated.

## 2. Scouting

Everyone adds topics (a name and an optional description) to the shared
**Mob List**. The list updates live, and exact duplicates are refused. You can
keep adding topics later from the **Mob List** button, but anything added
after threat is revealed has no threat, so it isn't pulled automatically.

## 3. Threat Voting

Each player has **3 threat** to spread across the topics, and can stack it all
on one. Votes stay hidden (others only see that you've voted) until the
facilitator clicks **Reveal Threat**, which shows each topic's total. The
server rejects ballots that go over budget or name unknown topics. The
facilitator can reopen voting, and moving on to Boss Encounters reveals threat
automatically.

## 4. Boss encounters

**Pull a Boss** takes the topic with the **highest threat** first (ties are
broken at random). Topics with **no threat are skipped**; the facilitator can
still pull any topic by hand from the Mob List.

Boss HP slides with threat: **HP = 60 + (votes / top votes) × 440**, rounded.
So the most threatening topic always has 500 HP. The tier is a label derived
from HP:

| Tier | HP |
| --- | --- |
| Normal | under 200 |
| Elite | 200–379 |
| Raid Boss | 380 and up |

During the fight:

1. **Anyone proposes tactics** (a name and an optional detail). They join the
   boss's tactics, starting at **Common**.
2. **The rest of the party rallies** behind the tactics they back, the same
   way as achievements: you can't rally your own, and you can un-rally.
   Rarity rises with the share of the *other* party members who rallied:

   | Share rallied | 20% | 40% | 60% | 80% |
   | --- | --- | --- | --- | --- |
   | Rarity | Uncommon | Rare | Epic | Legendary |

   The board shows only the rarity, never how many rallied or who. In small
   parties some rarities get skipped: with 3 others, one rally is 33%
   (Uncommon), two are 67% (Epic) and three are Legendary.
3. **The facilitator checks each tactic's rarity** before dropping it, and can
   override it. That's the only way a tactic becomes **Poor**. An override
   sticks even if more people rally, until the facilitator picks **Rallies
   decide** again. The log and ledger record what rallies had made it
   ("Rare (changed from Uncommon)").
4. **Drop** puts a tactic on the table, which locks its rarity, and everyone
   picks Need / Greed / Pass. **Roll & Resolve** rolls and reveals. Tactics
   someone owns damage the boss by their rarity; tactics everyone passes on
   deal no damage.

Tactics in rooms saved before rallies existed keep the rarity they were
proposed with; the facilitator can still override it.

| Rarity | Poor | Common | Uncommon | Rare | Epic | Legendary |
| --- | --- | --- | --- | --- | --- | --- |
| Damage | 15 | 30 | 50 | 80 | 120 | 200 |

An encounter ends one of three ways:

- **Slain** — its HP reaches zero.
- **Retreated** — the facilitator clicks **Call It** when the room agrees the
  problem is covered (not available mid-vote).
- **Enraged** — an optional **enrage timer** runs out. If a vote is in
  progress, the boss enrages once that drop is resolved, so no votes are lost.

Then **Clear Stage** or pull the next boss. The optional **loot table** is a
backlog you can drop items from with **Drop from Backlog** / **Pick from
Backlog**; items someone already owns aren't offered again.

### Loot rules (Need / Greed / Pass)

- If anyone Needs, only Needers roll 1–100; highest wins.
- If nobody Needs, Greeders roll instead.
- If everyone passes, the item is recorded as **passed over** (no owner, not a task).
- Ties on the top roll re-roll only the tied players.
- **Bags** limit how many open tasks each player can own (see below). With
  full bags you can only Pass, and anyone full at resolve time counts as
  passing. Ticking a task done frees its slot.

### Bag size

The team shares a budget of **10 actions**, split across the party, so nobody
walks away with an impossible pile:

**Bag size = ceil(10 ÷ party size), but never less than 3.**

| Party size | 1 | 2 | 3 | 4 or more |
| --- | --- | --- | --- | --- |
| Bag size | 10 | 5 | 4 | 3 |

From four players up, the minimum of 3 means the bags add up to more than 10.

**Party size** counts every slot someone holds, plus proxy slots the
facilitator added for people who aren't online. That includes the facilitator
when they have a character. A player whose connection drops still counts
(their panel shows **Away**) until they click **Leave Group** or the
facilitator kicks or removes them. Open slots don't count. In local mode,
everyone at the table counts.

Bag size is recalculated whenever someone joins, leaves or is removed. Every
panel shows it as **Bags n/x**, and everyone gets a "Bag size changed" toast.

If bags shrink below what someone already holds, nothing is taken away. Their
panel shows **Bags 5/3, over the limit**, with the extra bags outlined, and
they can't Need or Greed until they've completed enough tasks to get back
under the limit.

### Timers

The facilitator can set an optional **phase timer** (any phase) and a
per-boss **enrage timer**. Both are off by default and can be paused,
extended (+1 or +5 minutes) or cleared at any time. A phase timer running out
shows "Time's up" but doesn't close the phase.

## Loot Ledger

**Loot Ledger** opens a markdown action plan to copy or download. It uses
plain language so it reads clearly outside the retro: tactics are listed as
**actions**.

1. **Achievements** — Legendary first, with who posted and who rallied.
2. **Each boss** — tier, HP, threat and status with its action count (e.g.
   "Slain, 3 of 4 actions open" or "Retreated, 1 of 2 actions open"), then
   each action with its rarity (and any rarity override), owner, who rallied
   and done state.
3. **Not pulled** — topics that were raised but never fought, with their threat.

## Tuning

All the game rules live in `shared/rules.js`, used by the server, the room
engine and the browser:

| Constant | Default | What it does |
| --- | --- | --- |
| `THREAT_PER_PLAYER` | 3 | Threat each player can spend |
| `HP_BASE`, `HP_RANGE` | 60, 440 | Boss HP = base + share of top threat × range |
| `TIER_BANDS` | 380 / 200 / 0 | HP where Raid Boss / Elite / Normal start |
| `TACTIC_DAMAGE` | 15–200 | Damage per rarity |
| `RALLY_EPIC`, `RALLY_LEGENDARY` | 0.4, 0.75 | Share of other members needed to upgrade an achievement |
| `TACTIC_RALLY_UNCOMMON` … `TACTIC_RALLY_LEGENDARY` | 0.2, 0.4, 0.6, 0.8 | Share of other members needed to upgrade a tactic |
| `TEAM_ACTION_BUDGET` | 10 | Open tasks shared across the party; bag size = budget ÷ party size, rounded up |
| `MIN_BAG_SLOTS` | 3 | Smallest bag size, however big the party |
| `RACE_CLASSES`, `FACTION` | WoW: Forever | Legal race/class combinations |
| `LIMITS` | | Maximum lengths for names, titles and descriptions |

## Races & classes (WoW: Forever)

Character creation follows the **WoW: Forever** race/class matrix: the eight
Classic races plus the two Skyborne variants (High Order for Alliance,
Windshaper for Horde), including Forever's six new combos (Human Hunter, Dwarf
Shaman, Gnome Priest, Orc Mage, Troll Warlock, Undead Paladin). The engine
rejects illegal combinations, so a tampered client can't create, say, a Night
Elf Mage.

| Faction  | Race        | Classes |
| -------- | ----------- | ------- |
| Alliance | Human       | Warrior, Paladin, Hunter, Rogue, Priest, Mage, Warlock |
| Alliance | Dwarf       | Warrior, Paladin, Hunter, Rogue, Priest, Shaman |
| Alliance | Night Elf   | Warrior, Hunter, Rogue, Priest, Druid |
| Alliance | Gnome       | Warrior, Rogue, Priest, Mage, Warlock |
| Alliance | High Order  | Warrior, Hunter, Rogue, Druid, Mage |
| Horde    | Orc         | Warrior, Hunter, Rogue, Shaman, Warlock, Mage |
| Horde    | Tauren      | Warrior, Hunter, Shaman, Druid |
| Horde    | Troll       | Warrior, Hunter, Rogue, Priest, Mage, Shaman, Warlock |
| Horde    | Undead      | Warrior, Rogue, Priest, Mage, Warlock, Paladin |
| Horde    | Windshaper  | Warrior, Hunter, Rogue, Druid, Shaman |

## Accessibility

The interface targets **WCAG 2.2 AA**:

- Rarity, faction and status are never shown by colour alone: there's always a
  text label, a letter or a distinct icon. Rare and Epic text is slightly
  lighter than WoW's own colours so it meets 4.5:1 on every surface.
- Toasts are read out by a polite live region and never move focus.
- Everything works from the keyboard, with a visible focus ring. Dialogs keep
  focus inside, close with Escape and return focus to what opened them.
  Confirmations start on Cancel.
- Focus is kept when other people's actions update the screen.
- Animations (toasts, the health bar, pulses) are switched off when the system
  asks for reduced motion.
- Timers can be paused or extended by the facilitator.
- Text sizes are in `rem`, so the self-hosted fonts follow browser text-size
  settings; the layout holds at 200% text size and at 320px wide.

## Files

- `net.html`, `net-client.js` — the client UI, for both modes
- `local-mode.js` — runs the engine in the browser for local mode
- `index.html` — opens local mode
- `shared/rules.js` — game rules and constants
- `shared/engine.js` — the room engine: every state change, per-viewer views
  and the Loot Ledger
- `server/server.js` — Express + ws server: connections, host role, slot
  claims, saving rooms and timers
- `server/data/rooms.json` — saved rooms (auto-created, git-ignored)
- `icons.js` — line-art icons
- `styles.css` — shared styling
- `fonts/` — self-hosted Cinzel and Marcellus web fonts
- `test/` — unit tests (`npm test`)
