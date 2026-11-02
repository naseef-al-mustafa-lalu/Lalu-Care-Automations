# Lalu print automation: n8n import pack (Phase 1)

**Files**
- `Lalu_Print_Main.json`: the one workflow (print run, monitor, staff actions). 50 nodes, 17 Code nodes, no placeholder checkpoints.
- `Lalu_Print_Error_Alert.json`: error workflow that emails Ops/Engineering.

**Status: inactive. Logic tested locally (204 checks on every Code node and the wiring). Not import-tested or run in a real n8n, and not run against HubSpot, EMR+, Gotenberg or a printer.** See "Pilot checklist".

## How it works (HubSpot is the only state store)
No Data Tables, no lock, no callbacks. Job state sits on each deal (`print_status`, `printer_job_reference`, `print_batch_id`, ...).

1. **Print run** (daily 08:30 UK time, or manual): guard (stop if any deal is still Preparing) → **printer pre-flight** → **daily allowance** → read the Queued deals, oldest first (paged) → resolve the single "Third party" company destination → claim deals as Preparing → per destination pack: download PDFs → manifest + merge in Gotenberg → send to the print bridge → write the result.
2. **Monitor** (every 5 min): looks up each Preparing / Sent-to-printer job on the bridge by `submission_ref` and updates HubSpot. Completed means Printed, hold released, and the existing stage handoff (PIP → Awaiting invoicing, UC/HAA → To be sent) only if the deal is still at its awaiting-printing stage and has no open print issue. Failed, missing or timed-out jobs go to Needs attention. It never prints.
3. **Staff actions**: HubSpot workflow calls the webhook with the deal ID, n8n re-reads the deal and validates. Rejections are written back as `REJECTED: reason` in the Print request note. Action is reset to None.

## Printer pre-flight and outcomes
Before anything is claimed the run calls the bridge `GET /status`. Nothing is printed or claimed unless the printer is ready.

| Bridge says | What happens |
|---|---|
| `ready` | continue |
| `ready_warning` (low toner/paper) | continue (warning is in the response, not alerted) |
| `busy` / queue has jobs (limit `max_preflight_queue_jobs`, default 0) | stop, alert email, deals stay Queued |
| `offline`, `jammed`, `paper_out`, `door_open`, `toner_empty`, `error`, `unknown` | stop, alert email naming the reason, deals stay Queued |
| bridge unreachable / non-200 | stop, alert email, deals stay Queued |

After a stop, fix the printer and start a manual run (there is no automatic second attempt today). During a job: submit accepted → Sent to printer; rejected or unknown → run stops, deals Needs attention; later the monitor reads `completed`, `failed`, `error` (with `reason`, e.g. paper jam) or `not_found`.

## Cardiff print gateway: what the real API changes (read before building)
The gateway details (Cardiff_Print_API_Details) differ from the bridge this pack assumed. **Done:** pre-flight now calls `GET http://10.0.60.33:8787/health` (needs `status: online`, `spoolerStatus: Running`, `printerStatus: Normal` when present, queue `CRD-PRN-01-AUTO`); stage IDs are set. **Not yet matched, needs a decision:**
1. `POST /print-jobs` takes JSON with a `documentUrl` the gateway downloads itself; file bytes are not accepted. The workflow still posts a merged PDF as multipart, so it will not print until we have a short-lived secure URL host for the PDFs.
2. Limits: 50 MB per file, 25 jobs per batch, PDF only. One merged pack of up to 50 reports will not fit; the realistic shape is one job per report plus the manifest as job 1 (max 24 reports per request), and EMR+ reports over 50 MB go to Needs attention.
**Confirmed 2 Nov from n8n:** `/health` at the address above returns 200 with `printerStatus: Normal`, so the gateway does report printer state. Which faults change it (jam, paper-out, toner) is still untested.
3. The result is synchronous (`jobsCompleted`/`jobsFailed` counts, no per-job lookup, no job status endpoint). "Printed" can only mean "accepted by the Ricoh queue"; jams, paper-out and toner cannot be detected, only spooler state.
4. Auth: header `X-Print-Agent-Token` held as an n8n Header Auth credential, never in the JSON. The token was shared in a document and chat; rotate it before production.

## Limits (Config node)
- `max_reports_per_pack`: reports per destination batch (default 50). Bigger destinations split into several packs.
- `max_reports_per_day`: total reports per day (default 200). Counted against deals with a Print submitted at date today (UK time), oldest queued first; the rest stay Queued for tomorrow.

## Set up (in this order)
1. **HubSpot properties** (Deal, group "Printer information"). **Config currently holds my guessed internal names; replace them with the real ones you created:**
   `print_status` (enum: queued, preparing, sent_to_printer, printed, needs_attention), `print_queued_at` (datetime), `print_batch_id`, `print_destination`, `printer_job_reference` (text), `print_submitted_at`, `print_completed_at` (datetime), `print_issue` (text), `dispatch_hold_printing` (checkbox, true/false), `print_action` (enum: none, report_problem, resolve_problem, print_reprint), `print_request_note` (text).
2. **HubSpot workflow A (queue)**: when a deal enters an awaiting-printing stage and `print_status` is empty → set `print_status=queued`, `print_queued_at=now`, `dispatch_hold_printing=true`.
3. **HubSpot workflow B (staff)**: when `print_action` is any of report_problem / resolve_problem / print_reprint → "Send a webhook" POST to `https://<n8n>/webhook/lalu-print-action` with the Header Auth header and JSON body `{"deal_id": "<Record ID>"}`. (If your plan lacks this action, replace the webhook with a Schedule + search on `print_action` is not none; ask and I'll add the branch.)
4. **Import** both JSONs. In `Lalu Print - Main`, open **Config** and replace every `REPLACE_` value: EMR host, Gotenberg URL, pipeline ID, stage IDs (awaiting-print x2, Awaiting invoicing, To be sent, Cancelled, Rejected), company destination property, bridge URLs. The "Check config" node refuses to run while any `REPLACE_` remains.
5. **Credentials**: HubSpot OAuth2 (read/write deals, read companies, read associations); EMR Header Auth (`Authorization` = `Api-Key <key>`); bridge Header Auth; webhook Header Auth; SMTP (error workflow). Fill the `REPLACE_` emails in the error workflow.
6. **Workflow settings**: set Main → Settings → Error workflow = `Lalu Print - Error alert`. n8n env: `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` (reports up to 150 MB), `EXECUTIONS_DATA_PRUNE=true`. Execution data saving is off in the file so PDFs are never retained; switch it on in staging only if you need to debug.
7. **Print bridge** (DevOps, on the office laptop) must offer this contract; n8n cannot print by itself:
   - `POST /submit` multipart: `file` (one PDF: manifest first, reports in order), `submission_ref`. Return 2xx `{"status":"accepted"}`; 4xx if it definitively refused; anything else/timeout is treated as "unknown".
   - `GET /status` → 200 `{"state":"ready|ready_warning|busy|offline|jammed|paper_out|door_open|toner_empty|error|unknown","queued_jobs":0,"message":"","warning":""}`. SumatraPDF only gives an exit code, so printer state must come from the Windows print queue (e.g. PowerShell `Get-Printer` / `Get-PrintJob`) or the printer's own status.
   - `GET /job?submission_ref=…` → 200 `{"status":"accepted|completed|failed|error","completed_at":"ISO","reason":"for failed/error"}` or 404 if it has no such job. It must remember jobs for at least the same working day and handle queue name, tray, one copy, duplex (keep one-sided until blank-page handling exists). Printing with SumatraPDF: `SumatraPDF.exe -print-to "<queue>" -print-settings "1x,simplex,paper=A4" -silent file.pdf`.
   - It deletes its spool copy after printing.

## What changed from the earlier drafts (all audit fixes)
- **Code-node mode bugs gone**: every Code node uses all-items mode with `$input` / `$('Node')`; no `$json`/`.item` mixing.
- **Report type mapping**: HubSpot internal values (`PIP`, `UC&ESA`, `Health Assessment Advisory Service`; labels are DWP- PIP, DWP - UC-113, DWP - Health Assessment Advisory Service) are mapped to PIP/UC/HAA. The old JSON compared them to "PIP/UC/HAA" directly and would have rejected every deal.
- **Real error handling per case**: EMR+ codes are read from the response. 409 not completed / not available, 404 mismatch / not found, report too large → Needs attention with a readable reason. 429, 5xx, network → deal goes back to Queued with a note ("retry next run"). 403 on every download → run stops with an alert.
- **Failures never strand the run**: no-PDF packs write their failures and continue; unsafe printer results (rejected/unknown) stop the run with an email, and untouched deals fall to Needs attention via the monitor after 60 min.
- **Webhook never hangs**: responds 200 immediately; errors alert by email.
- **Recovery grace**: the monitor only flags a Preparing deal after 60 min (`preparing_timeout_minutes`).
- **A4**: manifest sent with `preferCssPageSize=true`.
- **Pack size**: split by report count (50, configurable); merged pack capped at 400 MB; single report cap = 150 MiB (157,286,400 bytes).
- **Associations**: read through the v4 batch associations API, matched by label "Third party"; exactly one destination required.
- **One config**, batch IDs `PRINT-YYYYMMDD-HHMM`, packs `…-P01`.
- **Overlap protection**: one guard (no Preparing deals) instead of a lock. There is a seconds-wide window if a manual run starts at the same instant as the schedule; don't click it at 08:30.

## Decisions made to keep it simple (tell me if you disagree)
- Daily at 08:30 UK (n8n timezone is Europe/London, so BST/GMT is handled).
- "Report not completed" goes to Needs attention (staff Print / reprint later), not an automatic retry.
- Printed = the bridge reports completion. Keep a quick manifest check before posting, as the old spec had.
- No separate event/audit table: history is HubSpot property history plus the n8n error emails.

## Pilot checklist (not yet verified)
1. Import into staging; confirm no warnings.
2. **Search paging**: the Read queue / Find active jobs pagination option adds `after` to the JSON body. Test with more than 100 queued deals.
3. **Gotenberg calls**: the manifest and merge requests are built as multipart bytes in Code nodes and sent as a binary body with the boundary in the Content-Type header. Confirm Gotenberg returns a PDF (and the Merge node "combine by position" keeps both binaries).
4. EMR+ test cases from the API email (PIP/UC/HAA, wrong deal ID, not completed, bad key, wrong IP).
5. Bridge: accepted / rejected / timeout / duplicate submission_ref, lookup after restart, one paper run end to end.
6. Staff actions: all three, with and without a note, while a job is active.
7. Kill n8n mid-run; confirm the monitor ends in Needs attention and nothing prints twice.

## Gateway test pack (run this first)
Two extra workflows prove the Cardiff gateway connection before the real print step is rebuilt. Dummy one-page PDFs only.
1. Import `Lalu_Print_Test_File_Server.json`, replace `REPLACE_TEST_FILE_TOKEN` (random string), activate it. It serves `GET /webhook/print-test-file`.
2. Import `Lalu_Print_Gateway_Test.json`. Create a Header Auth credential (`X-Print-Agent-Token` = gateway token) and attach it to both HTTP nodes. In Config set `n8n_public_base` (URL the Cardiff laptop can reach) and the same token.
3. Run with `send_print_job: false`: health check only. Read the output of "Health-only result" (what `/health` returns, and whether n8n can reach 10.0.60.33:8787).
4. Tell Cardiff, then set `send_print_job: true`, `pages: 1`. If it prints: the gateway can fetch an n8n link (answers questions 1 and 2). Note the seconds taken and the response.
5. Further tests (one at a time): `pages: 3` (print order), `sha256_mode: wrong` (is it checked?), a second run with the same jobId (duplicates), a bad link (failure detail).
