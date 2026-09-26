import Docker from 'dockerode';
import yaml from 'js-yaml';
import { CONFIG, MachineInit } from './config';

const docker = new Docker();

const CONTAINER_LABEL_KEY = 'managed-by';
const CONTAINER_LABEL_VALUE = CONFIG.containerLabel;
const NETWORK_NAME = CONFIG.dockerNetwork;

async function ensureNetwork(): Promise<void> {
  try {
    const network = docker.getNetwork(NETWORK_NAME);
    await network.inspect();
  } catch {
    const opts: Docker.NetworkCreateOptions = {
      Name: NETWORK_NAME,
      Driver: 'bridge',
      Labels: { [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE },
    };
    if (CONFIG.dockerSubnet) opts.IPAM = { Driver: 'default', Config: [{ Subnet: CONFIG.dockerSubnet }] };
    await docker.createNetwork(opts);
    console.log(`[DockerManager] Created network: ${NETWORK_NAME}${CONFIG.dockerSubnet ? ` (${CONFIG.dockerSubnet})` : ''}`);
  }
}

export interface ContainerCreateResult {
  containerId: string;
  sshPort: number;
  containerIp: string;
}

export interface ContainerSpec {
  dockerImage: string;
  instanceId: number;
  displayName: string;
  init: MachineInit;
  /** Entrypoint images only; empty leaves root without a password. */
  rootPassword?: string;
  userData?: string;
  sshPublicKeys?: string[];
  /** Publish 22 and 8080 on random host ports (upstream localhost mode). */
  publishPorts: boolean;
  cpus?: number;
  memoryMb?: number;
  pids?: number;
  /** systemd images: wait this long for sshd and Docker to be active. */
  bootTimeoutMs?: number;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function createContainer(spec: ContainerSpec): Promise<ContainerCreateResult> {
  await ensureNetwork();

  const { instanceId, init } = spec;
  const containerName = `contabo-sim-${instanceId}`;
  const hostConfig: Docker.HostConfig & { CgroupnsMode?: string } = {
    Privileged: true, // Docker-in-Docker (and systemd) need it
    NetworkMode: NETWORK_NAME,
    Binds: [
      `contabo-sim-dind-${instanceId}:/var/lib/docker`, // Named volume gives overlay2 a real ext4 FS
    ],
  };
  if (spec.publishPorts) {
    hostConfig.PortBindings = {
      '22/tcp': [{ HostPort: '0' }], // dynamic port assignment
      '8080/tcp': [{ HostPort: '0' }], // side-agent HTTP port
    };
  }
  if (spec.cpus) hostConfig.NanoCpus = Math.round(spec.cpus * 1e9);
  if (spec.memoryMb) hostConfig.Memory = Math.round(spec.memoryMb * 1024 * 1024);
  if (spec.pids) hostConfig.PidsLimit = spec.pids;

  const opts: Docker.ContainerCreateOptions = {
    Image: spec.dockerImage,
    name: containerName,
    Hostname: `vmd${instanceId}`,
    Labels: {
      [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE,
      'contabo-sim-instance-id': String(instanceId),
      'contabo-sim-display-name': spec.displayName,
    },
    ExposedPorts: { '22/tcp': {}, '8080/tcp': {} },
    HostConfig: hostConfig,
  };
  if (init === 'systemd') {
    // Same shape kind uses for systemd nodes: private cgroup namespace and
    // tmpfs for /run, /run/lock and /tmp. The image's CMD is /sbin/init.
    hostConfig.CgroupnsMode = 'private';
    hostConfig.Tmpfs = { '/run': 'rw,exec,mode=755', '/run/lock': 'rw,mode=1777', '/tmp': 'rw,exec,mode=1777' };
    opts.Env = ['container=docker'];
  } else {
    const setPassword = spec.rootPassword
      ? `echo ${shellQuote(`root:${spec.rootPassword}`)} | chpasswd && `
      : 'passwd -l root >/dev/null && ';
    opts.Cmd = ['/bin/bash', '-c', `${setPassword}/usr/local/bin/entrypoint.sh`];
  }

  const container = await docker.createContainer(opts);
  try {
    await container.start();

    const info = await container.inspect();
    const portBindings = info.NetworkSettings.Ports?.['22/tcp'];
    const sshPort = portBindings && portBindings[0] ? parseInt(portBindings[0].HostPort || '0') : 0;
    const networkInfo = info.NetworkSettings.Networks[NETWORK_NAME];
    const containerIp = networkInfo ? networkInfo.IPAddress : '127.0.0.1';

    const keys = spec.sshPublicKeys ?? [];
    if (keys.length > 0) {
      await injectKeys(container, containerName, keys);
    }
    if (init === 'systemd') {
      await waitForBoot(container, containerName, spec.bootTimeoutMs ?? 120000);
    }

    // Fire-and-forget: execute userData (cloud-init or raw script)
    if (spec.userData && spec.userData.trim()) {
      const userData = spec.userData;
      (async () => {
        try {
          if (userData.trimStart().startsWith('#cloud-config')) {
            await executeCloudInit(container, containerName, userData);
          } else {
            await executeRawScript(container, containerName, userData);
          }
        } catch (err: any) {
          console.error(`[DockerManager] Failed to execute userData in ${containerName}: ${err.message}`);
        }
      })();
    }

    console.log(
      `[DockerManager] Created container ${containerName} (ID: ${container.id.substring(0, 12)}) ip ${containerIp}` +
        (spec.publishPorts ? ` ssh port ${sshPort}` : '')
    );
    return { containerId: container.id, sshPort, containerIp };
  } catch (err) {
    // Don't leave a half-made machine behind.
    await removeContainer(container.id).catch(() => undefined);
    throw err;
  }
}

async function injectKeys(container: Docker.Container, containerName: string, keys: string[]): Promise<void> {
  const b64 = Buffer.from(keys.join('\n') + '\n').toString('base64');
  const code = await execInContainer(
    container,
    containerName,
    `mkdir -p /root/.ssh && chmod 700 /root/.ssh && echo '${b64}' | base64 -d > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`,
    false
  );
  if (code !== 0) throw new Error(`could not write authorized_keys (exit ${code})`);
  console.log(`[DockerManager] ${keys.length} SSH key(s) installed in ${containerName}`);
}

/** Wait until systemd reports sshd and Docker active inside the machine. */
async function waitForBoot(container: Docker.Container, containerName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = await execInContainer(container, containerName, 'systemctl is-active --quiet ssh docker', false).catch(
      () => 1
    );
    if (code === 0) {
      console.log(`[DockerManager] ${containerName} booted (sshd and Docker active)`);
      return;
    }
    if (Date.now() >= deadline) {
      const state = await execOutput(container, 'systemctl --failed --no-legend; systemctl is-system-running').catch(
        () => ''
      );
      throw new Error(`machine did not boot within ${timeoutMs} ms${state ? `: ${state.trim().slice(-300)}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function startContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.start();
  console.log(`[DockerManager] Started container ${containerId.substring(0, 12)}`);
}

export async function stopContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop();
  console.log(`[DockerManager] Stopped container ${containerId.substring(0, 12)}`);
}

export async function restartContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.restart();
  console.log(`[DockerManager] Restarted container ${containerId.substring(0, 12)}`);
}

export async function removeContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  let instanceId: string | undefined;
  try {
    const info = await container.inspect();
    instanceId = info.Config.Labels?.['contabo-sim-instance-id'];
  } catch { /* ignore */ }
  try {
    await container.stop();
  } catch {
    // container might already be stopped
  }
  await container.remove({ force: true, v: true });
  console.log(`[DockerManager] Removed container ${containerId.substring(0, 12)}`);

  // Clean up DinD volume
  if (instanceId) {
    try {
      const vol = docker.getVolume(`contabo-sim-dind-${instanceId}`);
      await vol.remove();
      console.log(`[DockerManager] Removed DinD volume for instance ${instanceId}`);
    } catch { /* volume may not exist */ }
  }
}

export async function getContainerStatus(
  containerId: string
): Promise<{ status: string; sshPort: number }> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const isRunning = info.State.Running;
    const portBindings = info.NetworkSettings.Ports['22/tcp'];
    const sshPort = portBindings && portBindings[0]
      ? parseInt(portBindings[0].HostPort || '0')
      : 0;
    return {
      status: isRunning ? 'running' : 'stopped',
      sshPort: isRunning ? sshPort : 0,
    };
  } catch {
    return { status: 'error', sshPort: 0 };
  }
}

export async function buildImages(): Promise<void> {
  console.log('[DockerManager] Checking if SSH images exist...');
  const images = await docker.listImages();

  for (const [, mapping] of Object.entries(CONFIG.imageMapping)) {
    const [repo, tag] = mapping.dockerImage.split(':');
    const exists = images.some((img) =>
      img.RepoTags?.some((t) => t === mapping.dockerImage)
    );
    if (!exists) {
      console.log(
        `[DockerManager] Image ${mapping.dockerImage} not found. Please build it with: npm run build:docker`
      );
    } else {
      console.log(`[DockerManager] Image ${mapping.dockerImage} ✓`);
    }
  }
}

// ── Cloud-Init Helpers ──

interface CloudInitConfig {
  package_update?: boolean;
  packages?: string[];
  runcmd?: (string | string[])[];
}

/**
 * Execute a shell command inside a container and wait for it to finish.
 * Returns the exit code.
 */
async function execInContainer(
  container: Docker.Container,
  containerName: string,
  cmd: string,
  log = true,
): Promise<number> {
  if (log) console.log(`[CloudInit] ${containerName} $ ${cmd.substring(0, 120)}${cmd.length > 120 ? '...' : ''}`);
  const exec = await container.exec({
    Cmd: ['/bin/bash', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});

  return new Promise<number>((resolve) => {
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    stream.on('end', async () => {
      if (log && output.trim()) {
        // Log last 500 chars to avoid flooding
        const trimmed = output.trim().slice(-500);
        console.log(`[CloudInit] ${containerName} output: ${trimmed}`);
      }
      try {
        const inspect = await exec.inspect();
        resolve(inspect.ExitCode ?? 1);
      } catch {
        resolve(1);
      }
    });
    stream.on('error', () => resolve(1));
  });
}

async function execOutput(container: Docker.Container, cmd: string): Promise<string> {
  const exec = await container.exec({ Cmd: ['/bin/bash', '-c', cmd], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  return new Promise<string>((resolve) => {
    let out = '';
    stream.on('data', (c: Buffer) => (out += c.toString()));
    stream.on('end', () => resolve(out.replace(/[\x00-\x08]/g, '')));
    stream.on('error', () => resolve(out));
  });
}

/**
 * Parse and execute a #cloud-config YAML userData block.
 * Handles: package_update, packages, runcmd.
 */
async function executeCloudInit(
  container: Docker.Container,
  containerName: string,
  userData: string,
): Promise<void> {
  // Strip the #cloud-config header and parse YAML
  const yamlContent = userData.replace(/^#cloud-config\s*\n/, '');
  let cloudConfig: CloudInitConfig;
  try {
    cloudConfig = yaml.load(yamlContent) as CloudInitConfig;
  } catch (err: any) {
    console.error(`[CloudInit] Failed to parse cloud-config YAML in ${containerName}: ${err.message}`);
    return;
  }

  if (!cloudConfig) {
    console.warn(`[CloudInit] Empty cloud-config in ${containerName}`);
    return;
  }

  console.log(`[CloudInit] Processing cloud-config for ${containerName}`);

  // 1. package_update
  if (cloudConfig.package_update) {
    console.log(`[CloudInit] ${containerName}: Running apt-get update`);
    await execInContainer(container, containerName, 'apt-get update -qq');
  }

  // 2. packages
  if (cloudConfig.packages && cloudConfig.packages.length > 0) {
    const pkgs = cloudConfig.packages.join(' ');
    console.log(`[CloudInit] ${containerName}: Installing packages: ${pkgs}`);
    await execInContainer(
      container,
      containerName,
      `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgs}`,
    );
  }

  // 3. runcmd
  if (cloudConfig.runcmd && cloudConfig.runcmd.length > 0) {
    console.log(`[CloudInit] ${containerName}: Executing ${cloudConfig.runcmd.length} runcmd entries`);
    for (let i = 0; i < cloudConfig.runcmd.length; i++) {
      const entry = cloudConfig.runcmd[i];
      // cloud-init runcmd supports string or [cmd, arg1, ...]
      const cmd = Array.isArray(entry) ? entry.join(' ') : entry;
      if (!cmd || !cmd.trim()) continue;

      console.log(`[CloudInit] ${containerName}: runcmd[${i}]`);
      const exitCode = await execInContainer(container, containerName, cmd);
      if (exitCode !== 0) {
        console.warn(`[CloudInit] ${containerName}: runcmd[${i}] exited with code ${exitCode} (continuing)`);
      }
    }
  }

  console.log(`[CloudInit] Cloud-init completed for ${containerName}`);
}

/**
 * Execute a raw shell script (#!/bin/bash) as userData.
 */
async function executeRawScript(
  container: Docker.Container,
  containerName: string,
  userData: string,
): Promise<void> {
  const b64 = Buffer.from(userData).toString('base64');
  await execInContainer(
    container,
    containerName,
    `echo '${b64}' | base64 -d > /tmp/user-data.sh && chmod +x /tmp/user-data.sh && /bin/bash /tmp/user-data.sh`,
  );
  console.log(`[CloudInit] Raw script completed in ${containerName}`);
}

/** IDs of every container this simulator created (running or not). */
export async function listManagedContainers(): Promise<{ id: string; instanceId: number }[]> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${CONTAINER_LABEL_KEY}=${CONTAINER_LABEL_VALUE}`] },
  });
  return list.map((c) => ({ id: c.Id, instanceId: Number(c.Labels?.['contabo-sim-instance-id'] || 0) }));
}
