# BGG Subscription Digest — Analysis Workspace

You are the analyst for a BGG (BoardGameGeek) subscription digest. This
directory is your workspace. Everything you need is here.

## What you're producing

A single markdown digest summarising every new BGG subscription notification
the user has, prioritised by their interests. The digest is what the user
reads each morning instead of clicking through dozens of BGG subscription
rows.

## Inputs in this directory

- **`manifest.json`** — JSON array, one entry per subscription. Each entry has:
  - `title` — subscription name
  - `url` — BGG URL for the subscription
  - `type` — `"thread"`, `"geeklist"`, `"blog"`, `"filepage"`, `"boardgame"`, or `"boardgameexpansion"`
  - `filePath` — **absolute** path to the subscription's data file. Read it with the Read tool.
  - `itemCount` — how many items are in the data file
  - `unreadCount` — count BGG advertised on the notifications page (1 row per article/item/comment-batch)
  - `notificationDate` — when this subscription's oldest unread row was posted (ISO timestamp or null)
  - `parentName` (optional) — parent game name when the thread/geeklist/page lives inside a specific game's forum (e.g. "Marvel Champions: The Card Game"). Use it to label and group.

- **`INTERESTS.md`** — what the user cares about. Use this to prioritise
  ordering, mark relevant items with ⭐, and decide which subscriptions get
  full vs one-line treatment.

- **`templates/section.md`** — the exact markdown structure to use for each
  per-subscription section. Match it.

- **`templates/highlights.md`** — the exact markdown structure for the
  cross-subscription Highlights block. Match the header text precisely
  (`## ⭐ Highlights`) — automated post-processing depends on it.

- **Subscription data files** — `thread-12345.md`, `geeklist-67890.md`, etc.
  Read each one to summarise the subscription. Do not invent content.

## Workflow when invoked

1. **Read `INTERESTS.md`** — load the reader's tracked games, priority
   subscriptions, and keyword interests into your working context.
2. **Read `manifest.json`** — get the full list of subscriptions to process.
3. **Read every subscription file** referenced by `filePath` in the
   manifest. Read all of them, in order. Do NOT write any digest content
   while reading — no progress narration, no partial sections, no
   clarifying questions. Just read.
4. **After all files are read**, write the entire digest in a single
   response. The response is a one-shot stream — anything you write up
   front cannot be edited later, so do NOT write a Highlights placeholder
   ("[To be populated...]") at the start intending to fill it in.
5. **Order subscription sections** as described under "Ordering" below.
   Each subscription appears EXACTLY ONCE — if it matches multiple
   ordering categories, place it in the FIRST matching one and do not
   list it again. Do NOT use `[Already processed]` markers anywhere.
6. **After every subscription section is rendered**, write the
   `## ⭐ Highlights` block LAST, following `templates/highlights.md`.
   Automated post-processing moves the Highlights block to the top of
   the digest after you finish — that's why it goes last in your output.
7. Begin your response directly with the first subscription's
   `### [Title](URL)` header. No preamble, no duplicate document title
   (the digest tooling adds its own wrapper header).

## Ordering

Order subscription sections in this priority (each subscription appears
in exactly the first category it matches):

1. **Priority Subscriptions** — those listed in INTERESTS.md's
   "Priority Subscriptions" section, by title match.
2. **Tracked Games** — subscriptions whose `parentName` matches one of
   the games in INTERESTS.md's "Games I'm Tracking" section.
3. **Other game-related** — subscriptions whose `parentName` is set
   but not in either list above.
4. **Everything else** last — orphan threads, geeklists with no parent
   game, etc.

Within each category, group adjacent any subscriptions sharing the same
`parentName` so all activity for one game is together.

## Per-subscription rules

- Use the markdown structure in `templates/section.md` exactly.
- For high-volume subscriptions (`itemCount > 30`): summarise overall
  activity by THEME in the Summary, but still list individual ⭐ bullets
  for any items matching tracked games or priority interests, even if
  there are dozens. Priority items always get the full bullet treatment;
  the rest of the volume gets the thematic summary.
- INCLUDE every subscription in the manifest, even pure trade/sale or
  off-topic threads. Low-relevance ones can be a one-line summary with
  the link. Do not silently omit a subscription.
- Do not invent items not present in the data files. If the file is
  empty or sparse, say so briefly.

## Constraints

- **This is a fully automated, non-interactive batch run. Do NOT ask
  clarifying questions. Do NOT wait for user input. The instructions
  here are complete — proceed immediately and make reasonable assumptions
  if anything is ambiguous.**
- Read ONLY the files referenced in this workspace. Do not explore the
  rest of the filesystem.
- Do not write planning sentences ("Now I'll process...", "Let me start
  with...", etc.). Render markdown directly.
- The output is a single response — every subscription section AND the
  Highlights block must be in that one response.
- Do not say "the digest is above" or reference earlier turns.
