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
    jurisdictions: Jurisdiction[];
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
  sdkDefaults?: SdkDefault[];
  regions?: VendorRegion[];
}

export interface Jurisdiction {
  country: string;
  role: string;
  note?: string;
  /**
   * True when a customer's region setting selects this jurisdiction.
   *
   * Absent means false, so narrowing never removes a jurisdiction by default.
   * A contracting entity is not region selected: a project hosted in Frankfurt
   * is still contracted with the entity named in the processing addendum, and
   * dropping it because a region was detected would report a clean scan on a
   * transfer that is really happening.
   */
  regionSelected?: boolean;
}

/** Privacy-relevant behaviour an SDK applies when the option is not set. */
export interface SdkDefault {
  package?: string;
  option: string;
  defaultValue: string | boolean | number | null;
  effect: string;
  appliesFrom?: string;
  sourceUrl: string;
  lastChecked: string;
}

/**
 * A region identifier the vendor accepts, and the country it places processing in.
 *
 * Never inferred from the identifier. `eu-west-2` is London and `eu-central-2`
 * is Zurich; neither is in the EEA, and a prefix rule would place both there
 * with high confidence.
 */
export interface VendorRegion {
  code: string;
  country: string;
  label?: string;
  note?: string;
  sourceUrl: string;
  lastChecked: string;
}

export interface PackageAlias {
  /**
   * An exact package name, or a registry namespace written with a trailing
   * `/*` -- `@sentry/*`. An exact alias always wins over a namespace one.
   */
  name: string;
  /**
   * `scope` belongs to a `/*` namespace alias and says only that the namespace
   * is the vendor's, which is registry-enforced. It is not `official-sdk` on
   * purpose: a namespace also carries build plugins, type packages and test
   * helpers, and `official-sdk` is what lifts a direct dependency to high
   * confidence.
   */
  kind: 'official-sdk' | 'wrapper' | 'plugin' | 'framework-integration' | 'scope';
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
  /**
   * Option carrying a region identifier rather than a host.
   *
   * `new S3Client({ region: 'eu-west-1' })` names a jurisdiction without naming
   * a host, which `hostOption` cannot express: the value is a bare token, not a
   * URL. Resolved against the vendor's `regions` map, never from the prefix.
   */
  regionOption?: string;
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
