export type OpenCodeModelStatus = 'alpha' | 'beta' | 'deprecated' | 'active';

export interface OpenCodeModelPair {
  providerId: string;
  modelId: string;
}

export interface OpenCodeCatalogModel {
  id: string;
  name: string;
  status: OpenCodeModelStatus;
  sizeBytes?: number;
  contextTokens?: number;
  tools?: boolean;
  thinking?: boolean;
  vision?: boolean;
}

export type OpenCodeCatalogProviderAvailability =
  | 'available'
  | 'not-configured'
  | 'unavailable'
  | 'discovery-failed';

export interface OpenCodeCatalogProvider {
  id: string;
  name: string;
  /** True when this configured or credentialless provider may be offered for selection. */
  availableForSelection: boolean;
  /**
   * Secret-safe result for this provider's independent availability probe.
   * Older clients may omit it and continue to use availableForSelection.
   */
  availabilityStatus?: OpenCodeCatalogProviderAvailability;
  /** Bounded public diagnostic; never contains provider credentials or endpoint URLs. */
  availabilityMessage?: string;
  suggestedModel?: string;
  models: OpenCodeCatalogModel[];
}

/** Secret-safe, versioned choices returned without starting an OpenCode server. */
export interface OpenCodeModelCatalog {
  runtimeVersion: string;
  suggestedSelection?: OpenCodeModelPair;
  providers: OpenCodeCatalogProvider[];
}
