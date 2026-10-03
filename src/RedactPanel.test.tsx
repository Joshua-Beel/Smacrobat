import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import RedactPanel from './RedactPanel';

it('states destructive raster limits and manages exact rectangle actions', () => {
  const remove=vi.fn(), clear=vi.fn(), apply=vi.fn(), close=vi.fn(); let ui!:ReactTestRenderer;
  act(() => { ui=create(<RedactPanel page={1} rectangles={[{x:10,y:20,width:30,height:40}]} busy={false} remove={remove} clear={clear} apply={apply} close={close}/>); });
  const text=JSON.stringify(ui.toJSON());
  expect(ui.root.findByType('h2').children.join('')).toBe('Redact page 2'); expect(text).toContain('150 DPI'); expect(text).toContain('rasterizes every page'); expect(text).toContain('searchable text'); expect(text).toContain('source PDF stays unchanged');
  act(() => ui.root.findAllByType('button').find(button => button.children.join('')==='Remove')!.props.onClick());
  act(() => ui.root.findAllByType('button').find(button => button.children.join('')==='Clear')!.props.onClick());
  act(() => ui.root.findAllByType('button').find(button => button.children.join('')==='Create redacted copy…')!.props.onClick());
  act(() => ui.root.findByProps({'aria-label':'Close redaction'}).props.onClick());
  expect(remove).toHaveBeenCalledWith(0); expect(clear).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it('disables mutation while busy or empty', () => {
  let ui!:ReactTestRenderer;
  act(() => { ui=create(<RedactPanel page={0} rectangles={[]} busy={false} remove={vi.fn()} clear={vi.fn()} apply={vi.fn()} close={vi.fn()}/>); });
  expect(ui.root.findAllByType('button').find(button => button.children.join('')==='Create redacted copy…')!.props.disabled).toBe(true);
  act(() => { ui.update(<RedactPanel page={0} rectangles={[{x:1,y:1,width:2,height:2}]} busy remove={vi.fn()} clear={vi.fn()} apply={vi.fn()} close={vi.fn()}/>); });
  expect(ui.root.findAllByType('button').every(button => button.props.disabled)).toBe(true);
});
