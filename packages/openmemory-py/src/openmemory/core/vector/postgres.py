
from typing import List, Optional, Dict, Any
import json
import logging
import asyncio
from ..types import MemRow
from ..vector_store import VectorStore, VectorRow
from ..embedding_contract import validate_vector, validate_provenance

logger = logging.getLogger("vector_store.postgres")

class PostgresVectorStore(VectorStore):
    def __init__(self, dsn: str, table_name: str = "vectors"):
        self.dsn = dsn
        self.table = table_name
        self.pool = None
        self._pool_lock = asyncio.Lock()

    async def _get_pool(self):
        import asyncpg
        async with self._pool_lock:
            if self.pool:
                return self.pool
            pool = await asyncpg.create_pool(self.dsn)
            try:
                async with pool.acquire() as conn, conn.transaction():
                    await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", f"openmemory-python-vectors:{self.table}")
                    await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
                    await conn.execute(f"""
                        CREATE TABLE IF NOT EXISTS {self.table} (
                            id TEXT NOT NULL,
                            sector TEXT NOT NULL,
                            user_id TEXT,
                            v vector,
                            dim INTEGER,
                            created_at TIMESTAMPTZ DEFAULT NOW(),
                            PRIMARY KEY(id, sector)
                        )
                    """)
                    primary = await conn.fetchrow("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p'", self.table)
                    if primary and primary["definition"] == "PRIMARY KEY (id)":
                        name = primary["conname"].replace('"', '""')
                        await conn.execute(f'ALTER TABLE {self.table} DROP CONSTRAINT "{name}", ADD PRIMARY KEY(id,sector)')
                    elif not primary or primary["definition"] != "PRIMARY KEY (id, sector)":
                        raise ValueError("Unsupported vector primary key; review migration before upgrading")
                    await conn.execute(f"ALTER TABLE {self.table} ADD COLUMN IF NOT EXISTS provenance TEXT")
                    # Unbounded vector columns cannot have an unqualified HNSW index.
                    # Preserve any operator-managed indexes and use exact search.
            except BaseException:
                await pool.close()
                raise
            self.pool = pool
        return self.pool

    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None, provenance: Optional[Dict[str, Any]] = None):
        validate_vector(vector, dim)
        validate_provenance(provenance, sector, dim)
        pool = await self._get_pool()
        vec_str = str(vector)

        sql = f"""
            INSERT INTO {self.table} (id, sector, user_id, v, dim, provenance)
            VALUES ($1, $2, $3, $4::vector, $5, $6)
            ON CONFLICT (id,sector) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                v = EXCLUDED.v,
                dim = EXCLUDED.dim,
                provenance = EXCLUDED.provenance
        """
        async with pool.acquire() as conn:
            await conn.execute(sql, id, sector, user_id, vec_str, dim, json.dumps(provenance) if provenance is not None else None)

    async def getVectorsById(self, id: str) -> List[VectorRow]:
        pool = await self._get_pool()
        sql = f"SELECT id, sector, v::text as v_txt, dim, provenance FROM {self.table} WHERE id=$1"
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, id)

        res = []
        for r in rows:
            vec = json.loads(r["v_txt"])
            res.append(VectorRow(r["id"], r["sector"], vec, r["dim"], json.loads(r["provenance"]) if r["provenance"] else None))
        return res

    async def getVector(self, id: str, sector: str) -> Optional[VectorRow]:
        pool = await self._get_pool()
        sql = f"SELECT id, sector, v::text as v_txt, dim, provenance FROM {self.table} WHERE id=$1 AND sector=$2"
        async with pool.acquire() as conn:
            r = await conn.fetchrow(sql, id, sector)

        if not r: return None
        vec = json.loads(r["v_txt"])
        return VectorRow(r["id"], r["sector"], vec, r["dim"], json.loads(r["provenance"]) if r["provenance"] else None)

    async def deleteVectors(self, id: str):
        pool = await self._get_pool()
        async with pool.acquire() as conn:
            await conn.execute(f"DELETE FROM {self.table} WHERE id=$1", id)

    async def search(self, vector: List[float], sector: str, k: int, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        validate_vector(vector, len(vector))
        pool = await self._get_pool()
        vec_str = str(vector)

        filter_sql = " AND sector=$2 AND vector_dims(v)=vector_dims($1::vector)"
        args = [vec_str, sector]
        arg_idx = 3

        if filter and filter.get("user_id"):
            filter_sql += f" AND user_id=${arg_idx}"
            args.append(filter["user_id"])
            arg_idx += 1
        sql = f"""
            SELECT id, 1 - (v <=> $1::vector) as similarity
            FROM {self.table}
            WHERE 1=1 {filter_sql}
            ORDER BY v <=> $1::vector
            LIMIT {k}
        """

        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *args)

        return [{"id": r["id"], "similarity": float(r["similarity"])} for r in rows]
