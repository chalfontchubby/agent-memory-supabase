export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}
/** Runs a command and captures its output. Throws Deno.errors.NotFound when the command is not on PATH. */
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const defaultRun: Runner = async (cmd, args, opts = {}) => {
  const out = await new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
};

/** Removes each secret from text before it is shown. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join('***');
  return t;
}
