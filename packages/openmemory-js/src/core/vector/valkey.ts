import { VectorStore, StoredEmbedding } from "../vector_store";
import { EmbeddingProvenance, validateVector, validateProvenance } from "../embedding_contract";
import Redis from "ioredis";
import { env } from "../cfg";
import { vectorToBuffer, bufferToVector } from "../../memory/embed";

export class ValkeyVectorStore implements VectorStore {
    private client: Redis;

    constructor(private scopedMemoryIds?: (user_id?: string, project?: string) => Promise<string[]>) {
        this.client = new Redis({
            host: env.valkey_host || "localhost",
            port: env.valkey_port || 6379,
            password: env.valkey_password,
        });
    }

    private getKey(id: string, sector: string): string {
        return `vec:${sector}:${id}`;
    }

    async storeVector(id: string, sector: string, vector: number[], dim: number, user_id?: string, provenance: EmbeddingProvenance | null = null): Promise<void> {
        validateVector(vector, dim);
        validateProvenance(provenance, sector, dim);
        const key = this.getKey(id, sector);
        const buf = vectorToBuffer(vector);

        await this.client.hset(key, {
            v: buf,
            dim: dim,
            user_id: user_id || "anonymous",
            id: id,
            sector: sector,
            provenance: JSON.stringify(provenance)
        });
    }

    async deleteVector(id: string, sector: string): Promise<void> {
        const key = this.getKey(id, sector);
        await this.client.del(key);
    }

    async deleteVectors(id: string): Promise<void> {















        let cursor = "0";
        do {
            const res = await this.client.scan(cursor, "MATCH", `vec:*:${id}`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) await this.client.del(...keys);
        } while (cursor !== "0");
    }

    async searchSimilar(sector: string, queryVec: number[], topK: number, user_id?: string, project?: string): Promise<Array<{ id: string; score: number }>> {
        validateVector(queryVec, queryVec.length);
        // Metadata is authoritative for scope. Rank its vectors before limiting;
        // a global KNN followed by filtering can discard every eligible memory.
        if ((user_id || project) && this.scopedMemoryIds) {
            const ids = await this.scopedMemoryIds(user_id, project);
            const results: Array<{ id: string; score: number }> = [];
            for (let offset = 0; offset < ids.length; offset += 100) {
                const batch = ids.slice(offset, offset + 100);
                const pipeline = this.client.pipeline();
                for (const id of batch) pipeline.hgetBuffer(this.getKey(id, sector), "v");
                const rows = await pipeline.exec();
                rows?.forEach(([error, value], index) => {
                    if (error) throw error;
                    if (value) {
                        const vector = bufferToVector(value as Buffer);
                        if (vector.length === queryVec.length) results.push({ id: batch[index], score: this.cosineSimilarity(queryVec, vector) });
                    }
                });
            }
            results.sort((a, b) => b.score - a.score);
            return results.slice(0, topK);
        }
        if (project) throw new Error("Project search requires a metadata scope resolver");
        // Valkey/Redis doesn't support user_id filtering in FT.SEARCH easily
        // For now we'll need to post-filter or use a more complex query
        const indexName = `idx:${sector}`;
        const blob = vectorToBuffer(queryVec);

        try {
            // Use FT.SEARCH with vector similarity
            const res = await this.client.call(
                "FT.SEARCH",
                indexName,
                `*=>[KNN ${topK * 2} @v $blob AS score]`,  // fetch more to allow filtering
                "PARAMS",
                "2",
                "blob",
                blob,
                "DIALECT",
                "2"
            ) as any[];

            // Parse results and filter by user_id if provided
            const results: Array<{ id: string; score: number }> = [];
            for (let i = 1; i < res.length; i += 2) {
                const key = res[i] as string;
                const fields = res[i + 1] as any[];
                let id = "";
                let dist = 0;
                let vec_user_id = "";

                for (let j = 0; j < fields.length; j += 2) {
                    if (fields[j] === "id") id = fields[j + 1];
                    if (fields[j] === "score") dist = parseFloat(fields[j + 1]);
                    if (fields[j] === "user_id") vec_user_id = fields[j + 1];
                }
                if (!id) id = key.split(":").pop()!;

                // Filter by user_id if provided
                if (!user_id || vec_user_id === user_id) {
                    results.push({ id, score: 1 - dist });
                    if (results.length >= topK) break;
                }
            }

            return results;

        } catch (e) {
            console.warn(`[Valkey] FT.SEARCH failed for ${sector}, falling back to scan (slow):`, e);

            // Fallback: scan all vectors and filter
            let cursor = "0";
            const allVecs = new Map<string, { id: string; vector: number[]; user_id: string }>();
            do {
                const res = await this.client.scan(cursor, "MATCH", `vec:${sector}:*`, "COUNT", 100);
                cursor = res[0];
                const keys = res[1];
                if (keys.length) {
                    const pipe = this.client.pipeline();
                    keys.forEach(k => pipe.hmgetBuffer(k, "v", "user_id"));
                    const buffers = await pipe.exec();
                    buffers?.forEach((b, idx) => {
                        if (b && b[1]) {
                            const [buf, owner] = b[1] as [Buffer | null, Buffer | null];
                            if (!buf) return;
                            const vec_user_id = owner?.toString() || "";
                            const id = keys[idx].split(":").pop()!;

                            // Filter by user_id during scan
                            if (!user_id || vec_user_id === user_id) {
                                allVecs.set(id, { id, vector: bufferToVector(buf), user_id: vec_user_id });
                            }
                        }
                    });
                }
            } while (cursor !== "0");

            const sims = Array.from(allVecs.values()).filter(v => v.vector.length === queryVec.length).map(v => ({
                id: v.id,
                score: this.cosineSimilarity(queryVec, v.vector)
            }));
            sims.sort((a, b) => b.score - a.score);
            return sims.slice(0, topK);
        }
    }

    private cosineSimilarity(a: number[], b: number[]) {
        if (a.length !== b.length) return 0;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    }

    async getVector(id: string, sector: string): Promise<StoredEmbedding | null> {
        const key = this.getKey(id, sector);
        const res = await this.client.hmgetBuffer(key, "v", "dim", "provenance");
        if (!res[0]) return null;
        return {
            vector: bufferToVector(res[0]),
            dim: Number(res[1]?.toString()),
            provenance: res[2] ? JSON.parse(res[2].toString()) : null
        };
    }

    async getVectorsById(id: string): Promise<Array<StoredEmbedding & { sector: string }>> {

        const results = new Map<string, StoredEmbedding & { sector: string }>();
        let cursor = "0";
        do {
            const res = await this.client.scan(cursor, "MATCH", `vec:*:${id}`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                const pipe = this.client.pipeline();
                keys.forEach(k => pipe.hmgetBuffer(k, "v", "dim", "provenance"));
                const res = await pipe.exec();
                res?.forEach((r, idx) => {
                    if (r && r[1]) {
                        const [v, dim, provenance] = r[1] as [Buffer, Buffer, Buffer | null];
                        if (!v || !dim) return;
                        const key = keys[idx];
                        const parts = key.split(":");
                        const sector = parts[1];
                        results.set(sector, {
                            sector,
                            vector: bufferToVector(v),
                            dim: Number(dim.toString()),
                            provenance: provenance ? JSON.parse(provenance.toString()) : null
                        });
                    }
                });
            }
        } while (cursor !== "0");
        return Array.from(results.values());
    }

    async getVectorsBySector(sector: string): Promise<Array<StoredEmbedding & { id: string }>> {
        const results = new Map<string, StoredEmbedding & { id: string }>();
        let cursor = "0";
        do {
            const res = await this.client.scan(cursor, "MATCH", `vec:${sector}:*`, "COUNT", 100);
            cursor = res[0];
            const keys = res[1];
            if (keys.length) {
                const pipe = this.client.pipeline();
                keys.forEach(k => pipe.hmgetBuffer(k, "v", "dim", "provenance"));
                const res = await pipe.exec();
                res?.forEach((r, idx) => {
                    if (r && r[1]) {
                        const [v, dim, provenance] = r[1] as [Buffer, Buffer, Buffer | null];
                        if (!v || !dim) return;
                        const key = keys[idx];
                        const id = key.split(":").pop()!;
                        results.set(id, {
                            id,
                            vector: bufferToVector(v),
                            dim: Number(dim.toString()),
                            provenance: provenance ? JSON.parse(provenance.toString()) : null
                        });
                    }
                });
            }
        } while (cursor !== "0");
        return Array.from(results.values());
    }
}
