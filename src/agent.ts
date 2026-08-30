// ============================================================
// agent.ts — write subscription data files and invoke an agent (claude or pi) to produce the digest
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
//        - pi:      `pi --print --mode json --approve --provider <p> --model <m> "<prompt>"`
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
// `spawn` streams stdout/stderr — used for pi whose JSONL output can
// `spawnSync` for claude (bounded JSON output); `spawn` streaming for pi
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
export type DigestStatus = 'complete' | 'partial' | 'rate_limited' | 'invalid' | 'error';

// ============================================================
// isTemplateEcho — detect a digest that is just the unfilled template
// ============================================================
//
// Failure mode (observed 2026-06-26 with ollama/minimax-m2.5:cloud): instead of
// FILLING IN the per-section / highlights template, the model copies the format
// EXAMPLES out of digest-data/templates/{highlights,section}.md verbatim into
// its output. The result is structurally valid markdown — so nothing downstream
// notices — but every section is placeholder boilerplate ("2–4 sentences on
// what's new…", "Bullet per notable item (max 8)…", "<Tracked game>"). It then
// gets emailed AND the subscriptions get cleared, losing the real activity.
//
// These sentinel strings are copied straight from the template files and would
// never occur in a genuinely-written digest (verified: 0 occurrences in a good
// run, 25+ in the bad one). We require >= 2 distinct hits so that a digest which
// happens to quote one phrase in prose can't trip the guard.
const TEMPLATE_SENTINELS = [
  'Bullet per notable item (max 8)',
  'comma-separated list of matched interests',
  'one-line summary of where it appeared',
  'only include this line if',
  '<Tracked game>',
  '<Subscription Title>',
  '<one-line summary',
];

export function isTemplateEcho(body: string): boolean {
  let hits = 0;
  for (const sentinel of TEMPLATE_SENTINELS) {
    if (body.includes(sentinel)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

// ============================================================
// isMissingHighlights — detect a digest with no Highlights block
// ============================================================
//
// Failure mode (observed 2026-07-02 with ollama/minimax-m3:cloud): the model
// degenerated mid-run (re-rendering 25 duplicate sections, leaking reasoning)
// and never emitted the "## ⭐ Highlights" block at all. liftHighlightsToTop
// silently passes such a body through unchanged, so the pipeline shipped a
// header-less digest AND cleared 42 BGG notices — the same data-loss class as
// the template echo, through a different door.
//
// We accept a star-less "## Highlights" too, because liftHighlightsToTop does:
// if the lifter would happily place it at the top, the guard must not call it
// missing. The regex mirrors the lifter's (a fresh literal each call, so the
// non-global test has no lastIndex state to leak).
export function isMissingHighlights(body: string): boolean {
  return !/^[ \t]*##[ \t]+(?:⭐[ \t]+)?Highlights[ \t]*$/im.test(body);
}

// ============================================================
// stripReasoningTags — remove leaked model reasoning from the body
// ============================================================
//
// pi's JSONL separates a turn's reasoning ({"type":"thinking"}) from its
// output ({"type":"text"}), and runPiDigest reads only the text items — so
// cleanly-routed reasoning never reaches the digest. But when pi's provider
// adapter does NOT recognize a model's reasoning delimiter (minimax-m3 emits
// <mm:think>…</mm:think>, which the 0.9.x adapter left un-parsed on 2026-07-02),
// the raw tags land inside the `text` channel and leak into the digest.
//
// This is a defensive workaround for that harness+model gap, not a correctness
// guarantee — the isMissingHighlights guard is the real safety net. We remove
// well-formed <think>/<mm:think> blocks, then any orphan tags (the opener is
// often already gone, stripped as preamble, leaving a lone </mm:think> glued to
// real content mid-body). A safety valve returns the ORIGINAL if stripping would
// erase almost everything — that means the whole digest was written inside a
// reasoning block, and an empty body is worse than a tagged one (the highlights
// guard will flag it either way).
export function stripReasoningTags(body: string): string {
  if (!/<\/?(?:mm:)?think\b/i.test(body)) return body; // no tags → untouched
  const stripped = body
    .replace(/<(?:mm:)?think\b[^>]*>[\s\S]*?<\/(?:mm:)?think>/gi, '')
    .replace(/<\/?(?:mm:)?think\b[^>]*>/gi, '')
    .trim();
  if (stripped.length < body.trim().length * 0.2) return body;
  return stripped;
}

// ============================================================
// generateGuardedDigest — run a digest with a template-echo retry guard
// ============================================================
//
// `run` is a thunk that performs ONE digest generation (so this stays testable
// without a live model — the caller passes () => runDigest(...)). If the first
// result is an unfilled template, we retry ONCE; if it's STILL a template after
// the retry, we stamp status='invalid' so the caller can refuse to clear the BGG
// notices (otherwise the unread activity would be marked viewed and lost).
//
// We do NOT throw on an invalid result — the caller still emails a clearly
// labeled alert. Throwing is reserved for the run itself failing (network, etc.),
// which the caller's try/catch turns into a status='error' fallback.
// digestDefect — name the reason a completed digest is unshippable, or null.
// A run ALREADY flagged degraded (partial after skips, rate_limited after a 429,
// or a prior error/invalid) may legitimately lack a Highlights block — the
// caller already banners those — so we never second-guess or override it here.
function digestDefect(result: DigestResult): string | null {
  if (result.status && result.status !== 'complete') return null;
  if (isTemplateEcho(result.body))     return 'unfilled template';
  if (isMissingHighlights(result.body)) return 'missing Highlights block';
  return null;
}

export async function generateGuardedDigest(run: () => Promise<DigestResult>): Promise<DigestResult> {
  let result = await run();
  let defect = digestDefect(result);
  if (!defect) return result;

  log.warn(`Agent produced a defective digest (${defect}) — retrying once`);
  result = await run();
  defect = digestDefect(result);
  if (defect) {
    log.error(`Agent digest still defective (${defect}) after retry — marking invalid`);
    result.status = 'invalid';
  }
  return result;
}

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

  // The model the agent ACTUALLY used, as reported in its own output — not the
  // `--model` we asked for. pi can silently fall back to its default when
  // the requested model is unavailable, so the footer should report what really
  // ran. Format: "provider/model" (e.g. "ollama/minimax-m3:cloud") when the
  // provider is known. Undefined when the agent doesn't report it (plain claude).
  actualModel?: string;
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
// pi both read CLAUDE.md from cwd).
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
  // Both claude-code and pi read CLAUDE.md from cwd automatically.
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
// stripBlockNarration — drop model narration BETWEEN and AFTER blocks
// ============================================================
//
// stripPreamble() handles narration BEFORE the first section. This handles
// everywhere else. Observed 2026-08-30 (pi + nemotron-3-super:cloud, real
// cron run): the model narrated its plan in three additional places —
//
//   1. between sections   "Now, next section: Priority Threads: ..."
//   2. after the last section, before the Highlights header — a ~50-line
//      planning block ("Let's list the tracked games ...", "We'll write:")
//   3. after the Highlights bullets  "We'll output it all at once."
//
// and liftHighlightsToTop() then AMPLIFIED it. That helper slices from the
// Highlights header to the END OF BODY and moves the slice to the top, so (3)
// was relocated directly beneath the Highlights bullets while (2) was left
// stranded at the bottom — clutter at both ends of the reader's email. The
// tell in the real digest: its last line before the footer was "We'll write:",
// the sentence that had immediately preceded the Highlights header.
//
// STRUCTURAL, NOT KEYWORD-BASED. We deliberately mirror stripPreamble's anchor
// approach instead of matching phrases like "Let's" or "Now,": a keyword list
// is endless, model-specific, and risks eating real digest prose (a summary
// could legitimately begin "Now in its third printing..."). Instead we rely on
// the structure templates/section.md already guarantees:
//
//   - A section runs from "### [Title](URL)" to the next block marker, and its
//     LAST legitimate line is "**Topics Mentioned:** ...". Anything after that
//     line, inside the section, is narration.
//   - The Highlights block is its header plus contiguous "-" bullet lines.
//     Anything after the bullets is narration.
//
// SAFETY VALVE: a section with no "**Topics Mentioned:**" line is left
// completely untouched. Keeping a little narration beats silently deleting
// real content from a section the model rendered unusually.
//
// ORDERING: must run BEFORE liftHighlightsToTop, so the trailing narration is
// already gone when the Highlights block gets relocated. It also runs after
// elideDuplicateSections so it only walks sections that survived dedup.
export function stripBlockNarration(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;

  // Block markers: a bracketed section header, or the Highlights header.
  // These are the only legitimate top-level starts in a digest.
  const markerRe = /^[ \t]*(?:###[ \t]+\[|##[ \t]+(?:⭐[ \t]+)?Highlights[ \t]*$)/gim;

  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(trimmed)) !== null) starts.push(m.index);

  if (starts.length === 0) return body;      // nothing recognisable → leave alone

  let removed = 0;
  const kept: string[] = [];

  for (let i = 0; i < starts.length; i++) {
    const blockStart = starts[i];
    const blockEnd   = i + 1 < starts.length ? starts[i + 1] : trimmed.length;
    const block      = trimmed.slice(blockStart, blockEnd);

    const isHighlights = /^[ \t]*##[ \t]+(?:⭐[ \t]+)?Highlights/i.test(block);
    const cleaned      = isHighlights ? trimHighlightsBlock(block) : trimSectionBlock(block);

    // Measure against the block's OWN trimEnd(), not its raw length: the
    // helpers trimEnd their result, and re-joining blocks normalises the
    // blank lines between them. Without this, a perfectly clean digest
    // reports a spurious "Stripped 2 chars" warning purely from whitespace.
    removed += block.trimEnd().length - cleaned.length;
    kept.push(cleaned);
  }

  if (removed <= 0) return trimmed;

  log.warn(`Stripped ${removed} chars of model narration between/after digest blocks`);
  return kept.join('\n\n').trim();
}

// A section ends at its "**Topics Mentioned:**" line. Keep through the end of
// that line (plus an optional "---" separator the models like to emit) and
// drop whatever follows.
function trimSectionBlock(block: string): string {
  // Find the LAST Topics line — a section should have exactly one, but if the
  // model repeated itself the final one is the true end of its content.
  const topicsRe = /^[ \t]*\*\*Topics Mentioned:\*\*.*$/gim;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = topicsRe.exec(block)) !== null) last = m;

  if (!last) return block.trimEnd();   // safety valve: no anchor → untouched

  return block.slice(0, last.index + last[0].length).trimEnd();
}

// The Highlights block is its header followed by contiguous bullet lines.
// Keep the header and every bullet up to the first non-bullet, non-blank line.
function trimHighlightsBlock(block: string): string {
  const lines = block.split('\n');
  const out: string[] = [lines[0]];        // the "## ⭐ Highlights" header itself

  let seenBullet = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const isBullet = /^[ \t]*[-*][ \t]+/.test(line);
    const isBlank  = line.trim() === '';

    if (isBullet) { seenBullet = true; out.push(line); continue; }
    if (isBlank)  { out.push(line); continue; }

    // First real prose line AFTER we've seen at least one bullet ends the
    // block. Before any bullet we keep going — some models put a short lead-in
    // line between the header and the list.
    if (seenBullet) break;
    out.push(line);
  }

  return out.join('\n').trimEnd();
}

// ============================================================
// postProcessDigestBody — the full output-cleanup pipeline
// ============================================================
//
// Both the claude and pi paths produce a raw markdown body that needs the
// same defensive cleanup before it becomes the digest. Composing the steps in
// ONE place keeps the two call sites in sync and makes the pipeline testable
// in isolation (see agent.preamble.test.ts).
//
// Order matters, read inside-out (the innermost call runs first):
//   1. stripReasoningTags       — remove leaked <mm:think> reasoning tokens
//   2. stripPreamble            — drop model planning narration up front
//   3. fixHallucinatedHostnames — repair "boardgeek.com" → "boardgamegeek.com"
//   4. elideRepetitionCollapse  — cut runaway autoregressive line loops
//   5. elideDuplicateSections   — drop a section rendered twice (keep first)
//   6. stripBlockNarration      — drop narration BETWEEN sections and AFTER
//                                 the Highlights bullets. MUST precede the
//                                 lift: liftHighlightsToTop slices to end-of-
//                                 body, so any narration still trailing the
//                                 Highlights block would be carried to the
//                                 top of the digest with it.
//   7. liftHighlightsToTop      — move the trailing Highlights block to the top
//
// stripReasoningTags is innermost so leaked reasoning is gone before stripPreamble
// measures the "preamble", before dedup (which keys off "### [Title]" headers),
// and before the Highlights lift reshuffles things.
export function postProcessDigestBody(body: string): string {
  return liftHighlightsToTop(
    stripBlockNarration(
      elideDuplicateSections(
        elideRepetitionCollapse(
          fixHallucinatedHostnames(
            stripPreamble(
              stripReasoningTags(body),
            ),
          ),
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
      // templates/ automatically. Both claude-code and pi read
      // CLAUDE.md from the cwd.
      cwd:       path.dirname(manifestPath),
      // 45-minute hard cap. Anthropic-backed runs typically finish in 1–2 min,
      // but Ollama-backed runs (claude-ollama) routinely take 5–15 min and
      // have high variance day-to-day; cron hits the slow tail. Matches/exceeds
      // pi's 60-min ceiling.
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
// runPiDigest — launch pi with file access and parse JSONL events
// ============================================================
//
// pi (https://github.com/badlogic/pi-mono, published as
// @earendil-works/pi-coding-agent) is a coding agent that speaks the same
// Read-tool dance as Claude Code but supports arbitrary providers (ollama,
// anthropic, openai, etc.) via its config.
//
// CLI shape:
//   pi --print --mode json --approve --provider <p> --model <m> "<prompt>"
//     --approve    : auto-approve tool confirmations (parallel of --dangerously-skip-permissions)
//     --mode json  : emit JSON Lines — one JSON event per line on stdout
//     --print      : single-shot run; the prompt is passed as an argument (not via stdin)
//
// Provider comes from the "provider/model" prefix when present, else from
// `defaultProvider` in the user's pi settings.json (typically "ollama").
// pi's model catalog lives in ~/.dotfiles/pi/models.json — a model absent
// from it fails with "Model <provider>/<id> not found" even when the backend
// serves it fine.
//
// JSONL event shape we care about (verified empirically against pi 0.84.x):
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
type AgentUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; total?: number };
};
// `name` / `arguments` are populated for `type:'toolCall'` items — we only
// care about the `write` tool's `arguments.content` (see selectDigestBody).
type AgentContent = {
  type: string;
  text?: string;
  name?: string;
  arguments?: { content?: string; path?: string };
};
type AgentEvent = {
  type: string;
  // `model` / `provider` are what pi ACTUALLY routed to for this turn —
  // the source of truth for the footer, since pi may silently fall back
  // to its default when the requested model can't be resolved.
  message?: { content?: AgentContent[]; usage?: AgentUsage; model?: string; provider?: string };
};

// ============================================================
// selectDigestBody — recover the digest text from an agent run
// ============================================================
//
// Failure mode (observed 2026-08-07 with ollama/minimax-m3:cloud, a 49-
// subscription run): the model's synthesis text turn ran long and was cut
// off mid-sentence at "Now the Highlights block. Let me identify the
// cross-subscription themes:" — never finishing. In the NEXT turn, the
// model — in violation of the explicit "do NOT use the Write tool"
// CLAUDE.md instruction — called its `write` tool and saved the complete,
// correctly-formatted digest (real Highlights block included) to
// digest-output.md, then closed with an unrelated short wrap-up text turn
// ("The digest is written to digest-data/digest-output.md. Here's a quick
// summary of what was built..." — no Highlights block).
//
// The old backward-walk only ever looked at `type:'text'` content items
// and returned the newest non-empty one — the short wrap-up — discarding
// the real digest that was sitting one turn earlier in the `write`
// toolCall's `arguments.content`. isMissingHighlights correctly flagged
// the wrap-up as defective, but the retry this triggered ran the model
// again from scratch instead of recovering content that was already on
// the stream — and in this incident, the retry's output was considerably
// worse (garbled links, wrong words, encoding artifacts).
//
// Fix: walk turn_ends newest-to-oldest. At each turn, gather every
// candidate string — the turn's joined `text` items (exactly the old
// behavior) AND any `write` toolCall's `arguments.content`. If a turn has
// a candidate that actually contains a Highlights block, use it — that's
// almost certainly the real synthesis, wherever it landed. Only if NO
// turn has such a candidate do we fall back to the original behavior (the
// newest non-empty `text` item), so a genuinely defective run still
// surfaces as defective and the existing retry/invalid guard still
// applies.
export function selectDigestBody(turnEnds: AgentEvent[]): { body: string; turnIndex: number } {
  let fallbackBody  = '';
  let fallbackIndex = -1;

  for (let i = turnEnds.length - 1; i >= 0; i--) {
    const content = turnEnds[i].message?.content ?? [];

    const textJoined = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0)
      .map((c) => c.text as string)
      .join('\n');

    // Preserve the ORIGINAL behavior exactly as the fallback: the newest
    // turn with non-empty text, regardless of content.
    if (fallbackIndex === -1 && textJoined) {
      fallbackBody  = textJoined;
      fallbackIndex = i;
    }

    const writeCandidates = content
      .filter((c) =>
        c.type === 'toolCall' && c.name === 'write' &&
        typeof c.arguments?.content === 'string' && c.arguments.content.trim().length > 0,
      )
      .map((c) => c.arguments!.content as string);

    const candidates = [textJoined, ...writeCandidates].filter((s) => s.length > 0);
    for (const candidate of candidates) {
      if (!isMissingHighlights(candidate)) {
        return { body: candidate, turnIndex: i };
      }
    }
  }

  return { body: fallbackBody, turnIndex: fallbackIndex };
}

// ============================================================
// Default model — single source of truth
// ============================================================
//
// NOTE (2026-08-30): `qwen3-coder-next:cloud` is RETIRED on ollama, so this
// default is currently a dead fallback. It only bites when no --model is
// passed (the crontab always passes one). Deliberately left as-is pending the
// model decision; when that lands, changing this ONE constant fixes every
// caller. See also ~/.dotfiles/pi/settings.json defaultModel, which points at the
// now-paywalled minimax-m3:cloud.
export const DEFAULT_AGENT_MODEL = 'qwen3-coder-next:cloud';

// ============================================================
// buildAgentCliArgs — pi's command line
// ============================================================
//
// Kept as a separate pure function purely so the flag shapes are unit
// testable without spawning a process (see agent.pi-cli-args.test.ts).
//
//   pi --print --mode json --approve --provider ollama --model nemotron-3-super:cloud <prompt>
//
// `--approve` is the "don't stop to ask about tool use" switch. An unattended
// cron run MUST have it or the process blocks forever on a permission prompt
// nobody is there to answer, until the timeout SIGKILLs it.
//
// `--print` puts pi in non-interactive mode; `--mode json` selects the JSONL
// event stream that runPiDigest() parses.
export function buildAgentCliArgs(model: string, prompt: string): string[] {
  // Split a leading "provider/" prefix off the model id. Split on the FIRST
  // '/' only — model ids legitimately contain ':' (gpt-oss:20b-cloud) and
  // may contain further slashes (carstenuhlig/omnicoder-2-9b:latest), so
  // neither may be mangled. With no prefix we omit --provider entirely and
  // let pi fall back to defaultProvider from its settings.json.
  const slash = model.indexOf('/');
  const provider = slash === -1 ? undefined : model.slice(0, slash);
  const bareModel = slash === -1 ? model : model.slice(slash + 1);

  return [
    '--print',
    '--mode', 'json',
    '--approve',
    ...(provider ? ['--provider', provider] : []),
    '--model', bareModel,
    prompt,
  ];
}

export async function runPiDigest(
  manifestPath: string,
  interests: string,
  model = DEFAULT_AGENT_MODEL,
): Promise<DigestResult> {
  const prompt = buildDigestPrompt(manifestPath, interests);

  // Both CLIs accept the prompt directly as an argument — no temp file
  // needed. spawn with args array bypasses shell quoting, so embedded
  // quotes/backticks/newlines in the prompt are safe.
  const home = process.env.HOME ?? '';
  const extraPaths = [
    `${home}/.bun/bin`,                         // bun-installed pi (the typical install)
    `${home}/.local/bin`,                       // npm global on Linux
    `${home}/.npm-global/bin`,                  // npm with custom prefix
    `${home}/.nvm/versions/node/current/bin`,   // nvm current
    '/usr/local/bin',                           // homebrew / manual installs
  ];
  const augmentedPath = [...extraPaths, process.env.PATH ?? ''].join(':');

  const args = buildAgentCliArgs(model, prompt);

  log.debug('Launching pi with --mode json (streaming)', {
    manifestPath,
    model,
    promptLength: prompt.length,
    // Log the flags but NOT the prompt itself — it is ~270 chars of template
    // and would bury the rest of the line.
    flags: args.filter((a) => a !== prompt),
  });

  // ---- Stream the agent's JSONL output ----
  //
  // We use streaming spawn instead of spawnSync because the JSONL grows
  // unboundedly with tool rounds (each Read tool call's full file contents
  // get echoed back as a tool_result event). Long digests with chatty models
  // were hitting ENOBUFS on the 50MB spawnSync cap. Streaming has no cap and
  // also lowers peak memory because we keep only the parsed turn_end events
  // (small) and discard everything else line-by-line.
  // (AgentUsage / AgentContent / AgentEvent are declared at module scope,
  // above, so selectDigestBody can be a standalone testable function.)

  // Wall-clock the run so we can populate durationMs (the JSONL doesn't
  // include a top-level duration like Claude's --output-format json does).
  const start = Date.now();
  const proc  = spawn('pi', args, {
    // cwd = digest-data so the agent picks up the workspace's CLAUDE.md and
    // templates/ from there. pi
    // discovers CLAUDE.md/AGENTS.md the same way (its --no-context-files flag
    // is what would DISABLE that, and we deliberately do not pass it).
    cwd:   path.dirname(manifestPath),
    env:   { ...process.env, PATH: augmentedPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Hard timeout — kill pi if it hangs (e.g. local model deadlock).
  //
  // Raised 30 -> 60 min on 2026-08-30. Every ollama cloud model that used to
  // run this digest is now behind a 402 paywall, and the free-tier models that
  // replace them are FAR slower: nemotron-3-super:cloud took 1287s (21.5 min)
  // for a light 11-subscription run, where minimax-m3 did 18 subscriptions in
  // 105s. At 30 min a heavier day would have been SIGKILLed, which surfaces as
  // "pi produced no turn_end events" — indistinguishable from the paywall
  // failure it replaced. 60 min buys roughly 2.5x headroom over the measured
  // worst case. This is a ceiling for a hung process, not a target: a healthy
  // run still exits as soon as the agent is done.
  const TIMEOUT_MS = 60 * 60 * 1000;
  const timeoutHandle = setTimeout(() => {
    log.warn(`pi exceeded ${TIMEOUT_MS}ms timeout — killing process`);
    proc.kill('SIGKILL');
  }, TIMEOUT_MS);

  // Only retain turn_end events — every other event type is discarded as it
  // streams in, keeping memory bounded regardless of digest size.
  const turnEnds: AgentEvent[] = [];
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
        const ev = JSON.parse(line) as AgentEvent;
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
          const ev = JSON.parse(last) as AgentEvent;
          if (ev.type === 'turn_end') turnEnds.push(ev);
        } catch { /* skip */ }
      }
      if (code !== 0) {
        reject(new Error(
          `pi exited with code ${code}: ${stderrChunks.slice(0, 1000)}`,
        ));
        return;
      }
      resolve();
    });
  });
  const durationMs = Date.now() - start;

  log.debug('pi stream complete', {
    bytesRead:  totalBytes,
    turnEnds:   turnEnds.length,
    durationMs,
  });

  if (turnEnds.length === 0) {
    throw new Error(
      `pi produced no turn_end events (${totalBytes} bytes read). ` +
      `stderr: ${stderrChunks.slice(0, 500)}`,
    );
  }

  // ---- Pull the digest body ----
  //
  // See selectDigestBody's doc comment for the 2026-08-07 failure mode this
  // guards against (model writes the real digest via the `write` tool, then
  // closes with an unrelated short text turn).
  const { body: selectedBody, turnIndex } = selectDigestBody(turnEnds);
  const body = selectedBody;
  const synthesisModel:    string | undefined = turnIndex !== -1 ? turnEnds[turnIndex].message?.model    : undefined;
  const synthesisProvider: string | undefined = turnIndex !== -1 ? turnEnds[turnIndex].message?.provider : undefined;
  if (!body) {
    throw new Error(
      `pi ran ${turnEnds.length} turn(s) but no turn produced assistant text. ` +
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

  // ---- Determine the model the agent ACTUALLY used ----
  // Prefer the synthesis turn (the one that wrote the digest); fall back to the
  // last turn that reported a model. Combine with provider so it's comparable to
  // the requested id (e.g. "ollama/minimax-m3:cloud").
  let reportedModel    = synthesisModel;
  let reportedProvider = synthesisProvider;
  if (!reportedModel) {
    for (let i = turnEnds.length - 1; i >= 0; i--) {
      if (turnEnds[i].message?.model) {
        reportedModel    = turnEnds[i].message?.model;
        reportedProvider = turnEnds[i].message?.provider;
        break;
      }
    }
  }
  const actualModel = reportedModel
    ? (reportedProvider ? `${reportedProvider}/${reportedModel}` : reportedModel)
    : undefined;

  // Warn loudly if the agent silently routed to a different model than requested —
  // compare on the bare model name (after the last '/') so provider prefixes
  // don't cause false mismatches.
  const bare = (m: string) => m.split('/').pop();
  if (actualModel && bare(actualModel) !== bare(model)) {
    log.warn(`pi used a DIFFERENT model than requested — fell back?`, {
      requested: model,
      actual:    actualModel,
    });
  }

  return {
    body: postProcessDigestBody(body),
    inputTokens, outputTokens, costUsd, durationMs,
    actualModel,
  };
}

// ============================================================
// runDigest — dispatch to claude / claude-ollama / pi based on agent name
// ============================================================
//
// 'claude'        — claude CLI against Anthropic's API. Original tool-loop
//                   pattern; effectively unbounded context with caching.
// 'claude-ollama' — claude CLI redirected at local Ollama via
//                   `ollama launch claude --model X --yes`. Same tool-loop
//                   pattern as plain claude. Item-cap truncation in the
//                   data-fetch phase keeps total context within the 200K
//                   model window so degeneration doesn't trigger.
// 'pi'            — pi CLI (@earendil-works/pi-coding-agent), JSONL event
//                   stream parsed by runPiDigest().
//
// REMOVED 2026-08-30: 'tallow'. tallow 0.9.10 was pinned to the DEPRECATED
// @mariozechner/pi-* ^0.72.1 with no npm release since 2026-05-06, while pi
// moved to @earendil-works/pi-coding-agent 0.84.x and ships actively. tallow
// was also measurably worse at the same job: on an identical manifest it took
// 1287s and streamed 489 MB where pi took 310s and streamed 1.5 MB, because
// tallow echoed full file contents back on every tool round. Since tallow was
// built on pi, dropping it cost nothing at the parser level — the JSONL event
// shape is the same one pi emits.
export type AgentName = 'claude' | 'claude-ollama' | 'pi';

export async function runDigest(
  agent: AgentName,
  manifestPath: string,
  interests: string,
  model?: string,
): Promise<DigestResult> {
  if (agent === 'pi') {
    return runPiDigest(manifestPath, interests, model);
  }
  // Both 'claude' and 'claude-ollama' share runClaudeDigest — the only
  // difference is whether we route through `ollama launch claude` to point
  // at the local Ollama endpoint (true) or talk to Anthropic directly (false).
  return runClaudeDigest(manifestPath, interests, model, agent === 'claude-ollama');
}
