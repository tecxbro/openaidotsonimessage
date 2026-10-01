/** Fixed-schema local diagnostics: no message content, provider IDs, paths or raw errors. */
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './types.ts';

const OPERATIONS = ['runtime_start', 'provider_stream', 'runtime_stop', 'outbound_drain', 'webhook_drain', 'cards_ready', 'batch_flush', 'inbound_handler', 'media_recovery', 'typing_control', 'typing_cleanup', 'read_control', 'webhook_delivery'] as const;
export type DiagnosticOperation = typeof OPERATIONS[number];
const EVENTS = ['runtime_starting', 'provider_connected', 'provider_stream_eof', 'stop_requested', 'runtime_stopped'] as const;
export type LifecycleEvent = typeof EVENTS[number];
const ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);
const REPEAT_INTERVAL_MS = 60_000;

function safeErrorCode(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && ERROR_CODES.has(code)) return code;
  } catch { /* Never invoke error serialization or propagate a hostile getter. */ }
  return 'operation_failed';
}

type FailureState = { lastReportedAt: number; suppressed: number; total: number };

export class RuntimeDiagnostics {
  private readonly runId = randomUUID();
  private readonly failures = new Map<DiagnosticOperation, FailureState>();
  private lastWriteWarningAt = -Infinity;
  constructor(private readonly directory = DATA_DIR, private readonly now = () => Date.now()) {}

  lifecycle(event: LifecycleEvent, trigger?: 'SIGINT' | 'SIGTERM' | 'requested'): void {
    if (!EVENTS.includes(event)) return;
    this.append({ event, ...(['SIGINT', 'SIGTERM', 'requested'].includes(trigger ?? '') ? { trigger } : {}) });
  }

  failure(operation: DiagnosticOperation, error?: unknown): void {
    if (!OPERATIONS.includes(operation)) return;
    const now = this.now();
    const prior = this.failures.get(operation);
    if (prior && now - prior.lastReportedAt < REPEAT_INTERVAL_MS) {
      prior.suppressed = Math.min(prior.suppressed + 1, Number.MAX_SAFE_INTEGER);
      prior.total = Math.min(prior.total + 1, Number.MAX_SAFE_INTEGER);
      return;
    }
    const total = Math.min((prior?.total ?? 0) + 1, Number.MAX_SAFE_INTEGER);
    this.failures.set(operation, { lastReportedAt: now, suppressed: 0, total });
    this.append({ event: 'operation_failed', operation, code: safeErrorCode(error), suppressed: prior?.suppressed ?? 0 });
  }

  recovered(operation: DiagnosticOperation): void {
    if (!OPERATIONS.includes(operation)) return;
    const prior = this.failures.get(operation);
    if (!prior) return;
    this.failures.delete(operation);
    this.append({ event: 'operation_recovered', operation, failureCount: prior.total });
  }

  private append(fields: Record<string, unknown>): void {
    let fd: number | undefined;
    try {
      const at = new Date(this.now()).toISOString();
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fd = openSync(join(this.directory, 'runtime-diagnostics.jsonl'), 'a', 0o600);
      writeSync(fd, JSON.stringify({ at, pid: process.pid, runId: this.runId, ...fields }) + '\n');
      fsyncSync(fd);
    } catch {
      // Disk/permission failures must not create a new rejected task or expose
      // the external error. Rate-limit this fallback independently of the file.
      const now = this.now();
      if (now - this.lastWriteWarningAt >= REPEAT_INTERVAL_MS) {
        this.lastWriteWarningAt = now;
        try { console.error(JSON.stringify({ event: 'diagnostic_write_unavailable', reason: 'local_diagnostic_storage_error' })); } catch { /* no recursive logger */ }
      }
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* no raw close error */ } }
    }
  }
}
