import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('rejects a zero-test Cargo success receipt before accepting a required recovery probe', () => {
  const root = join('target', `native-recovery-gate-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const fakeCargo = join(root, 'cargo.cmd');
  writeFileSync(fakeCargo, '@echo off\r\necho test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\r\nexit /b 0\r\n', 'utf8');
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', 'scripts/run-native-recovery-gates.ps1', '-CargoPath', fakeCargo], { encoding: 'utf8', timeout: 10_000 });
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain('did not produce one exact passing receipt');
});
