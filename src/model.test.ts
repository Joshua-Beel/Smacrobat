import { describe, expect, it } from 'vitest';
import { clampPage, currentPageAt, firstPageAfter, maxPageWidth, pageLayout, pageOffsets, scaleAnchoredTop, visiblePageRange, visiblePages, parsePageRange } from './model';
describe('document viewport', () => {
  it('bounds invalid navigation', () => { expect(clampPage(-1, 98)).toBe(0); expect(clampPage(120, 98)).toBe(97); expect(clampPage(NaN, 98)).toBe(0); });
  it('lays out mixed page sizes without overlap', () => { expect(pageOffsets([{ width: 612, height: 792 }, { width: 792, height: 612 }], 2)).toEqual([24, 1632]); });
  it('keeps raster work bounded on a 1500-page document', () => {
    const pages = Array.from({ length: 1500 }, () => ({ width: 612, height: 792 }));
    const offsets = pageOffsets(pages, 1);
    const visible = visiblePages(offsets, pages, 1, offsets[749], 1000);
    expect(visible).toContain(749); expect(visible.length).toBeLessThanOrEqual(5); expect(visible).not.toContain(0);
  });
  it('matches the linear visible and current-page rules at mixed-size boundaries', () => {
    const pages = [{ width: 612, height: 792 }, { width: 792, height: 612 }, { width: 450, height: 1_200 }, { width: 700, height: 333 }];
    for (const scale of [.5, 1, 1.75]) {
      const layout = pageLayout(pages, scale);
      const linearVisible = (top: number, height: number) => pages.map((_, index) => index).filter(index => layout.bottoms[index] >= top - height / 2 && layout.offsets[index] <= top + height * 1.5);
      const linearCurrent = (offset: number) => { const index = layout.bottoms.findIndex(bottom => bottom > offset); return index < 0 ? pages.length - 1 : index; };
      for (const top of [0, layout.offsets[1], layout.bottoms[0], layout.bottoms[0] + 12, layout.offsets[3], layout.bottoms[3], layout.height + 20]) {
        const range = visiblePageRange(layout, top, 500);
        expect(Array.from({ length: range.end - range.start }, (_, index) => range.start + index)).toEqual(linearVisible(top, 500));
        expect(currentPageAt(layout, top)).toBe(linearCurrent(top));
      }
      const boundary = 2, epsilon = .001;
      const indexes = (top: number) => { const range = visiblePageRange(layout, top, 500); return Array.from({ length: range.end - range.start }, (_, index) => range.start + index); };
      expect(indexes(layout.bottoms[boundary] + 250)).toContain(boundary);
      expect(indexes(layout.bottoms[boundary] + 250 + epsilon)).not.toContain(boundary);
      expect(indexes(layout.offsets[boundary] - 750)).toContain(boundary);
      expect(indexes(layout.offsets[boundary] - 750 - epsilon)).not.toContain(boundary);
      expect(firstPageAfter(layout, layout.bottoms[0])).toBe(1);
      expect(currentPageAt(layout, layout.bottoms[boundary] - epsilon)).toBe(boundary);
      expect(currentPageAt(layout, layout.bottoms[boundary])).toBe(boundary + 1);
      expect(currentPageAt(layout, layout.bottoms.at(-1)!)).toBe(pages.length - 1);
    }
  });
  it('keeps visible and current lookups bounded for 65,536 pages', () => {
    const pages = Array.from({ length: 65_536 }, (_, index) => ({ width: 500 + index % 3 * 50, height: 700 + index % 5 * 20 }));
    const source = pageLayout(pages, 1);
    let reads = 0;
    const countReads = (values: number[]) => new Proxy(values, { get(target, property, receiver) { if (typeof property === 'string' && /^\d+$/.test(property)) reads++; return Reflect.get(target, property, receiver); } }) as number[];
    const layout = { ...source, offsets: countReads(source.offsets), bottoms: countReads(source.bottoms) };
    const top = source.offsets[32_768] + 13;
    const range = visiblePageRange(layout, top, 900);
    expect(range.end - range.start).toBeLessThan(8);
    expect(currentPageAt(layout, top + 80)).toBe(32_768);
    expect(reads).toBeLessThan(80);
  });
  it('matches linear ranges for first, middle, and last mixed-height pages at 1,500 and 65,536 pages', () => {
    for (const count of [1_500, 65_536]) {
      const pages = Array.from({ length: count }, (_, index) => ({ width: 480 + index % 4 * 80, height: 360 + index % 7 * 95 }));
      const layout = pageLayout(pages, 1.25);
      const linearVisible = (top: number) => pages.map((_, index) => index).filter(index => layout.bottoms[index] >= top - 600 && layout.offsets[index] <= top + 1_800);
      const linearCurrent = (offset: number) => { const index = layout.bottoms.findIndex(bottom => bottom > offset + 80); return index < 0 ? count - 1 : index; };
      for (const index of [0, Math.floor(count / 2), count - 1]) {
        for (const top of [layout.offsets[index], layout.bottoms[index], layout.bottoms[index] + 12]) {
          const range = visiblePageRange(layout, top, 1_200);
          expect(Array.from({ length: range.end - range.start }, (_, offset) => range.start + offset)).toEqual(linearVisible(top));
          expect(currentPageAt(layout, top + 80)).toBe(linearCurrent(top));
        }
      }
    }
  });
  it('preserves the strict scale anchor and total layout measurements', () => {
    const pages = [{ width: 612, height: 792 }, { width: 900, height: 300 }, { width: 480, height: 1_000 }];
    const old = pageLayout(pages, 1), next = pageLayout(pages, 1.5);
    const scrollTop = old.bottoms[0];
    expect(maxPageWidth(pages)).toBe(900);
    expect(old.height).toBe(old.bottoms.at(-1)! + 24);
    expect(scaleAnchoredTop(old, next, 1, 1.5, scrollTop)).toBe(next.offsets[1] + (scrollTop - old.offsets[1]) * 1.5);
  });
});
describe('page range selection', () => {
  it('deduplicates ranges in document order', () => { expect(parsePageRange('5, 1-3, 2', 6)).toEqual([0, 1, 2, 4]); });
  it('rejects empty, reversed, non-integer and out-of-bounds ranges', () => {
    for (const value of ['', '0', '1-99', '3-1', '1.5', '1,,2', '-1']) expect(() => parsePageRange(value, 6)).toThrow();
  });
});
