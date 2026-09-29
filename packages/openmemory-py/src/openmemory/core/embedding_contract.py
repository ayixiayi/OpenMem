"""Observed generation metadata; model aliases do not identify immutable weights."""

import math
from numbers import Real


def validate_vector(vector, dim):
    if (
        not isinstance(dim, int)
        or isinstance(dim, bool)
        or dim <= 0
        or not isinstance(vector, (list, tuple))
        or len(vector) != dim
        or any(
            not isinstance(value, Real)
            or isinstance(value, bool)
            or not math.isfinite(value)
            or abs(value) > 3.4028234663852886e38
            for value in vector
        )
    ):
        raise ValueError(
            "Embedding must be a nonempty finite vector matching its dimension"
        )


def validate_provenance(provenance, sector, dim):
    if provenance is not None and (
        provenance.get("schema_version") != 1
        or provenance.get("sector") != sector
        or provenance.get("dimensions") != dim
    ):
        raise ValueError("Embedding provenance does not match vector sector/dimension")
