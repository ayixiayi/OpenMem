-- Historical vectors deliberately retain NULL (unknown) provenance.
ALTER TABLE vectors ADD COLUMN provenance TEXT;
