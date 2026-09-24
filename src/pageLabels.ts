export type PageLabel = { page: number; label: string };
export type DocumentPageLabels = {
  documentId: number;
  revision: number;
  status: 'supported' | 'none' | 'unavailable';
  reason: string | null;
  labels: PageLabel[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validatePageLabels(value: unknown, pageCount: number): DocumentPageLabels | null {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0 || !isRecord(value)) return null;
  if (!isSafeNonNegativeInteger(value.documentId) || !isSafeNonNegativeInteger(value.revision)) return null;
  if (value.status !== 'supported' && value.status !== 'none' && value.status !== 'unavailable') return null;
  if (value.reason !== null && typeof value.reason !== 'string') return null;
  if (!Array.isArray(value.labels)) return null;
  if (value.status !== 'supported' && value.labels.length !== 0) return null;
  if (value.status === 'supported' && value.labels.length !== pageCount) return null;
  const labels: PageLabel[] = [];
  for (let index = 0; index < value.labels.length; index++) {
    const item = value.labels[index];
    if (!isRecord(item) || item.page !== index || typeof item.label !== 'string') return null;
    labels.push({ page: item.page, label: item.label });
  }
  return { documentId: value.documentId, revision: value.revision, status: value.status, reason: value.reason, labels };
}

export function pageLabelFor(snapshot: DocumentPageLabels | null | undefined, page: number): string | null {
  if (snapshot?.status !== 'supported' || !Number.isSafeInteger(page) || page < 0) return null;
  const item = snapshot.labels[page];
  return item?.page === page ? item.label : null;
}

export function pageLabelDescription(label: string): string {
  return label.length === 0 ? '(blank label)' : label;
}
