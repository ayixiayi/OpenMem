CREATE TABLE document_sections (
    document_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    section_index INTEGER NOT NULL CHECK(section_index >= 0),
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    PRIMARY KEY(document_id, section_index)
);
CREATE INDEX document_sections_memory ON document_sections(memory_id);
CREATE TRIGGER document_sections_delete AFTER DELETE ON memories BEGIN
    DELETE FROM document_sections WHERE document_id=old.id OR memory_id=old.id;
END;

-- Preserve only explicit, unambiguous links with matching stored ownership.
WITH records AS (
    SELECT id, user_id, CASE WHEN json_valid(meta) THEN meta ELSE '{}' END AS meta
    FROM memories
), candidates AS (
    SELECT root.id AS document_id,
           json_extract(child.meta, '$.section_index') AS section_index,
           child.id AS memory_id
    FROM records child JOIN records root
      ON root.id=json_extract(child.meta, '$.parent_id')
    WHERE json_type(child.meta, '$.is_child')='true'
      AND json_type(root.meta, '$.is_root')='true'
      AND json_type(child.meta, '$.parent_id')='text'
      AND json_type(child.meta, '$.section_index')='integer'
      AND json_extract(child.meta, '$.section_index') >= 0
      AND root.id <> child.id AND root.user_id IS child.user_id
)
INSERT INTO document_sections(document_id, section_index, memory_id)
SELECT document_id, section_index, min(memory_id) FROM candidates
GROUP BY document_id, section_index HAVING count(*)=1;
