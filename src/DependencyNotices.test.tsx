import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { dependencyNotices } from './bridge';
import DependencyNotices from './DependencyNotices';

vi.mock('./bridge', () => ({ dependencyNotices: vi.fn() }));

async function mount() {
  let ui!: ReactTestRenderer;
  await act(async () => {
    ui = create(<DependencyNotices close={vi.fn()} />, {
      createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null,
    });
  });
  return ui;
}

afterEach(() => vi.clearAllMocks());

it('keeps the default dependency notices byte-for-byte intact', async () => {
  const base = 'PDF Workstation third-party notices\npackage-a\n';
  vi.mocked(dependencyNotices).mockResolvedValue(base);
  const ui = await mount();
  const area = ui.root.findByType('textarea');
  expect(area.props.value).toBe(base);
  expect(area.props.value).not.toContain('OPTIONAL OCR ENGINE LICENSES');
  act(() => ui.unmount());
});

it('presents the verified optional OCR texts in the native order without changing base notices', async () => {
  const base = 'PDF Workstation third-party notices\npackage-a\n';
  const ocr = 'OPTIONAL OCR ENGINE LICENSES\nTesseract\nApache License\nLeptonica\nBSD 2-Clause\nEnglish fast model\nApache License\n';
  vi.mocked(dependencyNotices).mockResolvedValue(base + ocr);
  const ui = await mount();
  const value = ui.root.findByType('textarea').props.value as string;
  expect(value).toBe(base + ocr);
  expect(value.indexOf('Tesseract')).toBeLessThan(value.indexOf('Leptonica'));
  expect(value.indexOf('Leptonica')).toBeLessThan(value.indexOf('English fast model'));
  act(() => ui.unmount());
});

it('leaves base notices readable when native reports that optional OCR notices are unavailable', async () => {
  const base = 'PDF Workstation third-party notices\npackage-a\n';
  const warning = 'Optional OCR license texts could not be verified.';
  vi.mocked(dependencyNotices).mockResolvedValue(warning + base);
  const ui = await mount();
  const value = ui.root.findByType('textarea').props.value as string;
  expect(value).toBe(warning + base);
  expect(value).not.toContain('resources/ocr');
  expect(value).not.toMatch(/[a-f0-9]{64}/i);
  expect(ui.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  act(() => ui.unmount());
});
