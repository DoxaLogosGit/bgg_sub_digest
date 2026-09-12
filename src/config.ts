// ============================================================
// config.ts — load and validate config.json using Zod
//
// PYTHON CONTEXT: Zod is TypeScript's equivalent of Pydantic.
// You define a schema using Zod's fluent API, then call .parse()
// on raw data (usually JSON). If the data doesn't match the schema,
// .parse() throws a descriptive error. If it matches, you get back
// a fully typed object that TypeScript knows the shape of.
//
// Pydantic equivalent:
//   class BggConfig(BaseModel):
//       username: str
//       password: str
//       apiKey: str
//
//   class DigestConfig(BaseModel):
//       outputDir: str = './digests'
//       scheduleMode: Literal['daily', 'weekly'] = 'daily'
//       ...
//
//   class AppConfig(BaseModel):
//       bgg: BggConfig
//       digest: DigestConfig
//
// The major benefit: TypeScript infers the type from the schema automatically.
// You never have to separately write an interface AND a validator.
// ============================================================

// Node.js built-in filesystem module (equivalent to Python's pathlib/os)
import * as fs from 'fs';
import * as path from 'path';

// `z` is the conventional import name for the Zod library.
// All Zod schema constructors live on this `z` object.
import { z } from 'zod';
import * as TOML from 'smol-toml';
import type { InterestsConfig } from './interests';

// ---- Schema definition ----------------------------------------
//
// z.object({ ... }) creates a schema for a plain object (like a dict).
// z.string(), z.number(), z.boolean() validate primitive types.
// .min(1, 'message') is a refinement — like Pydantic's Field(min_length=1).
// .default(value) provides a fallback if the JSON key is missing.
// z.enum([...]) validates that the value is one of the listed strings.

const ConfigSchema = z.object({
  // The `bgg` key in config.json — holds login credentials
  bgg: z.object({
    username: z.string().min(1, 'BGG username is required'),
    password: z.string().min(1, 'BGG password is required'),

    // The BGG XML API application token. Required for API access —
    // requests without it may be rejected by Cloudflare.
    apiKey:   z.string().min(1, 'BGG XML API key is required'),
  }),

  // The `digest` key in config.json — controls behavior of each run
  digest: z.object({
    // Where to write the daily .md digest files
    outputDir: z.string().default('./digests'),

    // 'daily' = run every day; 'weekly' = run once a week.
    // Only used for scheduling logic; doesn't change content.
    scheduleMode: z.enum(['daily', 'weekly']).default('daily'),

    // How many items to include per subscription when sending to Claude.
    // Lower values = smaller prompt = faster + cheaper; higher values = more detail.
    // 57 subscriptions × 15 items × ~700 chars ≈ 600K chars total — fits in
    // the Claude Sonnet 4.6 context window with room to spare.
    maxNewItemsPerSubscription: z.number().default(15),

    // Run Chromium in headless (invisible) mode. Set false for the first run
    // so you can watch it navigate and solve any Cloudflare challenge manually.
    headless: z.boolean().default(true),

    // Path to the file describing what you care about. Prefer interests.toml
    // (structured — the pipeline reads priority_titles from it to order the
    // digest before chunking). A .md path still works and is treated as
    // free text with no machine-readable priorities; see loadInterestsConfig.
    interestsFile: z.string().default('./interests.toml'),

    // How many subscriptions to hand the model in a single run.
    //
    // The digest is built in chunks because nemotron-3-super:cloud degenerates
    // on large one-shot runs: six healthy runs at <=21 subscriptions
    // (2026-09-04 .. 09-09) against four degenerate ones at >=31 (09-01,
    // 09-02, 09-03, 09-10). 12 leaves real margin under the smallest observed
    // failure. Runs with fewer subscriptions than this take the original
    // single-pass path unchanged.
    chunkSize: z.number().int().positive().default(12),

    // Hard ceiling on model invocations for one run.
    //
    // Model calls are METERED, which the chunked design did not account for.
    // On 2026-09-11 a single night made 41 calls against a pre-chunking
    // baseline of 1, and exhausted the monthly quota on both providers. A
    // healthy run now costs 1 call (single pass); a run that has to chunk 50
    // subscriptions costs about 6. 12 leaves room for retries and one level of
    // splitting while making a runaway impossible.
    maxModelCalls: z.number().int().positive().default(12),

    // The LOCAL (unmetered) model, tried first on every subscription.
    //
    // This is PI'S catalog name, which differs from `ollama list`: it is
    // `omnicoder-oc`, NOT `omnicoder-oc:latest`. Check with
    // `pi --list-models < /dev/null` — and note the stdin redirect, because
    // pi blocks forever when stdin is left open. A wrong name fails instantly
    // with "Model not found" rather than hanging.
    localModel: z.string().default('omnicoder-oc'),

    // The METERED model, used only for subscriptions the local model could
    // not render.
    cloudModel: z.string().default('nemotron-3-super:cloud'),

    // Ceiling on LOCAL calls for one run. Local calls cost time, not money,
    // so this is far above maxModelCalls and exists to stop a runaway loop
    // rather than to ration spend.
    maxLocalCalls: z.number().int().positive().default(120),

    // Largest input handed to the local model in one call.
    //
    // Measured 2026-09-11: above roughly 3K tokens the model returns SILENT
    // EMPTY OUTPUT. 12000 was the first guess and proved too generous — on
    // 2026-09-12 an 11,441-byte thread came back empty, because the real
    // budget also has to cover the instruction preamble and the answer inside
    // the same 8192-token context. 8000 chars (~2K tokens) leaves room for
    // both and matches the 10-item geeklist size that rendered cleanly.
    maxLocalInputChars: z.number().int().positive().default(8000),

    // Whether to actually clear (mark-as-read) each processed subscription on BGG.
    // true  = click BGG's remove button on each notification row after processing.
    // false = log "[DEBUG] Would click..." but don't click — useful for testing.
    // Default false (safe) — turn on once you've verified the right rows are targeted.
    clearSubs: z.boolean().default(false),
  }),

  // Optional email delivery via Resend (https://resend.com).
  // If this section is absent, the digest is only written to disk.
  // Python: Optional[EmailConfig] = None
  email: z.object({
    // Resend API key from https://resend.com/api-keys
    resendApiKey: z.string().min(1),

    // "From" address — must be a verified sender domain in Resend.
    // e.g. "BGG Digest <digest@yourdomain.com>" or just "you@yourdomain.com"
    from: z.string().min(1),

    // Recipient address — where the digest is delivered.
    to: z.string().min(1),
  }).optional(),
});

// ---- loadConfig -----------------------------------------------
//
// PYTHON CONTEXT: this is the equivalent of:
//
//   def load_config(config_path='./config.json') -> AppConfig:
//       with open(config_path) as f:
//           raw = json.load(f)
//       return AppConfig.model_validate(raw)
//
// The `= './config.json'` is a default parameter value — same as Python.
//
// Return type annotation: `: z.infer<typeof ConfigSchema>`
//   - `typeof ConfigSchema` asks TypeScript for the compile-time type of
//     the ConfigSchema constant (it's a complex Zod object type).
//   - `z.infer<...>` extracts the "output type" — what you get back after
//     .parse() succeeds. This is the plain TypeScript object type with all
//     the right field names and types.
//   - The `export type AppConfig` at the bottom is a convenient alias for
//     this same inferred type, so callers don't have to write it out.
export function loadConfig(configPath = './config.json'): z.infer<typeof ConfigSchema> {
  // path.resolve() converts a relative path to absolute using the CWD.
  // Equivalent to pathlib.Path(config_path).resolve()
  const resolved = path.resolve(configPath);

  // fs.existsSync() is synchronous (blocking) — fine for startup code.
  // Python: Path(resolved).exists()
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Config file not found at ${resolved}\n` +
      `Copy config.example.json to config.json and fill in your credentials.`,
    );
  }

  // fs.readFileSync() reads the whole file into memory as a string.
  // Python: open(resolved).read()
  // JSON.parse() is Python's json.loads()
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));

  // ConfigSchema.parse() validates `raw` against the schema.
  // Throws ZodError (with field-level messages) if invalid.
  // Fills in .default() values for any missing optional fields.
  // Python (Pydantic): AppConfig.model_validate(raw)
  const parsed = ConfigSchema.parse(raw);

  // Resolve relative paths to absolute NOW, while we know the CWD.
  // If we stored './digests' and the user later cd'd elsewhere, path.join
  // would produce wrong results. Better to canonicalize once at load time.
  parsed.digest.outputDir     = path.resolve(parsed.digest.outputDir);
  parsed.digest.interestsFile = path.resolve(parsed.digest.interestsFile);

  return parsed;
}

// ---- loadInterests --------------------------------------------
//
// Reads the interests markdown file and returns its text.
// Returns an empty string if the file doesn't exist — Claude will
// still summarize all content, just without personalization hints.
//
// Python equivalent:
//   def load_interests(path: str) -> str:
//       try:
//           return Path(path).read_text().strip()
//       except FileNotFoundError:
//           return ''
export function loadInterests(interestsFilePath: string): string {
  if (!fs.existsSync(interestsFilePath)) {
    return '';
  }
  // .trim() strips leading/trailing whitespace — same as Python's str.strip()
  return fs.readFileSync(interestsFilePath, 'utf-8').trim();
}

// ---- loadInterestsConfig --------------------------------------
//
// Read interests.toml into the structured shape the ranking code needs.
//
// FALLBACK: if the configured path is not a .toml, or the .toml is missing,
// we still return a usable config — with the file's raw text as `notes` and
// NO machine-readable priorities. The digest then still works and the model
// still sees the reader's interests; only the code-side priority ordering is
// unavailable, which degrades chunk ordering rather than breaking the run.
// This is what keeps an existing interests.md installation working.
export function loadInterestsConfig(interestsFilePath: string): InterestsConfig {
  const empty: InterestsConfig = {
    priorityTitles: [], trackedGames: [], keywords: [], notes: '',
  };

  if (!fs.existsSync(interestsFilePath)) return empty;
  const raw = fs.readFileSync(interestsFilePath, 'utf-8');

  if (!interestsFilePath.toLowerCase().endsWith('.toml')) {
    // A legacy free-text interests.md: hand it to the model wholesale.
    return { ...empty, notes: raw.trim() };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // A typo in the TOML must not take the whole digest down. Fall back to
    // treating it as prose and say so loudly.
    console.error(
      `[WARN] Could not parse ${interestsFilePath} as TOML (${String(err)}). ` +
      `Falling back to free text — priority ordering will be unavailable.`,
    );
    return { ...empty, notes: raw.trim() };
  }

  // Coerce defensively: a hand-edited file may hold a string where a list
  // belongs, and a crashed digest is a worse outcome than an ignored key.
  const list = (key: string): string[] => {
    const v = parsed[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    if (typeof v === 'string') return [v];
    return [];
  };

  return {
    priorityTitles: list('priority_titles'),
    trackedGames:   list('tracked_games'),
    keywords:       list('keywords'),
    notes:          typeof parsed['notes'] === 'string' ? parsed['notes'].trim() : '',
  };
}

// ---- Type export -----------------------------------------------
//
// `z.infer<typeof ConfigSchema>` is the TypeScript type of the parsed config.
// We export it as `AppConfig` so other modules can write:
//
//   import type { AppConfig } from './config';
//   function doSomething(config: AppConfig) { ... }
//
// `import type` is a TypeScript-only import — it vanishes at compile time
// and generates no runtime code. It's only for type checking.
export type AppConfig = z.infer<typeof ConfigSchema>;

// ---- resolveTiers ----------------------------------------------
//
// Which models does this run use, and in what order?
//
// The default is local-first: every subscription is attempted on the
// unmetered model and only escalates to the metered one if it fails.
// Escalation is per SUBSCRIPTION, not per run — one stubborn subscription
// costs one metered call, not a night's worth. That containment is the whole
// point: on 2026-09-11 an unconditional fallback would have spent 50.
//
// PYTHON CONTEXT: pure function over argv. Returns the model list to try in
// order, plus whether escalation past the first tier is permitted at all.
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
  // Silently running a different model than the one named would be worse than
  // any tiering benefit.
  const modelIdx = argv.indexOf('--model');
  if (modelIdx !== -1 && argv[modelIdx + 1] && !argv[modelIdx + 1].startsWith('--')) {
    return { models: [argv[modelIdx + 1]], escalates: false };
  }

  if (cloudOnly) return { models: [cfg.cloudModel], escalates: false };
  if (localOnly) return { models: [cfg.localModel], escalates: false };

  return { models: [cfg.localModel, cfg.cloudModel], escalates: true };
}
