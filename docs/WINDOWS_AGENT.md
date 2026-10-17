# Printout Buddy Windows Print Agent (MVP)

Connects a shop's Windows computer and its printer to Printout Buddy so orders print without opening a browser.
Design and decisions: [WINDOWS_AGENT_ARCHITECTURE.md](WINDOWS_AGENT_ARCHITECTURE.md).

> **REAL HARDWARE PRINTING UNVERIFIED.** All automated tests use a virtual printer (a fake spooler) plus read-only checks on a real
> Windows host (DPAPI, ACLs, printer discovery). Nobody has yet printed a real page through this agent. Do the manual
> checklist at the end before relying on it. The binary is **not code-signed**.

## What "Print initiated" means
The agent can see the Windows print *queue*, not the paper. The strongest thing it ever reports is **Print initiated**: Windows accepted
the job and started processing it (or finished with it). The order only becomes *Printed* when the shopkeeper confirms it by hand, as
before. If anything is unclear (crash, lost network after sending, stuck queue) the job becomes **Needs your check** and nothing is
re-sent automatically.

## Install
1. Download `PrintoutBuddyAgent-<version>-win-x64.zip`, check it against `SHA256SUMS.txt`
   (`Get-FileHash .\PrintoutBuddyAgent-*.zip -Algorithm SHA256`), unzip to e.g. `C:\Program Files\PrintoutBuddy\` (or any folder you own).
   Windows SmartScreen will warn because the file is unsigned; only continue if the checksum matches the one published with the release.
2. For **PDF** orders install [SumatraPDF](https://www.sumatrapdfreader.org/) (free). Copy `config.sample.json` to
   `%LOCALAPPDATA%\PrintoutBuddyAgent\config.json`, set `pdfRenderer.path` and, recommended, `pdfRenderer.sha256` (the agent then refuses
   a renderer that was swapped). JPEG/PNG work without it. Without a renderer PDF jobs fail safely *before* anything is sent.
3. Make sure the printer works from Windows (print a Windows test page) and is the one you want.

## Pair
1. In Printout Buddy: **Shop → Devices → Add device** shows a code like `PB-AB12-CD34` (single use, 10 minutes).
2. On the PC: `printout-agent pair --server https://YOUR-PRINTOUT-ADDRESS --code PB-AB12-CD34 --name "Counter PC"`
   (HTTPS is required.) The credential is encrypted with Windows DPAPI for your Windows user; it is never shown or written in clear.
3. In **Shop → Devices** the computer appears with its printers. **Authorize** the printer you want and **Make default**.
   The agent only ever prints on authorized printers.
4. `printout-agent install` starts the agent automatically when you sign in to Windows (Scheduled Task, restarts if it dies).
   `printout-agent run` runs it in the foreground. `printout-agent status` / `printers` / `doctor` show what is happening.

## Use
Open an order → **Print on Windows printer**. Status: *Waiting → Preparing → Sending to the print queue → In the Windows print queue →
Print initiated*. You can **Cancel** (a job already in the queue is removed only if Windows confirms), **Retry** a failed job, and resolve
**Needs your check** jobs with *It printed* / *It did not print: print again* / *stop*. The Queue page shows the same status per order.

## Supported formats and options
| Format | How | Notes |
| --- | --- | --- |
| PDF | SumatraPDF (`-print-to`, no shell) | needs the renderer; encrypted PDFs rejected |
| JPEG, PNG | built-in .NET printing | one page, fitted to the page, duplex ignored |
Everything else (Office files, SVG, GIF, text, executables…) is refused **before** the spooler. Declared type and file bytes must agree.
Size limit 50 MB (configurable up to 100). Options: copies, colour/B&W, one/two-sided, page ranges (PDF), A4. A job asking for colour or
duplex on a printer that cannot do it is refused when you press Print.

## Security
* TLS only (`https://`); redirects refused; the credential is a 256-bit bearer secret, only its SHA-256 is stored on the server.
* Device and shop isolation: a job is bound to one device + printer + shop at creation; every device call re-reads the device row, so
  **revocation takes effect on the next request**. A job can only be moved by the holder of its current lease.
* Documents: fetched through a signed URL valid ≤ 2 minutes, available only to the lease holder while the job is being prepared.
* Local: data directory `%LOCALAPPDATA%\PrintoutBuddyAgent` is restricted to your Windows user; temp files use random names inside it,
  never a server-supplied name (no traversal), are deleted right after submission and swept after 15 min at the latest.
  Logs never contain document content, signed URLs, credentials or pairing codes.
* No shell: every program is started with an argument array; PowerShell scripts are fixed and receive data on stdin.
* Rotation: `printout-agent rotate` (also automatic every 30 days). The old credential survives 10 minutes only if the new one has not
  been used yet (lost-response safety). Revoke in **Shop → Devices → Disconnect**; the agent then stops and deletes its stored credential.

## Troubleshooting
| Symptom | Check |
| --- | --- |
| "pairing code is invalid" | codes last 10 minutes and work once; create a new one |
| computer shows Offline | `printout-agent status`; internet/proxy; is the task running (`doctor`) |
| job fails `RENDERER_MISSING` | install SumatraPDF and set `pdfRenderer` in config.json |
| `PRINTER_OFFLINE` | printer switched off/paused in Windows; fix, then Retry (safe: nothing was sent) |
| *Needs your check* | look at the printer and the Windows queue (Settings → Printers), then choose what happened |
| agent stopped, "disconnected by the shop" | the computer was removed in Devices; pair again |
Logs: `%LOCALAPPDATA%\PrintoutBuddyAgent\logs\agent.log`.

## Update / uninstall
Update: `printout-agent uninstall`, replace `printout-agent.exe`, `printout-agent install` (pairing and settings are kept).
Uninstall: `printout-agent uninstall --purge`, delete the folder, then **Disconnect** the computer in Devices (revokes its credential).
No auto-updater exists.

## Operational limitations
Runs while a user is signed in (no Windows service); one job at a time; polls every 5 s (no push); no GUI/tray; Windows 10/11 x64;
completion is never confirmed by hardware; page ranges for images are ignored; paper size is whatever the printer's A4 setting is;
unsigned executable; the spooler document name used to find a job after a crash depends on the renderer, so after a crash the
agent may need you to reconcile; the Sumatra command-line behaviour and real printer drivers have not been verified on hardware.

## Build (Windows)
`corepack pnpm install --frozen-lockfile && corepack pnpm --filter @printout/windows-agent build && corepack pnpm --filter @printout/windows-agent package`
→ `apps/windows-agent/release/*.zip` + `SHA256SUMS.txt`. `dist/BUILD-INFO.json` records commit and Node version. The exe embeds Node, so
checksums match only for the same Node version and platform.

## Release readiness (read before distributing)
* **Hardware acceptance:** [WINDOWS_AGENT_HARDWARE_ACCEPTANCE.md](WINDOWS_AGENT_HARDWARE_ACCEPTANCE.md) must be completed and signed off. Until then: **REAL HARDWARE PRINTING UNVERIFIED**.
* **Unsigned:** `printout-agent.exe` and the zip are **not code-signed** (no signing certificate exists or was used; the embedded Node binary's original signature is invalidated by the build). Windows SmartScreen will warn. It is **not ready for broad distribution**; use only on named test machines, verifying `SHA256SUMS.txt`.
* **Not deployed:** nothing here has been installed on production shop machines, deployed to the VPS or merged to `main`. The PR into `development` stays open until Release A (Branding + Shop Hours + QR Poster) is confirmed deployed.
* **Migration rehearsal:** this feature adds one additive migration, `20261017031501_windows_print_agent` (new enums, tables `DevicePrinter` and `DevicePrintJob`, nullable columns `previousCredentialHash`, `previousCredentialValidUntil`, `credentialRotatedAt` on `ShopDevice`; nothing dropped or rewritten, verified no schema drift). Before its first production release it must be rehearsed with `prisma migrate deploy` on a restored copy of production data (never `db push` / `migrate reset`), timed, checked with `prisma migrate diff`, and its rollback considered (the old app version ignores the new tables/columns, so the schema can stay while the app is rolled back). Follow `docs/DEPLOYMENT.md`.

## Manual hardware checklist (summary)
With a test shop and a printer (a PDF/virtual one first: `tools/virtual-printer.ps1 -Create` as administrator; never real customer documents):
pair; authorize; print a PDF and a PNG; B&W, colour, duplex, copies=3, page ranges `1-2,4`; unplug/pause the printer (job must fail
with `PRINTER_OFFLINE`, nothing printed later); kill the agent mid-print (job must become *Needs your check*, no second copy); disconnect the
computer mid-job; rotate the credential; reboot and confirm autostart. The full checklist, with sign-off, is in [WINDOWS_AGENT_HARDWARE_ACCEPTANCE.md](WINDOWS_AGENT_HARDWARE_ACCEPTANCE.md).
