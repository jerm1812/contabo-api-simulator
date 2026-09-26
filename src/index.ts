import { CONFIG, limitsFromEnv } from './config';
import { buildImages } from './docker-manager';
import { backendFromEnv } from './backend';
import { settingsFromEnv } from './scenarios';
import { newContext, reapExpired } from './sim';
import { createApp } from './app';
import { loadState, startPersistence, Persister } from './persist';

const REAP_INTERVAL_MS = 60_000;

async function start() {
  const settings = settingsFromEnv();
  const limits = limitsFromEnv();
  const backend = backendFromEnv(limits);
  const ctx = newContext(backend, settings, limits);
  const app = createApp(ctx);

  console.log('Contabo API Simulator');
  console.log(`  machine backend: ${backend.name}`);
  console.log(`  default scenario: ${settings.defaultScenario} (${settings.provisionDelayMs} ms to running)`);
  console.log(`  strict auth: ${settings.strictAuth ? 'on' : 'off'}`);
  console.log(
    `  limits: max instances ${limits.maxInstances || 'unlimited'}, cpus ${limits.cpus || 'unlimited'}, ` +
      `memory ${limits.memoryMb ? limits.memoryMb + ' MB' : 'unlimited'}, max age ${limits.maxAgeHours ? limits.maxAgeHours + ' h' : 'off'}`
  );

  if (backend.name === 'docker') await buildImages();

  let persister: Persister | undefined;
  const stateFile = process.env.SIM_STATE_FILE?.trim();
  if (stateFile) {
    const r = await loadState(ctx, stateFile);
    console.log(
      `  state file: ${stateFile} (${r.restored} instances restored, ${r.failed} marked error, ${r.orphansRemoved} orphan machines removed)`
    );
    persister = startPersistence(stateFile);
  } else {
    // Without a state file nothing can own a machine from a previous run.
    let removed = 0;
    for (const m of await backend.list()) {
      await backend.remove(m.handle).then(() => removed++, () => undefined);
    }
    if (removed) console.log(`  removed ${removed} machines left from a previous run`);
  }

  if (limits.maxAgeHours) {
    setInterval(() => void reapExpired(ctx), REAP_INTERVAL_MS).unref();
  }

  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(CONFIG.port, host, () => {
    console.log(`  API:       http://${host}:${CONFIG.port}`);
    console.log(`  token:     POST /auth/realms/contabo/protocol/openid-connect/token`);
    console.log(`  control:   /sim/state, /sim/scenario, /sim/faults, /sim/reset`);
    console.log(`  dashboard: http://${host}:${CONFIG.port}/dashboard`);
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal}: saving state and exiting`);
    persister?.stop();
    await persister?.flush();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
