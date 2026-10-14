import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIAGNOSTIC_BYTES, startTiltProcess, TiltStartupError, validateDiagnosticBytes, type TiltProcessDiagnostics, type TiltSession } from './tilt/process.js';
import { runManagedCommand } from './process.js';

export type { TiltSession } from './tilt/process.js';

export const ENVIRONMENTS = ['wasm-platform', 'db-operator'] as const;
export type Environment = typeof ENVIRONMENTS[number];
export type Action = 'start' | 'stop';
export interface LocalDevResult { environment: Environment; status: 'running' | 'stopped' | 'absent'; tiltUrl?: string }
export type LocalDevDiagnostics = { environment: Environment } & (TiltProcessDiagnostics | {
  status: 'not_started';
  output: { text: string; retainedBytes: number; droppedBytes: number };
});
export type Run = (command: string, args: string[], cwd?: string, signal?: AbortSignal) => Promise<string>;
export type StartTilt = (environment: Environment, repoDir: string, signal?: AbortSignal) => Promise<TiltSession>;

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const OPERATION_TIMEOUT_MS = 5 * 60_000;
const CLEANUP_TIMEOUT_MS = 8_000;

interface Cluster { name: string; serversCount: number; serversRunning: number; agentsCount?: number; agentsRunning?: number }
interface Operation { environment: Environment; action: Action; promise: Promise<LocalDevResult>; controller: AbortController }

/** One MCP process owns one foreground Tilt session for the two sibling repos. */
export class LocalDev {
  private closed = false;
  private operation?: Operation;
  private closePromise?: Promise<void>;
  private active?: { environment: Environment; session: TiltSession };
  private readonly sessions = new Map<Environment, TiltSession>();
  private readonly launchAttempts = new Map<Environment, object>();
  private readonly stopping = new WeakMap<TiltSession, Promise<void>>();
  private readonly run: Run;
  private readonly startTilt: StartTilt;

  constructor(dependencies: { run?: Run; startTilt?: StartTilt } = {}) {
    this.run = dependencies.run ?? runManagedCommand;
    this.startTilt = dependencies.startTilt ?? ((environment, repoDir, signal) => startTiltProcess(environment, repoDir, { signal }));
  }

  diagnostics(environment: Environment, maxBytes = DEFAULT_DIAGNOSTIC_BYTES): LocalDevDiagnostics {
    if (!ENVIRONMENTS.includes(environment)) throw new Error('Expected wasm-platform or db-operator');
    validateDiagnosticBytes(maxBytes);
    const session = this.sessions.get(environment);
    return session ? { environment, ...session.diagnostics(maxBytes) } : {
      environment, status: 'not_started', output: { text: '', retainedBytes: 0, droppedBytes: 0 },
    };
  }

  async execute(environment: Environment, action: Action, signal?: AbortSignal): Promise<LocalDevResult> {
    if (!ENVIRONMENTS.includes(environment) || !['start', 'stop'].includes(action)) throw new Error('Expected wasm-platform or db-operator and start or stop');
    if (this.closed) throw new Error('local_dev is closed');
    signal?.throwIfAborted();
    const previous = this.operation;
    if (previous) {
      if (previous.environment !== environment || action !== 'stop') throw new Error('Another local_dev operation is in progress');
      if (previous.action === 'stop') return previous.promise;
      previous.controller.abort(new Error(`local_dev start cancelled by stop for ${environment}`));
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('local_dev operation timed out after 5 minutes')), OPERATION_TIMEOUT_MS);
    const promise = Promise.resolve().then(async () => {
      if (previous) await previous.promise.catch(() => {});
      this.checkCancelled(controller.signal);
      return this.runAction(environment, action, controller.signal);
    }).finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (this.operation === operation) this.operation = undefined;
    });
    const operation: Operation = { environment, action, controller, promise };
    this.operation = operation;
    return promise;
  }

  private async runAction(environment: Environment, action: Action, signal: AbortSignal): Promise<LocalDevResult> {
    this.checkCancelled(signal);
    if (action === 'start' && this.active?.environment === environment && this.active.session.running) return { environment, status: 'running', tiltUrl: 'http://localhost:10350' };
    if (action === 'start' || this.active?.environment === environment) await this.stopTilt();
    this.checkCancelled(signal);
    const clusters = JSON.parse(await this.runCommand('k3d', ['cluster', 'list', '-o', 'json'], signal)) as Cluster[];
    const selected = clusters.find(cluster => cluster.name === environment);
    const repoDir = join(rootDir, environment);
    if (action === 'stop') {
      if (selected) await this.runCommand('make', ['-C', repoDir, 'cluster-down'], signal);
      return { environment, status: selected ? 'stopped' : 'absent' };
    }
    const other = ENVIRONMENTS.find(name => name !== environment)!;
    if (clusters.some(cluster => cluster.name === other)) await this.runCommand('make', ['-C', join(rootDir, other), 'cluster-down'], signal);
    const running = selected && selected.serversCount > 0 && selected.serversRunning === selected.serversCount && (selected.agentsRunning ?? 0) === (selected.agentsCount ?? 0);
    if (!running) {
      if (selected) await this.runCommand('make', ['-C', repoDir, 'cluster-down'], signal);
      await this.runCommand('make', ['-C', repoDir, 'cluster-up'], signal);
    }
    this.checkCancelled(signal);
    const launchAttempt = {};
    this.launchAttempts.set(environment, launchAttempt);
    let launchedSession: TiltSession | undefined;
    const launching = this.startTilt(environment, repoDir, signal).then(async session => {
      launchedSession = session;
      if (this.launchAttempts.get(environment) === launchAttempt) this.sessions.set(environment, session);
      if (signal.aborted || this.closed) {
        await this.stopSession(session);
        this.checkCancelled(signal);
      }
      return session;
    }).catch(error => {
      if (error instanceof TiltStartupError && this.launchAttempts.get(environment) === launchAttempt) {
        launchedSession = error.session;
        this.sessions.set(environment, error.session);
        if (!this.active) this.active = { environment, session: error.session };
      }
      throw error;
    });
    try {
      const session = await this.awaitStep(launching, signal);
      this.checkCancelled(signal);
      this.active = { environment, session };
      if (!session.running) throw new Error(`Tilt exited or failed to start. Call local_dev_diagnostics for ${environment}.`);
      return { environment, status: 'running', tiltUrl: 'http://localhost:10350' };
    } catch (error) {
      if (signal.aborted && launchedSession) await this.stopSession(launchedSession);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const operation = this.operation;
    operation?.controller.abort(new Error('local_dev closed'));
    this.closePromise = (async () => {
      if (operation) await operation.promise.catch(() => {});
      await this.stopTilt();
    })();
    return this.closePromise;
  }

  private checkCancelled(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed) throw new Error('local_dev is closed');
  }

  private async runCommand(command: string, args: string[], signal: AbortSignal): Promise<string> {
    this.checkCancelled(signal);
    const result = await this.awaitStep(this.run(command, args, undefined, signal), signal);
    this.checkCancelled(signal);
    return result;
  }

  private awaitStep<T>(step: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(cleanupTimeout);
        signal.removeEventListener('abort', onAbort);
        result();
      };
      const onAbort = () => {
        cleanupTimeout = setTimeout(() => settle(() => reject(signal.reason)), CLEANUP_TIMEOUT_MS);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      step.then(
        result => settle(() => signal.aborted ? reject(signal.reason) : resolve(result)),
        error => settle(() => reject(signal.aborted ? signal.reason : error)),
      );
    });
  }

  private stopSession(session: TiltSession): Promise<void> {
    const pending = this.stopping.get(session);
    if (pending) return pending;
    const stopped = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tilt cleanup timed out')), CLEANUP_TIMEOUT_MS);
      Promise.resolve().then(() => session.stop()).then(resolve, reject).finally(() => clearTimeout(timeout));
    }).catch(error => {
      if (this.stopping.get(session) === stopped) this.stopping.delete(session);
      throw error;
    });
    this.stopping.set(session, stopped);
    return stopped;
  }

  private async stopTilt(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await this.stopSession(active.session);
    if (this.active === active) this.active = undefined;
  }
}
