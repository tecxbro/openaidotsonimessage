/** Offline/read-only prerequisites. Never logs or fetches credentials. */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MOONSHINE_MODEL_DIR, MOONSHINE_VENV_PYTHON } from './voice-stt.ts';
import { DATA_DIR } from './types.ts';
const required = ['adapter.ort','cross_kv.ort','decoder_kv.ort','decoder_kv_with_attention.ort','encoder.ort','frontend.model.ort','frontend.weights.ort','streaming_config.json','tokenizer.bin'];
const check = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const model = required.every(name => existsSync(join(MOONSHINE_MODEL_DIR, name)));
let modelIntegrity = false;
try {
  const manifest = JSON.parse(await readFile(new URL("../../stt/MODEL_MANIFEST.json", import.meta.url), "utf8"));
  modelIntegrity = manifest.files.length === required.length;
  for (const entry of manifest.files) {
    if (!required.includes(entry.file)) { modelIntegrity = false; break; }
    const bytes = await readFile(join(MOONSHINE_MODEL_DIR, entry.file));
    if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) modelIntegrity = false;
  }
} catch { modelIntegrity = false; }
const checks = {
  bun: typeof Bun !== 'undefined',
  sdk: (await import('@spectrum-ts/core')).Spectrum !== undefined,
  hostedProvider: (await import('@spectrum-ts/imessage')).imessage !== undefined,
  flock: check('flock', ['--version']),
  ffmpeg: check('ffmpeg', ['-version']), ffprobe: check('ffprobe', ['-version']),
  moonshine: check(MOONSHINE_VENV_PYTHON, ['-c', 'import moonshine_voice; from moonshine_voice import ModelArch; assert int(ModelArch.SMALL_STREAMING)==4; import importlib.metadata; assert importlib.metadata.version("moonshine-voice")=="0.1.5"']),
  modelFiles: model, modelIntegrity,
};
console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, dataDirectory: DATA_DIR,
  activation: 'active-task-only', externalModel: false,
  pendingMediaJobs: (await readdir(join(DATA_DIR, 'media-jobs')).catch(() => [])).filter(x => x.endsWith('.json')).length,
  limits: ['No native automatic dot wake endpoint', 'Provider transport and physical-device UX require live proof', 'Live Mini public hosting is optional and unconfigured'] }, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
