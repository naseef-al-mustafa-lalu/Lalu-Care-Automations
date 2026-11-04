# Lalu Print Automation: Process Flow, Credentials and Status

> Snapshot of the Google Doc "Lalu Print Automation: Process Flow, Credentials and Status" (https://docs.google.com/document/d/1jmkVAFaXcQGtFlXnYkrO2ZVcsSJf3v8tp6oqTKOoZJQ/edit), taken 4 November 2026. The Google Doc is the working copy; this file is for reference alongside the workflow. It contains no secrets and no patient data.

## 1. What changed since the 2 November plan

The six-step flow and the HubSpot deal section are unchanged. The printer connection is now proven, and three design choices were made for data security and simplicity.

- **Printer connection is real and tested.** n8n talks to the Cardiff print gateway (CRD-PRINT-GW01) which prints on the Ricoh queue CRD-PRN-01-AUTO. Pages printed in the correct order. After IT's fix each job takes about 6 seconds (previously about 126 seconds).
- **No external tools.** Manifests are built as a plain PDF inside n8n. Nothing leaves Lalu systems.
- **No report is stored anywhere.** n8n streams each PDF straight from EMR+ to the gateway when the gateway asks for it (see section 3).
- **HubSpot is the only record of the state.** The n8n Data Tables from the earlier plan are not used. Print status, batch ID, job reference and issues all live on the deal.
- **Schedule:** daily at 08:30 Europe/London (the earlier plan said 09:00 on working days), with a configurable batch size and a daily limit.

## 2. The process flow

### 1. Add ready cases to the queue
When a deal first enters an awaiting-printing stage, a HubSpot workflow sets:
- Print status = Queued
- The queue time
- Dispatch hold - printing = Yes

Stages: UC/HSA awaiting printing (64932356), PIP awaiting printing (64932357). Processed or active cases are kept out of re-enrolment. No report download happens yet.

### 2. Select the cases for this run (n8n, 08:30 daily)
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
1. The printing hold is cleared. UC/HSA moves to To be sent (65006207).
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
| HubSpot connection (OAuth2) | Reading and updating deals | n8n HubSpot credential | Naseef (HubSpot admin) | To connect to the sandbox portal first, then live. |
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
| Print action | None, Report problem, Resolve problem, Print / reprint. Staff set it with a Print request note; n8n processes it and resets to None. |
| Dispatch hold - printing | Yes from queue entry until successful printing with no open issue |
| Print queued at, Print batch ID, Print destination, Printer job reference, Print submitted at, Print completed at, Print issue, Print request note | Timing, batch link, destination used, job reference, and the reason for any problem |

## 7. Staff actions

- **Report problem:** staff set the Print action property to Report problem and add a Print request note. n8n then sets Print status = Needs attention and Dispatch hold - printing = Yes, copies the problem into Print issue, and resets Print action to None. The deal stays in its current pipeline stage.
- **Resolve problem:** staff set the Print action property to Resolve problem and add a Print request note describing the fix. If the earlier job has a successful result, n8n sets Print status = Printed, sets Dispatch hold - printing = No, clears Print issue, and applies the normal stage handoff (UC/HSA to To be sent, PIP to PIP Awaiting Invoicing). If not, Print status stays "Needs attention" and the hold stays Yes. Print action is reset to None.
- **Print / reprint:** staff first check the printer output, then set the Print action property to Print / reprint and add a Print request note giving the reason. n8n sets Print status = Queued and Dispatch hold - printing = Yes, and the case joins the next scheduled run with a new batch ID. The request is refused if an earlier job is still active or its result is unknown. Print action is reset to None.

## 8. Error catching and recovery

- One run at a time. The run checks for an active batch before starting.
- Timeout or restart during sending: mark the batch "sent, result unknown", stop, and alert. Staff check the printer, then use Print / reprint if needed. Never auto-resend.
- A HubSpot update failure never triggers reprinting; only the deal update is retried.
- If the printer is not ready at 08:30, nothing is sent and the team is alerted; cases stay Queued for the next run.

| What goes wrong | What the deal shows | What happens next |
|---|---|---|
| Printer not ready at 08:30 (health check fails) | Stays Queued | Nothing is sent and the team is alerted. The cases are picked up at the next run. |
| Gateway rejects the call (wrong or missing token, more than 25 jobs, file over 50 MB, not a PDF) | Needs attention, reason in Print issue | Nothing prints. Fix the cause, then use Print / reprint. |
| A report cannot be fetched from EMR+ (400, 404 or 409: case or deal ID mismatch, not completed, report not available, report too large) | Needs attention, reason in Print issue | The gateway reports that job as failed. The manifest already lists the case, so staff are told which report is missing. Whether later jobs still print is to be confirmed in the pilot. Reprint once fixed. |
| EMR+ rejects the key or IP address (403) | Needs attention on the affected cases | The run stops and the team is alerted. Fix the key or the IP allow-list, then reprint. Tell Naseef: this is a credentials issue. |
| EMR+ rate limit or server error (429, 500) | Needs attention if it continues | 429: n8n waits 60 seconds and retries up to twice. 500: n8n waits 30 seconds and retries once. If it still fails the job fails as above: for 429 try again later, for 500 ask Emily to check Sentry. |
| Link expired, already used, or the gateway cannot reach n8n | Needs attention, reason in Print issue | The job fails. A reprint creates new links. |
| Call times out | Needs attention, result unknown | Never resent automatically. Staff check the printer output and queue, then Resolve problem or Print / reprint. |
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
| Destination property | `destination_address` on the deal (synced from the Third party company). A deal with it empty goes to Needs attention. |
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
