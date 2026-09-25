// Simulator context and the simulated instance lifecycle.
import { MachineBackend } from './backend';
import { ScenarioState, SimSettings, Scenario } from './scenarios';
import * as store from './instance-store';
import { InstanceRecord, InstanceStatus } from './types';
import { CONFIG } from './config';

export interface SimContext {
  backend: MachineBackend;
  scenarios: ScenarioState;
  /** Startup settings, restored by POST /sim/reset. */
  defaults: SimSettings;
  /** Access tokens issued by the token endpoint (strict auth). */
  tokens: Map<string, number>;
}

export function newContext(backend: MachineBackend, defaults: SimSettings): SimContext {
  return { backend, scenarios: new ScenarioState(defaults), defaults, tokens: new Map() };
}

const timers = new Map<number, NodeJS.Timeout[]>();

function schedule(instanceId: number, ms: number, fn: () => void | Promise<void>): void {
  const t = setTimeout(() => {
    Promise.resolve(fn()).catch((err) =>
      console.error(`[Lifecycle] ${instanceId}: ${err instanceof Error ? err.message : err}`)
    );
  }, ms);
  t.unref();
  const list = timers.get(instanceId) ?? [];
  list.push(t);
  timers.set(instanceId, list);
}

export function cancelTimers(instanceId: number): void {
  for (const t of timers.get(instanceId) ?? []) clearTimeout(t);
  timers.delete(instanceId);
}

function settle(record: InstanceRecord, status: InstanceStatus, errorMessage: string | null = null) {
  record.instance.status = status;
  record.instance.errorMessage = errorMessage;
  record.phase = 'ready';
}

export interface LifecycleInput {
  dockerImage: string;
  userData?: string;
  sshPublicKeys: string[];
}

/**
 * Drive a freshly created instance through the states its scenario calls for.
 * The instance starts in "provisioning" with no IP. For a normal run the
 * machine is created right away; halfway through the delay the instance moves
 * to "installing" with its IP (as Contabo does), and at the full delay to
 * "running". Every step waits for the machine, so a slow Docker never reports
 * "running" early.
 */
export function startLifecycle(ctx: SimContext, record: InstanceRecord, input: LifecycleInput): void {
  const id = record.instance.instanceId;
  const scenario = record.scenario as Scenario;
  const s = ctx.scenarios.settings;
  const delay = scenario === 'slow' ? s.slowDelayMs : s.provisionDelayMs;
  const half = Math.floor(delay / 2);

  switch (scenario) {
    case 'stuck':
      return; // provisioning forever
    case 'error':
      schedule(id, half, () => settle(record, 'error', 'Simulated provisioning error'));
      return;
    case 'product_not_available':
      schedule(id, half, () =>
        settle(record, 'product_not_available', 'Simulated: product is not available in this region')
      );
      return;
    default:
      break; // normal, slow, cancel_fail
  }

  const machine = ctx.backend
    .create({
      instanceId: id,
      dockerImage: input.dockerImage,
      displayName: record.instance.displayName,
      rootPassword: record.rootPassword,
      userData: input.userData,
      sshPublicKeys: input.sshPublicKeys,
    })
    .then((m) => {
      if (record.cancelled) {
        void ctx.backend.remove(m.handle).catch(() => undefined);
        return null;
      }
      record.containerId = m.handle;
      record.instance.sshPort = m.sshPort;
      return m;
    })
    .catch((err) => {
      if (!record.cancelled) {
        cancelTimers(id);
        settle(record, 'error', `Simulator could not create the machine: ${err instanceof Error ? err.message : err}`);
      }
      return null;
    });

  schedule(id, half, async () => {
    const m = await machine;
    if (!m || record.cancelled || record.phase === 'ready') return;
    store.setAddress(record, m.ip);
    record.instance.status = 'installing';
  });
  schedule(id, delay, async () => {
    const m = await machine;
    if (!m || record.cancelled || record.phase === 'ready') return;
    store.setAddress(record, m.ip);
    settle(record, 'running');
  });
}

/** Refresh a settled instance's status from its machine (running/stopped/gone). */
export async function refreshFromMachine(ctx: SimContext, record: InstanceRecord): Promise<void> {
  if (record.phase !== 'ready' || record.cancelled || !record.containerId) return;
  if (record.instance.status !== 'running' && record.instance.status !== 'stopped') return;
  const running = await ctx.backend.isRunning(record.containerId);
  if (running === null) {
    settle(record, 'error', 'Simulator machine is gone');
    return;
  }
  record.instance.status = running ? 'running' : 'stopped';
  const port = running ? await ctx.backend.sshPort(record.containerId) : undefined;
  if (port !== undefined) record.instance.sshPort = port;
}

/** Cancel an instance: stop its lifecycle, remove its machine, stamp cancelDate. */
export async function cancelInstance(ctx: SimContext, record: InstanceRecord): Promise<void> {
  cancelTimers(record.instance.instanceId);
  record.cancelled = true;
  record.phase = 'ready';
  record.instance.cancelDate = new Date().toISOString().slice(0, 10);
  record.instance.status = 'stopped';
  if (record.containerId) {
    const handle = record.containerId;
    record.containerId = '';
    await ctx.backend.remove(handle);
  }
}

/** Force an instance into a status (control API). Stops its lifecycle. */
export function forceStatus(record: InstanceRecord, status: InstanceStatus, errorMessage?: string): void {
  cancelTimers(record.instance.instanceId);
  settle(record, status, errorMessage ?? null);
}

/** Remove every instance and its machine, and restore startup settings. */
export async function resetAll(ctx: SimContext): Promise<void> {
  for (const record of store.getAllInstances()) {
    cancelTimers(record.instance.instanceId);
    record.cancelled = true;
    if (record.containerId) {
      await ctx.backend.remove(record.containerId).catch(() => undefined);
    }
  }
  store.clearInstances();
  ctx.scenarios.reset(ctx.defaults);
  ctx.tokens.clear();
}

export function defaultImageId(): string {
  return Object.keys(CONFIG.imageMapping)[0];
}
