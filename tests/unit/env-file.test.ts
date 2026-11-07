import { assert, assertEquals, assertRejects } from '@std/assert';
import { assertGitIgnored, readEnvFile, upsertEnvVars } from '../../scripts/lib/env-file.ts';

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
