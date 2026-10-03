import type { CreatePdfOptions, SavedCopy } from './bridge';

export const MAX_MULTI_IMAGE_SOURCES = 32;

export type ImagePdfSource = { path: string; name: string; identity: string };
export type MultiImagePdfRequest = { sources: ImagePdfSource[]; options: CreatePdfOptions };
export type ChooseImagePdfSources = () => Promise<ImagePdfSource[] | null>;
export type CreatePdfFromImages = (request: MultiImagePdfRequest) => Promise<SavedCopy | null>;

export function validateImagePdfSources(sources: ImagePdfSource[]): string | null {
  if (sources.length < 1 || sources.length > MAX_MULTI_IMAGE_SOURCES) return `Choose between 1 and ${MAX_MULTI_IMAGE_SOURCES} images.`;
  const identities = new Set<string>();
  for (const source of sources) {
    if (!source.path.trim() || !source.name.trim() || !source.identity.trim()) return 'Every selected image must have a path, filename, and native identity.';
    if (identities.has(source.identity)) return 'Each selected image must have a unique native identity.';
    identities.add(source.identity);
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
