import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { editPages, openDocument, saveCopy } from './bridge';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), documentPageLabels: vi.fn() }));
vi.mock('./Viewer', () => ({ default: () => <div>Rendered document</div> }));

const document: DocumentInfo = { id: 9, name: 'one.pdf', path: 'C:/docs/one.pdf', pages: [{ width: 612, height: 792 }], revision: 0, dirty: false, can_undo: true, can_redo: false };
let keydown: (event: KeyboardEvent) => void;
let ui: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn() },
    addEventListener: (name: string, callback: typeof keydown) => { if (name === 'keydown') keydown = callback; },
    removeEventListener: vi.fn(),
  });
  vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document });
  vi.mocked(editPages).mockResolvedValue(document);
  vi.mocked(saveCopy).mockResolvedValue(null);
});

afterEach(() => { if (ui) act(() => ui!.unmount()); ui = undefined; vi.unstubAllGlobals(); });

it.each(['o', 's', 'z'])('ignores Ctrl+%s from a dialog button but retains the workspace shortcut', async key => {
  await act(async () => { ui = create(<App />); });
  await act(async () => ui!.root.findAllByType('button').find(button => button.children.includes('Explore a sample PDF '))!.props.onClick());
  vi.mocked(openDocument).mockClear();
  vi.mocked(openDocument).mockResolvedValue(null);
  const send = async (inDialog: boolean) => {
    const target = { closest: (selector: string) => selector === 'dialog' && inDialog ? {} : null, matches: () => false };
    await act(async () => keydown({ key, ctrlKey: true, target, preventDefault: vi.fn() } as unknown as KeyboardEvent));
  };
  await send(true);
  expect(openDocument).not.toHaveBeenCalled();
  expect(saveCopy).not.toHaveBeenCalled();
  expect(editPages).not.toHaveBeenCalled();
  await send(false);
  expect(key === 'o' ? openDocument : key === 's' ? saveCopy : editPages).toHaveBeenCalledOnce();
});
