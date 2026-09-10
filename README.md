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
| `digest.headless` | `true` | Leave `true`. The digest reaches BGG through its JSON API (no page navigation), so the browser only carries login cookies. `--reauth` flips this to `false` for a one-off interactive login when cookies expire. |
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

The digest authenticates to BGG with the login cookies saved in
`./bgg-browser-profile/`. On a fresh setup that profile has no cookies yet, so
do an interactive login once:

```bash
npm start -- --reauth
```

`--reauth` opens Chromium visibly and logs into BGG with your `config.json`
credentials, saving the session ("remember me") cookies to the profile. After
that, normal headless runs (`npm start`) reach BGG entirely through its JSON
API — no browser navigation, no Cloudflare challenge.

Once you've confirmed a run produces a digest you trust, set `clearSubs: true`
so processed notifications are marked read on BGG.

**If the login cookies expire later** (the remember-me cookies last ~30 days and
refresh on use, so this is rare), `getAuthToken` fails, the script emails you an
`[ACTION REQUIRED] session expired` notification (if email is configured), and
exits. Run `npm start -- --reauth` again to refresh them.

### First-run setup for `--agent tallow`

Tallow refuses to invoke its tools (Read, etc.) in directories that aren't
explicitly trusted. The digest pipeline uses three directories that tallow
needs to operate against:

```bash
cd /path/to/bgg_sub_digest && tallow   # opens interactive
/trust-project                         # trusts project root
exit
cd ./digest-data && tallow
/trust-project                         # trusts the workspace agent runs in
exit
cd ./digests && tallow
/trust-project                         # trusts the digest output dir
exit
```

Without these, tallow will read your trigger prompt, declare the task
complete, and produce no digest content — because every tool call inside
the run silently no-ops. Symptoms in the digest footer: very low input
tokens (~100K instead of the expected ~600K-1M from real Read calls) and
a 1-line response like *"Task completed."*

`--agent claude` and `--agent claude-ollama` don't need this — Claude Code
handles trust through `--dangerously-skip-permissions` which the script
passes automatically.

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
| `--reuse-data` | off | Skip the BGG fetch; rerun the agent against existing `./digest-data/` |
| `--reauth` | off | Open Chromium visibly and log into BGG to refresh expired session cookies |

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

# --reuse-data: skip the BGG fetch and rerun the agent against the
# existing ./digest-data/manifest.json. Fast iteration on agent/model choice.
npm start -- --agent claude-ollama --model nemotron-3-super:cloud --reuse-data

# --reauth: refresh expired BGG login cookies — opens Chromium visibly and
# logs in, so future headless API runs authenticate again.
npm start -- --reauth
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

> **⚠️ Ollama model compatibility caveat.** Not every Ollama model works
> well through `--agent claude-ollama`. Claude Code sends tool-use messages
> in Anthropic's format (`user` message containing `tool_result` blocks);
> some Ollama-served models — especially those tuned for OpenAI-style
> function calling like Mistral's `devstral-2` — return HTTP 400 errors
> with messages like *"Unexpected role 'tool' after role 'user'"* because
> the translation layer between Claude Code and Ollama doesn't reconcile
> the two protocols. Other models (e.g. `glm-4.7:cloud`) are simply too
> slow per-call for a 30+ tool-call workflow. And smaller free-tier models
> (`nemotron-3-super:cloud`, `gemma4:31b-cloud`) tend to produce shallow
> "extract and truncate" summaries rather than real paraphrases, with
> occasional autoregressive repetition collapse. The defensive
> post-processors in `agent.ts` (`fixHallucinatedHostnames`,
> `elideRepetitionCollapse`, `elideDuplicateSections`,
> `liftHighlightsToTop`) cap the worst of this, but don't make a small
> model produce large-model-quality summaries. Test any new Ollama model
> with `--reuse-data` before pointing your daily cron at it.

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

### BGG notification feed

BGG's human-facing `/subscriptions` HTML page is behind a Cloudflare
"verify you are human" challenge that a headless cron can't pass. So instead of
scraping that page, the digest reads the same data BGG's own frontend uses — a
JSON notification feed in an API zone that is *not* behind the challenge:

1. `GET boardgamegeek.com/api/accounts/current` — authenticated by the saved
   login cookies — returns a short-lived `authToken`.
2. `GET api.geekdo.com/api/notice?sort=newest` — with `Authorization: GeekAuth
   <authToken>` — returns the notice list plus `essentialItems` (resolved titles
   and parent-game context for each item).

These calls go through Playwright's `ctx.request` HTTP client, which shares the
profile's cookie jar but performs **no page navigation** — so Cloudflare's
HTML-page challenge is never triggered. See `DEVELOPMENT_NOTES.md` for the full
discovery story.

Each notice carries a `group` (the thread/geeklist it belongs to), the new
`item`, a `trackingItem` (what to mark read to clear it), and a date.
`transformNotices()` groups notices by `group` into one subscription each and
captures:
- The earliest notice date in the group (`notificationDate`)
- The number of notices in the group (`unreadCount`)
- The specific new article/item IDs (`notifiedItemIds`)
- The title and parent-game context from `essentialItems`

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

**Already-read item bodies are excerpted.** When an old geeklist item picks up
a new comment, the item is selected but its body is content the reader saw on
a previous run. Those bodies are cut to a ~200-character lead plus an
`[earlier item — excerpt only]` marker, so the new comments still have an
anchor without paying full price for text already delivered. Items posted
*or edited* since the cutoff are never trimmed — there the body is the news.
Measured on SGOYT August 2026 (843 items): no effect early in the month,
rising to an 18% smaller data file by the 31st as activity shifts from new
posts to discussion on existing ones.

Fallback chain for both types when the primary path returns nothing:
1. `notifiedItemIds` — the specific item/article ID from the notice
2. `recentItems(maxItems)` / `recentArticles(maxItems)` — most-recent N by date

**Types we don't deep-fetch** (blog posts, file pages, videos, stand-alone
boardgame/comment notices) and **content we can't fetch** (e.g. a 1000+ post
thread whose new replies are past BGG's XML API window) are emitted as a
lightweight stub — title, parent context, and link — so the reader still knows
there's new activity. Because every processed notice is cleared on BGG after the
digest sends, a stub ensures nothing the feed reported is silently dropped.

### Replies aimed at you

Subscriptions where somebody responded to **you personally** are detected in
TypeScript (`src/bgg/self-activity.ts`) and flagged in the manifest as
`selfActivity`, so the ordering is deterministic rather than left to the
model. Flagged sections sort to the very top of the digest, carry a
`**💬 Replies to you:**` line, and lead the Highlights block.

Matching is deliberately **strict** — BGG forum threads are flat, with no
reply pointer, so "a reply to my post" can only ever be inferred. A thread
counts only if you started it or somebody quoted you. Merely having posted in
a thread does *not* count: the loose reading would promote every busy monthly
thread you once dropped a comment into, every night. Geeklists are different
— comments there attach to a specific item, so those attributions are real:

| Type     | Flagged when |
|----------|--------------|
| Thread   | you wrote the opening post and others replied |
| Thread   | a new post quotes you (`YourName wrote:`) |
| Geeklist | you own the list and others added items or comments |
| Geeklist | an item you contributed picked up comments |
| Geeklist | somebody commented after you on another member's item |

The thread rules need the opening post's author, which the `minarticledate`
window almost never includes, so each thread costs one extra
`thread?id=N&count=1` request. The notice feed can't supply it — its
`essentialItems` carry no author field of any kind.

**Known limitation:** this shares the digest's general blind spot — it can
only see what BGG still marks unread. Replies to you are exactly what you are
most likely to go read yourself before the 3am run, and that visit clears the
notice, so the digest never sees them.

### Chunked generation

Above `chunkSize` subscriptions (default 12), the digest is built in pieces
rather than one shot. The model degrades badly on large single runs: six
healthy runs at ≤21 subscriptions (2026-09-04 → 09-09) against four
degenerate ones at ≥31 (09-01, 09-02, 09-03, 09-10). The 09-10 run read all
31 subscriptions, wrote a Highlights block naming most of them, and emitted
exactly **one** section — then cleared 90 BGG notices, because nothing
compared what it rendered against what it was given.

The flow:

1. **Rank the whole set** (`src/interests.ts`) — replies to you, then
   `priority_titles` matches, then tracked games, then everything else.
   This happens in code, before the split, because a chunk cannot see the
   other chunks: "priority subscriptions first" is meaningless to a model
   looking at 12 of 31. That is why priority rules live in `interests.toml`.
2. **One pass per chunk**, sections only. Each is guarded and retried on its
   own, so a bad chunk costs a chunk rather than the night.
3. **One synthesis pass** over the assembled sections (`SECTIONS.md`) that
   writes only the Highlights block — so Highlights summarises what you will
   actually read, and its context stays small.

Runs at or under `chunkSize` take the original single-pass path untouched.

**Coverage.** While a split can still follow, a group must render *every*
subscription it was given — one missing section is 8% of a 12-item chunk, not
a rounding error, and a chunk that ships short has its missing subscription's
notices cleared and lost. Once splitting is exhausted the requirement relaxes
to the lenient 60% floor, because insisting on every section where nothing can
follow would discard the sections the model did produce.

**Escalation on failure.** A group that comes back defective is retried
*smaller* before it is written off: a failing 12 becomes 6 + 6, a failing 6
becomes 3 + 3. Degeneration is driven by how much the model is handed at once,
so a half-size retry has a real chance. Recursion is capped at two levels — if
the model is broken rather than overloaded, splitting cannot help, and an
uncapped retry would burn hours on a bad night. A single-pass run that fails
escalates the same way, dropping into the chunked path rather than shipping an
invalid digest.

Only the part that fails at *every* size is lost. If the first half of a group
never renders but the second half does, the second half ships.

Whatever is still lost is reported as skipped and **BGG notices are not
cleared** — the night re-fetches tomorrow rather than disappearing.

### Workspace-based agent invocation

The script splits cleanly: **fetch phase** writes data files; **agent phase**
runs an analyst that drives itself off the workspace.

After fetching, `./digest-data/` looks like this:

```
digest-data/
├── CLAUDE.md                  ← orchestration: copied from templates/workspace/
├── INTERESTS.md               ← reader's interests, copied from config.digest.interestsFile
├── manifest.json              ← list of subscriptions to process
├── templates/
│   ├── section.md             ← per-subscription markdown format reference
│   └── highlights.md          ← cross-subscription Highlights format reference
├── thread-3702528.md          ← per-subscription data files
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

**Session expired / `[ACTION REQUIRED] session expired` email** — the digest
authenticates to BGG's API with the login cookies in `./bgg-browser-profile/`.
Those remember-me cookies last ~30 days and refresh on use, but if they lapse
(or you've never logged in), `getAuthToken` fails and the run exits. Refresh
them with an interactive login:

```bash
npm start -- --reauth
```

This opens Chromium visibly, logs into BGG with your `config.json` credentials,
and saves fresh cookies to `./bgg-browser-profile/` so future headless cron
runs authenticate again. (Note: the digest itself never touches BGG's
Cloudflare-gated HTML pages — it uses the JSON API — so the old "solve the bot
challenge" step no longer applies.)

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
│   │   ├── notifications.ts  # Notification feed API client + transform + clear
│   │   ├── api.ts            # BGG XML API client (threads + geeklists) via ctx.request
│   │   ├── self-activity.ts  # Detects replies aimed at you (thread/geeklist rules)
│   │   ├── auth.ts           # Browser profile + interactive --reauth login
│   │   ├── scraper.ts        # (legacy) HTML /subscriptions scraping — kept dormant
│   │   └── page-content.ts   # (legacy) Playwright DOM fetch — kept dormant
│   ├── agent.ts             # File writing + Claude subprocess
│   ├── digest.ts             # Markdown assembly + file output
│   ├── index.ts              # Main orchestrator
│   ├── types.ts              # TypeScript interfaces
│   ├── config.ts             # Config loading + validation
│   ├── interests.ts          # Priority ranking + chunk splitting
│   └── logger.ts             # Logging
├── config.example.json       # Copy this to config.json
├── interests.toml            # Your personalization file (edit freely)
├── digests/                  # Generated digest files (gitignored)
├── digest-data/              # Per-subscription data files (recreated each run)
├── logs/                     # Run logs
└── bgg-browser-profile/      # Persistent Chromium session (gitignored)
```

## Notes on commenting style

The source code is heavily commented with Python equivalents throughout —
originally written to help a Python developer learn TypeScript patterns.
If you're comfortable with TypeScript, the comments are safe to ignore.
