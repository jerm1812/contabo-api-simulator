export type MachineInit = 'systemd' | 'entrypoint';

export interface ImageInfo {
  dockerImage: string;
  name: string;
  osType: string;
  /** systemd: the image boots /sbin/init. entrypoint: upstream dockerd+sshd script. */
  init: MachineInit;
}

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}=${raw} must be a non-negative number`);
  return n;
}

/** Resource caps for the Docker machines. 0 means no limit. */
export interface MachineLimits {
  /** Instances that may hold a machine at once (SIM_MAX_INSTANCES). */
  maxInstances: number;
  /** CPUs per machine (SIM_MACHINE_CPUS). */
  cpus: number;
  /** Memory per machine in MB (SIM_MACHINE_MEMORY_MB). */
  memoryMb: number;
  /** Processes per machine (SIM_MACHINE_PIDS). */
  pids: number;
  /** Instances older than this are cancelled and their machine removed (SIM_MAX_AGE_HOURS). */
  maxAgeHours: number;
  /** How long to wait for a systemd machine to boot sshd and Docker (SIM_BOOT_TIMEOUT_MS). */
  bootTimeoutMs: number;
}

export function limitsFromEnv(): MachineLimits {
  return {
    maxInstances: envInt('SIM_MAX_INSTANCES', 0),
    cpus: envInt('SIM_MACHINE_CPUS', 0),
    memoryMb: envInt('SIM_MACHINE_MEMORY_MB', 0),
    pids: envInt('SIM_MACHINE_PIDS', 0),
    maxAgeHours: envInt('SIM_MAX_AGE_HOURS', 0),
    bootTimeoutMs: envInt('SIM_BOOT_TIMEOUT_MS', 120000),
  };
}

export const CONFIG = {
  port: parseInt(process.env.PORT || '5550'),
  tenantId: 'DE',
  customerId: process.env.CUSTOMER_ID || '54321',
  /**
   * Root password for entrypoint-style images only. Empty by default: machines
   * are key-only, like a Contabo VM created with an SSH key. The systemd image
   * never accepts passwords.
   */
  rootPassword: process.env.SIM_ROOT_PASSWORD || '',
  dockerNetwork: process.env.SIM_DOCKER_NETWORK || 'contabo-sim-network',
  /** Optional subnet for the machine network, e.g. 172.30.0.0/24 (SIM_DOCKER_SUBNET). */
  dockerSubnet: process.env.SIM_DOCKER_SUBNET || '',
  containerLabel: 'contabo-simulator',
  // Image ID mapping: Contabo UUID → Docker image tag
  imageMapping: {
    'afecbb85-e2fc-46f0-9684-b46b1faf00bb': {
      dockerImage: 'contabo-sim-ubuntu:22.04',
      name: 'Ubuntu 22.04',
      osType: 'Linux',
      init: 'systemd',
    },
    'b1a06e61-7a3c-4150-b145-78c85cdfb211': {
      dockerImage: 'contabo-sim-debian:12',
      name: 'Debian 12',
      osType: 'Linux',
      init: 'entrypoint',
    },
  } as Record<string, ImageInfo>,
  // Product ID mapping
  productMapping: {
    V45: { ramMb: 8192, cpuCores: 4, diskMb: 200 * 1024, name: 'VPS S' },
    V92: { ramMb: 16384, cpuCores: 6, diskMb: 400 * 1024, name: 'VPS M' },
    V93: { ramMb: 32768, cpuCores: 8, diskMb: 800 * 1024, name: 'VPS L' },
    V94: { ramMb: 65536, cpuCores: 10, diskMb: 1600 * 1024, name: 'VPS XL' },
  } as Record<string, { ramMb: number; cpuCores: number; diskMb: number; name: string }>,
};
