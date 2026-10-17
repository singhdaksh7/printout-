import { isSea } from 'node:sea';
import { main } from './cli.js';

// Packaged (single executable): argv = [exe, ...args] or [exe, exe, ...args] depending on the Node version.
// Script mode (node entry.js ...): argv = [node, script, ...args].
const argv = process.argv;
let args: string[];
if (isSea()) {
  args = argv.slice(1);
  if (args[0] && args[0].toLowerCase() === argv[0]!.toLowerCase()) args = args.slice(1);
} else {
  args = argv.slice(2);
}
main(args).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
);
