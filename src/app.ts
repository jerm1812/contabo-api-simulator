import express from 'express';
import cors from 'cors';
import path from 'path';
import { CONFIG } from './config';
import * as store from './instance-store';
import { SimContext, refreshFromMachine } from './sim';
import { authRouter, requireToken } from './routes/auth';
import { instancesRouter } from './routes/instances';
import { instanceActionsRouter } from './routes/instance-actions';
import { simControlRouter } from './routes/sim-control';
import imagesRouter from './routes/images';
import secretsRouter from './routes/secrets';

export function createApp(ctx: SimContext, opts: { logRequests?: boolean } = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  if (opts.logRequests !== false) {
    app.use((req, _res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, backend: ctx.backend.name });
  });

  // ─── Contabo API ───
  app.use('/', authRouter(ctx));
  app.use('/v1', requireToken(ctx));
  app.use('/v1/compute/instances', instancesRouter(ctx));
  app.use('/v1/compute/instances', instanceActionsRouter(ctx));
  app.use('/v1/compute/images', imagesRouter);
  app.use('/v1/secrets', secretsRouter);

  // ─── Simulator control API ───
  app.use('/sim', simControlRouter(ctx));

  // ─── Dashboard ───
  app.get('/', (_req, res) => res.redirect('/dashboard'));
  app.get('/dashboard', (_req, res) => {
    res.sendFile('dashboard.html', { root: path.join(__dirname, '..', 'public') });
  });

  app.get('/api/dashboard/stats', async (_req, res) => {
    const records = store.getAllInstances();
    await Promise.all(records.map((r) => refreshFromMachine(ctx, r)));
    const instances = records.map((r) => ({
      ...r.instance,
      containerId: r.containerId.substring(0, 12),
      rootPassword: r.rootPassword,
    }));
    res.json({
      stats: {
        total: instances.length,
        running: instances.filter((i) => i.status === 'running').length,
        stopped: instances.filter((i) => i.status === 'stopped').length,
      },
      instances,
      secrets: store.getAllSecrets(),
      availableImages: Object.entries(CONFIG.imageMapping).map(([id, info]) => ({ imageId: id, ...info })),
    });
  });

  return app;
}
