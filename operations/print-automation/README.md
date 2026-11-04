# Lalu print automation: n8n import pack (Phase 1)

Prints completed UC / HAA / PIP reports on the Cardiff Ricoh through the Cardiff print gateway, tracked on HubSpot deals (pipeline "eMR+ Fulfillment"). No report is stored anywhere and no external tool is used.

Files in `n8n/`:

| File | What it is |
|---|---|
| `Lalu_Print_Main.json` | The workflow: four flows in one (print run, stuck check, staff actions, report link) |
| `Lalu_Print_Error_Alert.json` | Emails Ops when any print workflow fails. Set it as the error workflow of Main |
| `Lalu_Print_Test_File_Server.json`, `Lalu_Print_Gateway_Test.json` | Gateway test pack (used in the 2 and 3 Nov tests) |

`generator/` rebuilds the JSON (`node build.js`) and checks it (`node test.js`, 259 checks, uses `qpdf` and `pdftotext` to validate the manifest PDFs). Edit the generator, not the JSON.

## How it works

1. **Print run** (daily 08:30 Europe/London, or manual). Checks the printer is ready (gateway `/health`: online, spooler Running, printer Normal, right queue). Reads the queued deals, checks case reference / report type / destination, applies the daily limit (oldest first), marks them Preparing, groups by the Third party destination and splits into calls of at most `reports_per_call` (max 24).
2. For each call, n8n signs one link per PDF (the manifest first, then each report) and sends **one** `POST /print-jobs` to the gateway with those links. It reads the per-job results from the same response and writes HubSpot: Printed (hold cleared, existing stage handoff only if the deal is still at an awaiting-printing stage) or Needs attention with a readable reason.
3. **Report link** (the gateway calls this). The gateway opens each link. n8n checks the signature and expiry, then either builds the manifest PDF itself (plain PDF, no external tool) or fetches that one report from EMR+ and streams it straight back. Nothing is saved.
4. **Stuck check** (every 15 min). If n8n restarted mid-run, deals left Preparing for `preparing_timeout_minutes` become Needs attention.
5. **Staff actions** (HubSpot webhook). Report problem / Resolve problem / Print / reprint, validated against the deal record. No printer call is needed.

HubSpot is the only state store. There are no Data Tables.

### Manifest
One per call, printed first: batch ID, print call and part (for example part 2 of 3), destination, prepared time, number of reports, then one line per report (case reference and type) in print order. No claimant names. Destinations with more than 24 reports are sent in several calls, each with its own manifest.

### Outcomes
| Situation | Deals | Run |
|---|---|---|
| Printer not ready | stay Queued | stops, alert email, nothing claimed |
| All jobs printed | Printed, hold cleared, stage handed off | continues |
| One report failed (EMR+ error, bad link, printer error) | that deal Needs attention with the reason | continues |
| Manifest failed but reports printed | Printed but hold stays, issue says check the stack | continues |
| Gateway rejected the call (401, 500 `accepted:false`) | Needs attention | stops, alert |
| Timeout / no answer / 5xx | Needs attention, "result unknown" | stops, alert. **Never resent automatically** |
| Every report refused by EMR+ (403) | Needs attention | stops, alert |

EMR+ errors are turned into HTTP codes the gateway reports back: 404 no matching case, 409 not completed / not available, 403 key or IP refused, 410 link expired, 422 bad link, 413 over 50 MB, 503 busy / unreachable / not configured, 502 other.

## Credentials (nothing secret is in this repo)
| What | Where it lives |
|---|---|
| Gateway token (`X-Print-Agent-Token`) | n8n Header Auth credential "Cardiff Print Agent" (used by the health check and the print call). Pilot token: rotate before production |
| EMR+ API key (`Authorization: Api-Key <key>`) | n8n Header Auth credential on the node "Fetch report from EMR+". **Pending** |
| HubSpot | n8n HubSpot OAuth2 credential on every HubSpot node |
| Staff webhook key | n8n Header Auth credential on "Staff action webhook" and the HubSpot "Send a webhook" action |
| Alert email | SMTP credential on the error workflow |
| Link-signing secret | `link_secret` in the Config node (a long random string, set in n8n only, never committed). The only secret not held as an n8n credential, because Code and Crypto nodes cannot read credentials |

## Set up (in this order)
1. HubSpot: properties and stages already exist (see Config). Create a HubSpot workflow that sets Print status = Queued, Print queued at and Dispatch hold - printing = Yes when a deal first enters an awaiting-printing stage, and a workflow "Send a webhook" to `/webhook/lalu-print-action` with body `{"deal_id": "<Record ID>"}` when Print action changes.
2. Import `Lalu_Print_Main.json` and `Lalu_Print_Error_Alert.json`. Bind credentials (above). In Config set `link_secret`. Leave `emr_base` as the placeholder until EMR+ is ready.
3. **Test with dummy reports** (no EMR+ needed): set `emr_mode` to `dummy`, point HubSpot at the sandbox, queue a few sandbox deals, publish the workflow (the report link must be live for the gateway to fetch it), run "Manual print run". Pages are labelled DUMMY REPORT.
4. When EMR+ is ready: set `emr_base`, bind the EMR+ credential, set `emr_mode` to `live`, test with real PIP / UC / HAA cases (wrong deal ID, not completed, bad key, wrong IP).
5. Set Error workflow = "Lalu Print - Error alert" in the Main workflow settings. Replace `REPLACE_FROM_EMAIL` / `REPLACE_OPS_EMAIL`.
6. Activate only after the pilot checklist.

## Limits (Config node)
- `reports_per_call` (default and maximum 24): reports per gateway call. The gateway allows 25 jobs per call and one is the manifest.
- `max_reports_per_day` (default 200): reports per day, counted from deals with a Print submitted at date today (UK time), oldest queued first. The rest wait for tomorrow.
- `link_valid_minutes` (default 30): how long a report link works. A call of 25 jobs takes about 3 minutes at about 6 s per job.
- `preparing_timeout_minutes` (default 60).

## Cardiff print gateway (CRD-PRINT-GW01, 10.0.60.33:8787)
- `GET /health` returns `status`, `spoolerStatus`, `printerQueue`, `printerStatus`. `POST /print-jobs` takes JSON with a `documentUrl` per job that the gateway downloads itself. Header `X-Print-Agent-Token`. PDF only, 50 MB per file, 25 jobs per call, 5 copies, queue `CRD-PRN-01-AUTO` only.
- n8n runs on Google Cloud (34.142.83.45) and cannot reach private addresses by default. 10.0.60.33 works.
- Jobs are processed in order, one at a time. About 6 s per job after IT's fix on 3 Nov (it was about 126 s).
- Failures return HTTP 200 with `batchStatus: failed`, `jobsFailed` and `results[].errorCode`. A call can time out and still print, so a timeout is "result unknown", never "failed".

### Gateway test results (2 to 3 Nov 2026)
| Test | Result |
|---|---|
| `/health` from n8n | 200 in about 0.2 s |
| No / wrong token | 401 `UNAUTHORISED`, nothing printed |
| n8n-hosted `documentUrl` | Works: the gateway fetched the dummy PDF from automation.lalu.co.uk and printed it |
| 1 page | `batchStatus: completed`, per-job `results[]` |
| Bad link (404) | HTTP 200, `batchStatus: failed`, `errorCode: PRINT_JOB_FAILED`, `(404) Not Found`. Nothing printed |
| More than 25 jobs | HTTP 500 `API_ERROR`, nothing printed |
| 3 pages | All printed in the correct order. Before the fix n8n timed out at 300 s but they still printed. After the fix about 6 s per job |

**Still untested:** wrong `sha256` (the workflow sends an empty one), duplicate `jobId`, jam / paper-out / toner effect on `printerStatus`, behaviour with a busy queue, whether later jobs in a call still print after an earlier one fails.

## Still to do
- EMR+ host and API key, then live tests (see step 4).
- Rotate the pilot gateway token before production.
- The links are signed and expire after `link_valid_minutes`, but are not strictly one-time (n8n keeps no state between executions). The gateway may open a link again within that window.
- Not import-tested in n8n here. The Crypto node (HMAC SHA256, hex) and Respond to Webhook are the two nodes to check first after import.

## Gateway test pack
The two test workflows prove the gateway connection with dummy one-page PDFs. See the files for notes; `send_print_job` defaults to false (health check only).
