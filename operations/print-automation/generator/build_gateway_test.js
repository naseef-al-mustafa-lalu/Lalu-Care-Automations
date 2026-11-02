// Generates the Cardiff gateway test pack: a file server workflow + a test runner workflow.
// Dummy one-page PDFs only. No claimant data. Run: node build_gateway_test.js
const fs = require('fs'); const path = require('path');
let n = 0; const uid = () => `t${String(++n).padStart(4, '0')}-0000-4000-8000-000000000000`;
const OUT = path.join(__dirname, '..', 'n8n');

// Minimal valid one-page PDF builder, shared by the server Code node (as source text) and the local check.
const PDF_FN = String.raw`function makePdf(lines){
  const esc=s=>String(s).replace(/[\\()]/g,'\\$&');
  let y=760, content='BT /F1 20 Tf 60 '+y+' Td ';
  lines.forEach((l,i)=>{ content+=(i?'0 -30 Td ':'')+'('+esc(l)+') Tj '; });
  content+='ET';
  const objs=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length '+Buffer.byteLength(content)+' >>\nstream\n'+content+'\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n'; const off=[];
  objs.forEach((o,i)=>{ off.push(Buffer.byteLength(pdf)); pdf+=(i+1)+' 0 obj\n'+o+'\nendobj\n'; });
  const x=Buffer.byteLength(pdf);
  pdf+='xref\n0 '+(objs.length+1)+'\n0000000000 65535 f \n'+off.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objs.length+1)+' /Root 1 0 R >>\nstartxref\n'+x+'\n%%EOF\n';
  return Buffer.from(pdf,'latin1');
}`;
module.exports = { PDF_FN };

const mk = (name, nodes, conns) => ({ name, nodes, connections: conns, active: false, settings: { executionOrder: 'v1', timezone: 'Europe/London', saveDataSuccessExecution: 'none' }, pinData: {}, tags: [] });
const node = (name, type, typeVersion, parameters, position, extra = {}) => ({ parameters, id: uid(), name, type, typeVersion, position, ...extra });
const wire = (c, ...names) => { for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }; };

// ===== 1. File server =====
const serverCode = String.raw`const t=$('Test file link').first().json.query?.t;
const secret='REPLACE_TEST_FILE_TOKEN';
if(t!==secret) return [{json:{denied:true}}];
const page=String($('Test file link').first().json.query?.page||'1');
const label=String($('Test file link').first().json.query?.label||'TEST');
${PDF_FN}
const buf=makePdf(['LALU PRINT GATEWAY TEST','Dummy page '+page+' ('+label+')','Non-sensitive. Safe to bin.','Sent '+new Date().toISOString()]);
const bin=await this.helpers.prepareBinaryData(buf,'test-'+page+'.pdf','application/pdf');
return [{json:{denied:false},binary:{data:bin}}];`;
const s = [
  node('Test file link', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'print-test-file', responseMode: 'responseNode', options: {} }, [0, 0], { notes: 'GET /webhook/print-test-file?t=<token>&page=1&label=A . Returns a dummy one-page PDF. Use the production URL (not test-url) so the gateway can fetch it.', notesInFlow: true }),
  node('Make dummy PDF', 'n8n-nodes-base.code', 2, { jsCode: serverCode }, [220, 0], { notes: 'Replace REPLACE_TEST_FILE_TOKEN with the same random value used in the runner Config.', notesInFlow: true }),
  node('Allowed?', 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: uid(), leftValue: '={{ $json.denied }}', rightValue: false, operator: { type: 'boolean', operation: 'equals' } }] }, options: {} }, [440, 0]),
  node('Send PDF', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'binary', inputDataFieldName: 'data', options: { responseCode: 200, responseHeaders: { entries: [{ name: 'Content-Type', value: 'application/pdf' }] } } }, [660, -80]),
  node('Not found', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: 'Not found', options: { responseCode: 404 } }, [660, 100])
];
const sc = {}; wire(sc, 'Test file link', 'Make dummy PDF', 'Allowed?');
sc['Allowed?'] = { main: [[{ node: 'Send PDF', type: 'main', index: 0 }], [{ node: 'Not found', type: 'main', index: 0 }]] };

// ===== 2. Test runner =====
const cfg = {
  gateway_base: 'http://10.28.1.140:8787',
  printer_queue: 'CRD-PRN-01-AUTO',
  n8n_public_base: 'REPLACE_N8N_PUBLIC_BASE',
  test_file_token: 'REPLACE_TEST_FILE_TOKEN',
  send_print_job: false,
  pages: 1,
  sha256_mode: 'empty'
};
const buildJob = String.raw`const c=$('Config').first().json.cfg;
const health=$input.first().json;
const hc=Number(health.statusCode||0);
const out={health_status_code:hc,health_body:health.body||null,health_error:health.error?.message||null};
if(hc!==200||!c.send_print_job) return [{json:{...out,print_skipped:true,reason:hc!==200?'health check failed':'send_print_job is false (health-only run)'}}];
const batchId='BATCH-N8N-TEST-'+new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14);
const jobs=[]; for(let i=1;i<=Number(c.pages);i++){
  jobs.push({jobId:'PRT-N8N-TEST-'+batchId.slice(-14)+'-'+i,documentUrl:c.n8n_public_base.replace(/\/$/,'')+'/webhook/print-test-file?t='+encodeURIComponent(c.test_file_token)+'&page='+i+'&label=ORDER-'+i,sha256:c.sha256_mode==='wrong'?'0'.repeat(64):'',printerQueue:c.printer_queue,copies:1,paperSize:'A4',colour:false,duplex:true});
}
return [{json:{...out,print_skipped:false,body:{requestType:jobs.length>1?'batch':'single',batchId,submittedBy:'n8n-test',jobs},started_ms:Date.now()}}];`;
const summarise = String.raw`const r=$input.first().json; const prev=$('Build test job').first().json;
const ms=Date.now()-Number(prev.started_ms||Date.now());
return [{json:{summary:{http_status:Number(r.statusCode||0),seconds_taken:Math.round(ms/100)/10,gateway_response:r.body||null,error:r.error?.message||null,batchId:prev.body?.batchId,jobs_sent:prev.body?.jobs?.length},what_to_note:'Check: did it print? order of pages? time taken? failure detail? (see README, gateway test)'}}];`;
const r = [
  node('Run test', 'n8n-nodes-base.manualTrigger', 1, {}, [0, 0]),
  node('Config', 'n8n-nodes-base.set', 3.4, { mode: 'raw', jsonOutput: JSON.stringify({ cfg }, null, 2), includeOtherFields: true, options: {} }, [220, 0], { notes: 'send_print_job=false: health check only (safe). Set true for a real test page. pages: 1 to 3 (use 3 to test order). sha256_mode: empty | wrong.', notesInFlow: true }),
  node('Gateway health', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: "={{ $('Config').first().json.cfg.gateway_base + '/health' }}", authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [440, 0], { onError: 'continueRegularOutput', notes: 'Header Auth credential: name X-Print-Agent-Token, value = the gateway token.', notesInFlow: true }),
  node('Build test job', 'n8n-nodes-base.code', 2, { jsCode: buildJob }, [660, 0]),
  node('Send test page?', 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: uid(), leftValue: '={{ $json.print_skipped }}', rightValue: false, operator: { type: 'boolean', operation: 'equals' } }] }, options: {} }, [880, 0]),
  node('Submit to gateway', 'n8n-nodes-base.httpRequest', 4.2, { method: 'POST', url: "={{ $('Config').first().json.cfg.gateway_base + '/print-jobs' }}", authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.body }}', options: { timeout: 300000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [1100, -80], { onError: 'continueRegularOutput', notes: 'NO retries on purpose: a retry could print twice.', notesInFlow: true }),
  node('Summarise result', 'n8n-nodes-base.code', 2, { jsCode: summarise }, [1320, -80]),
  node('Health-only result', 'n8n-nodes-base.noOp', 1, {}, [1100, 100], { notes: 'Read this output: health_status_code and health_body show what /health returns.', notesInFlow: true })
];
const rc = {}; wire(rc, 'Run test', 'Config', 'Gateway health', 'Build test job', 'Send test page?');
rc['Send test page?'] = { main: [[{ node: 'Submit to gateway', type: 'main', index: 0 }], [{ node: 'Health-only result', type: 'main', index: 0 }]] };
wire(rc, 'Submit to gateway', 'Summarise result');

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'Lalu_Print_Test_File_Server.json'), JSON.stringify(mk('Lalu Print - Test file server', s, sc), null, 2));
  fs.writeFileSync(path.join(OUT, 'Lalu_Print_Gateway_Test.json'), JSON.stringify(mk('Lalu Print - Gateway test', r, rc), null, 2));
  console.log('written');
}
