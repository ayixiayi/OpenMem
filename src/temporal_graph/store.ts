import { run_async, get_async, all_async, transaction } from '../core/db'
import { TemporalFact, TemporalEdge } from './types'
import { randomUUID } from 'crypto'

export type FactKind = 'state' | 'set' | 'event'

export interface FactOptions {
    /** Project scope; `null`/omitted means a global fact (e.g. a user preference). */
    project?: string | null
    /**
     * `state`: one value per subject+predicate at a time; a new value ends the old one.
     * `set`: values coexist (supported platforms, dependencies); retract individually.
     * `event`: an instant (deploy, outage, migration); never replaces anything.
     */
    kind?: FactKind
    /** The contextual memory this fact was extracted from. */
    source_memory_id?: string | null
}

export const normalize_subject = (subject: string) => subject.trim().replace(/\s+/g, ' ').toLowerCase()
export const normalize_predicate = (predicate: string) => predicate.trim().toLowerCase().replace(/[\s-]+/g, '_')

/** SQL for "same user and project" that works on both backends. */
export const fact_scope_sql = (user_id?: string | null, project?: string | null) => ({
    sql: `${user_id ? 'user_id = ?' : 'user_id IS NULL'} AND ${project ? 'project = ?' : 'project IS NULL'}`,
    params: [...(user_id ? [user_id] : []), ...(project ? [project] : [])],
})

// Rows whose interval ends before it starts were retracted by a same-time correction.
const LIVE = '(valid_to IS NULL OR valid_to >= valid_from)'

export const insert_fact = async (
    subject: string,
    predicate: string,
    object: string,
    valid_from: Date = new Date(),
    confidence: number = 1.0,
    metadata?: Record<string, any>,
    user_id?: string,
    opts: FactOptions = {}
): Promise<string> => {
    return transaction.run(() => insert_fact_in_transaction(subject, predicate, object, valid_from, confidence, metadata, user_id, opts))
}

/** Must run inside `transaction.run`. Returns the id of the fact now holding this value. */
export const insert_fact_in_transaction = async (
    subject: string,
    predicate: string,
    object: string,
    valid_from: Date = new Date(),
    confidence: number = 1.0,
    metadata?: Record<string, any>,
    user_id?: string,
    opts: FactOptions = {}
): Promise<string> => {
    subject = normalize_subject(subject)
    predicate = normalize_predicate(predicate)
    object = object.trim()
    const kind = opts.kind ?? 'state'
    const project = opts.project || null
    const t = valid_from.getTime()
    if (!Number.isFinite(t)) throw new Error('valid_from must be a valid date')
    const now = Date.now()
    const scope = fact_scope_sql(user_id, project)
    // Kinds never interact: an event or set value must not end or truncate a state.
    const key = `${scope.sql} AND subject = ? AND predicate = ? AND kind = ?`
    const key_params = [...scope.params, subject, predicate, kind]

    // An already-recorded value is reused; it gains a source link if it had none.
    const covering = async () => {
        const row = await get_async(`
            SELECT id, source_memory_id FROM temporal_facts
            WHERE ${key} AND object = ? AND ${LIVE} AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
            ORDER BY valid_from DESC LIMIT 1
        `, [...key_params, object, t, t])
        if (row && !row.source_memory_id && opts.source_memory_id) {
            await run_async(`UPDATE temporal_facts SET source_memory_id = ? WHERE id = ?`, [opts.source_memory_id, row.id])
        }
        return row
    }

    let valid_to: number | null = null
    if (kind === 'event') {
        valid_to = t
    } else if (kind === 'set') {
        const held = await covering()
        if (held) return held.id
    } else {
        const held = await covering()
        if (held) return held.id
        // Same start time, different value: a correction. Keep the old row for
        // audit but give it an empty interval so it is never current.
        await run_async(`
            UPDATE temporal_facts SET valid_to = ?, last_updated = ?
            WHERE ${key} AND valid_from = ? AND object <> ? AND ${LIVE}
        `, [t - 1, now, ...key_params, t, object])
        const prev = await get_async(`
            SELECT id, valid_to FROM temporal_facts
            WHERE ${key} AND valid_from < ? AND ${LIVE}
            ORDER BY valid_from DESC LIMIT 1
        `, [...key_params, t])
        if (prev && (prev.valid_to == null || Number(prev.valid_to) >= t)) {
            await run_async(`UPDATE temporal_facts SET valid_to = ?, last_updated = ? WHERE id = ?`, [t - 1, now, prev.id])
        }
        // Backfilling an older value: it ends where the next known value begins.
        const next = await get_async(`
            SELECT valid_from FROM temporal_facts
            WHERE ${key} AND valid_from > ? AND ${LIVE}
            ORDER BY valid_from ASC LIMIT 1
        `, [...key_params, t])
        if (next) valid_to = Number(next.valid_from) - 1
    }

    const meta = metadata ? JSON.stringify(metadata) : null
    const same = await get_async(`
        SELECT id FROM temporal_facts WHERE ${key} AND object = ? AND valid_from = ?
    `, [...key_params, object, t])
    if (same) {
        // Re-asserting a retracted value at the same instant revives that row.
        await run_async(`
            UPDATE temporal_facts SET valid_to = ?, confidence = ?, last_updated = ?, metadata = ?, kind = ?, source_memory_id = ?
            WHERE id = ?
        `, [valid_to, confidence, now, meta, kind, opts.source_memory_id ?? null, same.id])
        return same.id
    }

    const id = randomUUID()
    await run_async(`
        INSERT INTO temporal_facts (id, user_id, project, kind, subject, predicate, object, valid_from, valid_to, confidence, last_updated, metadata, source_memory_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, user_id || null, project, kind, subject, predicate, object, t, valid_to, confidence, now, meta, opts.source_memory_id ?? null])
    return id
}

/** End a fact's validity, e.g. a platform that is no longer supported. */
export const retract_fact = async (
    match: { id?: string; subject?: string; predicate?: string; object?: string },
    at: Date = new Date(),
    user_id?: string,
    project?: string | null
): Promise<number> => {
    const t = at.getTime()
    const conditions = ['valid_from <= ?', '(valid_to IS NULL OR valid_to >= ?)']
    const params: any[] = [t, t]
    if (match.id) {
        conditions.push('id = ?')
        params.push(match.id)
    } else {
        if (!match.subject || !match.predicate) throw new Error('retract needs an id, or subject and predicate')
        const scope = fact_scope_sql(user_id, project || null)
        conditions.push(scope.sql, 'subject = ?', 'predicate = ?')
        params.push(...scope.params, normalize_subject(match.subject), normalize_predicate(match.predicate))
        if (match.object) {
            conditions.push('object = ?')
            params.push(match.object.trim())
        }
    }
    if (match.id && user_id) {
        conditions.push('user_id = ?')
        params.push(user_id)
    }
    return transaction.run(async () => {
        const rows = await all_async(`SELECT id FROM temporal_facts WHERE ${conditions.join(' AND ')}`, params)
        for (const row of rows) {
            await run_async(`UPDATE temporal_facts SET valid_to = ?, last_updated = ? WHERE id = ?`, [t, Date.now(), row.id])
        }
        return rows.length
    })
}

export const update_fact = async (id: string, confidence?: number, metadata?: Record<string, any>): Promise<void> => {
    const updates: string[] = []
    const params: any[] = []

    if (confidence !== undefined) {
        updates.push('confidence = ?')
        params.push(confidence)
    }

    if (metadata !== undefined) {
        updates.push('metadata = ?')
        params.push(JSON.stringify(metadata))
    }

    updates.push('last_updated = ?')
    params.push(Date.now())

    params.push(id)

    if (updates.length > 0) {
        await run_async(`UPDATE temporal_facts SET ${updates.join(', ')} WHERE id = ?`, params)
        console.error(`[TEMPORAL] Updated fact ${id}`)
    }
}

export const invalidate_fact = async (id: string, valid_to: Date = new Date()): Promise<void> => {
    await run_async(`UPDATE temporal_facts SET valid_to = ?, last_updated = ? WHERE id = ?`, [valid_to.getTime(), Date.now(), id])
    console.error(`[TEMPORAL] Invalidated fact ${id} at ${valid_to.toISOString()}`)
}

export const delete_fact = async (id: string): Promise<void> => {
    await run_async(`DELETE FROM temporal_facts WHERE id = ?`, [id])
    console.error(`[TEMPORAL] Deleted fact ${id}`)
}

export const insert_edge = async (
    source_id: string,
    target_id: string,
    relation_type: string,
    valid_from: Date = new Date(),
    weight: number = 1.0,
    metadata?: Record<string, any>
): Promise<string> => {
    const id = randomUUID()
    const valid_from_ts = valid_from.getTime()

    await run_async(`
        INSERT INTO temporal_edges (id, source_id, target_id, relation_type, valid_from, valid_to, weight, metadata)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `, [id, source_id, target_id, relation_type, valid_from_ts, weight, metadata ? JSON.stringify(metadata) : null])

    console.error(`[TEMPORAL] Created edge: ${source_id} --[${relation_type}]--> ${target_id}`)
    return id
}

export const invalidate_edge = async (id: string, valid_to: Date = new Date()): Promise<void> => {
    await run_async(`UPDATE temporal_edges SET valid_to = ? WHERE id = ?`, [valid_to.getTime(), id])
    console.error(`[TEMPORAL] Invalidated edge ${id}`)
}

export const batch_insert_facts = async (facts: Array<{
    subject: string
    predicate: string
    object: string
    valid_from?: Date
    confidence?: number
    metadata?: Record<string, any>
} & FactOptions>, user_id?: string): Promise<string[]> => {
    const ids: string[] = []

    await transaction.run(async () => {
        for (const fact of facts) {
            const id = await insert_fact_in_transaction(
                fact.subject,
                fact.predicate,
                fact.object,
                fact.valid_from,
                fact.confidence,
                fact.metadata,
                user_id,
                fact
            )
            ids.push(id)
        }
    })

    return ids
}

export const apply_confidence_decay = async (decay_rate: number = 0.01): Promise<number> => {
    const now = Date.now()
    const one_day = 86400000

    await run_async(`
        UPDATE temporal_facts
        SET confidence = MAX(0.1, confidence * (1 - ? * ((? - valid_from) / ?)))
        WHERE valid_to IS NULL AND confidence > 0.1
    `, [decay_rate, now, one_day])

    const result = await get_async(`SELECT changes() as changes`) as any
    const changes = result?.changes || 0
    console.error(`[TEMPORAL] Applied confidence decay to ${changes} facts`)
    return changes
}

export const get_active_facts_count = async (): Promise<number> => {
    const result = await get_async(`SELECT COUNT(*) as count FROM temporal_facts WHERE valid_to IS NULL`) as any
    return result?.count || 0
}

export const get_total_facts_count = async (): Promise<number> => {
    const result = await get_async(`SELECT COUNT(*) as count FROM temporal_facts`) as any
    return result?.count || 0
}
