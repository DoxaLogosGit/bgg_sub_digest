// ============================================================
// logger.ts — simple file + console logger
//
// PYTHON CONTEXT: This is a hand-rolled logger similar to Python's
// logging module configured with two handlers — a FileHandler that
// appends to a daily log file and a StreamHandler for the console.
//
// We skip heavy npm logging frameworks (winston, pino) because this
// script only runs once a day; a simple append-to-file approach is
// easier to understand and maintain.
//
// Usage (from any other module):
//   import { log } from './logger';
//   log.info('Starting digest run');
//   log.error('Failed to fetch thread', { threadId: 123, err });
//
// The second argument is an optional "meta" object — arbitrary
// key/value pairs that get serialized to JSON on the same log line.
// In Python you'd pass kwargs to a logging call via the `extra` dict.
// ============================================================

// `import * as fs from 'fs'` pulls in Node.js's built-in filesystem
// module. In Python this is just `import os` or `import pathlib`.
// Node doesn't have stdlib access by default — you import each module.
import * as fs from 'fs';

// Node.js's built-in path utilities — equivalent to Python's os.path
// or pathlib. path.join(), path.resolve() work like their Python equivalents.
import * as path from 'path';

// ---- Log file setup ------------------------------------------

// path.resolve() makes a path absolute from the current working directory
// (where you ran `npm start`). Equivalent to pathlib.Path('.').resolve() / 'logs'
const LOG_DIR = path.resolve('./logs');

// .slice(0, 10) extracts "YYYY-MM-DD" from the full ISO string.
// Python: datetime.now().strftime('%Y-%m-%d')
const today = new Date().toISOString().slice(0, 10);

// path.join() is cross-platform path concatenation — same as Python's os.path.join()
const LOG_FILE = path.join(LOG_DIR, `bgg-digest-${today}.log`);

// Create the log directory if it doesn't exist.
// `recursive: true` is like mkdir -p — creates intermediate dirs.
// Python: os.makedirs(LOG_DIR, exist_ok=True)
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Open a writable stream in append mode ('a'). This is lower-level
// than writeFileSync — it keeps the file handle open for the whole
// process lifetime rather than opening/closing on every write.
//
// Python equivalent: open(LOG_FILE, 'a', buffering=1)  (line-buffered)
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// ---- Type alias for log levels --------------------------------
//
// `type LogLevel = ...` creates a type alias for a union of four
// specific string literals. This is like Python's:
//   LogLevel = Literal['INFO', 'WARN', 'ERROR', 'DEBUG']
//
// TypeScript will flag a typo like 'INFOO' at compile time.
type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

// ---- Core write function --------------------------------------
//
// Function signature breakdown:
//   level: LogLevel       — must be one of the four literal strings
//   message: string       — the main log message
//   meta?: Record<string, unknown>  — optional; the ? means it may be absent
//
// `Record<string, unknown>` is TypeScript for "an object with string keys
// and values of any type". Python equivalent: dict[str, Any].
//
// `void` return type means the function doesn't return a meaningful value
// (like Python's -> None).
function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  // .toISOString() gives "2025-04-22T10:30:00.000Z"
  // Python: datetime.utcnow().isoformat() + 'Z'
  const ts = new Date().toISOString();

  // Ternary operator: `condition ? valueIfTrue : valueIfFalse`
  // Python equivalent: '  ' + json.dumps(meta) if meta else ''
  //
  // JSON.stringify() is like Python's json.dumps() — serializes an object
  // to a JSON string.
  const metaStr = meta ? '  ' + JSON.stringify(meta) : '';

  // Template literals (backtick strings) allow ${expression} interpolation.
  // Python equivalent: f'[{ts}] [{level}] {message}{metaStr}'
  const line = `[${ts}] [${level}] ${message}${metaStr}`;

  // Write to the file stream. '\n' adds a newline — Node streams don't
  // add one automatically (unlike Python's print()).
  logStream.write(line + '\n');

  // Also write to the terminal. ERROR and WARN go to stderr so shell
  // redirections like `npm start 2>errors.log` capture them separately.
  // Python equivalent: print(line, file=sys.stderr) vs print(line)
  if (level === 'ERROR' || level === 'WARN') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// ---- Public API -----------------------------------------------
//
// `export const log = { ... }` exports a single object with four methods.
// In Python terms, this is like a module-level "singleton" object:
//
//   class _Logger:
//       def info(self, msg, **meta): ...
//   log = _Logger()
//
// Each property is an "arrow function" — the concise TypeScript/JavaScript
// way to write a small function. Arrow functions capture `this` from their
// surrounding scope (not relevant here, but important to know).
//
// `(msg: string, meta?: Record<string, unknown>) => write('INFO', msg, meta)`
// is equivalent to Python's:
//   lambda msg, meta=None: write('INFO', msg, meta)
// But with type annotations.
export const log = {
  info:  (msg: string, meta?: Record<string, unknown>) => write('INFO',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => write('WARN',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('ERROR', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => write('DEBUG', msg, meta),
};
