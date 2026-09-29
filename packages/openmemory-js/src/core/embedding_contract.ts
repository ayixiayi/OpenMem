/** Provenance is observed generation metadata, not a claim about immutable model weights. */
export interface EmbeddingProvenance {
    schema_version: 1;
    provider: string;
    model: string;
    sector: string;
    dimensions: number;
    transform: string;
    sources?: EmbeddingProvenance[];
}

export interface GeneratedEmbedding {
    vector: number[];
    provenance: EmbeddingProvenance;
}

export function validateVector(vector: number[], dim: number): void {
    if (
        !Array.isArray(vector) ||
        !Number.isInteger(dim) ||
        dim <= 0 ||
        vector.length !== dim ||
        Array.from(vector).some(
            (value) =>
                typeof value !== "number" ||
                !Number.isFinite(Math.fround(value)),
        )
    ) {
        throw new Error(
            "Embedding must be a nonempty finite vector matching its dimension",
        );
    }
}

export function validateProvenance(
    provenance: EmbeddingProvenance | null,
    sector: string,
    dim: number,
): void {
    if (
        provenance &&
        (provenance.schema_version !== 1 ||
            provenance.sector !== sector ||
            provenance.dimensions !== dim)
    ) {
        throw new Error(
            "Embedding provenance does not match vector sector/dimension",
        );
    }
}
