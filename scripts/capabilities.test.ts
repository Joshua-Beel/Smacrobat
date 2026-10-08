import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8')) as { windows: string[]; permissions: unknown[] };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('webview capability', () => {
  it('grants only the explicit core permissions the frontend calls', () => {
    expect(capability.windows).toEqual(['main']);
    expect(capability.permissions).toEqual(['core:app:allow-version', 'core:event:allow-listen', 'core:event:allow-unlisten', 'core:window:allow-destroy']);
    expect(capability.permissions.some(permission => typeof permission !== 'string' || /default|updater|allow-emit|menu|tray|image|path/.test(permission))).toBe(false);
  });

  it('keeps frontend Tauri imports inside what the capability covers', () => {
    const imports = new Set<string>();
    for (const file of sources('src')) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](@tauri-apps\/[^'"]+)['"]/g)) imports.add(match[1]);
    }
    expect([...imports].sort()).toEqual(['@tauri-apps/api/app', '@tauri-apps/api/core', '@tauri-apps/api/window']);
    const app = sources('src').map(file => readFileSync(file, 'utf8')).join('\n');
    expect(app).not.toMatch(/['"]plugin:/);
    expect(app).not.toMatch(/@tauri-apps\/plugin-/);
  });
});
