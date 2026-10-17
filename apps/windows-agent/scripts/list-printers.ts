import { WindowsSpooler } from '../src/spooler.js';

// Read-only developer helper: prints what the agent would report to the server. Never prints anything.
const printers = await new WindowsSpooler().listPrinters();
console.log(JSON.stringify(printers, null, 2));
