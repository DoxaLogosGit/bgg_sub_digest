// ============================================================
// agent.ts — write subscription data files and invoke an agent (claude or tallow) to produce the digest
//
// ARCHITECTURE (file-based, replaces the old single-prompt approach):
//
//   1. For each outstanding BGG subscription, format its content and
//      write it to ./digest-data/[type]-[id].md
//
//   2. Write a manifest.json listing all subscription files with metadata.
//
//   3. Launch the configured agent with a prompt telling it to read the
//      manifest then each subscription file via its Read tool:
//        - Claude:  `claude --model <m> --dangerously-skip-permissions --print --output-format json`
//        - Tallow:  `tallow --model <m> --yolo --mode json --print "<prompt>"`
//
//   4. Parse the agent's response to extract the digest body AND token usage stats.
//
// WHY file-based instead of one big prompt:
//   - High-volume subscriptions (e.g. SGOYT with 400+ items behind) get their
//     own file — Claude reads it and summarizes by theme, rather than us trying
//     to cram everything into a 600K-char context window.
//   - Claude decides which files to read in depth vs. skim based on your interests.
//   - The JSON output format gives us exact token usage + cost for the digest footer.
//
// PYTHON CONTEXT: `claude --dangerously-skip-permissions --print` is Claude
// Code's headless mode. It reads a prompt from stdin, uses tools (like the
// Read tool to read files) without permission prompts, and prints output.
// We pass `--output-format json` to get a single JSON object with the full
// response plus token usage and cost statistics.
// We invoke it as a child process using spawnSync() — like Python's subprocess.run()
// with capture_output=True.
// ============================================================

// `spawnSync` runs a child process synchronously (blocks until it exits).
// `spawn` streams stdout/stderr — used for tallow whose JSONL output can
// `spawnSync` for claude (bounded JSON output); `spawn` streaming for tallow
// (large JSONL output exceeds spawnSync's buffer cap).
import { spawn, spawnSync } from 'child_process';

// `os` module — provides os.tmpdir() for the system's temp directory.
// Python: import tempfile; tempfile.gettempdir()
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import type { BggGeeklistItem } from './types';

// ============================================================
// formatThreadContent — format thread articles as plain text
// ============================================================
//
// Converts a list of thread articles into a readable text block
// for inclusion in the subscription data file. Claude gets plain text,
// not structured data, so readability matters more than parsability.
//
// PYTHON CONTEXT:
//   `Array<{ username: string; postdate: Date; ... }>` is TypeScript's
//   syntax for an array of inline anonymous object types. Python equivalent:
//   list[dict] or list[ArticleDict] with a TypedDict.
//
// The `export` keyword makes this available to index.ts which calls it
// after fetching each thread's articles.
export function formatThreadContent(
  threadSubject: string,
  // Inline object type for each article — no need for a named type here
  // since this shape is only used in this one function.
  articles: Array<{ username: string; postdate: Date; subject: string; body: string; link: string }>,
): string {
  // Build the output as an array of strings, then join them.
  // Python: lines = [f'=== Thread: {thread_subject} ===\n']
  const lines: string[] = [`=== Thread: ${threadSubject} ===\n`];

  // `for...of` iterates over array elements — same as Python's for loop
  for (const a of articles) {
    // .toLocaleDateString('en-US') formats as "1/15/2024" — human-readable
    // Python: a.postdate.strftime('%m/%d/%Y')
    const dateStr = a.postdate.toLocaleDateString('en-US');
    lines.push(`[Post by ${a.username} on ${dateStr}]`);
    if (a.subject) lines.push(`Subject: ${a.subject}`);  // Only add if non-empty
    lines.push(`Link: ${a.link}`);
    lines.push(renderQuotesAsBlockquotes(a.body));
    lines.push('');  // Blank line between articles for readability
  }

  // Array.join('\n') concatenates with newlines — Python: '\n'.join(lines)
  return lines.join('\n');
}

// ============================================================
// renderQuotesAsBlockquotes — convert BGG "Author wrote:" patterns to markdown
// ============================================================
//
// BGG renders quoted replies in its forum CSS as styled indented blocks; the
// XML API returns them as inline text starting with "Author wrote:" followed
// by the quoted content, then the new reply's text. After our stripMarkup
// preserves paragraph breaks, the structure is typically:
//
//   Username wrote:
//   <quoted text — possibly multi-paragraph>
//
//   <new reply text>
//
// We detect that pattern and rewrite the quote block as a markdown blockquote
// (lines prefixed with `> `), so it renders visually distinct in the digest
// markdown and in the email HTML.
//
// Heuristic: a "quote block" starts with a line matching `Author wrote:` and
// extends until the next blank line — at which point the new reply begins.
// Doesn't perfectly handle nested quotes (rare on BGG); single-level quotes
// cover ~95% of cases and are the visual disaster the digest had before.
function renderQuotesAsBlockquotes(body: string): string {
  if (!body) return body;

  // Regex matches `Author wrote:` at line start, captures author and the
  // following content up to (but not including) the next blank line.
  // - (?<=^|\n) — lookbehind for line start without consuming the newline.
  // - [\w'`-]+   allows usernames with apostrophes, backticks, hyphens.
  // - [\s\S]+?   non-greedy — stops at the first blank line or end of body.
  // No /m flag, so $ in the lookahead only means end-of-string (not end-of-line).
  const quoteRe = /(?<=^|\n)([\w'`-]+) wrote:\s*\n([\s\S]+?)(?=\n\s*\n|$)/g;

  return body.replace(quoteRe, (_match, author: string, quoted: string) => {
    const quotedLines = quoted
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `> **${author} wrote:**\n${quotedLines}`;
  });
}

// ============================================================
// formatGeeklistContent — format geeklist items as plain text
// ============================================================
//
// Same pattern as formatThreadContent but for geeklists.
// Includes each item's comments indented below the item.
//
// `notificationDate` — the earliest notification date scraped from BGG's
// subscription page. Comments newer than this date are labeled "[NEW]" so
// Claude knows which discussion was actually added since the last visit.
// If null (we couldn't parse a date), all comments are shown without labels.
//
// Python equivalent signature:
//   def format_geeklist_content(
//       title: str,
//       items: list[BggGeeklistItem],
//       notification_date: Optional[datetime] = None,
//   ) -> str:
export function formatGeeklistContent(
  geeklistTitle: string,
  items: BggGeeklistItem[],
  notificationDate: Date | null = null,  // `= null` is the default parameter value
): string {
  const lines: string[] = [`=== Geeklist: ${geeklistTitle} ===\n`];

  for (const item of items) {
    const dateStr = item.postdate.toLocaleDateString('en-US');

    // The last-activity date — whichever is later: postdate or editdate.
    // If editdate > postdate, the item was edited or had comments added.
    // Python: last_activity = max(item.postdate, item.editdate)
    const lastActivity = item.editdate > item.postdate ? item.editdate : item.postdate;
    const activityStr  = lastActivity.toLocaleDateString('en-US');

    // Mark the item as NEW if it was posted after the notification cutoff,
    // meaning the item itself was added to the geeklist since the last visit.
    // `notificationDate !== null && item.postdate > notificationDate`:
    //   — `!== null` checks notificationDate exists (not null or undefined)
    //   — `&&` short-circuits: if left side is false, right side is not evaluated
    //   Python: notification_date and item.postdate > notification_date
    const itemIsNew = notificationDate !== null && item.postdate > notificationDate;
    const newTag    = itemIsNew ? ' [NEW ITEM]' : '';

    // `—` is an em-dash character used for visual separation in the output.
    lines.push(`[Item by ${item.username} posted ${dateStr}, last activity ${activityStr}]${newTag} — ${item.objectName}`);
    lines.push(`Link: ${item.link}`);
    if (item.body) lines.push(item.body);

    // ---- Filter and label comments ----
    //
    // When we have a notificationDate, drop comments older than the cutoff
    // entirely — they were already read on a prior visit and just bloat the
    // file. Without a date, fall back to "10 newest" as a sensible cap.
    // Python: [c for c in item.comments if not notif_date or c.date > notif_date]
    const filteredComments = notificationDate !== null
      ? item.comments.filter((c) => c.date > notificationDate)
      : item.comments;

    const sortedComments = [...filteredComments]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 10);

    for (const c of sortedComments) {
      const cd = c.date.toLocaleDateString('en-US');
      lines.push(`  ↳ Comment by ${c.username} on ${cd}: ${c.body}`);
    }

    // Note if we capped (or filtered out) any comments
    const omitted = filteredComments.length > 10 ? filteredComments.length - 10 : 0;
    if (omitted > 0) {
      lines.push(`  ↳ (${omitted} older comments not shown)`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// ManifestEntry — metadata for one subscription's data file
// ============================================================
//
// PYTHON CONTEXT: `interface` is TypeScript's equivalent of a TypedDict
// or frozen @dataclass — just a shape description for the type checker,
// no runtime code generated. The `export` keyword makes it importable
// by index.ts.
//
// Python equivalent:
//   from typing import TypedDict, Optional, Literal
//   class ManifestEntry(TypedDict):
//       subscription_id: int
//       type: Literal['thread', 'geeklist', 'unknown']
//       title: str
//       url: str
//       file_path: str
//       item_count: int
//       notification_date: Optional[str]
export interface ManifestEntry {
  // BGG's internal numeric ID for this subscription
  subscriptionId: number;

  // 'thread' for forum threads, 'geeklist' for community curated lists,
  // plus the secondary types for game-page / blog / file-page subscriptions
  // that we follow for new content (no XML API but we scrape the HTML).
  type: 'thread' | 'geeklist' | 'boardgame' | 'boardgameexpansion' | 'blog' | 'filepage' | 'unknown';

  // Human-readable title (from BGG's notification page or API)
  title: string;

  // Canonical URL to this subscription's content page on BGG
  url: string;

  // Absolute filesystem path to the subscription's data file.
  // Claude reads this path using its Read tool.
  filePath: string;

  // How many items (articles / geeklist entries) are in the data file.
  // This is what we actually fetched — may differ from unreadCount.
  itemCount: number;

  // BGG's advertised count of unread posts/items/comments for this subscription,
  // parsed from the notification row summary text ("3 more replies", "12 new items").
  // 0 means we couldn't parse it — not the same as nothing new.
  // Geeklists may report separate item + comment counts which we sum.
  unreadCount: number;

  // ISO 8601 timestamp: when BGG last marked this subscription as read.
  // null if we couldn't parse a date from the notification row text.
  // Python: Optional[str]
  notificationDate: string | null;

  // The parent boardgame/expansion name when this thread or geeklist lives
  // inside a game's forum (e.g. "Nusfjord: Big Box"). Lets the digest group
  // and label related discussion. Captured from a sibling /boardgame URL in
  // the same notice row.
  parentName?: string;
}

// ============================================================
// DigestResult — return type of runClaudeDigest
// ============================================================
//
// Bundles Claude's markdown response with token usage stats parsed
// from the --output-format json output.
//
// PYTHON CONTEXT: `interface` here is like a TypedDict for a function's
// return value. The caller (index.ts) uses these fields to build the
// token usage footer in the digest.
// 'complete'     — every subscription rendered, Highlights produced
// 'partial'      — some subscriptions skipped after retries (model/timeout errors)
// 'rate_limited' — halted mid-digest after a 429; Highlights skipped
export type DigestStatus = 'complete' | 'partial' | 'rate_limited';

export interface DigestSkippedEntry {
  title:    string;
  filePath: string;
  reason:   string;
}

export interface DigestResult {
  body: string;          // Claude's full markdown digest text
  inputTokens: number;   // Total context tokens (prompt + cache hits + cache creation)
  outputTokens: number;  // Tokens in Claude's response
  costUsd: number;       // Estimated cost in USD (from total_cost_usd in JSON output)
  durationMs: number;    // Wall-clock time for the full Claude call
  // Per-subscription orchestration metadata. Optional — undefined for the
  // plain-claude single-call path; populated by the Ollama per-subscription
  // orchestrator. The caller uses these to flag the digest as PARTIAL or
  // RATE_LIMITED in the email subject and the body banner.
  status?:         DigestStatus;
  completedCount?: number;             // sections successfully rendered
  totalCount?:     number;             // total subscriptions in manifest
  skipped?:        DigestSkippedEntry[];
}

// ============================================================
// writeSubscriptionFile — write one subscription's content to disk
// ============================================================
//
// Creates ./digest-data/[type]-[id].md with the formatted text content.
// Returns the absolute path to the file that was written.
// The file is overwritten if it already exists (each run is fresh).
//
// PYTHON CONTEXT equivalent:
//   def write_subscription_file(sub: dict, content: str, digest_data_dir: str) -> str:
//       os.makedirs(digest_data_dir, exist_ok=True)
//       file_path = os.path.join(digest_data_dir, f"{sub['type']}-{sub['id']}.md")
//       Path(file_path).write_text(content, encoding='utf-8')
//       return file_path
export function writeSubscriptionFile(
  // Inline type: only needs type and id from the full BggSubscription object.
  // TypeScript structural typing means any object with these two fields will work.
  sub: { type: string; id: number },
  content: string,
  digestDataDir: string,
): string {
  // Create the directory if it doesn't exist.
  // { recursive: true } = like mkdir -p — no error if already exists.
  // Python: os.makedirs(digest_data_dir, exist_ok=True)
  if (!fs.existsSync(digestDataDir)) {
    fs.mkdirSync(digestDataDir, { recursive: true });
  }

  // Build the filename: "geeklist-123456.md" or "thread-789012.md"
  // Template literal: `${sub.type}-${sub.id}.md`
  // Python: f"{sub['type']}-{sub['id']}.md"
  const fileName = `${sub.type}-${sub.id}.md`;
  const filePath = path.join(digestDataDir, fileName);

  // Write (overwrite) the file synchronously.
  // Python: Path(file_path).write_text(content, encoding='utf-8')
  fs.writeFileSync(filePath, content, 'utf-8');
  log.debug('Subscription file written', { filePath, bytes: content.length });
  return filePath;
}

// ============================================================
// installWorkspaceTemplate — copy CLAUDE.md + templates/ into digest-data
// ============================================================
//
// The "workspace" pattern: digest-data/ contains everything the agent needs
// to do its job — manifest.json, subscription files, INTERESTS.md, CLAUDE.md
// (orchestration), and templates/ (format references). The agent runs with
// cwd=digestDataDir so it picks up CLAUDE.md automatically (claude-code and
// tallow both read CLAUDE.md from cwd).
//
// Source layout (in this repo): templates/workspace/
//   ├── CLAUDE.md
//   └── templates/
//       ├── section.md
//       └── highlights.md
//
// Destination (workspace): <digestDataDir>/
//   ├── CLAUDE.md                     (copied)
//   ├── templates/section.md          (copied)
//   ├── templates/highlights.md       (copied)
//   ├── INTERESTS.md                  (written from `interests` arg, if non-empty)
//   ├── manifest.json                 (written separately by writeManifest)
//   └── thread-*.md / geeklist-*.md   (written separately by writeSubscriptionFile)
//
// Called before EVERY agent invocation, including --reuse-data, so edits to
// templates/workspace/* take effect immediately on the next run.
export function installWorkspaceTemplate(
  digestDataDir: string,
  interests: string,
): void {
  // Source: templates/workspace/ relative to project root (where `npm start`
  // runs). process.cwd() is the project root in normal usage.
  const srcDir = path.join(process.cwd(), 'templates', 'workspace');
  if (!fs.existsSync(srcDir)) {
    log.warn(
      `Workspace template dir not found at ${srcDir} — agent will only see ` +
      `manifest.json and subscription data files (no CLAUDE.md / templates).`,
    );
    return;
  }

  // Recursive copy. Node 18+ supports fs.cpSync with { recursive: true }.
  fs.cpSync(srcDir, digestDataDir, { recursive: true });

  // Write the user's interests as INTERESTS.md inside the workspace, so
  // CLAUDE.md can reference it via the relative path "INTERESTS.md".
  // If interests is empty, write a stub so CLAUDE.md's reference still
  // resolves to a readable file.
  const interestsPath = path.join(digestDataDir, 'INTERESTS.md');
  fs.writeFileSync(
    interestsPath,
    interests.trim() ||
      '# Interests\n\nNo interests configured. Summarize all subscriptions equally; do not apply ⭐ prioritization.',
    'utf-8',
  );

  log.debug('Workspace template installed', { digestDataDir });
}

// ============================================================
// writeManifest — write manifest.json listing all subscription files
// ============================================================
//
// The manifest is Claude's index. It reads this first to discover
// what files are available, how many items each has, and when each
// subscription was last visited — giving it enough context to prioritize
// which files to read in depth vs. skim based on the interests file.
//
// Returns the absolute path to the manifest file.
//
// PYTHON CONTEXT:
//   def write_manifest(entries: list[ManifestEntry], digest_data_dir: str) -> str:
//       manifest_path = os.path.join(digest_data_dir, 'manifest.json')
//       Path(manifest_path).write_text(json.dumps(entries, indent=2), encoding='utf-8')
//       return manifest_path
export function writeManifest(entries: ManifestEntry[], digestDataDir: string): string {
  const manifestPath = path.join(digestDataDir, 'manifest.json');

  // JSON.stringify(value, null, 2):
  //   - value: the data to serialize
  //   - null: no custom replacer function
  //   - 2: indent with 2 spaces (human-readable)
  // Python: json.dumps(entries, indent=2)
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2), 'utf-8');
  log.debug('Manifest written', { manifestPath, subscriptions: entries.length });
  return manifestPath;
}

// ============================================================
// buildDigestPrompt — construct the task instructions for Claude
// ============================================================
//
// Private function (not exported) — only runClaudeDigest calls this.
// The prompt tells Claude:
//   1. What to do (build a BGG digest)
//   2. Where the data is (manifest path — exact absolute path)
//   3. How to format the output (section structure)
//   4. What to do for high-volume subscriptions (summarize by theme)
//   5. What the user cares about (interests file content)
//
// We give Claude explicit instructions to read ONLY the listed files —
// not to explore the filesystem — since it has full FS access via
// --dangerously-skip-permissions.
function buildDigestPrompt(
  _manifestPath: string,  // Unused — workspace's CLAUDE.md references manifest at ./manifest.json
  _interests: string,     // Unused — written to workspace's INTERESTS.md by installWorkspaceTemplate
): string {
  // The full instruction set lives in the workspace's CLAUDE.md (copied
  // there by installWorkspaceTemplate before each agent invocation).
  // We just give the agent a short trigger directive — the agent picks up
  // CLAUDE.md, INTERESTS.md, manifest.json, and templates/ from the cwd
  // (which is set to digestDataDir on spawn).
  //
  // Both claude-code and tallow read CLAUDE.md from cwd automatically.
  return `Build the BGG subscription digest. All instructions, ordering rules, and section/highlights format references are in this directory's CLAUDE.md and templates/. The reader's interests are in INTERESTS.md. The manifest of subscriptions to process is at ./manifest.json. Begin.`;
}

// ============================================================
// liftHighlightsToTop — move "## ⭐ Highlights" block from end to top
// ============================================================
//
// We instruct the model to write subscription sections first and the
// "## ⭐ Highlights" block last (see buildDigestPrompt). Reasoning:
//   - --print --output-format json is one-shot linear text. Models that put
//     Highlights first sometimes write a "[To be populated...]" placeholder
//     and never come back, because they can't edit their own output mid-run.
//   - With Highlights at the END, the model writes it as the final act of
//     generation, so it's either there in full or visibly missing.
// This helper reshapes the linear output for the reader so Highlights still
// appears at the top of the digest.
//
// Behaviour:
//   - Finds the LAST occurrence of a "## ⭐ Highlights" header (or "##
//     Highlights" without the star — some models drop it).
//   - Moves everything from that header onward to the front of the body.
//   - Strips any earlier (placeholder) Highlights blocks so we don't keep
//     a dead "[To be populated...]" stub above the real one.
//   - If no Highlights header is found at all, returns the body unchanged.
function liftHighlightsToTop(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;

  const headerRe = /^[ \t]*##[ \t]+(?:⭐[ \t]+)?Highlights[ \t]*$/gim;
  const matches: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(trimmed)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }

  if (matches.length === 0) return body;

  const last       = matches[matches.length - 1];
  const highlights = trimmed.slice(last.start).trim();
  let sections     = trimmed.slice(0, last.start).trim();

  // Remove earlier placeholder Highlights blocks (header + everything until
  // the next "##" or "###" header).
  if (matches.length > 1) {
    for (let i = matches.length - 2; i >= 0; i--) {
      const placeholder = matches[i];
      const after       = sections.slice(placeholder.end);
      const nextHeader  = /\n##+[ \t]+/.exec(after);
      const elideEnd    = nextHeader
        ? placeholder.end + nextHeader.index
        : sections.length;
      sections = (sections.slice(0, placeholder.start) + sections.slice(elideEnd)).trim();
    }
  }

  return `${highlights}\n\n${sections}`.trim();
}

// ============================================================
// fixHallucinatedHostnames — repair model URL substitutions
// ============================================================
//
// nemotron-3-super:cloud has been observed to drop "game" from
// "boardgamegeek.com" mid-generation, producing URLs like
// `https://boardgeek.com/thread/123` that 404 when the user clicks them.
// Pure autoregressive substitution — not in source data.
//
// "boardgeek.com" is not a substring of "boardgamegeek.com" (different
// 6th character), so unconditional global replace is safe.
function fixHallucinatedHostnames(body: string): string {
  const fixed = body.replace(/boardgeek\.com/g, 'boardgamegeek.com');
  if (fixed !== body) {
    const count = (body.match(/boardgeek\.com/g) ?? []).length;
    log.warn(`Repaired ${count} hallucinated "boardgeek.com" → "boardgamegeek.com"`);
  }
  return fixed;
}

// ============================================================
// stripPreamble — drop model "thinking out loud" before the digest body
// ============================================================
//
// CLAUDE.md tells the agent to begin its response DIRECTLY with the first
// subscription's "### [Title](URL)" header — no preamble, no plan. Strongly
// instruction-following models (claude, minimax-m2.5:cloud) obey. Others do
// not: minimax-m3:cloud (observed in the 2026-06-04 cron run) ignored it and
// emitted a block of planning narration BEFORE the digest:
//
//   Good, I've scanned the entire GMT P500 list. ...
//   Now I have all the information I need. Let me build the digest.
//   ### Plan
//   1. Priority Subscriptions ...
//   Now writing the digest. The output is the entire response ...
//   ### [1 Player Guild / SGOYT ...](https://...)   <-- real digest starts HERE
//
// That narration is "bad form" in the reader's morning email, and prompt-only
// hardening doesn't hold (the model ignores the existing "no planning
// sentences" rule). It's a one-shot stream we can't ask the model to edit, so
// we strip it here, post-hoc.
//
// ANCHOR: the first real content marker — whichever comes FIRST of:
//   - a section header   "### [Title](URL)"  (/^[ \t]*###[ \t]+\[/m)
//   - the Highlights block "## (⭐ )?Highlights"
// Everything before that anchor is preamble and gets dropped.
//
// Why anchor on "### [" (with the bracket) and not a bare "###": the plan
// itself uses sub-headers like "### Plan". Bracket-anchoring lets "### Plan"
// fall INTO the stripped region while the real first section ("### [..](..)")
// survives as the anchor.
//
// Why ALSO consider the Highlights header: a model could legitimately put
// "## ⭐ Highlights" first (liftHighlightsToTop supports that layout). We must
// not mistake a leading Highlights block for preamble and delete it.
//
// Safety valve: if NEITHER anchor is found (totally malformed output), return
// the body unchanged rather than nuke everything.
//
// ORDERING: this MUST run before elideDuplicateSections and liftHighlightsToTop
// (see postProcessDigestBody). If a stray plan line ever looked like a real
// "### [Title]" header, dedup would keep the plan's copy and drop the real
// section; stripping the preamble first removes that hazard entirely.
function stripPreamble(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;

  // First bracketed section header, e.g. "### [Earthborne Rangers](https://...)".
  // /m makes ^ match at the start of any line, not just the whole string.
  const sectionRe   = /^[ \t]*###[ \t]+\[/m;
  // First Highlights header, with or without the leading star. /i = case-insensitive.
  const highlightRe = /^[ \t]*##[ \t]+(?:⭐[ \t]+)?Highlights[ \t]*$/im;

  const sectionMatch   = sectionRe.exec(trimmed);
  const highlightMatch = highlightRe.exec(trimmed);

  // Keep only the anchors that actually matched, then take the earliest offset.
  // The `.filter((i): i is number => ...)` is a TypeScript type guard — it tells
  // the compiler the surviving values are definitely numbers (not undefined).
  // Python: offsets = [i for i in (a, b) if i is not None]
  const offsets = [sectionMatch?.index, highlightMatch?.index]
    .filter((i): i is number => typeof i === 'number');
  if (offsets.length === 0) return body;   // no anchor at all → leave untouched
  const anchor = Math.min(...offsets);

  if (anchor === 0) return trimmed;        // already starts cleanly, nothing to strip

  const stripped = trimmed.slice(anchor).trim();
  log.warn(`Stripped ${anchor} chars of model preamble before the digest body`);
  return stripped;
}

// ============================================================
// postProcessDigestBody — the full output-cleanup pipeline
// ============================================================
//
// Both the claude and tallow paths produce a raw markdown body that needs the
// same defensive cleanup before it becomes the digest. Composing the steps in
// ONE place keeps the two call sites in sync and makes the pipeline testable
// in isolation (see agent.preamble.test.ts).
//
// Order matters, read inside-out (the innermost call runs first):
//   1. stripPreamble            — drop model planning narration up front
//   2. fixHallucinatedHostnames — repair "boardgeek.com" → "boardgamegeek.com"
//   3. elideRepetitionCollapse  — cut runaway autoregressive line loops
//   4. elideDuplicateSections   — drop a section rendered twice (keep first)
//   5. liftHighlightsToTop      — move the trailing Highlights block to the top
//
// stripPreamble is innermost so the preamble is gone before dedup (which keys
// off "### [Title]" headers) and before the Highlights lift reshuffles things.
export function postProcessDigestBody(body: string): string {
  return liftHighlightsToTop(
    elideDuplicateSections(
      elideRepetitionCollapse(
        fixHallucinatedHostnames(
          stripPreamble(body),
        ),
      ),
    ),
  );
}

// ============================================================
// elideDuplicateSections — drop sections rendered twice
// ============================================================
//
// Models occasionally render the entire digest, then start over and
// render it again — usually the second copy is partial / abbreviated.
// Walk all "### [Title](URL)" headers; for any title that appears more
// than once, keep the first occurrence and elide everything from the
// duplicate header through the start of the next header (or end of body).
function elideDuplicateSections(body: string): string {
  // Match section headers: "### [Title](URL)" at start of line.
  const headerRe = /^[ \t]*###[ \t]+\[([^\]]+)\]/gm;
  type Match = { title: string; start: number };
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(body)) !== null) {
    matches.push({ title: m[1].trim(), start: m.index });
  }

  if (matches.length < 2) return body;

  // Identify duplicate ranges (start of dup header → start of next header
  // or end of body). Keep first occurrence of each title.
  const seen:        Set<string> = new Set();
  const elideRanges: { start: number; end: number }[] = [];
  for (let i = 0; i < matches.length; i++) {
    const t = matches[i].title;
    if (seen.has(t)) {
      const end = i + 1 < matches.length ? matches[i + 1].start : body.length;
      elideRanges.push({ start: matches[i].start, end });
    } else {
      seen.add(t);
    }
  }

  if (elideRanges.length === 0) return body;

  // Apply elides in reverse so earlier offsets remain valid.
  let out = body;
  for (let i = elideRanges.length - 1; i >= 0; i--) {
    out = out.slice(0, elideRanges[i].start) + out.slice(elideRanges[i].end);
  }

  log.warn(`Elided ${elideRanges.length} duplicate section(s) from agent output`);
  return out;
}

// ============================================================
// elideRepetitionCollapse — strip runaway autoregressive loops
// ============================================================
//
// Some Ollama-served models (notably nemotron-3-super:cloud) hit
// repetition collapse on long generations: the autoregressive sampler's
// next-token entropy collapses and the model emits the same line over
// and over until it hits the output cap. Output looks like:
//
//   [Post by mattrob77 on 5/4/2026] — Notes they have decided to ...
//   [Post by mattrob77 on 5/4/2026] — Notes they have decided to ...
//   [Post by mattrob77 on 5/4/2026] — Notes they have decided to ...
//   ... (200 more copies) ...
//
// This burns the entire output budget on garbage AND clobbers the
// Highlights block we asked the model to write last. Defensive
// truncation: detect runs of 3+ trimmed-identical lines longer than
// MIN_LINE_CHARS, keep the first occurrence, replace the tail with a
// marker. Doesn't fix the model — just salvages the surrounding digest
// so we get a usable output instead of pages of nothing.
function elideRepetitionCollapse(body: string): string {
  const MIN_RUN_LENGTH = 3;
  const MIN_LINE_CHARS = 30;  // skip short separators like "---" or single-token bullets
  const lines = body.split('\n');
  const out:   string[] = [];
  let totalElided = 0;

  let i = 0;
  while (i < lines.length) {
    const line    = lines[i];
    const trimmed = line.trim();

    if (trimmed.length < MIN_LINE_CHARS) {
      out.push(line);
      i++;
      continue;
    }

    // Count consecutive identical (trimmed) lines.
    let runLength = 1;
    while (i + runLength < lines.length && lines[i + runLength].trim() === trimmed) {
      runLength++;
    }

    if (runLength >= MIN_RUN_LENGTH) {
      // Keep the first occurrence, elide the rest.
      out.push(line);
      const elidedCount = runLength - 1;
      totalElided += elidedCount;
      out.push(
        `\n*(⚠️ Model entered a repetition loop here — ${elidedCount} additional copies of the same line elided. ` +
        `Likely cause: autoregressive degeneration on a high-volume section. The digest may be truncated or missing the Highlights block as a result.)*\n`,
      );
      i += runLength;
    } else {
      out.push(line);
      i++;
    }
  }

  if (totalElided > 0) {
    log.warn(`Elided ${totalElided} repeated line(s) from agent output (repetition collapse)`);
  }

  return out.join('\n');
}

// ============================================================
// runClaudeDigest — launch claude with file access and parse the result
// ============================================================
//
// Writes the prompt to a temp file, launches:
//   claude --dangerously-skip-permissions --print --output-format json
// which reads the manifest and subscription files autonomously, then
// parses the JSON response to extract the digest text and token stats.
//
// The JSON response structure (verified empirically):
//   {
//     "type": "result",
//     "result": "...markdown digest...",
//     "total_cost_usd": 0.046,
//     "duration_ms": 45000,
//     "usage": {
//       "input_tokens": 3,
//       "cache_creation_input_tokens": 9095,
//       "cache_read_input_tokens": 33826,
//       "output_tokens": 136
//     }
//   }
//
// PYTHON CONTEXT equivalent:
//   def run_claude_digest(manifest_path: str, interests: str) -> DigestResult:
//       prompt = build_digest_prompt(manifest_path, interests)
//       with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
//           f.write(prompt)
//           tmp = f.name
//       try:
//           result = subprocess.run(
//               f'claude --dangerously-skip-permissions --print --output-format json < "{tmp}"',
//               shell=True, capture_output=True, text=True, timeout=1200
//           )
//           parsed = json.loads(result.stdout)
//           usage = parsed.get('usage', {})
//           return DigestResult(body=parsed['result'], ...)
//       finally:
//           os.unlink(tmp)
export function runClaudeDigest(
  manifestPath: string,
  interests: string,
  model = 'opus',
  // When true, route claude through `ollama launch claude --model <m> --yes`,
  // which sets the Anthropic env vars and points claude at the local Ollama
  // OpenAI-compatible endpoint. The `model` arg is then an Ollama model id
  // (e.g. "nemotron-3-super:cloud"). See:
  // https://docs.ollama.com/integrations/claude-code
  useOllama = false,
): DigestResult {
  const prompt = buildDigestPrompt(manifestPath, interests);

  // Write prompt to a temp file — avoids shell argument length limits.
  // Python: with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
  const tmpFile = path.join(os.tmpdir(), `bgg-digest-prompt-${Date.now()}.txt`);

  // `try { ... } finally { ... }` ensures the temp file is always deleted.
  // Python: try: ... finally: os.unlink(tmp_file)
  try {
    fs.writeFileSync(tmpFile, prompt, 'utf-8');
    log.debug('Launching claude with --dangerously-skip-permissions', {
      manifestPath,
      promptLength: prompt.length,
    });

    // Launch claude in headless mode with:
    //   --model opus                    : use Claude Opus for higher quality digest writing
    //   --dangerously-skip-permissions  : no approval prompts for file reads
    //   --print                         : read from stdin, print result to stdout
    //   --output-format json            : return a JSON object with result + usage stats
    //
    // Timeout is 20 minutes — file reading adds multiple round-trips vs. a single prompt.
    // Python: subprocess.run(..., shell=True, capture_output=True, text=True, timeout=1200)
    // Cron runs with a minimal PATH that typically doesn't include ~/.local/bin
    // or wherever `claude` was installed. We extend the inherited PATH with the
    // common locations so spawnSync can find the binary regardless of how this
    // process was launched (interactive shell vs. cron vs. systemd timer).
    const home = process.env.HOME ?? '';
    const extraPaths = [
      `${home}/.local/bin`,           // npm global on Linux (most common for claude)
      `${home}/.npm-global/bin`,      // npm with custom prefix
      `${home}/.nvm/versions/node/current/bin`, // nvm current
      '/usr/local/bin',               // homebrew / manual installs
    ].filter(Boolean);
    const augmentedPath = [...extraPaths, process.env.PATH ?? ''].join(':');

    // ollama launch claude --model X --yes -- <claude-flags>
    //   --yes : auto-answer any setup prompt non-interactively
    //   --    : everything after this is passed to claude itself
    // The `<` redirect feeds the prompt to claude's stdin through ollama.
    const claudeFlags = `--dangerously-skip-permissions --print --output-format json`;
    const cmd = useOllama
      ? `ollama launch claude --model ${model} --yes -- ${claudeFlags} < "${tmpFile}"`
      : `claude --model ${model} ${claudeFlags} < "${tmpFile}"`;

    const result = spawnSync(cmd, {
      shell:     true,
      encoding:  'utf-8',
      // cwd = digest-data so claude reads the workspace's CLAUDE.md and
      // templates/ automatically. Both claude-code and tallow read
      // CLAUDE.md from the cwd.
      cwd:       path.dirname(manifestPath),
      // 45-minute hard cap. Anthropic-backed runs typically finish in 1–2 min,
      // but Ollama-backed runs (claude-ollama) routinely take 5–15 min and
      // have high variance day-to-day; cron hits the slow tail. Matches/exceeds
      // tallow's 30-min ceiling.
      timeout:   45 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,  // 20 MB max output buffer
      env:       { ...process.env, PATH: augmentedPath },
    });

    // `result.error` is set if spawnSync itself failed (e.g. command not found).
    // This is different from a non-zero exit code — it's a Node.js-level spawn error.
    // Python: subprocess.SubprocessError vs. result.returncode != 0
    if (result.error) throw result.error;

    // .trim() strips leading/trailing whitespace — Python: result.stdout.strip()
    const rawOutput = result.stdout?.trim() ?? '';

    if (result.status !== 0) {
      // Non-zero exit = claude CLI reported an error.
      // With --output-format json, claude writes a structured error object to
      // STDOUT (not stderr) — e.g. when Ollama returns 404 for an unknown
      // model, the body contains {is_error:true, api_error_status:404,
      // result:"There's an issue with the selected model..."}. Surface that
      // text instead of an empty stderr message.
      let detail = '';
      if (rawOutput) {
        try {
          const parsed = JSON.parse(rawOutput) as {
            result?: string;
            is_error?: boolean;
            api_error_status?: number;
          };
          if (parsed.is_error && parsed.result) {
            detail = parsed.api_error_status
              ? `[HTTP ${parsed.api_error_status}] ${parsed.result}`
              : parsed.result;
          }
        } catch {
          // Not JSON — fall through and use raw stdout as the diagnostic.
          detail = rawOutput.slice(0, 500);
        }
      }
      if (!detail) detail = result.stderr?.slice(0, 500) ?? '';
      throw new Error(
        `claude CLI exited with code ${result.status}: ${detail || '(no output)'}`,
      );
    }

    if (!rawOutput) throw new Error('claude CLI returned empty output');

    // Save the raw JSON output to logs/ so we can post-mortem when the body
    // comes back empty or malformed. Always save BEFORE any validation that
    // might throw — this is the only copy of the response.
    let rawPath = '';
    try {
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      rawPath = path.join(logsDir, `claude-raw-${stamp}.json`);
      fs.writeFileSync(rawPath, rawOutput, 'utf-8');
      log.debug('Claude raw JSON saved', { rawPath, bytes: rawOutput.length });
    } catch (writeErr) {
      log.warn('Could not save raw claude JSON', { err: String(writeErr) });
    }

    // Detect empty result — model completed but produced no text (hit max
    // output tokens during synthesis, looped on tool calls, or stopped to
    // ask a clarifying question). ?? won't catch empty string; check after saving.
    {
      let numTurns: number | undefined;
      let hasEmptyResult = false;
      try {
        const quick = JSON.parse(rawOutput) as Record<string, unknown>;
        numTurns = typeof quick['num_turns'] === 'number' ? quick['num_turns'] : undefined;
        hasEmptyResult = 'result' in quick && !quick['result'];
      } catch { /* fall through to the full parse below */ }
      if (hasEmptyResult) {
        throw new Error(
          `claude CLI returned an empty result after ${numTurns ?? '?'} turn(s) — ` +
          `model likely hit max_tokens during synthesis or looped on tool calls. ` +
          `Raw response saved to ${rawPath || 'logs/claude-raw-*.json'}`,
        );
      }
    }

    log.debug('Claude file-based digest received', { outputLength: rawOutput.length });

    // ---- Parse the JSON response ----
    //
    // Declare the expected shape using a TypeScript inline type.
    // `?` suffix means the field may be absent — optional chaining (?.) handles that below.
    // Python equivalent type hints:
    //   result: Optional[str]
    //   total_cost_usd: Optional[float]
    //   duration_ms: Optional[int]
    //   usage: Optional[dict]
    let parsed: {
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      };
    };

    try {
      // JSON.parse() converts a JSON string to a JavaScript object.
      // Python: json.loads(raw_output)
      // `as { ... }` is a TypeScript type assertion — tells the compiler what shape to expect.
      // At runtime it's just JSON.parse() — no actual validation.
      parsed = JSON.parse(rawOutput) as typeof parsed;
    } catch {
      // JSON parse failed — shouldn't happen with --output-format json, but be safe.
      // Fall through with raw text and zero token stats.
      log.warn('Could not parse claude JSON output — using raw text, token stats unavailable');
      return {
        body:         rawOutput,
        inputTokens:  0,
        outputTokens: 0,
        costUsd:      0,
        durationMs:   0,
      };
    }

    // ---- Extract token usage ----
    //
    // BGG's API tokens break into three categories we sum for "input":
    //   input_tokens                : the literal prompt tokens we sent
    //   cache_creation_input_tokens : tokens used to CREATE a new cache entry (billed normally)
    //   cache_read_input_tokens     : tokens served FROM cache (cheaper but still "used")
    //
    // We sum all three so the footer shows total context consumed.
    // Python: sum(v for k, v in usage.items() if k != 'output_tokens')
    const u = parsed.usage ?? {};  // `?? {}` = empty object if usage is missing
    const inputTokens =
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);

    return {
      body:         postProcessDigestBody(parsed.result ?? rawOutput),
      inputTokens,
      outputTokens: u.output_tokens ?? 0,
      costUsd:      parsed.total_cost_usd ?? 0,
      durationMs:   parsed.duration_ms ?? 0,
    };

  } finally {
    // Always delete the temp file, even if an error was thrown above.
    // fs.unlink() is async with a no-op callback — fire and forget.
    // Python: os.unlink(tmp_file)  (in finally block, synchronous)
    fs.unlink(tmpFile, () => undefined);
  }
}

// ============================================================
// ============================================================
// runTallowDigest — launch tallow with file access and parse JSONL events
// ============================================================
//
// Tallow (https://github.com/dungle-scrubs/tallow) is an alternative coding
// agent that speaks the same Read-tool dance as Claude Code but supports
// arbitrary providers (ollama, anthropic, openai, etc.) via its config.
//
// CLI shape:
//   tallow --model <model> --yolo --mode json --print "<prompt>"
//     --yolo       : auto-approve all tool confirmations (parallel of --dangerously-skip-permissions)
//     --mode json  : emit JSON Lines — one JSON event per line on stdout
//     --print      : single-shot run; the prompt is passed as an argument (not via stdin)
//
// Provider selection is left to the user's ~/.tallow/settings.json
// `defaultProvider` (typically "ollama"). Override per-invocation by editing
// that file or by including `provider/model` in the model string if tallow
// supports it for the chosen backend.
//
// JSONL event shape we care about (verified empirically against tallow 0.9.x):
//   {"type":"session", ...}                      // first line, has session id
//   {"type":"message_start", ...}
//   {"type":"message_end", ...}
//   {"type":"turn_end","message":{
//      "role":"assistant",
//      "content":[
//        {"type":"thinking","thinking":"..."},   // present when the model has a reasoning step
//        {"type":"tool_use", ...},               // when calling Read etc.
//        {"type":"text","text":"...digest md..."}
//      ],
//      "usage":{
//        "input":N, "output":N,
//        "cacheRead":N, "cacheWrite":N,
//        "totalTokens":N,
//        "cost":{"input":..., "output":..., "total":...}
//      }
//   }, "toolResults":[...]}
//
// IMPORTANT: there are typically MANY turn_end events (one per tool round).
// Tool-only turns may have empty/no `text` items — we walk back to the last
// turn whose content contains a non-empty `text` chunk to grab the digest
// body. Token usage is summed across every turn_end so the footer reflects
// the full cost of the run.
export async function runTallowDigest(
  manifestPath: string,
  interests: string,
  model = 'qwen3-coder-next:cloud',
): Promise<DigestResult> {
  const prompt = buildDigestPrompt(manifestPath, interests);

  // tallow accepts the prompt directly as a CLI argument — no temp file
  // needed. spawn with args array bypasses shell quoting, so embedded
  // quotes/backticks/newlines in the prompt are safe.
  const home = process.env.HOME ?? '';
  const extraPaths = [
    `${home}/.bun/bin`,                         // bun-installed tallow (the typical install)
    `${home}/.local/bin`,                       // npm global on Linux
    `${home}/.npm-global/bin`,                  // npm with custom prefix
    `${home}/.nvm/versions/node/current/bin`,   // nvm current
    '/usr/local/bin',                           // homebrew / manual installs
  ];
  const augmentedPath = [...extraPaths, process.env.PATH ?? ''].join(':');

  log.debug('Launching tallow with --yolo --mode json (streaming)', {
    manifestPath,
    model,
    promptLength: prompt.length,
  });

  const args = [
    '--yolo',
    '--mode', 'json',
    '--model', model,
    '--print', prompt,
  ];

  // ---- Stream tallow's JSONL output ----
  //
  // We use streaming spawn instead of spawnSync because tallow's JSONL grows
  // unboundedly with tool rounds (each Read tool call's full file contents
  // get echoed back as a tool_result event). Long digests with chatty models
  // were hitting ENOBUFS on the 50MB spawnSync cap. Streaming has no cap and
  // also lowers peak memory because we keep only the parsed turn_end events
  // (small) and discard everything else line-by-line.
  type TallowUsage = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { input?: number; output?: number; total?: number };
  };
  type TallowContent = { type: string; text?: string };
  type TallowEvent = {
    type: string;
    message?: { content?: TallowContent[]; usage?: TallowUsage };
  };

  // Wall-clock the run so we can populate durationMs (tallow's JSONL doesn't
  // include a top-level duration like Claude's --output-format json does).
  const start = Date.now();
  const proc  = spawn('tallow', args, {
    // cwd = digest-data so tallow picks up the workspace's CLAUDE.md and
    // templates/ from there. Tallow scans both .claude/ and .tallow/ in cwd
    // and reads CLAUDE.md natively.
    cwd:   path.dirname(manifestPath),
    env:   { ...process.env, PATH: augmentedPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Hard timeout — kill tallow if it hangs (e.g. local model deadlock).
  const TIMEOUT_MS = 30 * 60 * 1000;
  const timeoutHandle = setTimeout(() => {
    log.warn(`tallow exceeded ${TIMEOUT_MS}ms timeout — killing process`);
    proc.kill('SIGKILL');
  }, TIMEOUT_MS);

  // Only retain turn_end events — every other event type is discarded as it
  // streams in, keeping memory bounded regardless of digest size.
  const turnEnds: TallowEvent[] = [];
  let stdoutTail   = '';     // partial last line awaiting a newline
  let stderrChunks = '';     // capped stderr for error diagnostics
  let totalBytes   = 0;

  proc.stdout.setEncoding('utf-8');
  proc.stdout.on('data', (chunk: string) => {
    totalBytes += chunk.length;
    stdoutTail += chunk;
    let nl: number;
    while ((nl = stdoutTail.indexOf('\n')) !== -1) {
      const line = stdoutTail.slice(0, nl).trim();
      stdoutTail = stdoutTail.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as TallowEvent;
        if (ev.type === 'turn_end') turnEnds.push(ev);
      } catch {
        // Skip un-parseable lines defensively.
      }
    }
  });

  proc.stderr.setEncoding('utf-8');
  proc.stderr.on('data', (chunk: string) => {
    if (stderrChunks.length < 4000) stderrChunks += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      // Flush any trailing line that didn't end with \n.
      const last = stdoutTail.trim();
      if (last) {
        try {
          const ev = JSON.parse(last) as TallowEvent;
          if (ev.type === 'turn_end') turnEnds.push(ev);
        } catch { /* skip */ }
      }
      if (code !== 0) {
        reject(new Error(
          `tallow exited with code ${code}: ${stderrChunks.slice(0, 1000)}`,
        ));
        return;
      }
      resolve();
    });
  });
  const durationMs = Date.now() - start;

  log.debug('Tallow stream complete', {
    bytesRead:  totalBytes,
    turnEnds:   turnEnds.length,
    durationMs,
  });

  if (turnEnds.length === 0) {
    throw new Error(
      `tallow produced no turn_end events (${totalBytes} bytes read). ` +
      `stderr: ${stderrChunks.slice(0, 500)}`,
    );
  }

  // ---- Pull the digest body ----
  //
  // Walk turn_ends from newest backward and grab the text from the first
  // one that has a non-empty `type:'text'` item. Tool-only turns contribute
  // no body text. The prompt instructs the agent to write the entire digest
  // in a single final response, so the last turn with text SHOULD be the
  // synthesis.
  let body = '';
  for (let i = turnEnds.length - 1; i >= 0; i--) {
    const text = (turnEnds[i].message?.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0)
      .map((c) => c.text as string)
      .join('\n');
    if (text) {
      body = text;
      break;
    }
  }
  if (!body) {
    throw new Error(
      `tallow ran ${turnEnds.length} turn(s) but no turn produced assistant text. ` +
      `Model may have looped on tool calls without ever synthesizing.`,
    );
  }

  // ---- Sum usage across all turn_end events ----
  let inputTokens  = 0;
  let outputTokens = 0;
  let costUsd      = 0;
  for (const ev of turnEnds) {
    const u = ev.message?.usage ?? {};
    inputTokens  += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    outputTokens += u.output ?? 0;
    costUsd      += u.cost?.total ?? 0;
  }

  return {
    body: postProcessDigestBody(body),
    inputTokens, outputTokens, costUsd, durationMs,
  };
}

// ============================================================
// runDigest — dispatch to claude / claude-ollama / tallow based on agent name
// ============================================================
//
// 'claude'        — claude CLI against Anthropic's API. Original tool-loop
//                   pattern; effectively unbounded context with caching.
// 'claude-ollama' — claude CLI redirected at local Ollama via
//                   `ollama launch claude --model X --yes`. Same tool-loop
//                   pattern as plain claude. Item-cap truncation in the
//                   data-fetch phase keeps total context within the 200K
//                   model window so degeneration doesn't trigger.
// 'tallow'        — tallow CLI (its own provider routing).
export type AgentName = 'claude' | 'claude-ollama' | 'tallow';

export async function runDigest(
  agent: AgentName,
  manifestPath: string,
  interests: string,
  model?: string,
): Promise<DigestResult> {
  if (agent === 'tallow') {
    return runTallowDigest(manifestPath, interests, model);
  }
  // Both 'claude' and 'claude-ollama' share runClaudeDigest — the only
  // difference is whether we route through `ollama launch claude` to point
  // at the local Ollama endpoint (true) or talk to Anthropic directly (false).
  return runClaudeDigest(manifestPath, interests, model, agent === 'claude-ollama');
}
