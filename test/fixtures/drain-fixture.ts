// Fixture: write a large payload using the SAME helper that cli.ts uses,
// then process.exit. The headless test spawns this and asserts no bytes
// were dropped — without the drain, process.exit cuts the pipe before the
// kernel finishes copying the buffer.
//
// Importing writeAndDrain (instead of inlining) means a future regression
// in cli.ts's helper choice is covered by this fixture's test.
//
// Size deliberately exceeds the default pipe high-water mark (~64KB on
// macOS/Linux) so a missing drain truncates visibly. 1 MB == 1024 * 1024.

import { writeAndDrain } from "../../src/headless.js";

const SIZE = Number(process.argv[2] ?? 1024 * 1024);
const payload = "x".repeat(SIZE);

await writeAndDrain(process.stdout, payload);
process.exit(0);
