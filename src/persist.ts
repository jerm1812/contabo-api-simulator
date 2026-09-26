// Optional state file (SIM_STATE_FILE) so a simulator restart keeps its
// instances and secrets, and reconciles them with the machines that survived.
import { promises as fs } from 'fs';
import * as path from 'path';
import * as store from './instance-store';
import { SimContext } from './sim';

export interface LoadResult {
  restored: number;
  /** Instances whose machine was gone, or that were mid-provisioning. */
  failed: number;
  /** Managed machines no active instance owns; removed. */
  orphansRemoved: number;
}

const RESTART_DURING_PROVISIONING = 'simulator restarted during provisioning';
const MACHINE_MISSING = 'machine missing after simulator restart';

/**
 * Load the state file if it exists, then reconcile with the backend: records
 * whose machine is gone or that were still provisioning become error, and
 * managed machines no active record owns are removed.
 */
export async function loadState(ctx: SimContext, file: string): Promise<LoadResult> {
  const result: LoadResult = { restored: 0, failed: 0, orphansRemoved: 0 };
  try {
    const raw = await fs.readFile(file, 'utf8');
    store.restore(JSON.parse(raw) as store.StoreSnapshot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const machines = await ctx.backend.list();
  const live = new Set(machines.map((m) => m.handle));
  const owned = new Set<string>();

  for (const record of store.getAllInstances()) {
    result.restored++;
    if (record.cancelled) continue;
    const fail = (msg: string) => {
      record.instance.status = 'error';
      record.instance.errorMessage = msg;
      record.phase = 'ready';
      result.failed++;
    };
    if (record.phase === 'provisioning') {
      // The lifecycle timers died with the old process; don't leave it hanging.
      fail(RESTART_DURING_PROVISIONING);
      continue;
    }
    if (record.containerId && !live.has(record.containerId)) {
      fail(MACHINE_MISSING);
      record.containerId = '';
      continue;
    }
    if (record.containerId) owned.add(record.containerId);
  }

  for (const m of machines) {
    if (owned.has(m.handle)) continue;
    try {
      await ctx.backend.remove(m.handle);
      result.orphansRemoved++;
    } catch (err) {
      console.error(`[State] could not remove orphan machine ${m.handle}: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Records whose (orphaned) machine was just removed no longer own one.
  for (const record of store.getAllInstances()) {
    if (record.containerId && !owned.has(record.containerId)) record.containerId = '';
  }
  return result;
}

export async function saveState(file: string): Promise<string> {
  const body = JSON.stringify(store.snapshot());
  await writeAtomic(file, body);
  return body;
}

async function writeAtomic(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export interface Persister {
  flush(): Promise<void>;
  stop(): void;
}

/** Write the state file whenever it changes, checking every intervalMs. */
export function startPersistence(file: string, intervalMs = 2000): Persister {
  let last = JSON.stringify(store.snapshot());
  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    writing = writing.then(async () => {
      const body = JSON.stringify(store.snapshot());
      if (body === last) return;
      await writeAtomic(file, body);
      last = body;
    }).catch((err) => console.error(`[State] save failed: ${err instanceof Error ? err.message : err}`));
    return writing;
  };
  const t = setInterval(() => void flush(), intervalMs);
  t.unref();
  return { flush, stop: () => clearInterval(t) };
}
