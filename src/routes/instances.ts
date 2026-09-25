import { Router, Request, Response } from 'express';
import { CONFIG } from '../config';
import * as store from '../instance-store';
import { buildPaginatedResponse, buildSingleResponse } from '../response-builder';
import { CreateInstanceRequest } from '../types';
import { SimContext, startLifecycle, refreshFromMachine, cancelInstance, cancelTimers, defaultImageId } from '../sim';
import { cloudConfigSSHKeys } from '../cloud-config';

function notFound(res: Response, instanceId: number) {
  res.status(404).json({ statusCode: 404, message: `Instance ${instanceId} not found` });
}

function serverError(res: Response, message: string) {
  res.status(500).json({ statusCode: 500, message });
}

/** Contabo accepts imageId as a string; the upstream simulator also took [string]. */
function normalizeImageId(raw: unknown): string {
  if (Array.isArray(raw)) raw = raw[0];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : defaultImageId();
}

export function instancesRouter(ctx: SimContext): Router {
  const router = Router();

  // ─── GET /v1/compute/instances ───
  router.get('/', async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const size = parseInt(req.query.size as string) || 10;
      const records = store.getAllInstances();
      await Promise.all(records.map((r) => refreshFromMachine(ctx, r)));
      const instances = records.map((r) => r.instance);
      res.json(buildPaginatedResponse(instances, page, size, '/v1/compute/instances'));
    } catch (err: any) {
      console.error('[Instances] List error:', err.message);
      serverError(res, err.message);
    }
  });

  // ─── POST /v1/compute/instances ───
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body: CreateInstanceRequest = req.body || {};
      const scenario = ctx.scenarios.takeNext();
      if (scenario === 'create_fail') {
        console.log('[Instances] Create failed (scenario create_fail)');
        serverError(res, 'Simulated: instance creation failed');
        return;
      }

      const imageId = normalizeImageId(body.imageId);
      const productId = body.productId || 'V45';
      const region = body.region || 'EU';
      const displayName = body.displayName || 'VPS';
      const defaultUser = body.defaultUser || 'root';
      const sshKeys = body.sshKeys || [];
      const userData = body.userData;

      // Keys from Contabo secrets (sshKeys) and from cloud-config userData.
      const sshPublicKeys: string[] = [];
      for (const secretId of sshKeys) {
        const secret = store.getSecret(secretId);
        if (secret && secret.type === 'ssh') sshPublicKeys.push(secret.value);
        else console.warn(`[Instances] SSH key secret ${secretId} missing or not type ssh; skipping`);
      }
      sshPublicKeys.push(...cloudConfigSSHKeys(userData));

      let imageInfo = CONFIG.imageMapping[imageId];
      if (!imageInfo) {
        if (ctx.backend.name === 'docker') {
          res.status(400).json({
            statusCode: 400,
            message: `Unknown imageId: ${imageId}. Available: ${Object.keys(CONFIG.imageMapping).join(', ')}`,
          });
          return;
        }
        imageInfo = CONFIG.imageMapping[defaultImageId()];
      }

      const record = store.createInstance({
        imageId,
        productId,
        region,
        displayName,
        defaultUser,
        sshKeys,
        rootPassword: CONFIG.defaultPassword,
        osType: imageInfo.osType,
        scenario,
        status: 'provisioning',
      });

      startLifecycle(ctx, record, { dockerImage: imageInfo.dockerImage, userData, sshPublicKeys });
      console.log(`[Instances] Created instance ${record.instance.instanceId} (scenario ${scenario})`);

      res
        .status(201)
        .json(buildSingleResponse(record.instance, `/v1/compute/instances/${record.instance.instanceId}`));
    } catch (err: any) {
      console.error('[Instances] Create error:', err.message);
      serverError(res, err.message);
    }
  });

  // ─── GET /v1/compute/instances/:instanceId ───
  router.get('/:instanceId', async (req: Request, res: Response) => {
    try {
      const instanceId = parseInt(req.params.instanceId as string);
      const record = store.getInstance(instanceId);
      if (!record) return notFound(res, instanceId);
      await refreshFromMachine(ctx, record);
      res.json(buildSingleResponse(record.instance, `/v1/compute/instances/${instanceId}`));
    } catch (err: any) {
      console.error('[Instances] Get error:', err.message);
      serverError(res, err.message);
    }
  });

  // ─── PATCH /v1/compute/instances/:instanceId ───
  router.patch('/:instanceId', (req: Request, res: Response) => {
    const instanceId = parseInt(req.params.instanceId as string);
    const record = store.getInstance(instanceId);
    if (!record) return notFound(res, instanceId);
    if (req.body?.displayName) record.instance.displayName = req.body.displayName;
    res.json(buildSingleResponse(record.instance, `/v1/compute/instances/${instanceId}`));
  });

  // ─── POST /v1/compute/instances/:instanceId/cancel ───
  // Contabo has no DELETE for instances; cancel ends the contract. The
  // simulator removes the machine right away and keeps the record with a
  // cancelDate so a later GET still answers.
  router.post('/:instanceId/cancel', async (req: Request, res: Response) => {
    try {
      const instanceId = parseInt(req.params.instanceId as string);
      const record = store.getInstance(instanceId);
      if (!record) return notFound(res, instanceId);
      if (record.scenario === 'cancel_fail') {
        console.log(`[Instances] Cancel failed for ${instanceId} (scenario cancel_fail)`);
        serverError(res, 'Simulated: cancellation failed');
        return;
      }
      await cancelInstance(ctx, record);
      console.log(`[Instances] Cancelled instance ${instanceId}`);
      res.json({
        data: [
          {
            tenantId: record.instance.tenantId,
            customerId: record.instance.customerId,
            instanceId,
            cancelDate: record.instance.cancelDate,
          },
        ],
        _links: { self: `/v1/compute/instances/${instanceId}/cancel` },
      });
    } catch (err: any) {
      console.error('[Instances] Cancel error:', err.message);
      serverError(res, err.message);
    }
  });

  // ─── DELETE /v1/compute/instances/:instanceId ───
  // Not part of Contabo's API; kept from upstream for the dashboard.
  router.delete('/:instanceId', async (req: Request, res: Response) => {
    try {
      const instanceId = parseInt(req.params.instanceId as string);
      const record = store.deleteInstance(instanceId);
      if (!record) return notFound(res, instanceId);
      cancelTimers(instanceId);
      record.cancelled = true;
      if (record.containerId) await ctx.backend.remove(record.containerId);
      console.log(`[Instances] Deleted instance ${instanceId}`);
      res.status(204).send();
    } catch (err: any) {
      console.error('[Instances] Delete error:', err.message);
      serverError(res, err.message);
    }
  });

  return router;
}
