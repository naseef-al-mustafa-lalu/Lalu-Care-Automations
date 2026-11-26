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
const typeOf=p=>c.report_types[String(p[F.report_type]||'').trim()];
const isIssue=st=>Object.values(c.issue_stages).includes(st);
const handoff=(p,pr)=>{ if(c.awaiting_print_stages.includes(p.dealstage)||isIssue(p.dealstage)){ const t=typeOf(p); if(t==='PIP') pr.dealstage=c.pip_invoicing_stage; else if(t) pr.dealstage=c.completed_stage; } };
const toIssue=(p,pr)=>{ const t=typeOf(p); if(t&&c.awaiting_print_stages.includes(p.dealstage)) pr.dealstage=c.issue_stages[t]; };
const backToQueue=(p,pr)=>{ const t=typeOf(p); if(t&&isIssue(p.dealstage)) pr.dealstage=c.awaiting_stage_by_type[t]; };`;

// ------------------------------------------------------------------ print run
CODE.stop_if_blocked = String.raw`const n=Number(($input.first().json||{}).total||0);
if(n>0){
  let sched=false; try{ sched=$('Working day?').first().json.scheduled===true; }catch(e){}
  if(sched){ const d=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'}).format(new Date()); const sd=$getWorkflowStaticData('global'); if(sd.blocked_alert_day===d) return []; sd.blocked_alert_day=d; }
  throw new Error('PRINT_RUN_BLOCKED: '+n+' deal(s) are still Preparing from an earlier run. The stuck check flags them as Needs attention after the timeout; check the printer queue, then re-run.');
}
return [{json:{ok:true}}];`;

CODE.working_day = String.raw`const c=$('Config').first().json.cfg; const it=$('Route').first();
if(!it.json.scheduled) return [it];
// Schedule comes from the Print control company (run_start_time, run_end_time, run_days); a blank or invalid value falls back to Config. Print paused ends the tick quietly, so a paused day makes no printer check and sends no alert.
const r=$input.first().json||{}; const p=(r.body||{}).properties||{};
if(String(p.print_paused)==='true') return [];
const hhmm=v=>{ const m=/^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(v==null?'':v)); if(!m) return null; const h=+m[1], mi=+m[2]; return (h<24&&mi<60)?String(h).padStart(2,'0')+':'+m[2]:null; };
const start=hhmm(p.run_start_time)||c.run_start_time; const end=hhmm(p.run_end_time)||c.retry_until_time;
const ALL=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const fromCo=String(p.run_days||'').split(';').map(x=>x.trim()).filter(x=>ALL.includes(x));
const days=fromCo.length?fromCo:(c.run_days||ALL.slice(0,5));
const d=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'}).format(new Date());
const hm=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
const dn=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',weekday:'long'}).format(new Date());
if(!days.includes(dn)) return [];
if((c.bank_holidays||[]).includes(d)) return [];
if(hm<start||hm>end) return [];
const sd=$getWorkflowStaticData('global');
if(sd.ran_day===d) return [];
return [{json:{...it.json,run_start:start,run_end:end}}];`;

CODE.printer_ready = String.raw`const c=$('Config').first().json.cfg;
const r=$input.first().json||{}; const sc=Number(r.statusCode||0); const b=r.body||{};
let sched=false; let rs=c.run_start_time, re=c.retry_until_time; try{ const w=$('Working day?').first().json; sched=w.scheduled===true; rs=w.run_start||rs; re=w.run_end||re; }catch(e){}
const problems=[]; const stop=(why)=>{ if(!problems.length) problems.push(why); };
if(sc!==200) stop('the print gateway is unreachable or returned HTTP '+(sc||'no response'));
const sp=String(b.spoolerStatus||''); const q=String(b.printerQueue||'');
const state=(String(b.status||'')==='online'&&sp==='Running')?'ready':(String(b.status||'')==='online'?'spooler_'+sp.toLowerCase():String(b.status||'unknown'));
if(!problems.length&&state!=='ready') stop('print gateway reports status "'+(b.status||'unknown')+'", spooler "'+(sp||'unknown')+'"');
const ps=String(b.printerStatus||''); if(!problems.length&&ps&&ps.toLowerCase()!=='normal') stop('printer status is "'+ps+'"');
if(!problems.length&&c.printer_queue&&q&&q!==c.printer_queue) stop('gateway queue is "'+q+'", expected "'+c.printer_queue+'"');
const notes=[]; const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'}).format(new Date());
if(problems.length){
  const why=problems[0];
  if(c.dry_run===true){ notes.push(why); }
  else if(!sched){ throw new Error('PRINTER_NOT_READY: '+why+'. Nothing was claimed or printed; deals stay Queued. Fix the printer, then start a manual run.'); }
  else {
    const hm=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
    const sd=$getWorkflowStaticData('global');
    if(hm>=re){ throw new Error('PRINTER_NOT_READY_GAVE_UP: '+why+'. Checked every 30 minutes since '+rs+' and it did not come back by '+re+'. Nothing was claimed or printed; deals stay Queued and the next weekday run will try again. Fix the printer, then start a manual run if it cannot wait.'); }
    if(sd.offline_alert_day!==day){ sd.offline_alert_day=day; throw new Error('PRINTER_NOT_READY_WILL_RETRY: '+why+'. Nothing was claimed or printed. n8n checks again every 30 minutes until '+re+' and runs the batches once the printer is online.'); }
    return [];
  }
}
if(sched){ $getWorkflowStaticData('global').ran_day=day; }
const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
const offset=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(Date.now()/1000)*1000;
const day_start_ms=Date.UTC(+p.year,+p.month-1,+p.day)-offset;
return [{json:{printer_state:notes.length?'dry_run_not_checked: '+notes.join('; '):state,warning:String(b.warning||''),day_start_ms:String(day_start_ms)}}];`;

CODE.daily_allowance = String.raw`const c=$('Apply control settings').first().json.cfg;
const sent=Number(($input.first().json||{}).total||0);
const allowance=Math.max(0,c.max_reports_per_day-sent);
if(allowance===0) return [];
return [{json:{allowance,sent_today:sent}}];`;

CODE.select_queued = String.raw`const c=$('Apply control settings').first().json.cfg;
const seen=new Map();
for(const it of $input.all()) for(const d of (it.json.results||[])) seen.set(String(d.id),d);
const skip=new Set(c.cancelled_rejected_stages);
const sw=c.print_enabled||{};
const off=d=>{ const t=c.report_types[String(((d.properties||{})[c.fields.report_type])||'').trim()]; return !!t&&sw[t]===false; };
const deals=[...seen.values()].filter(d=>!skip.has((d.properties||{}).dealstage)&&!off(d));
if(!deals.length) return [];
const out=[];
for(let i=0;i<deals.length;i+=100){
  const part=deals.slice(i,i+100);
  out.push({json:{inputs:part.map(d=>({id:String(d.id)})),deals:part}});
}
return out;`;

// Checks each report exists in EMR+ before anything is claimed or put on a manifest (HEAD request: nothing is downloaded or stored).
// Per batch, just before it prints: one item per case so the HEAD request runs once per report.
CODE.list_checks = String.raw`const pack=$input.first().json;
return pack.cases.map(k=>({json:{deal_id:k.deal_id,mediref:k.mediref}}));`;

// Reads the HEAD answers for this batch. Missing / unlinked reports go to Needs attention and are taken off the manifest.
// EMR+ not answering puts the deal back to Queued (next run). 401/403 puts the whole batch back and stops the run after the write.
CODE.apply_checks = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const pack=$('Next batch').first().json;
const res=$input.all().map(i=>i.json||{});
const maxMb=Number(c.max_report_mb||150); const maxB=maxMb*1000000;
const why={400:'the case reference (medi ref) is not valid: correct the medi ref on the deal',404:'EMR+ could not match the medi ref to this deal (wrong medi ref, copied from another case, or not linked to this deal\'s submission reference): check the medi ref and submission reference on the deal against the EMR+ instruction',409:'the report is not completed, not available or too large in EMR+: ops to check'};
const keep=[]; const updates=[]; let abort='';
const back=k=>{}; // not claimed yet: a report EMR+ could not answer for simply stays Queued for the next run
pack.cases.forEach((k,i)=>{
  const r=res[i]||{}; const sc=Number(r.statusCode||0); let bad='';
  if(abort){ back(k); return; }
  if(sc===200){ const hl=Number(((r.headers||{})['content-length'])||0); if(hl>maxB) bad='the report is '+(hl/1000000).toFixed(1)+' MB, over the limit of '+maxMb+' MB'; }
  else if(sc===401||sc===403){ abort='EMR_ACCESS_REFUSED: EMR+ refused access (HTTP '+sc+') while checking reports. Check the API key and that the n8n IP address is allowed. This batch was not printed and its deals were put back to Queued.'; back(k); return; }
  else if(why[sc]) bad=why[sc]+' (HTTP '+sc+')';
  else { back(k); return; }
  if(bad){ const pr={}; pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='Not queued for printing: '+bad+'. Fix the cause, then use Print / reprint.'; const type=k.report_type; if(c.issue_stages[type]) pr.dealstage=c.issue_stages[type]; updates.push({id:k.deal_id,properties:pr}); return; }
  keep.push(k);
});
if(abort){ return [{json:{...pack,cases:[],updates:[],abort,checked:pack.cases.length,removed:pack.cases.length}}]; }
const cases=keep.map((k,idx)=>({...k,job_id:pack.submission_ref+'-R'+String(idx+1).padStart(2,'0')}));
// claim the deals that stay on this batch (Preparing) now, one batch at a time
for(const k of cases){ const pr={}; pr[F.status]=V.preparing; pr[F.hold]='true'; pr[F.batch]=pack.batch_id; pr[F.job_ref]=k.job_id; pr[F.destination]=pack.destination; pr[F.issue]=''; pr[F.submitted_at]=''; pr[F.completed_at]=''; updates.push({id:k.deal_id,properties:pr}); }
return [{json:{...pack,cases,updates,abort,checked:pack.cases.length,removed:pack.cases.length-cases.length}}];`;

// After the check write: stop on an access error, otherwise pass the checked pack on.
CODE.pack_after_checks = String.raw`const w=$input.first().json||{};
if(w.status==='error'||(w.errors&&w.errors.length)) throw new Error('CLAIM_FAILED: HubSpot did not accept the claims for this batch. Run stopped before printing; deals stuck in Preparing are flagged by the stuck check.');
const j=$('Apply batch check').first().json;
if(j.abort) throw new Error(j.abort);
const {updates,abort,checked,removed,...pack}=j;
return [{json:pack}];`;

// Groups valid cases by destination, splits each destination into calls of reports_per_call, claims the cases.
CODE.build_packs = String.raw`const c=$('Apply control settings').first().json.cfg; const F=c.fields, V=c.values;
const deals=$('Select queued deals').all().flatMap(i=>i.json.deals||[]);
const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
const batch_id='PRINT-'+parts.year+parts.month+parts.day+'-'+parts.hour+parts.minute;
const when=parts.day+'/'+parts.month+'/'+parts.year+' '+parts.hour+':'+parts.minute;
const allowance=$('Daily allowance').first().json.allowance;
const per=Math.max(1,Math.min(24,Number(c.reports_per_call)||20));
const qt=d=>{ const t=(d.properties||{})[F.queued_at]; const n=/^\d+$/.test(String(t))?Number(t):Date.parse(t); return isNaN(n)?Infinity:n; };
deals.sort((a,b)=>qt(a)-qt(b));
const updates=[]; const valid=[];
for(const d of deals){
  const p=d.properties||{}; const id=String(d.id);
  const mediref=String(p[F.case_ref]||'').trim();
  const type=c.report_types[String(p[F.report_type]||'').trim()];
  const destRaw=String(p[F.dest_source]||'').trim();
  const dest=destRaw.split(/\r?\n|,/).map(x=>x.trim()).filter(Boolean).join(', ');
  let bad='';
  if(!/^\d+$/.test(mediref)) bad='Case reference missing or not numeric';
  else if(!type) bad='Report type not recognised';
  const noPc=!!dest&&!!c.require_postcode_in_destination&&!/[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}/i.test(dest);
  if(!bad&&(!dest||noPc)){
    // No usable destination yet: leave the deal Queued (no stage move, no Needs attention). Write a waiting note once; it prints on its own when the address is populated.
    const why=noPc?'the destination has no postcode yet (just a company name): add the full address to the Third party company':(p[F.recipient_set]==='No')?'no third party company matched the scanned address on the deal':(p[F.recipient_set]==='Yes')?'a third party company is linked but it has no address':'the destination address is empty on the deal (check the Third party company)';
    if(!String(p[F.issue]||'').startsWith('Waiting for destination address')){ const pr={}; pr[F.issue]='Waiting for destination address: '+why+'. It will print on its own once the address is populated.'; updates.push({id,properties:pr}); }
    continue;
  }
  if(bad){ const pr={}; pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='Not queued for printing: '+bad+'.'; if(type&&c.awaiting_print_stages.includes(p.dealstage)) pr.dealstage=c.issue_stages[type]; updates.push({id,properties:pr}); }
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
  }
}
// Deals are claimed (Preparing) one batch at a time, just before that batch prints (Apply batch check), so a long run never leaves later batches looking stuck.
const maxB=Number(c.max_batches_per_run||0); let run=maxB>0?packs.slice(0,maxB):packs;
const maxR=Number(c.max_reports_per_run||0);
if(maxR>0){ const keep=[]; let tot=0; for(const pk of run){ if(tot>=maxR) break; keep.push(pk); tot+=pk.cases.length; } run=keep; } // stops starting new batches once this many reports are in the run; a batch already started is never cut
const out=[];
for(let i=0;i<updates.length;i+=100) out.push({json:{inputs:updates.slice(i,i+100),packs:run}});
if(!out.length) out.push({json:{inputs:[],packs:run}});
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
const tcode={PIP:'P',UC:'U',HAA:'H',DLA:'D'};
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
const base=c.n8n_public_base.replace(/\/$/,'')+'/webhook/'+(c.report_path||'lalu-report')+'?';
const jobs=items.map(it=>{ const j=it.json; const q=Object.keys(j.query).map(k=>k+'='+encodeURIComponent(String(j.query[k]))).join('&')+'&s='+j.sig;
  return {jobId:j.job_id,documentUrl:base+q,sha256:'',printerQueue:c.printer_queue,copies:1,paperSize:'A4',colour:!!c.colour,duplex:!!c.duplex}; });
if(jobs.length>25) throw new Error('BATCH_TOO_LARGE: '+jobs.length+' jobs, the gateway allows 25.');
const manifest=items.find(i=>i.json.kind==='manifest').json;
return [{json:{meta:{pack_ref:first.pack_ref,batch_id:first.batch_id,destination:first.destination,manifest_job_id:manifest.job_id,cases:manifest.cases,started_ms:first.started_ms,started_iso:new Date().toISOString()},body:{requestType:'batch',batchId:first.pack_ref,submittedBy:'n8n-lalu-print',jobs}}}];`;

// Reads the gateway answer: per-job results, never assumes a timeout means "not printed".
CODE.print_outcome = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const meta=$('Build print request').first().json.meta;
const r=$('Submit to gateway').first().json||{}; const sc=Number(r.statusCode||0);
const hl=$input.first().json||{}; const hb=(hl.body&&typeof hl.body==='object')?hl.body:{}; const hsc=Number(hl.statusCode||0);
const pst=!hsc?'the print gateway did not answer a status check afterwards, so it may be offline':(hsc>=400?'the print gateway answered a status check with HTTP '+hsc:'status check afterwards: printer '+String(hb.printerStatus||hb.status||'unknown')+', spooler '+String(hb.spoolerStatus||'unknown')+(hb.warning?', warning: '+String(hb.warning).slice(0,80):'')); const b=(r.body&&typeof r.body==='object')?r.body:{};
const nowISO=new Date().toISOString();
const why={400:'the case reference (medi ref) is missing or not valid: correct the medi ref on the deal',404:'EMR+ could not match the medi ref to this deal (wrong medi ref, copied from another case, or not linked to this deal\'s submission reference): check the medi ref and submission reference on the deal against the EMR+ instruction',409:'the report is not completed, not available or too large in EMR+: ops to check',403:'EMR+ refused access (API key or IP address): tell Naseef',410:'the download link expired before the printer used it',413:'the report is over the size limit of '+Number(c.max_report_mb||150)+' MB',422:'the download link was not valid',502:'EMR+ internal error or not a PDF after a retry: ask Emily to check Sentry',503:'EMR+ was rate limited, unreachable or not configured after retries: try again later'};
const linkProblem='the print gateway could not reach the n8n report link. This is a workflow or connection problem, not this deal: check the n8n print workflow is active and that the gateway can reach automation.lalu.co.uk';
const reason=x=>{ const msg=String((x&&x.errorMessage)||''); const m=msg.match(/\((\d{3})\)/);
  if(m&&m[1]==='404'){ const mm=String((mf&&mf.x&&mf.x.errorMessage)||''); return (mf&&!mf.ok&&/\(404\)/.test(mm))?linkProblem+' (HTTP 404, the manifest sheet failed the same way)':why[404]+' (HTTP 404)'; }
  if(m&&why[m[1]]) return why[m[1]]+' (HTTP '+m[1]+')';
  if(!msg&&!(x&&x.errorCode)) return 'the printer reported a failure';
  return String(msg||x.errorCode).slice(0,160)+(m?'':'. If this is a connection error, check the gateway can reach automation.lalu.co.uk and the n8n print workflow is active'); };
const timedOut=!!(r.error&&/timeout|timed out/i.test(String(r.error.message||r.error.code||'')));
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
const updates=[]; const handoff=[]; const issue_moves=[]; let okc=0, failed=0, f403=0;
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
      pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='Report not printed: '+reason(j.x)+'. Fix the cause and use Print / reprint, or print it by hand and set Print action to Printed manually.';
    }
  } else if(kind==='rejected'){
    pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='The print gateway rejected the batch (HTTP '+sc+(b.errorCode?', '+b.errorCode:'')+'). Nothing was printed. Fix the connection, then use Print / reprint.';
  } else {
    pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]=(timedOut?'Print result unknown: n8n stopped waiting for the print gateway after '+Number(c.gateway_timeout_minutes||15)+' minutes (gateway_timeout_minutes in Config), but the printer may have carried on and finished. ':'Print result unknown (no clear answer from the print gateway). ')+'Check the paper output and printer queue before any reprint ('+pst+').';
  }
  if(pr[F.status]===V.issue) issue_moves.push({id:k.deal_id,report_type:k.report_type});
  updates.push({id:k.deal_id,properties:pr});
}
return [{json:{kind,pack_ref:meta.pack_ref,unsafe:kind!=='results',updates,handoff,issue_moves,read_inputs:handoff.map(h=>({id:h.id})).concat(issue_moves.map(m=>({id:m.id}))),jobs_ok:okc,jobs_failed:failed,all_failed_403:failed>0&&okc===0&&f403===failed,manifest_ok:mf.ok}}];`;

CODE.build_result_updates = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const o=$('Print outcome').first().json; const r=$input.first().json||{};
const stage=new Map((((r.body||{}).results)||[]).map(x=>[String(x.id),(x.properties||{}).dealstage]));
const im=new Map((o.issue_moves||[]).map(m=>[m.id,m.report_type]));
const upd=o.updates.map(u=>{ const t=im.get(String(u.id)); if(t&&stage.has(String(u.id))&&c.awaiting_print_stages.includes(stage.get(String(u.id)))) return {id:u.id,properties:{...u.properties,dealstage:c.issue_stages[t]}}; return u; });
for(const h of o.handoff){
  const pr={...h.properties};
  if(!stage.has(h.id)){ pr[F.hold]='true'; pr[F.issue]='Printed. The stage handoff was not applied because the deal could not be read. Use Resolve problem to hand off.'; }
  else if(c.awaiting_print_stages.includes(stage.get(h.id))||Object.values(c.issue_stages).includes(stage.get(h.id))){ pr.dealstage=(h.report_type==='PIP')?c.pip_invoicing_stage:c.completed_stage; }
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
    pr[F.issue]='The print run did not finish for this case within '+c.preparing_timeout_minutes+' minutes. Check the paper output and printer queue before any reprint, then use Print / reprint if needed.'; toIssue(p,pr);
    upd.push({id:String(d.id),properties:pr});
  }
}
const out=[]; for(let i=0;i<upd.length;i+=100) out.push({json:{inputs:upd.slice(i,i+100)}});
return out.length?out:[{json:{inputs:[]}}];`.replace('${HELPERS}', HELPERS);

// ------------------------------------------------------------------ staff actions (HubSpot is the only record)
CODE.read_request = String.raw`const c=$('Config').first().json.cfg; const F=c.fields;
const b=$('Config').first().json.body;
const events=Array.isArray(b)?b:[b||{}];
const ids=new Set();
for(const e of events){
  if(!e||typeof e!=='object') continue;
  if(e.subscriptionType){ // a HubSpot webhook event: only a Print action change counts, and "none" is our own reset
    if(!/^deal\./.test(String(e.subscriptionType))) continue;
    if(e.propertyName&&e.propertyName!==F.action) continue;
    if(e.propertyValue!==undefined&&String(e.propertyValue)===c.values.action_none) continue;
  }
  const id=String(e.objectId!==undefined?e.objectId:(e.deal_id!==undefined?e.deal_id:(e.hs_object_id!==undefined?e.hs_object_id:'')));
  if(/^\d+$/.test(id)) ids.add(id);
}
if(!ids.size){ if(events.some(e=>e&&e.subscriptionType)) return []; throw new Error('STAFF_REQUEST_INVALID: send a HubSpot webhook event or a body with deal_id'); }
return [...ids].map(id=>({json:{deal_id:id}}));`;

CODE.poll_requests = String.raw`const c=$('Config').first().json.cfg; const F=c.fields;
const ids=new Set();
for(const it of $input.all()){ const b=it.json.body&&it.json.body.results?it.json.body:it.json; for(const d of (b.results||[])){ const a=(d.properties||{})[F.action]; if(a&&a!==c.values.action_none) ids.add(String(d.id)); } }
return [...ids].map(id=>({json:{deal_id:id}}));`;

CODE.decide_staff = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
${HELPERS}
const decide=(deal)=>{
const p=deal.properties||{}; const id=String(deal.id);
const action=p[F.action]; if(!action||action===V.action_none) return [];
const note=String(p[F.request_note]||'').trim(); const st=p[F.status];
const reject=(why)=>{ const pr={}; pr[F.action]=V.action_none; pr[F.request_note]='REJECTED: '+why; return [{json:{deal_id:id,properties:pr}}]; };
if(c.cancelled_rejected_stages.includes(p.dealstage)) return reject('this deal is cancelled or rejected');
if(!note||note.startsWith('REJECTED:')) return reject('write a new Print request note explaining the request, then set Print action again');
const pr={}; pr[F.action]=V.action_none;
if(action===V.action_problem){
  pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]=note.slice(0,500); toIssue(p,pr);
} else if(action===V.action_resolve){
  if(!p[F.completed_at]) return reject('there is no successful print record on this deal, so the hold stays. Use Print / reprint if another copy is needed');
  pr[F.status]=V.printed; pr[F.issue]=''; pr[F.hold]='false'; handoff(p,pr);
} else if(action===V.action_manual){
  if(st===V.preparing||st===V.submitted) return reject('the earlier job may still be active. Check the printer queue and paper output first');
  if(st===V.printed) return reject('this case is already marked Printed');
  pr[F.status]=V.printed; pr[F.issue]=''; pr[F.hold]='false'; pr[F.completed_at]=nowISO; if(!p[F.job_ref]) pr[F.job_ref]='Manual'; handoff(p,pr);
} else if(action===V.action_print){
  if(st===V.preparing||st===V.submitted) return reject('the earlier job may still be active. Check the printer queue and paper output first');
  if(!st||st===V.queued) return reject('this case has not been printed yet or is already queued');
  pr[F.status]=V.queued; pr[F.hold]='true'; pr[F.queued_at]=nowISO; pr[F.issue]=''; pr[F.batch]=''; pr[F.job_ref]=''; pr[F.submitted_at]=''; pr[F.completed_at]=''; backToQueue(p,pr);
} else return reject('unknown Print action');
return [{json:{deal_id:id,properties:pr}}];
};
return $input.all().flatMap(it=>decide(it.json));`.replace('${HELPERS}', HELPERS);

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
if(!want||diff!==0) return [{json:{ok:false,status:422,msg:'link not valid'}}];
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
const names={P:'PIP',U:'UC',H:'HAA',D:'DLA'};
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

CODE.check_report = String.raw`const c=$('Config').first().json.cfg; const it=$input.first(); const r=it.json||{}; const sc=Number(r.statusCode||0);
const bad=(status,msg)=>[{json:{ok:false,retry:false,status,msg}}];
const again=(wait,status,msg)=>[{json:{ok:false,retry:true,wait,status,msg}}];
if(!sc) return bad(503,'EMR+ unreachable or not configured');
if(sc!==200){
  const n=$runIndex; // 0 = first answer, 1 = after the first retry, ...
  if(sc===429){ if(n<Number(c.emr_retry_429_max||0)) return again(Number(c.emr_retry_429_wait_seconds||60),503,'EMR+ rate limited, retrying'); return bad(503,'EMR+ rate limited (429) after retries'); }
  if(sc===500){ if(n<Number(c.emr_retry_500_max||0)) return again(Number(c.emr_retry_500_wait_seconds||30),502,'EMR+ internal error, retrying'); return bad(502,'EMR+ internal error (500) after retry'); }
  let said=''; try{ if(it.binary&&it.binary.data){ const eb=(await this.helpers.getBinaryDataBuffer(0,'data')).subarray(0,2000).toString('utf8'); let j=null; try{ j=JSON.parse(eb); }catch(e){} said=String(j?[j.error||j.code||'',j.message||j.detail||''].filter(Boolean).join(': '):eb).replace(/\s+/g,' ').trim().slice(0,160); } }catch(e){}
  const m={400:[400,'invalid case reference or missing deal id'],401:[403,'EMR+ refused access'],403:[403,'EMR+ refused access'],404:[404,'case not found or deal id mismatch'],409:[409,'report not completed, not available or too large']};
  const x=m[sc]||(sc>=500?[502,'EMR+ error']:[502,'unexpected EMR+ answer']); return bad(x[0],x[1]+(said?' - EMR+ said: '+said:''));
}
if(!it.binary||!it.binary.data) return bad(502,'EMR+ sent no file');
const maxMb=Number(c.max_report_mb||150); const maxB=maxMb*1000000; // decimal MB: the smaller reading of "150 MB", so nothing is passed on that either system could refuse
const hl=Number(((r.headers||{})['content-length'])||0);
if(hl>maxB) return bad(413,'report is '+(hl/1000000).toFixed(1)+' MB, over the limit of '+maxMb+' MB');
const ct=String((r.headers||{})['content-type']||'').toLowerCase();
// Large reports (about 90 MB seen on 25 Nov) are NOT read into the code node: loading them here crashed the node, so the gateway got a 500. The size and content type from EMR+'s headers are used instead; only small reports are also checked for the %PDF- marker.
const bigMb=Number(c.max_inspect_mb||20);
if(hl>bigMb*1000000){ if(ct.indexOf('application/pdf')<0) return bad(502,'EMR+ did not send a PDF'); return [{json:{ok:true,retry:false},binary:{data:it.binary.data}}]; }
const buf=await this.helpers.getBinaryDataBuffer(0,'data');
if(buf.length<6||buf.subarray(0,5).toString()!=='%PDF-') return bad(502,'EMR+ did not send a PDF');
if(buf.length>maxB) return bad(413,'report is '+(buf.length/1000000).toFixed(1)+' MB, over the limit of '+maxMb+' MB');
return [{json:{ok:true,retry:false},binary:{data:it.binary.data}}];`;

// ---------- dry run: stands in for the print gateway, sends nothing to the printer ----------
CODE.dry_run = String.raw`const c=$('Config').first().json.cfg; const F=c.fields, V=c.values;
const req=$input.first().json; const meta=req.meta; const jobs=req.body.jobs;
const res=new Map();
for(const j of jobs){
  let sc=0, size=0, pdf=false, said='';
  try{
    const r=await this.helpers.httpRequest({method:'GET',url:j.documentUrl,returnFullResponse:true,encoding:'arraybuffer',ignoreHttpStatusErrors:true,timeout:300000});
    sc=Number(r.statusCode||0); const b=Buffer.from(r.body||[]); size=b.length; pdf=size>5&&b.subarray(0,5).toString()==='%PDF-';
    if(sc!==200||!pdf) said=b.subarray(0,300).toString('utf8').replace(/\s+/g,' ').trim().slice(0,160);
  }catch(e){ said=String(e&&e.message||e).slice(0,160); }
  res.set(String(j.jobId),{ok:sc===200&&pdf,sc,size,said});
}
const mb=n=>(n/1048576).toFixed(2)+' MB';
const mf=res.get(String(meta.manifest_job_id))||{ok:false,sc:0,said:'no manifest'};
const inputs=[]; const lines=[];
for(const k of meta.cases){
  const r=res.get(String(k.job_id))||{ok:false,sc:0,size:0,said:'no result'};
  const pr={}; pr[F.batch]=''; pr[F.job_ref]=''; pr[F.submitted_at]=''; pr[F.completed_at]='';
  if(r.ok&&mf.ok){ pr[F.status]=V.queued; pr[F.hold]='true'; pr[F.issue]='DRY RUN OK: nothing was sent to the printer. Report fetched from EMR+ ('+mb(r.size)+') and would print to the destination shown. Set dry_run to false in Config to print for real.'; }
  else { pr[F.status]=V.issue; pr[F.hold]='true'; pr[F.issue]='DRY RUN FAILED (nothing was sent to the printer): '+(r.ok?'manifest sheet failed ('+mf.sc+' '+mf.said+')':'report link answered '+r.sc+(r.said?' - '+r.said:'')+((r.sc===400||r.sc===404)?' (check the medi ref and submission reference on the deal)':''))+'. Fix the cause, then use Print / reprint.'; }
  inputs.push({id:k.deal_id,properties:pr}); lines.push(k.deal_id+': '+pr[F.issue]);
}
return [{json:{dry_run:true,pack_ref:meta.pack_ref,inputs,summary:lines}}];`;

module.exports = CODE;

// Ops control: the "Print control" company in the ops portal. Blank property = use the Config value. Read once at run start.
// A ticked Print paused, or HubSpot not answering, ends the run quietly before anything is claimed (deals stay Queued) — except in dry run.
CODE.apply_control = String.raw`const c=JSON.parse(JSON.stringify($('Config').first().json.cfg));
const r=$input.first().json||{}; const sc=Number(r.statusCode||0); const p=(r.body||{}).properties;
const prev=$('Printer ready?').first().json;
if(sc!==200||!p){ if(c.dry_run===true) return [{json:{...prev,cfg:c,control_applied:['control unreadable (dry run)']}}]; return []; }
if(String(p.print_paused)==='true') return [];
const applied=[]; const has=v=>v!==null&&v!==undefined&&String(v).trim()!=='';
const tf={PIP:'printing_on_pip',UC:'printing_on_uc',HAA:'printing_on_hsa',DLA:'printing_on_dla'};
c.print_enabled={...(c.print_enabled||{})};
for(const [t,k] of Object.entries(tf)){ const v=String(p[k]); if(v==='true'||v==='false'){ c.print_enabled[t]=v==='true'; applied.push(k); } }
const num=(k,min,max,to)=>{ if(!has(p[k])) return; const n=Number(p[k]); if(Number.isInteger(n)&&n>=min&&n<=max){ c[to]=n; applied.push(k); } };
num('max_batches_per_run',0,1000,'max_batches_per_run'); num('max_reports_per_run',0,100000,'max_reports_per_run'); num('reports_per_call',1,24,'reports_per_call'); num('max_reports_per_day',0,100000,'max_reports_per_day');
return [{json:{...prev,cfg:c,control_applied:applied}}];`;

// Before every batch: still not paused? Passes the batch straight through. Paused or unreadable ends the run; the batch's deals are still Queued.
CODE.pause_check = String.raw`const pack=$('Next batch').first().json;
const c=$('Config').first().json.cfg;
const r=$input.first().json||{}; const sc=Number(r.statusCode||0); const p=(r.body||{}).properties;
if(c.dry_run===true) return [{json:pack}];
if(sc!==200||!p||String(p.print_paused)==='true') return [];
return [{json:pack}];`;
