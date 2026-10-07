import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi, type Mock } from 'vitest';
import InsertPagesDialog from './InsertPagesDialog';
import type { SavedCopy } from './bridge';
import type { DocumentInfo } from './model';

const document = (id: number, pages: number, revision = id): DocumentInfo => ({ id, name: `file-${id}.pdf`, path: `C:/file-${id}.pdf`, pages: Array.from({ length: pages }, () => ({ width: 612, height: 792 })), revision, dirty: true, can_undo: true, can_redo: false });
const output = (document: DocumentInfo): SavedCopy => ({ path: 'C:/inserted.pdf', document });
const select = (ui: ReactTestRenderer, label: string) => ui.root.findByProps({ 'aria-label': label });
const insertButton = (ui: ReactTestRenderer) => ui.root.findAllByType('button').find(button => button.children.join('') === 'Insert pages')!;

async function mount({ documents = [document(1, 3, 4), document(2, 2, 7)], activeId = 1, busy = false, insert = vi.fn().mockResolvedValue(output(document(3, 5, 0))), close = vi.fn() }: { documents?: DocumentInfo[]; activeId?: number; busy?: boolean; insert?: Mock<(...args: any[]) => any>; close?: Mock<(...args: any[]) => any> } = {}) {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<InsertPagesDialog documents={documents} activeId={activeId} busy={busy} insert={insert} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, insert, close };
}

it('uses target and donor current revisions at before-first, middle, and append boundaries', async () => {
  const { ui, insert, close } = await mount({ activeId: 2 });
  expect(JSON.stringify(ui.toJSON())).toContain('The target PDF’s document metadata is copied as-is. Metadata is not merged or invented, and both source PDFs stay unchanged.');
  act(() => select(ui, 'Target PDF').props.onChange({ target: { value: '1' } }));
  act(() => select(ui, 'Donor PDF').props.onChange({ target: { value: '2' } }));
  for (const [boundary, phrase] of [['0', 'before page 1'], ['1', 'after page 1'], ['3', 'after the last page (append)']] as const) {
    act(() => select(ui, 'Insertion boundary').props.onChange({ target: { value: boundary } }));
    expect(JSON.stringify(ui.toJSON())).toContain(phrase);
  }
  await act(async () => insertButton(ui).props.onClick());
  expect(insert).toHaveBeenCalledWith({ id: 1, revision: 4 }, { id: 2, revision: 7 }, 3);
  expect(close).toHaveBeenCalledOnce();
  act(() => ui.unmount());
});

it('rejects duplicate, closed, oversized, and non-integer or out-of-range boundaries before native work', async () => {
  const duplicate = await mount();
  act(() => select(duplicate.ui, 'Donor PDF').props.onChange({ target: { value: '1' } }));
  await act(async () => insertButton(duplicate.ui).props.onClick());
  expect(duplicate.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('two different');
  expect(duplicate.insert).not.toHaveBeenCalled();
  act(() => duplicate.ui.unmount());

  for (const boundary of ['1.5', '-1', '4', 'Infinity']) {
    const invalid = await mount();
    act(() => select(invalid.ui, 'Insertion boundary').props.onChange({ target: { value: boundary } }));
    await act(async () => insertButton(invalid.ui).props.onClick());
    expect(invalid.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('whole-number insertion boundary');
    expect(invalid.insert).not.toHaveBeenCalled();
    act(() => invalid.ui.unmount());
  }

  const first = document(1, 3), donor = document(2, 2);
  const closed = await mount({ documents: [first, donor] });
  await act(async () => closed.ui.update(<InsertPagesDialog documents={[first]} activeId={1} busy={false} insert={closed.insert} close={closed.close} />));
  await act(async () => insertButton(closed.ui).props.onClick());
  expect(closed.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('no longer open');
  expect(closed.insert).not.toHaveBeenCalled();
  act(() => closed.ui.unmount());

  const oversized = await mount({ documents: [document(1, 2500), document(2, 1600)] });
  await act(async () => insertButton(oversized.ui).props.onClick());
  expect(oversized.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('at most 4,096 pages');
  expect(oversized.insert).not.toHaveBeenCalled();
  act(() => oversized.ui.unmount());
});

it('closes on native cancellation and retains failures for retry without duplicate submission or Escape close while busy', async () => {
  const canceled = await mount({ insert: vi.fn().mockResolvedValue(null) });
  await act(async () => insertButton(canceled.ui).props.onClick());
  expect(canceled.close).toHaveBeenCalledOnce();
  act(() => canceled.ui.unmount());

  let resolve!: (value: SavedCopy) => void;
  const insert = vi.fn().mockRejectedValueOnce(new Error('Target document changed.')).mockImplementationOnce(() => new Promise<SavedCopy>(done => { resolve = done; }));
  const retry = await mount({ insert });
  await act(async () => insertButton(retry.ui).props.onClick());
  expect(retry.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('Target document changed');
  act(() => { insertButton(retry.ui).props.onClick(); insertButton(retry.ui).props.onClick(); });
  expect(insert).toHaveBeenCalledTimes(2);
  expect(select(retry.ui, 'Target PDF').props.disabled).toBe(true);
  act(() => retry.ui.root.findByType('dialog').props.onCancel({ preventDefault: vi.fn() }));
  expect(retry.close).not.toHaveBeenCalled();
  await act(async () => resolve(output(document(3, 5, 0))));
  expect(retry.close).toHaveBeenCalledOnce();
  act(() => retry.ui.unmount());
});

it('blocks controls while workspace work is in progress', async () => {
  const { ui, insert, close } = await mount({ busy: true });
  expect(select(ui, 'Target PDF').props.disabled).toBe(true);
  act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault: vi.fn() }));
  expect(close).not.toHaveBeenCalled();
  await act(async () => insertButton(ui).props.onClick());
  expect(insert).not.toHaveBeenCalled();
  act(() => ui.unmount());
});
