// Scriptable behaviour for the simulator: what the next instance create does,
// plus one-off faults (token failures, revoked tokens). Driven by env vars at
// startup and changed at runtime through the /sim control API.

export const SCENARIOS = [
  'normal', // provisioning, then installing (IP assigned), then running
  'slow', // same as normal but uses SIM_SLOW_DELAY_MS
  'stuck', // stays in provisioning forever
  'error', // goes to status "error" with an errorMessage
  'product_not_available', // goes to status "product_not_available"
  'create_fail', // POST /v1/compute/instances returns 500, nothing is created
  'cancel_fail', // instance runs normally, but POST .../cancel returns 500
] as const;

export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(v: unknown): v is Scenario {
  return typeof v === 'string' && (SCENARIOS as readonly string[]).includes(v);
}

export interface SimSettings {
  defaultScenario: Scenario;
  /** Total time from create to "running" for the normal scenario. */
  provisionDelayMs: number;
  /** Total time from create to "running" for the slow scenario. */
  slowDelayMs: number;
  /** When true, /v1 routes only accept tokens this simulator issued. */
  strictAuth: boolean;
  /** When true, every token request fails with 401. */
  tokenAlwaysFails: boolean;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function settingsFromEnv(): SimSettings {
  const envScenario = (process.env.SIM_SCENARIO || 'normal').trim();
  if (!isScenario(envScenario)) {
    throw new Error(`SIM_SCENARIO=${envScenario} is not one of: ${SCENARIOS.join(', ')}`);
  }
  return {
    defaultScenario: envScenario,
    provisionDelayMs: intEnv('SIM_PROVISION_DELAY_MS', 5000),
    slowDelayMs: intEnv('SIM_SLOW_DELAY_MS', 120000),
    strictAuth: boolEnv('SIM_STRICT_AUTH', false),
    tokenAlwaysFails: boolEnv('SIM_TOKEN_FAIL', false),
  };
}

/** Mutable runtime state for scenarios and faults. */
export class ScenarioState {
  settings: SimSettings;
  /** One-shot scenarios consumed in order by the next creates. */
  queue: Scenario[] = [];
  /** Number of upcoming token requests that should fail with 401. */
  tokenFailures = 0;

  constructor(settings: SimSettings) {
    this.settings = { ...settings };
  }

  /** The scenario for the next create: the queue first, then the default. */
  takeNext(): Scenario {
    return this.queue.shift() ?? this.settings.defaultScenario;
  }

  /** Whether this token request should fail (consumes a queued failure). */
  takeTokenFailure(): boolean {
    if (this.settings.tokenAlwaysFails) return true;
    if (this.tokenFailures > 0) {
      this.tokenFailures--;
      return true;
    }
    return false;
  }

  reset(defaults: SimSettings): void {
    this.settings = { ...defaults };
    this.queue = [];
    this.tokenFailures = 0;
  }

  snapshot() {
    return {
      settings: { ...this.settings },
      queue: [...this.queue],
      tokenFailures: this.tokenFailures,
      scenarios: [...SCENARIOS],
    };
  }
}
