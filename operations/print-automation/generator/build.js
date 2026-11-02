const fs = require('fs'); const crypto = require('crypto');
const CODE = require('./code.js');
const uid = () => crypto.randomUUID();

// ---------- config (single place) ----------
const cfg = {
  hubspot_base: 'https://api.hubapi.com',
  emr_base: 'https://REPLACE_EMR_HOST',
  gotenberg_base: 'http://REPLACE_INTERNAL_GOTENBERG:3000',
  pipeline_id: '28557963',
  awaiting_print_stages: ['64932357', '64932356'],
  pip_invoicing_stage: '64932358',
  to_be_sent_stage: '65006207',
  cancelled_rejected_stages: ['81292295', '65056856'],
  fields: {
    case_ref: 'mediref', report_type: 'report_type',
    status: 'print_status', queued_at: 'print_queued_at', batch: 'print_batch_id', destination: 'print_destination',
    submitted_at: 'print_submitted_at', completed_at: 'print_completed_at', job_ref: 'printer_job_reference',
    issue: 'print_issue', hold: 'dispatch_hold_printing', action: 'print_action', request_note: 'print_request_note'
  },
  values: {
    queued: 'queued', preparing: 'preparing', submitted: 'sent_to_printer', printed: 'printed', issue: 'needs_attention',
    action_none: 'none', action_problem: 'report_problem', action_resolve: 'resolve_problem', action_print: 'print_reprint'
  },
  report_types: { 'PIP': 'PIP', 'UC&ESA': 'UC', 'Health Assessment Advisory Service': 'HAA' },
  company_destination_field: 'REPLACE_COMPANY_DESTINATION_PROPERTY',
  third_party_label: 'Third party',
  printer_submit_url: 'https://REPLACE_PRINT_BRIDGE/submit',
  printer_lookup_url: 'https://REPLACE_PRINT_BRIDGE/job',
  printer_status_url: 'http://10.0.60.33:8787/health',
  printer_queue: 'CRD-PRN-01-AUTO',
  max_reports_per_pack: 50,
  max_reports_per_day: 200,
  max_preflight_queue_jobs: 0,
  max_report_bytes: 157286400,
  max_pack_bytes: 400000000,
  completion_timeout_minutes: 30,
  preparing_timeout_minutes: 60
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
const HS = { authentication: 'predefinedCredentialType', nodeCredentialType: 'hubspotOAuth2Api' };
const HDR = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
const paginate = { pagination: { pagination: { parameters: { parameter: [{ type: 'body', name: 'after', value: '={{ $response.body.paging.next.after }}' }] }, paginationMode: 'updateAParameterInEachRequest', paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body.paging || !$response.body.paging.next || !$response.body.paging.next.after }}', limitPagesFetched: true, maxRequests: 50 } } };
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
note('README', '# Lalu print automation (Phase 1)\nOne workflow, three flows:\n**1 Print run** (daily 08:30 UK or manual) → **2 Monitor** (every 5 min) → **3 Staff actions** (HubSpot webhook).\nHubSpot is the only state store. Edit settings ONLY in the **Config** node. See README.md for bindings. Activate only after the pilot checklist.', [0, -420], 560, 180);
add('Daily 08:30 print run', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: '30 8 * * *' }] } }, [0, 0]);
add('Manual print run', 'n8n-nodes-base.manualTrigger', 1, {}, [0, 120]);
add('Every 5 min monitor', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } }, [0, 300]);
add('Staff action webhook', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'lalu-print-action', authentication: 'headerAuth', responseMode: 'onReceived', options: {} }, [0, 480], { notes: 'Bind a Header Auth credential. HubSpot workflow "Send a webhook" sends header + body {"deal_id": "<Record ID>"}. Replies 200 immediately.', notesInFlow: true });
flowSet('Flow: print', 'print', [220, 60]); flowSet('Flow: monitor', 'monitor', [220, 300]); flowSet('Flow: staff', 'staff', [220, 480]);
link('Daily 08:30 print run', 'Flow: print'); link('Manual print run', 'Flow: print'); link('Every 5 min monitor', 'Flow: monitor'); link('Staff action webhook', 'Flow: staff');
add('Config', 'n8n-nodes-base.set', 3.4, { mode: 'raw', jsonOutput: JSON.stringify({ cfg }, null, 2), includeOtherFields: true, options: {} }, [440, 240], { notes: 'ALL settings live here. Replace every REPLACE_ value. Property names/values match the Printing automation section in HubSpot.', notesInFlow: true });
['Flow: print', 'Flow: monitor', 'Flow: staff'].forEach(f => link(f, 'Config'));
code('Check config', CODE.check_config, [660, 240]);
add('Route', 'n8n-nodes-base.switch', 3.2, { rules: { values: ['print', 'monitor', 'staff'].map(k => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uid(), leftValue: "={{ $('Config').first().json.flow }}", rightValue: k, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: k })) }, options: {} }, [880, 240]);
chain('Config', 'Check config', 'Route');

// ---------- FLOW 1: PRINT RUN ----------
note('Flow 1 note', '## 1. Print run\nGuard → read queue → resolve destination → claim (Preparing) → per destination pack: download PDFs → manifest + merge → send to printer → record result. Any unsafe printer result stops the run (alert email).', [1100, -330], 520, 130);
search('Guard: any Preparing deals?', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.status,operator:'EQ',value:${C}.values.preparing}]`, [1100, -120], false);
code('Stop if run unfinished', CODE.stop_if_blocked, [1320, -120]);
search('Read queue', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.status,operator:'EQ',value:${C}.values.queued}]`, [1540, -120], true, true);
add('Printer status check', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `={{ ${C}.printer_status_url }}`, ...HDR, options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [1320, 40], { onError: 'continueRegularOutput', notes: 'Pre-flight: bridge + printer state before anything is claimed.', notesInFlow: true });
code('Printer ready?', CODE.printer_ready, [1540, 40], 'ready / ready_warning continue. offline, jammed, paper_out, door_open, toner_empty, error, busy, unreachable => stop + alert email, nothing claimed.');
search('Count sent today', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.submitted_at,operator:'GTE',value:$json.day_start_ms}]`, [1760, 40], false);
code('Daily allowance', CODE.daily_allowance, [1980, 40], 'Daily limit minus reports already sent today. 0 left => run ends quietly.');
code('Select queued deals', CODE.select_queued, [1760, -120]);
add('Read Third party associations', 'n8n-nodes-base.httpRequest', 4.2, { method: 'POST', url: `={{ ${C}.hubspot_base + '/crm/v4/associations/deals/companies/batch/read' }}`, ...HS, sendBody: true, specifyBody: 'json', jsonBody: '={{ {inputs:$json.inputs} }}', options: { response: { response: { neverError: true } } } }, [1980, -120], retry);
code('Prepare company reads', CODE.prepare_companies, [2200, -120]);
hsPost('Read destination companies', '/crm/v3/objects/companies/batch/read', `={{ {properties:[${C}.company_destination_field],inputs:$json.inputs} }}`, [2420, -120], { response: { response: { neverError: true } } });
code('Build packs and claim updates', CODE.build_packs, [2640, -120], 'Invalid cases go to Needs attention with the reason; valid cases are claimed as Preparing and grouped by destination (sorted).');
hsPost('Claim deals', '/crm/v3/objects/deals/batch/update', '={{ {inputs:$json.inputs} }}', [2860, -120]);
code('List packs', CODE.list_packs, [3080, -120]);
add('Next pack', 'n8n-nodes-base.splitInBatches', 3, { batchSize: 1, options: {} }, [3300, -120], { notes: 'Output 1 (loop) = next destination pack. Output 0 (done) = finished.', notesInFlow: true });
code('Expand cases', CODE.expand_cases, [3520, 0]);
add('Download report', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `={{ ${C}.emr_base + '/api/v1/instructions/medi_ref/' + $json.case.mediref + '/completed_report/?hubspot_deal_id=' + $json.case.deal_id }}`, ...HDR, options: { timeout: 120000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'file', outputPropertyName: 'pdf' } } } }, [3740, 0], { onError: 'continueRegularOutput', notes: 'Bind Header Auth credential: Name=Authorization, Value=Api-Key <key>.', notesInFlow: true });
code('Build pack PDF', CODE.build_pack, [3960, 0], 'Sorts downloads into OK/failed (using EMR+ error codes) and prepares the manifest request.');
add('Any reports OK?', 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uid(), leftValue: '={{ $json.pack_ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }, [4180, 0]);
const gotenberg = (name, path, field, ctExpr, outName, pos) => add(name, 'n8n-nodes-base.httpRequest', 4.2, { method: 'POST', url: `={{ ${C}.gotenberg_base + '${path}' }}`, sendHeaders: true, headerParameters: { parameters: [{ name: 'Content-Type', value: ctExpr }] }, sendBody: true, contentType: 'binaryData', inputDataFieldName: field, options: { timeout: 120000, response: { response: { responseFormat: 'file', outputPropertyName: outName } } } }, pos, retry);
gotenberg('Render manifest (Gotenberg)', '/forms/chromium/convert/html', 'manifest_req', '={{ $json.manifest_ct }}', 'manifest_pdf', [4400, -60]);
add('Combine reports and manifest', 'n8n-nodes-base.merge', 3, { mode: 'combine', combineBy: 'combineByPosition', options: {} }, [4620, 0]);
code('Build merge request', CODE.build_merge, [4840, 0]);
gotenberg('Merge pack (Gotenberg)', '/forms/pdfengines/merge', 'merge_req', '={{ $json.merge_ct }}', 'pack', [5060, 0]);
code('Validate pack', CODE.validate_pack, [5280, 0]);
add('Send pack to printer', 'n8n-nodes-base.httpRequest', 4.2, { method: 'POST', url: `={{ ${C}.printer_submit_url }}`, ...HDR, sendBody: true, contentType: 'multipart-form-data', bodyParameters: { parameters: [{ parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'pack' }, { name: 'submission_ref', value: '={{ $json.submission_ref }}' }] }, options: { timeout: 120000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [5500, 0], { onError: 'continueRegularOutput', notes: 'NO retries here: a retry could print twice. Timeouts/errors are treated as "unknown".', notesInFlow: true });
code('Print outcome', CODE.print_outcome, [5720, 0]);
hsPost('Write print results', '/crm/v3/objects/deals/batch/update', '={{ {inputs:$json.inputs} }}', [5940, 0]);
code('Stop if printer result unsafe', CODE.stop_if_unsafe, [6160, 0]);
code('Failure updates (nothing to print)', CODE.failure_updates, [4400, 200]);
hsPost('Write failures', '/crm/v3/objects/deals/batch/update', '={{ {inputs:$json.inputs} }}', [4620, 200]);
chain('Route', 'Guard: any Preparing deals?'); // placeholder, fixed below with output index
delete conns['Route']; link('Route', 'Guard: any Preparing deals?', 0);
chain('Guard: any Preparing deals?', 'Stop if run unfinished', 'Printer status check', 'Printer ready?', 'Count sent today', 'Daily allowance', 'Read queue', 'Select queued deals', 'Read Third party associations', 'Prepare company reads', 'Read destination companies', 'Build packs and claim updates', 'Claim deals', 'List packs', 'Next pack');
link('Next pack', 'Expand cases', 1);
chain('Expand cases', 'Download report', 'Build pack PDF', 'Any reports OK?');
link('Any reports OK?', 'Render manifest (Gotenberg)', 0); link('Any reports OK?', 'Combine reports and manifest', 0);
link('Render manifest (Gotenberg)', 'Combine reports and manifest', 0); // second input fixed below
// merge inputs: first branch -> input 0, gotenberg -> input 1
conns['Any reports OK?'].main[0] = [{ node: 'Render manifest (Gotenberg)', type: 'main', index: 0 }, { node: 'Combine reports and manifest', type: 'main', index: 0 }];
conns['Render manifest (Gotenberg)'] = { main: [[{ node: 'Combine reports and manifest', type: 'main', index: 1 }]] };
chain('Combine reports and manifest', 'Build merge request', 'Merge pack (Gotenberg)', 'Validate pack', 'Send pack to printer', 'Print outcome', 'Write print results', 'Stop if printer result unsafe');
link('Stop if printer result unsafe', 'Next pack');
link('Any reports OK?', 'Failure updates (nothing to print)', 1);
chain('Failure updates (nothing to print)', 'Write failures'); link('Write failures', 'Next pack');

// ---------- FLOW 2: MONITOR ----------
note('Flow 2 note', '## 2. Monitor (every 5 min)\nLooks up every Preparing / Sent-to-printer job on the print bridge and updates HubSpot: Printed (+ release hold + existing stage handoff), Needs attention (failed, missing, timed out). Never prints anything.', [1100, 330], 520, 130);
search('Find active print jobs', `[{propertyName:'pipeline',operator:'EQ',value:${C}.pipeline_id},{propertyName:${C}.fields.status,operator:'IN',values:[${C}.values.preparing,${C}.values.submitted]}]`, [1100, 540]);
code('Group jobs', CODE.group_jobs, [1320, 540]);
add('Look up printer job', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `={{ ${C}.printer_lookup_url + '?submission_ref=' + encodeURIComponent($json.job_ref) }}`, ...HDR, options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [1540, 540], { onError: 'continueRegularOutput' });
code('Decide monitor updates', CODE.decide_monitor, [1760, 540]);
hsPost('Apply monitor updates', '/crm/v3/objects/deals/batch/update', '={{ {inputs:$json.inputs} }}', [1980, 540]);
link('Route', 'Find active print jobs', 1);
chain('Find active print jobs', 'Group jobs', 'Look up printer job', 'Decide monitor updates', 'Apply monitor updates');

// ---------- FLOW 3: STAFF ----------
note('Flow 3 note', '## 3. Staff actions\nHubSpot sends the deal ID. n8n re-reads the deal, validates the request (note required, no active job, etc.) and updates it. Rejections are written to the Print request note as "REJECTED: …". Action is reset to None.', [1100, 760], 520, 130);
code('Read staff request', CODE.read_request, [1100, 960]);
add('Read deal', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `={{ ${C}.hubspot_base + '/crm/v3/objects/deals/' + $json.deal_id + '?properties=' + ${props}.join(',') }}`, ...HS, options: {} }, [1320, 960], retry);
add('Look up job for request', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `={{ ${C}.printer_lookup_url + '?submission_ref=' + encodeURIComponent($json.properties[${C}.fields.job_ref] || 'none') }}`, ...HDR, options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, [1540, 960], { onError: 'continueRegularOutput' });
code('Decide staff action', CODE.decide_staff, [1760, 960]);
add('Apply staff action', 'n8n-nodes-base.httpRequest', 4.2, { method: 'PATCH', url: `={{ ${C}.hubspot_base + '/crm/v3/objects/deals/' + $json.deal_id }}`, ...HS, sendBody: true, specifyBody: 'json', jsonBody: '={{ {properties:$json.properties} }}', options: {} }, [1980, 960], retry);
link('Route', 'Read staff request', 2);
chain('Read staff request', 'Read deal', 'Look up job for request', 'Decide staff action', 'Apply staff action');

const main = {
  name: 'Lalu Print - Main (print run, monitor, staff actions)',
  nodes, connections: conns, active: false,
  settings: { executionOrder: 'v1', timezone: 'Europe/London', saveExecutionProgress: false, saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, executionTimeout: 3000 },
  pinData: {}, tags: []
};

// ---------- error workflow ----------
const en = [], ec = {};
en.push({ parameters: {}, id: uid(), name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0] });
en.push({ parameters: { fromEmail: 'REPLACE_FROM_EMAIL', toEmail: 'REPLACE_OPS_EMAIL', subject: '=Print automation FAILED: {{ $json.workflow.name }}', emailFormat: 'text', text: "={{ 'Workflow: ' + $json.workflow.name + '\\nFailed node: ' + ($json.execution.lastNodeExecuted || '') + '\\nError: ' + ($json.execution.error && $json.execution.error.message) + '\\nExecution: ' + ($json.execution.url || '') + '\\n\\nDo not re-run blindly: check the printer queue and deals in Preparing / Needs attention first.' }}", options: {} }, id: uid(), name: 'Email Ops and Engineering', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [240, 0], notes: 'Bind an SMTP credential. Set REPLACE_ values. No claimant data is included.', notesInFlow: true });
ec['Error Trigger'] = { main: [[{ node: 'Email Ops and Engineering', type: 'main', index: 0 }]] };
const err = { name: 'Lalu Print - Error alert', nodes: en, connections: ec, active: false, settings: { executionOrder: 'v1', timezone: 'Europe/London' }, pinData: {}, tags: [] };

fs.mkdirSync(require('path').join(__dirname,'..','n8n'), { recursive: true });
fs.writeFileSync(require('path').join(__dirname,'..','n8n','Lalu_Print_Main.json'), JSON.stringify(main, null, 2));
fs.writeFileSync(require('path').join(__dirname,'..','n8n','Lalu_Print_Error_Alert.json'), JSON.stringify(err, null, 2));
console.log('nodes', nodes.length, 'code nodes', nodes.filter(n => n.type.endsWith('.code')).length);
