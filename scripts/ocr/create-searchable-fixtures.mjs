import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const GLYPHS = {
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  A:['01110','10001','10001','11111','10001','10001','10001'], B:['11110','10001','10001','11110','10001','10001','11110'],
  E:['11111','10000','10000','11110','10000','10000','11111'], F:['11111','10000','10000','11110','10000','10000','10000'],
  G:['01110','10001','10000','10111','10001','10001','01110'], H:['10001','10001','10001','11111','10001','10001','10001'],
  I:['11111','00100','00100','00100','00100','00100','11111'], L:['10000','10000','10000','10000','10000','10000','11111'],
  M:['10001','11011','10101','10101','10001','10001','10001'], N:['10001','11001','10101','10011','10001','10001','10001'],
  O:['01110','10001','10001','10001','10001','10001','01110'], P:['11110','10001','10001','11110','10000','10000','10000'],
  R:['11110','10001','10001','11110','10100','10010','10001'], T:['11111','00100','00100','00100','00100','00100','00100'],
  W:['10001','10001','10001','10101','10101','10101','01010'],
  0:['01110','10001','10011','10101','11001','10001','01110'], 1:['00100','01100','00100','00100','00100','00100','01110'],
  2:['01110','10001','00001','00010','00100','01000','11111'], 3:['11110','00001','00001','01110','00001','00001','11110'],
  4:['00010','00110','01010','10010','11111','00010','00010'], 5:['11111','10000','10000','11110','00001','00001','11110'],
  6:['01110','10000','10000','11110','10001','10001','01110'], 7:['11111','00001','00010','00100','01000','01000','01000'],
  8:['01110','10001','10001','01110','10001','10001','01110'], 9:['01110','10001','10001','01111','00001','00001','01110'],
};
const layouts = [
  { name:'single-line', width:640, height:180, words:[{text:'ALPHA',x:56,y:54,scale:10},{text:'123',x:376,y:54,scale:10}] },
  { name:'two-column', width:720, height:300, words:[{text:'LEFT',x:48,y:45,scale:7},{text:'RIGHT',x:396,y:45,scale:7},{text:'BOTTOM',x:48,y:178,scale:6},{text:'TOP',x:438,y:178,scale:6}] },
  { name:'mixed-lines', width:660, height:300, words:[{text:'ONE',x:54,y:38,scale:12},{text:'TWO',x:354,y:38,scale:12},{text:'ALPHA',x:80,y:194,scale:6},{text:'90',x:470,y:194,scale:6}] },
];

function crc32(bytes) { let crc=0xffffffff; for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);} return (crc^0xffffffff)>>>0; }
function adler32(bytes){let a=1,b=0;for(const byte of bytes){a=(a+byte)%65521;b=(b+a)%65521;}return ((b<<16)|a)>>>0;}
function u32(value){const out=Buffer.alloc(4);out.writeUInt32BE(value>>>0);return out;}
function chunk(type,data){const name=Buffer.from(type,'ascii');return Buffer.concat([u32(data.length),name,data,u32(crc32(Buffer.concat([name,data])))]);}
function storedZlib(bytes){const parts=[Buffer.from([0x78,0x01])];for(let offset=0;offset<bytes.length;){const length=Math.min(65535,bytes.length-offset),final=offset+length===bytes.length;const header=Buffer.alloc(5);header[0]=final?1:0;header.writeUInt16LE(length,1);header.writeUInt16LE((~length)&0xffff,3);parts.push(header,bytes.subarray(offset,offset+length));offset+=length;}parts.push(u32(adler32(bytes)));return Buffer.concat(parts);}
function png(width,height,rgb){const scan=Buffer.alloc(height*(1+width*3));for(let y=0;y<height;y++){const target=y*(1+width*3);scan[target]=0;rgb.copy(scan,target+1,y*width*3,(y+1)*width*3);}const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',storedZlib(scan)),chunk('IEND',Buffer.alloc(0))]);}
function render(layout){const rgb=Buffer.alloc(layout.width*layout.height*3,255);for(const word of layout.words){if(!/^[A-Z0-9]+$/.test(word.text))throw new Error(`Unsupported fixture text: ${word.text}`);let cursor=word.x;for(const char of word.text){const glyph=GLYPHS[char];if(!glyph)throw new Error(`Unsupported glyph: ${char}`);for(let row=0;row<7;row++)for(let col=0;col<5;col++)if(glyph[row][col]==='1')for(let dy=0;dy<word.scale;dy++)for(let dx=0;dx<word.scale;dx++){const x=cursor+col*word.scale+dx,y=word.y+row*word.scale+dy,at=(y*layout.width+x)*3;rgb[at]=rgb[at+1]=rgb[at+2]=0;}cursor+=6*word.scale;}word.width=word.text.length*6*word.scale-word.scale;word.height=7*word.scale;}return rgb;}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
function tsv(layout){const rows=['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',`1\t1\t0\t0\t0\t0\t0\t0\t${layout.width}\t${layout.height}\t-1\t`];const lines=[...new Set(layout.words.map(word=>word.y))].sort((a,b)=>a-b);for(let block=0;block<lines.length;block++){const words=layout.words.filter(word=>word.y===lines[block]).sort((a,b)=>a.x-b.x),left=Math.min(...words.map(word=>word.x)),top=Math.min(...words.map(word=>word.y)),right=Math.max(...words.map(word=>word.x+word.width)),bottom=Math.max(...words.map(word=>word.y+word.height)),box=`${left}\t${top}\t${right-left}\t${bottom-top}`;rows.push(`2\t1\t${block+1}\t0\t0\t0\t${box}\t-1\t`,`3\t1\t${block+1}\t1\t0\t0\t${box}\t-1\t`,`4\t1\t${block+1}\t1\t1\t0\t${box}\t-1\t`);for(let word=0;word<words.length;word++){const item=words[word];rows.push(`5\t1\t${block+1}\t1\t1\t${word+1}\t${item.x}\t${item.y}\t${item.width}\t${item.height}\t95\t${item.text}`);}}return `${rows.join('\n')}\n`;}
export function buildFixtures(){return layouts.map(source=>{const layout=structuredClone(source),rgb=render(layout),encoded=png(layout.width,layout.height,rgb),hierarchy=tsv(layout);return {name:layout.name,png:encoded,oracle:{name:layout.name,dpi:150,width:layout.width,height:layout.height,rawRgbBytes:rgb.length,rawRgbSha256:sha(rgb),pngBytes:encoded.length,pngSha256:sha(encoded),text:layout.words.map(word=>word.text).join(' '),tsv:hierarchy,tsvBytes:Buffer.byteLength(hierarchy),tsvSha256:sha(Buffer.from(hierarchy)),pointScale:{numerator:12,denominator:25},words:layout.words.map(({text,x,y,width,height})=>({text,pixels:{x,y,width,height},pointNumerators:{x:x*12,y:y*12,width:width*12,height:height*12}}))}};});}
export async function writeFixtures(root){const output=resolve(root);await mkdir(output,{recursive:true});const fixtures=buildFixtures();for(const fixture of fixtures)await writeFile(join(output,`${fixture.name}.png`),fixture.png);const oracle={schemaVersion:1,scope:'Deterministic synthetic ASCII raster geometry only; no OCR accuracy or real-scan claim.',fixtures:fixtures.map(item=>item.oracle)};await writeFile(join(output,'oracle.json'),`${JSON.stringify(oracle,null,2)}\n`,'utf8');return oracle;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const here=dirname(fileURLToPath(import.meta.url));await writeFixtures(resolve(here,'../../src-tauri/tests/fixtures/searchable-ocr'));}
