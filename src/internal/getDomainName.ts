const KNOWN_CCTLDS = new Set([
  'co.uk',
  'co.jp',
  'co.kr',
  'com.au',
  'com.br',
  'co.in',
  'co.nz',
  'org.uk',
  'net.au',
]);

export function getDomainName(hostname: string): string {
  const hostParts = hostname.split('.');
  if (hostParts.length <= 2) {
    return hostParts[0] ?? hostname;
  }

  const lastTwo = hostParts.slice(-2).join('.');
  if (KNOWN_CCTLDS.has(lastTwo) && hostParts.length > 3) {
    return hostParts.slice(-3, -2)[0] ?? hostname;
  } else if (KNOWN_CCTLDS.has(lastTwo)) {
    return hostParts[0] ?? hostname;
  }

  return hostParts.slice(-2, -1)[0] ?? hostname;
}
