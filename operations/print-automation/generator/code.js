// Code-node sources. All run in "Run Once for All Items" mode. No template literals inside (safe inside String.raw).
const CODE = {};

CODE.check_config = String.raw`const c=$('Config').first().json.cfg;
const bad=JSON.stringify(c).match(/REPLACE_[A-Z_]+/g);
if(bad) throw new Error('SETUP_REQUIRED: set these values in the Config node: '+[...new Set(bad)].join(', '));
return $input.all();`;

CODE.stop_if_blocked = String.raw`const n=Number(($input.first().json||{}).total||0);
if(n>0) throw new Error('PRINT_RUN_BLOCKED: '+n+' deal(s) are still Preparing from an earlier run. The monitor flags them as Needs attention after the timeout; check the printer queue, then re-run.');
return [{json:{ok:true}}];`;

CODE.select_queued = String.raw`const c=$('Config').first().json.cfg;
const seen=new Map();
for(const it of $input.all()) for(const d of (it.json.results||[])) seen.set(String(d.id),d);
const skip=new Set(c.cancelled_rejected_stages);
const deals=[...seen.values()].filter(d=>!skip.has((d.properties||{}).dealstage));
if(!deals.length) return [];
const out=[];
for(let i=0;i<deals.length;i+=100){
  const part=deals.slice(i,i+100);
  out.push({json:{inputs:part.map(d=>({id:String(d.id)})),deals:part}});
}
return out;`;

CODE.prepare_companies = String.raw`const c=$('Config').first().json.cfg;
const assoc=$input.all().flatMap(i=>i.json.results||[]);
const ids=new Set();
for(const r of assoc) for(const t of (r.to||[])) if((t.associationTypes||[]).some(a=>a.label===c.third_party_label)) ids.add(String(t.toObjectId));
const arr=[...ids]; const out=[];
for(let i=0;i<arr.length;i+=100) out.push({json:{inputs:arr.slice(i,i+100).map(id=>({id}))}});
return out.length?out:[{json:{inputs:[]}}];`;

CODE.build_packs = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const deals=$('Select queued deals').all().flatMap(i=>i.json.deals);
const assoc=$('Read Third party associations').all().flatMap(i=>i.json.results||[]);
const comps=new Map();
for(const i of $('Read destination companies').all()) for(const r of (i.json.results||[])) comps.set(String(r.id),String((r.properties||{})[c.company_destination_field]||'').trim());
const destIds=new Map();
for(const r of assoc){
  const s=new Set();
  for(const t of (r.to||[])) if((t.associationTypes||[]).some(a=>a.label===c.third_party_label)) s.add(String(t.toObjectId));
  destIds.set(String(r.from.id),[...s]);
}
const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
const batch_id='PRINT-'+parts.year+parts.month+parts.day+'-'+parts.hour+parts.minute;
const allowance=$('Daily allowance').first().json.allowance;
const qt=d=>{ const t=(d.properties||{})[F.queued_at]; const n=/^\d+$/.test(String(t))?Number(t):Date.parse(t); return isNaN(n)?Infinity:n; };
deals.sort((a,b)=>qt(a)-qt(b));
const updates=[]; const valid=[];
for(const d of deals){
  const p=d.properties||{}; const id=String(d.id);
  const mediref=String(p[F.case_ref]||'').trim();
  const type=c.report_types[String(p[F.report_type]||'').trim()];
  const dests=[...new Set((destIds.get(id)||[]).map(x=>comps.get(x)).filter(Boolean))];
  let bad='';
  if(!/^\d+$/.test(mediref)) bad='Case reference missing or not numeric';
  else if(!type) bad='Report type not recognised';
  else if(dests.length!==1) bad='Exactly one Third party company with a destination is required (found '+dests.length+')';
  if(bad){ const pr={}; pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='Not queued for printing: '+bad+'.'; updates.push({id,properties:pr}); }
  else if(valid.length<allowance) valid.push({deal_id:id,mediref,report_type:type,destination:dests[0]});
}
const groups=new Map();
for(const k of valid){ if(!groups.has(k.destination)) groups.set(k.destination,[]); groups.get(k.destination).push(k); }
const packs=[]; let n=0;
for(const [destination,items] of [...groups].sort((a,b)=>a[0].localeCompare(b[0]))){
  items.sort((a,b)=>a.mediref.localeCompare(b.mediref));
  for(let i=0;i<items.length;i+=c.max_reports_per_pack){
    n++; const submission_ref=batch_id+'-P'+String(n).padStart(2,'0');
    const cases=items.slice(i,i+c.max_reports_per_pack);
    packs.push({batch_id,destination,submission_ref,cases});
    for(const k of cases){ const pr={}; pr[F.status]=V.preparing; pr[F.hold]='true'; pr[F.batch]=batch_id; pr[F.job_ref]=submission_ref; pr[F.destination]=destination; pr[F.issue]=''; pr[F.submitted_at]=''; pr[F.completed_at]=''; updates.push({id:k.deal_id,properties:pr}); }
  }
}
const out=[];
for(let i=0;i<updates.length;i+=100) out.push({json:{inputs:updates.slice(i,i+100),packs}});
return out;`;

CODE.list_packs = String.raw`for(const i of $input.all()){
  const j=i.json||{};
  if(j.status==='error'||(j.errors&&j.errors.length)) throw new Error('CLAIM_FAILED: HubSpot did not accept every claim. Run stopped before printing; stuck Preparing deals are flagged by the monitor.');
}
const packs=$('Build packs and claim updates').first().json.packs||[];
return packs.map(p=>({json:p}));`;

CODE.expand_cases = String.raw`const p=$input.first().json;
return p.cases.map(k=>({json:{batch_id:p.batch_id,destination:p.destination,submission_ref:p.submission_ref,case:k}}));`;

CODE.build_pack = String.raw`const c=$('Config').first().json.cfg;
const inp=$input.all(); const ok=[]; const failed=[]; const binary={}; let meta=null; let all403=true;
const reasons={instruction_not_completed:'Report not completed yet in EMR+',report_not_available:'Completed report file is missing in EMR+',report_too_large:'Report is over the EMR+ size limit',hubspot_deal_id_mismatch:'HubSpot deal ID does not match the EMR+ case',instruction_not_found:'No EMR+ case found for this case reference',invalid_medi_ref:'Case reference is not valid',missing_hubspot_deal_id:'Deal ID was not sent to EMR+',report_invalid:'Report file is not a readable PDF or is too large',access_denied:'EMR+ refused access (API key or IP)'};
for(let i=0;i<inp.length;i++){
  const src=$('Expand cases').itemMatching(i).json; meta=meta||src;
  const it=inp[i]; const r=it.json||{}; const sc=Number(r.statusCode||0);
  if(sc!==403) all403=false;
  let good=false; let code='download_failed';
  if(it.binary&&it.binary.pdf){
    const buf=await this.helpers.getBinaryDataBuffer(i,'pdf');
    if(sc===200){
      if(buf.length>5&&buf.subarray(0,5).toString()==='%PDF-'&&buf.length<=c.max_report_bytes) good=true; else code='report_invalid';
    } else {
      try{ const j=JSON.parse(buf.toString('utf8')); code=j.code||(j.detail?'access_denied':'error_'+sc); }catch(e){ code='error_'+sc; }
    }
  }
  if(good){
    ok.push(src.case);
    const key='r_'+String(ok.length).padStart(4,'0');
    binary[key]={...it.binary.pdf,fileName:String(ok.length).padStart(6,'0')+'_report_'+src.case.mediref+'.pdf',mimeType:'application/pdf'};
  } else {
    const retry=(sc===0||sc===429||sc>=500)&&code!=='report_invalid';
    failed.push({deal_id:src.case.deal_id,kind:retry?'retry':'attention',reason:(reasons[code]||('EMR+ returned '+(sc||'no response')+' ('+code+')'))});
  }
}
if(all403&&inp.length) throw new Error('EMR_ACCESS_DENIED: every download returned 403. Check the API key and that the n8n server IP is allowed in EMR+. Deals stay Preparing and are flagged by the monitor.');
const base={batch_id:meta.batch_id,destination:meta.destination,submission_ref:meta.submission_ref,ok_cases:ok,failed};
if(!ok.length) return [{json:{...base,pack_ok:false}}];
const esc=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const html='<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font:12px Arial}table{width:100%;border-collapse:collapse}td,th{padding:6px;border:1px solid #aaa;text-align:left}</style></head><body><h1>Print manifest</h1><p>Batch: '+esc(meta.batch_id)+'<br>Pack: '+esc(meta.submission_ref)+'<br>Destination: '+esc(meta.destination)+'<br>Reports: '+ok.length+'</p><table><tr><th>#</th><th>Case reference</th><th>Type</th></tr>'+ok.map((k,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(k.mediref)+'</td><td>'+esc(k.report_type)+'</td></tr>').join('')+'</table></body></html>';
const boundary='----lalu'+Date.now().toString(16)+Math.random().toString(16).slice(2);
const crlf='\r\n';
const part=(name,filename,ctype,buf)=>Buffer.concat([Buffer.from('--'+boundary+crlf+'Content-Disposition: form-data; name="'+name+'"'+(filename?'; filename="'+filename+'"':'')+crlf+(ctype?'Content-Type: '+ctype+crlf:'')+crlf),buf,Buffer.from(crlf)]);
const body=Buffer.concat([part('files','index.html','text/html',Buffer.from(html)),part('preferCssPageSize',null,null,Buffer.from('true')),Buffer.from('--'+boundary+'--'+crlf)]);
const ct='multipart/form-data; boundary='+boundary;
binary.manifest_req=await this.helpers.prepareBinaryData(body,'manifest_req.bin',ct);
return [{json:{...base,pack_ok:true,manifest_ct:ct},binary}];`;

CODE.build_merge = String.raw`const inItem=$input.first(); const meta=inItem.json;
const keys=Object.keys(inItem.binary).filter(k=>k.startsWith('r_')).sort();
const boundary='----lalu'+Date.now().toString(16)+Math.random().toString(16).slice(2);
const crlf='\r\n';
const part=(name,filename,ctype,buf)=>Buffer.concat([Buffer.from('--'+boundary+crlf+'Content-Disposition: form-data; name="'+name+'"'+(filename?'; filename="'+filename+'"':'')+crlf+(ctype?'Content-Type: '+ctype+crlf:'')+crlf),buf,Buffer.from(crlf)]);
const chunks=[part('files','000000_manifest.pdf','application/pdf',await this.helpers.getBinaryDataBuffer(0,'manifest_pdf'))];
for(const k of keys) chunks.push(part('files',inItem.binary[k].fileName,'application/pdf',await this.helpers.getBinaryDataBuffer(0,k)));
chunks.push(Buffer.from('--'+boundary+'--'+crlf));
const ct='multipart/form-data; boundary='+boundary;
const req=await this.helpers.prepareBinaryData(Buffer.concat(chunks),'merge_req.bin',ct);
return [{json:{...meta,merge_ct:ct},binary:{merge_req:req}}];`;

CODE.validate_pack = String.raw`const c=$('Config').first().json.cfg;
const meta=$('Build pack PDF').first().json;
const buf=await this.helpers.getBinaryDataBuffer(0,'pack');
if(buf.subarray(0,5).toString()!=='%PDF-'||buf.length>c.max_pack_bytes) throw new Error('PACK_INVALID: merged pack for '+meta.submission_ref+' is not a PDF or is larger than the pack limit. Nothing was sent; deals stay Preparing and are flagged by the monitor.');
const b=$input.first().binary.pack;
return [{json:{batch_id:meta.batch_id,destination:meta.destination,submission_ref:meta.submission_ref,pack_bytes:buf.length},binary:{pack:{...b,fileName:meta.submission_ref+'.pdf',mimeType:'application/pdf'}}}];`;

const MAP_FAILED = String.raw`const failedProps=(f)=>{ const pr={};
  if(f.kind==='retry'){ pr[F.status]=V.queued; pr[F.hold]='true'; pr[F.batch]=''; pr[F.job_ref]=''; pr[F.issue]='Will retry on the next run: '+f.reason; }
  else { pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='Report not printed: '+f.reason+'. Fix the cause, then use Print / reprint.'; }
  return {id:f.deal_id,properties:pr}; };`;

CODE.print_outcome = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const meta=$('Validate pack').first().json; const pack=$('Build pack PDF').first().json;
const r=$input.first().json||{}; const sc=Number(r.statusCode||0);
let kind='unknown';
if(sc>=200&&sc<300) kind='accepted'; else if(sc>=400&&sc<500) kind='rejected';
if(r.body&&r.body.status==='rejected') kind='rejected';
const now=new Date().toISOString();
${MAP_FAILED}
const upd=[];
for(const k of pack.ok_cases){ const pr={};
  if(kind==='accepted'){ pr[F.status]=V.submitted; pr[F.submitted_at]=now; }
  else { pr[F.status]=V.issue; pr[F.hold]='true';
    pr[F.issue]= kind==='rejected' ? 'Printer connection rejected the pack (HTTP '+sc+'). Nothing was printed. Fix the connection, then use Print / reprint.' : 'Printer result unknown. Check the paper output and printer queue before any reprint.'; }
  upd.push({id:k.deal_id,properties:pr}); }
for(const f of pack.failed) upd.push(failedProps(f));
const out=[]; for(let i=0;i<upd.length;i+=100) out.push({json:{inputs:upd.slice(i,i+100),unsafe:kind!=='accepted',kind,submission_ref:meta.submission_ref}});
return out;`.replace('${MAP_FAILED}', MAP_FAILED);

CODE.failure_updates = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const meta=$input.first().json;
${MAP_FAILED}
const upd=meta.failed.map(failedProps); const out=[];
for(let i=0;i<upd.length;i+=100) out.push({json:{inputs:upd.slice(i,i+100)}});
return out;`.replace('${MAP_FAILED}', MAP_FAILED);

CODE.stop_if_unsafe = String.raw`for(const i of $input.all()){ if(i.json.status==='error'||(i.json.errors&&i.json.errors.length)) throw new Error('RESULT_WRITE_PARTIAL: some HubSpot updates failed; the monitor will repair them from the printer record.'); }
const o=$('Print outcome').first().json;
if(o.unsafe) throw new Error('PRINT_RUN_PAUSED: pack '+o.submission_ref+' was not clearly accepted by the printer ('+o.kind+'). Remaining packs were not sent. Check the printer queue and paper output, then use Print / reprint on affected deals.');
return [{json:{continue:true}}];`;


CODE.printer_ready = String.raw`const c=$('Config').first().json.cfg;
const r=$input.first().json||{}; const sc=Number(r.statusCode||0); const b=r.body||{};
const stop=(why)=>{ throw new Error('PRINTER_NOT_READY: '+why+'. Nothing was claimed or printed; deals stay Queued. Fix the printer, then start a manual run.'); };
if(sc!==200) stop('the print bridge is unreachable or returned HTTP '+(sc||'no response'));
const sp=String(b.spoolerStatus||''); const q=String(b.printerQueue||'');
const state=(String(b.status||'')==='online'&&sp==='Running')?'ready':(String(b.status||'')==='online'?'spooler_'+sp.toLowerCase():String(b.status||'unknown'));
if(state!=='ready') stop('print gateway reports status "'+(b.status||'unknown')+'", spooler "'+(sp||'unknown')+'"');
const ps=String(b.printerStatus||''); if(ps&&ps.toLowerCase()!=='normal') stop('printer status is "'+ps+'"');
if(c.printer_queue&&q&&q!==c.printer_queue) stop('gateway queue is "'+q+'", expected "'+c.printer_queue+'"');
const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
const offset=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(Date.now()/1000)*1000;
const day_start_ms=Date.UTC(+p.year,+p.month-1,+p.day)-offset;
return [{json:{printer_state:state,warning:String(b.warning||''),day_start_ms:String(day_start_ms)}}];`;

CODE.daily_allowance = String.raw`const c=$('Config').first().json.cfg;
const sent=Number(($input.first().json||{}).total||0);
const allowance=Math.max(0,c.max_reports_per_day-sent);
if(allowance===0) return [];
return [{json:{allowance,sent_today:sent}}];`;

// ---- monitor ----
CODE.group_jobs = String.raw`const c=$('Config').first().json.cfg; const F=c.fields;
const seen=new Map();
for(const it of $input.all()) for(const d of (it.json.results||[])) seen.set(String(d.id),d);
const groups=new Map();
for(const d of seen.values()){ const ref=String((d.properties||{})[F.job_ref]||'').trim()||'__none__'; if(!groups.has(ref)) groups.set(ref,[]); groups.get(ref).push(d); }
return [...groups].map(([job_ref,deals])=>({json:{job_ref,deals}}));`;

const HELPERS = String.raw`const now=Date.now(); const nowISO=new Date(now).toISOString();
const age=t=>{ if(!t) return Infinity; const d=/^\d+$/.test(String(t))?new Date(Number(t)):new Date(t); return isNaN(d)?Infinity:(now-d.getTime())/60000; };
const handoff=(p,pr)=>{ if(c.awaiting_print_stages.includes(p.dealstage)){ const t=c.report_types[String(p[F.report_type]||'').trim()]; if(t==='PIP') pr.dealstage=c.pip_invoicing_stage; else if(t) pr.dealstage=c.to_be_sent_stage; } };`;

CODE.decide_monitor = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
${HELPERS}
const res=$input.all(); const upd=[];
for(let i=0;i<res.length;i++){
  const g=$('Group jobs').itemMatching(i).json; const r=res[i].json||{}; const sc=Number(r.statusCode||0);
  const b=r.body||{};
  const bs = g.job_ref==='__none__' ? 'no_ref' : (sc===200 ? String(b.status||'') : (sc===404 ? 'not_found' : 'unreachable'));
  for(const d of g.deals){
    const p=d.properties||{}; const st=p[F.status]; const issue=String(p[F.issue]||'').trim(); const pr={};
    const attention=(msg)=>{ pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]=msg; };
    if(bs==='completed'){
      pr[F.status]=V.printed; pr[F.completed_at]=b.completed_at||nowISO;
      if(!issue){ pr[F.hold]='false'; handoff(p,pr); }
    } else if(bs==='failed'||bs==='error'){ attention('Printer problem: '+(b.reason||'the job failed')+'. Check the printer and paper output, then use Print / reprint.'); }
    else if(bs==='accepted'){
      if(st===V.preparing){ pr[F.status]=V.submitted; pr[F.submitted_at]=nowISO; }
      else if(age(p[F.submitted_at]||p.hs_lastmodifieddate)>c.completion_timeout_minutes) attention('No completion message within '+c.completion_timeout_minutes+' minutes. Check the paper output and printer queue before any reprint.');
    } else if(bs==='not_found'){
      if(st===V.submitted || age(p.hs_lastmodifieddate)>c.preparing_timeout_minutes) attention('The printer connection has no record of this job. Check the paper output and printer queue before any reprint.');
    } else if(bs==='no_ref'){ attention('Print job reference is missing. Check the paper output and printer queue before any reprint.'); }
    else if(bs==='unreachable'){
      if(age(p.hs_lastmodifieddate)>c.preparing_timeout_minutes) attention('Printer connection unreachable for over '+c.preparing_timeout_minutes+' minutes. Check it, then use Print / reprint.');
    } else { /* unrecognised status: leave for next check */ }
    if(Object.keys(pr).length) upd.push({id:String(d.id),properties:pr});
  }
}
const out=[]; for(let i=0;i<upd.length;i+=100) out.push({json:{inputs:upd.slice(i,i+100)}});
return out;`.replace('${HELPERS}', HELPERS);

// ---- staff ----
CODE.read_request = String.raw`const b=$('Config').first().json.body||{};
const id=String(b.deal_id!==undefined?b.deal_id:(b.hs_object_id!==undefined?b.hs_object_id:''));
if(!/^\d+$/.test(id)) throw new Error('STAFF_REQUEST_INVALID: webhook body must contain deal_id');
return [{json:{deal_id:id}}];`;

CODE.decide_staff = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
${HELPERS}
const deal=$('Read deal').first().json; const p=deal.properties||{}; const id=String(deal.id);
const r=$input.first().json||{}; const bs=Number(r.statusCode||0)===200?String((r.body||{}).status||''):'';
const action=p[F.action]; if(!action||action===V.action_none) return [];
const note=String(p[F.request_note]||'').trim(); const st=p[F.status];
const reject=(why)=>{ const pr={}; pr[F.action]=V.action_none; pr[F.request_note]='REJECTED: '+why; return [{json:{deal_id:id,properties:pr}}]; };
if(c.cancelled_rejected_stages.includes(p.dealstage)) return reject('this deal is cancelled or rejected');
if(!note||note.startsWith('REJECTED:')) return reject('write a new Print request note explaining the request, then set Print action again');
const pr={}; pr[F.action]=V.action_none;
if(action===V.action_problem){
  pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]=note.slice(0,500);
} else if(action===V.action_resolve){
  if(bs!=='completed') return reject('there is no successful print record for this job, so the hold stays. Use Print / reprint if another copy is needed');
  pr[F.status]=V.printed; pr[F.issue]=''; pr[F.hold]='false'; pr[F.completed_at]=p[F.completed_at]||nowISO; handoff(p,pr);
} else if(action===V.action_print){
  if(st===V.preparing||st===V.submitted||bs==='accepted') return reject('the earlier job may still be active. Check the printer queue and paper output first');
  if(!st||st===V.queued) return reject('this case has not been printed yet or is already queued');
  pr[F.status]=V.queued; pr[F.hold]='true'; pr[F.queued_at]=nowISO; pr[F.issue]=''; pr[F.batch]=''; pr[F.job_ref]=''; pr[F.submitted_at]=''; pr[F.completed_at]='';
} else return reject('unknown Print action');
return [{json:{deal_id:id,properties:pr}}];`.replace('${HELPERS}', HELPERS);

module.exports = CODE;
