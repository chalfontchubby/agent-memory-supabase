import { dirname, resolve } from 'jsr:@std/path@1.0.8';
import { defaultRun, type Runner } from './run.ts';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return '';
    throw e;
  }
}

const SAFE = /^[A-Za-z0-9_./:@%+=,-]*$/;

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t[0] === "'" && t.at(-1) === "'") return t.slice(1, -1).replaceAll("'\\''", "'");
  if (t.length >= 2 && t[0] === '"' && t.at(-1) === '"') return t.slice(1, -1);
  return t;
}

/** Quotes a value for a dotenv file that is also safe to `source`. */
function quote(v: string): string {
  return SAFE.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`;
}

/** KEY=value lines of a dotenv file. A missing file is an empty map. The last of a duplicated key wins, as in a shell. */
export async function readEnvFile(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const line of (await readOrEmpty(path)).split('\n')) {
    const m = LINE.exec(line.replace(/\r$/, ''));
    if (m && !line.trimStart().startsWith('#')) out.set(m[1], unquote(m[2]));
  }
  return out;
}

/**
 * Writes via a 0600 temp file in the same directory, fsync, then rename over the target, so a failure at any point
 * leaves the original untouched and a secret is never readable under a looser mode.
 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    const f = await Deno.open(tmp, { write: true, createNew: true, mode: 0o600 });
    try {
      await f.write(new TextEncoder().encode(text));
      await f.syncData();
    } finally {
      f.close();
    }
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Sets each key exactly once: the first existing line is replaced in place (keeping an `export ` prefix and a CR),
 * later duplicates are removed, missing keys are appended. Other lines are untouched. Mode 0600, written atomically.
 */
export async function upsertEnvVars(path: string, vars: Record<string, string>): Promise<void> {
  const text = await readOrEmpty(path);
  const lines = text === '' ? [] : text.split('\n');
  const pending = new Map(Object.entries(vars));
  const done = new Set<string>();
  const next: string[] = [];
  for (const line of lines) {
    const cr = line.endsWith('\r') ? '\r' : '';
    const m = LINE.exec(line.slice(0, line.length - cr.length));
    if (!m || line.trimStart().startsWith('#') || !pending.has(m[1])) {
      next.push(line);
      continue;
    }
    if (done.has(m[1])) continue; // later duplicate
    done.add(m[1]);
    const exp = /^\s*export\s/.test(line) ? 'export ' : '';
    next.push(`${exp}${m[1]}=${quote(pending.get(m[1])!)}${cr}`);
  }
  const missing = [...pending].filter(([k]) => !done.has(k));
  if (missing.length > 0) {
    if (next.at(-1) === '') next.pop();
    for (const [k, v] of missing) next.push(`${k}=${quote(v)}`);
    next.push('');
  }
  await writeTextAtomic(path, next.join('\n'));
}

/** Throws unless git ignores the file. */
export async function assertGitIgnored(path: string, run: Runner = defaultRun): Promise<void> {
  const abs = resolve(path);
  let code: number;
  try {
    code = (await run('git', ['check-ignore', '-q', abs], { cwd: dirname(abs) })).code;
  } catch {
    code = 1;
  }
  if (code !== 0) throw new Error(`${path} is not ignored by git; refusing to write secrets to it`);
}
