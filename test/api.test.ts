import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, Harness, TOKEN_PATH, panelCreateBody } from './helpers';
import { cloudConfigSSHKeys } from '../src/cloud-config';
import { resetAll } from '../src/sim';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetAll(h.ctx);
});

async function create(body: unknown = panelCreateBody()) {
  return h.api('POST', '/v1/compute/instances', body);
}

describe('auth', () => {
  test('issues a token at the real Contabo token path', async () => {
    const tok = await h.token();
    assert.match(tok, /^sim-/);
  });

  test('strict mode rejects a token request without credentials', async () => {
    const res = await fetch(h.base + TOKEN_PATH, { method: 'POST' });
    assert.equal(res.status, 400);
  });

  test('strict mode rejects /v1 calls with an unknown token', async () => {
    const r = await h.api('GET', '/v1/compute/instances', undefined, 'not-issued');
    assert.equal(r.status, 401);
  });

  test('revoked tokens get 401 and a fresh token works', async () => {
    const tok = await h.token();
    assert.equal((await h.api('GET', '/v1/compute/instances', undefined, tok)).status, 200);
    await fetch(h.base + '/sim/faults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revokeTokens: true }),
    });
    assert.equal((await h.api('GET', '/v1/compute/instances', undefined, tok)).status, 401);
    assert.equal((await h.api('GET', '/v1/compute/instances')).status, 200);
  });

  test('queued token failures fail that many requests, then recover', async () => {
    h.ctx.scenarios.tokenFailures = 2;
    await assert.rejects(h.token(), /401/);
    await assert.rejects(h.token(), /401/);
    assert.match(await h.token(), /^sim-/);
  });
});

describe('instance lifecycle', () => {
  test('normal: provisioning without IP, then installing with IP, then running', async () => {
    const r = await create();
    assert.equal(r.status, 201);
    const inst = r.json.data[0];
    assert.equal(typeof inst.instanceId, 'number');
    assert.equal(inst.status, 'provisioning');
    assert.equal(inst.ipConfig.v4.ip, '');

    const seen = new Set<string>();
    const running = await h.waitFor(inst.instanceId, (i) => {
      seen.add(i.status);
      if (i.status === 'installing') assert.match(i.ipConfig.v4.ip, /^198\.51\.100\./);
      return i.status === 'running';
    });
    assert.match(running.ipConfig.v4.ip, /^198\.51\.100\.\d+$/);
    assert.equal(running.errorMessage, null);
    assert.ok(seen.has('running'));
  });

  test('accepts the legacy [imageId] array form', async () => {
    const r = await create({ ...panelCreateBody(), imageId: ['afecbb85-e2fc-46f0-9684-b46b1faf00bb'] });
    assert.equal(r.status, 201);
    assert.equal(r.json.data[0].imageId, 'afecbb85-e2fc-46f0-9684-b46b1faf00bb');
  });

  test('stuck: stays in provisioning past the delay', async () => {
    h.ctx.scenarios.queue = ['stuck'];
    const id = (await create()).json.data[0].instanceId;
    await new Promise((r) => setTimeout(r, 150));
    const inst = (await h.api('GET', `/v1/compute/instances/${id}`)).json.data[0];
    assert.equal(inst.status, 'provisioning');
    assert.equal(inst.ipConfig.v4.ip, '');
  });

  for (const scenario of ['error', 'product_not_available'] as const) {
    test(`${scenario}: settles on status ${scenario} with an errorMessage`, async () => {
      h.ctx.scenarios.queue = [scenario];
      const id = (await create()).json.data[0].instanceId;
      const inst = await h.waitFor(id, (i) => i.status === scenario);
      assert.ok(inst.errorMessage && inst.errorMessage.length > 0);
      assert.equal(inst.ipConfig.v4.ip, '');
    });
  }

  test('slow: still installing after the normal delay, running after the slow delay', async () => {
    h.ctx.scenarios.queue = ['slow'];
    const id = (await create()).json.data[0].instanceId;
    await new Promise((r) => setTimeout(r, 120));
    const mid = (await h.api('GET', `/v1/compute/instances/${id}`)).json.data[0];
    assert.notEqual(mid.status, 'running');
    await h.waitFor(id, (i) => i.status === 'running');
  });

  test('create_fail: 500 and nothing is created', async () => {
    h.ctx.scenarios.queue = ['create_fail'];
    const r = await create();
    assert.equal(r.status, 500);
    const list = await h.api('GET', '/v1/compute/instances');
    assert.equal(list.json.data.length, 0);
  });

  test('queued scenarios are used in order, then the default', async () => {
    h.ctx.scenarios.queue = ['error', 'stuck'];
    const a = (await create()).json.data[0].instanceId;
    const b = (await create()).json.data[0].instanceId;
    const c = (await create()).json.data[0].instanceId;
    await h.waitFor(a, (i) => i.status === 'error');
    await h.waitFor(c, (i) => i.status === 'running');
    const bi = (await h.api('GET', `/v1/compute/instances/${b}`)).json.data[0];
    assert.equal(bi.status, 'provisioning');
  });
});

describe('cancel', () => {
  test('removes the machine and stamps cancelDate; GET still answers', async () => {
    const id = (await create()).json.data[0].instanceId;
    await h.waitFor(id, (i) => i.status === 'running');
    const handle = `none-${id}`;
    assert.equal(await h.backend.isRunning(handle), true);

    const r = await h.api('POST', `/v1/compute/instances/${id}/cancel`, {});
    assert.equal(r.status, 200);
    assert.match(r.json.data[0].cancelDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(await h.backend.isRunning(handle), null);

    const inst = (await h.api('GET', `/v1/compute/instances/${id}`)).json.data[0];
    assert.equal(inst.cancelDate, r.json.data[0].cancelDate);
  });

  test('cancelling while provisioning stops the lifecycle', async () => {
    const id = (await create()).json.data[0].instanceId;
    assert.equal((await h.api('POST', `/v1/compute/instances/${id}/cancel`, {})).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    const inst = (await h.api('GET', `/v1/compute/instances/${id}`)).json.data[0];
    assert.notEqual(inst.status, 'running');
    assert.equal(await h.backend.isRunning(`none-${id}`), null);
  });

  test('cancel_fail: cancel returns 500 and the machine stays', async () => {
    h.ctx.scenarios.queue = ['cancel_fail'];
    const id = (await create()).json.data[0].instanceId;
    await h.waitFor(id, (i) => i.status === 'running');
    assert.equal((await h.api('POST', `/v1/compute/instances/${id}/cancel`, {})).status, 500);
    assert.equal(await h.backend.isRunning(`none-${id}`), true);
  });

  test('unknown instance is 404', async () => {
    assert.equal((await h.api('POST', '/v1/compute/instances/1/cancel', {})).status, 404);
  });
});

describe('actions', () => {
  test('stop and start a running instance', async () => {
    const id = (await create()).json.data[0].instanceId;
    await h.waitFor(id, (i) => i.status === 'running');
    assert.equal((await h.api('POST', `/v1/compute/instances/${id}/actions/stop`)).status, 201);
    assert.equal((await h.api('GET', `/v1/compute/instances/${id}`)).json.data[0].status, 'stopped');
    assert.equal((await h.api('POST', `/v1/compute/instances/${id}/actions/start`)).status, 201);
    assert.equal((await h.api('GET', `/v1/compute/instances/${id}`)).json.data[0].status, 'running');
  });

  test('actions on a provisioning instance are 409', async () => {
    h.ctx.scenarios.queue = ['stuck'];
    const id = (await create()).json.data[0].instanceId;
    assert.equal((await h.api('POST', `/v1/compute/instances/${id}/actions/stop`)).status, 409);
  });
});

describe('control API', () => {
  const put = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(h.base + path, {
      method: path === '/sim/scenario' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  test('PUT /sim/scenario sets the default and the queue', async () => {
    const res = await put('/sim/scenario', { default: 'stuck', next: ['error'] });
    assert.equal(res.status, 200);
    const a = (await create()).json.data[0].instanceId;
    const b = (await create()).json.data[0].instanceId;
    await h.waitFor(a, (i) => i.status === 'error');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await h.api('GET', `/v1/compute/instances/${b}`)).json.data[0].status, 'provisioning');
  });

  test('rejects unknown scenarios', async () => {
    assert.equal((await put('/sim/scenario', { default: 'nope' })).status, 400);
    assert.equal((await put('/sim/scenario', { next: ['normal', 'nope'] })).status, 400);
  });

  test('forces an instance status', async () => {
    h.ctx.scenarios.queue = ['stuck'];
    const id = (await create()).json.data[0].instanceId;
    const res = await put(`/sim/instances/${id}/status`, { status: 'error', errorMessage: 'boom' });
    assert.equal(res.status, 200);
    const inst = (await h.api('GET', `/v1/compute/instances/${id}`)).json.data[0];
    assert.equal(inst.status, 'error');
    assert.equal(inst.errorMessage, 'boom');
  });

  test('reset removes instances and machines', async () => {
    const id = (await create()).json.data[0].instanceId;
    await h.waitFor(id, (i) => i.status === 'running');
    assert.equal((await put('/sim/reset', {})).status, 200);
    assert.equal((await h.api('GET', '/v1/compute/instances')).json.data.length, 0);
    assert.equal(await h.backend.isRunning(`none-${id}`), null);
  });

  test('SIM_CONTROL_TOKEN guards the control API', async () => {
    process.env.SIM_CONTROL_TOKEN = 'ctl';
    try {
      assert.equal((await fetch(h.base + '/sim/state')).status, 401);
      assert.equal((await fetch(h.base + '/sim/state', { headers: { 'X-Sim-Control-Token': 'ctl' } })).status, 200);
    } finally {
      delete process.env.SIM_CONTROL_TOKEN;
    }
  });
});

describe('cloud-config', () => {
  test('extracts ssh_authorized_keys the way the panel sends them', () => {
    const keys = cloudConfigSSHKeys(panelCreateBody('ssh-ed25519 AAAAKEY me@host').userData);
    assert.deepEqual(keys, ['ssh-ed25519 AAAAKEY me@host']);
  });

  test('ignores non-cloud-config and malformed userData', () => {
    assert.deepEqual(cloudConfigSSHKeys('#!/bin/bash\necho hi'), []);
    assert.deepEqual(cloudConfigSSHKeys('#cloud-config\n: : :'), []);
    assert.deepEqual(cloudConfigSSHKeys(undefined), []);
  });
});
