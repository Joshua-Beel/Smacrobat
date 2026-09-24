import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import PageList, { PAGE_LIST_ROW_HEIGHT, pageListGaps, pageListWindow } from './PageList';
import type { DocumentInfo } from './model';
import type { DocumentPageLabels } from './pageLabels';

const document = (count: number): DocumentInfo => ({ id: 4, name: 'many.pdf', path: 'C:/many.pdf', pages: Array.from({ length: count }, (_, index) => ({ width: 612 + index % 2, height: 792 })), revision: 3, dirty: false, can_undo: false, can_redo: false });
const labels = (count: number): DocumentPageLabels => ({ documentId: 4, revision: 3, status: 'supported', reason: null, labels: Array.from({ length: count }, (_, page) => ({ page, label: page === 1 ? '12' : page === 2 ? '' : page === 3 ? '  Ω  ' : page === 4 ? 'duplicate' : page === 5 ? 'duplicate' : `label-${page}` })) });
const row = (ui: ReactTestRenderer, index: number) => ui.root.findByProps({ 'data-page-index': index });
const event = (key: string) => ({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() });

it('bounds first, middle, and final windows while spacer math retains every physical row', () => {
  for (const [scrollTop, current, focused] of [[0, 0, null], [32_768 * PAGE_LIST_ROW_HEIGHT, 32_768, 65_535], [65_535 * PAGE_LIST_ROW_HEIGHT, 65_535, 0]] as const) {
    const pages = pageListWindow(65_536, scrollTop, PAGE_LIST_ROW_HEIGHT * 3, current, focused);
    expect(pages).toContain(current);
    if (focused !== null) expect(pages).toContain(focused);
    expect(pages.length).toBeLessThanOrEqual(3 + 12 + 2);
    const tail = 65_536 - pages[pages.length - 1] - 1;
    expect(pageListGaps(pages).reduce((total, gap) => total + gap.before, 0) + pages.length + tail).toBe(65_536);
  }
});

it('covers a tall, non-row-aligned viewport with only viewport rows, overscan, and pins', () => {
  const height = PAGE_LIST_ROW_HEIGHT * 53 + 17;
  const pages = pageListWindow(65_536, PAGE_LIST_ROW_HEIGHT * 2 + 41, height, 50_000, 60_000);
  const firstVisible = Math.floor((PAGE_LIST_ROW_HEIGHT * 2 + 41) / PAGE_LIST_ROW_HEIGHT);
  const finalVisible = Math.ceil((PAGE_LIST_ROW_HEIGHT * 2 + 41 + height) / PAGE_LIST_ROW_HEIGHT) - 1;
  for (let index = firstVisible; index <= finalVisible; index++) expect(pages).toContain(index);
  expect(pages.length).toBeLessThanOrEqual(Math.ceil(height / PAGE_LIST_ROW_HEIGHT) + 12 + 2);
});

it('keeps exact secondary labels in mounted DOM text and activates only physical indices', () => {
  const go = vi.fn(); let ui!: ReactTestRenderer;
  act(() => { ui = create(<PageList document={document(1_500)} page={3} pageLabels={labels(1_500)} go={go} />); });
  expect(row(ui, 1).props.title).toBe('Label: 12');
  expect(JSON.stringify(ui.toJSON())).toContain('(blank label)');
  expect(JSON.stringify(ui.toJSON())).toContain('  Ω  ');
  expect(JSON.stringify(ui.toJSON())).toContain('duplicate');
  act(() => row(ui, 4).props.onClick());
  expect(go).toHaveBeenCalledExactlyOnceWith(4);
  act(() => ui.unmount());
});

it('scrolls the sidebar window without navigation and pins current plus focus outside that window', () => {
  const go = vi.fn(); let ui!: ReactTestRenderer;
  act(() => { ui = create(<PageList document={document(65_536)} page={0} pageLabels={null} go={go} />); });
  const list = ui.root.findByProps({ 'aria-label': 'Page list' });
  act(() => list.props.onScroll({ currentTarget: { scrollTop: 32_768 * PAGE_LIST_ROW_HEIGHT } }));
  expect(row(ui, 0)).toBeTruthy();
  expect(row(ui, 32_768)).toBeTruthy();
  expect(go).not.toHaveBeenCalled();
  act(() => row(ui, 0).props.onFocus());
  act(() => list.props.onScroll({ currentTarget: { scrollTop: 65_535 * PAGE_LIST_ROW_HEIGHT } }));
  expect(row(ui, 0)).toBeTruthy();
  expect(row(ui, 65_535)).toBeTruthy();
  expect(ui.root.findAllByType('button').filter(button => button.props['data-page-index'] !== undefined).length).toBeLessThan(60);
  act(() => ui.unmount());
});

it('recenters an external current page without focusing it or replacing the retained roving index', () => {
  const go = vi.fn();
  const querySelector = vi.fn();
  const list = { clientHeight: PAGE_LIST_ROW_HEIGHT * 3, scrollTop: 0, querySelector };
  let ui!: ReactTestRenderer;
  act(() => { ui = create(<PageList document={document(1_500)} page={0} pageLabels={null} go={go} />, { createNodeMock: element => element.type === 'div' ? list : {} }); });
  act(() => row(ui, 5).props.onFocus());
  act(() => ui.update(<PageList document={document(1_500)} page={600} pageLabels={null} go={go} />));
  expect(list.scrollTop).toBeGreaterThan(0);
  expect(row(ui, 5).props.tabIndex).toBe(0);
  expect(row(ui, 600).props['aria-current']).toBe('page');
  expect(querySelector).not.toHaveBeenCalled();
  expect(go).not.toHaveBeenCalled();
  act(() => ui.unmount());
});

it('moves a roving focus across virtual boundaries while preserving PageUp and activating once on Enter or Space', () => {
  const go = vi.fn(); let ui!: ReactTestRenderer;
  act(() => { ui = create(<PageList document={document(1_500)} page={17} pageLabels={labels(1_500)} go={go} />); });
  act(() => row(ui, 17).props.onFocus());
  const down = event('ArrowDown'); act(() => row(ui, 17).props.onKeyDown(down));
  expect(down.preventDefault).toHaveBeenCalledOnce(); expect(down.stopPropagation).toHaveBeenCalledOnce(); expect(row(ui, 18).props.tabIndex).toBe(0); expect(go).not.toHaveBeenCalled();
  const end = event('End'); act(() => row(ui, 18).props.onKeyDown(end));
  expect(end.preventDefault).toHaveBeenCalledOnce(); expect(row(ui, 1_499).props.tabIndex).toBe(0);
  const pageDown = event('PageDown'); act(() => row(ui, 1_499).props.onKeyDown(pageDown));
  expect(pageDown.preventDefault).not.toHaveBeenCalled(); expect(pageDown.stopPropagation).not.toHaveBeenCalled();
  const enter = event('Enter'); act(() => row(ui, 1_499).props.onKeyDown(enter));
  expect(go).toHaveBeenCalledExactlyOnceWith(1_499);
  go.mockClear();
  const space = event(' '); act(() => row(ui, 1_499).props.onKeyDown(space));
  expect(go).toHaveBeenCalledExactlyOnceWith(1_499);
  act(() => ui.unmount());
});

it('drops an invalid pinned focus when the page count shrinks', () => {
  const go = vi.fn(); const original = document(1_500); let ui!: ReactTestRenderer;
  act(() => { ui = create(<PageList document={original} page={1_499} pageLabels={labels(1_500)} go={go} />); });
  act(() => row(ui, 1_499).props.onFocus());
  act(() => ui.update(<PageList document={{ ...original, pages: original.pages.slice(0, 2), revision: 4 }} page={1} pageLabels={null} go={go} />));
  expect(ui.root.findAllByType('button').filter(button => button.props['data-page-index'] !== undefined)).toHaveLength(2);
  expect(row(ui, 1).props['aria-current']).toBe('page');
  act(() => ui.unmount());
});
