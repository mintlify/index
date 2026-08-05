// In production this is backed by MongoDB collections tracking which sites
// have been synced into which Chroma collection ("manifest") of the corpus.

export type UniversalSearchSiteStatus = 'pending' | 'synced' | 'skipped' | 'removed' | 'failed';

export type UniversalSearchSiteEntry = {
  status: UniversalSearchSiteStatus;
  attempts: number;
  lastSyncedDeploymentHistoryId?: string;
  deploymentId?: string;
  orgId?: string;
  domains?: string[];
  chunkCount?: number;
  lastSyncedAt?: Date;
  skipReason?: string;
};

export type UniversalSearchManifestStatus = 'pending' | 'active' | 'retired';

export type UniversalSearchManifestType = {
  _id: string;
  collectionName: string;
  collectionId?: string;
  scope?: string[];
  status: UniversalSearchManifestStatus;
  createdAt: Date;
  activatedAt?: Date;
  retiredAt?: Date;
};

export type LeanUniversalSearchManifest = UniversalSearchManifestType;

export type UniversalSearchSiteType = UniversalSearchSiteEntry & {
  _id: string;
  collectionName: string;
  subdomain: string;
};

export interface UniversalSearchManifestRepository {
  getActiveManifest(): Promise<LeanUniversalSearchManifest | null>;

  getSyncedSiteSubdomains(collectionName: string, subdomains: string[]): Promise<string[]>;

  getSubdomainsByDomains(collectionName: string, domains: string[]): Promise<string[]>;

  getSyncedSiteHosts(collectionName: string): Promise<{ subdomain: string; domains?: string[] }[]>;
}
