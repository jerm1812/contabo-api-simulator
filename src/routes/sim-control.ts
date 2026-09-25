// Control API for tests and staging: choose what the next create does, inject
// token faults, force an instance into a state, or reset everything. Not part
// of Contabo's API. When SIM_CONTROL_TOKEN is set, requests need the header
// X-Sim-Control-Token with that value.
import { Router, Request, Response, NextFunction } from 'express';
import * as store from '../instance-store';
import { SimContext, forceStatus, resetAll } from '../sim';
import { isScenario, SCENARIOS } from '../scenarios';
import { InstanceStatus } from '../types';

const FORCEABLE: InstanceStatus[] = ['provisioning', 'installing', 'running', 'stopped', 'error', 'product_not_available'];

function bad(res: Response, message: string) {
  res.status(400).json({ statusCode: 400, message });
}

export function simControlRouter(ctx: SimContext): Router {
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const want = process.env.SIM_CONTROL_TOKEN;
    if (want && req.header('x-sim-control-token') !== want) {
      res.status(401).json({ statusCode: 401, message: 'missing or wrong X-Sim-Control-Token' });
      return;
    }
    next();
  });

  // GET /sim/state
  router.get('/state', (_req, res) => {
    res.json({
      ...ctx.scenarios.snapshot(),
      backend: ctx.backend.name,
      instances: store.getAllInstances().map((r) => ({
        instanceId: r.instance.instanceId,
        status: r.instance.status,
        ip: r.instance.ipConfig.v4.ip,
        scenario: r.scenario,
        cancelled: r.cancelled,
      })),
    });
  });

  // PUT /sim/scenario { default?, next?: [...], provisionDelayMs?, slowDelayMs?, strictAuth? }
  router.put('/scenario', (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    if (b.default !== undefined && !isScenario(b.default)) {
      return bad(res, `default must be one of: ${SCENARIOS.join(', ')}`);
    }
    if (b.next !== undefined && (!Array.isArray(b.next) || !b.next.every(isScenario))) {
      return bad(res, `next must be an array of: ${SCENARIOS.join(', ')}`);
    }
    for (const k of ['provisionDelayMs', 'slowDelayMs'] as const) {
      if (b[k] !== undefined && (typeof b[k] !== 'number' || (b[k] as number) < 0)) {
        return bad(res, `${k} must be a non-negative number`);
      }
    }
    if (b.strictAuth !== undefined && typeof b.strictAuth !== 'boolean') return bad(res, 'strictAuth must be boolean');

    const s = ctx.scenarios.settings;
    if (isScenario(b.default)) s.defaultScenario = b.default;
    if (Array.isArray(b.next)) ctx.scenarios.queue = [...b.next] as typeof ctx.scenarios.queue;
    if (typeof b.provisionDelayMs === 'number') s.provisionDelayMs = b.provisionDelayMs;
    if (typeof b.slowDelayMs === 'number') s.slowDelayMs = b.slowDelayMs;
    if (typeof b.strictAuth === 'boolean') s.strictAuth = b.strictAuth;
    res.json(ctx.scenarios.snapshot());
  });

  // POST /sim/faults { tokenFailures?: n, tokenAlwaysFails?: bool, revokeTokens?: bool }
  router.post('/faults', (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    if (b.tokenFailures !== undefined) {
      if (typeof b.tokenFailures !== 'number' || b.tokenFailures < 0) return bad(res, 'tokenFailures must be >= 0');
      ctx.scenarios.tokenFailures = Math.floor(b.tokenFailures);
    }
    if (b.tokenAlwaysFails !== undefined) {
      if (typeof b.tokenAlwaysFails !== 'boolean') return bad(res, 'tokenAlwaysFails must be boolean');
      ctx.scenarios.settings.tokenAlwaysFails = b.tokenAlwaysFails;
    }
    if (b.revokeTokens === true) ctx.tokens.clear();
    res.json(ctx.scenarios.snapshot());
  });

  // POST /sim/instances/:id/status { status, errorMessage? }
  router.post('/instances/:instanceId/status', (req, res) => {
    const instanceId = parseInt(req.params.instanceId as string);
    const record = store.getInstance(instanceId);
    if (!record) {
      res.status(404).json({ statusCode: 404, message: `Instance ${instanceId} not found` });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    if (!FORCEABLE.includes(b.status as InstanceStatus)) return bad(res, `status must be one of: ${FORCEABLE.join(', ')}`);
    if (b.errorMessage !== undefined && typeof b.errorMessage !== 'string') return bad(res, 'errorMessage must be a string');
    forceStatus(record, b.status as InstanceStatus, b.errorMessage as string | undefined);
    res.json({ data: [record.instance] });
  });

  // POST /sim/reset: remove every instance and machine, restore startup settings.
  router.post('/reset', async (_req, res) => {
    await resetAll(ctx);
    res.json(ctx.scenarios.snapshot());
  });

  return router;
}
