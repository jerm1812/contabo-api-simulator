import { Router, Request, Response } from 'express';
import * as store from '../instance-store';
import { CONFIG } from '../config';
import { InstanceActionResponse, InstanceStatus } from '../types';
import { SimContext } from '../sim';

type Action = 'start' | 'stop' | 'restart' | 'shutdown';

const RESULT: Record<Action, InstanceStatus> = {
  start: 'running',
  stop: 'stopped',
  restart: 'running',
  shutdown: 'stopped',
};

function actionResponse(instanceId: number, action: string) {
  const data: InstanceActionResponse = {
    tenantId: CONFIG.tenantId,
    customerId: CONFIG.customerId,
    instanceId,
    action,
  };
  return {
    data: [data],
    _links: { self: `/v1/compute/instances/${instanceId}/actions/${action}` },
  };
}

export function instanceActionsRouter(ctx: SimContext): Router {
  const router = Router();

  for (const action of Object.keys(RESULT) as Action[]) {
    router.post(`/:instanceId/actions/${action}`, async (req: Request, res: Response) => {
      try {
        const instanceId = parseInt(req.params.instanceId as string);
        const record = store.getInstance(instanceId);
        if (!record) {
          res.status(404).json({ statusCode: 404, message: `Instance ${instanceId} not found` });
          return;
        }
        if (record.cancelled || record.phase !== 'ready' || !record.containerId) {
          res.status(409).json({
            statusCode: 409,
            message: `Instance ${instanceId} is ${record.cancelled ? 'cancelled' : record.instance.status}; cannot ${action}`,
          });
          return;
        }
        const handle = record.containerId;
        if (action === 'start') await ctx.backend.start(handle);
        else if (action === 'restart') await ctx.backend.restart(handle);
        else await ctx.backend.stop(handle);

        record.instance.status = RESULT[action];
        record.instance.errorMessage = null;
        const port = RESULT[action] === 'running' ? await ctx.backend.sshPort(handle) : 0;
        if (port !== undefined) record.instance.sshPort = port;

        res.status(201).json(actionResponse(instanceId, action));
      } catch (err: any) {
        console.error(`[Actions] ${action} error:`, err.message);
        res.status(500).json({ statusCode: 500, message: err.message });
      }
    });
  }

  return router;
}
