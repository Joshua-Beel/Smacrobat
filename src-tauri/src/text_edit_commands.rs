use serde::Serialize;
use std::sync::{atomic::{AtomicU64,Ordering},Mutex};

#[derive(Clone,Debug,PartialEq,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct TextReplacementBounds { pub(crate) x:f32,pub(crate) y:f32,pub(crate) width:f32,pub(crate) height:f32 }

#[derive(Clone,Debug,PartialEq,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct TextReplacementTarget {
    pub(crate) selection_id:String,pub(crate) document_id:u64,pub(crate) revision:u64,pub(crate) page:u16,
    pub(crate) run_id:&'static str,pub(crate) text:String,pub(crate) bounds:TextReplacementBounds,
    pub(crate) max_bytes:usize,pub(crate) mode:&'static str,
}

struct Active { target:TextReplacementTarget,in_flight:bool }
#[derive(Default)] pub(crate) struct TextReplacementSelections { next:AtomicU64,active:Mutex<Option<Active>> }
pub(crate) struct TextReplacementAttempt<'a>{owner:&'a TextReplacementSelections,id:String,settled:bool}

impl TextReplacementSelections {
    pub(crate) fn register(&self,document_id:u64,revision:u64,page:u16,text:String,bounds:TextReplacementBounds)->Result<TextReplacementTarget,String>{
        let mut active=self.active.lock().map_err(|_|"Text replacement state is unavailable.")?;
        if active.is_some(){return Err("Finish or cancel the current text replacement first.".into())}
        let target=TextReplacementTarget{selection_id:format!("text-replacement-{}",self.next.fetch_add(1,Ordering::Relaxed)+1),document_id,revision,page,run_id:"run-0",max_bytes:text.len(),text,bounds,mode:"newCopy"};
        *active=Some(Active{target:target.clone(),in_flight:false});Ok(target)
    }
    pub(crate) fn begin<'a>(&'a self,id:&str,document_id:u64,revision:u64)->Result<(TextReplacementTarget,TextReplacementAttempt<'a>),String>{let mut active=self.active.lock().map_err(|_|"Text replacement state is unavailable.")?;let entry=active.as_mut().filter(|v|v.target.selection_id==id).ok_or("The text replacement selection is unavailable.")?;if entry.target.document_id!=document_id||entry.target.revision!=revision{return Err("The text replacement selection does not match the document revision.".into())}if entry.in_flight{return Err("This text replacement is already running.".into())}entry.in_flight=true;Ok((entry.target.clone(),TextReplacementAttempt{owner:self,id:id.into(),settled:false}))}
    pub(crate) fn cancel(&self,id:&str)->Result<(),String>{let mut active=self.active.lock().map_err(|_|"Text replacement state is unavailable.")?;if active.as_ref().is_some_and(|v|v.target.selection_id==id){if active.as_ref().is_some_and(|v|v.in_flight){return Err("The text replacement is currently running.".into())}*active=None}Ok(())}
    fn finish(&self,id:&str,success:bool)->Result<(),String>{let mut active=self.active.lock().map_err(|_|"Text replacement state is unavailable.")?;let entry=active.as_mut().filter(|v|v.target.selection_id==id).ok_or("The text replacement selection is unavailable.")?;if success{*active=None}else{entry.in_flight=false}Ok(())}
}
impl TextReplacementAttempt<'_>{pub(crate) fn commit_success(mut self)->Result<(),String>{self.owner.finish(&self.id,true)?;self.settled=true;Ok(())}}
impl Drop for TextReplacementAttempt<'_>{fn drop(&mut self){if !self.settled{let _=self.owner.finish(&self.id,false);}}}

#[cfg(test)]mod tests{use super::*;#[test]fn stale_busy_retry_cancel_and_success_are_exact(){let s=TextReplacementSelections::default();let t=s.register(2,3,0,"123".into(),TextReplacementBounds{x:0.1,y:0.2,width:0.3,height:0.1}).unwrap();assert!(s.begin(&t.selection_id,2,4).is_err());let(_,a)=s.begin(&t.selection_id,2,3).unwrap();assert!(s.begin(&t.selection_id,2,3).is_err());drop(a);let(_,a)=s.begin(&t.selection_id,2,3).unwrap();a.commit_success().unwrap();assert!(s.begin(&t.selection_id,2,3).is_err());s.cancel(&t.selection_id).unwrap();}}
