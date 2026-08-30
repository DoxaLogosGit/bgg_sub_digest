// ============================================================
// agent.pi-cli-args.test.ts — flag construction for tallow vs pi
// ============================================================
//
// Standalone test (the project has no test framework yet). Run it with:
//   npx tsx src/agent.pi-cli-args.test.ts
//
// WHAT IT GUARDS:
//   tallow and pi speak the SAME JSONL event protocol (tallow is built on
//   pi), so runPiProtocolDigest() streams and parses both identically. The
//   ONLY thing that differs is the command line, and the differences are
//   easy to get subtly wrong:
//
//     1. tallow takes ONE combined "provider/model" string (--model
//        ollama/x). pi wants them SEPARATE (--provider ollama --model x).
//     2. Model ids legitimately contain colons — gpt-oss:20b-cloud,
//        nemotron-3-nano:30b-cloud. Splitting the provider prefix on the
//        wrong character mangles them into a model that does not exist,
//        which surfaces as pi's "Model ollama/X not found" FATAL.
//     3. Both need a non-interactive approval switch (--yolo / --approve).
//        Without it an unattended cron run blocks forever on a tool-permission
//        prompt that nobody is there to answer — the process just hangs until
//        the timeout SIGKILLs it.
//
// These are pure-function assertions: no process is spawned.

import assert from 'node:assert/strict';
import { buildAgentCliArgs } from './agent';

const PROMPT = 'Read manifest.json and write the digest.';

// Small helper: value that follows a flag, or undefined if the flag is absent.
// Python: args[args.index(flag) + 1] but None-safe.
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

// ---- 1. tallow keeps the combined provider/model string ----
{
  const args = buildAgentCliArgs('tallow', 'ollama/nemotron-3-super:cloud', PROMPT);

  assert.ok(args.includes('--yolo'), 'tallow must pass --yolo for unattended runs');
  assert.equal(valueAfter(args, '--mode'), 'json');
  assert.equal(
    valueAfter(args, '--model'), 'ollama/nemotron-3-super:cloud',
    'tallow takes provider/model as ONE argument',
  );
  assert.ok(!args.includes('--provider'), 'tallow has no --provider flag');
  assert.equal(valueAfter(args, '--print'), PROMPT, 'tallow takes the prompt after --print');
}

// ---- 2. pi splits provider off the model ----
{
  const args = buildAgentCliArgs('pi', 'ollama/nemotron-3-super:cloud', PROMPT);

  assert.ok(args.includes('--approve'), 'pi must pass --approve for unattended runs');
  assert.ok(args.includes('--print'), 'pi needs --print for non-interactive mode');
  assert.equal(valueAfter(args, '--mode'), 'json');
  assert.equal(valueAfter(args, '--provider'), 'ollama');
  assert.equal(
    valueAfter(args, '--model'), 'nemotron-3-super:cloud',
    'pi wants the BARE model id, provider stripped',
  );
  assert.equal(args[args.length - 1], PROMPT, 'pi takes the prompt as a positional arg');
}

// ---- 3. a colon in the model id must survive the split ----
// Regression guard for the class of bug that produced "Model ollama/... not
// found": splitting on ':' instead of the first '/' would turn
// "gpt-oss:20b-cloud" into "gpt-oss".
{
  const args = buildAgentCliArgs('pi', 'ollama/gpt-oss:20b-cloud', PROMPT);
  assert.equal(valueAfter(args, '--provider'), 'ollama');
  assert.equal(valueAfter(args, '--model'), 'gpt-oss:20b-cloud');
}
{
  const args = buildAgentCliArgs('pi', 'ollama/nemotron-3-nano:30b-cloud', PROMPT);
  assert.equal(valueAfter(args, '--model'), 'nemotron-3-nano:30b-cloud');
}

// ---- 4. a bare model id (no provider prefix) omits --provider ----
// pi then falls back to defaultProvider from its settings.json rather than
// being handed an empty string, which it would reject.
{
  const args = buildAgentCliArgs('pi', 'gpt-oss:20b-cloud', PROMPT);
  assert.ok(!args.includes('--provider'), 'no prefix => no --provider flag at all');
  assert.equal(valueAfter(args, '--model'), 'gpt-oss:20b-cloud');
}

// ---- 5. only the FIRST slash separates provider from model ----
// Defensive: some registries use slashes inside the model path itself
// (e.g. a HuggingFace-style "org/name"). Everything after the first slash
// belongs to the model.
{
  const args = buildAgentCliArgs('pi', 'ollama/carstenuhlig/omnicoder-2-9b:latest', PROMPT);
  assert.equal(valueAfter(args, '--provider'), 'ollama');
  assert.equal(
    valueAfter(args, '--model'), 'carstenuhlig/omnicoder-2-9b:latest',
    'only the first slash is the provider separator',
  );
}

// ---- 6. the prompt is never split or mangled ----
// The real prompt contains newlines and punctuation; spawn() with an args
// array passes it through without a shell, so it must arrive intact as ONE
// element for both agents.
{
  const gnarly = 'Line one\nLine "two" with `backticks` and $VARS';
  for (const bin of ['tallow', 'pi'] as const) {
    const args = buildAgentCliArgs(bin, 'ollama/x:cloud', gnarly);
    assert.equal(
      args.filter((a) => a === gnarly).length, 1,
      `${bin}: prompt must appear exactly once, unmodified`,
    );
  }
}

console.log('✓ agent.pi-cli-args.test.ts — all assertions passed');
