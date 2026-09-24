import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Viewer from './Viewer';
import { renderPage } from './bridge';
import { fitPageScale, pageLayout, scaleAnchoredTop, visiblePageRange, type DocumentInfo } from './model';

vi.mock('./bridge', () => ({ renderPage: vi.fn() }));
vi.mock('./TextLayer', () => ({ default: () => null }));
vi.mock('./CommentLayer', () => ({ default: () => null }));

const document = (id: number, revision: number, count: number, width = 612): DocumentInfo => ({ id, revision, name: `${id}.pdf`, path: `C:/${id}.pdf`, pages: Array.from({ length: count }, (_, index) => ({ width: width + index % 2, height: 700 + index % 5 * 20 })), dirty: false, can_undo: false, can_redo: false });
const viewport = { scrollTop: 0, scrollLeft: 0, scrollTo: vi.fn(), setPointerCapture: vi.fn() };
const props = (info: DocumentInfo, onPage = vi.fn()) => ({ document: info, zoom: 100, fit: 'none' as const, target: { page: 0, token: 0 }, onPage, hand: false });
const scrollable = (ui: ReactTestRenderer) => ui.root.findAll(node => typeof node.props.onScroll === 'function')[0];
let resize: ((entries: Array<{ contentRect: { width: number; height: number } }>) => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(renderPage).mockResolvedValue('blob:test');
  vi.stubGlobal('window', { devicePixelRatio: 1, setTimeout, clearTimeout });
  vi.stubGlobal('URL', { revokeObjectURL: vi.fn() });
  viewport.scrollTop = 0; viewport.scrollLeft = 0;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: typeof resize) { resize = callback; } observe() {} disconnect() {} });
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

it('uses the stable target page for fit-page scale through manual scrolls and frames explicit jumps', async () => {
  const info: DocumentInfo = { id: 4, revision: 1, name: 'mixed.pdf', path: 'C:/mixed.pdf', pages: [{ width: 612, height: 792 }, { width: 1_100, height: 400 }, { width: 400, height: 1_300 }], dirty: false, can_undo: false, can_redo: false };
  const onPage = vi.fn(); let ui!: ReactTestRenderer;
  const target = { page: 1, token: 3 };
  act(() => { ui = create(<Viewer {...props(info, onPage)} fit="page" target={target} />, { createNodeMock: () => viewport }); });
  const expected = fitPageScale(info.pages[1], 900, 800);
  const paper = (index: number) => ui.root.findAll(node => node.props['aria-label'] === `Page ${index + 1}`)[0];
  expect(paper(1).props.style.width).toBeCloseTo(info.pages[1].width * expected);
  expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: pageLayout(info.pages, expected).offsets[1] - 24 });
  const current = scrollable(ui);
  act(() => current.props.onScroll({ currentTarget: { scrollTop: pageLayout(info.pages, expected).offsets[2] } }));
  expect(onPage).toHaveBeenLastCalledWith(2);
  expect(paper(2).props.style.width).toBeCloseTo(info.pages[2].width * expected);
  const nextTarget = { page: 2, token: 4 }, nextScale = fitPageScale(info.pages[2], 900, 800);
  act(() => { ui.update(<Viewer {...props(info, onPage)} fit="page" target={nextTarget} />); });
  expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: pageLayout(info.pages, nextScale).offsets[2] - 24 });
  expect(paper(2).props.style.width).toBeCloseTo(info.pages[2].width * nextScale);
  act(() => ui.unmount());
});

it('recomputes fit-page scale on resize while retaining the target-page anchor', () => {
  const info = document(4, 1, 3, 1_000), target = { page: 1, token: 1 }; let ui!: ReactTestRenderer;
  act(() => { ui = create(<Viewer {...props(info)} fit="page" target={target} />, { createNodeMock: () => viewport }); });
  const oldScale = fitPageScale(info.pages[1], 900, 800), oldLayout = pageLayout(info.pages, oldScale);
  const oldTop = oldLayout.offsets[1] - 24;
  viewport.scrollTop = oldTop;
  act(() => resize?.([{ contentRect: { width: 744, height: 648 } }]));
  const nextScale = fitPageScale(info.pages[1], 744, 648), nextLayout = pageLayout(info.pages, nextScale);
  expect(viewport.scrollTop).toBeCloseTo(scaleAnchoredTop(oldLayout, nextLayout, oldScale, nextScale, oldTop));
  act(() => ui.unmount());
});
