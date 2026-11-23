# Lalu Print Automation: Process Flow, Credentials and Status

> Snapshot of the Google Doc "Lalu Print Automation: Process Flow, Credentials and Status" (https://docs.google.com/document/d/1jmkVAFaXcQGtFlXnYkrO2ZVcsSJf3v8tp6oqTKOoZJQ/edit), taken 4 November 2026. The Google Doc is the working copy; this file is for reference alongside the workflow. It contains no secrets and no patient data.

## 1. What changed since the 2 November plan

The six-step flow and the HubSpot deal section are unchanged. The printer connection is now proven, and three design choices were made for data security and simplicity.

- **Printer connection is real and tested.** n8n talks to the Cardiff print gateway (CRD-PRINT-GW01) which prints on the Ricoh queue CRD-PRN-01-AUTO. Pages printed in the correct order. After IT's fix each job takes about 6 seconds (previously about 126 seconds).
- **No external tools.** Manifests are built as a plain PDF inside n8n. Nothing leaves Lalu systems.
- **No report is stored anywhere.** n8n streams each PDF straight from EMR+ to the gateway when the gateway asks for it (see section 3).
- **HubSpot is the only record of the state.** The n8n Data Tables from the earlier plan are not used. Print status, batch ID, job reference and issues all live on the deal.
- **Schedule:** Monday to Friday from 08:30 Europe/London; if the printer is offline n8n checks again every 30 minutes until 16:30 (the earlier plan said 09:00 on working days), with a configurable batch size and a daily limit.

## 2. The process flow

### 1. Add ready cases to the queue
When a deal first enters an awaiting-printing stage, a HubSpot workflow sets:
- Print status = Queued
- The queue time
- Dispatch hold - printing = Yes

Stages: UC/HSA awaiting printing (64932356), PIP awaiting printing (64932357). Processed or active cases are kept out of re-enrolment. No report download happens yet.

### 2. Select the cases for this run (n8n, from 08:30 on working days)
1. n8n first checks the printer is ready (gateway health: status online, spooler running, printer Normal, correct queue).
2. If not ready, nothing is sent and the team is alerted.
3. n8n then reads the queue and checks case reference (mediref), report type and destination.
4. Invalid cases are flagged on the deal.
5. Valid cases are given a batch ID, marked Preparing, and capped by the batch size and the daily limit.
6. Later arrivals wait for the next run.

### 3. Prepare the reports by destination
1. Cases are grouped by destination (the `destination_address` property on the deal, synced from the Third party company).
2. For each destination, n8n builds a manifest PDF containing: case reference, report type, destination, number of reports, batch ID, date and time. No claimant names unless the spec requires them.

**Manifest layout:** the batch ID, destination, number of reports, and date and time appear once, at the top of the manifest. The case reference and report type appear once per report, as one line per report, in the same order the reports print behind it. Staff use this to check the printed stack against the sheet.

Reports are **not downloaded in advance**: n8n creates signed links that expire after 30 minutes, one per report. The manifest is the first job, then each report in order, up to 24 reports per call to the gateway.

**More than 24 reports:** a destination with more reports than fit in one call is sent in several calls. Each call gets its own manifest, labelled as a part of the batch (for example part 1 of 2), listing only the reports in that call.

### 4. Send one destination batch at a time
n8n sends one batch to the gateway. For each link, the gateway calls back to n8n; n8n then fetches that single report from EMR+ and streams it back. Nothing is saved on n8n or the gateway beyond the print spool. Deals are marked Sent to the printer only when the gateway accepts the batch.

- **If printing is uncertain:** a timeout means "sent, result unknown". n8n never resends automatically. Further batches stop and the team checks the printer output and queue first. This was seen in testing: a call timed out at 5 minutes but the pages had printed.

### 5. Printer confirms completion
The gateway returns a result per job in the same response (batch status and each job's result or error code). n8n marks only the matching cases Printed and records the completion time. A failed job goes to Needs attention immediately with the reason in Print issue. There is no separate callback.

### 6. Return to the current fulfilment process
After successful printing with no open issue:
1. The printing hold is cleared. UC/HSA moves to Completed (65006208).
2. PIP moves to PIP Awaiting Invoicing (64932358).
3. A stage staff already changed is never overwritten. Reprints never move a deal backwards.

## 3. How a report reaches the printer

| Step | Who | What happens |
|---|---|---|
| a | n8n | Builds the manifest and signed links, one per PDF, each valid for 30 minutes. |
| b | n8n to Cardiff gateway | POST /print-jobs with the job list (manifest first). Authenticated with the gateway token. |
| c | Gateway to n8n | For each job the gateway requests its link (outbound HTTPS from the Cardiff laptop to automation.lalu.co.uk). |
| d | n8n to EMR+ | n8n validates the link, calls the EMR+ completed-report API with the EMR+ key, and streams the PDF back without saving it. |
| e | Gateway to Ricoh | Prints in order, one job at a time, and returns a result per job to n8n. |
| f | n8n to HubSpot | Updates print status, completion time, issues and the stage handoff on each deal. |

## 4. Credentials: what they are, where they are stored

**Rule:** every secret is stored only as a saved credential inside n8n (automation.lalu.co.uk). None is in this document, in GitHub, in a workflow file, in HubSpot or in chat. Workflow files only name a credential; they never contain its value.

| Credential | Used for | Where stored | Who creates it | Status |
|---|---|---|---|---|
| Cardiff print gateway token (header X-Print-Agent-Token) | Sending print jobs and the health check to the gateway | n8n credential "Cardiff Print Agent — live" (Header Auth) | Naseef, token issued by Lalu IT (Jade) | In place and tested. Pilot token: must be rotated before production. |
| EMR+ API key (Authorization: Api-Key) | Fetching completed report PDFs by mediref and deal ID | n8n Header Auth credential. Key is created in EMR+ Django admin (API EMR, internal keys). | Naseef with Liting & Emily (EMR+) | Pending |
| HubSpot connection (Header Auth, Bearer token) | Reading and updating deals | n8n Header Auth credential | Naseef (HubSpot admin) | To connect to the sandbox portal first, then live. |
| Link-signing secret | Signing and checking the report links | Set in the n8n workflow Config node (`link_secret`). Never in GitHub. n8n code nodes cannot read credentials, so this is the one secret not held as a credential. | Naseef (a long random string) | To be set when the workflow is imported. |
| Staff-action webhook | Telling n8n that Print action changed | No credential: a HubSpot private app webhook subscription (deal.propertyChange on print_action) posts to the n8n URL. n8n trusts only the deal ID and re-reads the deal. | Naseef | To be created (private app). |
| Email (SMTP) for alerts | Error alert emails to the team | n8n SMTP credential | Lalu IT | To be confirmed. |

### Network and access notes
- n8n runs on Google Cloud (outbound IP 34.142.83.45). It cannot reach private Lalu addresses by default; the gateway is reached at 10.0.60.33:8787, which worked in testing.
- EMR+ may restrict by IP. The allow-list is blank by default (any IP). Confirm whether 34.142.83.45 should be added.
- Credentials in n8n are visible only to named n8n users. Keep n8n user access to those who need it.
- Rotate any token that was used during testing before go-live.

## 5. Data security rules

- PDFs pass through n8n in memory only. They are not saved as files, in n8n storage, in GitHub, or by any external service.
- No external conversion or storage tools.
- Manifests contain case references and counts only.
- Report links are signed, tied to one report and expire after 30 minutes. They are not strictly one-time, because n8n keeps no state between runs.
- Execution logs must not keep PDF content. Confirm n8n execution data retention with IT before go-live.
- GitHub holds workflow definitions and documentation only. No secrets and no patient data.

## 6. HubSpot Deal - Printing Information section (left menu)

| Property | Use |
|---|---|
| Print status | Queued, Preparing, Sent to printer, Printed, Needs attention |
| Print action | None, Report problem, Resolve problem, Print / reprint, Printed manually. Staff set it with a Print request note; n8n processes it and resets to None. |
| Dispatch hold - printing | Yes from queue entry until successful printing with no open issue |
| Print queued at, Print batch ID, Print destination, Printer job reference, Print submitted at, Print completed at, Print issue, Print request note | Timing, batch link, destination used, job reference, and the reason for any problem |

## 7. Staff actions

- **Report problem:** staff set the Print action property to Report problem and add a Print request note. n8n then sets Print status = Needs attention and Dispatch hold - printing = Yes, copies the problem into Print issue, and resets Print action to None. The deal stays in its current pipeline stage.
- **Resolve problem:** staff set the Print action property to Resolve problem and add a Print request note describing the fix. If the earlier job has a successful result, n8n sets Print status = Printed, sets Dispatch hold - printing = No, clears Print issue, and applies the normal stage handoff (UC/HSA to To be sent, PIP to PIP Awaiting Invoicing). If not, Print status stays "Needs attention" and the hold stays Yes. Print action is reset to None.
- **Print / reprint:** staff first check the printer output, then set the Print action property to Print / reprint and add a Print request note giving the reason. n8n sets Print status = Queued and Dispatch hold - printing = Yes, and the case joins the next scheduled run with a new batch ID. The request is refused if an earlier job is still active or its result is unknown. Print action is reset to None.
- **Printed manually:** if staff print a report by hand, they set Print action to Printed manually and add a Print request note (required). n8n sets Print status = Printed, Dispatch hold - printing = No, clears Print issue, records the completion time with job reference "Manual", and applies the normal stage handoff. Refused while Preparing or Sent to printer, or if already Printed or cancelled. Print action is reset to None.

## 8. Error catching and recovery

- One run at a time. The run checks for an active batch before starting.
- Timeout or restart during sending: mark the batch "sent, result unknown", stop, and alert. Staff check the printer, then use Print / reprint if needed. Never auto-resend.
- A HubSpot update failure never triggers reprinting; only the deal update is retried.
- If the printer is not ready at 08:30, nothing is sent and the team is alerted once. n8n checks again every 30 minutes and runs the batches once, as soon as the printer is online. If it is still offline at 16:30 the team is alerted again; cases stay Queued and the next weekday run tries again.

| What goes wrong | What the deal shows | What happens next |
|---|---|---|
| Printer not ready at 08:30 (health check fails) | Stays Queued | Nothing is sent and the team is alerted. n8n checks again every 30 minutes until 16:30 and runs the batches once the printer is online. If it is still offline at 16:30, the team is alerted again and the cases are picked up at the next weekday run. |
| Gateway rejects the call (wrong or missing token, more than 25 jobs, report over 150 MB, not a PDF) | Needs attention, reason in Print issue | Nothing prints. Fix the cause, then use Print / reprint. |
| A report cannot be fetched from EMR+ (400, 404 or 409: case or deal ID mismatch, not completed, report not available, report too large) | Needs attention, reason in Print issue | The gateway reports that job as failed. The manifest already lists the case, so staff are told which report is missing. Whether later jobs still print is to be confirmed in the pilot. Reprint once fixed. |
| EMR+ rejects the key or IP address (403) | Needs attention on the affected cases | The run stops and the team is alerted. Fix the key or the IP allow-list, then reprint. Tell Naseef: this is a credentials issue. |
| EMR+ rate limit or server error (429, 500) | Needs attention if it continues | 429: n8n waits 60 seconds and retries up to twice. 500: n8n waits 30 seconds and retries once. If it still fails the job fails as above: for 429 try again later, for 500 ask Emily to check Sentry. |
| Link expired, already used, or the gateway cannot reach n8n | Needs attention, reason in Print issue | The job fails. A reprint creates new links. |
| Call times out | Needs attention, result unknown, with the printer state from a health check made straight afterwards (for example "printer Normal, spooler Running", or "gateway did not answer") | Never resent automatically. Staff check the printer output and queue, then Resolve problem or Print / reprint. |
| Manifest cannot be built | Needs attention | That destination is not sent. Other destinations continue. |
| n8n restarts during a run | Left in Preparing or Sent to printer | Nothing is resent automatically. Staff check the output, then use Print / reprint. |
| Daily limit reached | Stays Queued | Remaining cases wait for the next run, oldest first. |
| Wrong checksum or duplicate job ID (untested) | To be confirmed | To test in the pilot. Treated as a failed job until tested. |
| Paper jam, out of paper or toner problem (untested) | Stays Queued | The printer status should stop the next run. To test in the pilot. |

- **Decision to confirm:** EMR+ failures during printing. The report is fetched while the gateway prints, so a failure shows up as a failed job after the manifest has already listed the case. Proposed: staff are told which report is missing. To confirm in the pilot: whether the remaining jobs in that call still print.
- **Decision to confirm:** timeouts. Proposed: a timeout sets the deals to Needs attention with the reason "result unknown", and the batch is never resent automatically.

## 9. Status

| Item | Status |
|---|---|
| Gateway connection, auth, printer health check | Built and tested |
| Sequential printing in order, per-job results | Tested (3 pages; about 6 s per job after IT fix) |
| n8n-hosted links fetched by the gateway | Tested with dummy PDFs |
| Main print workflow rebuilt for this design (links, manifest, 24-per-call, timeout handling) | Built and checked locally (259 checks, manifest PDFs validated). Imported into n8n 4 November; to test with dummy reports. |
| EMR+ host and API key | Pending (4 November) |
| Destination property | `destination_address` on the deal (synced from the Third party company). A deal with it empty goes to Needs attention, with a reason from recipient_company_set. |
| Manifest fields | Proposed above, to confirm |
| Batch and daily limits | To set (the gateway allows 25 jobs per call; one is the manifest) |
| Untested: wrong checksum, duplicate job ID, paper jam / out of paper / toner effect on printer status | To test in the pilot |
| Rotate pilot gateway token | Before production |

## 10. Out of scope for Phase 1

- Packaging and posting the reports.
- Addressing envelopes (address labels are also outside this phase).
- Invoice generation.
- Sage and finance-sheet updates.
- Instruction letters.

## Process flow diagrams

- Lalu Print Automation: Daily run: https://miro.com/app/board/uXjVESTWxTc=/?moveToWidget=3458764689318601613&cot=14
- Lalu Print Automation: Staff actions: https://miro.com/app/board/uXjVESTWxTc=/?moveToWidget=3458764689318601611&cot=14

## 11. Test program

Run in the sandbox with dry run on unless marked live. Live tests print real paper and are run with IT on the Cardiff queue.

| Test | How to run it | Pass when | Where |
|---|---|---|---|
| Skip and continue | Three deals to one destination, the middle one with a wrong mediref | The other two print; the middle deal is Needs attention with the EMR+ reason; the manifest lists all three | Live print |
| Timeout | Pause the Cardiff print queue so the call times out | Deals go to Needs attention with "result unknown", nothing is resent, and Print / reprint is refused until staff confirm the output | Live print |
| Report too large | Force a 409 or 413, or use a report over 150 MB | Only that deal is Needs attention with the size reason; the others print | Sandbox |
| Gateway fails per job, not per call | Confirm with Jade that an oversized job fails alone | The rest of the call still prints | With IT |
| Same 150 MB definition | Confirm with Jade and Emily that EMR+ and the gateway both count bytes | Both confirm bytes | With IT |
| n8n stream limit | Stream a report close to 150 MB through n8n, which holds each report in memory while it streams | Completes with no out-of-memory error or restart. If it fails, lower the limit in Config or raise the n8n memory, keeping the EMR+ and gateway limits in step | Live print |
| Wrong checksum and duplicate job ID | Send a job with a wrong checksum, then one with a duplicate job ID | Treated as a failed job and the deal is flagged | Live print |
| Paper jam, out of paper, toner | Cause each condition on the printer | The printer status stops the next run and cases stay Queued | Live print |
| Printed manually | Try it without a note, with a note, while Preparing or Sent to printer, and when already Printed | Refused without a note and in the blocked states; otherwise Print status = Printed, hold = No, stage moves | Sandbox |
| Statuses and stage moves | Dry run does not reach Sent to printer, Printed or the stage handoff, so use a real test print or set the values by hand | UC/HSA moves to Completed and PIP to PIP Awaiting Invoicing; a stage staff already changed is not overwritten | Sandbox |
| EMR+ errors | 403 (key or IP allow-list), 429 and 500 retries | Behaviour matches the failure table | Sandbox |
| Network | Gateway fetches report links from n8n; EMR+ accepts the n8n address | Done in testing | Done |
| Execution data | Confirm n8n execution data does not keep PDF content (see the tracker for the 25 November change) | No PDF content is kept | n8n settings |
| Alerts and summary | Put the SMTP credential in place, then run the summary email and the saved HubSpot view | The email arrives with the template content and the view lists Needs attention deals | Sandbox |
| Printer offline retry | Make the printer check fail on a scheduled run before 16:30, then bring it back | Alert on the first offline check only; retried every 30 minutes; runs the batches once online; at 16:30 a "gave up" alert and a quiet end | Live (needs the gateway offline) |
| Once a day | Run a scheduled tick after the day's run has finished | Later ticks end quietly; a manual run still goes ahead | Sandbox |
| Printer state after a timeout | Cause a timeout on a live print (pause the Cardiff queue) | The Print issue says "result unknown" with the printer and spooler state from /health, or that the gateway did not answer | Live print |
| Gateway timeout setting | Change gateway_timeout_minutes in Config | The next print call waits for that many minutes | Sandbox |
| Weekday schedule | A scheduled run on a date in bank_holidays, then a manual run on the same date | The scheduled run ends quietly and the manual run goes ahead; no scheduled run on a weekend | Sandbox |
| Add the Service Key to the ops workflow | Emily creates the ops Service Key; add it as an n8n credential, bind it to the 12 HubSpot steps, bind the live EMR+ credential to Fetch report from EMR+, set emr_base and link_secret | Every HubSpot and EMR+ step in the ops workflow has a credential; a dry run on the ops portal passes | Ops portal (waiting for Emily) |
| Ops portal repeat | Repeat the HubSpot checks in the ops portal: properties, stages, Third party association label, destination_address, then the HubSpot credential and hubspot_base | Same results as the sandbox | Ops portal |
| Destination grouping | Queue deals for the same company address and for a different one; queue a deal with no destination | The same address shares one batch, a different address is a separate batch; an empty destination goes to Needs attention with a reason from recipient_company_set | Sandbox |
| Hand-print fallback | Hand-print a Queued test case | Without recording it a dry run picks it up again; after Printed manually with a note it does not | Sandbox |
| Report type values | Compare the report type values on the ops portal with the Config mapping | They match | Ops portal |

Rotate the pilot gateway token before production.

## Appendix A: Summary email template

Sent after each run (and when nothing printed) to the print team. Fields in curly brackets are filled by n8n. Not built yet: needs the SMTP credential.

```
Subject: Lalu print run {run_date}: {printed_count} printed, {attention_count} need attention

Hi team,

The {run_time} print run has finished.

Printed: {printed_count} reports to {destination_count} destinations (batch {batch_id}).
Need attention: {attention_count}
{for each deal: case reference (mediref) | report type | destination | reason from Print issue | link to the deal}
Still queued for the next run: {queued_count}

What to do: open the saved HubSpot view "Print - Needs attention". Fix the cause, then set Print action to Print / reprint, or print by hand and set Print action to Printed manually with a note.
Where a result is unknown, check the printer output and queue first. If it printed, set Print action to Printed manually. If it did not, set Print / reprint. Nothing is ever resent automatically.

Sent by the Lalu print automation (n8n). Please do not reply to this email.
```

## Appendix B: Saved HubSpot view

Deal view "Print - Needs attention": filter Print status is any of Needs attention. Created in the sandbox portal (147702827). Repeat in the ops portal (6373960) at go-live.

## 12. Destination standardisation and open confirmations (17 November)

- **Destination:** `destination_address` on the deal is a read-only calculated property. It takes the canonical address from the associated Third party company, not the scanned text (checked on 375 deals in the awaiting-printing stages: 10 distinct destinations, none equal to the scanned address). The HubSpot workflow "Auto-triage associated 3rd party company" creates the association: when a deal in the Commencement pipeline has `company_address` known, it associates the company whose `company_address` matches, then tries `alternative_address`, and sets `recipient_company_set` to Yes or No. n8n therefore groups by the exact destination text, one batch per destination. A known-destinations list and address normalisation are not needed and were removed.
- **Third party company link:** done automatically by the HubSpot workflow above, so no one links it by hand. A deal whose scanned address matches no company gets `recipient_company_set` = No and no destination. n8n sends it to Needs attention with the reason; ops add the scanned wording to the right company as an alternative address, or create the company, then use Print / reprint. Still to check: deals marked Yes that have no destination (the linked company has no address, or the sync is not feeding the property).
- **Case and submission reference:** entered by hand today. Confirmed: the submission reference cannot be empty on a live deal.
- **Report type:** comes from UAT. The values match the ops portal. The sandbox N8N Trigger workflow lists `DWP - UC-113`, `DWP - PIP`, `DWP - Health Assessment Advisory Service`; the print workflow maps `PIP`, `UC&ESA`, `Health Assessment Advisory Service`. 
- **Stage moves:** not n8n. In the ops portal the published workflow "eMR+ Fulfillment 1 - sort deals into stages based on report type" moves deals out of Clinician Signed Off. The sandbox also has an "N8N Trigger" workflow (sets Send to N8N = Yes). There is no such workflow in the ops portal, so it is treated as a sandbox-only experiment; the Lalu Print queue workflow is the one carried over.
- **Manifest fields:** settled as case reference, report type, destination, number of reports, batch ID, date and time. No claimant names.
- **Pilot hand-printing limitation:** a Queued case printed by hand and not recorded will print again at 08:30. Set Print action to Printed manually with a note first. Refused once Preparing or Sent to printer.

## 13. Weekday schedule, wrong medi ref, task list (17 November)

- **Schedule:** the scheduled run is Monday to Friday, first check at 08:30 (Europe/London) then every 30 minutes until the printer is online or 16:30 (Config run_start_time and retry_until_time), once a day and skips dates listed in Config `bank_holidays` (YYYY-MM-DD, update each year). A manual run ignores the list. A "Working day?" node does the check.
- **Wrong medi ref:** a missing or non-numeric medi ref is flagged before queuing. A medi ref that EMR+ cannot match to the deal (wrong, copied from another case, or the instruction is not linked to the deal's submission reference) returns 400 or 404; the Print issue on the deal says what to check and correct, then use Print / reprint. EMR+ only returns a report for an instruction linked to that deal, so a medi ref copied from another case cannot print the wrong report.
- **Open tasks:** kept in Appendix B of the Google Doc (all Incomplete).
