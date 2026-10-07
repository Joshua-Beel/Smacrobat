import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi, type Mock } from 'vitest';
import CombineDialog from './CombineDialog';
import type { SavedCopy } from './bridge';
import type { DocumentInfo } from './model';

const document = (id: number, pages: number, revision = id): DocumentInfo => ({ id, name: `file-${id}.pdf`, path: `C:/file-${id}.pdf`, pages: Array.from({ length: pages }, () => ({ width: 612, height: 792 })), revision, dirty: true, can_undo: true, can_redo: false });
const output = (document: DocumentInfo): SavedCopy => ({ path: 'C:/combined.pdf', document });
const select = (ui: ReactTestRenderer, label: string) => ui.root.findByProps({ 'aria-label': label });
const combineButton = (ui: ReactTestRenderer) => ui.root.findAllByType('button').find(button => button.children.join('') === 'Combine PDFs')!;

async function mount({ documents = [document(1, 2, 4), document(2, 3, 7)], activeId = 1, busy = false, combine = vi.fn().mockResolvedValue(output(document(3, 5, 0))), close = vi.fn() }: { documents?: DocumentInfo[]; activeId?: number; busy?: boolean; combine?: Mock<(...args: any[]) => any>; close?: Mock<(...args: any[]) => any> } = {}) {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<CombineDialog documents={documents} activeId={activeId} busy={busy} combine={combine} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, combine, close };
}

it('uses the chosen current revisions and order, and states the first-PDF metadata rule', async () => {
  const { ui, combine, close } = await mount({ activeId: 2 });
  expect(JSON.stringify(ui.toJSON())).toContain('The first PDF’s document metadata is copied as-is. Metadata is not merged or invented.');
  act(() => select(ui, 'First PDF').props.onChange({ target: { value: '1' } }));
  act(() => select(ui, 'Second PDF').props.onChange({ target: { value: '2' } }));
  expect(JSON.stringify(ui.toJSON())).toContain('file-1.pdf (2), then file-2.pdf (3): 5 pages.');
  await act(async () => combineButton(ui).props.onClick());
  expect(combine).toHaveBeenCalledWith({ id: 1, revision: 4 }, { id: 2, revision: 7 });
  expect(close).toHaveBeenCalledOnce();
  act(() => ui.unmount());
});

it('rejects duplicate, closed, and oversized choices without invoking native work', async () => {
  const duplicate = await mount();
  act(() => select(duplicate.ui, 'Second PDF').props.onChange({ target: { value: '1' } }));
  await act(async () => combineButton(duplicate.ui).props.onClick());
  expect(duplicate.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('two different');
  expect(duplicate.combine).not.toHaveBeenCalled();
  act(() => duplicate.ui.unmount());

  const first = document(1, 2), second = document(2, 2);
  const closed = await mount({ documents: [first, second] });
  await act(async () => closed.ui.update(<CombineDialog documents={[first]} activeId={1} busy={false} combine={closed.combine} close={closed.close} />));
  expect(JSON.stringify(closed.ui.toJSON())).toContain('no longer open');
  expect(closed.combine).not.toHaveBeenCalled();
  act(() => closed.ui.unmount());

  const oversized = await mount({ documents: [document(1, 2500), document(2, 1600)] });
  await act(async () => combineButton(oversized.ui).props.onClick());
  expect(oversized.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('at most 4,096 pages');
  expect(oversized.combine).not.toHaveBeenCalled();
  act(() => oversized.ui.unmount());
});

it('closes on native cancellation and retains a native failure for retry without duplicate work', async () => {
  const canceled = await mount({ combine: vi.fn().mockResolvedValue(null) });
  await act(async () => combineButton(canceled.ui).props.onClick());
  expect(canceled.close).toHaveBeenCalledOnce();
  act(() => canceled.ui.unmount());

  const closed = await mount({ combine: vi.fn().mockRejectedValue(new Error('Document is closed.')) });
  await act(async () => combineButton(closed.ui).props.onClick());
  expect(closed.ui.root.findByProps({ role: 'alert' }).children.join('')).toBe('Error: Document is closed.');
  expect(closed.close).not.toHaveBeenCalled();
  act(() => closed.ui.unmount());

  let resolve!: (value: SavedCopy) => void;
  const combine = vi.fn().mockRejectedValueOnce(new Error('Document changed. Choose the order again.')).mockImplementationOnce(() => new Promise<SavedCopy>(done => { resolve = done; }));
  const retry = await mount({ combine });
  await act(async () => combineButton(retry.ui).props.onClick());
  expect(retry.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('Document changed');
  act(() => { combineButton(retry.ui).props.onClick(); combineButton(retry.ui).props.onClick(); });
  expect(combine).toHaveBeenCalledTimes(2);
  expect(select(retry.ui, 'First PDF').props.disabled).toBe(true);
  act(() => retry.ui.root.findByType('dialog').props.onCancel({ preventDefault: vi.fn() }));
  expect(retry.close).not.toHaveBeenCalled();
  await act(async () => resolve(output(document(3, 5, 0))));
  expect(retry.close).toHaveBeenCalledOnce();
  act(() => retry.ui.unmount());
});

it('blocks controls while the workspace is busy before native work begins', async () => {
  const { ui, combine, close } = await mount({ busy: true });
  expect(select(ui, 'First PDF').props.disabled).toBe(true);
  act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault: vi.fn() }));
  expect(close).not.toHaveBeenCalled();
  await act(async () => combineButton(ui).props.onClick());
  expect(combine).not.toHaveBeenCalled();
  act(() => ui.unmount());
});
