const fs = require('fs'); const crypto = require('crypto');
const CODE = require('./code.js');
const uid = () => crypto.randomUUID();

// ---------- environment ----------
// PRINT_ENV=sandbox (default) builds the sandbox workflow; PRINT_ENV=live builds the ops portal workflow:
// its own report link path (both can sit in one n8n), and staff actions are found by polling (no webhook subscription needed).
const ENV = process.env.PRINT_ENV === 'live' ? 'live' : 'sandbox';
const LIVE = ENV === 'live';

// ---------- config (single place) ----------
const cfg = {
  environment: ENV,
  report_path: LIVE ? 'lalu-report-ops' : 'lalu-report',
  hubspot_base: 'https://api.hubapi.com',
  n8n_public_base: 'https://automation.lalu.co.uk',
  gateway_base: 'http://10.0.60.33:8787',
  printer_queue: 'CRD-PRN-01-AUTO',
  emr_mode: 'live',
  emr_base: LIVE ? 'REPLACE_LIVE_EMR_BASE' : 'https://lalucare.uat.lalu.co.uk',
  emr_retry_429_wait_seconds: 60,
  emr_retry_429_max: 2,
  emr_retry_500_wait_seconds: 30,
  emr_retry_500_max: 1,
  link_secret: 'REPLACE_LINK_SECRET',
  dry_run: true,
  max_report_mb: 150,
  run_start_time: '08:30', // scheduled runs check the printer from this time (UK time, HH:MM) ...
  retry_until_time: '16:30', // ... every 30 minutes until this time; if the printer is still offline an alert is sent and the next weekday run tries again
  bank_holidays: ['2026-12-25','2026-12-28','2027-01-01','2027-03-26','2027-03-29','2027-05-03','2027-05-31','2027-08-30','2027-12-27','2027-12-28'], // England and Wales; dates (YYYY-MM-DD) the scheduled run skips, e.g. '2026-12-25'; update every year
  link_valid_minutes: 30,
  max_batches_per_run: 2, // most batches one run will print (each run claims and prints at most this many; the rest stay Queued for the next run). 0 = no limit. Keeps one run within what the output tray holds
  require_postcode_in_destination: true, // a destination with no UK postcode (just a company name) is held as Waiting for destination address instead of printing
  reports_per_call: 20, // reports per print batch (manifest + this many reports). Change it here; the gateway's own ceiling is 24
  max_reports_per_day: 200,
  duplex: true,
  colour: false,
  pipeline_id: '28557963',
  awaiting_print_stages: ['64932357', '64932356'],
  issue_stages: { PIP: '66989570', UC: '66989569', HAA: '66989569', DLA: '66989570' }, // PIP - Issues; UC113/HSA - Issues; DLA uses the PIP Issues stage because DLA deals wait at the same stage as PIP (confirm)
  awaiting_stage_by_type: { PIP: '64932357', UC: '64932356', HAA: '64932356', DLA: '64932357' },
  pip_invoicing_stage: '64932358',
  completed_stage: '65006208', // Completed: where UC/HSA and HAA deals move after a successful print
  cancelled_rejected_stages: ['81292295', '65056856'],
  fields: {
    case_ref: 'mediref', report_type: 'report_type',
    status: 'print_status', queued_at: 'print_queued_at', batch: 'print_batch_id', destination: 'print_destination', dest_source: 'destination_address', recipient_set: 'recipient_company_set',
    submitted_at: 'print_submitted_at', completed_at: 'print_completed_at', job_ref: 'printer_job_reference',
    issue: 'print_issue', hold: 'dispatch_hold_printing', action: 'print_action', request_note: 'print_request_note'
  },
  values: {
    queued: 'queued', preparing: 'preparing', submitted: 'sent_to_printer', printed: 'printed', issue: 'needs_attention',
    action_none: 'none', action_problem: 'report_problem', action_resolve: 'resolve_problem', action_print: 'print_reprint', action_manual: 'printed_manually'
  },
  report_types: { 'PIP': 'PIP', 'UC&ESA': 'UC', 'Health Assessment Advisory Service': 'HAA', 'DWP - Disability Living Allowance': 'DLA' },
  print_enabled: { PIP: false, UC: true, HAA: true, DLA: false }, // one switch per report type. false = deals of that type are left Queued and untouched until you switch it back on. PIP is off for now. DLA is allowed but switched off until you are ready
  control_company_id: '474434180302', // the "Print control" company in the ops HubSpot portal. Its checkboxes/numbers override Config at run start (Printing on PIP/UC/HSA/DLA, Max batches per run, Reports per call, Max reports per day); Print paused is also checked before every batch. Blank = use the value in this Config
  preparing_timeout_minutes: 60,
  gateway_timeout_minutes: 30, // how long n8n waits for the gateway to answer one print call (one batch of up to 20 reports) before treating the result as unknown. A 20-report HSA batch took 15 min on 25 Nov, so 15 was too short
};

// ---------- helpers ----------
const nodes = []; const conns = {};
const add = (name, type, typeVersion, parameters, position, extra = {}) => { nodes.push({ parameters, id: uid(), name, type, typeVersion, position, ...extra }); return name; };
const link = (from, to, out = 0) => { conns[from] = conns[from] || { main: [] }; while (conns[from].main.length <= out) conns[from].main.push([]); conns[from].main[out].push({ node: to, type: 'main', index: 0 }); };
const chain = (...names) => { for (let i = 0; i < names.length - 1; i++) link(names[i], names[i + 1]); };
const C = "$('Config').first().json.cfg";
const props = `Object.values(${C}.fields).concat(['pipeline','dealstage','hs_lastmodifieddate'])`;
const code = (name, src, pos, notes) => add(name, 'n8n-nodes-base.code', 2, { jsCode: src }, pos, notes ? { notes, notesInFlow: true } : {});
const note = (name, content, pos, w = 420, h = 160) => add(name, 'n8n-nodes-base.stickyNote', 1, { content, height: h, width: w }, pos);
const retry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 };
const HS = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }; // HubSpot: Header Auth credential, Authorization: Bearer <private app token or service key>
const HDR = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
const paginate = { pagination: { pagination: { parameters: { parameters: [{ type: 'body', name: 'after', value: '={{ $response.body.paging.next.after }}' }] }, paginationMode: 'updateAParameterInEachRequest', paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body.paging || !$response.body.paging.next || !$response.body.paging.next.after }}', limitPagesFetched: true, maxRequests: 50 } } };
const search = (name, filtersExpr, pos, paged = true, sorted = false) => add(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST', url: `={{ ${C}.hubspot_base + '/crm/v3/objects/deals/search' }}`, ...HS, sendBody: true, specifyBody: 'json',
  jsonBody: `={{ {filterGroups:[{filters:${filtersExpr}}],properties:${props},limit:100${sorted ? `,sorts:[{propertyName:${C}.fields.queued_at,direction:'ASCENDING'}]` : ''}} }}`,
  options: paged ? { ...paginate } : {}
}, pos, retry);
const hsPost = (name, path, bodyExpr, pos, extraOpts = {}, extra = retry) => add(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST', url: `={{ ${C}.hubspot_base + '${path}' }}`, ...HS, sendBody: true, specifyBody: 'json', jsonBody: bodyExpr, options: extraOpts
}, pos, extra);
const flowSet = (name, flow, pos) => add(name, 'n8n-nodes-base.set', 3.4, { assignments: { assignments: [{ id: uid(), name: 'flow', value: flow, type: 'string' }] }, includeOtherFields: true, options: {} }, pos);

// ---------- triggers + config + routing ----------
note('README', '# Lalu print automation (Phase 1)\nOne workflow, four flows:\n**1 Print run** (Mon–Fri, first check 08:30 UK then every 30 min until the printer is online or 16:30; skips bank_holidays; or manual) · **2 Stuck check** (every 15 min) · **3 Staff actions** (HubSpot webhook) · **4 Report link** (the print gateway calls this to fetch each PDF).\nHubSpot is the only state store. Edit settings ONLY in the **Config** node. Reports are streamed from EMR+ to the gateway and never stored. See README.md for bindings. Activate only after the pilot checklist.', [0, -420], 600, 200);
add('Weekday print run (every 30 min)', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: '0,30 8-16 * * 1-5' }] } }, [0, 0]);
add('Manual print run', 'n8n-nodes-base.manualTrigger', 1, {}, [0, 120]);
add('Every 15 min stuck check', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }, [0, 300]);
{ add('Staff action webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: LIVE ? 'lalu-print-action-ops' : 'lalu-print-action', responseMode: 'responseNode', options: {} }, [0, 480], { notes: 'Target of a HubSpot private app webhook subscription: deal.propertyChange on print_action (event batches are accepted). No credential: HubSpot cannot send a custom header, and the flow trusts nothing in the payload except the deal ID. It re-reads the deal and acts only on what the deal record says. Also accepts {"deal_id": "..."}. Replies 200 immediately.', notesInFlow: true }); }
if (LIVE) add('Staff action poll (every minute)', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: '* 7-18 * * 1-5' }] } }, [0, 480], { notes: 'Safety net: every minute from 07:00 to 18:59, Monday to Friday (UK time), this looks for deals whose Print action is not None and runs the same staff-action steps as the webhook. The webhook (HubSpot private app subscription) is the main trigger.', notesInFlow: true });
add('Report link webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: cfg.report_path, responseMode: 'responseNode', options: {} }, [0, 660], { notes: 'Called by the Cardiff print gateway, not by people. Public by design: every link is signed and expires. Use the PRODUCTION url (https://automation.lalu.co.uk/webhook/' + cfg.report_path + ').', notesInFlow: true });
flowSet('Flow: print', 'print', [220, 120]); add('Flow: print scheduled', 'n8n-nodes-base.set', 3.4, { assignments: { assignments: [{ id: uid(), name: 'flow', value: 'print', type: 'string' }, { id: uid(), name: 'scheduled', value: true, type: 'boolean' }] }, includeOtherFields: true, options: {} }, [220, 0]); flowSet('Flow: stuck', 'stuck', [220, 300]); flowSet('Flow: staff', 'staff', [220, 480]); flowSet('Flow: link', 'link', [220, 660]);
link('Weekday print run (every 30 min)', 'Flow: print scheduled'); link('Manual print run', 'Flow: print'); link('Every 15 min stuck check', 'Flow: stuck'); link('Staff action webhook', 'Flow: staff'); if (LIVE) link('Staff action poll (every minute)', 'Flow: staff'); { add('Staff: reply 200', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: 'ok', options: { responseCode: 200 } }, [220, 560], { notes: 'Replies 200 to HubSpot straight away, then the staff flow carries on. Needed because the workflow also has Respond to Webhook nodes for the report link flow.', notesInFlow: true }); link('Staff action webhook', 'Staff: reply 200'); } link('Report link webhook', 'Flow: link');
add('Config', 'n8n-nodes-base.set', 3.4, { mode: 'raw', jsonOutput: JSON.stringify({ cfg }, null, 2), includeOtherFields: true, options: {} }, [440, 300], { notes: 'ALL settings live here. Replace every REPLACE_ value: link_secret = a long random string (32+ characters). emr_base = EMR+ host (only the Report link flow uses it; leave the placeholder until you have it). emr_mode "dummy" serves clearly labelled dummy PDFs for testing; "live" fetches real reports.', notesInFlow: true });
['Flow: print', 'Flow: print scheduled', 'Flow: stuck', 'Flow: staff', 'Flow: link'].forEach(f => link(f, 'Config'));
code('Check config', CODE.check_config, [660, 300]);
add('Route', 'n8n-nodes-base.switch', 3.2, { rules: { values: ['print', 'stuck', 'staff', 'link'].map(k => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uid(), leftValue: "={{ $('Config').first().json.flow }}", rightValue: k, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: k })) }, options: {} }, [880, 300]);
chain('Config', 'Check config', 'Route');

// ---------- FLOW 1: PRINT RUN ----------
note('Flow 1 note', '## 1. Print run\nPrinter ready? → read queue → read destination_address from the deal → claim (Preparing) → per destination batch (manifest + up to 24 reports): sign one link per PDF → one call to the print gateway → read each job result → write HubSpot. The gateway fetches each PDF from this workflow (flow 4), which streams it from EMR+. Nothing is stored. A timeout means "result unknown": never resent.', [1100, -360], 620, 150);
search('Guard: any Preparing deals?', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.status,operator:'EQ',value:${C}.values.preparing}]`, [1100, -120], false);
code('Stop if run unfinished', CODE.stop_if_blocked, [1320, -120]);
search('Read queue', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.status,operator:'EQ',value:${C}.values.queued}]`, [1540, -120], true, true);
add('Printer status check', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `={{ ${C}.gateway_base + '/health' }}`, ...HDR, options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [1320, 40], { onError: 'continueRegularOutput', notes: 'Header Auth credential "Cardiff Print Agent": header X-Print-Agent-Token. Pre-flight before anything is claimed.', notesInFlow: true });
code('Printer ready?', CODE.printer_ready, [1540, 40], 'Online + spooler Running + printer Normal + right queue. Anything else => stop + alert email, nothing claimed.');
search('Count sent today', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.submitted_at,operator:'GTE',value:$json.day_start_ms}]`, [1760, 40], false);
code('Daily allowance', CODE.daily_allowance, [1980, 40], 'max_reports_per_day minus reports already printed today. 0 left => run ends quietly.');
const CTL_URL = `={{ ${C}.hubspot_base + '/crm/v3/objects/companies/' + ${C}.control_company_id + '?properties=print_paused,printing_on_pip,printing_on_uc,printing_on_hsa,printing_on_dla,max_batches_per_run,reports_per_call,max_reports_per_day' }}`;
const ctlGet = (name, pos, notes) => add(name, 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: CTL_URL, ...HS, options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, pos, { retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput', notes, notesInFlow: true });
ctlGet('Read control settings', [1650, 40], 'Reads the Print control company in HubSpot (control_company_id in Config).');
code('Apply control settings', CODE.apply_control, [1870, 40], 'Print paused ticked, or HubSpot not answering => run ends quietly, nothing claimed. Otherwise any filled-in control value replaces the Config value for this run.');
ctlGet('Read pause switch', [3410, -240], 'Before every batch: is Print paused ticked on the Print control company?');
code('Pause check', CODE.pause_check, [3520, -330], 'Paused (or HubSpot not answering) => run ends; this batch stays Queued. Otherwise passes the batch on.');
code('Select queued deals', CODE.select_queued, [1760, -120]);
add('Check report in EMR+ (no download)', 'n8n-nodes-base.httpRequest', 4.2, { method: 'HEAD', url: "={{ $('Config').first().json.cfg.emr_base + '/api/v1/instructions/medi_ref/' + $json.mediref + '/completed_report/?hubspot_deal_id=' + $json.deal_id }}", ...HDR, options: { timeout: 30000, batching: { batch: { batchSize: 4, batchInterval: 250 } }, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } } } }, [2200, -120], { retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput', notes: 'Same Header Auth credential as Fetch report from EMR+. HEAD request: nothing is downloaded or stored. 200 = report is there, 404 = medi ref not linked to the deal, 409 = not ready.', notesInFlow: true });
code('Build batches and claim updates', CODE.build_packs, [2640, -120], 'Invalid cases go to Needs attention with the reason; valid cases are claimed as Preparing, grouped by destination and split into calls of reports_per_call (set in Config, currently 20; gateway ceiling 24).');
add('Any start updates?', 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: uid(), leftValue: "={{ ($json.inputs || []).length > 0 }}", rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }, [2750, -120], { notes: 'Only waiting notes and invalid cases are written here. Deals are claimed (Preparing) one batch at a time, just before each batch prints.', notesInFlow: true });
hsPost('Claim deals', '/crm/v3/objects/deals/batch/update', '={{ {inputs:$json.inputs} }}', [2860, -120]);
code('List batches', CODE.list_packs, [3080, -120]);
add('Next batch', 'n8n-nodes-base.splitInBatches', 3, { batchSize: 1, options: {} }, [3300, -120], { notes: 'Output 1 (loop) = next batch. Output 0 (done) = finished.', notesInFlow: true });
code('List pack deals to check', CODE.list_checks, [3520, -240], 'This batch only: one item per report so each gets its own HEAD request just before the batch prints.');
code('Apply batch check', CODE.apply_checks, [3960, -240], 'Reports that are missing or not linked go to Needs attention and come off this batch (and its manifest). EMR+ not answering puts the deal back to Queued. 403 puts the batch back and stops the run after the write.');
add('Has check updates?', 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: uid(), leftValue: "={{ ($json.updates || []).length > 0 }}", rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }, [4180, -240]);
hsPost('Write check updates', '/crm/v3/objects/deals/batch/update', "={{ {inputs:$json.updates} }}", [4400, -300]);
code('Pack after checks', CODE.pack_after_checks, [4620, -240], 'Stops the run on an EMR+ access error (after the write); otherwise passes the checked batch on.');
add('Anything to print?', 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: uid(), leftValue: "={{ ($json.cases || []).length > 0 }}", rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }, [4840, -240]);
code('Build job links', CODE.build_job_links, [3520, 0], 'One item per print job: the manifest first, then each report. Each gets signed text.');
add('Sign links', 'n8n-nodes-base.crypto', 1, { action: 'hmac', type: 'SHA256', value: '={{ $json.payload }}', dataPropertyName: 'sig', secret: `={{ ${C}.link_secret }}`, encoding: 'hex' }, [3740, 0], { notes: 'HMAC-SHA256 of each link with link_secret. The Report link flow checks it.', notesInFlow: true });
code('Build print request', CODE.build_print_request, [3960, 0]);
add('Submit to gateway', 'n8n-nodes-base.httpRequest', 4.2, { method: 'POST', url: `={{ ${C}.gateway_base + '/print-jobs' }}`, ...HDR, sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.body }}', options: { timeout: `={{ Number(${C}.gateway_timeout_minutes || 15) * 60000 }}`, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [4180, 0], { onError: 'continueRegularOutput', notes: 'NO retries here: a retry could print twice. A timeout can still print (seen in testing), so it is treated as "result unknown".', notesInFlow: true });
code('Print outcome', CODE.print_outcome, [4400, 0], 'Reads batchStatus and each job result / errorCode. Unknown or rejected => deals Needs attention and the run stops.');
hsPost('Read current stages', '/crm/v3/objects/deals/batch/read', "={{ {properties:['dealstage'],inputs:$json.read_inputs} }}", [4620, 0], { response: { response: { fullResponse: true, neverError: true } } }, { retryOnFail: false });
code('Build result updates', CODE.build_result_updates, [4840, 0], 'Stage handoff only if the deal is still at an awaiting-printing stage right now.');
hsPost('Write print results', '/crm/v3/objects/deals/batch/update', '={{ {inputs:$json.inputs} }}', [5060, 0]);
code('Stop if printer result unsafe', CODE.stop_if_unsafe, [5280, 0]);
code('Working day?', CODE.working_day, [880, -120], 'Scheduled runs only: ends quietly on a weekend or a date listed in Config bank_holidays (YYYY-MM-DD). Manual runs always continue.');
link('Route', 'Working day?', 0); link('Working day?', 'Guard: any Preparing deals?');
chain('Guard: any Preparing deals?', 'Stop if run unfinished', 'Printer status check', 'Printer ready?', 'Read control settings', 'Apply control settings', 'Count sent today', 'Daily allowance', 'Read queue', 'Select queued deals', 'Build batches and claim updates', 'Any start updates?', 'Claim deals', 'List batches', 'Next batch');
chain('List pack deals to check', 'Check report in EMR+ (no download)', 'Apply batch check', 'Has check updates?');
chain('Read pause switch', 'Pause check', 'List pack deals to check'); link('Next batch', 'Read pause switch', 1);
link('Any start updates?', 'List batches', 1);
link('Has check updates?', 'Write check updates', 0); link('Has check updates?', 'Pack after checks', 1); link('Write check updates', 'Pack after checks');
link('Pack after checks', 'Anything to print?'); link('Anything to print?', 'Build job links', 0); link('Anything to print?', 'Next batch', 1);
chain('Build job links', 'Sign links', 'Build print request');
add('Printer check after answer', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `={{ ${C}.gateway_base + '/health' }}`, ...HDR, options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [4400, 0], { onError: 'continueRegularOutput', notes: 'Pings the gateway health endpoint after every submit. Only used to describe the printer state when the print result is unknown (timeout); no gateway change needed.', notesInFlow: true });
chain('Submit to gateway', 'Printer check after answer', 'Print outcome', 'Read current stages', 'Build result updates', 'Write print results', 'Stop if printer result unsafe');
link('Stop if printer result unsafe', 'Next batch');

// ---------- FLOW 2: STUCK CHECK ----------
note('Flow 2 note', '## 2. Stuck check (every 15 min)\nA print run finishes inside one execution. If n8n restarted mid-run, deals can stay Preparing. After preparing_timeout_minutes they are set to Needs attention (hold on) so staff check the paper output. Never prints anything.', [1100, 330], 600, 130);
search('Find stuck deals', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.status,operator:'IN',values:[${C}.values.preparing,${C}.values.submitted]}]`, [1100, 540]);
code('Decide stuck updates', CODE.decide_stuck, [1320, 540]);
hsPost('Apply stuck updates', '/crm/v3/objects/deals/batch/update', '={{ {inputs:$json.inputs} }}', [1540, 540]);
link('Route', 'Find stuck deals', 1);
chain('Find stuck deals', 'Decide stuck updates', 'Apply stuck updates');

// ---------- FLOW 3: STAFF ----------
note('Flow 3 note', '## 3. Staff actions\nHubSpot sends the deal ID. n8n re-reads the deal, validates the request (note required, no active job, etc.) and updates it. Rejections are written to the Print request note as "REJECTED: ...". Print action is reset to None. Needs no printer call: the deal record is the source of truth.', [1100, 760], 600, 130);
code('Read staff request', CODE.read_request, [1100, 960]);
if (LIVE) { search('Find staff requests', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.action,operator:'HAS_PROPERTY'},{propertyName:${C}.fields.action,operator:'NEQ',value:${C}.values.action_none}]`, [1100, 960]); code('Staff requests to deals', CODE.poll_requests, [1320, 1060], 'One item per deal that has a Print action set. None => the run ends.'); }
add('Read deal', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `={{ ${C}.hubspot_base + '/crm/v3/objects/deals/' + $json.deal_id + '?properties=' + ${props}.join(',') }}`, ...HS, options: {} }, [1320, 960], retry);
code('Decide staff action', CODE.decide_staff, [1540, 960]);
add('Apply staff action', 'n8n-nodes-base.httpRequest', 4.2, { method: 'PATCH', url: `={{ ${C}.hubspot_base + '/crm/v3/objects/deals/' + $json.deal_id }}`, ...HS, sendBody: true, specifyBody: 'json', jsonBody: '={{ {properties:$json.properties} }}', options: {} }, [1760, 960], retry);
if (LIVE) { add('Staff event from webhook?', 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: uid(), leftValue: `={{ Object.keys($('Config').first().json.body || {}).length > 0 }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }, [900, 960], { notes: 'A HubSpot webhook event carries a body: use it. The one-minute poll has none: search HubSpot for deals with a Print action instead. The poll stays on as a safety net for a missed webhook.', notesInFlow: true }); link('Route', 'Staff event from webhook?', 2); link('Staff event from webhook?', 'Read staff request', 0); link('Staff event from webhook?', 'Find staff requests', 1); chain('Read staff request', 'Read deal'); chain('Find staff requests', 'Staff requests to deals', 'Read deal', 'Decide staff action', 'Apply staff action'); }
else { link('Route', 'Read staff request', 2); chain('Read staff request', 'Read deal', 'Decide staff action', 'Apply staff action'); }

// ---------- FLOW 4: REPORT LINK (called by the gateway) ----------
note('Flow 4 note', '## 4. Report link\nThe print gateway opens one link per job. We check the signature and expiry, then: manifest => build a plain PDF here; report => stream it from EMR+ (or a labelled dummy PDF in test mode). The PDF is never saved. Errors answer with a status code the print run turns into a readable reason (404 no case, 409 not completed, 403 EMR+ access, 410 expired, 422 bad link, 503 EMR+ unavailable/not configured).', [1100, 1160], 640, 160);
code('Check link', CODE.check_link, [1100, 1340]);
const ifNode = (name, left, right, pos, type = 'boolean', op = 'true') => add(name, 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uid(), leftValue: left, rightValue: right, operator: type === 'boolean' ? { type: 'boolean', operation: 'true', singleValue: true } : { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} }, pos);
ifNode('Link well-formed?', '={{ $json.ok }}', true, [1320, 1340]);
add('Check signature', 'n8n-nodes-base.crypto', 1, { action: 'hmac', type: 'SHA256', value: '={{ $json.payload }}', dataPropertyName: 'sig', secret: `={{ ${C}.link_secret }}`, encoding: 'hex' }, [1540, 1300]);
code('Verify signature', CODE.verify_signature, [1760, 1300]);
ifNode('Link valid?', '={{ $json.ok }}', true, [1980, 1300]);
ifNode('Manifest link?', "={{ $json.kind === 'm' }}", true, [2200, 1260]);
code('Build manifest PDF', CODE.build_manifest, [2420, 1160]);
ifNode('Dummy mode?', `={{ ${C}.emr_mode === 'dummy' }}`, true, [2420, 1360]);
code('Dummy report PDF', CODE.dummy_report, [2640, 1280]);
add('Fetch report from EMR+', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: "={{ $('Config').first().json.cfg.emr_base + '/api/v1/instructions/medi_ref/' + $('Config').first().json.query.m + '/completed_report/?hubspot_deal_id=' + $('Config').first().json.query.i }}", ...HDR, options: { timeout: 120000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'file', outputPropertyName: 'data' } } } }, [2640, 1440], { onError: 'continueRegularOutput', notes: 'PLACEHOLDER until EMR+ is ready: set emr_base in Config and bind a Header Auth credential (Name: Authorization, Value: Api-Key <key>). Streams the PDF back to the gateway; nothing is stored.', notesInFlow: true });
code('Check report', CODE.check_report, [2860, 1440], 'EMR+ 429: wait and retry (emr_retry_429_*). EMR+ 500: retry once (emr_retry_500_*). 403, 400, 404, 409: no retry, answered straight back so the deal shows the reason.');
ifNode('Retry EMR+?', '={{ $json.retry }}', true, [3080, 1560]);
add('Wait before retry', 'n8n-nodes-base.wait', 1.1, { resume: 'timeInterval', amount: '={{ $json.wait }}', unit: 'seconds' }, [3080, 1700], { notes: 'Waits, then fetches the same report again. Keep the wait under 65 s so n8n holds the link request open.', notesInFlow: true });
ifNode('Report OK?', '={{ $json.ok }}', true, [3080, 1440]);
add('Send PDF', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'binary', inputDataFieldName: 'data', options: { responseCode: 200, responseHeaders: { entries: [{ name: 'Content-Type', value: 'application/pdf' }] } } }, [3300, 1260]);
add('Send error', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ $json.msg }}', options: { responseCode: '={{ $json.status }}' } }, [3300, 1560]);
link('Route', 'Check link', 3);
link('Check link', 'Link well-formed?');
link('Link well-formed?', 'Check signature', 0); link('Link well-formed?', 'Send error', 1);
chain('Check signature', 'Verify signature', 'Link valid?');
link('Link valid?', 'Manifest link?', 0); link('Link valid?', 'Send error', 1);
link('Manifest link?', 'Build manifest PDF', 0); link('Manifest link?', 'Dummy mode?', 1);
link('Build manifest PDF', 'Send PDF');
link('Dummy mode?', 'Dummy report PDF', 0); link('Dummy mode?', 'Fetch report from EMR+', 1);
link('Dummy report PDF', 'Send PDF');
chain('Fetch report from EMR+', 'Check report', 'Retry EMR+?');
link('Retry EMR+?', 'Wait before retry', 0); link('Retry EMR+?', 'Report OK?', 1);
link('Wait before retry', 'Fetch report from EMR+');
link('Report OK?', 'Send PDF', 0); link('Report OK?', 'Send error', 1);
// dry run: fetch every signed link exactly as the gateway would, but send nothing to the printer
ifNode('Dry run?', '={{ $(\'Config\').first().json.cfg.dry_run === true }}', true, [4180, -220]);
code('Dry run: fetch links, no printing', CODE.dry_run, [4400, -220], 'DRY RUN (Config dry_run = true): fetches each signed report link from this workflow, like the gateway would, so the signature, EMR+ call, size and PDF checks all run. NOTHING is sent to the printer. Deals are left Queued with a DRY RUN message, or Needs attention if a fetch failed.');
hsPost('Write dry run results', '/crm/v3/objects/deals/batch/update', '={{ {inputs:$json.inputs} }}', [4620, -220]);
link('Build print request', 'Dry run?'); link('Dry run?', 'Dry run: fetch links, no printing', 0); link('Dry run?', 'Submit to gateway', 1);
chain('Dry run: fetch links, no printing', 'Write dry run results', 'Next batch');

const main = {
  name: LIVE ? 'Lalu Print - Ops Portal (print run, stuck check, staff actions, report link)' : 'Lalu Print - Main (print run, stuck check, staff actions, report link)',
  nodes, connections: conns, active: false,
  settings: { executionOrder: 'v1', timezone: 'Europe/London', saveExecutionProgress: false, saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, executionTimeout: 7200 },
  pinData: {}, tags: []
};

// ---------- error workflow ----------
const en = [], ec = {};
en.push({ parameters: {}, id: uid(), name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0] });
en.push({ parameters: { fromEmail: 'REPLACE_FROM_EMAIL', toEmail: 'REPLACE_OPS_EMAIL', subject: '=Print automation FAILED: {{ $json.workflow.name }}', emailFormat: 'text', text: "={{ 'Workflow: ' + $json.workflow.name + '\\nFailed node: ' + ($json.execution.lastNodeExecuted || '') + '\\nError: ' + ($json.execution.error && $json.execution.error.message) + '\\nExecution: ' + ($json.execution.url || '') + '\\n\\nDo not re-run blindly: check the printer queue and deals in Preparing / Needs attention first.' }}", options: {} }, id: uid(), name: 'Email Ops and Engineering', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [240, 0], notes: 'Bind an SMTP credential. Set REPLACE_ values. No claimant data is included.', notesInFlow: true });
ec['Error Trigger'] = { main: [[{ node: 'Email Ops and Engineering', type: 'main', index: 0 }]] };
const err = { name: 'Lalu Print - Error alert', nodes: en, connections: ec, active: false, settings: { executionOrder: 'v1', timezone: 'Europe/London' }, pinData: {}, tags: [] };

fs.mkdirSync(require('path').join(__dirname,'..','n8n'), { recursive: true });
fs.writeFileSync(require('path').join(__dirname,'..','n8n', LIVE ? 'Lalu_Print_OpsPortal.json' : 'Lalu_Print_Main.json'), JSON.stringify(main, null, 2));
if (!LIVE) fs.writeFileSync(require('path').join(__dirname,'..','n8n','Lalu_Print_Error_Alert.json'), JSON.stringify(err, null, 2));
console.log('nodes', nodes.length, 'code nodes', nodes.filter(n => n.type.endsWith('.code')).length);
