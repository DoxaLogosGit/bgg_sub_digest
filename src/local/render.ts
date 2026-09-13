// ============================================================
// local/render.ts — one subscription, rendered by the local model
// ============================================================
//
// The local model is handed SMALL inputs and asked only for prose. Everything
// structural is assembled around its answer (local/section.ts), and its answer
// is checked for emptiness before use (local/validate.ts).
//
// A subscription larger than the input cap is split. Each part is asked for
// BULLETS ONLY; one final call writes the Summary over the merged bullets.
// Asking every part for its own Summary would produce several competing
// summaries with no principled way to pick one.
//
// PYTHON CONTEXT: the model call is injected as `askProse` rather than
// imported, so every path here is testable without a model — including the
// failure paths, which are the ones that decide whether a bad night costs data.

import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';
import { splitSubscriptionContent } from './split';
import { groupDuplicateEntries } from './group';
import { assembleSection, matchTopics } from './section';
import { sectionDefect } from './validate';

export interface LocalRenderResult {
  section: string | null;   // null when the render was defective
  defect:  string | null;   // why, when it was
  calls:   number;          // model calls spent, for the caller's budget
}

// How many times to ask for one PART of a split subscription. Local calls cost
// only time; a failed part otherwise costs its items.
const PART_ATTEMPTS = 3;

// Pull the bullet lines out of whatever the model returned. Anything that is
// not a bullet (a stray preamble, a repeated Summary) is discarded — the
// caller supplies the structure.
function bulletsOf(answer: string): string[] {
  return answer
    .split('\n')
    .filter((line) => /^[ \t]*[-*][ \t]+\S/.test(line))
    .map((line) => line.trim());
}

// ---- isStubContent ----------------------------------------------
//
// A stub is what index.ts writes when BGG reported activity we could not
// fetch: blog posts, file pages, a thread whose replies are past the XML API
// window. Its entire body is "New activity on a BGG <type> you subscribe to",
// a context line and a link.
//
// 33 of the 50 subscriptions in the 2026-09-11 workspace were stubs. Handing
// one to a model is pointless and actively harmful: BGG-DATA-GUIDE.md section
// 3 exists to say DO NOT INFER CONTENT for exactly this case, and a model
// asked to summarise "there is no content" will either return nothing (six
// did on 2026-09-12) or invent something unverifiable.
function isStubContent(content: string): boolean {
  return /^New activity on a BGG .+ you subscribe to/m.test(content);
}

// A readable noun for a subscription type. `entry.type` is an API value and
// 'unknown' reads badly in prose ("this unknown's content"); an image upload
// is the commonest thing behind it.
function nounFor(type: string): string {
  switch (type) {
    case 'unknown':            return 'page';
    case 'boardgame':
    case 'boardgameexpansion': return 'game page';
    case 'filepage':           return 'file page';
    case 'blog':               return 'blog post';
    default:                   return type;
  }
}

// ---- stubSection ------------------------------------------------
//
// Rendered entirely in code, costing no model call. Says plainly that the
// content was not retrievable, which is what BGG-DATA-GUIDE.md asks for.
//
// Covers a GROUP of identical stubs, because BGG emits one notice per image:
// a game that gained 30 images arrives as 30 "subscriptions" with the same
// title and parent. One section with a count reads far better than 30
// near-identical blocks — the reader's complaint on 2026-09-12.
function stubSection(group: ManifestEntry[], content: string): string {
  const entry = group[0];
  const noun  = nounFor(entry.type);

  // The parenthetical reason index.ts recorded, e.g. "new items beyond API window".
  const why = /you subscribe to \(([^)]+)\)/.exec(content)?.[1];

  // A failed fetch is NOT "BGG does not expose this" — the same list loaded
  // fine in August. Say what happened, and that its notice was kept.
  if (why && /temporary fetch failure/.test(why)) {
    return [
      `**Summary:** BGG did not return the content of "${entry.title}" tonight (a temporary ` +
      `API failure). Its notice has been left unread, so the next run will try again.`,
      '',
      '**New Activity:**',
      `- ${entry.url}`,
    ].join('\n');
  }

  // The TITLE is included deliberately. A real workspace is mostly stubs, and
  // identical summaries drove isVacuousDigest's distinct-summary ratio to
  // 0.326 against its 0.30 floor. That guard catches a model repeating itself
  // and must not be tripped by our own boilerplate.
  const context = entry.parentName ? ` on ${entry.parentName}` : '';

  const summary = group.length > 1
    ? `${group.length} new "${entry.title}" ${noun}s${context}. BGG does not expose ` +
      `their content through the API, so they are listed rather than summarised.`
    : `New activity on "${entry.title}"${context}, but BGG does not expose this ` +
      `${noun}'s content through the API${why ? ` (${why})` : ''}, so there is ` +
      `nothing to summarise here.`;

  // Cap the link list. Thirty raw urls is the repetition being fixed, not a
  // feature; the first few let the reader jump in, the count tells them the
  // scale, and nothing is hidden because the count is exact.
  const MAX_LINKS = 5;
  const shown = group.slice(0, MAX_LINKS);
  const bullets = shown.map((e) => `- ${e.url}`);
  if (group.length > shown.length) {
    bullets.push(`- …and ${group.length - shown.length} more, all on ${entry.parentName ?? entry.title}`);
  }

  return [
    `**Summary:** ${summary}`,
    '',
    '**New Activity:**',
    ...bullets,
  ].join('\n');
}

// ---- listRecords ------------------------------------------------
//
// Bullets for a part the model never summarised, written entirely in code:
// who posted, what it was about, and a link. No prose, so nothing invented.
//
// WHY (2026-09-13): 5 of the ~8 parts of SGOYT September timed out. Their
// items contributed no bullets, the section still validated on the survivors,
// the run was stamped complete and the notices cleared — about 25 of 50 items,
// including the reader's own, vanished without a trace. A plain listing is a
// poor substitute for a summary and an infinitely better one than silence.
//
// Record shapes come from agent.ts's formatters:
//   [Item by NAME posted D, last activity D] [NEW ITEM] — GAME   + "Link: url"
//   [Post by NAME on D]                     + "Subject: s"       + "Link: url"
export function listRecords(part: string): string[] {
  const bullets: string[] = [];
  for (const record of part.split(/^(?=\[(?:Item|Post) by )/m)) {
    const head = /^\[(?:Item|Post) by (.+?) (?:posted|on) [^\]]*\](.*)$/m.exec(record);
    if (!head) continue;                               // the file header, not a record

    const who     = head[1].trim();
    const game    = /—\s*(.+)$/.exec(head[2])?.[1]?.trim();
    const subject = /^Subject:[ \t]*(.+)$/m.exec(record)?.[1]?.trim();
    const link    = /^Link:[ \t]*(\S+)/m.exec(record)?.[1];
    const what    = game ?? subject ?? 'post';

    bullets.push(`- ${who} — ${link ? `[${what}](${link})` : what} (not summarised)`);
  }
  return bullets;
}

// ---- describeBullets --------------------------------------------
//
// A summary of last resort, derived from the bullets rather than from the
// model. Purely factual — a count and the names that appear — so it can be
// wrong only if the bullets are.
function describeBullets(bullets: string[]): string {
  const names = bullets
    .map((b) => /^[-*][ \t]+\*{0,2}([^—:*]+?)\*{0,2}[ \t]*[—:-]/.exec(b)?.[1]?.trim())
    .filter((n): n is string => !!n && n.length < 40);

  const unique = [...new Set(names)];
  const who = unique.length === 0 ? ''
    : unique.length <= 3 ? ` from ${unique.join(', ')}`
    : ` from ${unique.slice(0, 3).join(', ')} and ${unique.length - 3} others`;

  return `${bullets.length} new item${bullets.length === 1 ? '' : 's'}${who}. ` +
         `A written summary was not available for this subscription, so the activity is listed below.`;
}

// ---- normaliseProse ---------------------------------------------
//
// The model writes prose; the MARKERS are structure and belong to us.
//
// Observed 2026-09-12 on the SGOYT split path: the summary call returned a
// perfectly good sentence with no "**Summary:**" prefix and the section was
// thrown away for "no Summary line" — a 61KB subscription lost to a missing
// six characters. Repair rather than reject.
function normaliseSummary(answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed) return '';

  const marked = /^\*{0,2}Summary:?\*{0,2}[ \t]*([\s\S]*)$/i.exec(trimmed);
  const text   = (marked ? marked[1] : trimmed).trim();

  // Drop anything the model appended after the summary — a bullet list it was
  // not asked for, or a second heading. The caller owns the bullets.
  const firstBlock = text.split(/\n\s*\n|\n(?=[ \t]*[-*][ \t]+)|\n(?=\*\*)/)[0].trim();
  return firstBlock;
}

export async function renderSubscriptionLocally(params: {
  entry: ManifestEntry;
  // Identical sibling stubs rendered by this same section, if any. BGG emits
  // one notice per image, so a game with 30 new images arrives as 30 entries.
  group?: ManifestEntry[];
  content: string;
  interests: InterestsConfig;
  maxInputChars: number;
  // wantSummary=false asks for a "**New Activity:**" bullet list only.
  askProse: (input: string, wantSummary: boolean) => Promise<string>;
}): Promise<LocalRenderResult> {
  const { entry, content, interests, maxInputChars, askProse } = params;
  const group = params.group ?? [entry];
  const topics = matchTopics(content, interests);
  let calls = 0;

  if (!content.trim()) {
    return { section: null, defect: 'no content to summarise', calls };
  }

  // ---- stubs never reach the model ----
  //
  // There is no content to summarise, and asking anyway invites invention.
  // Free, deterministic, and honest about what BGG did not give us.
  if (isStubContent(content)) {
    const section = assembleSection(entry, stubSection(group, content), topics);
    const defect  = sectionDefect(section);
    return defect ? { section: null, defect, calls } : { section, defect: null, calls };
  }

  const parts = splitSubscriptionContent(content, maxInputChars);
  if (parts.length === 0) {
    return { section: null, defect: 'no content to summarise', calls };
  }

  // ---- the common case: one part, one call, Summary and bullets together ----
  if (parts.length === 1) {
    const answer = await askProse(parts[0], true);
    calls += 1;

    // Measured 2026-09-11: the local model returns an empty string with no
    // error when the input is too long. Name it rather than letting an empty
    // section fall through to a confusing downstream defect.
    if (!answer.trim()) {
      return { section: null, defect: 'model returned empty output', calls };
    }

    // The model supplies prose; we own the markers. A good summary that
    // forgot its prefix must not cost the whole subscription.
    const bullets = bulletsOf(answer);
    const prose = bullets.length > 0
      ? `**Summary:** ${normaliseSummary(answer)}\n\n**New Activity:**\n${bullets.join('\n')}`
      : `**Summary:** ${normaliseSummary(answer)}`;

    const section = assembleSection(entry, prose, topics);
    const defect  = sectionDefect(section);
    return defect ? { section: null, defect, calls } : { section, defect: null, calls };
  }

  // ---- split: bullets per part, then one Summary over all of them ----
  const bulletLines: string[] = [];   // everything shown, in source order
  const summarised:  string[] = [];   // only what the model wrote
  let unsummarisedItems = 0;

  for (const part of parts) {
    // Retry each part on its own. The whole-subscription retry in
    // renderLocalFirst fires only when the section is DEFECTIVE, and one good
    // part is enough to make it valid — so without this a dead part was never
    // retried at all (2026-09-13).
    let bullets: string[] = [];
    for (let tryNo = 1; bullets.length === 0 && tryNo <= PART_ATTEMPTS; tryNo++) {
      bullets = bulletsOf(await askProse(part, false));
      calls += 1;
    }

    if (bullets.length > 0) {
      bulletLines.push(...bullets);
      summarised.push(...bullets);
    } else {
      // Still nothing: list the part's records in code rather than drop them.
      const listed = listRecords(part);
      bulletLines.push(...listed);
      unsummarisedItems += listed.length;
    }
  }

  // No part summarised at all is still a defect, so the caller's retry and
  // escalation ladder gets its turn before settling for a bare listing.
  if (summarised.length === 0) {
    return { section: null, defect: 'no bullets from any part', calls };
  }

  const summary = await askProse(summarised.join('\n'), true);
  calls += 1;

  // A flaky empty summary must not cost a subscription whose bullets are
  // already in hand. SGOYT September (61KB, 8 parts) was lost exactly this way
  // on 2026-09-12. The fallback states what the bullets contain and invents
  // nothing.
  let summaryText = normaliseSummary(summary) || describeBullets(summarised);

  // Say so when part of the section is a bare listing — otherwise the reader
  // takes the summary as covering everything below it.
  if (unsummarisedItems > 0) {
    summaryText += ` ${unsummarisedItems} item${unsummarisedItems === 1 ? '' : 's'} ` +
      `could not be summarised and ${unsummarisedItems === 1 ? 'is' : 'are'} listed by title only.`;
  }

  const prose = `**Summary:** ${summaryText}\n\n**New Activity:**\n${bulletLines.join('\n')}`;
  const section = assembleSection(entry, prose, topics);
  const defect  = sectionDefect(section);
  return defect ? { section: null, defect, calls } : { section, defect: null, calls };
}

// ============================================================
// renderLocalFirst — the whole digest, local first
// ============================================================
//
// Every subscription is attempted on the unmetered model. One that fails is
// retried locally (free), and only then escalates — ALONE.
//
// That containment is the point. On 2026-09-11 the pipeline exhausted the
// monthly quota on both providers in a day; an unconditional "fall back to
// cloud" would have spent 50 metered calls in one night. One stubborn
// subscription costs one metered call.
//
// Anything no tier could render is returned in `skipped`, which makes the
// caller withhold BGG notice-clearing. That rule held on 09-10 and 09-11 and
// is what keeps a bad night from becoming lost activity.

import type { DigestSkippedEntry } from '../agent';
import { isFatalRunError } from '../agent';
import { log } from '../logger';

// How many times to ask the local model before escalating. Three, because the
// failure it guards against is intermittent emptiness and each attempt is
// free — see the loop in renderLocalFirst.
const LOCAL_ATTEMPTS = 3;

export interface LocalFirstResult {
  sections:   string;                 // assembled section markdown, in ranked order
  skipped:    DigestSkippedEntry[];   // subscriptions no tier could render
  localCalls: number;
  cloudCalls: number;
}

export async function renderLocalFirst(params: {
  entries: ManifestEntry[];
  contents: Map<string, string>;      // filePath -> data file contents
  interests: InterestsConfig;
  maxInputChars: number;
  escalates: boolean;                 // false under --local-only
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

  // Set when the metered tier refuses for a reason that dooms every later
  // call — an exhausted quota or budget. Local rendering continues; only
  // escalation stops.
  let meteredExhausted = false;

  // Collapse identical stubs before rendering. BGG emits one notice per image,
  // so a game that gained 30 images arrives as 30 entries with the same title
  // and parent; one section with a count reads far better than 30 blocks.
  // Only stubs group — merging two real subscriptions would merge their
  // content, a worse bug than the repetition being fixed.
  const groups = groupDuplicateEntries(entries, (e) => {
    const c = contents.get(e.filePath) ?? '';
    return isStubContent(c);
  });

  for (const group of groups) {
    const entry   = group[0];
    const content = contents.get(entry.filePath) ?? '';

    if (localCalls >= budget) {
      // Every member of the group is unrendered, so every member is skipped —
      // otherwise the caller would clear notices for entries never summarised.
      skipped.push(...group.map((e) => ({
        title: e.title, filePath: e.filePath, url: e.url,
        reason: `local call budget of ${budget} exhausted before this subscription`,
      })));
      continue;
    }

    const attempt = (): Promise<LocalRenderResult> => renderSubscriptionLocally({
      entry, group, content, interests, maxInputChars,
      askProse: (input, wantSummary) => askLocal(input, wantSummary, entry),
    });

    // Retry locally several times before spending anything metered.
    //
    // Measured 2026-09-12: the local model returns an empty response
    // INTERMITTENTLY. The same 565-byte thread that failed twice inside a run
    // produced good output on a manual retry moments later, so this is
    // flakiness rather than a property of the input. Local calls cost only
    // time, and time is free at 03:00 — so buy several.
    let result = await attempt();
    localCalls += result.calls;

    for (let tryNo = 2; !result.section && tryNo <= LOCAL_ATTEMPTS; tryNo++) {
      log.debug('Local render defective — retrying locally', {
        title: entry.title, defect: result.defect, attempt: tryNo,
      });
      result = await attempt();
      localCalls += result.calls;
    }

    if (result.section) { rendered.push(result.section); continue; }

    if (!escalates) {
      skipped.push(...group.map((e) => ({
        title: e.title, filePath: e.filePath, url: e.url,
        reason: `local render failed (${result.defect}) and escalation is disabled`,
      })));
      continue;
    }

    if (meteredExhausted) {
      skipped.push(...group.map((e) => ({
        title: e.title, filePath: e.filePath, url: e.url,
        reason: `local render failed (${result.defect}); the metered tier is exhausted`,
      })));
      continue;
    }

    log.info('Escalating one subscription to the metered model', {
      title: entry.title, defect: result.defect,
    });

    // An escalation that THROWS must not take the night with it. Unwrapped,
    // a 429 from the metered model propagated out of this function and
    // discarded every section already rendered — the exact shape of a
    // quota-exhausted night (2026-09-11, both providers in one day).
    let fromCloud: string | null = null;
    try {
      fromCloud = await escalateGroup(group);
    } catch (err) {
      if (isFatalRunError(err)) {
        // Every later escalation fails identically; continuing through them
        // cost 22 doomed calls on 2026-09-11. Stop asking.
        meteredExhausted = true;
        log.error('Metered tier exhausted — remaining failures will be skipped', { err: String(err) });
      } else {
        log.warn('Cloud escalation threw', { title: entry.title, err: String(err) });
      }
    }
    cloudCalls += 1;
    if (fromCloud) { rendered.push(fromCloud); continue; }

    skipped.push(...group.map((e) => ({
      title: e.title, filePath: e.filePath, url: e.url,
      reason: `local render failed (${result.defect}) and the cloud escalation also failed`,
    })));
  }

  return { sections: rendered.join('\n\n'), skipped, localCalls, cloudCalls };
}
