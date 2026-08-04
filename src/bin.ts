#!/usr/bin/env node
// The published entrypoint. npm links `node_modules/.bin/setorra` as a symlink to the
// bundle, so `process.argv[1]` is the shim path and not this file -- any guard comparing
// the two is false through `npx`, which is the only path a customer uses. Keeping the
// entry a separate file means there is nothing to guard: `setorra.ts` stays importable
// for tests, and this runs when, and only when, it is the program.
import { main } from "./setorra.js";

process.exitCode = main(process.argv.slice(2));
