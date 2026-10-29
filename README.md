# Loot Council — WoW-themed Retro

A World of Warcraft themed retro tool. A session runs like a dungeon:

1. **Achievements** — celebrate what went well, and rally behind each other's wins.
2. **Scouting** — everyone adds the topics they want to discuss to a shared **Mob List**.
3. **Threat Voting** — everyone spreads threat across the topics, in secret.
4. **Boss Encounters** — the most threatening topics become bosses. You fight
   each one by proposing **tactics** (loot), rallying behind the best ones and
   distributing them with WoW **Need / Greed / Pass** rules. Won tactics become
   tasks with an owner.

When you're done, the facilitator clicks **End Raid** and everyone sees the
**Raid Summary**, a read-only recap of the session. The **Loot Ledger** exports
it all as a markdown action plan.

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
covers the rules: roll resolution and ties, boss tiers and HP from tactics,
achievement and tactic rally thresholds, threat ballots, and bag size for
different party sizes.
`test/engine.test.js` covers whole flows: achievement and tactic rallies,
merges, secret ballots, pull order and tiers, preparation and Engage, HP built
from the plan (and following it mid-fight), the facilitator's rarity override,
Tactical Victory,
enrage timers, who counts towards bag size, bags shrinking below what someone
holds, End Raid and the read-only room, the Raid Summary's totals and
ordering, and migrating old saved rooms.

## Online mode

The lobby puts joining first: most people arrive with a code or a link.

1. One person opens **Lead a new raid**, chooses whether to **Save this room**
   (see below) and clicks **Create Room**. They become the **facilitator**
   (host) and get a 4-character room code.
2. The facilitator clicks **Copy invite** (next to the room code in the top
   bar) and shares the link. The link looks like
   `http://192.168.1.42:3000/net.html?room=ABCD`: opening it joins that room
   straight away. If the room no longer exists, the lobby opens with the code
   filled in and says so.
3. Everyone else opens the link, or types the code under **Join your party**
   and clicks **Enter World**. The code box ignores anything that isn't a
   letter or digit, so pasting "ab-cd" or the whole invite link works too.
   Then they create a character: a character name, their **real name** (who's
   accountable for loot they win), then a faction, a race from that faction
   and a class that race can be.
4. The facilitator moves the session through its phases with **Back** /
   **Next** in the row under the phase tracker (with the optional phase timer).
   Everyone sees the current phase.

**How to play** in the lobby, and in the character menu, gives a short
overview of the phases.

### The header

Once you're in a room, the header is a slim bar with a phase tracker under it:

- **Room chip** — the room code, plus **Copy invite** for the facilitator. It
  briefly reads "Link copied".
- **Status** — **Connected** / **Connecting…** / **Disconnected** (it
  reconnects by itself), and **Saved** / **Not saved**. Select the save status
  for what it means.
- **Tools** — **Mob List** (after Achievements), **Party** (facilitator) and
  **Loot Ledger**.
- **Your character** — your avatar, name and "Real name · Race Class" (plus
  "Facilitator" for the host). It opens a menu with **Loot Table**
  (facilitator), **Edit my character**, **How to play** and **Leave group**.
  Edit my character reopens the character screen, prefilled; your loot stays
  with you.
- **Phase tracker** — Achievements › Scout › Threat › Bosses › Summary, with
  done phases ticked, the current one outlined, and a one-line hint for what
  to do now.

On phones the bar collapses to the swords, the room chip (with an icon-only
copy button), your avatar and a **Menu** button that holds everything else,
and the tracker shows "Phase n of N" with a progress bar.

### Saved and unsaved rooms

When creating a room, the facilitator chooses whether to save it. **The default
is not to save.**

- **Unsaved rooms** live in the server's memory only. Nothing is written to
  disk, and the room is gone if the server restarts.
- **Saved rooms** are written to `server/data/rooms.json` (debounced on every
  change) and reload after a restart. Everyone rejoins with the same code and
  reclaims their character; the first person back becomes the facilitator.

The header shows **Saved** or **Not saved**. Abandoned rooms (empty for
24 hours) are pruned either way.

### Playing with remote teammates

The server listens on your LAN, so people on the same network can use your
machine's IP (e.g. `http://192.168.1.42:3000/net.html`). For remote folks,
expose it with a tunnel such as `npx ngrok http 3000`; the client switches to
`wss` automatically over HTTPS. Invite links use whatever address the
facilitator opened the page with, so open it by the address your team will
use (your LAN IP or the tunnel URL), not `localhost`.

Browsers only allow one-click copying on HTTPS or `localhost`. On a plain-HTTP
LAN address, **Copy invite link** falls back to an older copy method, and if
that's blocked too it shows the link selected so you can copy it by hand.

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
a team around one screen. The header's room chip reads **Single screen**, and
the character button shows whoever the screen is **acting as**. Its menu lists
everyone at the table: pick a name to act as them (to post achievements, rally
and vote), or **Add a party member**. **Edit my character** edits whoever
you're acting as.

- **Threat ballots stay private** by passing the screen around: each person
  selects their name, opens their ballot, votes, then hides it again.
- **Need / Greed / Pass** buttons appear on every party panel.
- There are no tactic rallies (nobody else is at their own screen to rally),
  so whoever proposes a tactic picks its rarity instead.
- The session lives in `sessionStorage` by default, so it's cleared when the
  tab closes. Tick **Keep after the tab closes** (in the character menu) to
  keep it in `localStorage` instead; the header then reads **Kept in this
  browser** rather than **This tab only**. **Disband group** wipes it.

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

A boss's **tier** comes from its topic's share of the top threat, and sets how
much of the party's plan it takes to beat it:

| Tier | Share of top threat | HP is this much of the plan | Tactics needed to engage |
| --- | --- | --- | --- |
| Normal | under 30% (or no threat) | 50% | 1 |
| Elite | 30% or more | 65% | 2 |
| Raid Boss | 75% or more | 80% | 3 |

The top-threat topic is always a Raid Boss.

### Preparation, then Engage

A freshly pulled boss is in **preparation**. Its HP doesn't exist yet: the
health bar reads **??? HP**, and nothing can be dropped. The party proposes
tactics and rallies behind the best ones, while the boss card counts them
("4 tactics proposed · needs 3 to engage").

When the plan is ready, the facilitator clicks **Engage** (disabled, with
"Needs 2 more proposed tactics", until the tier's minimum is reached). That
sets the boss's HP from the plan:

**HP = the tier's percentage × the damage of every proposed tactic, rounded up.**

For example, an Elite with three Uncommon tactics has ⌈150 × 0.65⌉ = **98 HP**,
so owning two of them kills it. A Raid Boss with five Uncommon tactics has
⌈250 × 0.8⌉ = **200 HP**: owning four kills it.

The server works HP out and never sends it to anyone before Engage. The
enrage timer and Tactical Victory are only available once the boss is engaged.

### The fight

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
   someone owns damage the boss; tactics everyone passes on deal no damage.

Tactics in rooms saved before rallies existed keep the rarity they were
proposed with; the facilitator can still override it.

### Damage

Every owned tactic deals **40 damage plus a small bonus for its rarity**
(passed-over tactics deal none):

| Rarity | Poor | Common | Uncommon | Rare | Epic | Legendary |
| --- | --- | --- | --- | --- | --- | --- |
| Bonus | +0 | +5 | +10 | +20 | +30 | +50 |
| Damage | 40 | 45 | 50 | 60 | 70 | 90 |

Because HP is built from the same damage numbers, **rarity is neutral to
winning**: raising a tactic's rarity raises the boss's HP by the tier's share
of the extra damage. What matters is owning enough of the plan: about half of
it for a Normal boss, two thirds for an Elite and four fifths for a Raid Boss.
So rarity can stay an honest measure of priority.

### The plan keeps counting after Engage

Once engaged, HP follows the plan:

- **A tactic proposed mid-fight** adds the tier's share of its damage to both
  HP and max HP (a Common tactic adds ⌈45 × 0.8⌉ = 36 to a Raid Boss).
- **A rarity change** to a tactic that hasn't been dropped (rallies or the
  facilitator's override) adds or takes away the share of the difference.
- **A backlog item that isn't one of this boss's tactics** adds its share
  when it's dropped, so every drop is accounted for.

None of these can kill the boss on their own; that takes owned tactics.

### How an encounter ends

- **Slain** — its HP reaches zero.
- **Tactical Victory** — the facilitator declares it when the room agrees the
  problem is handled, even though the boss isn't fully beaten (not available
  mid-vote). It's a soft win, with its own "Tactical Victory!" toast for
  everyone. The facilitator can add a short optional note, e.g. "Covered by
  the CI rewrite", which appears on the Raid Summary and in the ledger along
  with the HP the boss had left.
- **Enraged** — an optional **enrage timer** runs out. If a vote is in
  progress, the boss enrages once that drop is resolved, so no votes are lost.
- **Abandoned** — the raid was ended (End Raid) while the boss was still
  being fought or prepared. One abandoned in preparation shows "HP never set".

A boss saved before preparation existed loads mid-fight, with its HP as it
was.

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

## End Raid and the Raid Summary

The facilitator ends the session with **End Raid**, next to Back / Next (it asks
to confirm first, and waits for any open Need / Greed / Pass vote to be
resolved). Everyone's screen switches to the **Raid Summary** at once. A boss
still being fought is marked **Abandoned**.

After End Raid the room is **read-only**: no new achievements, rallies,
topics, threat, tactics, drops or rolls, and tasks can't be ticked off. Anyone
can still view the summary, join late to see it, and export the Loot Ledger.
If End Raid was clicked by mistake, the facilitator can **Reopen Raid** from
the summary.

The Raid Summary shows:

1. **Party totals** — bosses slain, tactics owned, achievements earned and the
   gold value of all owned loot. These are team totals only.
2. **Encounters** — every topic with its outcome (Slain, Tactical Victory,
   Enraged, Abandoned or Not pulled), the HP left if it wasn't slain, any
   Tactical Victory note, and its tactics with their rarity and owner
   (or "Passed over" / "Never dropped").
3. **Achievements** — Legendary first, with who posted and who rallied. Who
   rallied is only revealed here, once the raid has ended.
4. **Character sheets** — one per party member: character name, race and
   class, real name, the tactics they own and the achievements they posted or
   rallied behind.
5. **Export Loot Ledger** — the same export as the header's Loot Ledger button.

It's deliberately **not a leaderboard**: no MVPs, rankings, scores or "most"
anything, and no per-player gold or counts. Character sheets are sorted
alphabetically by real name. Who rallied behind a tactic stays private (it's
only in the Loot Ledger).

In an **unsaved room** the summary carries a note, next to the export button,
that it disappears when the room closes. In local mode the note says it
disappears when the tab closes, unless **Keep after the tab closes** is ticked.
Saved rooms stay ended (and keep their summary) across a server restart.

## Loot Ledger

**Loot Ledger** opens a markdown action plan to copy or download. It uses
plain language so it reads clearly outside the retro: tactics are listed as
**actions**.

1. **Achievements** — Legendary first, with who posted and who rallied.
2. **Each boss** — tier, HP, threat and status with its action count (e.g.
   "Slain, 3 of 4 actions open" or "Tactical Victory (60 of 250 HP left), 1
   of 2 actions open"), then each action with its rarity (and any rarity
   override), owner, who rallied and done state. Any Tactical Victory note is
   shown under the boss.
3. **Not pulled** — topics that were raised but never fought, with their threat.

## Tuning

All the game rules live in `shared/rules.js`, used by the server, the room
engine and the browser:

| Constant | Default | What it does |
| --- | --- | --- |
| `THREAT_PER_PLAYER` | 3 | Threat each player can spend |
| `BOSS_TIERS` | see above | Per tier: share of top threat (`minShare`), HP as a share of the plan's damage (`hpPct`) and tactics needed to engage (`minTactics`) |
| `TACTIC_BASE_DAMAGE` | 40 | Damage every owned tactic deals |
| `RARITY_BONUS` | +0 to +50 | Extra damage by rarity (`TACTIC_DAMAGE` is base + bonus) |
| `RALLY_EPIC`, `RALLY_LEGENDARY` | 0.4, 0.75 | Share of other members needed to upgrade an achievement |
| `TACTIC_RALLY_UNCOMMON` … `TACTIC_RALLY_LEGENDARY` | 0.2, 0.4, 0.6, 0.8 | Share of other members needed to upgrade a tactic |
| `TEAM_ACTION_BUDGET` | 10 | Open tasks shared across the party; bag size = budget ÷ party size, rounded up |
| `MIN_BAG_SLOTS` | 3 | Smallest bag size, however big the party |
| `RACE_CLASSES`, `FACTION` | WoW: Forever | Legal race/class combinations |
| `LIMITS` | | Maximum lengths for names, titles, descriptions and Tactical Victory notes |

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
- When the raid ends, focus moves to the Raid Summary heading (the screen it
  was on is gone). The summary uses a heading per section, boss and character,
  and shows status and rarity as text.
- Animations (toasts, the health bar, pulses) are switched off when the system
  asks for reduced motion.
- Timers can be paused or extended by the facilitator.
- The lobby's controls are at least 44px tall, the room code has a visible
  label and hint, and connection status is written out, not just a coloured
  dot.
- The character menu, phone menu and save-status explanation are disclosures
  (not ARIA menus): Escape closes them and returns focus, clicking outside or
  tabbing away closes them. Header targets are at least 40px tall on desktop
  and 44px on phones. The phase tracker marks the current phase with
  `aria-current="step"` and says "done" / "current phase" in text.
- The header reflows without sideways scrolling at 320px wide, 400% zoom and
  200% text. It's only sticky on screens big enough for it, and toasts and
  keyboard focus are kept clear of it.
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
