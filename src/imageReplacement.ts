import type { ImageReplacementTarget,SavedCopy } from './bridge';
export type ReplacePdfImageCopy=(target:ImageReplacementTarget)=>Promise<SavedCopy|null>;
export type CancelImageReplacement=(selectionId:string)=>Promise<void>;
export function validateImageReplacementTarget(value:unknown):string|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return'Image replacement target does not match the supported strict profile.';
  const target=value as Partial<ImageReplacementTarget>;
  if(typeof target.selectionId!=='string'||!target.selectionId.trim()||!Number.isSafeInteger(target.documentId)||Number(target.documentId)<0||!Number.isSafeInteger(target.revision)||Number(target.revision)<0||!Number.isSafeInteger(target.page)||Number(target.page)<0)return'Image replacement requires an exact document revision and opaque selection.';
  if(typeof target.displayWidth!=='number'||!Number.isFinite(target.displayWidth)||target.displayWidth<=0||typeof target.displayHeight!=='number'||!Number.isFinite(target.displayHeight)||target.displayHeight<=0||!Number.isSafeInteger(target.pixelWidth)||Number(target.pixelWidth)<1||!Number.isSafeInteger(target.pixelHeight)||Number(target.pixelHeight)<1)return'Image replacement target dimensions are invalid.';
  if(target.mode!=='newCopy'||!Array.isArray(target.acceptedFormats)||target.acceptedFormats.length!==2||target.acceptedFormats[0]!=='png'||target.acceptedFormats[1]!=='jpeg')return'Image replacement target does not match the supported strict profile.';
  return null;
}
