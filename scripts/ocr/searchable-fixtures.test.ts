import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildFixtures } from './create-searchable-fixtures.mjs';

const root=resolve('src-tauri/tests/fixtures/searchable-ocr');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunks(png:Buffer){expect([...png.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);const found:{type:string,data:Buffer}[]=[];let at=8;for(;at<png.length;){const length=png.readUInt32BE(at),name=png.subarray(at+4,at+8),type=name.toString('ascii'),data=png.subarray(at+8,at+8+length),stored=png.readUInt32BE(at+8+length);expect(stored).toBe(crc32(Buffer.concat([name,data])));found.push({type,data});at+=12+length;}expect(at).toBe(png.length);return found;}

describe('searchable OCR synthetic fixtures',()=>{
  it('regenerates exact RGB8 PNG bytes and the complete oracle',async()=>{
    const built=buildFixtures();const committed=JSON.parse(await readFile(resolve(root,'oracle.json'),'utf8'));
    expect(committed.scope).toContain('no OCR accuracy');
    expect(committed.fixtures).toEqual(built.map(item=>item.oracle));
    for(const fixture of built){const bytes=await readFile(resolve(root,`${fixture.name}.png`));expect(bytes.equals(fixture.png)).toBe(true);expect(bytes.length).toBe(fixture.oracle.pngBytes);expect(sha(bytes)).toBe(fixture.oracle.pngSha256);}
  });
  it('contains only structurally valid IHDR, IDAT, and IEND chunks with exact raw RGB',()=>{
    for(const fixture of buildFixtures()){const parsed=chunks(fixture.png);expect(parsed.map(item=>item.type)).toEqual(['IHDR','IDAT','IEND']);const header=parsed[0].data;expect(header.length).toBe(13);expect(header.readUInt32BE(0)).toBe(fixture.oracle.width);expect(header.readUInt32BE(4)).toBe(fixture.oracle.height);expect([...header.subarray(8)]).toEqual([8,2,0,0,0]);const scan=inflateSync(parsed[1].data),stride=fixture.oracle.width*3+1;expect(scan.length).toBe(stride*fixture.oracle.height);const rgb=Buffer.alloc(fixture.oracle.rawRgbBytes);for(let y=0;y<fixture.oracle.height;y++){expect(scan[y*stride]).toBe(0);scan.copy(rgb,y*fixture.oracle.width*3,y*stride+1,(y+1)*stride);}expect(sha(rgb)).toBe(fixture.oracle.rawRgbSha256);expect(parsed[2].data.length).toBe(0);}
  });
  it('binds positive in-bounds nonoverlapping boxes and exact 72/150 point ratios',()=>{
    for(const fixture of buildFixtures()){expect(Buffer.byteLength(fixture.oracle.tsv)).toBe(fixture.oracle.tsvBytes);expect(sha(Buffer.from(fixture.oracle.tsv))).toBe(fixture.oracle.tsvSha256);expect(fixture.oracle.tsv.split('\n')[0]).toContain('block_num\tpar_num\tline_num\tword_num');expect(fixture.oracle.tsv.split('\n').filter(row=>row.startsWith('5\t')).map(row=>row.split('\t').at(-1)).join(' ')).toBe(fixture.oracle.text);for(let index=0;index<fixture.oracle.words.length;index++){const word=fixture.oracle.words[index],box=word.pixels;expect(word.text).toMatch(/^[A-Z0-9]+$/);expect(box.width).toBeGreaterThan(0);expect(box.height).toBeGreaterThan(0);expect(box.x+box.width).toBeLessThanOrEqual(fixture.oracle.width);expect(box.y+box.height).toBeLessThanOrEqual(fixture.oracle.height);expect(word.pointNumerators).toEqual({x:box.x*12,y:box.y*12,width:box.width*12,height:box.height*12});for(const other of fixture.oracle.words.slice(index+1)){const b=other.pixels;expect(box.x+box.width<=b.x||b.x+b.width<=box.x||box.y+box.height<=b.y||b.y+b.height<=box.y).toBe(true);}}}
  });
});
