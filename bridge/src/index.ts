import { loadConfig } from "./config.ts";
import { GpProofRuntime } from "./runtime.ts";
import { acquireFileLock } from "./file-lock.ts";
import { DATA_DIR } from "./types.ts";
import { join } from "node:path";
const release = await acquireFileLock(join(DATA_DIR, ".runtime-lock"), 0);
const runtime = new GpProofRuntime(loadConfig(), undefined, release);
try { await runtime.start(); }
catch { console.error("[dot] runtime failed; inspect non-secret lifecycle evidence"); process.exitCode = 1; }
finally { await runtime.stop(); await release(); }
