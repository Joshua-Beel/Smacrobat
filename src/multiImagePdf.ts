import type { CreatePdfOptions, ImagePdfSelection, ImagePdfSource, SavedCopy } from './bridge';

export const MAX_MULTI_IMAGE_SOURCES = 32;

export type { ImagePdfSelection, ImagePdfSource } from './bridge';
export type MultiImagePdfRequest = { selectionId: string; sourceIds: string[]; options: CreatePdfOptions };
export type ChooseImagePdfSources = (replaceSelectionId?: string) => Promise<ImagePdfSelection | null>;
export type CreatePdfFromImages = (request: MultiImagePdfRequest) => Promise<SavedCopy | null>;
export type CancelImagePdfSources = (selectionId: string) => Promise<void>;

export function validateImagePdfSources(sources: ImagePdfSource[]): string | null {
  if (sources.length < 1 || sources.length > MAX_MULTI_IMAGE_SOURCES) return `Choose between 1 and ${MAX_MULTI_IMAGE_SOURCES} images.`;
  const identities = new Set<string>();
  for (const source of sources) {
    if (!source.name.trim() || !source.sourceId.trim()) return 'Every selected image must have a filename and opaque native source ID.';
    if (identities.has(source.sourceId)) return 'Each selected image must have a unique native source ID.';
    identities.add(source.sourceId);
  }
  return null;
}

export function moveImagePdfSource(sources: ImagePdfSource[], index: number, offset: -1 | 1): ImagePdfSource[] {
  const target = index + offset;
  if (index < 0 || index >= sources.length || target < 0 || target >= sources.length) return sources;
  const next = [...sources];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
