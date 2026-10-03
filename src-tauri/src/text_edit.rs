use std::collections::{BTreeMap, BTreeSet};
use lopdf::{content::{Content, Operation}, Dictionary, Document, Object, ObjectId};

pub const MAX_TEXT_EDIT_INPUT: usize = 256 * 1024 * 1024;
pub const MAX_TEXT_EDIT_OUTPUT: usize = 256 * 1024 * 1024;
pub const MAX_TEXT_EDIT_OBJECTS: usize = 20_000;
pub const MAX_TEXT_EDIT_PAGES: usize = 4_096;
pub const MAX_TEXT_EDIT_CONTENT: usize = 4_096;
const WIDTHS: [u16; 95] = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];

#[derive(Clone, Debug, PartialEq)]
pub struct TextEditTarget { pub text: String, pub page_width: f32, pub page_height: f32, pub font_size: f32, pub matrix: [f32; 6] }

pub fn inspect_text_run(source: &[u8], physical_page: u32) -> Result<TextEditTarget, String> {
    let (_, profile) = load(source)?;
    profile.pages.get(page_index(physical_page)?).map(|p| p.info.clone()).ok_or_else(|| "text-edit page is outside the document".into())
}

pub fn replace_text_run(source: &[u8], physical_page: u32, replacement: &str) -> Result<Vec<u8>, String> {
    let (mut document, profile) = load(source)?;
    let target = profile.pages.get(page_index(physical_page)?).ok_or("text-edit page is outside the document")?.clone();
    ascii(replacement)?;
    if replacement.len() != target.info.text.len() { return Err("replacement must have the same encoded byte count".into()); }
    if advance(replacement.as_bytes()) != advance(target.info.text.as_bytes()) { return Err("replacement must have the same exact Helvetica advance".into()); }
    let original = document.objects.clone();
    let stream = document.get_object_mut(target.content_id).and_then(Object::as_stream_mut).map_err(|_| "text-edit content disappeared")?;
    let mut content = Content::decode(&stream.content).map_err(|_| "text-edit content is malformed")?;
    content.operations[3] = Operation::new("Tj", vec![Object::string_literal(replacement.as_bytes())]);
    stream.set_content(content.encode().map_err(|_| "text-edit content cannot be encoded")?);
    let expected = stream.clone();
    let output = canonical_bytes(&document)?;
    if output.len() > MAX_TEXT_EDIT_OUTPUT { return Err("text-edit output exceeds its limit".into()); }
    let (reopened, after) = load(&output)?;
    if after.pages.len() != profile.pages.len() || after.pages[page_index(physical_page)?].info.text != replacement { return Err("text-edit output target changed unexpectedly".into()); }
    for (id, before) in &original {
        if profile.xref_ids.contains(id) { continue; }
        let actual = reopened.objects.get(id).ok_or("text-edit output removed an object")?;
        if *id == target.content_id { if actual != &Object::Stream(expected.clone()) { return Err("text-edit output changed unsupported content fields".into()); } }
        else if actual != before { return Err("text-edit output changed a non-target object".into()); }
    }
    if reopened.objects.len().saturating_sub(after.xref_ids.len()) != original.len().saturating_sub(profile.xref_ids.len()) { return Err("text-edit output changed the object set".into()); }
    Ok(output)
}

#[derive(Clone)] struct Page { content_id: ObjectId, info: TextEditTarget }
struct Profile { pages: Vec<Page>, xref_ids: BTreeSet<ObjectId> }

fn load(source: &[u8]) -> Result<(Document, Profile), String> {
    if source.len() > MAX_TEXT_EDIT_INPUT { return Err("text-edit source exceeds its limit".into()); }
    exact_eof(source)?;
    let document = Document::load_mem(source).map_err(|e| format!("text-edit source is malformed: {e}"))?;
    let profile = validate(&document)?;
    if canonical_bytes(&document)? != source { return Err("text-edit source is not the exact canonical serialized profile".into()); }
    Ok((document, profile))
}

fn validate(document: &Document) -> Result<Profile, String> {
    if document.is_encrypted() || document.objects.len() > MAX_TEXT_EDIT_OBJECTS { return Err("text-edit source is protected or exceeds its object limit".into()); }
    match document.trailer.len() {
        2 => keys(&document.trailer, &[b"Root", b"Size"])? ,
        3 => { keys(&document.trailer, &[b"Root", b"Type", b"Size"])?; name(&document.trailer,b"Type",b"XRef")?; }
        _ => return Err("text-edit trailer has unsupported fields".into()),
    }
    let root = document.trailer.get(b"Root").and_then(Object::as_reference).map_err(|_| "text-edit root is invalid")?;
    let catalog = document.get_dictionary(root).map_err(|_| "text-edit catalog is invalid")?; keys(catalog, &[b"Type", b"Pages"])?; name(catalog,b"Type",b"Catalog")?;
    let pages_id = catalog.get(b"Pages").and_then(Object::as_reference).map_err(|_| "text-edit page tree is invalid")?;
    let tree = document.get_dictionary(pages_id).map_err(|_| "text-edit page tree is invalid")?; keys(tree,&[b"Type",b"Count",b"Kids"])?; name(tree,b"Type",b"Pages")?;
    let kids = tree.get(b"Kids").and_then(Object::as_array).map_err(|_| "text-edit page children are invalid")?;
    if kids.is_empty() || kids.len() > MAX_TEXT_EDIT_PAGES || tree.get(b"Count").and_then(Object::as_i64).ok() != Some(kids.len() as i64) { return Err("text-edit page count is invalid".into()); }
    let mut counts=BTreeMap::new(); count_refs(&document.trailer.clone().into(),&mut counts); for object in document.objects.values(){count_refs(object,&mut counts)}
    let mut reached=BTreeSet::from([root,pages_id]); let mut result=Vec::new();
    for kid in kids {
        let page_id=kid.as_reference().map_err(|_|"text-edit page must be indirect")?; if !reached.insert(page_id){return Err("text-edit page is aliased".into())}
        let page=document.get_dictionary(page_id).map_err(|_|"text-edit page is invalid")?; keys(page,&[b"Type",b"Parent",b"MediaBox",b"Resources",b"Contents"])?; name(page,b"Type",b"Page")?;
        if page.get(b"Parent").and_then(Object::as_reference).ok()!=Some(pages_id){return Err("text-edit page tree is not flat".into())}
        let (w,h)=media(page.get(b"MediaBox").map_err(|_|"text-edit MediaBox is missing")?)?;
        let resources=page.get(b"Resources").and_then(Object::as_dict).map_err(|_|"text-edit resources must be direct")?; keys(resources,&[b"Font"])?;
        let fonts=resources.get(b"Font").and_then(Object::as_dict).map_err(|_|"text-edit fonts must be direct")?; if fonts.len()!=1{return Err("text-edit requires one font".into())}
        let (font_name,font_obj)=fonts.iter().next().unwrap(); let font_id=font_obj.as_reference().map_err(|_|"text-edit font must be indirect")?;
        if counts.get(&font_id).copied()!=Some(1)||!reached.insert(font_id){return Err("text-edit font is shared or aliased".into())}
        let font=document.get_dictionary(font_id).map_err(|_|"text-edit font is invalid")?; keys(font,&[b"Type",b"Subtype",b"BaseFont",b"Encoding"])?; name(font,b"Type",b"Font")?; name(font,b"Subtype",b"Type1")?; name(font,b"BaseFont",b"Helvetica")?; name(font,b"Encoding",b"WinAnsiEncoding")?;
        let content_id=page.get(b"Contents").and_then(Object::as_reference).map_err(|_|"text-edit content must be indirect")?;
        if counts.get(&content_id).copied()!=Some(1)||!reached.insert(content_id){return Err("text-edit content is shared or aliased".into())}
        result.push(Page{content_id,info:content_info(document,content_id,font_name,w,h)?});
    }
    let xref_ids:BTreeSet<_>=document.objects.iter().filter_map(|(id,o)|(o.type_name().ok()==Some(b"XRef")).then_some(*id)).collect();
    if xref_ids.len()>1{return Err("text-edit cross-reference structure is unsupported".into())} for id in &xref_ids{crate::image_edit::validate_xref_stream(document,*id,root)?} reached.extend(xref_ids.iter().copied());
    let objects: BTreeSet<_> = document.objects.keys().copied().collect();
    if reached != objects { return Err(format!("text-edit source contains extra or unreachable objects: reached={reached:?}, objects={objects:?}")); }
    Ok(Profile{pages:result,xref_ids})
}

fn content_info(document:&Document,id:ObjectId,font:&[u8],w:f32,h:f32)->Result<TextEditTarget,String>{
    let stream=document.get_object(id).and_then(Object::as_stream).map_err(|_|"text-edit content is invalid")?;
    if stream.dict.iter().any(|(k,_)|k.as_slice()!=b"Length")||stream.content.len()>MAX_TEXT_EDIT_CONTENT{return Err("text-edit content fields or size are unsupported".into())}
    let c=Content::decode(&stream.content).map_err(|_|"text-edit content is malformed")?;
    if c.operations.len()!=5||c.operations.iter().map(|o|o.operator.as_str()).collect::<Vec<_>>()!=["BT","Tf","Tm","Tj","ET"]{return Err("text-edit requires one exact text run".into())}
    if !c.operations[0].operands.is_empty()||!c.operations[4].operands.is_empty(){return Err("text-edit text state is malformed".into())}
    let tf=&c.operations[1].operands; if tf.len()!=2||tf[0]!=Object::Name(font.to_vec()){return Err("text-edit font selection is invalid".into())} let size=number(&tf[1])?; if !(0.1..=512.0).contains(&size){return Err("text-edit font size is invalid".into())}
    let tm=&c.operations[2].operands; if tm.len()!=6{return Err("text-edit matrix is invalid".into())} let mut matrix=[0.0;6]; for(i,v)in tm.iter().enumerate(){matrix[i]=number(v)?} if matrix[..4]!=[1.0,0.0,0.0,1.0]||!matrix[4].is_finite()||!matrix[5].is_finite(){return Err("text-edit matrix is unsupported".into())}
    let shown=&c.operations[3].operands; if shown.len()!=1{return Err("text-edit string is invalid".into())} let bytes=shown[0].as_str().map_err(|_|"text-edit string must be literal bytes")?; let text=std::str::from_utf8(bytes).map_err(|_|"text-edit string is not ASCII")?; ascii(text)?;
    Ok(TextEditTarget{text:text.into(),page_width:w,page_height:h,font_size:size,matrix})
}
fn ascii(s:&str)->Result<(),String>{if s.is_empty()||!s.bytes().all(|b|(32..=126).contains(&b)){Err("text-edit text must be nonempty printable ASCII".into())}else{Ok(())}}
fn advance(b:&[u8])->u32{b.iter().map(|v|u32::from(WIDTHS[(v-32)as usize])).sum()}
fn page_index(p:u32)->Result<usize,String>{usize::try_from(p.checked_sub(1).ok_or("text-edit pages are one-based")?).map_err(|_|"text-edit page is invalid".into())}
fn media(o:&Object)->Result<(f32,f32),String>{let a=o.as_array().map_err(|_|"text-edit MediaBox is invalid")?;if a.len()!=4||number(&a[0])?!=0.0||number(&a[1])?!=0.0{return Err("text-edit MediaBox is unsupported".into())}let(w,h)=(number(&a[2])?,number(&a[3])?);if w<=0.0||h<=0.0||!w.is_finite()||!h.is_finite(){Err("text-edit MediaBox is invalid".into())}else{Ok((w,h))}}
fn keys(d:&Dictionary,k:&[&[u8]])->Result<(),String>{if d.len()!=k.len()||k.iter().any(|v|!d.has(v)){Err("text-edit object has unsupported fields".into())}else{Ok(())}}
fn name(d:&Dictionary,k:&[u8],v:&[u8])->Result<(),String>{if d.get(k).and_then(Object::as_name).ok()==Some(v){Ok(())}else{Err("text-edit object has an unsupported type".into())}}
fn number(o:&Object)->Result<f32,String>{match o{Object::Integer(v)=>Ok(*v as f32),Object::Real(v)if v.is_finite()=>Ok(*v),_=>Err("text-edit number is invalid".into())}}
fn count_refs(o:&Object,c:&mut BTreeMap<ObjectId,usize>){match o{Object::Reference(id)=>*c.entry(*id).or_default()+=1,Object::Array(a)=>a.iter().for_each(|v|count_refs(v,c)),Object::Dictionary(d)=>d.iter().for_each(|(_,v)|count_refs(v,c)),Object::Stream(s)=>s.dict.iter().for_each(|(_,v)|count_refs(v,c)),_=>{}}}
fn exact_eof(b:&[u8])->Result<(),String>{let at=b.windows(5).rposition(|v|v==b"%%EOF").ok_or("text-edit PDF has no EOF")?;if b[at+5..].iter().any(|v|!v.is_ascii_whitespace()){Err("text-edit PDF has trailing data".into())}else{Ok(())}}
fn canonical_bytes(document:&Document)->Result<Vec<u8>,String>{let mut d=document.clone();d.objects.retain(|_,o|o.type_name().ok()!=Some(b"XRef"));d.reference_table.cross_reference_type=lopdf::xref::XrefType::CrossReferenceTable;d.trailer.remove(b"Type");let mut out=Vec::new();d.save_to(&mut out).map_err(|e|format!("text-edit canonical serialization failed: {e}"))?;Ok(out)}
