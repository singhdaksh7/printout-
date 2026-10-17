# Windows Print Agent: architecture decision (ADR)

Status: accepted for the MVP on `feature/daksh-windows-print-agent` (base: `origin/development` dacf051).

## 1. What already exists (investigated, reused)

| Foundation | Where | Decision |
| --- | --- | --- |
| Device pairing (`PB-XXXX-XXXX`, 40-bit, HMAC at rest, 10 min, single use, throttled) | `domain/devices.ts`, `POST /device/pair` | **Reuse as is.** `platform: WINDOWS` is already accepted. |
| Device bearer credential (`pbd_…`, sha256 at rest, row read every request, revoke is immediate) | `device-auth.ts` | **Reuse.** Add rotation (new hash + `credentialVersion`, short grace for the old one). |
| Heartbeat + presence (60 s, ONLINE ≤ 180 s) | `routes/device-self.ts`, `domain/device-presence.ts` | **Reuse.** The agent heartbeats exactly like Android. |
| Print engine (`initiatePrint`, first print starts retention, order → PRINTING, never PRINTED) | `domain/print-service.ts` | **Reuse.** Enqueueing a Windows job calls `initiatePrint`, so retention/audit/SSE semantics exist once. |
| Short-lived document access | `storage.temporaryReadUrl`, `issueDocumentAccess` | **Reuse** behind a job-scoped endpoint (lease holder only). |
| Shop Devices page, Queue, Order detail, SSE | `apps/web/src/shop/*` | **Extend** (printers, job status, actions). |
| `PrintAgent`, `Printer`, `PrintJob` (+ `PrintJobStatus` with `PRINTED`) | `schema.prisma` ("target", unused, no rows are created) | **Do NOT use.** They model a different, unapproved design (job code/serviceDay, `PRINTED` status, a second credential table). Using them would fork device auth and put a `PRINTED` state in the data model. They stay untouched. |
| `phase2/*`, `phase3/*` branches | local worktrees `C:/p2`, `C:/p3` | Not merged. phase2 is already in development. `phase3/agent-b-printing` is the **Android** print engine; only its *ideas* (bounded spool, download then validate then submit) are mirrored. No Windows code exists anywhere. |

Truth about "printed": the platform has no hardware acknowledgement and neither does the Windows spooler (it knows about the queue, not the paper). Hence **no state in the new design is named "printed"**. `PRINTED` on the *order* is still set only by the shopkeeper's manual confirmation (existing flow). The most the agent can claim is **Print initiated**: the spooler accepted the job and began processing it.

## 2. New server model (additive migration, nothing dropped or rewritten)

* `DevicePrinter`: printers reported by a Windows device (name, driver, connectivity, colour/duplex, paper sizes), plus the shopkeeper's decisions `authorized` and `isDefault` (one default per shop). The agent can only ever print to a printer a shop owner authorized.
* `DevicePrintJob`: one dispatch of an order to one authorized printer of one device. Targeted at enqueue (`deviceId`, `printerId`), so no other device or shop can claim it.
* `ShopDevice`: `previousCredentialHash`, `previousCredentialValidUntil`, `credentialRotatedAt` for rotation.

### Job states (names align with the existing "Print initiated" wording)

`QUEUED → CLAIMED → DOWNLOADING → SUBMITTING → SUBMITTED_TO_SPOOLER → PRINT_INITIATED`
plus `FAILED`, `CANCEL_REQUESTED`, `CANCELED` (only when confirmed) and `NEEDS_RECONCILIATION`.

`SUBMITTING` is a write-ahead *intent*: the agent reports it (and journals it durably) **before** it touches the spooler. This is what makes crash recovery safe:

| Where the lease expired / the agent crashed | Server/agent action |
| --- | --- |
| `CLAIMED`, `DOWNLOADING` (nothing could have reached the spooler) | back to `QUEUED` (max 5 attempts, then `FAILED`) |
| `SUBMITTING`, `SUBMITTED_TO_SPOOLER` | **`NEEDS_RECONCILIATION`**, never re-queued automatically |
| agent restarts with a journal entry in `SUBMITTING`/`SUBMITTED` | looks the job up in the spooler by its document name `pb-<jobId>-<attempt>`; found: reports it (evidence); not found: stays ambiguous (reconcile). It **never** resubmits by itself |

Retry rules: `FAILED` before `SUBMITTING` ⇒ plain retry. `FAILED` after `SUBMITTING` or `NEEDS_RECONCILIATION` ⇒ the shopkeeper must choose (`printed`, `not printed, print again`, `not printed, give up`) and re-printing needs `acknowledgeDuplicateRisk`.

Idempotency: `(shopId, clientRequestId)` unique on enqueue; one non-terminal job per order (advisory lock); every agent progress call carries `leaseId` and an explicit target status, repeats of the current status are no-ops (they renew the lease), invalid edges are 409 and nothing is overwritten.

### Endpoints (all under `/api/v1`)

Device (Bearer): `PUT /device/printers`, `POST /device/print-jobs/claim`, `GET /device/print-jobs/active`, `POST /device/print-jobs/:id/download`, `POST /device/print-jobs/:id/progress`, `POST /device/credential/rotate`.
Shop (session + CSRF): `PATCH /shop/devices/:id/printers/:printerId`, `POST /shop/orders/:id/print-jobs`, `GET /shop/print-jobs`, `POST /shop/print-jobs/:id/{cancel,retry,reconcile}`. `GET /shop/devices` gains `printers`.
SSE: `printJob.updated` (ids and statuses only).

## 3. Windows agent (`apps/windows-agent`)

TypeScript on Node 22+, **no native modules, no shell**: every external program is started with `execFile` and an argument array; PowerShell scripts are static files that receive data through stdin/environment, never through string interpolation.

* **Credential storage**: DPAPI (`ProtectedData`, scope CurrentUser, plus per-install entropy) through PowerShell; the data directory is ACL-restricted to the current user with `icacls`.
* **Printer discovery**: `Get-Printer` + `System.Drawing.Printing.PrinterSettings` (colour, duplex, paper sizes, offline/error state).
* **Rendering/printing pipeline** (the only supported formats; everything else fails safely *before* the spooler):
  * `application/pdf`: SumatraPDF `-print-to <printer> -print-settings …` (optional, user-installed, path and optional SHA-256 pinned in config). Not installed ⇒ `RENDERER_MISSING` (nothing submitted, retry safe).
  * `image/jpeg`, `image/png`: built-in `System.Drawing` print (no third party).
* **Validation**: server-declared MIME *and* magic bytes must agree, size cap (50 MB default), encrypted PDFs rejected, filename never used for paths.
* **Temp files**: per-job random directory inside the ACL-restricted agent dir, `wx` creation, removed in `finally`, swept on start and after 15 min at the latest; contents never logged.
* **Journal** (`journal.jsonl`, fsynced): write-ahead log of job phases + an outbox of unacknowledged reports, so a lost acknowledgement is replayed (idempotently) after restart.
* **Reconnect**: exponential backoff with jitter; the main loop never exits on network errors.
* **Autostart**: a Scheduled Task at user logon (restart on failure). It is **not** a Windows service (no third-party service wrapper, DPAPI CurrentUser scope and per-user printers need the user profile).
* **UI**: CLI (`pair`, `status`, `printers`, `run`, `rotate`, `unpair`, `install`, `uninstall`, `doctor`). The shopkeeper-facing UI for printer authorization/default is the web Devices page.

## 4. Test strategy

* API: vitest on a disposable PostgreSQL (pairing → printers → enqueue → claim → progress → recovery; tenant isolation; revocation; rotation; races).
* Agent: vitest with a `FakeSpooler` (virtual printer: records submitted jobs, can simulate crash, offline, errors, jobs that disappear) and an in-process mock server that enforces the same contract.
* Windows-only smoke tests (read-only): real `Get-Printer` discovery, real DPAPI round trip. Printing to a physical or virtual printer is a **manual** step (`tools/windows/` + checklist); if no printer is available the status is **REAL HARDWARE PRINTING UNVERIFIED**.

## 5. Out of scope for the MVP (stated, not hidden)

Windows service mode, code signing, auto-update, multi-printer routing rules, finishing options (stapling, trays), reading hardware completion, GUI tray app, Windows event-log based completion.
