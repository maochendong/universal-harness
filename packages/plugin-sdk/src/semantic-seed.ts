/** Versioned, write-incapable semantic seed provider contract (M2-C). */
export interface SemanticDocumentInput {
  readonly node_id: string;
  readonly node_type: string;
  readonly revision: number;
  readonly locator?: string;
  readonly source_digest: string;
  readonly blob_digest?: string;
  /** Repository-controlled text. Providers must treat it as untrusted data. */
  readonly content: string;
}

export interface SemanticIndexInput {
  readonly protocol_version: 1;
  readonly project_id: string;
  readonly git_commit: string;
  readonly graph_source_digest: string;
  readonly extractor_version: string;
  readonly config_digest: string;
  readonly documents: readonly SemanticDocumentInput[];
}

export interface SemanticIndexDescriptor {
  readonly provider: string;
  readonly provider_version: string;
  readonly input_digest: string;
  readonly index_digest: string;
  readonly entry_count: number;
  /** Provider-owned cache locator; never a Ledger artifact locator. */
  readonly cache_path: string;
}

export interface SemanticScore {
  readonly numerator: number;
  readonly denominator: number;
  readonly millionths: number;
}

export interface SemanticFeatureExplanation {
  readonly kind: "symbol" | "import" | "path" | "term";
  readonly token: string;
  readonly weight: number;
}

export interface SemanticSeedSuggestion {
  readonly source_node_id: string;
  readonly source_revision: number;
  readonly candidate_node_id: string;
  readonly candidate_revision: number;
  readonly score: SemanticScore;
  readonly features: readonly SemanticFeatureExplanation[];
  readonly reason: string;
  readonly provider: string;
  readonly provider_version: string;
  readonly input_digest: string;
  readonly index_digest: string;
}

export interface SemanticSeedRequest {
  readonly descriptor: SemanticIndexDescriptor;
  readonly source_node_ids: readonly string[];
  /** Integer in 1..990000. */
  readonly threshold_millionths: number;
  /** Integer in 1..100. */
  readonly top_k: number;
}

export interface SemanticSeedProvider {
  readonly name: string;
  readonly version: string;
  buildIndex(input: SemanticIndexInput): Promise<SemanticIndexDescriptor>;
  suggest(input: SemanticSeedRequest): Promise<readonly SemanticSeedSuggestion[]>;
}
