import yaml from 'js-yaml';

/**
 * Public keys listed under ssh_authorized_keys in a #cloud-config userData
 * block. Real Contabo runs cloud-init, which installs these for the default
 * user; the simulator injects them into root's authorized_keys instead.
 */
export function cloudConfigSSHKeys(userData: string | undefined): string[] {
  if (!userData || !userData.trimStart().startsWith('#cloud-config')) return [];
  let doc: unknown;
  try {
    doc = yaml.load(userData.replace(/^\s*#cloud-config\s*\n/, ''));
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const keys = (doc as Record<string, unknown>).ssh_authorized_keys;
  if (!Array.isArray(keys)) return [];
  return keys
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
