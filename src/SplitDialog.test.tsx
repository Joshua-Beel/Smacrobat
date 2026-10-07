import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi, type Mock } from 'vitest';
import type { SplitOutput } from './bridge';
import SplitDialog from './SplitDialog';

const output: SplitOutput = { folder: 'C:/splits', files: [{ path: 'C:/splits/part-1.pdf', first_page: 1, last_page: 2, page_count: 2 }] };
const input = (ui: ReactTestRenderer) => ui.root.findByProps({ 'aria-label': 'Pages per split file' });
const splitButton = (ui: ReactTestRenderer) => ui.root.findAllByType('button').find(button => button.children.includes('Split PDF'))!;

async function mount({ pageCount = 128, busy = false, split = vi.fn().mockResolvedValue(output), close = vi.fn() }: { pageCount?: number; busy?: boolean; split?: Mock<(...args: any[]) => any>; close?: Mock<(...args: any[]) => any> } = {}) {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<SplitDialog pageCount={pageCount} busy={busy} split={split} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, split, close };
}

it('previews the current page count and rejects invalid or over-limit group sizes', async () => {
  const { ui, split } = await mount();
  expect(JSON.stringify(ui.toJSON())).toContain('Creates 64 files from 128 current pages');
  for (const value of ['', '0', '-1', '2.5', '1e2', 'Infinity']) {
    act(() => input(ui).props.onChange({ target: { value } }));
    await act(async () => splitButton(ui).props.onClick());
    expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('whole number');
  }
  act(() => input(ui).props.onChange({ target: { value: '1' } }));
  await act(async () => splitButton(ui).props.onClick());
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('at least 2 pages');
  expect(split).not.toHaveBeenCalled();
  act(() => ui.unmount());
});

it('accepts the 64-file boundary and reports the native output folder', async () => {
  const { ui, split } = await mount();
  await act(async () => splitButton(ui).props.onClick());
  expect(split).toHaveBeenCalledWith(2);
  expect(ui.root.findAllByType('p').some(paragraph => paragraph.children.join('') === 'Created 1 file in C:/splits.')).toBe(true);
  act(() => ui.unmount());
});

it('closes quietly when the native folder dialog is canceled', async () => {
  const close = vi.fn(), split = vi.fn().mockResolvedValue(null);
  const { ui } = await mount({ split, close });
  await act(async () => splitButton(ui).props.onClick());
  expect(split).toHaveBeenCalledWith(2); expect(close).toHaveBeenCalledOnce();
  act(() => ui.unmount());
});

it('shows native failures and permits retry without a duplicate submission', async () => {
  let resolve!: (value: SplitOutput) => void;
  const split = vi.fn().mockRejectedValueOnce(new Error('Output folder already exists')).mockImplementationOnce(() => new Promise<SplitOutput>(done => { resolve = done; }));
  const { ui } = await mount({ split });
  await act(async () => splitButton(ui).props.onClick());
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('Output folder already exists');
  act(() => { splitButton(ui).props.onClick(); splitButton(ui).props.onClick(); });
  expect(split).toHaveBeenCalledTimes(2);
  await act(async () => resolve(output));
  expect(JSON.stringify(ui.toJSON())).toContain('Split complete');
  act(() => ui.unmount());
});

it('allows cancel before work starts but blocks dialog cancel and controls while work is active', async () => {
  const close = vi.fn(), split = vi.fn().mockResolvedValue(output);
  const first = await mount({ split, close });
  const preventDefault = vi.fn();
  act(() => first.ui.root.findByType('dialog').props.onCancel({ preventDefault }));
  expect(preventDefault).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  act(() => first.ui.unmount());
  const second = await mount({ busy: true, split, close });
  expect(input(second.ui).props.disabled).toBe(true);
  act(() => second.ui.root.findByType('dialog').props.onCancel({ preventDefault }));
  expect(close).toHaveBeenCalledOnce(); expect(split).not.toHaveBeenCalled();
  act(() => second.ui.unmount());
});
