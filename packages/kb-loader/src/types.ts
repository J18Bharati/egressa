/** Shape of a kb/vendors/<id>.json entry. Mirrors kb/schema/vendor-1.0.0.json. */
export interface VendorEntry {
  schemaVersion: string;
  id: string;
  name: string;
  product?: string;
  category: string;
  homepage: string;
  aliases: {
    packages: Partial<Record<'npm' | 'pypi', PackageAlias[]>>;
    hosts: HostAlias[];
    clientConstructors?: ClientConstructor[];
  };
  processing: {
    jurisdictions: { country: string; role: string; note?: string }[];
    euRegion: {
      available: boolean;
      scope?: 'full' | 'partial' | 'product-specific';
      docUrl?: string;
      notes?: string;
    };
  };
  legal: {
    dpa: { available: boolean; url?: string; type?: string; lastChecked?: string };
    subprocessors?: { url: string; listType?: string; notifications?: string };
    transferMechanisms: {
      mechanism: string;
      dpfCertified?: boolean;
      url?: string;
      lastChecked?: string;
    }[];
  };
  dataCategories: { category: string; typical: boolean; note?: string }[];
  sources: { url: string; title: string; publisher: string; accessedAt: string }[];
  lastVerified: string;
  verifiedBy?: string;
  disputed?: { issueUrl: string; raisedAt: string; summary: string } | null;
  notes?: string;
}

export interface PackageAlias {
  name: string;
  kind: 'official-sdk' | 'wrapper' | 'plugin' | 'framework-integration';
  detectTransitive?: boolean;
}

export interface HostAlias {
  pattern: string;
  match: 'exact' | 'suffix';
  purpose: string;
  note?: string;
}

export interface ClientConstructor {
  module: string;
  export?: string;
  hostOption?: string | null;
}

export interface AdequacyDecision {
  country: string;
  mechanism: 'adequacy' | 'DPF';
  status: 'in-force' | 'partial' | 'withdrawn' | 'under-challenge';
  effectiveFrom?: string;
  scope?: string;
  sourceUrl: string;
  notes?: string;
}

export interface AdequacyStatus {
  schemaVersion: string;
  asOf: string;
  sources: { url: string; title: string; publisher: string; accessedAt: string }[];
  decisions: AdequacyDecision[];
}

export interface PackageMatch {
  vendor: VendorEntry;
  alias: PackageAlias;
}

export interface HostMatch {
  vendor: VendorEntry;
  alias: HostAlias;
}
