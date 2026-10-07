import type { EmbeddingProvenance } from "./embedding_contract";

export interface StoredEmbedding {
    vector: number[];
    dim: number;
    provenance?: EmbeddingProvenance | null;
}

export interface VectorStore {
    storeVector(id: string, sector: string, vector: number[], dim: number, user_id?: string, provenance?: EmbeddingProvenance | null): Promise<void>;
    deleteVector(id: string, sector: string): Promise<void>;
    deleteVectors(id: string): Promise<void>;
    searchSimilar(sector: string, queryVec: number[], topK: number, user_id?: string, project?: string): Promise<Array<{ id: string; score: number }>>;
    getVector(id: string, sector: string): Promise<StoredEmbedding | null>;
    getVectorsById(id: string): Promise<Array<StoredEmbedding & { sector: string }>>;
    getVectorsBySector(sector: string): Promise<Array<StoredEmbedding & { id: string }>>;
}
