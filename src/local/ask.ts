// ============================================================
// local/ask.ts — ask the local model for prose, nothing else
// ============================================================
//
// No tools, no workspace, no manifest. The subscription text goes straight
// into the prompt.
//
// WHY THAT MATTERS: on 2026-09-11 nemotron-3-super (a 120B CLOUD model) burned
// 168 turns on tool calls without ever synthesising — "pi ran 168 turn(s) but
// no turn produced assistant text". A 9B model is likelier to do the same, not
// less. Feeding one subscription per call leaves nothing to orchestrate: no
// manifest to read, no files to open, no turn loop to get lost in. That is why
// the local probes worked first time.
//
// num_ctx is set EXPLICITLY. ollama otherwise defaults to 64000, which pushed
// a 9B model to 8.3 GB and forced an 18% CPU spill on an 8188 MiB card. At
// 8192 the same model runs 100% on GPU (measured 2026-09-11).

const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

// Context window for a local call. The caller already caps the INPUT
// (maxLocalInputChars, ~3K tokens), so this only needs headroom for the
// prompt plus the answer.
const NUM_CTX = 8192;

// Output budget for one call.
//
// omnicoder-oc is a THINKING model: its reasoning is generated before the
// visible answer and spends the same budget. At 2048 it can reason itself out
// of room and return an EMPTY string — measured 2026-09-12, where a 4.7KB
// geeklist burned 2-8 minutes per attempt and produced nothing, three attempts
// running. The same input at 4096 answered in 10 seconds.
//
// Do NOT "fix" a recurrence with think:false. That was tried: the model then
// leaks its reasoning into the answer ("The user wants me to summarize...").
const NUM_PREDICT = 4096;

// Hard ceiling on a single local call.
//
// One subscription must not be able to eat the night. Nothing healthy has
// taken longer than ~60s (the slowest good render measured was 38s), so this
// is generous, and a call that exceeds it is failing rather than working.
const CALL_TIMEOUT_MS = 150_000;

// The attribution rules from BGG-DATA-GUIDE.md, restated here because this
// path deliberately does not load the workspace. Misattributing quoted text is
// the error the reader notices most, and both local models handled it
// correctly in the spike when told this explicitly.
const RULES = [
  'Rules:',
  '- The author of a post is the name in [Post by ...]; of a geeklist item, the name in [Item by ...].',
  '- A line starting with > is a QUOTE of an EARLIER post. Those are NOT the words of the person whose post contains them.',
  '- A "↳ Comment by X" line is a DIFFERENT person replying to that item.',
  '- Every bullet must say what the person argued, asked, or played. A bullet with only a name is useless.',
  '- Invent nothing. Use only the text below.',
].join('\n');

export async function askLocalProse(
  model: string,
  input: string,
  wantSummary: boolean,
): Promise<string> {
  // Two shapes. A summary pass over already-merged bullets must NOT ask for
  // bullets again, or the model rewrites them and duplicates the list.
  const summarisingBullets = wantSummary && /^[ \t]*[-*][ \t]+\S/m.test(input) && !input.includes('[Post by ') && !input.includes('[Item by ');

  const shape = summarisingBullets
    ? '**Summary:** two or three sentences covering the activity listed below.'
    : wantSummary
      ? '**Summary:** two or three sentences on what is new and the overall tone.\n' +
        '**New Activity:**\n- <author> — <what they said, one sentence>'
      : '**New Activity:**\n- <author> — <what they said, one sentence>';

  const prompt =
    'Summarise this BoardGameGeek activity for a daily digest.\n\n' +
    `Output EXACTLY this and nothing else:\n\n${shape}\n\n${RULES}\n\nACTIVITY:\n${input}`;

  // A stuck call returns '' rather than throwing, so the caller treats it as
  // an ordinary defective render and retries — which is exactly right, since
  // an over-long call is a failing one.
  let res: Response;
  try {
    res = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { num_ctx: NUM_CTX, temperature: 0.3, num_predict: NUM_PREDICT },
      }),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return '';
    }
    throw err;
  }

  if (!res.ok) {
    throw new Error(`ollama returned ${res.status} for model ${model}`);
  }
  const body = (await res.json()) as { response?: string };
  return body.response ?? '';
}
