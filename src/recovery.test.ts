import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { checkpointRecovery, createComment, createHighlight, createTextHighlight, cropPage, cropPages, deleteComment, deleteHighlight, editPages, resetCrops, restoreRecovery, updateComment, updateHighlight } from './bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));

beforeEach(() => vi.clearAllMocks());

it('sends only the current document identity, revision, and page for a checkpoint', async () => {
  vi.mocked(invoke).mockResolvedValue({ documentId: 7, revision: 4, currentPage: 2 });
  await expect(checkpointRecovery(7, 4, 2)).resolves.toEqual({ documentId: 7, revision: 4, currentPage: 2 });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('checkpoint_recovery', { id: 7, revision: 4, currentPage: 2 });
});

it('starts restore without sending a source or journal path', async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  await expect(restoreRecovery()).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('restore_recovery');
});

it('sends the exact physical viewer page with every journaled mutation', async () => {
  vi.mocked(invoke).mockResolvedValue({});
  await editPages(7, { kind: 'undo' }, 3);
  await cropPage(7, 1, 4, { x: .1, y: .2, width: .7, height: .6 }, 3);
  await cropPages(7, 4, [1, 2], { top: 1, right: 2, bottom: 3, left: 4 }, 3);
  await resetCrops(7, 4, [1, 2], 3);
  await createComment(7, 4, 1, { x: .1, y: .2, width: .03, height: .04 }, 'note', 3);
  await updateComment(7, 4, 'note-1', 'updated', 3);
  await deleteComment(7, 4, 'note-1', 3);
  await createHighlight(7, 4, 1, { x: .1, y: .2, width: .3, height: .4 }, null, 3);
  await createTextHighlight(7, 4, 1, 2, 5, 'selected', 3);
  await updateHighlight(7, 4, 'highlight-1', null, 3);
  await deleteHighlight(7, 4, 'highlight-1', 3);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['edit_pages', { id: 7, edit: { kind: 'undo' }, currentPage: 3 }],
    ['crop_page', { id: 7, page: 1, revision: 4, rect: { x: .1, y: .2, width: .7, height: .6 }, currentPage: 3 }],
    ['crop_pages', { id: 7, revision: 4, pages: [1, 2], insets: { top: 1, right: 2, bottom: 3, left: 4 }, currentPage: 3 }],
    ['reset_crops', { id: 7, revision: 4, pages: [1, 2], currentPage: 3 }],
    ['create_comment', { id: 7, revision: 4, page: 1, rect: { x: .1, y: .2, width: .03, height: .04 }, contents: 'note', currentPage: 3 }],
    ['update_comment', { id: 7, revision: 4, noteId: 'note-1', contents: 'updated', currentPage: 3 }],
    ['delete_comment', { id: 7, revision: 4, noteId: 'note-1', currentPage: 3 }],
    ['create_highlight', { id: 7, revision: 4, page: 1, rect: { x: .1, y: .2, width: .3, height: .4 }, contents: null, currentPage: 3 }],
    ['create_text_highlight', { id: 7, revision: 4, page: 1, start: 2, end: 5, contents: 'selected', currentPage: 3 }],
    ['update_highlight', { id: 7, revision: 4, annotationId: 'highlight-1', contents: null, currentPage: 3 }],
    ['delete_highlight', { id: 7, revision: 4, annotationId: 'highlight-1', currentPage: 3 }],
  ]);
});
