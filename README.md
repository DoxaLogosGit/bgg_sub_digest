# BGG Subscription Digest

Generates a daily or weekly markdown digest of new activity across your
[BoardGameGeek](https://boardgamegeek.com) subscriptions (threads and
geeklists), summarized and prioritized by Claude AI based on your interests.

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
- **Claude Code CLI** (`claude`) installed and authenticated
  — this script uses `claude --print` as its AI engine, so it runs on your
  existing Claude subscription rather than requiring a separate Anthropic API key
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
    "debugClear":                 true
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
| `digest.maxNewItemsPerSubscription` | `15` | Fallback cap when date-based filter isn't available |
| `digest.headless` | `true` | Set `false` on first run to watch Chromium and solve any Cloudflare challenge manually |
| `digest.interestsFile` | `./interests.md` | Path to your interests file (see below) |
| `digest.debugClear` | `true` | `true` = log what would be cleared but don't actually click; set `false` once you've verified targeting is correct |

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

### Running on a schedule (cron)

```cron
# Run every morning at 7am
0 7 * * * cd /path/to/bgg_sub_digest && npm start >> logs/cron.log 2>&1
```

The script uses a PID lock file (`./bgg-digest.pid`) to prevent overlapping
runs if a previous one is still in progress.

## How it works

### BGG notification page

BGG's `/subscriptions` page shows **one row per new item** (not per subscription).
A thread with 5 new replies appears as 5 rows; a geeklist with 3 new comments
appears as 3 rows. Rows are grouped under date headings ("Today", "Yesterday",
"Apr 21, 2026"). Each row's URL encodes the specific article or item ID that
triggered the notification.

The scraper aggregates rows by subscription, capturing:
- The list of specific item/article IDs flagged (`notifiedItemIds`)
- The earliest date heading any of those rows appeared under (`notificationDate`)
- The total number of rows for that subscription (`unreadCount`)

### "What's new" detection

Filter priority for each subscription:

1. **`notifiedItemIds`** — the precise set of new articles/items BGG flagged.
   This is the strongest signal we have and is preferred when present.
2. **`notificationDate`** — used for brand-new threads where BGG's URL has
   no `/article/N` fragment, so no specific ID was extractable. Includes
   anything posted after that date.
3. **Recency cap** — last resort: `recentArticles(maxItems)` /
   `recentItems(maxItems)`. Capped at `maxNewItemsPerSubscription`.

Subscriptions whose filter chain returns zero matches are skipped — no
empty stub sections in the digest.

### File-based Claude integration

Each subscription's content is written to `./digest-data/[type]-[id].md`.
A `manifest.json` is written listing all files with metadata including
`unreadCount` (BGG's advertised total) and `itemCount` (what was fetched).

Claude reads the manifest first, then reads each subscription file using its
Read tool, and produces the full digest. This means:

- No hard size limit — large geeklists get their own file
- Claude can skim low-priority subscriptions and read high-priority ones fully
- The digest prompt respects your `interests.md` for ordering and highlighting

Claude runs with `--model opus` for best summarization quality.

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
`unreadCount` field in the manifest will be 0 if BGG's row text format
didn't match our parser — check the debug logs for the raw row text.

**Links 404** — should be fixed as of April 2026. Thread article links use
`?article=ID` format. Geeklist item links use `#itemID` fragments (correct
page, may not scroll to exact item depending on browser).

## Project structure

```
bgg_sub_digest/
├── src/
│   ├── bgg/
│   │   ├── auth.ts        # Playwright login + browser profile
│   │   ├── scraper.ts     # Notification page scraping
│   │   └── api.ts         # BGG XML API client
│   ├── claude.ts          # File writing + Claude subprocess
│   ├── digest.ts          # Markdown assembly + file output
│   ├── index.ts           # Main orchestrator
│   ├── types.ts           # TypeScript interfaces
│   ├── config.ts          # Config loading + validation
│   └── logger.ts          # Logging
├── config.example.json    # Copy this to config.json
├── interests.md           # Your personalization file (edit freely)
├── digests/               # Generated digest files (gitignored)
├── digest-data/           # Per-subscription data files (recreated each run)
├── logs/                  # Run logs
└── bgg-browser-profile/   # Persistent Chromium session (gitignored)
```

## Notes on commenting style

The source code is heavily commented with Python equivalents throughout —
originally written to help a Python developer learn TypeScript patterns.
If you're comfortable with TypeScript, the comments are safe to ignore.
