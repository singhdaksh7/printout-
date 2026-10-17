# Windows Print Agent: real-hardware acceptance checklist

Status: **NOT YET PERFORMED. REAL HARDWARE PRINTING UNVERIFIED.** Every automated test used a fake printer plus read-only checks on a Windows host.
The agent is not ready for production use or broad distribution until every box below is ticked and signed off.

## Ground rules
- Use a **test shop** and a **test printer**. Never install on a production shop machine, never print customer documents, never touch production printers.
- Use disposable documents: a 5-page PDF (page 1 text only, page 2 coloured, page 3 an image, pages 4-5 text, each page labelled with its number), a JPEG and a PNG (an obviously orientated picture, e.g. a labelled arrow, one landscape and one portrait).
- Do this on a staging/development deployment with the additive migration already applied (see "Migration rehearsal").
- Record the exact result, the Windows version, printer model + driver version, SumatraPDF version and its SHA-256, the agent commit and zip SHA-256.
- A virtual printer (`apps/windows-agent/tools/virtual-printer.ps1 -Create`, run as administrator) may be used for a dry run only. It proves the Windows spooler path, not a physical printer, and does not replace section A.

## A. Physical printer and pairing
- [ ] A1 Windows test page prints from Windows Settings on the target printer (printer works independently of the agent).
- [ ] A2 `printout-agent pair` with a fresh code succeeds over HTTPS; `http://` is refused; a reused or expired code is refused.
- [ ] A3 Devices page shows the computer Online within ~2 minutes, with the real printer name, status, colour/duplex support matching the printer's actual capabilities.
- [ ] A4 Before authorizing, an order cannot be sent to the printer (button explains why). After Authorize + Make default it can.
- [ ] A5 `printout-agent doctor` reports PDF renderer, pairing, connectivity and autostart correctly.

## B. JPEG and PNG
- [ ] B1 PNG prints on paper, fitted to the page, correct orientation, not cropped, no extra blank page.
- [ ] B2 JPEG: same checks.
- [ ] B3 Landscape image prints rotated to fit; portrait does not.
- [ ] B4 Colour vs B&W selection is honoured (colour image comes out grey in B&W mode on a colour printer).
- [ ] B5 Copies = 3 produces exactly 3 sheets.
- [ ] B6 Job ends **Print initiated**, never claims "printed"; the order stays Printing until you confirm by hand.

## C. PDF through SumatraPDF
- [ ] C1 With no renderer configured a PDF job fails with a clear message and **nothing** is printed or queued; retry is plain (no duplicate warning).
- [ ] C2 With SumatraPDF configured (path + pinned SHA-256) the 5-page PDF prints.
- [ ] C3 A wrong SHA-256 in config makes the agent refuse the renderer (PDFs fail safely, images still print).
- [ ] C4 Record the **spooler document name** Windows shows for the job (Settings > Printers > queue, or `Get-PrintJob`). It must contain `pb-<jobId>-<attempt>`. If it does not, note it: crash recovery then relies on queue diffing (see section H).
- [ ] C5 A password-protected PDF and a renamed .txt are refused before the spooler.

## D. Correct print settings (verify on paper)
- [ ] D1 Page range `1-2,4` prints exactly pages 1, 2 and 4, in order.
- [ ] D2 Copies = 2 of a 3-page range gives 2 full sets (collated as the printer/driver does; record which).
- [ ] D3 Two-sided: front/back correct, flip edge on the long side. One-sided on a duplex printer stays one-sided.
- [ ] D4 B&W vs colour: page 2 colour in colour mode, grey in B&W mode.
- [ ] D5 A4 paper size honoured (record if the printer defaults to Letter and what happens).
- [ ] D6 Asking for colour/duplex on a printer that lacks it is refused when pressing Print (nothing queued).

## E. Offline and reconnect
- [ ] E1 Printer switched off / paused: new job fails `PRINTER_OFFLINE`, nothing appears in the Windows queue, and nothing prints when the printer comes back.
- [ ] E2 Disconnect the PC's network while a job is Waiting: agent keeps retrying; reconnect and the job is claimed and prints once.
- [ ] E3 Disconnect the network right after the job reaches the Windows queue: it prints once, the shop later sees Print initiated (or Needs your check), never two copies.
- [ ] E4 Reboot the PC: agent starts at sign-in (Task Scheduler), Devices page shows Online again, the queued job resumes.
- [ ] E5 Server unavailable for 10 minutes: no crash loop, log shows back-off, recovery on return.

## F. Paper-out and spooler failure
- [ ] F1 Remove paper after submission: the shop sees the spooler problem or Needs your check within the monitor window (default 120 s); the agent does **not** delete the Windows job or resubmit; adding paper lets it finish once.
- [ ] F2 Paper jam / door open: same expectations.
- [ ] F3 Stop the Print Spooler service before a job: job fails `SPOOLER_UNAVAILABLE`, nothing printed, retry is plain.
- [ ] F4 Stop the spooler service mid-job: job becomes Needs your check; no duplicate after the service returns.
- [ ] F5 An unrelated document in the Windows queue does not confuse tracking (our job is the one reported).

## G. Cancellation
- [ ] G1 Cancel while Waiting: Canceled at once, nothing printed.
- [ ] G2 Cancel while Preparing/Downloading: agent confirms Canceled, nothing in the Windows queue.
- [ ] G3 Cancel while the job sits paused in the Windows queue: agent removes it, status Canceled only after it is gone from the queue.
- [ ] G4 Cancel after the printer started: status ends Print initiated ("cancel too late"), never Canceled falsely.
- [ ] G5 Cancel with the agent stopped: job does not stay stuck forever (Canceled if nothing was sent, otherwise Needs your check).

## H. Crash recovery
- [ ] H1 Kill the agent process (Task Manager) while Downloading: after restart the job is re-queued/resumed and prints once.
- [ ] H2 Kill the agent right after the job appears in the Windows queue: after restart it finds the job and reports it; exactly one copy; no resubmission.
- [ ] H3 Kill the agent immediately after "Sending to the print queue" appears: result is either found-in-queue (one copy) or Needs your check; never two copies.
- [ ] H4 Power-cycle the PC mid-job: same as H3.
- [ ] H5 In H2-H4 record whether the restarted agent matched the job by name or whether reconciliation was needed.

## I. Duplicate-print prevention
- [ ] I1 Double-click Print / two browser tabs / retry button: exactly one job and one copy.
- [ ] I2 Print again after Print initiated requires the explicit "Print again" action.
- [ ] I3 Retry of a failed-after-submit job shows the duplicate-risk confirmation; declining sends nothing.
- [ ] I4 Run two agents on one PC: the second refuses to start (single-instance lock). Two PCs paired to one shop: a job goes only to the PC of its chosen printer.
- [ ] I5 Reconcile choices: *It printed* / *did not print: print again* / *stop* each behave as labelled and create at most one new job.
- [ ] I6 Count sheets for every scenario above: **total sheets equal expected sheets**, otherwise stop and file a defect.

## J. Security spot checks on the real machine
- [ ] J1 `%LOCALAPPDATA%\PrintoutBuddyAgent` is accessible only by your Windows user (`icacls`); `credentials.dpapi` is not readable text; copying it to another user/PC does not work.
- [ ] J2 Temp folder is empty after each job; logs contain no document content, no signed URLs, no credential.
- [ ] J3 Disconnect the computer in Devices mid-job: agent stops on its next request, deletes its credential, prints nothing further.
- [ ] J4 `printout-agent rotate` works and printing continues.

## Sign-off
Tester ____________ Date ________ Agent commit ________ Zip SHA-256 ________ Printer/driver ________ Windows ________ SumatraPDF ________
Defects found: ________ Result: PASS / FAIL.
