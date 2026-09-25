import { InstanceRecord, ContaboInstance, InstanceStatus, ContaboSecret } from './types';
import { CONFIG } from './config';
import { generateMacAddress } from './response-builder';

let nextSecretId = 1;
let nextVHostId = 73000;

// In-memory stores
const instances = new Map<number, InstanceRecord>();
const secrets = new Map<number, ContaboSecret>();

/** Generate a random 6-digit instance ID that doesn't collide with existing ones */
function generateInstanceId(): number {
  let id: number;
  do {
    id = 100000 + Math.floor(Math.random() * 900000); // 100000–999999
  } while (instances.has(id));
  return id;
}

// ─── Instance Operations ───

export function createInstance(params: {
  imageId: string;
  productId: string;
  region: string;
  displayName: string;
  defaultUser: string;
  sshKeys: number[];
  containerId?: string;
  sshPort?: number;
  containerIp?: string;
  rootPassword: string;
  osType: string;
  scenario?: string;
  status?: InstanceStatus;
}): InstanceRecord {
  const instanceId = generateInstanceId();
  const vHostId = nextVHostId++;

  const product = CONFIG.productMapping[params.productId] || CONFIG.productMapping['V45'];

  const instance: ContaboInstance = {
    tenantId: CONFIG.tenantId,
    customerId: CONFIG.customerId,
    additionalIps: [],
    name: `vmd${instanceId}`,
    displayName: params.displayName || `VPS ${instanceId}`,
    instanceId,
    dataCenter: params.region === 'US' ? 'United States 1' : 'European Union 1',
    region: params.region || 'EU',
    regionName: params.region === 'US' ? 'United States' : 'European Union',
    productId: params.productId || 'V45',
    imageId: params.imageId,
    ipConfig: {
      v4: {
        ip: '',
        netmaskCidr: 32,
        gateway: '',
      },
      v6: {
        ip: '',
        netmaskCidr: 128,
        gateway: '',
      },
    },
    macAddress: generateMacAddress(),
    ramMb: product.ramMb,
    cpuCores: product.cpuCores,
    osType: params.osType,
    diskMb: product.diskMb,
    sshKeys: params.sshKeys || [],
    createdDate: new Date().toISOString(),
    cancelDate: '',
    status: params.status ?? ('running' as InstanceStatus),
    vHostId,
    vHostNumber: vHostId,
    vHostName: `m${vHostId}`,
    addOns: [],
    errorMessage: null,
    productType: 'ssd',
    productName: product.name,
    defaultUser: params.defaultUser || 'root',
    sshPort: params.sshPort,
  };

  const record: InstanceRecord = {
    instance,
    containerId: params.containerId ?? '',
    rootPassword: params.rootPassword,
    scenario: params.scenario ?? 'normal',
    phase: params.status && params.status !== 'running' ? 'provisioning' : 'ready',
    cancelled: false,
  };

  if (params.containerIp) setAddress(record, params.containerIp);
  instances.set(instanceId, record);
  return record;
}

/** Report an IPv4 address for the instance (empty until the machine exists). */
export function setAddress(record: InstanceRecord, ip: string): void {
  record.instance.ipConfig.v4 = { ip, netmaskCidr: 32, gateway: ip ? gatewayFor(ip) : '' };
}

function gatewayFor(ip: string): string {
  const parts = ip.split('.');
  if (parts.length !== 4) return '';
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

export function getInstance(instanceId: number): InstanceRecord | undefined {
  return instances.get(instanceId);
}

export function getAllInstances(): InstanceRecord[] {
  return Array.from(instances.values());
}

export function updateInstance(
  instanceId: number,
  updates: Partial<ContaboInstance>
): InstanceRecord | undefined {
  const record = instances.get(instanceId);
  if (!record) return undefined;
  Object.assign(record.instance, updates);
  return record;
}

export function updateInstanceStatus(
  instanceId: number,
  status: InstanceStatus,
  sshPort?: number
): void {
  const record = instances.get(instanceId);
  if (record) {
    record.instance.status = status;
    if (sshPort !== undefined) {
      record.instance.sshPort = sshPort;
    }
  }
}

export function deleteInstance(instanceId: number): InstanceRecord | undefined {
  const record = instances.get(instanceId);
  if (record) {
    instances.delete(instanceId);
  }
  return record;
}

/** Drop every instance record (control API reset and tests). */
export function clearInstances(): void {
  instances.clear();
}

// ─── Secret Operations ───

export function createSecret(params: {
  name: string;
  type: 'ssh' | 'password';
  value: string;
}): ContaboSecret {
  const secretId = nextSecretId++;
  const secret: ContaboSecret = {
    secretId,
    tenantId: CONFIG.tenantId,
    customerId: CONFIG.customerId,
    name: params.name,
    type: params.type,
    value: params.value,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  secrets.set(secretId, secret);
  return secret;
}

export function getSecret(secretId: number): ContaboSecret | undefined {
  return secrets.get(secretId);
}

export function getAllSecrets(): ContaboSecret[] {
  return Array.from(secrets.values());
}
