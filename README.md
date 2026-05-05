# BGG Subscription Digest

Generates a daily or weekly markdown digest of new activity across your
[BoardGameGeek](https://boardgamegeek.com) subscriptions (threads, geeklists,
blogs, file pages, and game pages), summarized and prioritized by Claude AI
based on your interests.

Instead of clicking through each BGG subscription individually, you get one
file with everything new — highlights first, ordered by what you actually
care about.

## Example output

```markdown
# BGG Subscription Digest
*Generated: Monday, April 28, 2026*

## ⭐ Highlights

- **emmeray** completed The 7th Citadel campaign — full write-up in SGOYT Goals ⭐
- New KS thread for Earthborne Rangers 3rd edition launched with 12 replies ⭐

### [Solitaire Games On Your Table — April 2026](https://boardgamegeek.com/geeklist/375854)

**Summary:** Very active month with 89 new entries. Heavy Spirit Island and
Wingspan representation. Several members reporting campaign completions.

**New Activity:**
- 14 posts discussed Spirit Island solo experiences ⭐
- ...

---
*Token usage: 43,924 input + 1,234 output (45,158 total) | Cost: ~$0.046 | 45.2s*
```

## Requirements

- **Node.js** 18+ and **npm**
- An AI agent — one of:
  - **Claude Code CLI** (`claude`), authenticated against your Claude subscription
    (`--agent claude`, default)
  - **Claude Code CLI** redirected at a local **Ollama** server via
    `ollama launch claude` (`--agent claude-ollama`). Lets you run any Ollama
    model (local or cloud-served) through claude's tooling. See
    [Ollama's claude-code integration docs](https://docs.ollama.com/integrations/claude-code).
  - **Tallow** ([dungle-scrubs/tallow](https://github.com/dungle-scrubs/tallow))
    with any provider it supports (`--agent tallow`)

  All three run as headless subprocesses with file-read access. Pick one
  with `--agent <name>` at runtime.
- A **BGG account** with subscriptions
- A **BGG XML API key** — request one at
  `https://boardgamegeek.com/xmlapi/apiv2/requesttoken`

## Installation

```bash
git clone <this-repo>
cd bgg_sub_digest
npm install
npx playwright install chromium
```

## Configuration

### 1. Create `config.json`

Copy the example and fill in your credentials:

```bash
cp config.example.json config.json
chmod 600 config.json   # keep credentials private
```

Edit `config.json`:

```json
{
  "bgg": {
    "username": "your_bgg_username",
    "password": "your_bgg_password",
    "apiKey":   "your_bgg_xml_api_key"
  },
  "digest": {
    "outputDir":                  "./digests",
    "scheduleMode":               "daily",
    "maxNewItemsPerSubscription": 15,
    "headless":                   true,
    "interestsFile":              "./interests.md",
    "clearSubs":                  false
  }
}
```

**Config options:**

| Key | Default | Description |
|-----|---------|-------------|
| `bgg.username` | — | Your BGG login username |
| `bgg.password` | — | Your BGG login password |
| `bgg.apiKey` | — | BGG XML API application token |
| `digest.outputDir` | `./digests` | Where to write the daily `.md` files |
| `digest.scheduleMode` | `daily` | `"daily"` or `"weekly"` (informational only) |
| `digest.maxNewItemsPerSubscription` | `15` | Hard cap on items per subscription file. Applied to every selection path (date-filter, notifiedIds, fallback) — keeps total digest context within the model's window so summarization stays clean. |
| `digest.headless` | `true` | Set `false` on first run to watch Chromium and solve any Cloudflare challenge manually |
| `digest.interestsFile` | `./interests.md` | Path to your interests file (see below) |
| `digest.clearSubs` | `false` | `false` = log what would be cleared but don't click (safe / debug). `true` = click BGG's mark-as-read button on each notification row after processing. Turn on once you've verified targeting is correct and the script is generating digests you trust. |
| `email.resendApiKey` | — | Resend API key (omit entire `email` block to disable) |
| `email.from` | — | Verified sender address, e.g. `BGG Digest <digest@yourdomain.com>` |
| `email.to` | — | Recipient address |

### 3. Email delivery (optional)

The digest can be emailed to you automatically via [Resend](https://resend.com).
Resend's free tier (3,000 emails/month) is more than enough for a daily digest.

1. Sign up at [resend.com](https://resend.com) and create an API key
2. Add a verified sender domain (or use Resend's shared `onboarding@resend.dev`
   address for testing before you set one up)
3. Add the `email` section to your `config.json`:

```json
"email": {
  "resendApiKey": "re_your_api_key",
  "from":         "BGG Digest <digest@yourdomain.com>",
  "to":           "you@gmail.com"
}
```

The digest is converted from markdown to HTML before sending, so it renders
fully formatted in Gmail (headers, bold, bullet lists, links).

Omit the `email` section entirely to skip email and only write to disk.

### 2. Create `interests.md`

This is a plain-text or markdown description of what you care about on BGG.
Claude reads it to decide what to highlight (⭐) and how to order sections.

```markdown
# My BGG Interests

I primarily play solo games. My favorites:
- Spirit Island (all expansions)
- Earthborne Rangers
- Wingspan
- Oranienburger Kanal

I'm interested in:
- Campaign games and legacy content
- Kickstarters for games I own or follow
- Solo variant discussions
- SGOYT (Solitaire Games on Your Table) monthly threads
- Game reviews and first impressions

I'm NOT interested in:
- Trading / sales posts
- Multiplayer-only games
```

The more specific you are, the better Claude can prioritize. You can update
this file any time — it's re-read on every run.

## First run

Set `headless: false` in `config.json` so you can see what's happening:

```bash
npm start
```

Chromium will open and navigate to BGG. If Cloudflare shows a challenge
page, complete it manually. Your session is saved to `./bgg-browser-profile/`
and reused on future runs — you should only need to do this once.

After a successful first run, set `headless: true` and `debugClear: false`.

## Subsequent runs

```bash
npm start
```

Output is written to `./digests/bgg-digest-YYYY-MM-DD.md`.

### Choosing an agent and model

Two CLI flags control which agent and which model produce the digest:

| Flag | Default | Notes |
|------|---------|-------|
| `--agent <name>` | `claude` | `claude`, `claude-ollama`, or `tallow` |
| `--model <id>` | `opus` (claude), `qwen3-coder-next:cloud` (claude-ollama / tallow) | Any model the agent can resolve |

**Why three options?** A daily digest run on Claude Opus burns a meaningful
chunk of your Claude Pro usage window. The Ollama-routed paths let you point
the same digest pipeline at a cheaper backend so the daily script doesn't
eat into Claude usage you'd rather save for interactive coding.

| Agent | When to pick it |
|-------|-----------------|
| `claude` | Daily runs against Anthropic. Highest quality, simplest. Uses prompt caching, so repeated daily runs amortize well. |
| `claude-ollama` | Same `claude` binary but redirected at a local Ollama endpoint via [`ollama launch claude`](https://docs.ollama.com/integrations/claude-code). Lets you use Ollama models (free local or paid `:cloud`) while keeping Claude Code's tool-use protocol — usually more reliable than `tallow` because tooling is the same as Anthropic's. |
| `tallow` | Tallow's own agent. Routes via `~/.tallow/settings.json`'s `defaultProvider`. |

**Examples**

```bash
# Cheaper Claude run (Sonnet costs ~5× less than Opus)
npm start -- --model sonnet

# claude-ollama with a cloud-served Ollama model
npm start -- --agent claude-ollama --model nemotron-3-super:cloud

# claude-ollama against a local Ollama model
npm start -- --agent claude-ollama --model qwen35-pi

# Tallow with its default model
npm start -- --agent tallow

# --reuse-data: skip the BGG scrape and rerun the agent against the
# existing ./digest-data/manifest.json. Fast iteration on agent/model choice.
npm start -- --agent claude-ollama --model nemotron-3-super:cloud --reuse-data
```

For Tallow, model resolution flows through `~/.tallow/models.json` and the
`defaultProvider` in `~/.tallow/settings.json`. To use a different provider
(Anthropic, OpenAI, etc.) edit those files — this script doesn't pass
`--provider` itself.

For `claude-ollama`, the model name is whatever Ollama recognises (run
`ollama list` to see what's available locally; cloud models are listed at
`https://ollama.com/cloud/library`). The integration sets the Anthropic
env vars (`ANTHROPIC_BASE_URL=http://localhost:11434`, etc.) and exec's
the `claude` binary against your local Ollama.

### Running on a schedule (cron)

```cron
# Run every morning at 7am
0 7 * * * cd /path/to/bgg_sub_digest && npm start >> logs/cron.log 2>&1
```

The script uses a PID lock file (`./bgg-digest.pid`) to prevent overlapping
runs if a previous one is still in progress.

> **Note on PATH:** cron runs with a minimal `PATH` that typically does not
> include `~/.local/bin` (where `claude` is usually installed) or `~/.bun/bin`
> (where `tallow` is usually installed). The script automatically prepends
> `~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`, and `/usr/local/bin`
> to the subprocess PATH when calling either agent, so no extra cron PATH
> configuration is needed.

## How it works

### BGG notification page

BGG's `/subscriptions` page shows **one `gg-notice` row per subscription** with
outstanding activity. Rows are grouped under date headings ("Today", "Yesterday",
"Apr 21, 2026") — the heading is the date of the oldest unread item, which becomes
the cutoff for "show me everything newer than this."

Each row embeds the unread count in its text:
- Threads: `"3 replies"` or `"1 Thread"` (brand-new, never read)
- Geeklists: `"436 GeekList Items"` and/or `"1378 Comments"`
- Blogs / file pages: `"3 replies"` (same as threads)

The scraper captures:
- The oldest-unread date from the section heading (`notificationDate`)
- The unread count parsed from the row text (`unreadCount`)
- The specific article/item ID encoded in the row's link URL (`notifiedItemIds`)

### "What's new" detection

**Threads** use `minarticledate` — the BGG XML API accepts a date parameter so
only articles from the relevant window are fetched, rather than the full thread
history (long threads like "Dad Jokes" have thousands of archived posts).
`notificationDate` is the date of the **oldest** unread row for the
subscription, so we pass that (with a 2-hour buffer for hour-precision
boundary effects) to BGG and also filter client-side to drop anything older.
That keeps the per-thread window matched to the actual unread activity — for
a daily run, one day's worth of posts; for a 6-hour-old notification, ~8
hours of posts.

**Geeklists** use date-based filtering — `notificationDate` is the cutoff and
`itemsNewerThan()` returns everything posted after it. This correctly handles
high-volume geeklists like SGOYT where you may be hundreds of items behind.
The BGG geeklist API has no date filter, so the full geeklist is fetched and
filtered locally.

After date/notifiedIds filtering, every subscription's results are also
hard-capped at `maxNewItemsPerSubscription` (newest-first) so the total
digest context stays comfortably within the model's window — preventing
the over-summarization and repetition-collapse failures that happen when
Ollama-served 200K-window models hit context pressure.

Fallback chain for both types when the primary path returns nothing:
1. `notifiedItemIds` — the specific item/article ID from the notice row URL
2. `recentItems(maxItems)` / `recentArticles(maxItems)` — most-recent N by date

Subscriptions whose filter chain returns zero matches are skipped entirely — no
empty stub sections in the digest.

### Workspace-based agent invocation

The script splits cleanly: **scrape phase** writes data files; **agent phase**
runs an analyst that drives itself off the workspace.

After scraping, `./digest-data/` looks like this:

```
digest-data/
├── CLAUDE.md                  ← orchestration: copied from templates/workspace/
├── INTERESTS.md               ← reader's interests, copied from config.digest.interestsFile
├── manifest.json              ← list of subscriptions to process
├── templates/
│   ├── section.md             ← per-subscription markdown format reference
│   └── highlights.md          ← cross-subscription Highlights format reference
├── thread-3702528.md          ← scraped subscription data files
├── geeklist-376148.md
└── ...
```

The script then spawns the chosen agent (claude / claude-ollama / tallow)
with `cwd=digest-data/` and a tiny trigger prompt: *"Build the BGG digest.
All instructions are in CLAUDE.md."* The agent reads CLAUDE.md (both Claude
Code and tallow do this natively from cwd), follows the workflow described
there, reads each subscription file using its Read tool, and produces the
digest.

This means:

- **No hard size limit** — each subscription has its own file; the agent reads
  what it needs.
- **Edit prompt rules without touching code** — change
  `templates/workspace/CLAUDE.md` and the next run picks it up. The script
  reinstalls the workspace template before every run, including `--reuse-data`.
- **Same workspace for any agent** — claude (Anthropic), claude-ollama, and
  tallow all read CLAUDE.md the same way. Switching agents does not require
  prompt changes.
- **Highlights post-processing**: CLAUDE.md tells the model to write the
  `## ⭐ Highlights` block LAST (after every subscription section), then a
  small post-processor lifts it to the top. Avoids the "model writes a
  Highlights placeholder and runs out of output budget before filling it in"
  failure mode.

Claude runs with `--model opus` by default for best summarization quality.
Pass `-- --model sonnet` (or `haiku`) to `npm start` to use a cheaper model.

If `email` config is present, the digest is also converted to HTML and sent
via Resend after the file is written.

## Troubleshooting

**"BGG API HTTP 401"** — your API key may be wrong or expired. Verify it
at `https://boardgamegeek.com/xmlapi/apiv2/requesttoken`.

**"Another digest run (PID N) is still running"** — a previous run is still
in progress (or crashed and left a stale lock). Delete `./bgg-digest.pid`
and try again.

**Cloudflare challenge on every run** — your browser profile cookies expired.
Set `headless: false`, run once, and complete the challenge manually.

**Digest looks empty or missing subscriptions** — check `./logs/` for errors
and inspect `./digest-data/manifest.json` to see what was fetched. The
`unreadCount` field shows BGG's advertised total parsed from the notice row
text; `itemCount` shows how many items were actually fetched. If `itemCount`
is unexpectedly low, check the debug logs for the raw notification row text.

**`claude: command not found` (or `tallow: command not found`) in cron** —
the cron PATH does not include `~/.local/bin` or `~/.bun/bin`. The script
handles both automatically by augmenting the subprocess PATH. If you still
see this error, find the full path to the binary (`which claude` or
`which tallow`) and verify it matches one of the paths the script prepends.

**Links 404** — should be fixed as of April 2026. Thread article links use
`?article=ID` format. Geeklist item links use `#itemID` fragments (correct
page, may not scroll to exact item depending on browser).

## Project structure

```
bgg_sub_digest/
├── src/
│   ├── bgg/
│   │   ├── auth.ts           # Playwright login + browser profile
│   │   ├── scraper.ts        # Notification page scraping
│   │   ├── api.ts            # BGG XML API client (threads + geeklists)
│   │   └── page-content.ts   # Playwright content fetch (blogs + file pages)
│   ├── agent.ts             # File writing + Claude subprocess
│   ├── digest.ts             # Markdown assembly + file output
│   ├── index.ts              # Main orchestrator
│   ├── types.ts              # TypeScript interfaces
│   ├── config.ts             # Config loading + validation
│   └── logger.ts             # Logging
├── config.example.json       # Copy this to config.json
├── interests.md              # Your personalization file (edit freely)
├── digests/                  # Generated digest files (gitignored)
├── digest-data/              # Per-subscription data files (recreated each run)
├── logs/                     # Run logs
└── bgg-browser-profile/      # Persistent Chromium session (gitignored)
```

## Notes on commenting style

The source code is heavily commented with Python equivalents throughout —
originally written to help a Python developer learn TypeScript patterns.
If you're comfortable with TypeScript, the comments are safe to ignore.
