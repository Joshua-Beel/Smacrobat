import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { editPages, openDocument, saveCopy } from './bridge';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), createPdfFromImage: vi.fn(), documentPageLabels: vi.fn() }));
vi.mock('./Viewer', () => ({ default: ({ fit, target, onPage }: { fit: string; target: { page: number }; onPage: (page: number) => void }) => <button aria-label="Mock viewer reports page 3" data-fit={fit} data-target-page={target.page} onClick={() => onPage(2)}>Rendered document</button> }));

const document: DocumentInfo = { id: 9, name: 'one.pdf', path: 'C:/docs/one.pdf', pages: [{ width: 612, height: 792 }, { width: 792, height: 612 }, { width: 500, height: 1_000 }], revision: 0, dirty: false, can_undo: true, can_redo: false };
let keydown: (event: KeyboardEvent) => void;
let ui: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn() },
    addEventListener: (name: string, callback: typeof keydown) => { if (name === 'keydown') keydown = callback; },
    removeEventListener: vi.fn(),
  });
  vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document });
  vi.mocked(editPages).mockResolvedValue(document);
  vi.mocked(saveCopy).mockResolvedValue(null);
});

afterEach(() => { if (ui) act(() => ui!.unmount()); ui = undefined; vi.unstubAllGlobals(); });

it.each(['o', 's', 'z'])('ignores Ctrl+%s from a dialog button but retains the workspace shortcut', async key => {
  await act(async () => { ui = create(<App />); });
  await act(async () => ui!.root.findAllByType('button').find(button => button.children.includes('Explore a sample PDF '))!.props.onClick());
  vi.mocked(openDocument).mockClear();
  vi.mocked(openDocument).mockResolvedValue(null);
  const send = async (inDialog: boolean) => {
    const target = { closest: (selector: string) => selector === 'dialog' && inDialog ? {} : null, matches: () => false };
    await act(async () => keydown({ key, ctrlKey: true, target, preventDefault: vi.fn() } as unknown as KeyboardEvent));
  };
  await send(true);
  expect(openDocument).not.toHaveBeenCalled();
  expect(saveCopy).not.toHaveBeenCalled();
  expect(editPages).not.toHaveBeenCalled();
  await send(false);
  expect(key === 'o' ? openDocument : key === 's' ? saveCopy : editPages).toHaveBeenCalledOnce();
});

it('keeps Ctrl+0 behind dialog guards and uses target page as the stable fit-page reference', async () => {
  await act(async () => { ui = create(<App />); });
  await act(async () => ui!.root.findAllByType('button').find(button => button.children.includes('Explore a sample PDF '))!.props.onClick());
  const viewer = () => ui!.root.findByProps({ 'aria-label': 'Mock viewer reports page 3' });
  const zoom = () => ui!.root.findByProps({ 'aria-label': 'Zoom' });
  const send = async (inDialog: boolean) => {
    const target = { closest: (selector: string) => selector === 'dialog' && inDialog ? {} : null, matches: () => false };
    const preventDefault = vi.fn();
    await act(async () => keydown({ key: '0', ctrlKey: true, target, preventDefault } as unknown as KeyboardEvent));
    return preventDefault;
  };
  expect(viewer().props['data-fit']).toBe('width');
  expect(zoom().props.value).toBe('width');
  expect(ui!.root.findByProps({ 'aria-label': 'Fit width' }).props.className).toMatch(/activeIcon/);
  expect(ui!.root.findByProps({ 'aria-label': 'Fit page' }).props.className).not.toMatch(/activeIcon/);
  const guarded = await send(true);
  expect(guarded).not.toHaveBeenCalled();
  expect(viewer().props['data-fit']).toBe('width');
  expect(viewer().props['data-target-page']).toBe(0);
  const handled = await send(false);
  expect(handled).toHaveBeenCalledOnce();
  expect(viewer().props['data-fit']).toBe('page');
  expect(viewer().props['data-target-page']).toBe(0);
  expect(zoom().props.value).toBe('page');
  expect(ui!.root.findByProps({ 'aria-label': 'Fit width' }).props.className).not.toMatch(/activeIcon/);
  expect(ui!.root.findByProps({ 'aria-label': 'Fit page' }).props.className).toMatch(/activeIcon/);
  act(() => ui!.root.findByProps({ 'aria-label': 'Next page' }).props.onClick());
  expect(viewer().props['data-target-page']).toBe(1);
  act(() => viewer().props.onClick());
  expect(viewer().props['data-target-page']).toBe(1);
  act(() => ui!.root.findByProps({ 'aria-label': 'Fit page' }).props.onClick());
  expect(viewer().props['data-target-page']).toBe(2);
  act(() => ui!.root.findByProps({ 'aria-label': 'Zoom in' }).props.onClick());
  expect(viewer().props['data-fit']).toBe('none');
  expect(zoom().props.value).toBe(125);
  await act(async () => keydown({ key: '1', ctrlKey: true, target: { closest: () => null, matches: () => false }, preventDefault: vi.fn() } as unknown as KeyboardEvent));
  expect(viewer().props['data-fit']).toBe('none');
  await act(async () => keydown({ key: '2', ctrlKey: true, target: { closest: () => null, matches: () => false }, preventDefault: vi.fn() } as unknown as KeyboardEvent));
  expect(viewer().props['data-fit']).toBe('width');
  expect(zoom().props.value).toBe('width');
  expect(ui!.root.findByProps({ 'aria-label': 'Fit width' }).props.className).toMatch(/activeIcon/);
  expect(ui!.root.findByProps({ 'aria-label': 'Fit page' }).props.className).not.toMatch(/activeIcon/);
});
