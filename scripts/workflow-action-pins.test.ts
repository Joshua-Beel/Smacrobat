import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowDir = '.github/workflows';
const workflowFiles = readdirSync(workflowDir).filter(name => /\.ya?ml$/i.test(name)).sort();
const pinned = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const local = /^\.\/[\w./-]+$/;

function usesReferences(source: string) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const keyLines = lines.filter(line => /^\s*(?:-\s*)?['"]?uses['"]?\s*:/.test(line));
  const mentionLines = lines.filter(line => /\buses\s*:/.test(line));
  const refs = keyLines.map(line => {
    const value = line.replace(/^\s*(?:-\s*)?['"]?uses['"]?\s*:\s*/, '').replace(/\s+#.*$/, '').trim();
    return value.replace(/^(['"])(.*)\1$/, '$2');
  });
  return { refs, keyLines: keyLines.length, mentionLines: mentionLines.length };
}

describe('workflow action pins', () => {
  it('finds the workflow files', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)('%s pins every uses: to a full commit SHA or a local action', file => {
    const { refs, keyLines, mentionLines } = usesReferences(readFileSync(join(workflowDir, file), 'utf8'));
    expect(mentionLines, 'a uses: reference is not on its own key line').toBe(keyLines);
    const unpinned = refs.filter(ref => !pinned.test(ref) && !local.test(ref));
    expect(unpinned).toEqual([]);
  });
});
