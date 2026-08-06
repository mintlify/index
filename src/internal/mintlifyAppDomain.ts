export const MINTLIFY_APP_SUFFIX = '.mintlify.site';

export function isMintlifyAppHost(host: string): boolean {
  return host.endsWith(MINTLIFY_APP_SUFFIX);
}
