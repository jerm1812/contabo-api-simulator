import { AddressInfo } from 'net';
import { Server } from 'http';
import { NullBackend } from '../src/backend';
import { SimSettings } from '../src/scenarios';
import { newContext, resetAll, SimContext } from '../src/sim';
import { createApp } from '../src/app';

export const TOKEN_PATH = '/auth/realms/contabo/protocol/openid-connect/token';

export interface Harness {
  ctx: SimContext;
  backend: NullBackend;
  base: string;
  close(): Promise<void>;
  token(): Promise<string>;
  api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }>;
  waitFor(id: number, pred: (inst: any) => boolean, timeoutMs?: number): Promise<any>;
}

export async function startHarness(overrides: Partial<SimSettings> = {}): Promise<Harness> {
  const settings: SimSettings = {
    defaultScenario: 'normal',
    provisionDelayMs: 60,
    slowDelayMs: 400,
    strictAuth: true,
    tokenAlwaysFails: false,
    ...overrides,
  };
  const backend = new NullBackend();
  const ctx = newContext(backend, settings);
  await resetAll(ctx);
  const app = createApp(ctx, { logRequests: false });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const h: Harness = {
    ctx,
    backend,
    base,
    async close() {
      await resetAll(ctx);
      await new Promise<void>((r) => server.close(() => r()));
    },
    async token() {
      const res = await fetch(base + TOKEN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'cid',
          client_secret: 'sec',
          username: 'user',
          password: 'pass',
        }).toString(),
      });
      if (res.status !== 200) throw new Error(`token status ${res.status}`);
      return ((await res.json()) as { access_token: string }).access_token;
    },
    async api(method, path, body, token) {
      const tok = token ?? (await h.token());
      const res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    async waitFor(id, pred, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      let last: any;
      while (Date.now() < deadline) {
        const r = await h.api('GET', `/v1/compute/instances/${id}`);
        last = r.json?.data?.[0];
        if (last && pred(last)) return last;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out; last state ${JSON.stringify(last && { status: last.status, ip: last.ipConfig?.v4?.ip })}`);
    },
  };
  return h;
}

/** The body giga-panel's provision.Contabo.Create sends. */
export function panelCreateBody(sshPub = 'ssh-ed25519 AAAATEST panel@test') {
  return {
    imageId: 'afecbb85-e2fc-46f0-9684-b46b1faf00bb',
    productId: 'V45',
    region: 'EU',
    displayName: 'bronto-node-test',
    period: 1,
    defaultUser: 'root',
    userData: `#cloud-config\nssh_authorized_keys:\n  - ${sshPub}\n`,
  };
}
