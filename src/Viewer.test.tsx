import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Viewer from './Viewer';
import { renderPage } from './bridge';
import { pageLayout, visiblePageRange, type DocumentInfo } from './model';

vi.mock('./bridge', () => ({ renderPage: vi.fn() }));
vi.mock('./TextLayer', () => ({ default: () => null }));
vi.mock('./CommentLayer', () => ({ default: () => null }));

const document = (id: number, revision: number, count: number, width = 612): DocumentInfo => ({ id, revision, name: `${id}.pdf`, path: `C:/${id}.pdf`, pages: Array.from({ length: count }, (_, index) => ({ width: width + index % 2, height: 700 + index % 5 * 20 })), dirty: false, can_undo: false, can_redo: false });
const viewport = { scrollTop: 0, scrollLeft: 0, scrollTo: vi.fn(), setPointerCapture: vi.fn() };
const props = (info: DocumentInfo, onPage = vi.fn()) => ({ document: info, zoom: 100, fit: false, target: { page: 0, token: 0 }, onPage, hand: false });
const scrollable = (ui: ReactTestRenderer) => ui.root.findAll(node => typeof node.props.onScroll === 'function')[0];

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(renderPage).mockResolvedValue('blob:test');
  vi.stubGlobal('window', { devicePixelRatio: 1, setTimeout, clearTimeout });
  vi.stubGlobal('URL', { revokeObjectURL: vi.fn() });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('requests renders only for the binary visible range after a far 65,536-page scroll', async () => {
  const info = document(4, 1, 65_536); let ui!: ReactTestRenderer;
  act(() => { ui = create(<Viewer {...props(info)} />, { createNodeMock: () => viewport }); });
  await act(async () => { vi.advanceTimersByTime(35); await Promise.resolve(); });
  vi.mocked(renderPage).mockClear();
  const layout = pageLayout(info.pages, 96 / 72);
  const top = layout.offsets[32_768] + 13;
  act(() => scrollable(ui).props.onScroll({ currentTarget: { scrollTop: top } }));
  await act(async () => { vi.advanceTimersByTime(35); await Promise.resolve(); });
  const range = visiblePageRange(layout, top, 800);
  const requested = vi.mocked(renderPage).mock.calls.map(([, page]) => page);
  expect(requested).toEqual(Array.from({ length: range.end - range.start }, (_, index) => range.start + index));
  expect(requested.length).toBeLessThan(8);
  act(() => ui.unmount());
});

it('cancels old page timers when a document or revision changes', async () => {
  const first = document(4, 1, 1_500, 612), second = document(5, 2, 1_500, 700); let ui!: ReactTestRenderer;
  act(() => { ui = create(<Viewer key={`${first.id}-${first.revision}`} {...props(first)} />, { createNodeMock: () => viewport }); });
  act(() => ui.update(<Viewer key={`${second.id}-${second.revision}`} {...props(second)} />));
  await act(async () => { vi.advanceTimersByTime(35); await Promise.resolve(); });
  expect(vi.mocked(renderPage).mock.calls).not.toEqual(expect.arrayContaining([expect.arrayContaining([first.id]) ]));
  expect(vi.mocked(renderPage).mock.calls.length).toBeGreaterThan(0);
  expect(vi.mocked(renderPage).mock.calls.every(([id, , width]) => id === second.id && width >= Math.round(second.pages[0].width * 96 / 72))).toBe(true);
  act(() => ui.unmount());
});

it('uses the newest revision dimensions when the document ID stays the same', async () => {
  const first = document(4, 1, 1_500, 612), next = document(4, 2, 1_500, 700); let ui!: ReactTestRenderer;
  act(() => { ui = create(<Viewer {...props(first)} />, { createNodeMock: () => viewport }); });
  act(() => ui.update(<Viewer {...props(next)} />));
  await act(async () => { vi.advanceTimersByTime(35); await Promise.resolve(); });
  expect(vi.mocked(renderPage).mock.calls.length).toBeGreaterThan(0);
  expect(vi.mocked(renderPage).mock.calls.every(([id, , width]) => id === next.id && width >= Math.round(next.pages[0].width * 96 / 72))).toBe(true);
  act(() => ui.unmount());
});
