import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const ENVIRONMENTS = ['wasm-platform', 'db-operator'] as const;
export type Environment = typeof ENVIRONMENTS[number];
export type Action = 'start' | 'stop';
export interface LocalDevResult { environment: Environment; status: 'running' | 'stopped' | 'absent'; tiltUrl?: string }
export interface TiltSession { readonly running: boolean; stop(): Promise<void> }
export type Run = (command: string, args: string[], cwd?: string) => Promise<string>;
export type StartTilt = (environment: Environment, repoDir: string) => Promise<TiltSession>;

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const runCommand: Run = async (command, args, cwd) => (await execute(command, args, { cwd })).stdout;

const startTilt: StartTilt = async (environment, repoDir) => {
  const child = spawn('tilt', ['up', '--stream', '--port', '10350', '--context', `k3d-${environment}`], {
    cwd: repoDir,
    env: { ...process.env, KUBECONFIG: join(homedir(), '.scratch', `${environment}.yaml`) },
    stdio: ['ignore', 2, 2],
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return {
    get running() { return child.exitCode === null && child.signalCode === null; },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGINT');
      await closed;
    },
  };
};

interface Cluster { name: string; serversCount: number; serversRunning: number; agentsCount?: number; agentsRunning?: number }

/** One MCP process owns one foreground Tilt session for the two sibling repos. */
export class LocalDev {
  private closed = false;
  private busy = false;
  private active?: { environment: Environment; session: TiltSession };
  private readonly run: Run;
  private readonly startTilt: StartTilt;

  constructor(dependencies: { run?: Run; startTilt?: StartTilt } = {}) {
    this.run = dependencies.run ?? runCommand;
    this.startTilt = dependencies.startTilt ?? startTilt;
  }

  async execute(environment: Environment, action: Action): Promise<LocalDevResult> {
    if (this.busy) throw new Error('Another local_dev operation is in progress');
    this.busy = true;
    try { return await this.runAction(environment, action); }
    finally { this.busy = false; }
  }

  private async runAction(environment: Environment, action: Action): Promise<LocalDevResult> {
    if (this.closed) throw new Error('local_dev is closed');
    if (!ENVIRONMENTS.includes(environment) || !['start', 'stop'].includes(action)) throw new Error('Expected wasm-platform or db-operator and start or stop');
    if (action === 'start' && this.active?.environment === environment && this.active.session.running) return { environment, status: 'running', tiltUrl: 'http://localhost:10350' };
    if (action === 'start' || this.active?.environment === environment) await this.stopTilt();
    const clusters = JSON.parse(await this.run('k3d', ['cluster', 'list', '-o', 'json'])) as Cluster[];
    const selected = clusters.find(cluster => cluster.name === environment);
    const repoDir = join(rootDir, environment);
    if (action === 'stop') {
      if (selected) await this.run('make', ['-C', repoDir, 'cluster-down']);
      return { environment, status: selected ? 'stopped' : 'absent' };
    }
    const other = ENVIRONMENTS.find(name => name !== environment)!;
    if (clusters.some(cluster => cluster.name === other)) await this.run('make', ['-C', join(rootDir, other), 'cluster-down']);
    const running = selected && selected.serversCount > 0 && selected.serversRunning === selected.serversCount && (selected.agentsRunning ?? 0) === (selected.agentsCount ?? 0);
    if (!running) {
      if (selected) await this.run('make', ['-C', repoDir, 'cluster-down']);
      await this.run('make', ['-C', repoDir, 'cluster-up']);
    }
    if (this.closed) throw new Error('local_dev closed during cluster setup');
    const session = await this.startTilt(environment, repoDir);
    if (this.closed) { await session.stop(); throw new Error('local_dev closed during Tilt startup'); }
    this.active = { environment, session };
    return { environment, status: 'running', tiltUrl: 'http://localhost:10350' };
  }

  async close(): Promise<void> { this.closed = true; await this.stopTilt(); }

  private async stopTilt(): Promise<void> {
    if (!this.active) return;
    await this.active.session.stop();
    this.active = undefined;
  }
}
