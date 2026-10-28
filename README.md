# Loot Council — WoW-themed Retro

A World of Warcraft themed retro tool. **Pull a boss** (a retro topic), whittle
down its health by dropping loot (action items), and distribute each drop with
WoW **Need / Greed / Pass** group loot rules. Won items become assigned tasks
with an owner, and clearing all the loot slays the boss.

There are two ways to run it.

## 1. Local mode (single screen, no setup)

Just open **`index.html`** in a browser. Everything lives in that browser's
`localStorage`. The facilitator drives one screen: drop loot, each party
member's panel has Need/Greed/Pass, hit **Roll & Resolve**, and a WoW-style
loot toast announces the winner. Good for a co-located team around one display.

## 2. Online mode (per-laptop rolling)

Everyone rolls from their own laptop. The server is authoritative and does the
hidden rolling, so choices and roll values stay secret until the facilitator
resolves — then a loot toast fires on **everyone's** screen at once.

### Run it

```bash
npm install
npm start
```

During development, use `npm run dev` instead — it runs the server with Node's
built-in `--watch`, so it auto-restarts whenever you edit `server/server.js`.
(Changes to server logic only take effect after a restart, since the server
holds the authoritative game state.)

Then open:

- Facilitator & players: `http://localhost:3000/net.html`
- Single-screen local mode is still served at `http://localhost:3000/index.html`

### How a session works

1. One person clicks **Create a room** — they become the **facilitator** and get
   a 4-letter room code.
2. Everyone (including the facilitator) **creates their own character**: pick a
   character name, enter their **real name** (who's accountable for any loot
   they win), and choose a race and class on the join screen. That becomes your
   own panel — no need to wait for the host. Race and class selection follow
   **WoW: Forever** rules (see below), and each panel shows a faction crest
   (Alliance / Horde) plus the owner's real name. The real name also appears in
   the loot log and the exported action-item list, so every task has a clear
   owner. A **Quest Log** panel summarizes who owns how many open vs. done
   tasks, and hovering a party panel shows that person's details and workload.
3. Facilitator **drops loot** (random or a specific item).
4. Each player picks **Need / Greed / Pass** on their own screen. Others see only
   that a vote was cast, not what it was.
5. Facilitator clicks **Roll & Resolve**. The server rolls, reveals every roll,
   and the winner gets a loot toast + the task.
6. **Loot Ledger** copies a markdown remediation plan **grouped by problem** —
   each boss with its steps, owners, and done state as a checklist.

Players make their own characters, so the host doesn't pre-build the roster. The
**Party** panel is only needed for proxy slots (someone not online) or to kick /
reassign. If you reconnect after a drop (or a server restart) and re-enter the
same character name, you re-take your existing slot instead of duplicating it.

### Playing with remote teammates

The server listens on your LAN. For people on the same network, share your
machine's IP (e.g. `http://192.168.1.42:3000/net.html`). For fully remote folks,
expose it with a tunnel, for example:

```bash
npx ngrok http 3000
```

and share the generated URL (`https://xxxx.ngrok-free.app/net.html`). HTTPS is
handled automatically; the client upgrades the WebSocket to `wss` to match.

### Managing players (facilitator)

Open the **Party** panel to manage slots live:

- **Kick** frees a slot: the player is bumped off (and told why) but the slot
  stays, so they can reclaim it or someone else can take it. Any vote they cast
  on the current unresolved drop is cleared.
- **Make host** hands the facilitator role to the connected player in that slot.
  You become a regular player.
- The **&times;** button removes the slot entirely.

If the facilitator closes their tab, the next connected person is automatically
promoted so the session keeps running.

### Sessions survive restarts

Room state (loot table, party, active drop, result, and loot log) is saved to
`server/data/rooms.json`, debounced on every change. If the server restarts,
rooms reload from disk — just rejoin with the same room code. Because the old
connections are gone after a restart, party slots reset to **open** (reclaim
yours) and the first person to rejoin becomes the facilitator. Abandoned rooms
(empty for 24h) are pruned automatically.

## Races & classes (WoW: Forever)

Character creation is scoped to the **WoW: Forever** race/class matrix — the
eight Classic races plus the two Skyborne allied-race variants (High Order for
Alliance, Windshaper for Horde), including Forever's six new combos (Human
Hunter, Dwarf Shaman, Gnome Priest, Orc Mage, Troll Warlock, Undead Paladin).
When you pick a race, the class picker only shows classes that race can
actually be. The server is the source of truth: it sends the matrix to clients
and rejects any illegal combination, so a tampered client still can't create,
say, a Night Elf Mage or a Tauren Paladin.

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

To change the ruleset later, edit `RACE_CLASSES` / `FACTION` in
`server/server.js` — the client picks up the new matrix automatically.

## Boss encounters (a problem and its remediation plan)

Each **boss is a problem that needs addressing**, with a health pool. You bring
the boss down by **proposing remediation steps** — concrete fixes authored live
as the discussion produces them. Each step you resolve with Need / Greed / Pass
is a drop that damages the boss, and the ones someone owns become assigned
tasks. The boss carries its own **remediation plan**, so each problem leaves
with its own list of fixes and owners.

1. **Pull a boss.** Name the problem (e.g. "Flaky CI pipeline"), add an optional
   **description** so the room has context on what the problem is and why it
   matters (it shows under the boss name and in the export), and pick a
   difficulty:
   - **Trash mob** — a minor nitpick. 1 step to kill.
   - **Elite** — worth discussing. 2 steps to kill.
   - **Raid boss** — a big systemic issue. 4 steps to kill.
   Tougher bosses have more health, so you're expected to commit more (and
   heavier) remediation steps before they fall.
2. **Propose remediation steps (anyone).** While the boss is up, **any party
   member** can type a fix into the inline composer (name + priority/rarity +
   optional detail) and hit **Propose Step** — it joins the boss's remediation
   plan as a suggestion, attributed to whoever proposed it. The **facilitator**
   then drops a proposed step onto the table (the **Drop** button next to it)
   when the room is ready, and you resolve it with Need / Greed / Pass. This
   keeps brainstorming open to everyone while the facilitator still paces the
   encounter — and you can't drop over a vote that's already in progress. Every
   resolved step **damages the boss**: a step someone owns (wins) lands a full
   hit, while a step everyone passes on only chips away (half a hit). A health
   bar drains as you go, and the plan shows each step as *proposed*, *on the
   table*, *owned* (with its owner), or *unowned*.

   (In single-screen local mode there are no separate players, so the composer
   simply drops the step straight onto the shared screen.)
3. **Problem addressed.** When health hits zero the boss is slain — a victory
   toast fires (on everyone's screen in online mode) and the encounter shows how
   many owned remediation steps the party committed. Pull the next boss, or
   **End Encounter** to clear the stage. Past problems are archived so the export
   can group everything per problem.

The **loot table** is an optional **backlog**. A fresh room/session starts
**empty** — you fill it by proposing steps (each proposed step is also added to
the backlog, so it's reusable) or by adding items to the Loot Table directly.
Use **Drop from Backlog** / **Pick from Backlog** to put an existing backlog
item on the table instead of authoring a new step.

Items that **everyone passes on** aren't lost: they're recorded in the Loot Log
as **passed over** — no owner, not an actionable task, and they don't count
toward the "items looted" total or anyone's accountability — so the register
keeps a trace that the item was discussed and consciously dropped.

In online mode the server owns the health math, the slain flag, and the
remediation plan, so none of it can be faked by a tampered client, and the boss
(along with the rest of the room) survives server restarts. You can't drop a
step or backlog item without a live boss on the table.

## Loot rules (how Need / Greed / Pass resolves)

- If **anyone needs**, only Needers roll 1–100; highest wins.
- If **nobody needs**, Greeders roll instead.
- If **everyone passes**, the item is unclaimed.
- Ties on the top roll re-roll only the tied players until broken.
- **Bags hold 6.** Each player can own at most 6 open tasks at once (shown as
  `Bags n/6` on their panel). With full bags you can only Pass, and anyone
  whose bags are full at resolve time is counted as passing. Ticking a task
  done frees its slot. Change `MAX_SLOTS` in `server/server.js` (and `app.js`
  for local mode) to adjust.

## Rarity = priority = value

Item rarity doubles as task priority, using WoW's colors:
Poor (grey) → Common (white) → Uncommon (green) → Rare (blue) →
Epic (purple) → Legendary (orange). Legendary drops get an extra toast flourish.

Each rarity also carries a WoW-style vendor **value** in gold/silver/copper that
scales with worth (Poor ≈ 1s 50c, Legendary = 1000g). When someone wins an item,
the loot toast shows the rarity label and that gold value, so you can see at a
glance how valuable / high-priority the task is.

## Files

- `index.html`, `app.js` — single-screen local mode (localStorage)
- `net.html`, `net-client.js` — networked client (WebSocket)
- `server/server.js` — authoritative Node + Express + ws server
- `server/data/rooms.json` — persisted room state (auto-created, git-ignored)
- `styles.css` — shared styling + loot toast (used by both modes)
- `fonts/` — self-hosted Cinzel + Marcellus web fonts (WoW-style theming,
  no external/CDN dependency, so it renders correctly fully offline)
```
