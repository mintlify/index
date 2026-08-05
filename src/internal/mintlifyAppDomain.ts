export const MINTLIFY_APP_SUFFIX = '.mintlify.app';

export function isMintlifyAppHost(host: string): boolean {
  return host.endsWith(MINTLIFY_APP_SUFFIX);
}
