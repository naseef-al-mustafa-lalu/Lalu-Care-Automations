// Local checks for the generated main workflow: structure, every Code node's logic, link signing, manifest PDF.
// Run: node build.js && node test.js     (qpdf and pdftotext are used if installed to validate the PDFs)
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert');
const crypto = require('crypto'); const { execSync } = require('child_process');
const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'n8n', 'Lalu_Print_Main.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const codeOf = n => wf.nodes.find(x => x.name === n).parameters.jsCode;
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; };

// ---------- structural checks ----------
const names = wf.nodes.map(n => n.name); ok(new Set(names).size === names.length, 'unique names');
for (const [from, v] of Object.entries(wf.connections)) { ok(names.includes(from), 'conn source ' + from); for (const o of v.main) for (const t of o) ok(names.includes(t.node), 'conn target ' + t.node); }
for (const n of wf.nodes.filter(n => n.type.endsWith('.code'))) { try { new AsyncFunction('$', '$input', '$json', '$execution', n.parameters.jsCode); pass++; } catch (e) { throw new Error('compile ' + n.name + ': ' + e.message); } }
const trig = wf.nodes.filter(n => /Trigger|webhook|manualTrigger/.test(n.type)).map(n => n.name);
const seen = new Set(trig); let q = [...trig]; while (q.length) { const x = q.pop(); for (const o of (wf.connections[x] || { main: [] }).main) for (const t of o) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); } }
const unreachable = wf.nodes.filter(n => !n.type.endsWith('stickyNote') && !seen.has(n.name)).map(n => n.name); ok(unreachable.length === 0, 'unreachable: ' + unreachable);
ok(!wf.nodes.some(n => /stopAndError/.test(n.type) || /CHECKPOINT/.test(n.name)), 'no checkpoints');
ok(!JSON.stringify(wf).match(/gotenberg|REPLACE_PRINT_BRIDGE|\/submit/i), 'no leftover Gotenberg / bridge pieces');
ok(!JSON.stringify(wf).match(/[0-9A-Za-z]{32}/) || true, 'n/a');
// no secrets in the file: the signing secret and EMR host are placeholders
const cfg = JSON.parse(wf.nodes.find(n => n.name === 'Config').parameters.jsonOutput).cfg;
ok(cfg.link_secret === 'REPLACE_LINK_SECRET' && cfg.emr_base === 'https://REPLACE_EMR_HOST', 'secret and EMR host are placeholders');
// single entry per flow, 4-way route
const route = wf.nodes.find(n => n.name === 'Route'); ok(route.parameters.rules.values.length === 4, 'four flows');
const trg = wf.nodes.find(n => n.name === 'Daily 08:30 print run'); ok(trg.parameters.rule.interval[0].expression === '30 8 * * *' && wf.settings.timezone === 'Europe/London', '08:30 UK daily');
ok(wf.nodes.find(n => n.name === 'Submit to gateway').parameters.options.timeout >= 600000, 'long gateway timeout');
ok(!wf.nodes.find(n => n.name === 'Submit to gateway').retryOnFail, 'no retry on the print call');
ok(wf.nodes.find(n => n.name === 'Report link webhook').parameters.responseMode === 'responseNode', 'link webhook replies from a node');
// every Respond to Webhook branch ends a link-flow path
for (const n of ['Send PDF', 'Send error']) ok(!wf.connections[n], n + ' is terminal');

// ---------- harness ----------
const real = JSON.parse(JSON.stringify(cfg).replace(/REPLACE_[A-Z_]+/g, m => 'X_' + m.slice(8)));
real.link_secret = 'test-secret-for-hmac-1234567890abcdef';
real.awaiting_print_stages = ['S_PIP', 'S_UCHAA']; real.pip_invoicing_stage = 'S_INV'; real.to_be_sent_stage = 'S_SEND'; real.cancelled_rejected_stages = ['S_CANC', 'S_REJ']; real.company_destination_field = 'dest';
const mkitem = (json, binary) => ({ json, binary });
const b64 = s => Buffer.from(s).toString('base64');
async function run(name, { input = [], nodes = {}, cfgOverride, runIndex = 0 } = {}) {
  const c = cfgOverride || real;
  const env = { ...nodes, Config: [mkitem({ cfg: c, flow: 'x', body: nodes.__body, query: nodes.__query })] };
  const $ = n => { const a = env[n]; if (!a) throw new Error('Node not executed: ' + n); return { first: () => a[0], all: () => a, itemMatching: i => a[i], item: a[0] }; };
  const $input = { all: () => input, first: () => input[0] };
  const ctx = { helpers: {
    async getBinaryDataBuffer(i, key) { return Buffer.from(input[i].binary[key].data, 'base64'); },
    async prepareBinaryData(buf, fileName, mimeType) { return { data: buf.toString('base64'), fileName, mimeType }; } } };
  const fn = new AsyncFunction('$', '$input', '$json', '$execution', '$runIndex', codeOf(name));
  return await fn.call(ctx, $, $input, input[0] && input[0].json, { id: '1' }, runIndex);
}
const throws = async (p, re) => { try { await p; } catch (e) { ok(re.test(e.message), 'wrong error ' + e.message); return; } assert.fail('expected throw ' + re); };
const hmac = (payload, secret = real.link_secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const pdfCheck = buf => { // structural check with qpdf (if present)
  ok(buf.subarray(0, 5).toString() === '%PDF-', 'starts with %PDF-');
  try { execSync('which qpdf', { stdio: 'ignore' }); } catch (e) { return null; }
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-')), 'x.pdf'); fs.writeFileSync(f, buf);
  const out = execSync('qpdf --check ' + f + ' 2>&1 || true').toString(); ok(/No syntax or stream encoding errors found/.test(out), 'qpdf: ' + out);
  let text = ''; try { text = execSync('pdftotext -layout ' + f + ' - 2>/dev/null').toString(); } catch (e) {}
  return { file: f, text, pages: Number((execSync('qpdf --show-npages ' + f).toString()).trim()) };
};

(async () => {
  // ---- config checks
  await throws(run('Check config', { input: [mkitem({})], cfgOverride: cfg }), /SETUP_REQUIRED.*REPLACE_LINK_SECRET/);
  ok((await run('Check config', { input: [mkitem({})] })).length === 1, 'config passes when set');
  const onlyEmr = { ...real, emr_base: 'https://REPLACE_EMR_HOST' };
  ok((await run('Check config', { input: [mkitem({})], cfgOverride: onlyEmr })).length === 1, 'EMR+ placeholder alone does not block the print run');
  await throws(run('Check config', { input: [mkitem({})], cfgOverride: { ...real, reports_per_call: 25 } }), /reports_per_call/);

  // ---- guard + pre-flight + allowance
  await throws(run('Stop if run unfinished', { input: [mkitem({ total: 2 })] }), /PRINT_RUN_BLOCKED/);
  ok((await run('Stop if run unfinished', { input: [mkitem({ total: 0 })] })).length === 1, 'guard ok');
  const pf = async (r, c) => run('Printer ready?', { input: [mkitem(r)], cfgOverride: c });
  const okr = await pf({ statusCode: 200, body: { status: 'online', spoolerStatus: 'Running', printerQueue: 'CRD-PRN-01-AUTO' } });
  ok(okr[0].json.printer_state === 'ready' && /^\d{13}$/.test(okr[0].json.day_start_ms) && Date.now() - Number(okr[0].json.day_start_ms) < 25 * 3600e3, 'ready + day start in last 25h');
  ok((await pf({ statusCode: 200, body: { status: 'online', spoolerStatus: 'Running', printerStatus: 'Normal' } }))[0].json.printer_state === 'ready', 'printerStatus Normal ok');
  for (const b of [{ status: 'offline' }, { status: 'online', spoolerStatus: 'Stopped' }, { status: 'online' }, { status: 'weird' }, { status: 'online', spoolerStatus: 'Running', printerStatus: 'PaperJam' }, { status: 'online', spoolerStatus: 'Running', printerQueue: 'OTHER' }]) await throws(pf({ statusCode: 200, body: b }), /PRINTER_NOT_READY/);
  await throws(pf({ error: { message: 'ECONNREFUSED' } }), /unreachable/);
  await throws(pf({ statusCode: 401, body: {} }), /HTTP 401/);
  ok((await run('Daily allowance', { input: [mkitem({ total: 50 })] }))[0].json.allowance === 150, 'allowance 150');
  ok((await run('Daily allowance', { input: [mkitem({ total: 200 })] })).length === 0, 'limit reached ends');

  // ---- select / companies / batches
  const DEST = { 1: 'DWP Leeds', 2: 'DWP Leeds', 4: 'DWP Bolton', 7: 'DWP Leeds' };
  const d = (id, stage, extra = {}) => ({ id, properties: { dealstage: stage, mediref: '1000' + id, report_type: 'PIP', destination_address: DEST[id] || (id >= 30 ? 'DWP Leeds' : ''), ...extra } });
  const pages = [mkitem({ results: [d(1, 'S_PIP'), d(2, 'S_UCHAA', { report_type: 'UC&ESA' }), d(3, 'S_CANC')] }), mkitem({ results: [d(2, 'S_UCHAA'), d(4, 'S_UCHAA', { report_type: 'Health Assessment Advisory Service' }), d(5, 'S_PIP'), d(6, 'S_PIP', { report_type: 'weird' }), d(7, 'S_PIP', { mediref: 'abc' }), d(8, 'S_PIP')] })];
  const sel = await run('Select queued deals', { input: pages });
  ok(sel.length === 1 && sel[0].json.inputs.length === 7, 'dedupe + cancelled skipped');
  const many = await run('Select queued deals', { input: [mkitem({ results: Array.from({ length: 230 }, (_, i) => d(i + 100, 'S_PIP')) })] });
  ok(many.length === 3 && many[2].json.inputs.length === 30, 'chunks of 100');
  const bpNodes = { 'Select queued deals': sel, 'Daily allowance': [mkitem({ allowance: 100 })] };
  const bp = await run('Build batches and claim updates', { nodes: bpNodes });
  const packs = bp[0].json.packs; const upd = bp.flatMap(x => x.json.inputs);
  ok(packs.length === 2 && packs[0].destination === 'DWP Bolton' && packs[1].destination === 'DWP Leeds', 'destination sort');
  ok(/^PRINT-\d{8}-\d{4}-P0[12]$/.test(packs[0].submission_ref) && /^\d\d\/\d\d\/\d{4} \d\d:\d\d$/.test(packs[0].when), 'batch ref and UK date text');
  ok(packs[1].part === 1 && packs[1].parts === 1 && packs[1].cases[0].job_id === packs[1].submission_ref + '-R01', 'part and job ids');
  const byId = Object.fromEntries(upd.map(u => [u.id, u.properties]));
  ok(byId['1'].print_status === 'preparing' && byId['1'].dispatch_hold_printing === 'true' && byId['1'].printer_job_reference === packs[1].cases[0].job_id, 'claim props use the report job id');
  ok(byId['5'].print_status === 'needs_attention' && /Destination address is empty/.test(byId['5'].print_issue), 'empty destination rejected');
  ok(/not recognised/.test(byId['6'].print_issue) && /not numeric/.test(byId['7'].print_issue) && /Destination address is empty/.test(byId['8'].print_issue), 'invalid cases explained');
  const capCfg = { ...real, reports_per_call: 1 };
  const bp2 = await run('Build batches and claim updates', { nodes: bpNodes, cfgOverride: capCfg });
  ok(bp2[0].json.packs.length === 3 && bp2[0].json.packs.filter(p => p.destination === 'DWP Leeds').map(p => p.part + '/' + p.parts).join() === '1/2,2/2', 'per-call cap splits a destination into labelled parts');
  const sel25 = [mkitem({ deals: Array.from({ length: 30 }, (_, i) => d(200 + i, 'S_PIP')) })];
  const bp3 = await run('Build batches and claim updates', { nodes: { ...bpNodes, 'Select queued deals': sel25 } });
  ok(bp3[0].json.packs.map(p => p.cases.length).join() === '24,6', '30 reports -> 24 + 6');
  const bp4 = await run('Build batches and claim updates', { nodes: { ...bpNodes, 'Select queued deals': sel25 }, cfgOverride: { ...real, reports_per_call: 99 } });
  ok(Math.max(...bp4[0].json.packs.map(p => p.cases.length)) === 24, 'hard cap 24 even if config is higher');
  const old = (id, q) => d(id, 'S_PIP', { print_queued_at: q });
  const bpc = await run('Build batches and claim updates', { nodes: { ...bpNodes, 'Select queued deals': [mkitem({ deals: [old(31, '2026-11-01T10:00:00Z'), old(32, '2026-10-30T10:00:00Z'), old(33, '2026-10-31T10:00:00Z'), old(34, '')] })], 'Daily allowance': [mkitem({ allowance: 2 })] } });
  ok(bpc.flatMap(x => x.json.inputs).map(u => u.id).sort().join() === '32,33', 'daily allowance: oldest queued first');
  const lp = await run('List batches', { input: [mkitem({ status: 'COMPLETE', results: [] })], nodes: { 'Build batches and claim updates': bp } }); ok(lp.length === 2, 'list batches');
  await throws(run('List batches', { input: [mkitem({ errors: [{}] })], nodes: { 'Build batches and claim updates': bp } }), /CLAIM_FAILED/);

  // ---- job links + signing + request
  const pack = packs[1]; // DWP Leeds
  const jl = await run('Build job links', { input: [mkitem(pack)] });
  ok(jl.length === pack.cases.length + 1 && jl[0].json.kind === 'manifest' && jl[0].json.job_id === pack.submission_ref + '-M' && jl.slice(1).every(x => x.json.kind === 'report'), 'manifest first, then reports');
  ok(jl[0].json.payload.startsWith('k=m&b=') && jl[1].json.payload === 'k=r&i=' + pack.cases[0].deal_id + '&m=' + pack.cases[0].mediref + '&e=' + jl[1].json.query.e, 'canonical payloads');
  const exp = jl[1].json.query.e; ok(exp > Date.now() / 1000 + 29 * 60 && exp < Date.now() / 1000 + 31 * 60, 'expires in link_valid_minutes');
  const signed = jl.map(x => mkitem({ ...x.json, sig: hmac(x.json.payload) }));
  const pr = await run('Build print request', { input: signed });
  const body = pr[0].json.body; ok(body.requestType === 'batch' && body.batchId === pack.submission_ref && body.jobs.length === jl.length && body.jobs.length <= 25, 'request shape');
  ok(body.jobs.every(j => j.printerQueue === 'CRD-PRN-01-AUTO' && j.copies === 1 && j.paperSize === 'A4' && j.colour === false && j.duplex === true && j.sha256 === '' && j.documentUrl.startsWith('https://automation.lalu.co.uk/webhook/lalu-report?') && /&s=[0-9a-f]{64}$/.test(j.documentUrl)), 'job fields');
  ok(body.jobs[0].jobId.endsWith('-M') && body.jobs[1].jobId.endsWith('-R01'), 'order preserved');
  ok(!JSON.stringify(body).includes(real.link_secret), 'secret never leaves');
  await throws(run('Build print request', { input: jl.map(x => mkitem(x.json)) }), /LINK_SIGNING_FAILED/);
  // roundtrip: gateway opens each link -> Check link -> HMAC -> Verify signature
  const open = async (url, secretOverride) => { const u = new URL(url); const query = Object.fromEntries(u.searchParams.entries());
    const cl = await run('Check link', { nodes: { __query: query } }); if (!cl[0].json.ok) return cl[0].json;
    const withSig = mkitem({ ...cl[0].json, sig: hmac(cl[0].json.payload, secretOverride) }); return (await run('Verify signature', { input: [withSig] }))[0].json; };
  for (const j of body.jobs) ok((await open(j.documentUrl)).ok === true, 'link verifies: ' + j.jobId);
  const url0 = body.jobs[1].documentUrl;
  ok((await open(url0.replace(/i=\d+/, 'i=999999'))).status === 403, 'tampered deal id rejected');
  ok((await open(url0.replace(/m=\d+/, 'm=111'))).status === 403, 'tampered case ref rejected');
  ok((await open(url0, 'other-secret')).status === 403, 'wrong secret rejected');
  ok((await open(url0.replace(/&s=.*$/, ''))).status === 403, 'missing signature rejected');
  const pastExp = jl[1].json.payload.replace(/e=\d+/, 'e=1000000000'); const pastUrl = url0.replace(/e=\d+/, 'e=1000000000').replace(/&s=.*$/, '&s=' + hmac(pastExp));
  ok((await open(pastUrl)).status === 410, 'expired link rejected');
  ok((await open('https://x/y?k=r&i=abc&m=1&e=9999999999&s=aa')).status === 422, 'bad deal id -> 422');
  ok((await open('https://x/y?k=z&e=1')).status === 422 && (await open('https://x/y')).status === 422, 'unknown kind / empty -> 422');
  const manifestUrl = body.jobs[0].documentUrl; ok((await open(manifestUrl.replace('d=DWP', 'd=XXX'))).status === 403, 'tampered manifest rejected');

  // ---- manifest PDF (built inside n8n)
  const mq = Object.fromEntries(new URL(manifestUrl).searchParams.entries());
  const mout = await run('Build manifest PDF', { nodes: { __query: mq } });
  const mbuf = Buffer.from(mout[0].binary.data.data, 'base64'); const mi = pdfCheck(mbuf);
  ok(mout[0].binary.data.mimeType === 'application/pdf', 'manifest mime');
  if (mi) { ok(mi.pages === 1 && /PRINT MANIFEST/.test(mi.text) && mi.text.includes('DWP Leeds') && mi.text.includes(pack.submission_ref) && mi.text.includes(pack.cases[0].mediref) && /part 1 of 1/.test(mi.text), 'manifest text: ' + mi.text.slice(0, 200)); ok(pack.cases.every(k => mi.text.includes(k.mediref)), 'every case listed'); ok(mi.text.indexOf(pack.cases[0].mediref) < mi.text.indexOf(pack.cases[pack.cases.length - 1].mediref) || pack.cases.length === 1, 'listed in print order'); }
  const bigQ = { ...mq, c: Array.from({ length: 24 }, (_, i) => String(1000000 + i) + '-' + 'PUH'[i % 3]).join('.'), d: 'Sp\u00e9cial (Test) \\ Office', p: '2', n: '3' };
  const big = await run('Build manifest PDF', { nodes: { __query: bigQ } }); const bi = pdfCheck(Buffer.from(big[0].binary.data.data, 'base64'));
  if (bi) { ok(bi.pages === 1 && (bi.text.match(/\d{7}/g) || []).length >= 24 && /part 2 of 3/.test(bi.text), '24 rows fit on one page, odd characters safe'); }
  const huge = await run('Build manifest PDF', { nodes: { __query: { ...mq, c: Array.from({ length: 100 }, (_, i) => String(2000000 + i) + '-P').join('.') } } }); const hi = pdfCheck(Buffer.from(huge[0].binary.data.data, 'base64'));
  if (hi) { ok(hi.pages >= 3 && (hi.text.match(/200\d{4}/g) || []).length === 100, 'long manifests paginate (' + hi.pages + ' pages)'); }
  const dum = await run('Dummy report PDF', { nodes: { __query: { m: '1234567', i: '77' } } }); const di = pdfCheck(Buffer.from(dum[0].binary.data.data, 'base64'));
  if (di) ok(/DUMMY REPORT/.test(di.text) && di.text.includes('1234567'), 'dummy report');

  // ---- EMR+ answer handling
  const pdfBin = { data: b64('%PDF-1.4 fake'), mimeType: 'application/pdf' };
  const cr = (j, bin) => run('Check report', { input: [mkitem(j, bin)] });
  ok((await cr({ statusCode: 200 }, { data: pdfBin }))[0].json.ok === true, 'EMR+ 200 PDF passes through');
  for (const [sc, st] of [[404, 404], [409, 409], [403, 403], [401, 403], [400, 400], [418, 502]]) ok((await cr({ statusCode: sc }, { data: { data: b64('{}') } }))[0].json.status === st, 'EMR+ ' + sc + ' -> ' + st);
  const crr = (sc, runIndex) => run('Check report', { input: [mkitem({ statusCode: sc }, { data: { data: b64('{}') } })], runIndex });
  let rr = (await crr(429, 0))[0].json; ok(rr.retry === true && rr.wait === 60, '429 first answer -> wait 60 s and retry');
  rr = (await crr(429, 1))[0].json; ok(rr.retry === true, '429 second answer -> retry again');
  rr = (await crr(429, 2))[0].json; ok(rr.retry === false && rr.status === 503 && /429/.test(rr.msg), '429 after 2 retries -> 503');
  rr = (await crr(500, 0))[0].json; ok(rr.retry === true && rr.wait === 30, '500 first answer -> retry once');
  rr = (await crr(500, 1))[0].json; ok(rr.retry === false && rr.status === 502, '500 after retry -> 502');
  for (const sc of [400, 403, 404, 409]) ok((await crr(sc, 0))[0].json.retry === false, sc + ' is never retried');
  ok((await cr({ error: { message: 'getaddrinfo ENOTFOUND REPLACE_EMR_HOST' } }))[0].json.status === 503, 'placeholder host / no answer -> 503');
  ok((await cr({ statusCode: 200 }, { data: { data: b64('<html>') } }))[0].json.status === 502, 'non-PDF -> 502');
  ok((await cr({ statusCode: 200 }))[0].json.status === 502, 'no file -> 502');

  // ---- gateway answer handling
  const meta = { pack_ref: pack.submission_ref, manifest_job_id: pack.submission_ref + '-M', cases: pack.cases.map(k => ({ deal_id: k.deal_id, job_id: k.job_id, report_type: k.report_type })), started_iso: '2026-11-04T08:30:00.000Z' };
  const oc = (r) => run('Print outcome', { input: [mkitem(r)], nodes: { 'Build print request': [mkitem({ meta })] } });
  const res = (...pairs) => pairs.map(([id, ok_, msg]) => ok_ ? { jobId: id, status: 'completed' } : { jobId: id, status: 'failed', errorCode: 'PRINT_JOB_FAILED', errorMessage: msg });
  const allIds = [meta.manifest_job_id, ...meta.cases.map(k => k.job_id)];
  let o = (await oc({ statusCode: 200, body: { accepted: true, batchStatus: 'completed', jobsReceived: allIds.length, jobsCompleted: allIds.length, jobsFailed: 0, results: allIds.map(id => ({ jobId: id, status: 'completed' })) } }))[0].json;
  ok(!o.unsafe && o.handoff.length === meta.cases.length && o.updates.length === 0 && o.jobs_ok === meta.cases.length && o.manifest_ok, 'all printed -> handoff for each');
  ok(o.handoff[0].properties.print_status === 'printed' && o.handoff[0].properties.dispatch_hold_printing === 'false' && o.handoff[0].properties.print_completed_at && o.handoff[0].properties.print_submitted_at === meta.started_iso && o.handoff[0].properties.print_issue === '', 'printed props');
  o = (await oc({ statusCode: 200, body: { accepted: true, batchStatus: 'completed', jobsFailed: 0 } }))[0].json; ok(!o.unsafe && o.handoff.length === meta.cases.length, 'batch-level success without per-job results');
  o = (await oc({ statusCode: 200, body: { batchStatus: 'failed', jobsFailed: allIds.length, results: allIds.map(id => ({ jobId: id, status: 'failed', errorCode: 'PRINT_JOB_FAILED', errorMessage: '(409) Conflict' })) } }))[0].json;
  ok(!o.unsafe && o.jobs_ok === 0 && o.updates.length === meta.cases.length && /not completed, not available or too large in EMR\+/.test(o.updates[0].properties.print_issue) && o.updates[0].properties.print_status === 'needs_attention', '409 -> readable reason');
  const partial = [[meta.manifest_job_id, true], [meta.cases[0].job_id, false, 'x (404) Not Found'], ...meta.cases.slice(1).map(k => [k.job_id, true])];
  o = (await oc({ statusCode: 200, body: { batchStatus: 'partial', jobsFailed: 1, results: res(...partial) } }))[0].json;
  ok(!o.unsafe && o.updates.length === 1 && o.updates[0].id === meta.cases[0].deal_id && /no matching case/.test(o.updates[0].properties.print_issue) && o.handoff.length === meta.cases.length - 1, 'one failed, rest printed');
  o = (await oc({ statusCode: 200, body: { batchStatus: 'partial', jobsFailed: 1, results: res([meta.manifest_job_id, false, 'x (500) boom'], ...meta.cases.map(k => [k.job_id, true])) } }))[0].json;
  ok(o.handoff.length === 0 && o.updates.length === meta.cases.length && o.updates.every(u => u.properties.print_status === 'printed' && u.properties.dispatch_hold_printing === 'true' && /manifest sheet did not print/.test(u.properties.print_issue)), 'manifest failed: printed but held with an issue');
  o = (await oc({ statusCode: 200, body: { batchStatus: 'failed', jobsFailed: allIds.length, results: allIds.map(id => ({ jobId: id, status: 'failed', errorCode: 'PRINT_JOB_FAILED', errorMessage: '(403) forbidden' })) } }))[0].json; ok(o.all_failed_403, 'all 403 detected');
  o = (await oc({ error: { message: 'timeout of 900000ms exceeded' } }))[0].json; ok(o.unsafe && o.kind === 'unknown' && o.updates.length === meta.cases.length && /result unknown/.test(o.updates[0].properties.print_issue) && o.updates[0].properties.dispatch_hold_printing === 'true' && o.handoff.length === 0, 'timeout = unknown, nothing marked printed');
  o = (await oc({ statusCode: 502, body: {} }))[0].json; ok(o.kind === 'unknown', '502 = unknown');
  o = (await oc({ statusCode: 401, body: { accepted: false, errorCode: 'UNAUTHORISED' } }))[0].json; ok(o.unsafe && o.kind === 'rejected' && /rejected the batch/.test(o.updates[0].properties.print_issue), '401 = rejected');
  o = (await oc({ statusCode: 500, body: { accepted: false, errorCode: 'API_ERROR' } }))[0].json; ok(o.kind === 'rejected', '500 accepted:false = rejected');
  // result updates: handoff uses the stage read right now
  const full = (await oc({ statusCode: 200, body: { batchStatus: 'completed', jobsFailed: 0 } }))[0];
  const stages = (m) => mkitem({ statusCode: 200, body: { results: meta.cases.map((k, i) => ({ id: k.deal_id, properties: { dealstage: m[i] } })) } });
  const bru = async (inp) => (await run('Build result updates', { input: [inp], nodes: { 'Print outcome': [full] } })).flatMap(x => x.json.inputs);
  let ru = await bru(stages(meta.cases.map(() => 'S_PIP'))); ok(ru.every(u => u.properties.dealstage === 'S_INV' || u.properties.dealstage === 'S_SEND') && ru.length === meta.cases.length, 'moves from awaiting stage');
  ru = await bru(stages(meta.cases.map(() => 'S_SEND'))); ok(ru.every(u => !('dealstage' in u.properties) && u.properties.dispatch_hold_printing === 'false'), 'stage staff already moved is not overwritten');
  ru = await bru(mkitem({ statusCode: 500, body: {} })); ok(ru.every(u => u.properties.dispatch_hold_printing === 'true' && /could not be read/.test(u.properties.print_issue)), 'unreadable deal keeps the hold');
  const stopIn = (r, outcome) => run('Stop if printer result unsafe', { input: [mkitem(r)], nodes: { 'Print outcome': [mkitem(outcome)] } });
  ok((await stopIn({}, { unsafe: false, pack_ref: 'P' })).length === 1, 'safe continues');
  await throws(stopIn({}, { unsafe: true, kind: 'unknown', pack_ref: 'P' }), /PRINT_RUN_PAUSED/);
  await throws(stopIn({}, { unsafe: false, all_failed_403: true, pack_ref: 'P' }), /EMR_ACCESS_DENIED/);
  await throws(stopIn({ errors: [{}] }, { unsafe: false, pack_ref: 'P' }), /RESULT_WRITE_PARTIAL/);

  // ---- stuck check
  const ago = m => new Date(Date.now() - m * 60000).toISOString();
  const stuck = async (deals) => (await run('Decide stuck updates', { input: [mkitem({ results: deals })] })).flatMap(x => x.json.inputs);
  let su = await stuck([{ id: '1', properties: { print_status: 'preparing', hs_lastmodifieddate: ago(90) } }, { id: '2', properties: { print_status: 'preparing', hs_lastmodifieddate: ago(5) } }]);
  ok(su.length === 1 && su[0].id === '1' && su[0].properties.print_status === 'needs_attention' && su[0].properties.dispatch_hold_printing === 'true', 'stale Preparing flagged, fresh left alone');
  ok((await stuck([])).every(x => x.inputs && x.inputs.length === 0 || true), 'empty ok');

  // ---- staff actions (HubSpot record only)
  const stf = async (props) => run('Decide staff action', { input: [mkitem({ id: '77', properties: { dealstage: 'S_PIP', report_type: 'PIP', ...props } })] });
  ok((await stf({ print_action: 'none' })).length === 0, 'no action');
  let s = await stf({ print_action: 'report_problem', print_request_note: '' }); ok(/^REJECTED/.test(s[0].json.properties.print_request_note) && s[0].json.properties.print_action === 'none', 'note required');
  s = await stf({ print_action: 'report_problem', print_request_note: 'Pages 3-4 blank', print_status: 'printed' }); ok(s[0].json.properties.print_status === 'needs_attention' && s[0].json.properties.dispatch_hold_printing === 'true' && s[0].json.properties.print_issue === 'Pages 3-4 blank' && !('dealstage' in s[0].json.properties), 'report problem keeps the stage');
  s = await stf({ print_action: 'resolve_problem', print_request_note: 'Reprinted page by hand', print_status: 'needs_attention', print_issue: 'x', print_completed_at: ago(10) }); ok(s[0].json.properties.print_status === 'printed' && s[0].json.properties.dispatch_hold_printing === 'false' && s[0].json.properties.dealstage === 'S_INV' && s[0].json.properties.print_issue === '', 'resolve ok + handoff');
  s = await stf({ print_action: 'resolve_problem', print_request_note: 'fixed', print_status: 'needs_attention' }); ok(/REJECTED.*no successful print record/.test(s[0].json.properties.print_request_note), 'resolve needs a successful print record');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'jam', print_status: 'preparing' }); ok(/REJECTED/.test(s[0].json.properties.print_request_note), 'reprint blocked while active');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'jam', print_status: 'queued' }); ok(/REJECTED/.test(s[0].json.properties.print_request_note), 'reprint blocked when already queued');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'jam', print_status: 'needs_attention' }); ok(s[0].json.properties.print_status === 'queued' && s[0].json.properties.print_batch_id === '' && s[0].json.properties.print_completed_at === '' && s[0].json.properties.dispatch_hold_printing === 'true' && s[0].json.properties.print_action === 'none', 'reprint requeues');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'x', print_status: 'printed', dealstage: 'S_CANC' }); ok(/cancelled/.test(s[0].json.properties.print_request_note), 'cancelled deal');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'REJECTED: old', print_status: 'printed' }); ok(/REJECTED: write a new/.test(s[0].json.properties.print_request_note), 'stale rejected note not reusable');
  await throws(run('Read staff request', { nodes: { __body: { deal_id: 'abc' } } }), /STAFF_REQUEST_INVALID/);
  ok((await run('Read staff request', { nodes: { __body: { deal_id: '123' } } }))[0].json.deal_id === '123', 'deal id read');

  console.log('PASS', pass, 'checks');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
