export type RecoveryCommittedReopenRequired = {
  code: 'recoveryCommittedReopenRequired';
  documentId: number;
  requestedRevision: number;
  committedRevision: number;
};

export const recoveryCommittedReopenRequired = (reason: unknown, documentId: number, requestedRevision: number): reason is RecoveryCommittedReopenRequired => {
  if (typeof reason !== 'object' || reason === null || Array.isArray(reason)) return false;
  const value = reason as Record<string, unknown>;
  return Object.keys(value).length === 4 && value.code === 'recoveryCommittedReopenRequired' && value.documentId === documentId && value.requestedRevision === requestedRevision && Number.isSafeInteger(value.committedRevision) && (value.committedRevision as number) >= requestedRevision;
};
