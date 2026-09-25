import { CONFIG } from './config';
import { buildImages } from './docker-manager';
import { backendFromEnv } from './backend';
import { settingsFromEnv } from './scenarios';
import { newContext } from './sim';
import { createApp } from './app';

async function start() {
  const settings = settingsFromEnv();
  const backend = backendFromEnv();
  const ctx = newContext(backend, settings);
  const app = createApp(ctx);

  console.log('Contabo API Simulator');
  console.log(`  machine backend: ${backend.name}`);
  console.log(`  default scenario: ${settings.defaultScenario} (${settings.provisionDelayMs} ms to running)`);
  console.log(`  strict auth: ${settings.strictAuth ? 'on' : 'off'}`);

  if (backend.name === 'docker') await buildImages();

  const host = process.env.HOST || '0.0.0.0';
  app.listen(CONFIG.port, host, () => {
    console.log(`  API:       http://${host}:${CONFIG.port}`);
    console.log(`  token:     POST /auth/realms/contabo/protocol/openid-connect/token`);
    console.log(`  control:   /sim/state, /sim/scenario, /sim/faults, /sim/reset`);
    console.log(`  dashboard: http://${host}:${CONFIG.port}/dashboard`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
