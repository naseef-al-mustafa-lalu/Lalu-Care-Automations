const fs = require('fs'); const assert = require('assert');
const wf = JSON.parse(fs.readFileSync(require('path').join(__dirname,'..','n8n','Lalu_Print_Main.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const codeOf = n => wf.nodes.find(x => x.name === n).parameters.jsCode;
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; };

// ---------- structural checks ----------
const names = wf.nodes.map(n => n.name); ok(new Set(names).size === names.length, 'unique names');
for (const [from, v] of Object.entries(wf.connections)) { ok(names.includes(from), 'conn source ' + from); for (const o of v.main) for (const t of o) ok(names.includes(t.node), 'conn target ' + t.node); }
for (const n of wf.nodes.filter(n => n.type.endsWith('.code'))) { try { new AsyncFunction('$', '$input', '$json', '$execution', n.parameters.jsCode); pass++; } catch (e) { throw new Error('compile ' + n.name + ': ' + e.message); } }
// every non-trigger/sticky node reachable from a trigger
const trig = wf.nodes.filter(n => /Trigger|webhook|manualTrigger/.test(n.type)).map(n => n.name);
const seen = new Set(trig); let q = [...trig]; while (q.length) { const x = q.pop(); for (const o of (wf.connections[x] || { main: [] }).main) for (const t of o) if (!seen.has(t.node)) { seen.add(t.node); q.push(t.node); } }
const unreachable = wf.nodes.filter(n => !n.type.endsWith('stickyNote') && !seen.has(n.name)).map(n => n.name); ok(unreachable.length === 0, 'unreachable: ' + unreachable);
// no leftover CHECKPOINT / Stop and Error
ok(!wf.nodes.some(n => /stopAndError/.test(n.type) || /CHECKPOINT/.test(n.name)), 'no checkpoints');

// ---------- harness ----------
const cfg = JSON.parse(JSON.parse(wf.nodes.find(n => n.name === 'Config').parameters.jsonOutput).cfg ? wf.nodes.find(n => n.name === 'Config').parameters.jsonOutput : '{}').cfg;
const real = JSON.parse(JSON.stringify(cfg).replace(/REPLACE_[A-Z_]+/g, m => 'X_' + m.slice(8)));
real.awaiting_print_stages = ['S_PIP', 'S_UCHAA']; real.pip_invoicing_stage = 'S_INV'; real.to_be_sent_stage = 'S_SEND'; real.cancelled_rejected_stages = ['S_CANC', 'S_REJ']; real.company_destination_field = 'dest';
const mkitem = (json, binary) => ({ json, binary });
const b64 = s => Buffer.from(s).toString('base64');
async function run(name, { input = [], nodes = {}, cfgOverride } = {}) {
  const c = cfgOverride || real;
  const env = {
    ...nodes, Config: [mkitem({ cfg: c, flow: 'x', body: nodes.__body })]
  };
  const $ = n => { const a = env[n]; if (!a) throw new Error('Node not executed: ' + n); return { first: () => a[0], all: () => a, itemMatching: i => a[i], item: a[0] }; };
  const $input = { all: () => input, first: () => input[0] };
  const ctx = { helpers: {
    async getBinaryDataBuffer(i, key) { return Buffer.from(input[i].binary[key].data, 'base64'); },
    async prepareBinaryData(buf, fileName, mimeType) { return { data: buf.toString('base64'), fileName, mimeType }; } } };
  const fn = new AsyncFunction('$', '$input', '$json', '$execution', codeOf(name));
  return await fn.call(ctx, $, $input, input[0] && input[0].json, { id: '1' });
}
const throws = async (p, re) => { try { await p; } catch (e) { ok(re.test(e.message), 'wrong error ' + e.message); return; } assert.fail('expected throw ' + re); };

(async () => {
  // check_config
  await throws(run('Check config', { input: [mkitem({})], cfgOverride: cfg }), /SETUP_REQUIRED/);
  ok((await run('Check config', { input: [mkitem({})] })).length === 1, 'config passes when set');

  // guard
  await throws(run('Stop if run unfinished', { input: [mkitem({ total: 2 })] }), /PRINT_RUN_BLOCKED/);
  ok((await run('Stop if run unfinished', { input: [mkitem({ total: 0 })] })).length === 1, 'guard ok');

  // select queued
  const d = (id, stage, extra = {}) => ({ id, properties: { dealstage: stage, mediref: '1000' + id, report_type: 'PIP', ...extra } });
  const pages = [mkitem({ results: [d(1, 'S_PIP'), d(2, 'S_UCHAA', { report_type: 'UC&ESA' }), d(3, 'S_CANC')] }), mkitem({ results: [d(2, 'S_UCHAA'), d(4, 'S_UCHAA', { report_type: 'Health Assessment Advisory Service' }), d(5, 'S_PIP'), d(6, 'S_PIP', { report_type: 'weird' }), d(7, 'S_PIP', { mediref: 'abc' }), d(8, 'S_PIP')] })];
  const sel = await run('Select queued deals', { input: pages });
  ok(sel.length === 1 && sel[0].json.inputs.length === 7, 'dedupe + cancelled skipped: ' + sel[0].json.inputs.length);
  const many = await run('Select queued deals', { input: [mkitem({ results: Array.from({ length: 230 }, (_, i) => d(i + 100, 'S_PIP')) })] });
  ok(many.length === 3 && many[2].json.inputs.length === 30, 'chunks of 100');

  // companies
  const A = (from, ...tos) => ({ from: { id: from }, to: tos.map(t => ({ toObjectId: t, associationTypes: [{ label: 'Third party' }, { label: null }] })) });
  const assoc = [mkitem({ results: [A('1', 900), A('2', 900), A('4', 901), A('5', 900, 901), { from: { id: '6' }, to: [{ toObjectId: 905, associationTypes: [{ label: 'Other' }] }] }, A('7', 900)] })];
  const pc = await run('Prepare company reads', { input: assoc });
  ok(pc[0].json.inputs.map(x => x.id).sort().join() === '900,901', 'company ids only Third party');
  const comps = [mkitem({ results: [{ id: '900', properties: { dest: 'DWP Leeds' } }, { id: '901', properties: { dest: 'DWP Bolton' } }] })];

  // build packs
  const bp = await run('Build packs and claim updates', { nodes: { 'Select queued deals': sel, 'Read Third party associations': assoc, 'Read destination companies': comps, 'Daily allowance': [mkitem({ allowance: 100 })] } });
  const packs = bp[0].json.packs; const upd = bp.flatMap(x => x.json.inputs);
  ok(packs.length === 2 && packs[0].destination === 'DWP Bolton' && packs[1].destination === 'DWP Leeds', 'destination sort: ' + packs.map(p => p.destination));
  ok(packs[1].cases.map(c => c.deal_id).join() === '1,2' || packs[1].cases.length === 2, 'leeds cases');
  ok(/^PRINT-\d{8}-\d{4}-P0[12]$/.test(packs[0].submission_ref), 'submission ref ' + packs[0].submission_ref);
  const byId = Object.fromEntries(upd.map(u => [u.id, u.properties]));
  ok(byId['1'].print_status === 'preparing' && byId['1'].dispatch_hold_printing === 'true' && byId['1'].printer_job_reference === packs[1].submission_ref, 'claim props');
  ok(byId['5'].print_status === 'needs_attention' && /found 2/.test(byId['5'].print_issue), 'two companies rejected');
  ok(/not recognised/.test(byId['6'].print_issue) && /not numeric/.test(byId['7'].print_issue), 'type/mediref invalid');
  ok(/found 0/.test(byId['8'].print_issue), 'no company');
  // pack cap
  const capCfg = { ...real, max_reports_per_pack: 1 };
  const bp2 = await run('Build packs and claim updates', { nodes: { 'Select queued deals': sel, 'Read Third party associations': assoc, 'Read destination companies': comps, 'Daily allowance': [mkitem({ allowance: 100 })] }, cfgOverride: capCfg });
  ok(bp2[0].json.packs.length === 3, 'pack cap splits');

  // list packs
  const lp = await run('List packs', { input: [mkitem({ status: 'COMPLETE', results: [] })], nodes: { 'Build packs and claim updates': bp } });
  ok(lp.length === 2, 'list packs');
  await throws(run('List packs', { input: [mkitem({ status: 'COMPLETE', errors: [{}] })], nodes: { 'Build packs and claim updates': bp } }), /CLAIM_FAILED/);

  // expand + download check
  const pack = packs[1]; // Leeds: deals 1,2,5? (5 invalid) -> cases 1,2
  const ex = await run('Expand cases', { input: [mkitem(pack)] });
  ok(ex.length === pack.cases.length, 'expand');
  const pdf = n => ({ data: b64('%PDF-1.4 fake ' + n), fileName: 'x', mimeType: 'application/pdf' });
  const errBin = o => ({ data: b64(JSON.stringify(o)), fileName: 'x', mimeType: 'application/json' });
  const mk = (cases, results) => { const exn = cases.map(k => mkitem({ ...pack, case: k })); return { exn, items: results }; };
  // case: first ok, second 409 not completed
  let { exn, items } = mk(pack.cases, [mkitem({ statusCode: 200 }, { pdf: pdf(1) }), mkitem({ statusCode: 409 }, { pdf: errBin({ code: 'instruction_not_completed' }) })]);
  let bpdf = await run('Build pack PDF', { input: items, nodes: { 'Expand cases': exn } });
  ok(bpdf[0].json.pack_ok && bpdf[0].json.ok_cases.length === 1 && bpdf[0].json.failed[0].kind === 'attention' && /not completed/.test(bpdf[0].json.failed[0].reason), '409 -> attention');
  const body = Buffer.from(bpdf[0].binary.manifest_req.data, 'base64').toString();
  ok(body.includes('name="files"; filename="index.html"') && body.includes(pack.destination) && body.includes('preferCssPageSize') && body.trim().endsWith('--'), 'manifest multipart');
  ok(bpdf[0].binary.manifest_req.mimeType === bpdf[0].json.manifest_ct, 'ct on binary');
  ok(bpdf[0].binary.r_0001.fileName.startsWith('000001_report_'), 'report name');
  // 500 / network / invalid pdf / none ok
  ({ exn, items } = mk(pack.cases, [mkitem({ statusCode: 500 }, { pdf: errBin({ code: 'internal_error' }) }), mkitem({ error: { message: 'timeout' } })]));
  bpdf = await run('Build pack PDF', { input: items, nodes: { 'Expand cases': exn } });
  ok(!bpdf[0].json.pack_ok && bpdf[0].json.failed.every(f => f.kind === 'retry') && !bpdf[0].binary, 'temporary errors -> retry, no pack');
  ({ exn, items } = mk(pack.cases, [mkitem({ statusCode: 200 }, { pdf: { data: b64('<html>'), mimeType: 'x' } }), mkitem({ statusCode: 404 }, { pdf: errBin({ code: 'hubspot_deal_id_mismatch' }) })]));
  bpdf = await run('Build pack PDF', { input: items, nodes: { 'Expand cases': exn } });
  ok(bpdf[0].json.failed.every(f => f.kind === 'attention'), 'bad pdf & mismatch -> attention');
  ({ exn, items } = mk(pack.cases, [mkitem({ statusCode: 403 }, { pdf: errBin({ detail: 'x' }) }), mkitem({ statusCode: 403 }, { pdf: errBin({ detail: 'x' }) })]));
  await throws(run('Build pack PDF', { input: items, nodes: { 'Expand cases': exn } }), /EMR_ACCESS_DENIED/);

  // failure updates (no ok)
  ({ exn, items } = mk(pack.cases, [mkitem({ statusCode: 500 }, { pdf: errBin({}) }), mkitem({ statusCode: 409 }, { pdf: errBin({ code: 'report_not_available' }) })]));
  bpdf = await run('Build pack PDF', { input: items, nodes: { 'Expand cases': exn } });
  const fu = await run('Failure updates (nothing to print)', { input: bpdf });
  const fp = Object.fromEntries(fu[0].json.inputs.map(u => [u.id, u.properties]));
  ok(fp[pack.cases[0].deal_id].print_status === 'queued' && fp[pack.cases[1].deal_id].print_status === 'needs_attention', 'failure props');

  // merge request
  ({ exn, items } = mk(pack.cases, [mkitem({ statusCode: 200 }, { pdf: pdf(1) }), mkitem({ statusCode: 200 }, { pdf: pdf(2) })]));
  bpdf = await run('Build pack PDF', { input: items, nodes: { 'Expand cases': exn } });
  const merged = mkitem(bpdf[0].json, { ...bpdf[0].binary, manifest_pdf: pdf('MANIFEST') });
  const mr = await run('Build merge request', { input: [merged] });
  const mbody = Buffer.from(mr[0].binary.merge_req.data, 'base64').toString();
  const order = [...mbody.matchAll(/filename="([^"]+)"/g)].map(m => m[1]);
  ok(order[0] === '000000_manifest.pdf' && order.length === 3 && order[1] < order[2], 'merge order ' + order);
  // validate pack
  const vp = await run('Validate pack', { input: [mkitem({}, { pack: pdf('PACK') })], nodes: { 'Build pack PDF': bpdf } });
  ok(vp[0].binary.pack.fileName === pack.submission_ref + '.pdf' && vp[0].json.submission_ref === pack.submission_ref, 'validate pack');
  await throws(run('Validate pack', { input: [mkitem({}, { pack: { data: b64('nope'), mimeType: 'x' } })], nodes: { 'Build pack PDF': bpdf } }), /PACK_INVALID/);

  // outcomes
  const outcome = async r => run('Print outcome', { input: [mkitem(r)], nodes: { 'Validate pack': vp, 'Build pack PDF': [mkitem({ ...bpdf[0].json, failed: [{ deal_id: '99', kind: 'attention', reason: 'x' }] })] } });
  let oc = await outcome({ statusCode: 200, body: { status: 'accepted' } });
  ok(!oc[0].json.unsafe && oc[0].json.inputs[0].properties.print_status === 'sent_to_printer', 'accepted');
  ok(oc[0].json.inputs.some(u => u.id === '99' && u.properties.print_status === 'needs_attention'), 'failed deal included');
  oc = await outcome({ statusCode: 422, body: {} }); ok(oc[0].json.unsafe && oc[0].json.kind === 'rejected' && /rejected/.test(oc[0].json.inputs[0].properties.print_issue), 'rejected');
  oc = await outcome({ error: { message: 'timeout' } }); ok(oc[0].json.unsafe && oc[0].json.kind === 'unknown', 'timeout=unknown');
  oc = await outcome({ statusCode: 502 }); ok(oc[0].json.kind === 'unknown', '5xx=unknown');
  await throws(run('Stop if printer result unsafe', { input: [mkitem({ results: [] })], nodes: { 'Print outcome': oc } }), /PRINT_RUN_PAUSED/);
  oc = await outcome({ statusCode: 200, body: {} });
  ok((await run('Stop if printer result unsafe', { input: [mkitem({ results: [] })], nodes: { 'Print outcome': oc } })).length === 1, 'continue when safe');

  // monitor
  const ago = m => new Date(Date.now() - m * 60000).toISOString();
  const deal = (id, status, extra = {}) => ({ id, properties: { print_status: status, printer_job_reference: 'J1', dealstage: 'S_PIP', report_type: 'PIP', hs_lastmodifieddate: ago(5), ...extra } });
  const grp = (deals, ref = 'J1') => [mkitem({ job_ref: ref, deals })];
  const mon = async (deals, res, ref) => (await run('Decide monitor updates', { input: [mkitem(res)], nodes: { 'Group jobs': grp(deals, ref) } })).flatMap(x => x.json.inputs);
  let u = await mon([deal('1', 'sent_to_printer'), deal('2', 'sent_to_printer', { dealstage: 'S_UCHAA', report_type: 'UC&ESA' }), deal('3', 'sent_to_printer', { print_issue: 'staff fault' }), deal('4', 'sent_to_printer', { dealstage: 'S_SEND' })], { statusCode: 200, body: { status: 'completed' } });
  ok(u[0].properties.dealstage === 'S_INV' && u[0].properties.dispatch_hold_printing === 'false' && u[0].properties.print_status === 'printed', 'PIP handoff');
  ok(u[1].properties.dealstage === 'S_SEND', 'UC handoff');
  ok(!('dispatch_hold_printing' in u[2].properties) && !('dealstage' in u[2].properties), 'open issue keeps hold');
  ok(!('dealstage' in u[3].properties), 'later stage not overwritten');
  u = await mon([deal('1', 'preparing')], { statusCode: 200, body: { status: 'accepted' } }); ok(u[0].properties.print_status === 'sent_to_printer', 'accepted promotes');
  u = await mon([deal('1', 'sent_to_printer', { print_submitted_at: ago(45) })], { statusCode: 200, body: { status: 'accepted' } }); ok(u[0].properties.print_status === 'needs_attention', 'completion timeout');
  u = await mon([deal('1', 'sent_to_printer', { print_submitted_at: ago(5) })], { statusCode: 200, body: { status: 'accepted' } }); ok(u.length === 0, 'still waiting');
  u = await mon([deal('1', 'sent_to_printer')], { statusCode: 200, body: { status: 'failed' } }); ok(u[0].properties.print_status === 'needs_attention', 'failed');
  u = await mon([deal('1', 'preparing', { hs_lastmodifieddate: ago(90) })], { statusCode: 404, body: {} }); ok(u[0].properties.print_status === 'needs_attention', 'stale preparing, no record');
  u = await mon([deal('1', 'preparing', { hs_lastmodifieddate: ago(5) })], { statusCode: 404, body: {} }); ok(u.length === 0, 'fresh preparing left alone');
  u = await mon([deal('1', 'sent_to_printer')], { statusCode: 404, body: {} }); ok(u[0].properties.print_status === 'needs_attention', 'sent but unknown to bridge');
  u = await mon([deal('1', 'sent_to_printer')], { error: { message: 'down' } }); ok(u.length === 0, 'bridge down: wait');
  u = await mon([deal('1', 'sent_to_printer', { hs_lastmodifieddate: ago(120) })], { error: { message: 'down' } }); ok(u[0].properties.print_status === 'needs_attention', 'bridge down long');
  u = await mon([deal('1', 'preparing', { printer_job_reference: '' })], {}, '__none__'); ok(/reference is missing/.test(u[0].properties.print_issue), 'no ref');
  const gj = await run('Group jobs', { input: [mkitem({ results: [deal('1', 'preparing'), deal('2', 'preparing', { printer_job_reference: 'J2' }), deal('3', 'sent_to_printer')] })] });
  ok(gj.length === 2 && gj.find(g => g.json.job_ref === 'J1').json.deals.length === 2, 'group jobs');

  // staff
  const stf = async (props, lookup = { statusCode: 200, body: { status: 'completed' } }) => run('Decide staff action', { input: [mkitem(lookup)], nodes: { 'Read deal': [mkitem({ id: '77', properties: { dealstage: 'S_PIP', report_type: 'PIP', ...props } })] } });
  ok((await stf({ print_action: 'none' })).length === 0, 'no action');
  let s = await stf({ print_action: 'report_problem', print_request_note: '' }); ok(/^REJECTED/.test(s[0].json.properties.print_request_note) && s[0].json.properties.print_action === 'none', 'note required');
  s = await stf({ print_action: 'report_problem', print_request_note: 'Pages 3-4 blank', print_status: 'printed' }); ok(s[0].json.properties.print_status === 'needs_attention' && s[0].json.properties.dispatch_hold_printing === 'true' && s[0].json.properties.print_issue === 'Pages 3-4 blank', 'report problem');
  s = await stf({ print_action: 'resolve_problem', print_request_note: 'Reprinted page by hand', print_status: 'needs_attention', print_issue: 'x' }); ok(s[0].json.properties.print_status === 'printed' && s[0].json.properties.dispatch_hold_printing === 'false' && s[0].json.properties.dealstage === 'S_INV', 'resolve ok + handoff');
  s = await stf({ print_action: 'resolve_problem', print_request_note: 'fixed', print_status: 'needs_attention' }, { statusCode: 200, body: { status: 'failed' } }); ok(/REJECTED/.test(s[0].json.properties.print_request_note), 'resolve needs success record');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'jam', print_status: 'sent_to_printer' }); ok(/REJECTED/.test(s[0].json.properties.print_request_note), 'reprint blocked while active');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'jam', print_status: 'needs_attention' }, { statusCode: 200, body: { status: 'accepted' } }); ok(/REJECTED/.test(s[0].json.properties.print_request_note), 'reprint blocked when bridge says active');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'jam', print_status: 'needs_attention' }, { statusCode: 404, body: {} }); ok(s[0].json.properties.print_status === 'queued' && s[0].json.properties.print_batch_id === '' && s[0].json.properties.dispatch_hold_printing === 'true' && s[0].json.properties.print_action === 'none', 'reprint requeues');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'x', print_status: 'printed', dealstage: 'S_CANC' }); ok(/cancelled/.test(s[0].json.properties.print_request_note), 'cancelled deal');
  s = await stf({ print_action: 'print_reprint', print_request_note: 'REJECTED: old', print_status: 'printed' }); ok(/REJECTED: write a new/.test(s[0].json.properties.print_request_note), 'stale rejected note not reusable');
  await throws(run('Read staff request', { nodes: { __body: { deal_id: 'abc' } } }), /STAFF_REQUEST_INVALID/);
  ok((await run('Read staff request', { nodes: { __body: { deal_id: '123' } } }))[0].json.deal_id === '123', 'deal id read');


  // ---- new: pre-flight, allowance, cap ----
  const pf = async (r, c) => run('Printer ready?', { input: [mkitem(r)], cfgOverride: c });
  const okr = await pf({ statusCode: 200, body: { status: 'online', spoolerStatus: 'Running', printerQueue: 'CRD-PRN-01-AUTO' } });
  ok(okr[0].json.printer_state === 'ready' && /^\d{13}$/.test(okr[0].json.day_start_ms) && Number(okr[0].json.day_start_ms) <= Date.now() && Date.now() - Number(okr[0].json.day_start_ms) < 25 * 3600e3, 'day start in last 25h');
  ok((await pf({ statusCode: 200, body: { status: 'online', spoolerStatus: 'Running' } }))[0].json.printer_state === 'ready', 'queue omitted ok');
  for (const b of [{ status: 'offline' }, { status: 'online', spoolerStatus: 'Stopped' }, { status: 'online' }, { status: 'weird' }]) await throws(pf({ statusCode: 200, body: b }), /PRINTER_NOT_READY/);
  await throws(pf({ statusCode: 200, body: { status: 'online', spoolerStatus: 'Running', printerQueue: 'OTHER' } }), /expected/);
  await throws(pf({ error: { message: 'ECONNREFUSED' } }), /unreachable/);
  await throws(pf({ statusCode: 500, body: {} }), /HTTP 500/);
  ok((await run('Daily allowance', { input: [mkitem({ total: 50 })] }))[0].json.allowance === 150, 'allowance 150');
  ok((await run('Daily allowance', { input: [mkitem({ total: 200 })] })).length === 0, 'limit reached ends');
  ok((await run('Daily allowance', { input: [mkitem({ total: 999 })] })).length === 0, 'over limit ends');
  const old = (id, q, extra = {}) => d(id, 'S_PIP', { print_queued_at: q, ...extra });
  const selCap = [mkitem({ deals: [old(31, '2026-11-01T10:00:00Z'), old(32, '2026-10-30T10:00:00Z'), old(33, '2026-10-31T10:00:00Z'), old(34, '') ] })];
  const assocCap = [mkitem({ results: [A('31', 900), A('32', 900), A('33', 900), A('34', 900)] })];
  const bpc = await run('Build packs and claim updates', { nodes: { 'Select queued deals': selCap, 'Read Third party associations': assocCap, 'Read destination companies': comps, 'Daily allowance': [mkitem({ allowance: 2 })] } });
  const claimed = bpc.flatMap(x => x.json.inputs).map(u => u.id).sort().join();
  ok(claimed === '32,33', 'oldest two claimed, rest stay queued: ' + claimed);
  u = await mon([deal('1', 'sent_to_printer')], { statusCode: 200, body: { status: 'error', reason: 'paper jam' } }); ok(/paper jam/.test(u[0].properties.print_issue) && u[0].properties.print_status === 'needs_attention', 'bridge error state');
  const trig = wf.nodes.find(n => n.name === 'Daily 08:30 print run'); ok(trig.parameters.rule.interval[0].expression === '30 8 * * *' && wf.settings.timezone === 'Europe/London', '08:30 UK daily');

  console.log('PASS', pass, 'checks');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
