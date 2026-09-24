export type PageSize = { width: number; height: number };
export type DocumentInfo = { id: number; name: string; path: string; pages: PageSize[]; revision: number; dirty: boolean; can_undo: boolean; can_redo: boolean };
export type PageEdit = { kind: 'rotate'; pages: number[]; clockwise: boolean } | { kind: 'delete'; pages: number[] } | { kind: 'move'; from: number; to: number } | { kind: 'undo' | 'redo' };
export function parsePageRange(text: string, count: number): number[] {
  const pages = new Set<number>();
  if (!text.trim()) throw new Error('Enter page numbers, such as 1-3, 5.');
  for (const part of text.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('Use page numbers and ranges, such as 1-3, 5.');
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    if (first < 1 || last > count || last < first) throw new Error(`Choose pages between 1 and ${count}.`);
    for (let i = first; i <= last; i++) pages.add(i - 1);
  }
  return [...pages].sort((a, b) => a - b);
}
export const clampPage = (value: number, count: number) => Math.max(0, Math.min(count - 1, Number.isFinite(value) ? Math.trunc(value) : 0));
export type PageLayout = { offsets: number[]; bottoms: number[]; height: number; maxWidth: number };
export type PageRange = { start: number; end: number };
export function maxPageWidth(pages: PageSize[]) {
  let width = 0;
  for (const page of pages) width = Math.max(width, page.width);
  return width;
}
export function fitPageScale(page: PageSize, width: number, height: number) {
  return Math.max(0.1, Math.min((width - 144) / page.width, (height - 48) / page.height));
}
export function pageLayout(pages: PageSize[], scale: number, maxWidth = maxPageWidth(pages)): PageLayout {
  const offsets = new Array<number>(pages.length), bottoms = new Array<number>(pages.length);
  let offset = 24;
  for (let index = 0; index < pages.length; index++) {
    offsets[index] = offset;
    offset += pages[index].height * scale;
    bottoms[index] = offset;
    offset += 24;
  }
  return { offsets, bottoms, height: offset, maxWidth };
}
export function pageOffsets(pages: PageSize[], scale: number) {
  return pageLayout(pages, scale).offsets;
}
function firstIndex(values: number[], target: number, predicate: (value: number, target: number) => boolean) {
  let start = 0, end = values.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (predicate(values[middle], target)) end = middle; else start = middle + 1;
  }
  return start;
}
export function visiblePageRange(layout: PageLayout, top: number, height: number): PageRange {
  const start = firstIndex(layout.bottoms, top - height / 2, (bottom, boundary) => bottom >= boundary);
  const end = firstIndex(layout.offsets, top + height * 1.5, (offset, boundary) => offset > boundary);
  return { start: Math.min(start, end), end };
}
export function firstPageAfter(layout: PageLayout, offset: number) {
  const page = firstIndex(layout.bottoms, offset, (bottom, boundary) => bottom > boundary);
  return page === layout.bottoms.length ? -1 : page;
}
export function currentPageAt(layout: PageLayout, offset: number) {
  const page = firstPageAfter(layout, offset);
  return page < 0 ? layout.bottoms.length - 1 : page;
}
export function scaleAnchoredTop(oldLayout: PageLayout, nextLayout: PageLayout, oldScale: number, nextScale: number, scrollTop: number) {
  const anchor = Math.max(0, firstPageAfter(oldLayout, scrollTop));
  return nextLayout.offsets[anchor] + (scrollTop - oldLayout.offsets[anchor]) * nextScale / oldScale;
}
export function visiblePages(offsets: number[], pages: PageSize[], scale: number, top: number, height: number) {
  const layout: PageLayout = { offsets, bottoms: offsets.map((offset, index) => offset + pages[index].height * scale), height: 0, maxWidth: 0 };
  const range = visiblePageRange(layout, top, height);
  return Array.from({ length: range.end - range.start }, (_, index) => range.start + index);
}
export const toolGroups = [
  { name: 'Create & edit', tools: ['Create a PDF', 'Combine files', 'Organize pages', 'Edit a PDF', 'Export a PDF', 'Scan & OCR', 'Rich media'] },
  { name: 'Review', tools: ['Comment', 'Add a stamp', 'Compare files', 'Measure', 'Export package', 'Comment round-trip'] },
  { name: 'Forms & signatures', tools: ['Fill forms', 'Prepare a form', 'Use a certificate'] },
  { name: 'Protect & standardize', tools: ['Protect a PDF', 'Redact a PDF', 'PDF standards', 'Compress a PDF', 'Print preview', 'Prepare for accessibility'] },
  { name: 'Customize', tools: ['Create custom tool', 'Use guided actions', 'Add search index'] }
];
