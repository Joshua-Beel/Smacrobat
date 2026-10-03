import { expect,it } from 'vitest';
import { appendRedaction, type RedactionDraft } from './redaction';
import type { DocumentInfo } from './model';

const document:DocumentInfo={id:1,revision:2,name:'source.pdf',path:'C:/source.pdf',pages:[{width:100,height:200}],dirty:false,can_undo:false,can_redo:false};
const draft=(count=0):RedactionDraft=>({id:1,revision:2,page:0,rectangles:Array.from({length:count},()=>({x:1,y:2,width:3,height:4}))});

it('adds only finite positive in-page point rectangles against the captured revision',()=>{
  expect(appendRedaction(draft(),document,0,{x:10,y:20,width:30,height:40})?.rectangles).toHaveLength(1);
  for(const rect of [{x:-1,y:0,width:1,height:1},{x:0,y:0,width:0,height:1},{x:90,y:0,width:11,height:1},{x:0,y:190,width:1,height:11},{x:Number.NaN,y:0,width:1,height:1}]) expect(appendRedaction(draft(),document,0,rect)?.rectangles).toHaveLength(0);
  expect(appendRedaction(draft(),{...document,revision:3},0,{x:1,y:1,width:1,height:1})?.rectangles).toHaveLength(0);
  expect(appendRedaction(draft(),document,1,{x:1,y:1,width:1,height:1})?.rectangles).toHaveLength(0);
});

it('stops at exactly 256 rectangles',()=>{
  expect(appendRedaction(draft(255),document,0,{x:1,y:1,width:1,height:1})?.rectangles).toHaveLength(256);
  expect(appendRedaction(draft(256),document,0,{x:1,y:1,width:1,height:1})?.rectangles).toHaveLength(256);
});
