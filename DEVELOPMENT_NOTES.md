# BGG Subscription Digest — Development Notes

*Last updated: 2026-04-30*

---

## Project Overview

A TypeScript script that generates a daily/weekly markdown digest of new
activity across your BGG (BoardGameGeek) subscriptions — threads and geeklists.

**Why it exists:** BGG's notification page tells you something is new, but
you still have to click into each subscription individually. This script
fetches everything outstanding, writes it to structured files, and uses
Claude to produce a single prioritized digest ordered by your interests.

**Key constraint:** BGG is behind Cloudflare TLS fingerprinting. Plain
Node.js `fetch()` gets rejected even with valid cookies. All HTTP to BGG
must go through Playwright's Chromium renderer (`page.evaluate()`) so the
TLS handshake comes from a real browser.

---

## Architecture

### Flow

```
1.  Playwright logs into BGG (persistent profile in ./bgg-browser-profile/)
2.  Scraper reads /subscriptions — collects outstanding subscriptions,
    notification dates, and unread counts from notification row text
3.  For each subscription: BGG XML API fetches full content
    - Threads:    XML API v2  /xmlapi2/thread?id=N&minarticledate=...
    - Geeklists:  XML API v1  /xmlapi/geeklist/N?comments=1 (filtered locally)
    - Blogs/files: Playwright renders the page and extracts DOM content
4.  Items filtered to "new since last visit" using notificationDate cutoff
5.  Each subscription written to ./digest-data/[type]-[id].md
6.  manifest.json written with metadata (title, url, itemCount, unreadCount, etc.)
7.  claude --model <model> --dangerously-skip-permissions --print --output-format json
    reads the manifest, reads each file with its Read tool, produces digest
    (model defaults to opus; override with `npm start -- --model sonnet`)
8.  Token usage stats appended to digest footer
9.  Final markdown written to ./digests/bgg-digest-YYYY-MM-DD.md
10. Digest emailed via Resend (optional — only if email config is present)
```

### Key Files

| File | Purpose |
|------|---------|
| `src/bgg/auth.ts` | Playwright login + persistent browser profile |
| `src/bgg/scraper.ts` | Scrapes /subscriptions; parses notification dates + unread counts |
| `src/bgg/api.ts` | BGG XML API client; date-based item/article filters |
| `src/bgg/page-content.ts` | Playwright DOM fetch for blogs + file pages (no XML API) |
| `src/agent.ts` | Writes digest-data files; invokes Claude; parses JSON response |
| `src/digest.ts` | Wraps Claude's output with header; writes final .md file |
| `src/email.ts` | Converts digest to HTML; sends via Resend API |
| `src/index.ts` | Main orchestrator; PID lock; model arg parsing; token usage footer |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/config.ts` | Zod-validated config.json loader |
| `config.json` | BGG credentials + API key (gitignored, chmod 600) |
| `interests.md` | Plain-text description of what you care about — passed to Claude |

### No State File

There is no `state.json`. BGG's subscription notification page is the source
of truth. Whatever BGG marks as outstanding gets processed; once BGG marks it
read (via `clearSubscriptionShortcut`), it won't appear next run.

---

## How "What's New" Detection Works

BGG's notification page shows **one row per subscription** — a link to the
**oldest unread** entry plus summary text like "3 more replies" or
"12 new items, 5 new comments." It does NOT give you a complete list of every
new item.

### Two signals extracted from each row

**`notificationDate`** — the timestamp shown in the row text ("Apr 20",
"2 hours ago", etc.). This is the date of the oldest unread entry, which
makes it the right cutoff for "show me everything newer than this."

**`unreadCount`** — BGG's advertised total of unread posts/items/comments,
parsed from the row summary text. Included in the manifest so Claude knows
the true scale. Still being tuned — check debug logs on first runs.

### Filtering strategy — threads vs. geeklists differ

**Threads** — IDs first, date as fallback:
1. `notifiedItemIds` — BGG shows one row per thread WITH a specific article ID.
   Threads have many rows (one per new reply), so IDs are precise.
2. `notificationDate` (30-day lookback via `minarticledate`) — catches brand-new
   threads where the URL has no `/article/N` fragment yet.
3. Most-recent N by recency (last resort).

**Geeklists** — date first, IDs as fallback:
1. `notificationDate` — BGG shows ONE row per geeklist regardless of how many
   items are new, so `notifiedItemIds` only has a single entry (useless for
   SGOYT with 200+ items behind).
2. `notifiedItemIds` — fallback for edge cases where date parsing failed.
3. Most-recent N by recency (last resort).

The distinction was critical for SGOYT: using IDs-first (as Session 4 had it)
returned only 1 item. Switching geeklists to date-first returns all items since
the notification date.

---

## Claude Integration

### Old approach (single prompt)

All subscription content was concatenated into one giant string (capped at
600K chars) and piped to `claude --print`. This had two problems:

- Hard 600K-char limit dropped content from high-volume subscriptions
- The agent got everything at once with no ability to prioritize depth of reading

### New approach (file-based)

Each subscription is a separate file. The agent reads the manifest first, then
reads each file using its built-in Read tool. This means:

- No size cap — SGOYT with 400+ items behind gets its own file
- The agent can skim low-priority files and read high-priority ones in full
- The JSON output format (`--output-format json` for Claude, `--mode json` for Tallow) gives us token usage + cost

### Agent CLI flags

**Claude:**
```
claude --model <model> --dangerously-skip-permissions --print --output-format json
```

**Tallow:**
```
tallow --model <model> --yolo --mode json --print
```

#### Model parameter
- `--model <model>` — configurable at runtime via `npm start -- --model sonnet`.
  Defaults to `opus` for Claude, `ollama/qwen3-coder-next:cloud` for Tallow.
  Sonnet costs ~5× less for Claude; Haiku for cheap test runs.

#### Agent selection
- `--agent <agent>` — chooses between `claude` (default) or `tallow`.
  Tallow is a lightweight alternative that may be cheaper depending on the model.

### Claude extra flags
- `--dangerously-skip-permissions` — no approval prompts for Read tool calls
- `--print` — headless mode, reads prompt from stdin
- `--output-format json` — single JSON response with `result`, `total_cost_usd`,
  `duration_ms`, and `usage` (input/output/cache tokens)

### Tallow mode
- `--mode json` — outputs JSON Lines (one JSON object per line) with session events
- The digest is embedded in assistant message events
- Token usage is available in usage objects within those events

### JSON response shape — Claude (verified empirically)

```json
{
  "type": "result",
  "result": "...markdown digest...",
  "total_cost_usd": 0.046,
  "duration_ms": 45000,
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 9095,
    "cache_read_input_tokens": 33826,
    "output_tokens": 136
  }
}
```

### Tallow response format (verified empirically against tallow 0.9.x)

Tallow's `--mode json` emits **JSON Lines** — one event per stdout line.
The events we care about:

- `{"type":"session", ...}` — first line, session id and metadata
- `{"type":"message_start", ...}` / `{"type":"message_end", ...}` — per message
- `{"type":"turn_end", "message":{...}, "toolResults":[...]}` — emitted once
  per assistant turn (one per Read-tool round, plus a final synthesis turn)

Each `turn_end.message` shape:

```json
{
  "role": "assistant",
  "content": [
    {"type": "thinking", "thinking": "..."},
    {"type": "tool_use", "...": "..."},
    {"type": "text", "text": "...digest markdown..."}
  ],
  "api": "openai-completions",
  "provider": "ollama",
  "model": "omnicoder-oc",
  "usage": {
    "input": 8600, "output": 44,
    "cacheRead": 0, "cacheWrite": 0,
    "totalTokens": 8644,
    "cost": {"input": 0, "output": 0, "total": 0}
  }
}
```

**Parsing strategy in `runTallowDigest()`:**

1. Split stdout on `\n`; `JSON.parse` each non-empty line; skip un-parseable
   lines (defensive — under `--mode json` we don't expect any).
2. Filter to `type === 'turn_end'` events.
3. **Body:** walk the `turn_end` list from newest backward; take the text
   from the first turn whose `content[]` has at least one non-empty
   `type:'text'` chunk. Tool-only turns contribute no body, so this skips
   them. Local models don't always honor "single response" so the LAST
   text-bearing turn is the safest grab.
4. **Tokens:** sum `input + cacheRead + cacheWrite` for "input"; sum
   `output` separately. Sum `cost.total` across every turn for the run cost.
5. **Duration:** wall-clock around `spawnSync` (tallow JSONL doesn't carry
   a top-level duration like Claude does).

### Why Tallow was added (Session 6, May 2026)

A daily digest on Claude Opus consumes ~400K tokens — a substantial
fraction of the Claude Pro 5-hour usage window. To preserve that budget for
interactive coding, the agent layer was generalized to support a second
backend: Tallow + Ollama. Local Ollama models are zero-cost; Ollama cloud
models are far cheaper than Claude. Claude is still the default and remains
available on demand for higher-quality runs.

**Files touched:**
- `src/agent.ts` — added `runTallowDigest()`, `runDigest()` dispatcher,
  and `AgentName` type. `runClaudeDigest()` left untouched.
- `src/index.ts` — parse `--agent` and `--model` from argv; default model
  varies by agent. Replaced direct `runClaudeDigest()` call with
  `runDigest(agent, ...)`.
- README + this file — usage docs.

**Verified end-to-end** against `omnicoder-oc` (local) and
`qwen3-coder-next:cloud` (Ollama cloud). Both produced correctly formatted
digests and correct token/duration stats.

---

## Bugs Fixed (Sessions 2–3, April 2026)

### 1. Thread article links 404ing
**File:** `src/bgg/api.ts`  
**Problem:** Article links were built as `${threadLink}&article=47597099`.
The `&` before any `?` is not valid URL syntax — every link 404'd.  
**Fix:** `${link}${link.includes('?') ? '&' : '?'}article=${articleId}`

### 2. Notification date parsed as year 2001
**File:** `src/bgg/scraper.ts` → `parseNotificationDate()`  
**Problem:** BGG omits the year for current-year dates (shows "Apr 20" not
"Apr 20, 2026"). `new Date("Apr 20")` in Node.js V8 silently returns
April 20, **2001**. This made `notificationDate` useless as a filter cutoff —
every item since 2001 was "new."  
**Fix:** If the matched date string has no 4-digit year, append the current
year before constructing the Date. Step back one year if the result is
in the future (handles Dec→Jan edge case).

### 3. Only 1–2 items shown for active subscriptions
**Files:** `src/index.ts`, `src/bgg/api.ts`  
**Problem:** Filtering exclusively to `notifiedItemIds` only ever captured the
single oldest-unread-link ID that BGG surfaced in its notification row. For
the April 2026 Culling thread with 4 new posts, only 1 was captured. For
SGOYT with 400+ new items, only 2–3 appeared.  
**Fix:** Added `articlesNewerThan()` and `itemsNewerThan()` (both in
`api.ts`). Both threads and geeklists now use `notificationDate` as the
primary filter, falling back to `notifiedItemIds` only when no date is
available.

### 4. Architecture: single giant prompt → file-based
**Files:** `src/agent.ts` (full rewrite), `src/index.ts` (major update)  
**Problem:** 57 subscriptions × 15 items × ~700 chars approached the 600K
context limit. High-volume subscriptions had to be capped aggressively.
Claude had no ability to adjust depth based on content.  
**Fix:** File-based architecture described above.

### 5. Token usage not visible
**Files:** `src/index.ts` (`formatTokenUsage()`), `src/agent.ts` (JSON parsing)  
**Feature added:** Token usage + cost + duration appended to every digest:
```
---
*Token usage: 43,924 input + 1,234 output (45,158 total) | Cost: ~$0.0463 | 45.2s*
```

---

## Bugs Fixed (Session 4, April 2026)

### 6. False notification dates from titles containing "April 2026"
**File:** `src/bgg/scraper.ts` → `parseNotificationDate()`
**Problem:** The month-name regex `/\b(jan|feb|...|apr|...)\s+\d{1,2}/` was greedy
and matched "April 20" out of "April 2026 Shopping" because `\d{1,2}` happily
consumes the first two digits of a year, leaving the remaining "26" unmatched.
This made every subscription whose title contained a month-and-year string
(SGOYT, monthly culling threads, etc.) get `notificationDate=2026-04-20`,
pulling in months of irrelevant content.
**Fix:** Add `\b` after `\d{1,2}` so the day requires a word boundary. Two
adjacent digits have no boundary between them, so "April 2026" no longer matches.

### 7. Date / unread count came from the wrong DOM element
**File:** `src/bgg/scraper.ts`
**Problem:** Original scraper read `gg-item-link-ui.textContent` and tried to
extract date + unread count from it. That element only contains the breadcrumb
link text (e.g. "April 2026 Shopping") — neither the date nor any count info.
A live-DOM diagnostic confirmed the actual structure:
- Each new item is one `<gg-notice>` "row".
- Notices are grouped under `<h3 class="subscription-date-title">` headings
  ("Today", "Yesterday", "Apr 21, 2026") — the section header IS the date for
  every row beneath it.
- Row text contains TOTAL counts ("11 Replies", "436 GeekList Items"), not
  unread. The unread count for a subscription is the *number of notice rows*
  pointing at it.
**Fix:** Walk `document.querySelectorAll('h3.subscription-date-title, gg-notice')`
in document order, tracking the last-seen header to date-stamp each notice.
Use `unreadCount += 1` per row instead of regex-parsing text.

### 8. Filtering preferred date over exact item IDs
**File:** `src/index.ts`
**Problem:** When a subscription had both `notificationDate` and
`notifiedItemIds`, the old code ran `articlesNewerThan(date)` first and
fell back to IDs only if zero matched. Combined with bug #6's bogus dates,
this dragged in everything since "April 20".
**Fix:** Reverse the priority — `notifiedItemIds` is the most precise signal
BGG gives us (one ID per new article), so try it first. Date filter is the
fallback for brand-new threads where the URL has no `/article/N` fragment.
Recency cap is the last resort.

### 9b. Long threads returned archived (oldest) articles instead of new ones
**File:** `src/bgg/api.ts` → `fetchThread()`
**Problem:** BGG XML API v2's `/thread?id=N` endpoint returns the OLDEST 1000
articles by default — chronologically from the thread's beginning. For long
threads (Dad Jokes had 1795 articles since 2019, "What's on your table this
weekend?" ~1000+, etc.), the new replies are never in the response. Confirmed
by direct probe: thread 2188280 with no params returned articles from
2019-04-18 to 2021-10-18, missing every 2026 reply.
**Fix:** Pass `minarticledate=YYYY-MM-DD HH:mm:ss` (BGG's required date
format — ISO with `T` separator returns 400). Use a 30-day lookback before
`notificationDate` because BGG's /subscriptions page shows only ONE row per
thread (the newest unread reply). Earlier unread replies on the same thread
are older than `notificationDate` itself, so a window is needed to catch
them all. After the fix, the same thread returns the 2 actual unread replies.

### 9. Subscriptions with zero matched items still appeared in the digest
**File:** `src/index.ts`
**Problem:** When all three filters (IDs, date, recency) returned an empty
list, the code wrote an empty manifest entry and a near-empty file. The
digest got bloated with empty stub sections.
**Fix:** Skip the subscription entirely (no file, no manifest entry) when the
filter chain produces nothing. The Claude run also skips low-value content.

---

### 11. Game-page / blog / filepage subscriptions silently dropped
**Files:** `src/bgg/scraper.ts`, `src/index.ts`, `src/bgg/page-content.ts` (new)
**Problem:** `URL_PATTERNS` only recognized `/thread/N` and `/geeklist/N`. Any
notification whose primary URL was `/boardgame`, `/boardgameexpansion`,
`/blog`, or `/filepage` had no matching pattern and was silently filtered out
by `classifyUrl(...) → null`. The user noticed Nusfjord and Navajo Wars
(both `/filepage` and `/boardgame` subscriptions) never appeared.
**Fix:**
- Extended URL patterns to include the four extra types (ordered so /thread
  and /geeklist still win when both appear in the same notice).
- Added `extractParentBoardgame()` to capture the parent game name from a
  sibling `/boardgame` link. Uses the **anchor text** (proper "Marvel
  Champions: The Card Game" with colon) rather than slugifying the URL
  (which loses punctuation). Stored on `BggSubscription.parentName` and
  passed through to the manifest entry.
- For `blog` and `filepage` subs, added `src/bgg/page-content.ts` which
  navigates to the URL in Playwright, waits for the SPA to render, and
  extracts post body + comments via DOM selectors verified against the
  live site on 2026-04-28:
  - Blog: `h1.blog-post__headline`, `.blog-post__body`, `article.post .post-body`
  - File page: `h1.caption-title`, `article.post .post-body`
- Updated the Claude prompt to use `parentName` for ordering and labeling,
  and to include EVERY subscription with new content (low-priority ones can
  be one-line summaries — never silently omitted).

### 10. clearSubscriptionShortcut targeted the wrong DOM
**File:** `src/bgg/scraper.ts` → `clearSubscriptionShortcut()`
**Problem:** Original implementation queried `gg-shortcut` cards in the
sidebar, which are the user's *pinned shortcuts* — not the per-notification
clear control. Result: only ever cleared the user's own pinned bookmarks
(e.g. "1 Player Guild Trading Post"), never the actual notifications.
**Fix:** Each `<gg-notice>` row contains a per-row `button.quick-read-btn`
(captured in the diagnostic at `logs/row-dom-diagnostic.json#markAsReadCapture`).
The button is `tw-invisible tw-hidden` until hovered, so Playwright's
mouse-based click is unreliable — instead, find the button and call
`.click()` on the DOM element via `page.evaluate()`. This bypasses
visibility checks. We click every notice matching the subscription's URL
fragment in a single `evaluate()` call (DOM mutations between calls would
otherwise invalidate ElementHandles).

## Features Added (Session 5, April 2026)

### 12. Configurable Claude model via CLI argument
**Files:** `src/agent.ts`, `src/index.ts`
**Problem:** Model was hardcoded to `opus`. A single digest run was consuming
~400K tokens, eating a significant portion of the 5-hour Pro plan usage window.
**Fix:** `runClaudeDigest()` accepts a `model` parameter (default `'opus'`).
`index.ts` parses `--model <name>` from `process.argv` and passes it through.
Usage: `npm start -- --model sonnet` (Sonnet costs ~5× less for same context).

### 13. Email delivery via Resend
**Files:** `src/email.ts` (new), `src/config.ts`, `src/index.ts`
**Why:** Digest was only written to disk. To get it without opening a terminal,
email delivery was added using [Resend](https://resend.com) (free tier: 3,000/month).
**Implementation:**
- `marked` npm package converts markdown to HTML in one call — Gmail renders
  the full structure (headers, bold, bullets, links) from this HTML.
- `resend` npm package sends the email; `EmailConfig` interface mirrors the
  config schema shape (`resendApiKey`, `from`, `to`).
- `src/email.ts` exports `sendDigestEmail()` and `buildEmailSubject()`.
- Config schema has an optional `email` block — omitting it disables the feature
  entirely, no code changes needed.
- Email is sent AFTER the digest file is written. A send failure logs the error
  and returns `false` — it never kills the digest run.
- Subject format: `BGG Digest — Thursday, April 30, 2026`

---

## Session 7 (May 2026) — claude-ollama agent + reliability work

Triggered by tallow regressing in 0.9.x: the `--model` flag started being
silently ignored (always falling back to `~/.tallow/settings.json`'s
`defaultModel`), so every "different model" test was secretly the same
model — and that model hit Ollama's weekly compute-time quota.

### 14. Added `--agent claude-ollama`

Third agent option: runs the same `claude` binary used for `--agent claude`
but redirected at a local Ollama OpenAI-compatible endpoint. The user's
weekly Ollama quota is per-account compute-time (not per-model), so this
gives them a way to use Ollama models through Claude Code's tool-use
protocol when tallow is broken.

Two paths considered:
- **Direct env vars** — set `ANTHROPIC_AUTH_TOKEN=ollama`,
  `ANTHROPIC_API_KEY=""`, `ANTHROPIC_BASE_URL=http://localhost:11434`, then
  exec `claude` directly. Fast (~5s startup).
- **`ollama launch claude` wrapper** — Ollama's official integration command
  that does the same thing but with extra setup (~60s+ startup overhead per
  invocation).

Settled on the wrapper for the main one-call path (overhead amortizes over
a multi-minute digest) and direct env vars for the per-subscription
single-shot path (overhead × 41 = unusable).

### 15. Per-subscription orchestrator (added then reverted)

When the all-in-one tool-loop call started failing on Ollama-served models
(degenerate output: nemotron-3-super hit repetition collapse, mistral-large-3
hit context-window over-summarization and dropped 23/41 sections), tried a
per-subscription single-shot orchestrator: read each manifest entry's
content directly in the orchestrator code, call the model once per
subscription with that content inlined (no tool loop), aggregate.

Reverted after one real run. Two reasons:
1. **Compute-time cost ~13× the all-in-one path** — Ollama bills GPU time,
   and per-call setup destroys prompt caching. 2-hour wall clock vs 9 min.
2. **High failure rate from cloud-side throttling** — ~20% of calls timing
   out at 4 min, each timeout = 4 min of GPU time burned for zero output.

Useful infrastructure left behind: `DigestStatus` (`'complete' | 'partial'
| 'rate_limited'`) and `skipped[]` fields on `DigestResult`, banner-and-
subject-prefix logic in `index.ts` for non-complete runs. Currently unused
(the all-in-one path doesn't surface partial state) but available if we
ever add fallback handling there.

### 16. Hard cap on every selection path

Was: `maxNewItemsPerSubscription` was only applied as the last-resort
fallback. The date-filter and notifiedIds primary paths returned unbounded
counts (whatever fit in the lookback window).

Now: every selection path delegates to `recentArticles` / `recentItems`
(sort by latest activity descending, take top N) when over the cap. Logs
`Capped X at N most-recent (dropped M older)` on truncation. Total digest
context shrunk from ~7M cumulative input tokens to ~200K — keeps the model
inside the 200K-window degenerate-output zone safely.

### 17. Fixed thread lookback bug — was 30-day, should be `notificationDate`

`notificationDate` (per scraper.ts) is the **earliest** unread row date —
the oldest post we haven't seen yet. Old comment claimed it was the latest
unread reply and used `notificationDate − 30 days` as the API
`minarticledate`, pulling in a month of already-read content every run.

Fixed: pass `notificationDate − 2h` (small buffer for hour-precision
boundaries) as the API `minarticledate`, and also belt-and-braces filter
client-side to drop anything older. Per-thread window now matches actual
unread activity: 1-day-old notification = ~1 day of posts.

### 18. Highlights-at-end + post-process lift

Was: prompt told the model to write `## ⭐ Highlights` first. With
medium-sized models on `--print --output-format json` (one-shot linear
text), the model would write a `[To be populated...]` placeholder
intending to come back later — then run out of output budget before
ever filling it in.

Now: prompt tells the model to write all subscription sections FIRST and
the `## ⭐ Highlights` block LAST. `liftHighlightsToTop()` post-processes
the linear output, moves the trailing Highlights to the top of the body,
and elides any earlier placeholder Highlights blocks. Either Highlights
is present in full (ideal), or visibly missing (debuggable) — never the
silent placeholder.

### 19. "Each subscription appears exactly once" rule

Was: ordering rule said "place priority subs first, then tracked-game
subs, then ..." — interpreted by some models as "process each sub once
per category", producing duplicates with `[Already processed in priority
section]` markers.

Now: explicit "Each subscription appears EXACTLY ONCE in the output. If
it matches multiple categories, place it in the FIRST matching one and
do not list it again. Do NOT use '[Already processed]' placeholders or
any other cross-reference markers."

### 20. Renamed `debugClear` → `clearSubs` (with flipped semantics)

Was: `debugClear: true` meant "DON'T clear (just log)" — confusing
double-negative.

Now: `clearSubs: true` means "actually clear (click BGG's mark-as-read
button)". `false` = debug/log-only mode. Default `false` (safer).

### 21. Workspace-based agent invocation (replaces inline mega-prompt)

Inspired by analysis-agent patterns where a workspace folder governs the
agent's behavior via CLAUDE.md + skills + templates, with the launching
script just saying "Go".

Before: `buildDigestPrompt()` returned a 70+ line inline prompt with all
the rules (manifest schema, section format, ordering, output rules,
anti-planning, exactly-once, etc.) baked into a single string.

After: `templates/workspace/` in the project root holds the rules:
```
templates/workspace/
├── CLAUDE.md              ← orchestration / workflow / ordering rules
└── templates/
    ├── section.md         ← per-section markdown format reference
    └── highlights.md      ← Highlights block format reference
                             (pins the exact "## ⭐ Highlights" header
                              that liftHighlightsToTop matches against)
```

`installWorkspaceTemplate(digestDataDir, interests)` (in `agent.ts`)
recursively copies `templates/workspace/*` into `digest-data/` and writes
`INTERESTS.md` from the user's interests config. Called from
`runAgentAndWriteDigest()` before every agent invocation, including
`--reuse-data`, so prompt edits take effect immediately on the next run.

`buildDigestPrompt()` shrunk from ~70 lines to a single trigger sentence:
> Build the BGG subscription digest. All instructions, ordering rules, and
> section/highlights format references are in this directory's CLAUDE.md
> and templates/. The reader's interests are in INTERESTS.md. The manifest
> of subscriptions to process is at ./manifest.json. Begin.

Both spawn calls (claude in `runClaudeDigest`, tallow in `runTallowDigest`)
set `cwd: path.dirname(manifestPath)` (which is `digest-data/`), so the
agent picks up `CLAUDE.md` automatically. Both Claude Code and tallow read
CLAUDE.md from cwd natively (per tallow's
[Packages & Claude Code compatibility](https://tallow.dungle-scrubs.com/)
docs).

Manifest entries' `filePath` values stay absolute (the agent's Read tool
resolves them regardless of cwd, so absolute paths just work).

**What this buys us:**
- Edit prompt rules without rebuilding TypeScript or restarting cron.
- Same workspace serves all three agents (claude, claude-ollama, tallow).
- Self-contained: digest-data/ has everything an analyst needs to work
  independently.

**What we deliberately deferred:**
- A `.claude/skills/*` folder. Claude Code skills are description-matched at
  invocation, not bound to slash commands or auto-run. CLAUDE.md alone
  covers the single-workflow we need. Skills can be added later if we ever
  want multi-skill composition.

### 22. Repetition-collapse defensive truncation

`nemotron-3-super:cloud` (and other Ollama-served models) occasionally hit
autoregressive repetition collapse on long generations: the next-token
entropy collapses and the model emits the same line over and over until
it hits the output cap. One observed run had ~270 byte-identical copies
of `[Post by mattrob77 on 5/4/2026] — Notes they have decided to try
their copy of Marvel Champions again...` consuming the entire 32K output
budget AND clobbering the Highlights block.

`elideRepetitionCollapse(body)` (in `agent.ts`) detects this defensively:
runs of 3+ trimmed-identical lines longer than 30 chars get the first
occurrence kept, the rest replaced with a marker:

> *(⚠️ Model entered a repetition loop here — N additional copies of the
> same line elided. Likely cause: autoregressive degeneration on a
> high-volume section. The digest may be truncated or missing the
> Highlights block as a result.)*

Applied before `liftHighlightsToTop`, so any Highlights that did manage
to render still gets lifted. Doesn't fix the model — just ensures a
usable digest comes out instead of pages of nothing.

Both `runClaudeDigest` and `runTallowDigest` apply it.

### 23. Hallucinated-hostname repair + duplicate-section elide

Added two more defensive post-processors after observing nemotron-3-super
do all three failure modes in one run:

1. **`fixHallucinatedHostnames(body)`** — global regex replace of
   `boardgeek.com` → `boardgamegeek.com`. The model dropped "game" from
   "boardgamegeek" mid-generation in dozens of links; "boardgeek.com" is
   not a substring of "boardgamegeek.com" (different 6th character) so
   unconditional replace is safe. Logs the count of repairs.

2. **`elideDuplicateSections(body)`** — walks all `### [Title](URL)`
   headers; if any title appears twice (the model occasionally renders
   the entire digest then starts over), keep the first occurrence and
   elide everything from the duplicate header through the start of the
   next header (or end of body). Logs the count of elided sections.

Post-process chain in both `runClaudeDigest` and `runTallowDigest` is
now (right-to-left, applied left-to-right):

```
liftHighlightsToTop(
  elideDuplicateSections(
    elideRepetitionCollapse(
      fixHallucinatedHostnames(body)
    )
  )
)
```

Order rationale: hostname fix is atomic and structure-neutral (do first);
line-level dedup is structure-neutral (next); section-level dedup
operates on `###` headers (next); highlights lift moves a known block
(last). Chain is idempotent — running it twice produces the same output.

### 24. Tallow `/trust-project` requirement (debugging gotcha)

Tallow refuses to invoke its tools (Read, Write, etc.) in untrusted
directories. When invoked via `--print` against an untrusted workspace,
the agent reads the prompt, declares the task complete, and produces a
1-line response like `"Task completed."` because every tool call silently
no-ops. Footer signature: ~100K input tokens (no file reads) instead of
the expected ~600K-1M, and ~5K output tokens of nothing.

Fix: `cd <dir> && tallow` then `/trust-project` (interactive command),
applied separately to project root, `digest-data/`, and `digests/`.
Documented in README.md under "First-run setup for `--agent tallow`".

This is a tallow design choice, not a bug — but it's a silent failure
mode (no error in either tallow output or our parser) that wasted ~7
minutes of compute discovering. Worth checking the input-token count in
the digest footer as a sanity signal that real tool calls happened.

## Known Limitations / Future Work

- **Geeklist item links** — Built as `#item{id}` fragment. Not confirmed to
  scroll to the right item on all browsers. Does not cause 404s.

- **`notificationDate` precision** — "Today" is parsed as midnight of today.
  Articles posted today but before midnight (i.e. the previous day in UTC)
  could be over- or under-included depending on local timezone. Acceptable.

- **Cost / token usage** — A digest with ~80 subscriptions on Opus can consume
  ~400K tokens, a significant fraction of the Claude Pro 5-hour usage window.
  Use `npm start -- --model sonnet` to cut token consumption ~5× at some cost
  to digest depth and quality. For Ollama-routed paths, item-cap truncation
  (Session 7 item 16) keeps cost bounded.

- **Output token cap** — `nemotron-3-super:cloud` and similar Ollama models
  cap output at ~32K tokens. With 41 subscriptions + Highlights, tight but
  usually fits. If digests start truncating mid-stream, lower
  `maxNewItemsPerSubscription` to ~30 or filter out itemCount=1 trade/auction
  subs in the manifest builder.
