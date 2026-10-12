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

/**
 * Vectors are only comparable within one embedding space: same provider,
 * model, transform and dimension. A chunk average lives in its source's space.
 */
export function embeddingSpace(p: EmbeddingProvenance): string {
    if (p.provider === "composite" && p.model === "chunk-mean" && p.sources?.length === 1)
        return embeddingSpace(p.sources[0]);
    const inner = p.sources?.length ? `[${p.sources.map(embeddingSpace).join(",")}]` : "";
    return `${p.provider}/${p.model}/${p.transform}/${p.dimensions}${inner}`;
}

/** Unknown (legacy) provenance stays comparable; known provenance must match. */
export function inSpace(provenance: EmbeddingProvenance | null | undefined, space?: string): boolean {
    return !space || !provenance || embeddingSpace(provenance) === space;
}
