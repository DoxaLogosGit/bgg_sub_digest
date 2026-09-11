# Local-first digest generation

*2026-09-11*

## Problem

The digest spent its entire monthly quota on **both** providers within a day.
Pre-chunking the pipeline made 1 model call per night (09-05 .. 09-09). On
09-11 it made 41 against ollama, exhausted the account mid-run, then 37 against
Claude during the cleanup and exhausted that too. Model calls are a metered
resource and the chunked design did not treat them as one.

The `f8f0d0a` fixes put the cloud baseline back to one call per night. This
spec addresses the next question: **most nights should cost nothing at all.**

Local inference on the existing RTX 4070 (8 GB) is unmetered. A spike on
2026-09-11 established it is good enough to be the default:

| measurement | result |
|---|---|
| `omnicoder-oc` on a real 6.6 KB thread, via pi, with tool use | 33 s, accurate, correct attribution |
| same model, 10 geeklist items | 24 s, 10/10 items covered |
| input above ~3 K tokens (25+ items) | **silent empty output** |
| VRAM at 8 K / 16 K / 32 K context | 5.6 / 5.9 / 6.4 GB, **100% GPU** |

Two corrections from that spike matter here. `pi` is **not** broken — it blocks
when stdin is left open, and drives local models fine (`pi --list-models` uses
its own catalog: `omnicoder-oc`, not `omnicoder-oc:latest`). And VRAM is **not**
the constraint; the input cliff is a model limit, so the fix is capping input,
not buying memory.

## Goals

- A typical night costs **zero metered tokens**.
- Quality stays acceptable; where local cannot do the job, cloud finishes it.
- Metered escalation is confined to the specific groups that failed, never
  "the whole night falls back to cloud".
- The operator can force either tier from the command line.

## Non-goals

- Replacing the cloud path. It stays exactly as `f8f0d0a` left it and is what
  escalation runs.
- Proactive quota detection — no provider API exposes it (`ollama` offers only
  `signin`/`signout`). Detection stays reactive via `isFatalRunError`.
- Supporting every local model. `omnicoder-oc` is the pick; `granite4.1:8b` is
  a faster alternative once its output limit is raised. `qwen3.5:9b` is
  excluded — it returned 0 visible characters from 6,177 tokens.

## Design

### 1. Model tiers and routing

Config gains two named models instead of relying solely on `--model`:

```json
"digest": {
  "localModel": "omnicoder-oc",
  "cloudModel": "nemotron-3-super:cloud"
}
```

Default run: **every group is attempted locally first.** A group that is still
defective after local retries and splitting escalates to `cloudModel` for a
single call. Cloud is never used for a group local handled.

This is deliberately per-group, not per-run. A night where one subscription
defeats the local model costs one metered call, not fifty.

### 2. CLI flags

| flag | behaviour |
|---|---|
| *(none)* | local first, per-group cloud escalation |
| `--cloud-only` | skip local; run today's cloud path unchanged |
| `--local-only` | never escalate; guarantees zero metered spend |
| `--model X` | unchanged — forces exactly one model, no tiering |

`--cloud-only` exists so a night that matters can have the better model without
editing config. `--local-only` exists so a night near a quota ceiling cannot
spend anything.

### 3. Budgets differ by tier

The scarce resource is different on each side, so one number cannot serve both:

- **local**: `maxLocalCalls`, default 120. Bounds runtime only.
- **cloud**: the existing `maxModelCalls`, default 12. Bounds spend, and an
  exhausted budget aborts the run via `isFatalRunError`.

### 4. Code writes the structure; the model writes prose

The manifest already holds the title, URL, `parentName` and `selfActivity`. In
the local path the code emits those directly and asks the model only for the
parts that need judgement:

```
### [Title](URL)               <- manifest, never the model
*Parent: Name*                 <- manifest
**💬 Replies to you:** ...     <- already computed in TypeScript
**Summary:** <model>           <- model
**New Activity:**
- <model bullets>              <- model
**Topics Mentioned:** ...      <- matched in code against interests.toml
```

This is the fix for the spike's one real defect: the model wrote
`### Question about traits...` instead of `### [Title](URL)`, which scored 0
sections. A model that never writes a link cannot write a broken one. It also
shrinks the local prompt to "summarise this and say who said what", which is
what the 9B model already does well.

### 5. Splitting inside a subscription

Local calls are capped by **input size**, not subscription count:
`maxLocalInputChars`, default 12000 (~3 K tokens, comfortably under the
measured cliff).

A subscription whose data file exceeds the cap is split on item/post
boundaries (`^\[Item by ` / `^\[Post by `) into parts. Each part is asked for
**bullets only**. One final short call writes the `**Summary:**` from the
merged bullets. All of these are free.

SGOYT (50 items, 61 KB) becomes ~5 part-calls plus 1 summary call.

### 6. Highlights

Local, over **only the `**Summary:**` lines** from the assembled sections
(~50 x 200 chars ~= 10 KB) rather than the full digest. Untested — if the local
model cannot do it, fall back to a mechanical block built in code from
`selfActivity`, `priority_titles` and `tracked_games` matches. Dull but always
correct, and no model call at all.

### 7. Guards must change for this path

`isTruncatedDigest` counts `^### \[` headers. Once **code** writes those, they
are always present and the guard goes blind — which would recreate the 09-10
failure (a digest that looks structurally fine and says nothing) in a new
costume.

For the local path, validity is checked per section instead:

- a non-empty `**Summary:**` line, and
- at least one bullet under `**New Activity:**`

A section failing that is defective and drives the existing retry / split /
escalate ladder. The whole-digest guards (`isVacuousDigest`, coverage against
the manifest count) still apply to the assembled result.

## Failure handling

Unchanged in spirit from the cloud path, and safety-first:

1. local call defective -> retry locally
2. still defective -> split the input and retry the parts locally
3. smallest part still defective -> escalate that group to cloud (one call),
   unless `--local-only`
4. cloud also fails -> the group's subscriptions are recorded as `skipped`

Any skipped subscription means **BGG notices are not cleared**, so the night
re-fetches rather than disappearing. This is the rule that held on both 09-10
and 09-11 and must not be weakened.

## Testing

- Pure unit tests for input splitting: boundaries respected, nothing dropped or
  duplicated, a part never exceeds the cap.
- Section assembly: code-written header matches the manifest exactly; the
  replies-to-you line appears only when `selfActivity` is present.
- Per-section validity guard: empty Summary and zero-bullet cases both caught.
- Routing, with an injected runner: local-only never calls cloud; default
  escalates only the failing group; `--cloud-only` never calls local.
- End-to-end against the preserved 09-11 workspace (50 subscriptions), local
  only, measuring coverage and wall clock. Free.

## Open risks

- **Quality across the whole feed is unproven.** The spike covered one thread
  and one geeklist. Trade/sale threads, blogs and stub types are untested.
- **Local highlights are unproven**; the mechanical fallback exists for that.
- **Runtime** is roughly 30-40 minutes for 50 subscriptions. Acceptable at
  03:00 and explicitly not a constraint per the operator.
