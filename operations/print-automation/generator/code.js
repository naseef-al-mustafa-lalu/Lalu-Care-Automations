// Code-node sources. All run in "Run Once for All Items" mode. No template literals inside (safe inside String.raw).
const CODE = {};

// ------------------------------------------------------------------ shared
CODE.check_config = String.raw`const c=$('Config').first().json.cfg;
const copy=JSON.parse(JSON.stringify(c));
delete copy.emr_base; // EMR+ host is only needed by the report-link flow and may still be a placeholder
const bad=JSON.stringify(copy).match(/REPLACE_[A-Z_]+/g);
if(bad) throw new Error('SETUP_REQUIRED: set these values in the Config node: '+[...new Set(bad)].join(', '));
if(Number(c.reports_per_call)<1||Number(c.reports_per_call)>24) throw new Error('SETUP_REQUIRED: reports_per_call must be 1 to 24 (the gateway allows 25 jobs per call and one is the manifest)');
return $input.all();`;

const HELPERS = String.raw`const now=Date.now(); const nowISO=new Date(now).toISOString();
const age=t=>{ if(!t) return Infinity; const d=/^\d+$/.test(String(t))?new Date(Number(t)):new Date(t); return isNaN(d)?Infinity:(now-d.getTime())/60000; };
const handoff=(p,pr)=>{ if(c.awaiting_print_stages.includes(p.dealstage)){ const t=c.report_types[String(p[F.report_type]||'').trim()]; if(t==='PIP') pr.dealstage=c.pip_invoicing_stage; else if(t) pr.dealstage=c.to_be_sent_stage; } };`;

// ------------------------------------------------------------------ print run
CODE.stop_if_blocked = String.raw`const n=Number(($input.first().json||{}).total||0);
if(n>0) throw new Error('PRINT_RUN_BLOCKED: '+n+' deal(s) are still Preparing from an earlier run. The stuck check flags them as Needs attention after the timeout; check the printer queue, then re-run.');
return [{json:{ok:true}}];`;

CODE.printer_ready = String.raw`const c=$('Config').first().json.cfg;
const r=$input.first().json||{}; const sc=Number(r.statusCode||0); const b=r.body||{};
const stop=(why)=>{ throw new Error('PRINTER_NOT_READY: '+why+'. Nothing was claimed or printed; deals stay Queued. Fix the printer, then start a manual run.'); };
if(sc!==200) stop('the print gateway is unreachable or returned HTTP '+(sc||'no response'));
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

// Groups valid cases by destination, splits each destination into calls of reports_per_call, claims the cases.
CODE.build_packs = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const deals=$('Select queued deals').all().flatMap(i=>i.json.deals);
const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
const batch_id='PRINT-'+parts.year+parts.month+parts.day+'-'+parts.hour+parts.minute;
const when=parts.day+'/'+parts.month+'/'+parts.year+' '+parts.hour+':'+parts.minute;
const allowance=$('Daily allowance').first().json.allowance;
const per=Math.max(1,Math.min(24,Number(c.reports_per_call)||24));
const qt=d=>{ const t=(d.properties||{})[F.queued_at]; const n=/^\d+$/.test(String(t))?Number(t):Date.parse(t); return isNaN(n)?Infinity:n; };
deals.sort((a,b)=>qt(a)-qt(b));
const updates=[]; const valid=[];
for(const d of deals){
  const p=d.properties||{}; const id=String(d.id);
  const mediref=String(p[F.case_ref]||'').trim();
  const type=c.report_types[String(p[F.report_type]||'').trim()];
  const dest=String(p[F.dest_source]||'').trim();
  let bad='';
  if(!/^\d+$/.test(mediref)) bad='Case reference missing or not numeric';
  else if(!type) bad='Report type not recognised';
  else if(!dest) bad='Destination address is empty on the deal (check the Third party company)';
  if(bad){ const pr={}; pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='Not queued for printing: '+bad+'.'; updates.push({id,properties:pr}); }
  else if(valid.length<allowance) valid.push({deal_id:id,mediref,report_type:type,destination:dest});
}
const groups=new Map();
for(const k of valid){ if(!groups.has(k.destination)) groups.set(k.destination,[]); groups.get(k.destination).push(k); }
const packs=[]; let n=0;
for(const [destination,items] of [...groups].sort((a,b)=>a[0].localeCompare(b[0]))){
  items.sort((a,b)=>a.mediref.localeCompare(b.mediref));
  const total=Math.ceil(items.length/per);
  for(let i=0;i<items.length;i+=per){
    n++; const submission_ref=batch_id+'-P'+String(n).padStart(2,'0');
    const cases=items.slice(i,i+per).map((k,idx)=>({...k,job_id:submission_ref+'-R'+String(idx+1).padStart(2,'0')}));
    packs.push({batch_id,destination,submission_ref,part:Math.floor(i/per)+1,parts:total,when,cases});
    for(const k of cases){ const pr={}; pr[F.status]=V.preparing; pr[F.hold]='true'; pr[F.batch]=batch_id; pr[F.job_ref]=k.job_id; pr[F.destination]=destination; pr[F.issue]=''; pr[F.submitted_at]=''; pr[F.completed_at]=''; updates.push({id:k.deal_id,properties:pr}); }
  }
}
const out=[];
for(let i=0;i<updates.length;i+=100) out.push({json:{inputs:updates.slice(i,i+100),packs}});
return out;`;

CODE.list_packs = String.raw`for(const i of $input.all()){
  const j=i.json||{};
  if(j.status==='error'||(j.errors&&j.errors.length)) throw new Error('CLAIM_FAILED: HubSpot did not accept every claim. Run stopped before printing; stuck Preparing deals are flagged by the stuck check.');
}
const packs=$('Build batches and claim updates').first().json.packs||[];
return packs.map(p=>({json:p}));`;

// One item per print job: the manifest first, then each report. Each carries the text that gets signed.
CODE.build_job_links = String.raw`const c=$('Config').first().json.cfg;
const pack=$input.first().json;
const exp=Math.floor(Date.now()/1000)+Number(c.link_valid_minutes)*60;
const tcode={PIP:'P',UC:'U',HAA:'H'};
const canon=q=>Object.keys(q).map(k=>k+'='+encodeURIComponent(String(q[k]))).join('&');
const base={pack_ref:pack.submission_ref,batch_id:pack.batch_id,destination:pack.destination,started_ms:Date.now()};
const items=[];
const mq={k:'m',b:pack.batch_id,r:pack.submission_ref,d:pack.destination,p:pack.part,n:pack.parts,w:pack.when,e:exp,c:pack.cases.map(k=>k.mediref+'-'+tcode[k.report_type]).join('.')};
items.push({json:{...base,job_id:pack.submission_ref+'-M',kind:'manifest',query:mq,payload:canon(mq),cases:pack.cases.map(k=>({deal_id:k.deal_id,job_id:k.job_id,report_type:k.report_type}))}});
for(const k of pack.cases){ const q={k:'r',i:k.deal_id,m:k.mediref,e:exp}; items.push({json:{...base,job_id:k.job_id,kind:'report',query:q,payload:canon(q)}}); }
return items;`;

CODE.build_print_request = String.raw`const c=$('Config').first().json.cfg;
const items=$input.all(); const first=items[0].json;
for(const it of items) if(!it.json.sig||!/^[0-9a-f]{64}$/.test(String(it.json.sig))) throw new Error('LINK_SIGNING_FAILED: could not sign the report links. Nothing was sent to the printer.');
const base=c.n8n_public_base.replace(/\/$/,'')+'/webhook/lalu-report?';
const jobs=items.map(it=>{ const j=it.json; const q=Object.keys(j.query).map(k=>k+'='+encodeURIComponent(String(j.query[k]))).join('&')+'&s='+j.sig;
  return {jobId:j.job_id,documentUrl:base+q,sha256:'',printerQueue:c.printer_queue,copies:1,paperSize:'A4',colour:!!c.colour,duplex:!!c.duplex}; });
if(jobs.length>25) throw new Error('BATCH_TOO_LARGE: '+jobs.length+' jobs, the gateway allows 25.');
const manifest=items.find(i=>i.json.kind==='manifest').json;
return [{json:{meta:{pack_ref:first.pack_ref,batch_id:first.batch_id,destination:first.destination,manifest_job_id:manifest.job_id,cases:manifest.cases,started_ms:first.started_ms,started_iso:new Date().toISOString()},body:{requestType:'batch',batchId:first.pack_ref,submittedBy:'n8n-lalu-print',jobs}}}];`;

// Reads the gateway answer: per-job results, never assumes a timeout means "not printed".
CODE.print_outcome = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const meta=$('Build print request').first().json.meta;
const r=$input.first().json||{}; const sc=Number(r.statusCode||0); const b=(r.body&&typeof r.body==='object')?r.body:{};
const nowISO=new Date().toISOString();
const why={400:'the case reference was not valid',404:'EMR+ has no matching case (not found or deal ID mismatch)',409:'the report is not completed or not available in EMR+',403:'EMR+ refused access (API key or IP address)',410:'the download link expired before the printer used it',413:'the report is over the printer limit of 50 MB',422:'the download link was not valid',502:'EMR+ returned an error or something that is not a PDF',503:'EMR+ was busy, unreachable or not configured'};
const reason=x=>{ const m=String((x&&x.errorMessage)||'').match(/\((\d{3})\)/); if(m&&why[m[1]]) return why[m[1]]+' (HTTP '+m[1]+')'; return String((x&&(x.errorMessage||x.errorCode))||'the printer reported a failure').slice(0,160); };
let kind='results';
if(!sc) kind='unknown';
else if(sc>=400&&sc<500) kind='rejected';
else if(sc>=500) kind=(b.accepted===false)?'rejected':'unknown';
else if(b.accepted===false) kind='rejected';
const res=Array.isArray(b.results)?b.results:[]; const byId=new Map(res.map(x=>[String(x.jobId),x]));
const job=id=>{ const x=byId.get(String(id));
  if(x){ if(x.errorCode) return {ok:false,x}; const s=String(x.status||'').toLowerCase(); if(/fail|error|reject/.test(s)) return {ok:false,x}; return {ok:String(b.batchStatus||'')!=='failed',x}; }
  return {ok:String(b.batchStatus||'')==='completed'&&Number(b.jobsFailed||0)===0,x:null}; };
const mf=kind==='results'?job(meta.manifest_job_id):{ok:false,x:null};
const updates=[]; const handoff=[]; let okc=0, failed=0, f403=0;
for(const k of meta.cases){
  const pr={};
  if(kind==='results'){
    const j=job(k.job_id);
    if(j.ok){
      okc++; pr[F.status]=V.printed; pr[F.submitted_at]=meta.started_iso; pr[F.completed_at]=nowISO;
      if(mf.ok){ pr[F.issue]=''; pr[F.hold]='false'; handoff.push({id:k.deal_id,report_type:k.report_type,properties:pr}); continue; }
      pr[F.hold]='true'; pr[F.issue]='Printed, but the manifest sheet did not print ('+reason(mf.x)+'). Check the stack, then use Resolve problem.';
    } else {
      failed++; if(/\(403\)/.test(String((j.x&&j.x.errorMessage)||''))) f403++;
      pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='Report not printed: '+reason(j.x)+'. Fix the cause, then use Print / reprint.';
    }
  } else if(kind==='rejected'){
    pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='The print gateway rejected the batch (HTTP '+sc+(b.errorCode?', '+b.errorCode:'')+'). Nothing was printed. Fix the connection, then use Print / reprint.';
  } else {
    pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='Print result unknown (no clear answer from the print gateway). Check the paper output and printer queue before any reprint.';
  }
  updates.push({id:k.deal_id,properties:pr});
}
return [{json:{kind,pack_ref:meta.pack_ref,unsafe:kind!=='results',updates,handoff,read_inputs:handoff.map(h=>({id:h.id})),jobs_ok:okc,jobs_failed:failed,all_failed_403:failed>0&&okc===0&&f403===failed,manifest_ok:mf.ok}}];`;

CODE.build_result_updates = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const o=$('Print outcome').first().json; const r=$input.first().json||{};
const stage=new Map((((r.body||{}).results)||[]).map(x=>[String(x.id),(x.properties||{}).dealstage]));
const upd=o.updates.slice();
for(const h of o.handoff){
  const pr={...h.properties};
  if(!stage.has(h.id)){ pr[F.hold]='true'; pr[F.issue]='Printed. The stage handoff was not applied because the deal could not be read. Use Resolve problem to hand off.'; }
  else if(c.awaiting_print_stages.includes(stage.get(h.id))){ pr.dealstage=(h.report_type==='PIP')?c.pip_invoicing_stage:c.to_be_sent_stage; }
  upd.push({id:h.id,properties:pr});
}
const out=[]; for(let i=0;i<upd.length;i+=100) out.push({json:{inputs:upd.slice(i,i+100)}});
return out.length?out:[{json:{inputs:[]}}];`;

CODE.stop_if_unsafe = String.raw`for(const i of $input.all()){ if(i.json.status==='error'||(i.json.errors&&i.json.errors.length)) throw new Error('RESULT_WRITE_PARTIAL: some HubSpot updates failed after printing batch '+$('Print outcome').first().json.pack_ref+'. Check the deals in Preparing / Needs attention. Do not reprint without checking the paper output.'); }
const o=$('Print outcome').first().json;
if(o.unsafe) throw new Error('PRINT_RUN_PAUSED: batch '+o.pack_ref+' was not clearly accepted by the print gateway ('+o.kind+'). Remaining batches were not sent. Check the printer queue and paper output, then use Print / reprint on affected deals.');
if(o.all_failed_403) throw new Error('EMR_ACCESS_DENIED: every report in batch '+o.pack_ref+' was refused by EMR+ (403). Check the API key and that the n8n server IP is allowed in EMR+. Remaining batches were not sent.');
return [{json:{continue:true}}];`;

// ------------------------------------------------------------------ stuck check (replaces the old monitor)
CODE.decide_stuck = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
${HELPERS}
const seen=new Map();
for(const it of $input.all()) for(const d of (it.json.results||[])) seen.set(String(d.id),d);
const upd=[];
for(const d of seen.values()){
  const p=d.properties||{};
  if(age(p.hs_lastmodifieddate)>c.preparing_timeout_minutes){
    const pr={}; pr[F.status]=V.issue; pr[F.hold]='true';
    pr[F.issue]='The print run did not finish for this case within '+c.preparing_timeout_minutes+' minutes. Check the paper output and printer queue before any reprint, then use Print / reprint if needed.';
    upd.push({id:String(d.id),properties:pr});
  }
}
const out=[]; for(let i=0;i<upd.length;i+=100) out.push({json:{inputs:upd.slice(i,i+100)}});
return out.length?out:[{json:{inputs:[]}}];`.replace('${HELPERS}', HELPERS);

// ------------------------------------------------------------------ staff actions (HubSpot is the only record)
CODE.read_request = String.raw`const b=$('Config').first().json.body||{};
const id=String(b.deal_id!==undefined?b.deal_id:(b.hs_object_id!==undefined?b.hs_object_id:''));
if(!/^\d+$/.test(id)) throw new Error('STAFF_REQUEST_INVALID: webhook body must contain deal_id');
return [{json:{deal_id:id}}];`;

CODE.decide_staff = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
${HELPERS}
const deal=$input.first().json; const p=deal.properties||{}; const id=String(deal.id);
const action=p[F.action]; if(!action||action===V.action_none) return [];
const note=String(p[F.request_note]||'').trim(); const st=p[F.status];
const reject=(why)=>{ const pr={}; pr[F.action]=V.action_none; pr[F.request_note]='REJECTED: '+why; return [{json:{deal_id:id,properties:pr}}]; };
if(c.cancelled_rejected_stages.includes(p.dealstage)) return reject('this deal is cancelled or rejected');
if(!note||note.startsWith('REJECTED:')) return reject('write a new Print request note explaining the request, then set Print action again');
const pr={}; pr[F.action]=V.action_none;
if(action===V.action_problem){
  pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]=note.slice(0,500);
} else if(action===V.action_resolve){
  if(!p[F.completed_at]) return reject('there is no successful print record on this deal, so the hold stays. Use Print / reprint if another copy is needed');
  pr[F.status]=V.printed; pr[F.issue]=''; pr[F.hold]='false'; handoff(p,pr);
} else if(action===V.action_print){
  if(st===V.preparing||st===V.submitted) return reject('the earlier job may still be active. Check the printer queue and paper output first');
  if(!st||st===V.queued) return reject('this case has not been printed yet or is already queued');
  pr[F.status]=V.queued; pr[F.hold]='true'; pr[F.queued_at]=nowISO; pr[F.issue]=''; pr[F.batch]=''; pr[F.job_ref]=''; pr[F.submitted_at]=''; pr[F.completed_at]='';
} else return reject('unknown Print action');
return [{json:{deal_id:id,properties:pr}}];`.replace('${HELPERS}', HELPERS);

// ------------------------------------------------------------------ report link flow (the gateway calls this)
CODE.check_link = String.raw`const q=$('Config').first().json.query||{};
const bad=(status,msg)=>[{json:{ok:false,status,msg}}];
const kind=String(q.k||'');
const orders={r:['k','i','m','e'],m:['k','b','r','d','p','n','w','e','c']};
if(!orders[kind]) return bad(422,'link not valid');
for(const k of orders[kind]) if(q[k]===undefined||String(q[k]).length>2000) return bad(422,'link not valid');
if(!/^\d+$/.test(String(q.e))) return bad(422,'link not valid');
if(kind==='r'&&(!/^\d+$/.test(String(q.i))||!/^\d+$/.test(String(q.m)))) return bad(422,'link not valid');
const payload=orders[kind].map(k=>k+'='+encodeURIComponent(String(q[k]))).join('&');
return [{json:{ok:true,kind,payload,exp:Number(q.e),sig_given:String(q.s||'').toLowerCase()}}];`;

CODE.verify_signature = String.raw`const j=$input.first().json; const given=String(j.sig_given||''); const want=String(j.sig||'');
let diff=given.length^want.length; for(let i=0;i<want.length;i++) diff|=(given.charCodeAt(i)||0)^want.charCodeAt(i);
if(!want||diff!==0) return [{json:{ok:false,status:403,msg:'link not valid'}}];
if(Date.now()/1000>j.exp) return [{json:{ok:false,status:410,msg:'link expired'}}];
return [{json:{ok:true,kind:j.kind}}];`;

// Plain PDF written by hand: no external tool, nothing stored.
const PDF_LIB = String.raw`const asc=s=>String(s).replace(/[^\x20-\x7e]/g,'?').replace(/[\\()]/g,'\\$&');
const txt=(f,size,x,y,s)=>'BT /'+f+' '+size+' Tf 1 0 0 1 '+x+' '+y+' Tm ('+asc(s)+') Tj ET\n';
const buildPdf=(pages)=>{
  const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids ['+pages.map((_,i)=>(5+i*2)+' 0 R').join(' ')+'] /Count '+pages.length+' >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  pages.forEach((cs,i)=>{ objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents '+(6+i*2)+' 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>'); objs.push('<< /Length '+Buffer.byteLength(cs,'latin1')+' >>\nstream\n'+cs+'endstream'); });
  let pdf='%PDF-1.4\n'; const off=[];
  objs.forEach((o,i)=>{ off.push(Buffer.byteLength(pdf,'latin1')); pdf+=(i+1)+' 0 obj\n'+o+'\nendobj\n'; });
  const x=Buffer.byteLength(pdf,'latin1');
  pdf+='xref\n0 '+(objs.length+1)+'\n0000000000 65535 f \n'+off.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objs.length+1)+' /Root 1 0 R >>\nstartxref\n'+x+'\n%%EOF\n';
  return Buffer.from(pdf,'latin1');
};`;

CODE.build_manifest = String.raw`const q=$('Config').first().json.query||{};
${PDF_LIB}
const names={P:'PIP',U:'UC',H:'HAA'};
const rows=String(q.c||'').split('.').filter(Boolean).map(s=>{ const m=s.split('-'); return {ref:m[0],type:names[m[1]]||m[1]}; });
const dest=String(q.d||'').slice(0,70);
const pages=[]; let cur=''; let y=0; let first=true;
const head=()=>{ cur=''; if(first){
    cur+=txt('F2',22,50,790,'PRINT MANIFEST');
    cur+=txt('F1',12,50,760,'Batch: '+q.b); cur+=txt('F1',12,50,742,'Print call: '+q.r+'   (part '+q.p+' of '+q.n+')');
    cur+=txt('F2',12,50,724,'Destination: '+dest); cur+=txt('F1',12,50,706,'Prepared: '+q.w+'   Reports in this part: '+rows.length);
    cur+=txt('F1',10,50,684,'Check the printed reports behind this sheet against the list below before packing.');
    y=654; first=false;
  } else { cur+=txt('F2',12,50,800,'Manifest continued: '+q.r); y=770; }
  cur+=txt('F2',11,50,y,'No.'); cur+=txt('F2',11,110,y,'Case reference'); cur+=txt('F2',11,260,y,'Report type'); y-=20; };
head();
rows.forEach((r,i)=>{ if(y<60){ pages.push(cur); head(); }
  cur+=txt('F1',11,50,y,String(i+1)+'.'); cur+=txt('F1',11,110,y,r.ref); cur+=txt('F1',11,260,y,r.type); y-=18; });
pages.push(cur);
const buf=buildPdf(pages);
const bin=await this.helpers.prepareBinaryData(buf,'manifest-'+String(q.r||'batch')+'.pdf','application/pdf');
return [{json:{ok:true},binary:{data:bin}}];`.replace('${PDF_LIB}', PDF_LIB);

CODE.dummy_report = String.raw`const q=$('Config').first().json.query||{};
${PDF_LIB}
const c=txt('F2',20,60,780,'DUMMY REPORT (TEST MODE)')+txt('F1',14,60,740,'Case reference: '+String(q.m||''))+txt('F1',14,60,715,'Deal: '+String(q.i||''))+txt('F1',12,60,680,'Not a real report. Safe to bin.')+txt('F1',12,60,660,'Generated '+new Date().toISOString());
const bin=await this.helpers.prepareBinaryData(buildPdf([c]),'dummy-'+String(q.m||'')+'.pdf','application/pdf');
return [{json:{ok:true},binary:{data:bin}}];`.replace('${PDF_LIB}', PDF_LIB);

CODE.check_report = String.raw`const it=$input.first(); const r=it.json||{}; const sc=Number(r.statusCode||0);
const bad=(status,msg)=>[{json:{ok:false,status,msg}}];
if(!sc) return bad(503,'EMR+ unreachable or not configured');
if(sc!==200){
  const m={400:[400,'invalid case reference'],401:[403,'EMR+ refused access'],403:[403,'EMR+ refused access'],404:[404,'case not found or deal id mismatch'],409:[409,'report not completed, not available or too large'],429:[503,'EMR+ busy']};
  const x=m[sc]||(sc>=500?[502,'EMR+ error']:[502,'unexpected EMR+ answer']); return bad(x[0],x[1]);
}
if(!it.binary||!it.binary.data) return bad(502,'EMR+ sent no file');
const buf=await this.helpers.getBinaryDataBuffer(0,'data');
if(buf.length<6||buf.subarray(0,5).toString()!=='%PDF-') return bad(502,'EMR+ did not send a PDF');
if(buf.length>50*1024*1024) return bad(413,'report over the printer limit of 50 MB');
return [{json:{ok:true},binary:{data:it.binary.data}}];`;

module.exports = CODE;
