// Machine backends: what actually stands behind a simulated instance.
//   docker  real SSH-accessible containers (the upstream behaviour)
//   none    no machine at all; API-only, for CI and fast panel tests
import * as dockerMgr from './docker-manager';
import { MachineInit, MachineLimits } from './config';

export interface MachineSpec {
  instanceId: number;
  dockerImage: string;
  displayName: string;
  init: MachineInit;
  /** Entrypoint images only; empty means key-only. */
  rootPassword?: string;
  userData?: string;
  sshPublicKeys: string[];
}

export interface Machine {
  handle: string;
  /** The address reported in ipConfig.v4.ip. */
  ip: string;
  /** SSH port on that address (22 unless it's a published host port). */
  sshPort: number;
}

export interface MachineBackend {
  readonly name: 'docker' | 'none';
  create(spec: MachineSpec): Promise<Machine>;
  start(handle: string): Promise<void>;
  stop(handle: string): Promise<void>;
  restart(handle: string): Promise<void>;
  remove(handle: string): Promise<void>;
  /** true running, false stopped, null missing. */
  isRunning(handle: string): Promise<boolean | null>;
  /** Current SSH port, when it can change across restarts. */
  sshPort(handle: string): Promise<number | undefined>;
  /** Handles of machines this simulator owns, with the instance each belongs to. */
  list(): Promise<{ handle: string; instanceId: number }[]>;
}

// ─── none ───

export class NullBackend implements MachineBackend {
  readonly name = 'none' as const;
  private machines = new Map<string, { running: boolean }>();
  private nextHost = 10;

  async create(spec: MachineSpec): Promise<Machine> {
    const handle = `none-${spec.instanceId}`;
    this.machines.set(handle, { running: true });
    // TEST-NET-2 (RFC 5737): documentation-only, never routable.
    const host = this.nextHost;
    this.nextHost = this.nextHost >= 250 ? 10 : this.nextHost + 1;
    return { handle, ip: `198.51.100.${host}`, sshPort: 22 };
  }

  private get(handle: string) {
    const m = this.machines.get(handle);
    if (!m) throw new Error(`machine ${handle} not found`);
    return m;
  }

  async start(handle: string) {
    this.get(handle).running = true;
  }
  async stop(handle: string) {
    this.get(handle).running = false;
  }
  async restart(handle: string) {
    this.get(handle).running = true;
  }
  async remove(handle: string) {
    this.machines.delete(handle);
  }
  async isRunning(handle: string) {
    const m = this.machines.get(handle);
    return m ? m.running : null;
  }
  async sshPort() {
    return 22;
  }
  async list() {
    return Array.from(this.machines.keys()).map((handle) => ({
      handle,
      instanceId: Number(handle.replace(/^none-/, '')),
    }));
  }
}

// ─── docker ───

export type ReportedAddress = 'localhost' | 'container';

export class DockerBackend implements MachineBackend {
  readonly name = 'docker' as const;

  /**
   * localhost   report 127.0.0.1 and the published host port (upstream default)
   * container   report the container's own bridge IP with SSH on 22, which is
   *             what a panel on the same host needs (it always dials port 22)
   */
  constructor(
    private readonly reportAddress: ReportedAddress = 'localhost',
    private readonly limits: Partial<MachineLimits> = {}
  ) {}

  async create(spec: MachineSpec): Promise<Machine> {
    const res = await dockerMgr.createContainer({
      dockerImage: spec.dockerImage,
      instanceId: spec.instanceId,
      displayName: spec.displayName,
      init: spec.init,
      rootPassword: spec.rootPassword,
      userData: spec.userData,
      sshPublicKeys: spec.sshPublicKeys,
      // In container mode the machine is reached on its own IP; nothing is
      // published on the host.
      publishPorts: this.reportAddress !== 'container',
      cpus: this.limits.cpus,
      memoryMb: this.limits.memoryMb,
      pids: this.limits.pids,
      bootTimeoutMs: this.limits.bootTimeoutMs,
    });
    if (this.reportAddress === 'container' && res.containerIp) {
      return { handle: res.containerId, ip: res.containerIp, sshPort: 22 };
    }
    return { handle: res.containerId, ip: '127.0.0.1', sshPort: res.sshPort };
  }

  start(handle: string) {
    return dockerMgr.startContainer(handle);
  }
  stop(handle: string) {
    return dockerMgr.stopContainer(handle);
  }
  restart(handle: string) {
    return dockerMgr.restartContainer(handle);
  }
  remove(handle: string) {
    return dockerMgr.removeContainer(handle);
  }

  async isRunning(handle: string) {
    const s = await dockerMgr.getContainerStatus(handle);
    if (s.status === 'error') return null;
    return s.status === 'running';
  }

  async sshPort(handle: string) {
    if (this.reportAddress === 'container') return 22;
    const s = await dockerMgr.getContainerStatus(handle);
    return s.sshPort;
  }

  async list() {
    const all = await dockerMgr.listManagedContainers();
    return all.map((c) => ({ handle: c.id, instanceId: c.instanceId }));
  }
}

export function backendFromEnv(limits: Partial<MachineLimits> = {}): MachineBackend {
  const kind = (process.env.SIM_BACKEND || 'docker').trim().toLowerCase();
  if (kind === 'none') return new NullBackend();
  if (kind !== 'docker') throw new Error(`SIM_BACKEND=${kind} must be "docker" or "none"`);
  const addr = (process.env.SIM_REPORT_ADDRESS || 'localhost').trim().toLowerCase();
  if (addr !== 'localhost' && addr !== 'container') {
    throw new Error(`SIM_REPORT_ADDRESS=${addr} must be "localhost" or "container"`);
  }
  return new DockerBackend(addr, limits);
}
