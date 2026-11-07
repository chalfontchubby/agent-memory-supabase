import { dirname, resolve } from 'jsr:@std/path@1.0.8';
import { defaultRun, type Runner } from './run.ts';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0]) return t.slice(1, -1);
  return t;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return '';
    throw e;
  }
}

/** KEY=value lines of a dotenv file. A missing file is an empty map. */
export async function readEnvFile(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const line of (await readOrEmpty(path)).split('\n')) {
    const m = LINE.exec(line.replace(/\r$/, ''));
    if (m && !line.trimStart().startsWith('#')) out.set(m[1], unquote(m[2]));
  }
  return out;
}

/** Replaces existing KEY= lines in place and appends missing keys. Other lines are untouched. Mode 0600. */
export async function upsertEnvVars(path: string, vars: Record<string, string>): Promise<void> {
  const text = await readOrEmpty(path);
  const lines = text === '' ? [] : text.split('\n');
  const pending = new Map(Object.entries(vars));
  const done = new Set<string>();
  const next = lines.map((line) => {
    const m = LINE.exec(line.replace(/\r$/, ''));
    if (!m || line.trimStart().startsWith('#') || !pending.has(m[1])) return line;
    if (done.has(m[1])) return line;
    done.add(m[1]);
    return `${m[1]}=${pending.get(m[1])}`;
  });
  const missing = [...pending].filter(([k]) => !done.has(k));
  if (missing.length > 0) {
    if (next.length > 0 && next.at(-1) !== '') next.push('');
    // next now ends with '' (the trailing newline slot) or is empty
    if (next.length > 0) next.pop();
    for (const [k, v] of missing) next.push(`${k}=${v}`);
    next.push('');
  }
  await Deno.writeTextFile(path, next.join('\n'), { mode: 0o600 });
  await Deno.chmod(path, 0o600);
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
