import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Environment } from '../local-dev.js';
import { stopManagedProcess, trackManagedProcess, PROCESS_GRACE_MS, PROCESS_KILL_MS } from '../process.js';

export const DEFAULT_DIAGNOSTIC_BYTES = 16_384;
export const MAX_DIAGNOSTIC_BYTES = 65_536;

export interface TiltProcessDiagnostics {
  status: 'running' | 'exited' | 'stopped' | 'failed';
  pid?: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  output: { text: string; retainedBytes: number; droppedBytes: number };
}

export interface TiltSession {
  readonly running: boolean;
  diagnostics(maxBytes: number): TiltProcessDiagnostics;
  stop(): Promise<void>;
}

export class TiltStartupError extends Error {
  constructor(message: string, readonly session: TiltSession) { super(message); }
}

export function validateDiagnosticBytes(maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DIAGNOSTIC_BYTES) {
    throw new Error(`maxBytes must be an integer from 1 to ${MAX_DIAGNOSTIC_BYTES}`);
  }
}

function utf8Tail(buffer: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

/** Captures only the managed Tilt child's output; no caller-selected executable or arguments. */
export async function startTiltProcess(
  environment: Environment,
  repoDir: string,
  dependencies: {
    spawn?: typeof spawn;
    forwardOutput?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    processGroup?: boolean;
    graceMs?: number;
    killMs?: number;
    startupMs?: number;
  } = {},
): Promise<TiltSession> {
  if (dependencies.signal?.aborted) throw new Error('Tilt startup cancelled');
  const processGroup = (dependencies.processGroup ?? true) && process.platform !== 'win32';
  const startupMs = dependencies.startupMs ?? 10_000;
  if (!Number.isInteger(startupMs) || startupMs < 1 || startupMs > 10_000) throw new Error('Tilt startup deadline must be within its fixed maximum');
  const child: ChildProcess = (dependencies.spawn ?? spawn)('tilt', ['up', '--stream', '--port', '10350', '--context', `k3d-${environment}`], {
    cwd: repoDir,
    env: { ...process.env, KUBECONFIG: join(homedir(), '.scratch', `${environment}.yaml`) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: processGroup,
  });
  trackManagedProcess(child, { processGroup, graceMs: dependencies.graceMs, killMs: dependencies.killMs });
  const forwardOutput = dependencies.forwardOutput ?? (chunk => { process.stderr.write(chunk); });
  let status: TiltProcessDiagnostics['status'] = 'running';
  const startedAt = new Date().toISOString();
  let exitedAt: string | undefined;
  let exitCode: number | null | undefined;
  let signal: string | null | undefined;
  let error: string | undefined;
  let stopRequested = false;
  let spawned = false;
  let output = Buffer.alloc(0);
  let totalBytes = 0;
  const retain = (chunk: Buffer) => {
    totalBytes += chunk.length;
    const tail = utf8Tail(chunk, MAX_DIAGNOSTIC_BYTES);
    output = Buffer.from(chunk.length >= MAX_DIAGNOSTIC_BYTES ? tail : utf8Tail(Buffer.concat([output, tail]), MAX_DIAGNOSTIC_BYTES));
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream?.on('data', (chunk: Buffer) => {
      retain(Buffer.from(decoder.write(chunk)));
      forwardOutput(chunk);
    });
    stream?.once('end', () => retain(Buffer.from(decoder.end())));
    stream?.on('error', failure => {
      error = failure.message.slice(0, 1024);
      void stop().catch(() => { error = 'Tilt output stream failed; managed process cleanup failed'; });
    });
  }
  child.on('error', failure => {
    error = failure.message.slice(0, 1024);
    if (!spawned) {
      status = 'failed';
      exitedAt = new Date().toISOString();
    }
  });
  child.once('exit', (code, exitSignal) => {
    status = stopRequested ? 'stopped' : 'exited';
    exitedAt = new Date().toISOString();
    exitCode = code;
    signal = exitSignal;
  });
  const stop = () => {
    stopRequested = true;
    return stopManagedProcess(child, {
      initialSignal: 'SIGINT', processGroup,
      graceMs: dependencies.graceMs ?? PROCESS_GRACE_MS,
      killMs: dependencies.killMs ?? PROCESS_KILL_MS,
    });
  };
  const session: TiltSession = {
    get running() { return status === 'running'; },
    diagnostics(maxBytes) {
      validateDiagnosticBytes(maxBytes);
      const tail = utf8Tail(output, maxBytes);
      return {
        status, pid: child.pid, startedAt, exitedAt, exitCode, signal, error,
        output: { text: tail.toString('utf8'), retainedBytes: tail.length, droppedBytes: totalBytes - tail.length },
      };
    },
    stop() {
      if (status === 'failed') return Promise.resolve();
      return stop();
    },
  };
  const startup = await new Promise<'ready' | 'cancelled' | 'timed_out'>(resolve => {
    let complete = false;
    const finish = (outcome: 'ready' | 'cancelled' | 'timed_out') => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      dependencies.signal?.removeEventListener('abort', onAbort);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      resolve(outcome);
    };
    const onSpawn = () => { spawned = true; finish('ready'); };
    const onError = () => finish('ready');
    const onAbort = () => finish('cancelled');
    const timer = setTimeout(() => finish('timed_out'), startupMs);
    child.once('spawn', onSpawn);
    child.once('error', onError);
    dependencies.signal?.addEventListener('abort', onAbort, { once: true });
    if (dependencies.signal?.aborted) onAbort();
  });
  if (startup !== 'ready' || dependencies.signal?.aborted) {
    try { await stop(); }
    catch { throw new TiltStartupError('Tilt startup cleanup failed', session); }
    throw new TiltStartupError(startup === 'timed_out' ? 'Tilt startup timed out' : 'Tilt startup cancelled', session);
  }
  return session;
}
