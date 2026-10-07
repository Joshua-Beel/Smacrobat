import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi, type Mock } from 'vitest';
import ReplacePagesDialog from './ReplacePagesDialog';
import type { SavedCopy } from './bridge';
import type { DocumentInfo } from './model';

const document = (id: number, pages: number, revision = id): DocumentInfo => ({ id, name: `file-${id}.pdf`, path: `C:/file-${id}.pdf`, pages: Array.from({ length: pages }, () => ({ width: 612, height: 792 })), revision, dirty: true, can_undo: true, can_redo: false });
const output = (document: DocumentInfo): SavedCopy => ({ path: 'C:/replaced.pdf', document });
const field = (ui: ReactTestRenderer, label: string) => ui.root.findByProps({ 'aria-label': label });
const replaceButton = (ui: ReactTestRenderer) => ui.root.findAllByType('button').find(button => button.children.join('') === 'Replace pages')!;

async function mount({ documents = [document(1, 5, 4), document(2, 2, 7)], activeId = 1, initialRange = { start: 1, count: 2 }, busy = false, replace = vi.fn().mockResolvedValue(output(document(3, 2, 0))), close = vi.fn() }: { documents?: DocumentInfo[]; activeId?: number; initialRange?: { start: number; count: number }; busy?: boolean; replace?: Mock<(...args: any[]) => any>; close?: Mock<(...args: any[]) => any> } = {}) {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<ReplacePagesDialog documents={documents} activeId={activeId} initialRange={initialRange} busy={busy} replace={replace} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, replace, close };
}

it('uses current revisions and previews shorter, longer, and whole-target replacements', async () => {
  const { ui, replace, close } = await mount();
  expect(JSON.stringify(ui.toJSON())).toContain('even when every target page is replaced');
  expect(JSON.stringify(ui.toJSON())).toContain('pages 2–3');
  act(() => field(ui, 'First target page').props.onChange({ target: { value: '1' } }));
  act(() => field(ui, 'Target pages to replace').props.onChange({ target: { value: '4' } }));
  expect(JSON.stringify(ui.toJSON())).toContain('3 pages');
  act(() => field(ui, 'Target pages to replace').props.onChange({ target: { value: '1' } }));
  expect(JSON.stringify(ui.toJSON())).toContain('6 pages');
  act(() => field(ui, 'Target pages to replace').props.onChange({ target: { value: '5' } }));
  expect(JSON.stringify(ui.toJSON())).toContain('2 pages');
  await act(async () => replaceButton(ui).props.onClick());
  expect(replace).toHaveBeenCalledWith({ id: 1, revision: 4 }, { id: 2, revision: 7 }, 0, 5);
  expect(close).toHaveBeenCalledOnce();
  act(() => ui.unmount());
});

it('rejects duplicate, closed, oversized, non-integer, and out-of-range target ranges before native work', async () => {
  const duplicate = await mount();
  act(() => field(duplicate.ui, 'Donor PDF').props.onChange({ target: { value: '1' } }));
  await act(async () => replaceButton(duplicate.ui).props.onClick());
  expect(duplicate.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('two different');
  expect(duplicate.replace).not.toHaveBeenCalled(); act(() => duplicate.ui.unmount());

  for (const [first, count] of [['1.5', '1'], ['-1', '1'], ['6', '1'], ['1', '0'], ['1', '6'], ['Infinity', '1']] as const) {
    const invalid = await mount();
    act(() => field(invalid.ui, 'First target page').props.onChange({ target: { value: first } }));
    act(() => field(invalid.ui, 'Target pages to replace').props.onChange({ target: { value: count } }));
    await act(async () => replaceButton(invalid.ui).props.onClick());
    expect(invalid.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('positive whole-number count');
    expect(invalid.replace).not.toHaveBeenCalled(); act(() => invalid.ui.unmount());
  }

  const first = document(1, 5), donor = document(2, 2);
  const closed = await mount({ documents: [first, donor] });
  await act(async () => closed.ui.update(<ReplacePagesDialog documents={[first]} activeId={1} initialRange={{ start: 0, count: 1 }} busy={false} replace={closed.replace} close={closed.close} />));
  await act(async () => replaceButton(closed.ui).props.onClick());
  expect(closed.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('no longer open');
  act(() => closed.ui.unmount());

  const oversized = await mount({ documents: [document(1, 2500), document(2, 1600)] });
  await act(async () => replaceButton(oversized.ui).props.onClick());
  expect(oversized.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('input PDFs');
  act(() => oversized.ui.unmount());
});

it('closes on native cancellation and retains failures for retry without duplicate work or Escape close while busy', async () => {
  const canceled = await mount({ replace: vi.fn().mockResolvedValue(null) });
  await act(async () => replaceButton(canceled.ui).props.onClick());
  expect(canceled.close).toHaveBeenCalledOnce(); act(() => canceled.ui.unmount());

  let resolve!: (value: SavedCopy) => void;
  const replace = vi.fn().mockRejectedValueOnce(new Error('Target document changed.')).mockImplementationOnce(() => new Promise<SavedCopy>(done => { resolve = done; }));
  const retry = await mount({ replace });
  await act(async () => replaceButton(retry.ui).props.onClick());
  expect(retry.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('Target document changed');
  act(() => { replaceButton(retry.ui).props.onClick(); replaceButton(retry.ui).props.onClick(); });
  expect(replace).toHaveBeenCalledTimes(2); expect(field(retry.ui, 'Target PDF').props.disabled).toBe(true);
  act(() => retry.ui.root.findByType('dialog').props.onCancel({ preventDefault: vi.fn() }));
  expect(retry.close).not.toHaveBeenCalled();
  await act(async () => resolve(output(document(3, 5, 0))));
  expect(retry.close).toHaveBeenCalledOnce(); act(() => retry.ui.unmount());
});

it('blocks controls while workspace work is in progress', async () => {
  const { ui, replace, close } = await mount({ busy: true });
  expect(field(ui, 'Target PDF').props.disabled).toBe(true);
  act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault: vi.fn() }));
  expect(close).not.toHaveBeenCalled(); await act(async () => replaceButton(ui).props.onClick());
  expect(replace).not.toHaveBeenCalled(); act(() => ui.unmount());
});
