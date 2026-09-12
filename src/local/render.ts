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
import { assembleSection, matchTopics } from './section';
import { sectionDefect } from './validate';

export interface LocalRenderResult {
  section: string | null;   // null when the render was defective
  defect:  string | null;   // why, when it was
  calls:   number;          // model calls spent, for the caller's budget
}

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

// ---- stubSection ------------------------------------------------
//
// Rendered entirely in code, costing no model call. Says plainly that the
// content was not retrievable, which is what the data guide asks for.
function stubSection(entry: ManifestEntry, content: string): string {
  // The parenthetical reason index.ts recorded, e.g. "content fetch failed".
  const why = /you subscribe to \(([^)]+)\)/.exec(content)?.[1];

  const summary =
    `BGG reported new activity on this ${entry.type}, but its content is not ` +
    `retrievable through the API${why ? ` (${why})` : ''}, so there is nothing to summarise here.`;

  const bullet = `Open the ${entry.type} to see what changed — ${entry.url}`;

  return [
    `**Summary:** ${summary}`,
    '',
    '**New Activity:**',
    `- ${bullet}`,
  ].join('\n');
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
         `A written summary was not available for this subscription, so the activity is listed in full below.`;
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
  content: string;
  interests: InterestsConfig;
  maxInputChars: number;
  // wantSummary=false asks for a "**New Activity:**" bullet list only.
  askProse: (input: string, wantSummary: boolean) => Promise<string>;
}): Promise<LocalRenderResult> {
  const { entry, content, interests, maxInputChars, askProse } = params;
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
    const section = assembleSection(entry, stubSection(entry, content), topics);
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
  const bulletLines: string[] = [];
  for (const part of parts) {
    const answer = await askProse(part, false);
    calls += 1;
    // A part that comes back empty costs its own bullets but not the whole
    // subscription — the merged result is still validated below, so a total
    // loss is caught while a partial one still ships what survived.
    bulletLines.push(...bulletsOf(answer));
  }

  if (bulletLines.length === 0) {
    return { section: null, defect: 'no bullets from any part', calls };
  }

  const summary = await askProse(bulletLines.join('\n'), true);
  calls += 1;

  // A flaky empty summary must not cost a subscription whose bullets are
  // already in hand. SGOYT September (61KB, 8 parts) was lost exactly this way
  // on 2026-09-12. The fallback states what the bullets contain and invents
  // nothing.
  const summaryText = normaliseSummary(summary) || describeBullets(bulletLines);

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

  for (const entry of entries) {
    const content = contents.get(entry.filePath) ?? '';

    if (localCalls >= budget) {
      skipped.push({
        title: entry.title, filePath: entry.filePath,
        reason: `local call budget of ${budget} exhausted before this subscription`,
      });
      continue;
    }

    const attempt = (): Promise<LocalRenderResult> => renderSubscriptionLocally({
      entry, content, interests, maxInputChars,
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
      skipped.push({
        title: entry.title, filePath: entry.filePath,
        reason: `local render failed (${result.defect}) and escalation is disabled`,
      });
      continue;
    }

    log.info('Escalating one subscription to the metered model', {
      title: entry.title, defect: result.defect,
    });
    const fromCloud = await escalateGroup([entry]);
    cloudCalls += 1;
    if (fromCloud) { rendered.push(fromCloud); continue; }

    skipped.push({
      title: entry.title, filePath: entry.filePath,
      reason: `local render failed (${result.defect}) and the cloud escalation also failed`,
    });
  }

  return { sections: rendered.join('\n\n'), skipped, localCalls, cloudCalls };
}
