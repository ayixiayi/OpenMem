from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any, Union
import json
import sqlite3
import struct
from .db import db, DB
from .types import MemRow
from .embedding_contract import validate_vector, validate_provenance
import logging

logger = logging.getLogger("vector_store")

class VectorRow:
    def __init__(self, id: str, sector: str, vector: List[float], dim: int, provenance: Optional[Dict[str, Any]] = None):
        self.id = id
        self.sector = sector
        self.vector = vector
        self.dim = dim
        self.provenance = provenance

class VectorStore(ABC):
    @abstractmethod
    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None, provenance: Optional[Dict[str, Any]] = None): pass

    @abstractmethod
    async def getVectorsById(self, id: str) -> List[VectorRow]: pass

    @abstractmethod
    async def getVector(self, id: str, sector: str) -> Optional[VectorRow]: pass

    @abstractmethod
    async def deleteVectors(self, id: str): pass

    @abstractmethod
    async def search(self, vector: List[float], sector: str, k: int, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]: pass

class SQLiteVectorStore(VectorStore):
    def __init__(self, table_name: str = "vectors"):
        self.table = table_name

    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None, provenance: Optional[Dict[str, Any]] = None):
        validate_vector(vector, dim)
        validate_provenance(provenance, sector, dim)
        blob = struct.pack(f"{len(vector)}f", *vector)
        sql = f"INSERT OR REPLACE INTO {self.table}(id, sector, user_id, v, dim, provenance) VALUES (?, ?, ?, ?, ?, ?)"
        db.conn.execute(sql, (id, sector, user_id, blob, dim, json.dumps(provenance) if provenance is not None else None))
        db.commit()

    async def getVectorsById(self, id: str) -> List[VectorRow]:
        sql = f"SELECT * FROM {self.table} WHERE id=?"
        rows = db.conn.execute(sql, (id,)).fetchall()
        res = []
        for r in rows:
            cnt = len(r["v"]) // 4
            vec = list(struct.unpack(f"{cnt}f", r["v"]))
            res.append(VectorRow(r["id"], r["sector"], vec, r["dim"], json.loads(r["provenance"]) if r["provenance"] else None))
        return res

    async def getVector(self, id: str, sector: str) -> Optional[VectorRow]:
        sql = f"SELECT * FROM {self.table} WHERE id=? AND sector=?"
        r = db.conn.execute(sql, (id, sector)).fetchone()
        if not r: return None
        cnt = len(r["v"]) // 4
        vec = list(struct.unpack(f"{cnt}f", r["v"]))
        return VectorRow(r["id"], r["sector"], vec, r["dim"], json.loads(r["provenance"]) if r["provenance"] else None)

    async def deleteVectors(self, id: str):
        db.conn.execute(f"DELETE FROM {self.table} WHERE id=?", (id,))
        db.commit()

    async def search(self, vector: List[float], sector: str, k: int, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        validate_vector(vector, len(vector))
        filter_sql = ""
        params = [sector]
        if filter and filter.get("user_id"):
            filter_sql += " AND user_id=?"
            params.append(filter["user_id"])

        sql = f"SELECT id, v FROM {self.table} WHERE sector=? {filter_sql}"
        rows = db.conn.execute(sql, tuple(params)).fetchall()
        results = []
        import numpy as np
        query_vec = np.array(vector, dtype=np.float32)
        q_norm = np.linalg.norm(query_vec)

        for r in rows:
            cnt = len(r["v"]) // 4
            if cnt != len(vector): continue
            v = np.array(struct.unpack(f"{cnt}f", r["v"]), dtype=np.float32)
            dot = np.dot(query_vec, v)
            norm = np.linalg.norm(v)
            sim = dot / (q_norm * norm) if (q_norm * norm) > 0 else 0
            results.append({"id": r["id"], "similarity": float(sim)})
        results.sort(key=lambda x: x["similarity"], reverse=True)
        return results[:k]
import os

def get_vector_store() -> VectorStore:
    backend = os.getenv("OPENMEMORY_VECTOR_STORE", "sqlite")

    if backend == "postgres":
        dsn = os.getenv("OPENMEMORY_PG_DSN", "postgresql://user:pass@localhost:5432/db")
        from .vector.postgres import PostgresVectorStore
        logger.info("Using PostgresVectorStore")
        return PostgresVectorStore(dsn)

    elif backend == "valkey" or backend == "redis":
        url = os.getenv("OPENMEMORY_REDIS_URL", "redis://localhost:6379/0")
        from .vector.valkey import ValkeyVectorStore
        logger.info("Using ValkeyVectorStore")
        return ValkeyVectorStore(url)

    else:
        logger.info("Using SQLiteVectorStore")
        return SQLiteVectorStore()

vector_store = get_vector_store()
