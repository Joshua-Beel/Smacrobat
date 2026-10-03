import type { RasterRedactionRect } from './bridge';
import type { DocumentInfo } from './model';

export type RedactionDraft = { id:number; revision:number; page:number; rectangles:RasterRedactionRect[] };

export function appendRedaction(draft:RedactionDraft|null, document:DocumentInfo|undefined, page:number, rect:RasterRedactionRect):RedactionDraft|null {
  if (!draft || !document || draft.id!==document.id || draft.revision!==document.revision || page!==draft.page || draft.rectangles.length>=256) return draft;
  const size=document.pages[draft.page];
  if (!size || ![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite) || rect.x<0 || rect.y<0 || rect.width<=0 || rect.height<=0 || rect.x+rect.width>size.width || rect.y+rect.height>size.height) return draft;
  return {...draft,rectangles:[...draft.rectangles,rect]};
}
