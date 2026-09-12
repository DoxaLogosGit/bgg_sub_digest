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

    // Measured 2026-09-11: the local model returns an empty string with no
    // error above ~3K input tokens. Name it rather than letting an empty
    // section fall through to a confusing downstream defect.
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

  const prose   = `${summary.trim()}\n\n**New Activity:**\n${bulletLines.join('\n')}`;
  const section = assembleSection(entry, prose, topics);
  const defect  = sectionDefect(section);
  return defect ? { section: null, defect, calls } : { section, defect: null, calls };
}
