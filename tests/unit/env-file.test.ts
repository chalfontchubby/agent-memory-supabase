import { assert, assertEquals, assertRejects } from '@std/assert';
import { assertGitIgnored, readEnvFile, upsertEnvVars, writeTextAtomic } from '../../scripts/lib/env-file.ts';

Deno.test('upsert replaces in place, appends, preserves other lines, mode 0600', async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/.env`;
  const original = '# keep me\nA=1\n\nSECRET=old\n  # indented comment\nB="two words"\n';
  await Deno.writeTextFile(p, original);
  await Deno.chmod(p, 0o644);
  await upsertEnvVars(p, { SECRET: 'new', ADDED: 'x' });
  assertEquals(
    await Deno.readTextFile(p),
    '# keep me\nA=1\n\nSECRET=new\n  # indented comment\nB="two words"\nADDED=x\n',
  );
  assertEquals((await Deno.stat(p)).mode! & 0o777, 0o600);
  const m = await readEnvFile(p);
  assertEquals(m.get('SECRET'), 'new');
  assertEquals(m.get('B'), 'two words');
  assertEquals(m.get('ADDED'), 'x');
  await upsertEnvVars(p, { SECRET: 'newer' });
  assertEquals((await Deno.readTextFile(p)).match(/SECRET=/g)?.length, 1);
});

Deno.test('upsert creates a missing file with mode 0600', async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/.env`;
  await upsertEnvVars(p, { K: 'v' });
  assertEquals(await Deno.readTextFile(p), 'K=v\n');
  assertEquals((await Deno.stat(p)).mode! & 0o777, 0o600);
  assertEquals((await readEnvFile(`${dir}/none`)).size, 0);
});

Deno.test('assertGitIgnored throws unless git ignores the file', async () => {
  const dir = await Deno.makeTempDir();
  const git = (...a: string[]) => new Deno.Command('git', { args: a, cwd: dir }).output();
  assert((await git('init', '-q')).success);
  await assertRejects(
    () => assertGitIgnored(`${dir}/.env`),
    Error,
    'is not ignored by git; refusing to write secrets to it',
  );
  await Deno.writeTextFile(`${dir}/.gitignore`, '.env\n');
  await assertGitIgnored(`${dir}/.env`);
});

Deno.test('upsert over a 0644 file leaves mode 0600 and no temp file', async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/.env`;
  await Deno.writeTextFile(p, 'A=1\n');
  await Deno.chmod(p, 0o644);
  await upsertEnvVars(p, { A: '2' });
  assertEquals((await Deno.stat(p)).mode! & 0o777, 0o600);
  assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ['.env']);
});

Deno.test('a failed write leaves the original untouched and no temp file', async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/.env`;
  await Deno.writeTextFile(p, 'KEEP=me\n');
  await Deno.chmod(dir, 0o500); // temp file cannot be created
  try {
    await assertRejects(() => upsertEnvVars(p, { KEEP: 'new' }));
  } finally {
    await Deno.chmod(dir, 0o700);
  }
  assertEquals(await Deno.readTextFile(p), 'KEEP=me\n');
  // rename failure after the temp file was written: the target is a non-empty directory
  const dir2 = await Deno.makeTempDir();
  await Deno.mkdir(`${dir2}/.env`);
  await Deno.writeTextFile(`${dir2}/.env/x`, '');
  await assertRejects(() => writeTextAtomic(`${dir2}/.env`, 'S=1\n'));
  assertEquals([...Deno.readDirSync(dir2)].map((e) => e.name), ['.env']);
});

Deno.test('duplicate keys collapse to one line and readEnvFile agrees', async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/.env`;
  await Deno.writeTextFile(p, 'T=1\nX=keep\nT=2\nX=keep2\nT=3\n');
  await upsertEnvVars(p, { T: 'new' });
  assertEquals(await Deno.readTextFile(p), 'T=new\nX=keep\nX=keep2\n');
  assertEquals((await readEnvFile(p)).get('T'), 'new');
});

Deno.test('CR line endings and export prefix are kept', async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/.env`;
  await Deno.writeTextFile(p, 'export T=1\r\nO=2\r\n');
  await upsertEnvVars(p, { T: '9' });
  assertEquals(await Deno.readTextFile(p), 'export T=9\r\nO=2\r\n');
  assertEquals((await readEnvFile(p)).get('T'), '9');
});

Deno.test('unsafe values are single-quoted, safely sourceable, and round-trip', async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/.env`;
  const v = `it's a $HOME & "x" ; y`;
  await upsertEnvVars(p, { Q: v, SAFE: 'postgresql://u:p%40@h:5432/db' });
  const text = await Deno.readTextFile(p);
  assertEquals(text.split('\n')[1], 'SAFE=postgresql://u:p%40@h:5432/db');
  assertEquals((await readEnvFile(p)).get('Q'), v);
  const sh = await new Deno.Command('sh', { args: ['-c', `set -a; . "${p}"; printf %s "$Q"`], stdout: 'piped' })
    .output();
  assertEquals(new TextDecoder().decode(sh.stdout), v);
});
