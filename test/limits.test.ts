import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { startHarness, Harness, panelCreateBody } from './helpers';
import { resetAll, reapExpired, newContext, activeInstanceCount } from '../src/sim';
import { NullBackend } from '../src/backend';
import { limitsFromEnv } from '../src/config';
import * as store from '../src/instance-store';
import { loadState, saveState, startPersistence } from '../src/persist';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetAll(h.ctx);
  h.ctx.limits = { ...h.ctx.limits, maxInstances: 0, maxAgeHours: 0 };
});

const create = () => h.api('POST', '/v1/compute/instances', panelCreateBody());

describe('limits', () => {
  test('newContext fills unset limits with no caps', () => {
    const ctx = newContext(new NullBackend(), h.ctx.defaults, { maxInstances: 2 });
    assert.equal(ctx.limits.maxInstances, 2);
    assert.equal(ctx.limits.cpus, 0);
    assert.equal(ctx.limits.maxAgeHours, 0);
    assert.equal(ctx.limits.bootTimeoutMs, 120000);
  });

  test('limitsFromEnv reads SIM_* caps', () => {
    const saved = { ...process.env };
    try {
      process.env.SIM_MAX_INSTANCES = '3';
      process.env.SIM_MACHINE_CPUS = '2';
      process.env.SIM_MACHINE_MEMORY_MB = '2048';
      process.env.SIM_MAX_AGE_HOURS = '24';
      const l = limitsFromEnv();
      assert.equal(l.maxInstances, 3);
      assert.equal(l.cpus, 2);
      assert.equal(l.memoryMb, 2048);
      assert.equal(l.maxAgeHours, 24);
    } finally {
      process.env = saved;
    }
  });

  test('SIM_MAX_INSTANCES refuses creates with 429 and frees up after cancel', async () => {
    h.ctx.limits.maxInstances = 2;
    const a = await create();
    const b = await create();
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const c = await create();
    assert.equal(c.status, 429);
    assert.match(c.json.message, /limit reached \(2\)/);

    const id = a.json.data[0].instanceId;
    assert.equal((await h.api("POST", `/v1/compute/instances/${id}/cancel`, {})).status, 200);
    assert.equal(activeInstanceCount(), 1);
    assert.equal((await create()).status, 201);
  });

  test('reaper cancels instances older than SIM_MAX_AGE_HOURS only', async () => {
    const old = (await create()).json.data[0];
    const fresh = (await create()).json.data[0];
    await h.waitFor(old.instanceId, (i) => i.status === 'running');
    await h.waitFor(fresh.instanceId, (i) => i.status === 'running');
    store.getInstance(old.instanceId)!.instance.createdDate = new Date(Date.now() - 25 * 3600 * 1000).toISOString();

    assert.deepEqual(await reapExpired(h.ctx), [], 'off when SIM_MAX_AGE_HOURS is 0');
    h.ctx.limits.maxAgeHours = 24;
    assert.deepEqual(await reapExpired(h.ctx), [old.instanceId]);
    assert.equal(store.getInstance(old.instanceId)!.cancelled, true);
    assert.equal(store.getInstance(fresh.instanceId)!.cancelled, false);
  });
});

describe('state file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sim-state-'));
  });

  test('round-trips instances and reconciles with the backend', async () => {
    const running = (await create()).json.data[0];
    await h.waitFor(running.instanceId, (i) => i.status === 'running');
    const gone = (await create()).json.data[0];
    await h.waitFor(gone.instanceId, (i) => i.status === 'running');
    const file = path.join(dir, 'state.json');
    await saveState(file);

    // Simulate a restart: new backend where only one machine survived, plus an orphan.
    const backend = new NullBackend();
    const survivor = store.getInstance(running.instanceId)!.containerId;
    (backend as any).machines.set(survivor, { running: true });
    (backend as any).machines.set('none-999999', { running: true });
    store.clearInstances();
    const ctx = newContext(backend, h.ctx.defaults);

    const r = await loadState(ctx, file);
    assert.equal(r.restored, 2);
    assert.equal(r.failed, 1);
    assert.equal(r.orphansRemoved, 1);
    assert.equal(store.getInstance(running.instanceId)!.instance.status, 'running');
    const g = store.getInstance(gone.instanceId)!;
    assert.equal(g.instance.status, 'error');
    assert.match(g.instance.errorMessage ?? '', /missing after simulator restart/);
    assert.deepEqual((await backend.list()).map((m) => m.handle), [survivor]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('an instance caught mid-provisioning comes back as error', async () => {
    h.ctx.scenarios.queue.push('stuck');
    const inst = (await create()).json.data[0];
    const file = path.join(dir, 'state.json');
    await saveState(file);
    store.clearInstances();

    const ctx = newContext(new NullBackend(), h.ctx.defaults);
    await loadState(ctx, file);
    const rec = store.getInstance(inst.instanceId)!;
    assert.equal(rec.instance.status, 'error');
    assert.equal(rec.phase, 'ready');
    assert.match(rec.instance.errorMessage ?? '', /restarted during provisioning/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a missing state file is a clean start', async () => {
    const ctx = newContext(new NullBackend(), h.ctx.defaults);
    const r = await loadState(ctx, path.join(dir, 'nope.json'));
    assert.deepEqual(r, { restored: 0, failed: 0, orphansRemoved: 0 });
    rmSync(dir, { recursive: true, force: true });
  });

  test('persistence writes only when something changed, and on flush', async () => {
    const file = path.join(dir, 'state.json');
    const p = startPersistence(file, 60_000);
    await p.flush();
    assert.equal(existsSync(file), false, 'nothing changed yet');
    const inst = (await create()).json.data[0];
    await p.flush();
    p.stop();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.instances[0].instance.instanceId, inst.instanceId);
    rmSync(dir, { recursive: true, force: true });
  });
});
