import { spawn, type ChildProcess } from 'node:child_process';

export const MANAGED_COMMAND_TIMEOUT_MS = 300_000;
export const MAX_MANAGED_STDOUT_BYTES = 1024 * 1024;
export const PROCESS_GRACE_MS = 5000;
export const PROCESS_KILL_MS = 2000;
const MAX_MANAGED_STDERR_BYTES = 16_384;
export type ManagedCommandRunner = (command: string, args: string[], cwd?: string, signal?: AbortSignal) => Promise<string>;

interface ProcessState {
  closed: boolean;
  exited: boolean;
  processGroup: boolean;
  groupReleased: boolean;
  cleanupFailed: boolean;
  graceMs?: number;
  killMs?: number;
  stopping?: Promise<void>;
  stopped: boolean;
}

const states = new WeakMap<ChildProcess, ProcessState>();

/** Install lifetime listeners immediately after spawn, before any shutdown can race close. */
export function trackManagedProcess(child: ChildProcess, options: { processGroup?: boolean; graceMs?: number; killMs?: number } = {}): void {
  if (states.has(child)) return;
  const exited = (child.exitCode !== null && child.exitCode !== undefined) || (child.signalCode !== null && child.signalCode !== undefined);
  const state: ProcessState = {
    closed: false, exited, stopped: false, cleanupFailed: false,
    processGroup: !exited && !!options.processGroup && process.platform !== 'win32',
    groupReleased: false, graceMs: options.graceMs, killMs: options.killMs,
  };
  states.set(child, state);
  const cleanupGroup = () => {
    if (!state.processGroup || state.groupReleased) return;
    try {
      if (groupExists(child)) void stopManagedProcess(child, { processGroup: true, graceMs: state.graceMs, killMs: state.killMs }).catch(() => { state.cleanupFailed = true; });
    } catch { state.cleanupFailed = true; }
  };
  child.once('close', () => { state.closed = true; cleanupGroup(); });
  child.once('exit', () => { state.exited = true; cleanupGroup(); });
  child.on('error', () => {});
}

function duration(value: number | undefined, maximum: number): number {
  const selected = value ?? maximum;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) throw new Error('Managed process deadlines must be positive and within their fixed maximums');
  return selected;
}

function groupExists(child: ChildProcess): boolean {
  const state = states.get(child);
  if (!state?.processGroup || state.groupReleased) return false;
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { state.groupReleased = true; return false; }
    throw new Error('Could not inspect managed process group');
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean): void {
  if (!child.pid) return;
  if (processGroup && (!states.get(child)?.processGroup || states.get(child)?.groupReleased)) return;
  if (processGroup && !groupExists(child)) return;
  if (!processGroup && states.get(child)?.exited) return;
  try {
    if (processGroup) {
      process.kill(-child.pid, signal);
      if (signal === 'SIGKILL') states.get(child)!.groupReleased = true;
    }
    else if (!child.kill(signal)) throw new Error('Could not signal managed process');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Could not signal managed process');
    if (processGroup) states.get(child)!.groupReleased = true;
  }
}

function waitForClose(child: ChildProcess, state: ProcessState, timeoutMs: number, waitForGroup: boolean): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (poll) clearInterval(poll);
      child.removeListener('close', check);
      if (error) reject(error);
      else resolve(result);
    };
    const check = () => {
      try { if (state.closed && (!waitForGroup || !groupExists(child))) finish(true); }
      catch { finish(false, new Error('Could not inspect managed process group')); }
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const poll = waitForGroup ? setInterval(check, Math.min(50, timeoutMs)) : undefined;
    child.on('close', check);
    check();
  });
}

/** Signals only a child owned by this server, with bounded graceful and forced shutdown. */
export function stopManagedProcess(child: ChildProcess, options: {
  initialSignal?: NodeJS.Signals;
  processGroup?: boolean;
  graceMs?: number;
  killMs?: number;
} = {}): Promise<void> {
  trackManagedProcess(child, options);
  const state = states.get(child)!;
  if (state.stopping) return state.stopping;
  if (state.stopped) return Promise.resolve();
  const graceMs = duration(options.graceMs, PROCESS_GRACE_MS);
  const killMs = duration(options.killMs, PROCESS_KILL_MS);
  const processGroup = (options.processGroup ?? false) && state.processGroup;
  const initialSignal = options.initialSignal ?? 'SIGTERM';
  const stop = async () => {
    let awaitingPid = !child.pid;
    const onSpawn = () => {
      if (!awaitingPid) return;
      awaitingPid = false;
      try { signalChild(child, initialSignal, processGroup); } catch {}
    };
    child.once('spawn', onSpawn);
    try {
      if (!state.closed || processGroup && groupExists(child)) signalChild(child, initialSignal, processGroup);
      if (await waitForClose(child, state, graceMs, processGroup)) { state.stopped = true; state.cleanupFailed = false; return; }
      signalChild(child, 'SIGKILL', processGroup);
      if (!await waitForClose(child, state, killMs, false)) throw new Error('Managed process did not close after forced shutdown');
      state.stopped = true;
      state.cleanupFailed = false;
      if (processGroup) state.groupReleased = true;
    } finally { child.removeListener('spawn', onSpawn); }
  };
  const stopping = stop();
  state.stopping = stopping;
  void stopping.finally(() => { if (state.stopping === stopping) state.stopping = undefined; }).catch(() => {});
  return stopping;
}

/** Commands are fixed by the lifecycle owner; dependency overrides are only for process tests. */
export function createManagedCommandRunner(dependencies: {
  spawn?: typeof spawn;
  processGroup?: boolean;
  timeoutMs?: number;
  graceMs?: number;
  killMs?: number;
} = {}): ManagedCommandRunner {
  const timeoutMs = duration(dependencies.timeoutMs, MANAGED_COMMAND_TIMEOUT_MS);
  const graceMs = duration(dependencies.graceMs, PROCESS_GRACE_MS);
  const killMs = duration(dependencies.killMs, PROCESS_KILL_MS);
  const processGroup = (dependencies.processGroup ?? true) && process.platform !== 'win32';
  return async (command, args, cwd, signal) => {
    if (signal?.aborted) throw new Error('Managed command cancelled');
    let child: ChildProcess;
    try { child = (dependencies.spawn ?? spawn)(command, args, { cwd, detached: processGroup, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error('Could not start managed command'); }
    trackManagedProcess(child, { processGroup, graceMs, killMs });
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let failure: string | undefined;
      let stdoutBytes = 0;
      const stdout: Buffer[] = [];
      let stderr = Buffer.alloc(0);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(new Error(error));
        else resolve(Buffer.concat(stdout).toString('utf8'));
      };
      const cancel = (message: string) => {
        if (failure || settled) return;
        failure = message;
        void stopManagedProcess(child, { processGroup, graceMs, killMs }).then(
          () => finish(message),
          () => finish(`${message}; managed process cleanup failed`),
        );
      };
      const onAbort = () => cancel('Managed command cancelled');
      const timeout = setTimeout(() => cancel('Managed command timed out'), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (failure || settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_MANAGED_STDOUT_BYTES) { cancel('Managed command stdout exceeds the size limit'); return; }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const tail = chunk.subarray(Math.max(0, chunk.length - MAX_MANAGED_STDERR_BYTES));
        stderr = Buffer.from(chunk.length >= MAX_MANAGED_STDERR_BYTES ? tail : Buffer.concat([stderr, tail]).subarray(-MAX_MANAGED_STDERR_BYTES));
      });
      child.on('error', () => cancel('Managed command process failed'));
      for (const stream of [child.stdout, child.stderr]) stream?.on('error', () => cancel('Managed command output stream failed'));
      child.once('close', (code: number | null, exitSignal: NodeJS.Signals | null) => {
        if (failure) return;
        const completed = () => {
          if (failure) return;
          if (states.get(child)!.cleanupFailed) finish('Managed command descendant cleanup failed');
          else if (code !== 0) finish(`Managed command failed (${exitSignal ? `signal ${exitSignal}` : `exit code ${code ?? 'unknown'}`}; ${stderr.length} retained stderr bytes)`);
          else finish();
        };
        const stopping = states.get(child)!.stopping;
        if (stopping) void stopping.then(completed, () => finish('Managed command descendant cleanup failed'));
        else completed();
      });
      if (signal?.aborted) onAbort();
    });
  };
}

export const runManagedCommand: ManagedCommandRunner = createManagedCommandRunner();
