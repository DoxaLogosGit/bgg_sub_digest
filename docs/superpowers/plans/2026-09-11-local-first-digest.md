# Local-First Digest Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a typical nightly digest cost zero metered tokens by rendering it with a local ollama model, escalating to cloud only for the groups the local model cannot do.

**Architecture:** A new `src/local/` module tree owns the local path: splitting a subscription's data under an input-size cap, assembling section markdown from the manifest (so the model never writes a link), and validating each section's prose. `src/index.ts` routes local-first and escalates per failing group into the existing `runChunkedDigest`, which is unchanged.

**Tech Stack:** TypeScript, Node 22, tsx, `node:assert/strict` standalone test scripts (no framework), pi CLI driving ollama.

**Spec:** `docs/superpowers/specs/2026-09-11-local-first-digest-design.md`

## Global Constraints

- Tests are standalone scripts run with `npx tsx <file>`; assert with `node:assert/strict`. There is no test framework.
- tsx compiles to CJS: **top-level `await` is unsupported.** Wrap async assertions in `async function main()` and call `main().catch((e) => { console.error(e); process.exit(1); })`.
- Every test file ends by printing `<name>: all assertions passed ✓` — the suite runner greps for `passed`.
- Comment density matches the existing codebase: explain *why*, cite the dated incident a guard exists for.
- `npx tsc --noEmit` must stay clean.
- Local model name is `omnicoder-oc` (pi's catalog name, **not** `omnicoder-oc:latest`).
- When testing pi by hand, always redirect stdin: `pi ... < /dev/null`. pi blocks forever on open stdin.
- Never run a real digest without `--no-email` unless the task says to deliver.
- Metered budget `maxModelCalls` default 12; local budget `maxLocalCalls` default 120.

---

### Task 1: Split a subscription's content under an input cap

**Files:**
- Create: `src/local/split.ts`
- Test: `src/local/split.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `splitSubscriptionContent(content: string, maxChars: number): string[]`

- [ ] **Step 1: Write the failing test**

```typescript
// src/local/split.test.ts
import assert from 'node:assert/strict';
import { splitSubscriptionContent } from './split';

// A geeklist file: a "=== Geeklist: X ===" header then repeated "[Item by ...]" blocks.
const header = '=== Geeklist: Solitaire Games on Your Table ===\n\n';
const item = (n: number) => `[Item by member${n} posted 9/1/2026] — Game ${n}\nLink: https://x/#item${n}\n${'body '.repeat(40)}\n\n`;
const geeklist = header + [1, 2, 3, 4, 5, 6].map(item).join('');

// ---- under the cap: one part, returned unchanged ----
{
  const parts = splitSubscriptionContent(geeklist, 100_000);
  assert.equal(parts.length, 1, 'content under the cap is not split');
  assert.equal(parts[0], geeklist, 'and is returned byte-for-byte');
}

// ---- over the cap: split on item boundaries ----
{
  const parts = splitSubscriptionContent(geeklist, 700);
  assert.ok(parts.length > 1, 'content over the cap is split');
  for (const p of parts) {
    assert.ok(p.length <= 700 || p.split('[Item by').length === 2,
      'no part exceeds the cap unless it is a single oversized item');
  }
  // Every item survives exactly once.
  const all = parts.join('');
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.equal((all.match(new RegExp(`\\[Item by member${n} `, 'g')) ?? []).length, 1,
      `item ${n} appears exactly once across the parts`);
  }
}

// ---- the file header is repeated into every part ----
//
// Each part becomes its own model call with no memory of the others, so a part
// that does not say which geeklist it is gets summarised without that context.
{
  const parts = splitSubscriptionContent(geeklist, 700);
  for (const p of parts) {
    assert.ok(p.startsWith('=== Geeklist: Solitaire Games on Your Table ==='),
      'every part carries the file header');
  }
}

// ---- threads split on "[Post by ...]" ----
{
  const thread = '=== Thread: Best solo game ===\n\n' +
    [1, 2, 3, 4].map((n) => `[Post by user${n} on 9/1/2026]\nLink: https://x?article=${n}\n${'text '.repeat(40)}\n\n`).join('');
  const parts = splitSubscriptionContent(thread, 600);
  assert.ok(parts.length > 1, 'threads split too');
  const all = parts.join('');
  for (const n of [1, 2, 3, 4]) {
    assert.equal((all.match(new RegExp(`\\[Post by user${n} `, 'g')) ?? []).length, 1,
      `post ${n} appears exactly once`);
  }
}

// ---- a single item larger than the cap is NOT truncated ----
//
// Losing content silently is the failure this whole pipeline keeps relearning.
// An oversized item goes out whole and over cap; the model may do badly with
// it, and the section guard will catch that.
{
  const huge = header + `[Item by whale posted 9/1/2026] — Big\n${'x'.repeat(5000)}\n\n`;
  const parts = splitSubscriptionContent(huge, 500);
  assert.equal(parts.length, 1, 'an oversized single item stays one part');
  assert.ok(parts[0].includes('x'.repeat(5000)), 'and is never truncated');
}

// ---- content with no markers at all is returned as one part ----
{
  const stub = 'New activity on a BGG blog you subscribe to.\nLink: https://x\n';
  assert.deepEqual(splitSubscriptionContent(stub, 10), [stub],
    'a stub with no item/post markers cannot be split and is passed through');
}

// ---- empty input ----
assert.deepEqual(splitSubscriptionContent('', 100), [], 'empty content yields no parts');

console.log('split.test.ts: all assertions passed ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/local/split.test.ts`
Expected: FAIL — `Cannot find module './split'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/local/split.ts
// ============================================================
// local/split.ts — cut a subscription's data under an input cap
// ============================================================
//
// WHY (measured 2026-09-11): the local model returns SILENT EMPTY OUTPUT above
// roughly 3K input tokens. Feeding it the 61KB / 50-item SGOYT geeklist
// produced zero characters and no error; 10 items produced all 10 bullets in
// 24s. VRAM is NOT the constraint — the same model sits at 100% GPU even with
// a 32K context — so the fix is capping the INPUT, not the context.
//
// Parts are split on BGG's own record boundaries so no post or item is ever
// cut in half.

// A record starts at a line beginning "[Item by " (geeklists) or "[Post by "
// (threads). Both formats are produced by agent.ts's formatters.
const RECORD_START = /^(?=\[(?:Item|Post) by )/m;

export function splitSubscriptionContent(content: string, maxChars: number): string[] {
  if (!content.trim()) return [];
  if (content.length <= maxChars) return [content];

  // Everything before the first record is the file header ("=== Thread: X ===").
  const pieces = content.split(RECORD_START);
  const header = pieces[0].startsWith('[') ? '' : pieces.shift() ?? '';
  const records = pieces;

  // No records to split on — a stub file, or a shape we do not recognise.
  // Pass it through whole rather than guessing where to cut.
  if (records.length === 0) return [content];

  const parts: string[] = [];
  let current = '';

  for (const record of records) {
    // Starting a new part when this record would overflow the current one.
    // An individual record larger than the cap still goes out whole: silently
    // truncating a member's post is worse than one oversized call.
    if (current && (header.length + current.length + record.length) > maxChars) {
      parts.push(header + current);
      current = '';
    }
    current += record;
  }
  if (current) parts.push(header + current);

  return parts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/local/split.test.ts`
Expected: PASS, prints `split.test.ts: all assertions passed ✓`

- [ ] **Step 5: Commit**

```bash
git add src/local/split.ts src/local/split.test.ts
git commit -m "Split subscription data under a local input cap

The local model returns silent empty output above ~3K input tokens
(measured on the 61KB SGOYT geeklist: 0 chars at 50 items, all 10
bullets at 10 items). VRAM is not the limit - it stays 100% on GPU even
at 32K context - so cap the input instead.

Parts cut on BGG's own [Item by / [Post by record boundaries so no post
is ever halved, and every part repeats the file header because each one
becomes an independent model call with no memory of its siblings. A
single record larger than the cap goes out whole rather than truncated."
```

---

### Task 2: Assemble a section from the manifest, not the model

**Files:**
- Create: `src/local/section.ts`
- Test: `src/local/section.test.ts`

**Interfaces:**
- Consumes: `ManifestEntry` from `../agent`, `InterestsConfig` from `../interests`.
- Produces:
  - `matchTopics(content: string, cfg: InterestsConfig): string[]`
  - `assembleSection(entry: ManifestEntry, prose: string, topics: string[]): string`

- [ ] **Step 1: Write the failing test**

```typescript
// src/local/section.test.ts
import assert from 'node:assert/strict';
import { assembleSection, matchTopics } from './section';
import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

const cfg: InterestsConfig = {
  priorityTitles: ['SGOYT'],
  trackedGames:   ['Spirit Island', "Star Trek: Captain's Chair"],
  keywords:       ['solo', 'expansion'],
  notes:          '',
};

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    subscriptionId: 42,
    type: 'thread',
    title: 'Best solo train game?',
    url: 'https://boardgamegeek.com/thread/3765831/best-train-game',
    filePath: '/tmp/thread-3765831.md',
    itemCount: 5,
    unreadCount: 5,
    notificationDate: null,
    ...over,
  };
}

const PROSE = '**Summary:** Members debated engine-building trains.\n\n**New Activity:**\n- alice — recommends Irish Gauge.';

// ---- the header comes from the MANIFEST, never the model ----
//
// The 2026-09-11 spike's one real defect: the model wrote a bare
// "### Question about traits..." with no link, which scored 0 sections and
// would have tripped the truncation guard. A model that never writes a link
// cannot write a broken one.
{
  const s = assembleSection(entry(), PROSE, []);
  assert.ok(s.startsWith('### [Best solo train game?](https://boardgamegeek.com/thread/3765831/best-train-game)\n'),
    'the section opens with the exact manifest title and url');
}

// ---- the Parent line appears only when parentName is set ----
{
  const withParent = assembleSection(entry({ parentName: '1 Player guild' }), PROSE, []);
  assert.match(withParent, /^\*Parent: 1 Player guild\*$/m);

  const without = assembleSection(entry(), PROSE, []);
  assert.ok(!without.includes('*Parent:'), 'no empty Parent line is ever emitted');
}

// ---- the replies-to-you line appears only when selfActivity is present ----
{
  const withReplies = assembleSection(
    entry({ selfActivity: { reasons: ['2 comments on your item "Tarawa 1943"'], replyCount: 2 } }),
    PROSE, []);
  assert.match(withReplies, /^\*\*💬 Replies to you:\*\* 2 comments on your item "Tarawa 1943"$/m);
  assert.ok(!assembleSection(entry(), PROSE, []).includes('Replies to you'));
}

// ---- several reasons join with "; " ----
{
  const s = assembleSection(
    entry({ selfActivity: { reasons: ['3 replies in a thread you started', '1 post quoting you'], replyCount: 4 } }),
    PROSE, []);
  assert.match(s, /Replies to you:\*\* 3 replies in a thread you started; 1 post quoting you/);
}

// ---- the model's prose is inserted verbatim ----
{
  const s = assembleSection(entry(), PROSE, []);
  assert.ok(s.includes('**Summary:** Members debated engine-building trains.'));
  assert.ok(s.includes('- alice — recommends Irish Gauge.'));
}

// ---- Topics Mentioned is computed in CODE and always closes the section ----
{
  const s = assembleSection(entry(), PROSE, ['solo', 'Spirit Island']);
  assert.match(s, /\*\*Topics Mentioned:\*\* solo, Spirit Island\s*$/);

  const none = assembleSection(entry(), PROSE, []);
  assert.match(none, /\*\*Topics Mentioned:\*\* none\s*$/);
}

// ---- matchTopics finds tracked games and keywords, case-insensitively ----
{
  const content = 'I played Spirit Island SOLO last night. The expansion is great.';
  const topics = matchTopics(content, cfg);
  assert.ok(topics.includes('Spirit Island'), 'tracked game matched');
  assert.ok(topics.includes('solo'), 'keyword matched case-insensitively');
  assert.ok(topics.includes('expansion'), 'second keyword matched');
  assert.ok(!topics.includes("Star Trek: Captain's Chair"), 'absent games are not reported');
}

// ---- matchTopics does not repeat a term ----
{
  const topics = matchTopics('solo solo solo Spirit Island Spirit Island', cfg);
  assert.equal(topics.filter((t) => t === 'solo').length, 1);
  assert.equal(topics.filter((t) => t === 'Spirit Island').length, 1);
}

// ---- a keyword written as "solo / solitaire" matches either side ----
//
// interests.toml keeps human-readable keyword entries; the slash is a list,
// not a literal to search for.
{
  const slashCfg: InterestsConfig = { ...cfg, keywords: ['solo / solitaire'] };
  assert.ok(matchTopics('a solitaire session', slashCfg).length > 0,
    'either side of a slashed keyword matches');
}

console.log('section.test.ts: all assertions passed ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/local/section.test.ts`
Expected: FAIL — `Cannot find module './section'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/local/section.ts
// ============================================================
// local/section.ts — build the section around the model's prose
// ============================================================
//
// WHY (2026-09-11 spike): asked to produce a whole section, the local model
// wrote a bare "### Question about traits..." with no markdown link. That
// scored 0 sections and would have tripped isTruncatedDigest. The manifest
// already holds the title, url, parent name and selfActivity, so the code
// emits every structural line and asks the model only for prose. A model that
// never writes a link cannot write a broken one.

import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

// ---- matchTopics ------------------------------------------------
//
// "Topics Mentioned" used to be the model's job and was routinely wrong or
// invented. It is a substring search, so it belongs in code.
export function matchTopics(content: string, cfg: InterestsConfig): string[] {
  const haystack = content.toLowerCase();
  const found: string[] = [];

  const add = (label: string): void => {
    if (!found.includes(label)) found.push(label);
  };

  for (const game of cfg.trackedGames) {
    if (game && haystack.includes(game.toLowerCase())) add(game);
  }

  for (const keyword of cfg.keywords) {
    // interests.toml keeps readable entries like "solo / solitaire" or
    // "kickstarter / crowdfunding" — a slash separates alternatives rather
    // than being part of the term.
    for (const alt of keyword.split('/').map((k) => k.trim()).filter(Boolean)) {
      if (haystack.includes(alt.toLowerCase())) { add(alt); break; }
    }
  }

  return found;
}

// ---- assembleSection --------------------------------------------
//
// `prose` is exactly what the model returned: a "**Summary:**" line and a
// "**New Activity:**" bullet list. Everything around it is ours.
export function assembleSection(entry: ManifestEntry, prose: string, topics: string[]): string {
  const lines: string[] = [`### [${entry.title}](${entry.url})`];

  // Only when set — an empty "*Parent: *" line was a real defect in 2026-09.
  if (entry.parentName) lines.push(`*Parent: ${entry.parentName}*`);

  if (entry.selfActivity && entry.selfActivity.reasons.length > 0) {
    lines.push(`**💬 Replies to you:** ${entry.selfActivity.reasons.join('; ')}`);
  }

  lines.push('', prose.trim(), '');
  lines.push(`**Topics Mentioned:** ${topics.length ? topics.join(', ') : 'none'}`);

  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/local/section.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/local/section.ts src/local/section.test.ts
git commit -m "Build local sections from the manifest, not the model

The 2026-09-11 spike's one real defect: asked for a whole section, the
local model wrote a bare '### Question about traits...' with no markdown
link. That scores 0 sections and trips isTruncatedDigest.

The manifest already holds the title, url, parentName and selfActivity,
so code now emits every structural line and the model supplies only the
Summary and bullets. A model that never writes a link cannot write a
broken one.

Topics Mentioned moves into code too - it is a substring search against
interests.toml, which is not a judgement call and was routinely invented."
```

---

### Task 3: Reject a section whose prose says nothing

**Files:**
- Create: `src/local/validate.ts`
- Test: `src/local/validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sectionDefect(section: string): string | null`

- [ ] **Step 1: Write the failing test**

```typescript
// src/local/validate.test.ts
import assert from 'node:assert/strict';
import { sectionDefect } from './validate';

const good = [
  '### [Best solo train game?](https://boardgamegeek.com/thread/1)',
  '',
  '**Summary:** Members debated engine-building trains and recommended three titles.',
  '',
  '**New Activity:**',
  '- alice — recommends Irish Gauge for its tight auction.',
  '- bob — argues Age of Steam is still the benchmark.',
  '',
  '**Topics Mentioned:** solo',
].join('\n');

assert.equal(sectionDefect(good), null, 'a complete section has no defect');

// ---- WHY THIS GUARD EXISTS ----
//
// isTruncatedDigest counts "### [" headers. Once CODE writes those they are
// always present, so that guard goes blind and the 2026-09-10 failure - a
// digest that is structurally perfect and says nothing - returns wearing a
// different hat. Validity therefore has to be checked in the PROSE.

// ---- missing Summary ----
{
  const d = sectionDefect(good.replace(/\*\*Summary:\*\*.*/, ''));
  assert.ok(d && /summary/i.test(d), `missing Summary must be a defect, got ${d}`);
}

// ---- empty Summary ----
{
  const d = sectionDefect(good.replace(/\*\*Summary:\*\*.*/, '**Summary:**'));
  assert.ok(d && /summary/i.test(d), 'an empty Summary is a defect');
}

// ---- a Summary too short to carry information ----
{
  const d = sectionDefect(good.replace(/\*\*Summary:\*\*.*/, '**Summary:** New activity.'));
  assert.ok(d && /summary/i.test(d), 'a stub Summary is a defect');
}

// ---- no bullets ----
{
  const d = sectionDefect(good.replace(/^- .*$/gm, ''));
  assert.ok(d && /bullet/i.test(d), `zero bullets must be a defect, got ${d}`);
}

// ---- empty body ----
assert.ok(sectionDefect(''), 'an empty section is a defect');

// ---- the "See file for details" shape from 2026-09-10 ----
//
// The re-run of that workspace produced 31 sections every one of which read
// "**Summary:** See file for details." That must not pass.
{
  const vacuous = good
    .replace(/\*\*Summary:\*\*.*/, '**Summary:** See file for details.')
    .replace(/^- .*$/gm, '- See file for details');
  assert.ok(sectionDefect(vacuous), 'the "See file for details" shape is a defect');
}

console.log('validate.test.ts: all assertions passed ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/local/validate.test.ts`
Expected: FAIL — `Cannot find module './validate'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/local/validate.ts
// ============================================================
// local/validate.ts — is this section's PROSE worth shipping?
// ============================================================
//
// WHY: isTruncatedDigest counts "### [" headers to catch a digest that
// rendered almost nothing (2026-09-10: 1 section of 31, shipped as complete,
// cleared 90 BGG notices). On the local path CODE writes those headers, so
// they are always present and that guard goes blind. Without a prose-level
// check the same failure returns in a new costume: a structurally perfect
// digest that says nothing.
//
// Thresholds are deliberately loose. This is a floor against emptiness, not a
// quality score — a real but terse summary must pass.

// Below this a "summary" carries no information. "New activity." is 14 chars;
// the shortest genuinely useful summary observed in the 09-04 digest was 58.
const MIN_SUMMARY_CHARS = 40;

// Phrases seen from a degenerating model standing in for real content.
const FILLER = /^(see (the )?file for details|new activity( detected)?|content not retrievable|activity detected)\.?$/i;

export function sectionDefect(section: string): string | null {
  if (!section.trim()) return 'empty section';

  const summaryMatch = /^\*\*Summary:\*\*[ \t]*(.*)$/m.exec(section);
  if (!summaryMatch) return 'no Summary line';

  const summary = summaryMatch[1].trim();
  if (!summary) return 'empty Summary';
  if (summary.length < MIN_SUMMARY_CHARS) return `Summary too short (${summary.length} chars)`;
  if (FILLER.test(summary)) return 'Summary is filler';

  const bullets = (section.match(/^[ \t]*[-*][ \t]+\S.*$/gm) ?? [])
    .filter((b) => !FILLER.test(b.replace(/^[ \t]*[-*][ \t]+/, '').trim()));
  if (bullets.length === 0) return 'no bullets under New Activity';

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/local/validate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/local/validate.ts src/local/validate.test.ts
git commit -m "Guard local sections on prose, not structure

isTruncatedDigest counts '### [' headers to catch a digest that rendered
almost nothing - the 2026-09-10 failure that shipped 1 section of 31 as
complete and cleared 90 BGG notices. On the local path code writes those
headers, so they are always present and that guard goes blind.

sectionDefect checks the part the model actually produced: a Summary with
real content and at least one bullet. Without it the same failure returns
in a new costume - structurally perfect, says nothing. Thresholds are a
floor against emptiness, not a quality score."
```

---

### Task 4: Config tiers, budgets and CLI flags

**Files:**
- Modify: `src/config.ts` (the `digest` schema block)
- Modify: `config.example.json`
- Test: `src/config.tiers.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `config.digest.localModel: string`, `config.digest.cloudModel: string`, `config.digest.maxLocalCalls: number`, `config.digest.maxLocalInputChars: number`; and `resolveTiers(argv: string[], cfg): { models: string[]; escalates: boolean }` exported from `src/config.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/config.tiers.test.ts
import assert from 'node:assert/strict';
import { resolveTiers } from './config';

const cfg = { localModel: 'omnicoder-oc', cloudModel: 'nemotron-3-super:cloud' };

// ---- default: local first, cloud available for escalation ----
{
  const t = resolveTiers([], cfg);
  assert.deepEqual(t.models, ['omnicoder-oc', 'nemotron-3-super:cloud']);
  assert.equal(t.escalates, true);
}

// ---- --local-only: never spends a metered token ----
{
  const t = resolveTiers(['--local-only'], cfg);
  assert.deepEqual(t.models, ['omnicoder-oc']);
  assert.equal(t.escalates, false, 'there is nothing to escalate to');
}

// ---- --cloud-only: skip local entirely ----
{
  const t = resolveTiers(['--cloud-only'], cfg);
  assert.deepEqual(t.models, ['nemotron-3-super:cloud']);
  assert.equal(t.escalates, false);
}

// ---- --model X overrides both tiers ----
{
  const t = resolveTiers(['--model', 'gemma4:31b-cloud'], cfg);
  assert.deepEqual(t.models, ['gemma4:31b-cloud'],
    'an explicit model is used alone, with no tiering');
  assert.equal(t.escalates, false);
}

// ---- conflicting flags fail loudly rather than picking silently ----
{
  assert.throws(() => resolveTiers(['--local-only', '--cloud-only'], cfg),
    /both --local-only and --cloud-only/i,
    'a contradiction must be an error, not a silent preference');
}

console.log('config.tiers.test.ts: all assertions passed ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/config.tiers.test.ts`
Expected: FAIL — `resolveTiers is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to the `digest` object in `ConfigSchema` in `src/config.ts`, directly after `maxModelCalls`:

```typescript
    // The local (unmetered) model, tried first on every group.
    // This is PI's catalog name, which differs from `ollama list` — it is
    // `omnicoder-oc`, NOT `omnicoder-oc:latest`. Check with
    // `pi --list-models < /dev/null`; a wrong name fails instantly rather
    // than hanging.
    localModel: z.string().default('omnicoder-oc'),

    // The metered model, used only for groups the local model could not do.
    cloudModel: z.string().default('nemotron-3-super:cloud'),

    // Ceiling on LOCAL calls for one run. Local calls cost time, not money,
    // so this is far higher than maxModelCalls and exists only to stop a
    // runaway loop, not to ration spend.
    maxLocalCalls: z.number().int().positive().default(120),

    // Largest input handed to the local model in one call. Measured
    // 2026-09-11: above roughly 3K tokens it returns silent empty output.
    // 12000 chars is ~3K tokens with margin.
    maxLocalInputChars: z.number().int().positive().default(12000),
```

Append to the end of `src/config.ts`:

```typescript
// ---- resolveTiers ----------------------------------------------
//
// Which models does this run use, and in what order?
//
// The default is local-first: a group is attempted on the unmetered model and
// only escalates to the metered one if it fails. Escalation is per GROUP, not
// per run — one stubborn subscription costs one metered call, not fifty.
//
// Python: def resolve_tiers(argv: list[str], cfg) -> Tiers
export function resolveTiers(
  argv: string[],
  cfg: { localModel: string; cloudModel: string },
): { models: string[]; escalates: boolean } {
  const localOnly = argv.includes('--local-only');
  const cloudOnly = argv.includes('--cloud-only');

  if (localOnly && cloudOnly) {
    throw new Error(
      'Cannot pass both --local-only and --cloud-only. Pick one, or neither ' +
      'for the default (local first, cloud escalation).',
    );
  }

  // An explicit --model is a direct instruction and wins over the tiers.
  const modelIdx = argv.indexOf('--model');
  if (modelIdx !== -1 && argv[modelIdx + 1]) {
    return { models: [argv[modelIdx + 1]], escalates: false };
  }

  if (cloudOnly) return { models: [cfg.cloudModel], escalates: false };
  if (localOnly) return { models: [cfg.localModel], escalates: false };

  return { models: [cfg.localModel, cfg.cloudModel], escalates: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/config.tiers.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean

- [ ] **Step 5: Add the new keys to `config.example.json`**

In the `digest` object, after `"maxModelCalls": 12,` add:

```json
    "localModel": "omnicoder-oc",
    "cloudModel": "nemotron-3-super:cloud",
    "maxLocalCalls": 120,
    "maxLocalInputChars": 12000,
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.tiers.test.ts config.example.json
git commit -m "Add model tiers, local budget and tier CLI flags

Local inference is unmetered, so the scarce resource differs per tier:
maxLocalCalls (120) bounds runtime, maxModelCalls (12) bounds spend.

resolveTiers decides which models a run uses. Default is local first with
cloud available for escalation; --local-only guarantees zero metered
spend; --cloud-only skips local for a night that matters; --model X still
forces one exact model. Passing both --local-only and --cloud-only throws
rather than silently preferring one.

localModel defaults to pi's catalog name 'omnicoder-oc' - NOT
'omnicoder-oc:latest', which is what ollama list calls it and what fails."
```

---

### Task 5: Render one subscription locally, splitting when needed

**Files:**
- Create: `src/local/render.ts`
- Test: `src/local/render.test.ts`

**Interfaces:**
- Consumes: `splitSubscriptionContent` (Task 1), `assembleSection`/`matchTopics` (Task 2), `sectionDefect` (Task 3).
- Produces:
  ```typescript
  export interface LocalRenderResult {
    section: string | null;   // null when every attempt was defective
    defect:  string | null;
    calls:   number;
  }
  export async function renderSubscriptionLocally(params: {
    entry: ManifestEntry;
    content: string;
    interests: InterestsConfig;
    maxInputChars: number;
    askProse: (input: string, wantSummary: boolean) => Promise<string>;
  }): Promise<LocalRenderResult>
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// src/local/render.test.ts
import assert from 'node:assert/strict';
import { renderSubscriptionLocally } from './render';
import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

const interests: InterestsConfig = {
  priorityTitles: [], trackedGames: ['Spirit Island'], keywords: ['solo'], notes: '',
};

const entry: ManifestEntry = {
  subscriptionId: 1, type: 'geeklist', title: 'SGOYT September',
  url: 'https://boardgamegeek.com/geeklist/383712',
  filePath: '/tmp/geeklist-383712.md',
  itemCount: 6, unreadCount: 6, notificationDate: null,
};

const header = '=== Geeklist: SGOYT September ===\n\n';
const item = (n: number) => `[Item by member${n} posted 9/1/2026] — Spirit Island\nLink: https://x/#item${n}\n${'body '.repeat(40)}\n\n`;
const content = header + [1, 2, 3, 4, 5, 6].map(item).join('');

const GOOD_PROSE =
  '**Summary:** Members posted six solo sessions with scores and short reviews of each game.\n\n' +
  '**New Activity:**\n- member1 — played Spirit Island and won at level 3.';
const BULLETS_ONLY = '**New Activity:**\n- member1 — played Spirit Island and won at level 3.';

async function main() {
  // ---- small input: ONE call, section assembled around the prose ----
  {
    let calls = 0;
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 100_000,
      askProse: async () => { calls += 1; return GOOD_PROSE; },
    });
    assert.equal(calls, 1, 'content under the cap costs exactly one call');
    assert.equal(r.defect, null);
    assert.ok(r.section!.startsWith('### [SGOYT September](https://boardgamegeek.com/geeklist/383712)'),
      'the header comes from the manifest');
    assert.match(r.section!, /\*\*Topics Mentioned:\*\* Spirit Island, solo/,
      'topics are computed in code from the CONTENT');
  }

  // ---- large input: split into parts, each asked for BULLETS ONLY ----
  //
  // Then one final call writes the Summary over the merged bullets. Asking
  // each part for its own Summary would produce several competing summaries
  // with no way to choose between them.
  {
    const asks: boolean[] = [];
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (_input, wantSummary) => {
        asks.push(wantSummary);
        return wantSummary
          ? '**Summary:** Members posted six solo sessions with scores and short reviews.'
          : BULLETS_ONLY;
      },
    });

    assert.ok(asks.length > 2, `a split subscription makes several calls, saw ${asks.length}`);
    assert.equal(asks.filter((w) => w).length, 1, 'exactly one call asks for the Summary');
    assert.equal(asks[asks.length - 1], true, 'and it is the LAST call, over the merged bullets');
    assert.equal(r.defect, null);
    assert.equal((r.section!.match(/^- member1 /gm) ?? []).length, asks.length - 1,
      'every part contributes its bullets to one merged section');
  }

  // ---- a defective result is reported, not shipped ----
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 100_000,
      askProse: async () => '**Summary:** New activity.\n\n**New Activity:**\n- See file for details',
    });
    assert.equal(r.section, null, 'a defective render yields no section');
    assert.ok(r.defect, 'and names the defect');
  }

  // ---- the model returning nothing at all is a defect, not a crash ----
  //
  // Measured 2026-09-11: above ~3K input tokens the local model returns an
  // empty string with no error. That is the single most likely failure here.
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 100_000,
      askProse: async () => '',
    });
    assert.equal(r.section, null);
    assert.ok(r.defect && /empty/i.test(r.defect), `empty output must be named, got ${r.defect}`);
  }

  // ---- calls are counted so the caller can enforce a budget ----
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (_i, wantSummary) => (wantSummary ? '**Summary:** ' + 'x'.repeat(60) : BULLETS_ONLY),
    });
    assert.ok(r.calls >= 2, `calls are reported, saw ${r.calls}`);
  }

  console.log('render.test.ts: all assertions passed ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/local/render.test.ts`
Expected: FAIL — `Cannot find module './render'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/local/render.ts
// ============================================================
// local/render.ts — one subscription, rendered by the local model
// ============================================================
//
// The local model is handed SMALL inputs and asked only for prose. Everything
// structural is assembled around its answer (see local/section.ts), and its
// answer is checked for emptiness before use (see local/validate.ts).
//
// A subscription larger than the input cap is split. Each part is asked for
// BULLETS ONLY; one final call writes the Summary over the merged bullets.
// Asking every part for its own Summary would produce several competing
// summaries with no principled way to pick one.

import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';
import { splitSubscriptionContent } from './split';
import { assembleSection, matchTopics } from './section';
import { sectionDefect } from './validate';

export interface LocalRenderResult {
  section: string | null;   // null when the render was defective
  defect:  string | null;   // why, when it was
  calls:   number;          // model calls spent, for the caller's budget
}

export async function renderSubscriptionLocally(params: {
  entry: ManifestEntry;
  content: string;
  interests: InterestsConfig;
  maxInputChars: number;
  // wantSummary=false asks for a "**New Activity:**" bullet list only.
  askProse: (input: string, wantSummary: boolean) => Promise<string>;
}): Promise<LocalRenderResult> {
  const { entry, content, interests, maxInputChars, askProse } = params;
  const topics = matchTopics(content, interests);
  const parts  = splitSubscriptionContent(content, maxInputChars);
  let calls = 0;

  if (parts.length === 0) {
    return { section: null, defect: 'no content to summarise', calls };
  }

  // ---- the common case: one part, one call, Summary and bullets together ----
  if (parts.length === 1) {
    const prose = await askProse(parts[0], true);
    calls += 1;
    if (!prose.trim()) {
      return { section: null, defect: 'model returned empty output', calls };
    }
    const section = assembleSection(entry, prose, topics);
    const defect  = sectionDefect(section);
    return defect ? { section: null, defect, calls } : { section, defect: null, calls };
  }

  // ---- split: bullets per part, then one Summary over all of them ----
  const bulletLines: string[] = [];
  for (const part of parts) {
    const answer = await askProse(part, false);
    calls += 1;
    // A part that comes back empty costs its bullets but not the subscription:
    // the merged result is still checked below, so a total loss is caught.
    for (const line of answer.split('\n')) {
      if (/^[ \t]*[-*][ \t]+\S/.test(line)) bulletLines.push(line.trim());
    }
  }

  if (bulletLines.length === 0) {
    return { section: null, defect: 'no bullets from any part', calls };
  }

  const summary = await askProse(bulletLines.join('\n'), true);
  calls += 1;

  const prose   = `${summary.trim()}\n\n**New Activity:**\n${bulletLines.join('\n')}`;
  const section = assembleSection(entry, prose, topics);
  const defect  = sectionDefect(section);
  return defect ? { section: null, defect, calls } : { section, defect: null, calls };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/local/render.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/local/render.ts src/local/render.test.ts
git commit -m "Render one subscription locally, splitting oversized ones

The local model gets small inputs and is asked only for prose; structure
is assembled around its answer and the answer is checked for emptiness
before use.

A subscription over the input cap is split. Each part is asked for
BULLETS ONLY and one final call writes the Summary over the merged
bullets - asking every part for its own summary would produce several
competing summaries with no principled way to choose.

Empty output is treated as a named defect rather than a crash: measured
2026-09-11, the local model returns an empty string with no error above
~3K input tokens, which makes it the most likely failure on this path."
```

---

### Task 6: Route local-first and escalate per failing group

**Files:**
- Modify: `src/index.ts` — the dispatch block that currently starts at the comment `// ---- Rank, then TRY ONE PASS, and chunk only if that fails ----`
- Test: `src/local/routing.test.ts` (create)

**Interfaces:**
- Consumes: `resolveTiers` (Task 4), `renderSubscriptionLocally` (Task 5), `runChunkedDigest` and `chunkEntries` (existing).
- Produces: `renderLocalFirst(...)` exported from `src/local/render.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/local/routing.test.ts
import assert from 'node:assert/strict';
import { renderLocalFirst } from './render';
import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

const interests: InterestsConfig = { priorityTitles: [], trackedGames: [], keywords: [], notes: '' };

function entry(i: number): ManifestEntry {
  return {
    subscriptionId: i, type: 'thread', title: `Sub ${i}`,
    url: `https://boardgamegeek.com/thread/${i}`, filePath: `/tmp/t${i}.md`,
    itemCount: 1, unreadCount: 1, notificationDate: null,
  };
}
const GOOD = '**Summary:** A genuine discussion took place with several detailed replies.\n\n**New Activity:**\n- alice — said a thing.';

async function main() {
  const entries = [entry(1), entry(2), entry(3)];
  const contents = new Map(entries.map((e) => [e.filePath, `=== Thread: ${e.title} ===\n\n[Post by alice on 9/1/2026]\nbody\n`]));

  // ---- all local: no cloud call is ever made ----
  {
    let local = 0, cloud = 0;
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async () => { local += 1; return GOOD; },
      escalateGroup: async () => { cloud += 1; return null; },
    });
    assert.equal(local, 3, 'one local call per subscription');
    assert.equal(cloud, 0, 'a healthy night never spends a metered token');
    assert.equal(r.skipped.length, 0);
    assert.equal((r.sections.match(/^### \[/gm) ?? []).length, 3);
  }

  // ---- one bad subscription escalates ALONE ----
  {
    let cloud = 0;
    const escalated: string[] = [];
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async (_i, _w, e) => (e.subscriptionId === 2 ? '' : GOOD),
      escalateGroup: async (group) => {
        cloud += 1;
        escalated.push(...group.map((g) => g.title));
        return `### [${group[0].title}](${group[0].url})\n\n**Summary:** Cloud wrote this one after local failed.\n\n**New Activity:**\n- bob — said a thing.`;
      },
    });
    assert.equal(cloud, 1, 'exactly one metered call, for the one failing subscription');
    assert.deepEqual(escalated, ['Sub 2'], 'and only that subscription was escalated');
    assert.equal(r.skipped.length, 0, 'the escalation rescued it');
    assert.equal((r.sections.match(/^### \[/gm) ?? []).length, 3, 'all three sections ship');
  }

  // ---- --local-only never escalates, and records the loss ----
  {
    let cloud = 0;
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: false,
      askLocal: async (_i, _w, e) => (e.subscriptionId === 2 ? '' : GOOD),
      escalateGroup: async () => { cloud += 1; return null; },
    });
    assert.equal(cloud, 0, '--local-only must never spend a metered token');
    assert.deepEqual(r.skipped.map((s) => s.title), ['Sub 2'],
      'the failing subscription is recorded as skipped so notices are not cleared');
    assert.equal((r.sections.match(/^### \[/gm) ?? []).length, 2);
  }

  // ---- a defective local render is RETRIED locally before escalating ----
  //
  // Spec failure ladder step 1. Local calls are unmetered, so a retry is
  // nearly free insurance against a one-off bad generation, and it keeps a
  // transient wobble from spending a metered token.
  {
    let attempts = 0, cloud = 0;
    const r = await renderLocalFirst({
      entries: [entry(1)], contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async () => { attempts += 1; return attempts === 1 ? '' : GOOD; },
      escalateGroup: async () => { cloud += 1; return null; },
    });
    assert.equal(attempts, 2, 'a defective local render is retried locally once');
    assert.equal(cloud, 0, 'and a successful retry never reaches the metered tier');
    assert.equal(r.skipped.length, 0);
  }

  // ---- the retry is not infinite ----
  {
    let attempts = 0, cloud = 0;
    await renderLocalFirst({
      entries: [entry(1)], contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async () => { attempts += 1; return ''; },
      escalateGroup: async () => { cloud += 1; return null; },
    });
    assert.equal(attempts, 2, 'exactly one retry, then escalate');
    assert.equal(cloud, 1);
  }

  // ---- cloud also failing means the subscription is skipped ----
  {
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async (_i, _w, e) => (e.subscriptionId === 3 ? '' : GOOD),
      escalateGroup: async () => null,
    });
    assert.deepEqual(r.skipped.map((s) => s.title), ['Sub 3']);
    assert.ok(r.skipped[0].reason.length > 0, 'the reason is recorded for the morning');
  }

  // ---- the local budget halts the run ----
  {
    let local = 0;
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: false,
      maxLocalCalls: 2,
      askLocal: async () => { local += 1; return GOOD; },
      escalateGroup: async () => null,
    });
    assert.ok(local <= 2, `the local budget must be enforced, saw ${local}`);
    assert.ok(r.skipped.length > 0, 'subscriptions past the budget are recorded as lost');
  }

  console.log('routing.test.ts: all assertions passed ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/local/routing.test.ts`
Expected: FAIL — `renderLocalFirst is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/local/render.ts`:

```typescript
import type { DigestSkippedEntry } from '../agent';
import { log } from '../logger';

export interface LocalFirstResult {
  sections: string;                    // assembled section markdown, in order
  skipped:  DigestSkippedEntry[];      // subscriptions no tier could render
  localCalls: number;
  cloudCalls: number;
}

// ---- renderLocalFirst --------------------------------------------
//
// Every subscription is attempted on the unmetered model. Only one that fails
// escalates, and it escalates ALONE — one stubborn subscription costs one
// metered call, not a night's worth. That containment is the whole point:
// on 2026-09-11 an unconditional fallback would have spent 50 cloud calls.
export async function renderLocalFirst(params: {
  entries: ManifestEntry[];
  contents: Map<string, string>;       // filePath -> data file contents
  interests: InterestsConfig;
  maxInputChars: number;
  escalates: boolean;                  // false under --local-only
  maxLocalCalls?: number;
  askLocal: (input: string, wantSummary: boolean, entry: ManifestEntry) => Promise<string>;
  // Returns assembled section markdown, or null when cloud could not do it.
  escalateGroup: (group: ManifestEntry[]) => Promise<string | null>;
}): Promise<LocalFirstResult> {
  const { entries, contents, interests, maxInputChars, escalates, askLocal, escalateGroup } = params;
  const budget = params.maxLocalCalls ?? Number.MAX_SAFE_INTEGER;

  const rendered: string[] = [];
  const skipped:  DigestSkippedEntry[] = [];
  let localCalls = 0, cloudCalls = 0;

  for (const entry of entries) {
    const content = contents.get(entry.filePath) ?? '';

    if (localCalls >= budget) {
      skipped.push({ title: entry.title, filePath: entry.filePath,
        reason: `local call budget of ${budget} exhausted before this subscription` });
      continue;
    }

    // Attempt, then ONE local retry before spending anything metered.
    // Local calls cost time only, so a retry is near-free insurance against a
    // one-off bad generation — and it keeps a transient wobble from reaching
    // the metered tier at all.
    let result = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars,
      askProse: (input, wantSummary) => askLocal(input, wantSummary, entry),
    });
    localCalls += result.calls;

    if (!result.section) {
      log.debug('Local render defective — retrying locally', { title: entry.title, defect: result.defect });
      result = await renderSubscriptionLocally({
        entry, content, interests, maxInputChars,
        askProse: (input, wantSummary) => askLocal(input, wantSummary, entry),
      });
      localCalls += result.calls;
    }

    if (result.section) { rendered.push(result.section); continue; }

    if (!escalates) {
      skipped.push({ title: entry.title, filePath: entry.filePath,
        reason: `local render failed (${result.defect}) and escalation is disabled` });
      continue;
    }

    const fromCloud = await escalateGroup([entry]);
    cloudCalls += 1;
    if (fromCloud) { rendered.push(fromCloud); continue; }

    skipped.push({ title: entry.title, filePath: entry.filePath,
      reason: `local render failed (${result.defect}) and the cloud escalation also failed` });
  }

  return { sections: rendered.join('\n\n'), skipped, localCalls, cloudCalls };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/local/routing.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/local/render.ts src/local/routing.test.ts
git commit -m "Route local-first, escalating only the subscriptions that fail

Every subscription is attempted on the unmetered model. One that fails
escalates ALONE - one stubborn subscription costs one metered call, not a
night's worth. An unconditional fallback would have spent 50 cloud calls
on 2026-09-11, which is the mistake this containment exists to prevent.

--local-only records a failed subscription as skipped rather than
escalating, so it can never spend a metered token, and a skipped
subscription still withholds BGG notice-clearing."
```

---

### Task 7: Wire the local path into the run and verify end to end

**Files:**
- Modify: `src/index.ts` — dispatch block and the `runOne` budget wrapper
- Modify: `README.md` — a "Local-first generation" section
- Test: manual end-to-end against the preserved workspace

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Read the current dispatch block**

Run: `grep -n "Rank, then TRY ONE PASS" -A 60 src/index.ts`
Read it fully before editing. It already ranks entries, wraps every model call in a `runOne` budget closure, tries one pass, and escalates into `runChunkedDigest`. The local path goes **in front of** that, and the existing cloud path becomes the escalation.

- [ ] **Step 2: Add the local-first branch**

Immediately after `const ranked = rankEntries(entries, interestsConfig);`, insert:

```typescript
    // ---- Local first ------------------------------------------------
    //
    // Local inference is unmetered, so a typical night should cost nothing.
    // The cloud path below is unchanged and now serves as escalation for the
    // subscriptions the local model could not render. See
    // docs/superpowers/specs/2026-09-11-local-first-digest-design.md
    const tiers = resolveTiers(process.argv, config.digest);
    const useLocal = tiers.models[0] === config.digest.localModel;

    if (useLocal) {
      const contents = new Map(
        ranked.map((e) => [e.filePath, fs.existsSync(e.filePath) ? fs.readFileSync(e.filePath, 'utf-8') : '']),
      );

      const localResult = await renderLocalFirst({
        entries: ranked,
        contents,
        interests: interestsConfig,
        maxInputChars: config.digest.maxLocalInputChars,
        escalates: tiers.escalates,
        maxLocalCalls: config.digest.maxLocalCalls,
        askLocal: (input, wantSummary) =>
          askLocalProse(config.digest.localModel, input, wantSummary),
        escalateGroup: async (group) => {
          const chunkManifest = writeManifest(group, digestDataDir);
          const r = await generateGuardedDigest(
            () => runOne(chunkManifest), group.length, { requireHighlights: false },
          );
          return r.status === 'invalid' ? null : stripHighlightsBlock(r.body);
        },
      });

      log.info('Local-first digest complete', {
        localCalls: localResult.localCalls,
        cloudCalls: localResult.cloudCalls,
        skipped:    localResult.skipped.length,
      });

      digestResult = {
        body: localResult.sections,
        inputTokens: 0, outputTokens: 0, costUsd: 0,
        durationMs: Date.now() - runStart.getTime(),
        status:         localResult.skipped.length > 0 ? 'partial' : undefined,
        completedCount: (localResult.sections.match(/^### \[/gm) ?? []).length,
        totalCount:     ranked.length,
        skipped:        localResult.skipped.length > 0 ? localResult.skipped : undefined,
      };
    } else {
```

Close the `else` branch after the existing escalation block (before the
`log.info(\`Digest used ${modelCalls} model call(s)...\`)` line) with `}`.

- [ ] **Step 3: Add the local prose helper**

Create `src/local/ask.ts`:

```typescript
// ============================================================
// local/ask.ts — ask the local model for prose, nothing else
// ============================================================
//
// No tools, no workspace, no manifest. The subscription text goes straight
// into the prompt, which is what makes this tractable for a 9B model: on
// 2026-09-11 a 120B cloud model burned 168 turns on tool calls without ever
// synthesising, and a small model is likelier to do the same.
//
// Talks to ollama's HTTP API directly. num_ctx is set explicitly because
// ollama otherwise defaults to 64000, which pushed a 9B model to 8.3 GB and
// forced an 18% CPU spill on an 8 GB card. At 8192 the same model runs 100%
// on GPU.

const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

const RULES = [
  'Rules:',
  '- The author of a post is the name in [Post by ...]; of a geeklist item, the name in [Item by ...].',
  '- A line starting with > is a QUOTE of an EARLIER post. Those are NOT the words of the person whose post contains them.',
  '- A "↳ Comment by X" line is a DIFFERENT person replying to the item.',
  '- Every bullet must say what the person argued, asked or played. A bullet with only a name is useless.',
  '- Invent nothing. Use only the text below.',
].join('\n');

export async function askLocalProse(
  model: string,
  input: string,
  wantSummary: boolean,
): Promise<string> {
  const shape = wantSummary
    ? '**Summary:** two or three sentences on what is new and the overall tone.\n' +
      (input.includes('\n- ') ? '' : '**New Activity:**\n- <author> — <what they said, one sentence>\n')
    : '**New Activity:**\n- <author> — <what they said, one sentence>\n';

  const prompt =
    `Summarise this BoardGameGeek activity for a daily digest.\n\nOutput EXACTLY this and nothing else:\n\n` +
    `${shape}\n${RULES}\n\nACTIVITY:\n${input}`;

  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, prompt, stream: false,
      options: { num_ctx: 8192, temperature: 0.3, num_predict: 2048 },
    }),
  });
  if (!res.ok) throw new Error(`ollama returned ${res.status} for model ${model}`);
  const body = (await res.json()) as { response?: string };
  return body.response ?? '';
}
```

- [ ] **Step 4: Add the imports to `src/index.ts`**

```typescript
import { renderLocalFirst } from './local/render';
import { askLocalProse } from './local/ask';
import { resolveTiers } from './config';
```

and add `stripHighlightsBlock` to the existing `from './agent'` import list.

- [ ] **Step 5: Verify the whole suite and typecheck**

Run: `npx tsc --noEmit && for f in $(find src -name '*.test.ts' | sort); do npx tsx "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done`
Expected: tsc clean, every file PASS

- [ ] **Step 6: End-to-end against the preserved workspace, local only, no email**

Run: `npx tsx src/index.ts --reuse-data --no-email --local-only --agent pi`
Expected: a digest in `digests/` whose section count is close to the 50 in
`digest-data/manifest.json`, and a log line `Local-first digest complete` with
`cloudCalls: 0`.

Record: wall clock, section count, skipped count.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/local/ask.ts README.md
git commit -m "Run the digest locally first, cloud only where local fails

A typical night now costs zero metered tokens. The cloud path is
unchanged and becomes escalation for the subscriptions the local model
could not render.

askLocalProse talks to ollama's HTTP API with no tools and no workspace -
the subscription text goes straight into the prompt. That is what makes a
9B model viable here: on 2026-09-11 a 120B cloud model burned 168 turns
on tool calls without ever synthesising. num_ctx is set explicitly
because ollama defaults to 64000, which forces a CPU spill on an 8 GB
card; at 8192 the same model runs 100% on GPU."
```

---

### Task 8: Highlights from summary lines, with a mechanical fallback

**Files:**
- Create: `src/local/highlights.ts`
- Test: `src/local/highlights.test.ts`
- Modify: `src/index.ts` — prepend the highlights block to the local body

**Interfaces:**
- Consumes: `ManifestEntry`, `InterestsConfig`.
- Produces:
  - `summaryLines(sections: string): string`
  - `mechanicalHighlights(entries: ManifestEntry[], cfg: InterestsConfig): string`

- [ ] **Step 1: Write the failing test**

```typescript
// src/local/highlights.test.ts
import assert from 'node:assert/strict';
import { summaryLines, mechanicalHighlights } from './highlights';
import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

const cfg: InterestsConfig = {
  priorityTitles: ['SGOYT'], trackedGames: ['Spirit Island'], keywords: ['solo'], notes: '',
};

function entry(over: Partial<ManifestEntry> & { title: string }): ManifestEntry {
  return {
    subscriptionId: 1, type: 'thread', url: 'https://boardgamegeek.com/thread/1',
    filePath: '/tmp/x.md', itemCount: 1, unreadCount: 1, notificationDate: null, ...over,
  };
}

// ---- summaryLines extracts only what the synthesis pass needs ----
//
// Feeding 50 full sections (~40KB) back to a 9B model recreates the overwhelm
// the whole local design avoids. The Summary lines are ~10KB and are what a
// highlights block is built from anyway.
{
  const sections = [
    '### [A](https://x/1)\n\n**Summary:** First thing happened in detail.\n\n**New Activity:**\n- a — x\n\n**Topics Mentioned:** solo',
    '### [B](https://x/2)\n\n**Summary:** Second thing happened in detail.\n\n**New Activity:**\n- b — y\n\n**Topics Mentioned:** none',
  ].join('\n\n');

  const out = summaryLines(sections);
  assert.match(out, /A — First thing happened in detail\./);
  assert.match(out, /B — Second thing happened in detail\./);
  assert.ok(!out.includes('- a — x'), 'bullets are excluded');
  assert.ok(out.length < sections.length / 2, 'the result is substantially smaller');
}

// ---- mechanicalHighlights needs no model at all ----
{
  const entries = [
    entry({ title: 'SGOYT September', selfActivity: { reasons: ['1 comment on your item "Tarawa 1943"'], replyCount: 1 } }),
    entry({ title: 'Random thread', parentName: 'Spirit Island' }),
    entry({ title: 'Unrelated thread' }),
  ];
  const hl = mechanicalHighlights(entries, cfg);

  assert.ok(hl.startsWith('## ⭐ Highlights'), 'uses the exact header the post-processor looks for');
  assert.match(hl, /💬 \*\*Replies to you\*\* —.*Tarawa 1943/, 'replies to you lead');
  assert.match(hl, /SGOYT September/, 'priority subscriptions are named');
  assert.match(hl, /Spirit Island/, 'tracked games are named');
  assert.ok(!hl.includes('Unrelated thread'), 'ordinary subscriptions are not highlighted');
}

// ---- with nothing notable, it still produces a valid block ----
{
  const hl = mechanicalHighlights([entry({ title: 'Unrelated thread' })], cfg);
  assert.ok(hl.startsWith('## ⭐ Highlights'));
  assert.match(hl, /^- /m, 'a block with no bullets would break the digest');
}

console.log('highlights.test.ts: all assertions passed ✓');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/local/highlights.test.ts`
Expected: FAIL — `Cannot find module './highlights'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/local/highlights.ts
// ============================================================
// local/highlights.ts — the cross-subscription block, cheaply
// ============================================================
//
// The synthesis pass reads ONLY the Summary lines. Feeding 50 assembled
// sections (~40KB) back to a 9B model recreates exactly the overwhelm the
// local design exists to avoid; the Summary lines are ~10KB and are the
// material a highlights block is built from anyway.
//
// mechanicalHighlights is the fallback when the model cannot manage even
// that. It needs no model: the pipeline already knows in code which
// subscriptions carry replies to the reader, which match priority titles, and
// which belong to a tracked game. Dull, but never wrong.

import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

export function summaryLines(sections: string): string {
  const out: string[] = [];
  let title = '';
  for (const line of sections.split('\n')) {
    const header = /^###[ \t]+\[(.+?)\]\(/.exec(line);
    if (header) { title = header[1]; continue; }
    const summary = /^\*\*Summary:\*\*[ \t]*(.*)$/.exec(line);
    if (summary && title) out.push(`${title} — ${summary[1].trim()}`);
  }
  return out.join('\n');
}

export function mechanicalHighlights(entries: ManifestEntry[], cfg: InterestsConfig): string {
  const lines = ['## ⭐ Highlights', ''];

  const replies = entries.filter((e) => e.selfActivity);
  if (replies.length > 0) {
    lines.push(`- 💬 **Replies to you** — ${replies
      .map((e) => `${e.title}: ${e.selfActivity!.reasons.join('; ')}`)
      .join(' | ')}`);
  }

  const matches = (hay: string | undefined, needles: string[]): boolean =>
    !!hay && needles.some((n) => n && hay.toLowerCase().includes(n.toLowerCase()));

  const priority = entries.filter((e) => !e.selfActivity && matches(e.title, cfg.priorityTitles));
  if (priority.length > 0) {
    lines.push(`- ⭐ **Priority subscriptions** — ${priority.map((e) => e.title).join(', ')}`);
  }

  for (const game of cfg.trackedGames) {
    const hits = entries.filter((e) => matches(e.parentName, [game]));
    if (hits.length > 0) {
      lines.push(`- ⭐ **${game}** — activity in ${hits.map((e) => e.title).join(', ')}`);
    }
  }

  // A Highlights block with no bullets would read as a generation failure.
  if (lines.length === 2) {
    lines.push(`- ${entries.length} subscription(s) with new activity; nothing matched your tracked games or priority list.`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/local/highlights.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean

- [ ] **Step 5: Use it in `src/index.ts`**

Inside the `useLocal` branch, after `localResult` is produced and before
`digestResult` is assigned:

```typescript
      // Highlights from the Summary lines only — a fraction of the assembled
      // digest. Falls back to the mechanical block, which needs no model.
      let highlights = '';
      try {
        const raw = await askLocalProse(
          config.digest.localModel,
          summaryLines(localResult.sections),
          true,
        );
        highlights = extractHighlightsBlock(raw);
      } catch (err) {
        log.warn('Local highlights pass failed', { err: String(err) });
      }
      if (!highlights) {
        log.info('Using mechanical highlights (no model call)');
        highlights = mechanicalHighlights(ranked, interestsConfig);
      }
```

and set `body: `${highlights}\n\n${localResult.sections}`` in `digestResult`.

- [ ] **Step 6: Re-run end to end and record the result**

Run: `npx tsx src/index.ts --reuse-data --no-email --local-only --agent pi`
Expected: the digest opens with `## ⭐ Highlights` and contains close to 50 sections.

- [ ] **Step 7: Commit**

```bash
git add src/local/highlights.ts src/local/highlights.test.ts src/index.ts
git commit -m "Build local Highlights from summary lines, with a free fallback

The synthesis pass reads only the Summary lines. Feeding 50 assembled
sections (~40KB) back to a 9B model would recreate exactly the overwhelm
the local design exists to avoid; the summary lines are ~10KB and are the
material a highlights block is built from anyway.

mechanicalHighlights is the fallback and needs no model at all - the
pipeline already knows in code which subscriptions carry replies to the
reader, match a priority title, or belong to a tracked game. Dull, but it
cannot be wrong, and a digest is never shipped without a Highlights
block."
```

---

## Verification

After Task 8, confirm all of the following before calling the work done:

- [ ] `npx tsc --noEmit` clean
- [ ] every `src/**/*.test.ts` prints `passed`
- [ ] `npx tsx src/index.ts --reuse-data --no-email --local-only --agent pi` produces a digest with section count within 10% of the manifest count and `cloudCalls: 0`
- [ ] `npx tsx src/index.ts --reuse-data --no-email --cloud-only --agent pi --model nemotron-3-super:cloud` still runs the unchanged cloud path (only when quota allows — otherwise confirm it aborts cleanly via `isFatalRunError`)
- [ ] a run with any skipped subscription logs `NOT clearing BGG notices`
