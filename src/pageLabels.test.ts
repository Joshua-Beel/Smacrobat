import { describe, expect, it } from 'vitest';
import { pageLabelDescription, pageLabelFor, validatePageLabels } from './pageLabels';

const supported = (labels: string[]) => ({ documentId: 7, revision: 3, status: 'supported', reason: null, labels: labels.map((label, page) => ({ page, label })) });

describe('page label snapshots', () => {
  it('accepts duplicate, blank, numeric, Unicode, and whitespace labels without rewriting them', () => {
    const labels = ['A', '', '12', '  第四  '];
    const snapshot = validatePageLabels(supported(labels), labels.length);
    expect(snapshot?.labels.map(item => item.label)).toEqual(labels);
    expect(pageLabelFor(snapshot, 2)).toBe('12');
    expect(pageLabelDescription('')).toBe('(blank label)');
    expect(pageLabelDescription('  第四  ')).toBe('  第四  ');
  });

  it('rejects partial, reordered, duplicate-index, and malformed snapshots', () => {
    const complete = supported(['one', 'two', 'three']);
    expect(validatePageLabels({ ...complete, labels: complete.labels.slice(0, 2) }, 3)).toBeNull();
    expect(validatePageLabels({ ...complete, labels: [{ page: 1, label: 'one' }, ...complete.labels.slice(1)] }, 3)).toBeNull();
    expect(validatePageLabels({ ...complete, labels: complete.labels.map(item => ({ ...item, label: 4 })) }, 3)).toBeNull();
    expect(validatePageLabels({ ...complete, status: 'none', labels: complete.labels }, 3)).toBeNull();
    expect(validatePageLabels({ ...complete, labels: complete.labels }, 2)).toBeNull();
  });

  it('requires empty labels for none and unavailable responses', () => {
    expect(validatePageLabels({ documentId: 7, revision: 3, status: 'none', reason: null, labels: [] }, 3)?.status).toBe('none');
    expect(validatePageLabels({ documentId: 7, revision: 3, status: 'unavailable', reason: 'encrypted', labels: [] }, 3)?.status).toBe('unavailable');
    expect(validatePageLabels({ documentId: 7, revision: 3, status: 'unavailable', reason: null, labels: [{ page: 0, label: 'x' }] }, 1)).toBeNull();
  });

  it('falls back to physical numbers for missing or mismatched pages', () => {
    const snapshot = validatePageLabels(supported(['front', 'back']), 2);
    expect(pageLabelFor(snapshot, 0)).toBe('front');
    expect(pageLabelFor(snapshot, 1)).toBe('back');
    expect(pageLabelFor(null, 0)).toBeNull();
    expect(pageLabelFor({ ...snapshot!, labels: [{ page: 1, label: 'stale' }, { page: 0, label: 'stale' }] }, 0)).toBeNull();
  });
});
