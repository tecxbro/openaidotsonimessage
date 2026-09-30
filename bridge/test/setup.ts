import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'photon-dot-test-'));
process.env.BRIDGE_DATA_DIR = root;
writeFileSync('/tmp/gpproof-1x1.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=', 'base64'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
