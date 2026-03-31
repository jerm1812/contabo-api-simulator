import Docker from 'dockerode';
import yaml from 'js-yaml';
import { CONFIG } from './config';

const docker = new Docker();

const CONTAINER_LABEL_KEY = 'managed-by';
const CONTAINER_LABEL_VALUE = CONFIG.containerLabel;
const NETWORK_NAME = CONFIG.dockerNetwork;

async function ensureNetwork(): Promise<void> {
  try {
    const network = docker.getNetwork(NETWORK_NAME);
    await network.inspect();
  } catch {
    await docker.createNetwork({
      Name: NETWORK_NAME,
      Driver: 'bridge',
      Labels: { [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE },
    });
    console.log(`[DockerManager] Created network: ${NETWORK_NAME}`);
  }
}

export interface ContainerCreateResult {
  containerId: string;
  sshPort: number;
  containerIp: string;
}

export async function createContainer(
  dockerImage: string,
  rootPassword: string,
  instanceId: number,
  displayName: string,
  userData?: string,
  sshPublicKeys?: string[]
): Promise<ContainerCreateResult> {
  await ensureNetwork();

  const containerName = `contabo-sim-${instanceId}`;

  const container = await docker.createContainer({
    Image: dockerImage,
    name: containerName,
    Labels: {
      [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE,
      'contabo-sim-instance-id': String(instanceId),
      'contabo-sim-display-name': displayName,
    },
    ExposedPorts: { '22/tcp': {}, '8080/tcp': {} },
    HostConfig: {
      PortBindings: {
        '22/tcp': [{ HostPort: '0' }], // dynamic port assignment
        '8080/tcp': [{ HostPort: '0' }], // side-agent HTTP port
      },
      Privileged: true,  // required for Docker-in-Docker (dockerd inside container)
      NetworkMode: NETWORK_NAME,
      Binds: [
        `contabo-sim-dind-${instanceId}:/var/lib/docker`, // Named volume gives overlay2 a real ext4 FS
      ],
    },
    Cmd: [
      '/bin/bash',
      '-c',
      `echo "root:${rootPassword}" | chpasswd && /usr/local/bin/entrypoint.sh`,
    ],
  });

  await container.start();

  // Get assigned port
  const info = await container.inspect();
  const portBindings = info.NetworkSettings.Ports['22/tcp'];
  const sshPort = portBindings && portBindings[0]
    ? parseInt(portBindings[0].HostPort || '0')
    : 0;

  // Get container IP on our network
  const networkInfo = info.NetworkSettings.Networks[NETWORK_NAME];
  const containerIp = networkInfo ? networkInfo.IPAddress : '127.0.0.1';

  // Fire-and-forget: inject SSH keys (don't block response)
  if (sshPublicKeys && sshPublicKeys.length > 0) {
    (async () => {
      try {
        console.log(`[DockerManager] Injecting ${sshPublicKeys.length} SSH key(s) into container ${containerName}`);
        const authorizedKeys = sshPublicKeys.join('\n');
        const b64Keys = Buffer.from(authorizedKeys).toString('base64');
        const sshExec = await container.exec({
          Cmd: [
            '/bin/bash',
            '-c',
            `mkdir -p /root/.ssh && chmod 700 /root/.ssh && echo '${b64Keys}' | base64 -d > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`,
          ],
          AttachStdout: true,
          AttachStderr: true,
        });
        const sshStream = await sshExec.start({});
        await new Promise<void>((resolve, reject) => {
          sshStream.on('data', () => {});
          sshStream.on('end', resolve);
          sshStream.on('error', reject);
        });
        console.log(`[DockerManager] SSH keys injected in container ${containerName}`);
      } catch (err: any) {
        console.error(`[DockerManager] Failed to inject SSH keys in ${containerName}: ${err.message}`);
      }
    })();
  }

  // Fire-and-forget: execute userData (cloud-init or raw script)
  if (userData && userData.trim()) {
    (async () => {
      try {
        if (userData.trimStart().startsWith('#cloud-config')) {
          console.log(`[DockerManager] Executing cloud-init config in container ${containerName} (background)`);
          await executeCloudInit(container, containerName, userData);
        } else {
          console.log(`[DockerManager] Executing raw script in container ${containerName} (background)`);
          await executeRawScript(container, containerName, userData);
        }
      } catch (err: any) {
        console.error(`[DockerManager] Failed to execute userData in ${containerName}: ${err.message}`);
      }
    })();
  }

  console.log(
    `[DockerManager] Created container ${containerName} (ID: ${container.id.substring(0, 12)}) SSH port: ${sshPort}`
  );

  return {
    containerId: container.id,
    sshPort,
    containerIp,
  };
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
  await container.remove({ force: true });
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
): Promise<number> {
  console.log(`[CloudInit] ${containerName} $ ${cmd.substring(0, 120)}${cmd.length > 120 ? '...' : ''}`);
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
      if (output.trim()) {
        // Log last 500 chars to avoid flooding
        const trimmed = output.trim().slice(-500);
        console.log(`[CloudInit] ${containerName} output: ${trimmed}`);
      }
      try {
        const inspect = await exec.inspect();
        resolve(inspect.ExitCode ?? 0);
      } catch {
        resolve(0);
      }
    });
    stream.on('error', () => resolve(1));
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
