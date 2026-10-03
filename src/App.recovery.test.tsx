import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { checkpointRecovery, closeDocument, keepRecoveredEdits, openDocument, openOriginal, restoreRecovery, saveCopy } from './bridge';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({
  native: false,
  openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), cancelPasswordRequest: vi.fn(),
  checkpointRecovery: vi.fn(), restoreRecovery: vi.fn(), keepRecoveredEdits: vi.fn(), openOriginal: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(),
  createPdfFromImage: vi.fn(), documentPageLabels: vi.fn(),
}));
vi.mock('./Viewer', () => ({ default: ({ document, onPage }: { document: DocumentInfo; onPage: (page: number) => void }) => <div data-viewed-document={document.id}><button onClick={() => onPage(1)}>Go to page 2</button>{document.name}</div> }));

const source: DocumentInfo = { id: 7, name: 'source.pdf', path: 'C:/docs/source.pdf', pages: [{ width: 612, height: 792 }, { width: 612, height: 792 }], revision: 4, dirty: true, can_undo: true, can_redo: false };
const cleanSource: DocumentInfo = { ...source, revision: 0, dirty: false, can_undo: false };
const recovered: DocumentInfo = { ...source, id: 8, revision: 4, dirty: true };
let ui: ReactTestRenderer;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: source });
  vi.mocked(closeDocument).mockResolvedValue();
  vi.mocked(saveCopy).mockResolvedValue(null);
});
afterEach(() => { if (ui) act(() => ui.unmount()); vi.unstubAllGlobals(); });

const button = (label: string) => ui.root.findAllByType('button').find(item => item.children.join('') === label)!;
const action = (label: string) => ui.root.findAllByType('button').find(item => item.props['aria-label'] === label)!;
const openButton = () => ui.root.findAllByType('button').find(item => item.children.includes('Open a file'))!;
async function mount(openSource = true) {
  await act(async () => { ui = create(<App />); });
  if (openSource) await act(async () => button('Open a file').props.onClick());
  act(() => ui.root.findByProps({ 'aria-expanded': false }).props.onClick());
}

it('creates a manual checkpoint for the exact dirty revision and current page', async () => {
  vi.mocked(checkpointRecovery).mockResolvedValue({ documentId: 7, revision: 4, currentPage: 1 });
  await mount();
  act(() => button('Go to page 2').props.onClick());
  await act(async () => button('Create manual recovery point').props.onClick());
  expect(checkpointRecovery).toHaveBeenCalledExactlyOnceWith(7, 4, 1);
  expect(JSON.stringify(ui.toJSON())).toContain('Recovery is manual, not automatic');
  expect(JSON.stringify(ui.toJSON())).toContain('power-loss durability is not proven');
});

it('refuses clean sessions and rejects a mismatched checkpoint acknowledgement', async () => {
  vi.mocked(openDocument).mockResolvedValueOnce({ status: 'opened', document: { ...source, dirty: false } });
  await mount();
  expect(button('Create manual recovery point').props.disabled).toBe(true);
  act(() => ui.unmount());

  vi.mocked(openDocument).mockResolvedValueOnce({ status: 'opened', document: source });
  vi.mocked(checkpointRecovery).mockResolvedValue({ documentId: 7, revision: 3, currentPage: 0 });
  await mount();
  await act(async () => button('Create manual recovery point').props.onClick());
  expect(JSON.stringify(ui.toJSON())).toContain('acknowledgement did not match this document revision');
  expect(JSON.stringify(ui.toJSON())).not.toContain('Recovery point saved');
});

it('closes and guides reopening after an equal-revision checkpoint was committed but not confirmed', async () => {
  vi.mocked(checkpointRecovery).mockRejectedValue({ code: 'recoveryCommittedReopenRequired', documentId: 7, requestedRevision: 4, committedRevision: 4 });
  await mount();
  await act(async () => button('Create manual recovery point').props.onClick());
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(7);
  expect(ui.root.findAllByProps({ 'data-viewed-document': 7 })).toHaveLength(0);
  expect(JSON.stringify(ui.toJSON())).toContain('edit may be saved in recovery');
  expect(JSON.stringify(ui.toJSON())).toContain('Reopen this PDF');
});

it('keeps the workspace unchanged when the native restore picker is cancelled', async () => {
  vi.mocked(restoreRecovery).mockResolvedValue(null);
  await mount();
  await act(async () => button('Restore manual recovery point').props.onClick());
  expect(restoreRecovery).toHaveBeenCalledTimes(1);
  expect(ui.root.findAllByProps({ 'data-viewed-document': 7 })).toHaveLength(1);
  expect(ui.root.findAllByProps({ 'data-viewed-document': 8 })).toHaveLength(0);
});

it('opens a recovered dirty session at its recorded page and preserves the source file claim', async () => {
  vi.mocked(restoreRecovery).mockResolvedValue({ document: recovered, currentPage: 1 });
  await mount(false);
  await act(async () => button('Restore manual recovery point').props.onClick());
  expect(ui.root.findAllByProps({ 'data-viewed-document': 8 })).toHaveLength(1);
  expect(ui.root.findByProps({ 'aria-label': 'Page number' }).props.defaultValue).toBe(2);
  expect(JSON.stringify(ui.toJSON())).toContain('The source file was not changed');
});

it('blocks conflicting open, save, and close actions while the native restore picker is active', async () => {
  let finish!: (value: null) => void;
  vi.mocked(restoreRecovery).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  const openControl = openButton();
  act(() => button('Restore manual recovery point').props.onClick());
  expect(openControl.props.disabled).toBe(true);
  expect(action('Save a copy').props.disabled).toBe(true);
  expect(action('Close source.pdf').props.disabled).toBe(true);
  await act(async () => finish(null));
  expect(openControl.props.disabled).toBe(false);
});

it('rejects incoherent restore output without opening it', async () => {
  vi.mocked(restoreRecovery).mockResolvedValue({ document: { ...recovered, dirty: false }, currentPage: 1 });
  await mount(false);
  await act(async () => button('Restore manual recovery point').props.onClick());
  expect(ui.root.findAllByProps({ 'data-viewed-document': 8 })).toHaveLength(0);
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(8);
  expect(JSON.stringify(ui.toJSON())).toContain('invalid edited document');
});

it('closes a recovered native session whose reply arrives after unmount', async () => {
  let finish!: (value: { document: DocumentInfo; currentPage: number }) => void;
  vi.mocked(restoreRecovery).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount(false);
  act(() => button('Restore manual recovery point').props.onClick());
  act(() => ui.unmount());
  await act(async () => finish({ document: recovered, currentPage: 1 }));
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(8);
});

it('keeps an automatic recovery offer explicit until the recovered revision is accepted', async () => {
  vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: cleanSource, recovery: { revision: 4, currentPage: 1 } });
  vi.mocked(keepRecoveredEdits).mockResolvedValue({ document: source, currentPage: 1 });
  await mount();
  expect(ui.root.findAllByProps({ 'data-viewed-document': 7 })).toHaveLength(1);
  expect(JSON.stringify(ui.toJSON())).toContain('Recovered edits are available');
  expect(ui.root.findByProps({ 'aria-label': 'Page number' }).props.defaultValue).toBe(1);
  await act(async () => button('Keep recovered edits').props.onClick());
  expect(keepRecoveredEdits).toHaveBeenCalledExactlyOnceWith(7, 0);
  expect(ui.root.findByProps({ 'aria-label': 'Page number' }).props.defaultValue).toBe(2);
  expect(JSON.stringify(ui.toJSON())).toContain('source PDF was not changed');
  expect(JSON.stringify(ui.toJSON())).not.toContain('Recovered edits are available');
});

it('opens the original only through the explicit recovery choice', async () => {
  vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: cleanSource, recovery: { revision: 4, currentPage: 1 } });
  vi.mocked(openOriginal).mockResolvedValue(cleanSource);
  await mount();
  await act(async () => button('Open original').props.onClick());
  expect(openOriginal).toHaveBeenCalledExactlyOnceWith(7, 0);
  expect(keepRecoveredEdits).not.toHaveBeenCalled();
  expect(JSON.stringify(ui.toJSON())).toContain('marked the offered recovery edits as discarded');
  expect(JSON.stringify(ui.toJSON())).not.toContain('Recovered edits are available');
});

it('closes and guides reopening after an equal-revision open-original tombstone was committed but not confirmed', async () => {
  vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: cleanSource, recovery: { revision: 4, currentPage: 1 } });
  vi.mocked(openOriginal).mockRejectedValue({ code: 'recoveryCommittedReopenRequired', documentId: 7, requestedRevision: 0, committedRevision: 0 });
  await mount();
  await act(async () => button('Open original').props.onClick());
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(7);
  expect(ui.root.findAllByProps({ 'data-viewed-document': 7 })).toHaveLength(0);
  expect(JSON.stringify(ui.toJSON())).not.toContain('Recovered edits are available');
  expect(JSON.stringify(ui.toJSON())).toContain('edit may be saved in recovery');
  expect(JSON.stringify(ui.toJSON())).toContain('Reopen this PDF');
});

it('retains the recovery choice and clean session when a choice fails', async () => {
  vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: cleanSource, recovery: { revision: 4, currentPage: 1 } });
  vi.mocked(keepRecoveredEdits).mockRejectedValue(new Error('journal unavailable'));
  await mount();
  await act(async () => button('Keep recovered edits').props.onClick());
  expect(JSON.stringify(ui.toJSON())).toContain('journal unavailable');
  expect(JSON.stringify(ui.toJSON())).toContain('Recovered edits are available');
  expect(ui.root.findByProps({ 'aria-label': 'Page number' }).props.defaultValue).toBe(1);
  expect(openOriginal).not.toHaveBeenCalled();
});

it('rejects an incoherent automatic recovery offer and closes its native session', async () => {
  vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: cleanSource, recovery: { revision: 4, currentPage: 2 } });
  await mount();
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(7);
  expect(ui.root.findAllByProps({ 'data-viewed-document': 7 })).toHaveLength(0);
  expect(JSON.stringify(ui.toJSON())).toContain('Recovery offered invalid state');
});
