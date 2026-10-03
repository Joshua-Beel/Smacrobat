import { expect, it } from 'vitest';
import { MAX_MULTI_IMAGE_SOURCES, moveImagePdfSource, validateImagePdfSources, type ImagePdfSource } from './multiImagePdf';

const source = (name: string): ImagePdfSource => ({ name, sourceId: `opaque-${name}` });

it('requires one through 32 unique opaque native source IDs', () => {
  expect(validateImagePdfSources([])).toContain('1 and 32');
  expect(validateImagePdfSources(Array.from({ length: MAX_MULTI_IMAGE_SOURCES }, (_, index) => source(`${index}.png`)))).toBeNull();
  expect(validateImagePdfSources(Array.from({ length: MAX_MULTI_IMAGE_SOURCES + 1 }, (_, index) => source(`${index}.png`)))).toContain('1 and 32');
  expect(validateImagePdfSources([source('A.png'), { name: 'copy.png', sourceId: 'opaque-A.png' }])).toContain('unique native source ID');
  expect(validateImagePdfSources([{ name: 'a.png', sourceId: '' }])).toContain('filename and opaque native source ID');
});

it('moves only valid adjacent entries without changing opaque source IDs', () => {
  const original = [source('a.png'), source('b.jpg'), source('c.png')];
  expect(moveImagePdfSource(original, 1, -1).map(item => item.name)).toEqual(['b.jpg', 'a.png', 'c.png']);
  expect(moveImagePdfSource(original, 1, 1).map(item => item.name)).toEqual(['a.png', 'c.png', 'b.jpg']);
  expect(moveImagePdfSource(original, 0, -1)).toBe(original);
  expect(original.map(item => item.name)).toEqual(['a.png', 'b.jpg', 'c.png']);
});
