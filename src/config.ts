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

    // Path to the plain-text/markdown file describing what you care about.
    // Its full content is passed verbatim to Claude when building the prompt.
    // Relative paths are resolved from the project root (where `npm start` runs).
    interestsFile: z.string().default('./interests.md'),

    // Safety switch for the "clear shortcut" feature.
    // true  = log "[DEBUG] Would click..." instead of actually clicking.
    // false = actually click BGG's remove button to clear each subscription.
    // Leave true until you've verified the right shortcuts are being targeted.
    debugClear: z.boolean().default(true),
  }),
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
