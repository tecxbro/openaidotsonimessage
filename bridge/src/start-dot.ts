/** Uses existing user-approved Photon CLI login. Never writes a project secret. */
import { execFileSync } from 'node:child_process';
import { acquireFileLock } from './file-lock.ts';
import { DATA_DIR } from './types.ts';
import { join } from 'node:path';
import type { GpProofRuntime } from './runtime.ts';

let stage = 'validate_configuration';
let runtime: GpProofRuntime | undefined;
let release: (() => Promise<void>) | undefined;
try {
  const projectId = process.env.SPECTRUM_PROJECT_ID?.trim();
  const authorizedSenderId = process.env.AUTHORIZED_SENDER_ID?.trim();
  const cli = process.env.PHOTON_CLI || 'photon';
  if (!projectId || !authorizedSenderId) throw new Error('missing_config');
  release = await acquireFileLock(join(DATA_DIR, '.runtime-lock'), 0);
  process.env.SPECTRUM_CLOUD_URL = 'https://spectrum.photon.codes';
  process.env.PHOTON_API_HOST = 'https://app.photon.codes';
  process.env.SPECTRUM_IMESSAGE_ADDRESS = 'imessage.spectrum.photon.codes:443';
  const { GpProofRuntime } = await import('./runtime.ts');
  stage = 'read_existing_credential_via_cli';
  let raw: string | undefined = execFileSync(cli, ['projects', 'secret', projectId, '--api-host', 'https://app.photon.codes', '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    env: { ...process.env, PHOTON_NO_UPDATE_NOTIFIER: '1' },
  });
  let credential = JSON.parse(raw);
  raw = undefined;
  if (credential.id !== projectId || typeof credential.projectSecret !== 'string' || !credential.projectSecret) throw new Error('invalid_credential_response');
  runtime = new GpProofRuntime({ projectId, projectSecret: credential.projectSecret, authorizedSenderId, hostMode: 'dot-local', greetingFastPath: false });
  credential = undefined;
  stage = 'consume_provider_stream';
  await runtime.start();
} catch {
  // Upstream/subprocess errors may contain credentials or request metadata.
  console.error(JSON.stringify({ event: 'runtime_failed', stage, reason: 'initialization_or_stream_error' }));
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.stop();
  if (release) await release();
}
