import type{SavedCopy,TextReplacementTarget}from'./bridge';
export type ReplacePdfTextCopy=(target:TextReplacementTarget,replacement:string)=>Promise<SavedCopy|null>;
export type CancelTextReplacement=(selectionId:string)=>Promise<void>;
export function validateTextReplacementTarget(value:unknown):string|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return'Text replacement target does not match the supported strict profile.';
 const target=value as Partial<TextReplacementTarget>,bounds=target.bounds as Partial<TextReplacementTarget['bounds']>|undefined;
 if(typeof target.selectionId!=='string'||!target.selectionId.trim()||!Number.isSafeInteger(target.documentId)||Number(target.documentId)<0||!Number.isSafeInteger(target.revision)||Number(target.revision)<0||!Number.isSafeInteger(target.page)||Number(target.page)<0||target.runId!=='run-0')return'Text replacement requires an exact document revision and opaque selection.';
 if(typeof target.text!=='string'||!/^[\x20-\x7e]*$/.test(target.text)||!Number.isSafeInteger(target.maxBytes)||Number(target.maxBytes)<1||Number(target.maxBytes)>4096||new TextEncoder().encode(target.text).length!==target.maxBytes)return'Text replacement requires the exact printable-ASCII source run.';
 if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(value=>typeof value==='number'&&Number.isFinite(value))||Number(bounds.x)<0||Number(bounds.y)<0||Number(bounds.width)<=0||Number(bounds.height)<=0||!Number.isFinite(Number(bounds.x)+Number(bounds.width))||!Number.isFinite(Number(bounds.y)+Number(bounds.height))||Number(bounds.x)+Number(bounds.width)>1||Number(bounds.y)+Number(bounds.height)>1||target.mode!=='newCopy')return'Text replacement target does not match the supported strict profile.';
 return null;
}
export function validateTextReplacement(value:string,maxBytes:number):string|null{
 if(!/^[\x20-\x7e]*$/.test(value))return'Replacement text must use printable ASCII only.';
 if(new TextEncoder().encode(value).length!==maxBytes)return`Replacement text must contain exactly ${maxBytes} ASCII bytes.`;
 return null;
}
