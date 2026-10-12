const syn_grps = [
    ["prefer", "like", "love", "enjoy", "favor"],
    ["theme", "mode", "style", "layout"],
    ["meeting", "meet", "session", "call", "sync"],
    ["dark", "night", "black"],
    ["light", "bright", "day"],
    ["user", "person", "people", "customer"],
    ["task", "todo", "job"],
    ["note", "memo", "reminder"],
    ["time", "schedule", "when", "date"],
    ["project", "initiative", "plan"],
    ["issue", "problem", "bug"],
    ["document", "doc", "file"],
    ["question", "query", "ask"],
];
const cmap = new Map<string, string>();
const slook = new Map<string, Set<string>>();

for (const grp of syn_grps) {
    const can = grp[0];
    const sset = new Set(grp);
    for (const w of grp) {
        cmap.set(w, can);
        slook.set(can, sset);
    }
}

const stem_rules: Array<[RegExp, string]> = [
    [/ies$/, "y"],
    [/ing$/, ""],
    [/ers?$/, "er"],
    [/ed$/, ""],
    [/s$/, ""],
];
const tok_pat = /[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/giu;
const cjk_run = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * ASCII words, plus overlapping character bigrams for CJK runs (which have no
 * spaces to split on). Without the bigrams every pure-CJK text produced an
 * empty token set, so unrelated memories shared one SimHash and one vector.
 */
export const tokenize = (text: string): string[] => {
    const toks: string[] = [];
    for (const [run] of text.matchAll(tok_pat)) {
        if (!cjk_run.test(run)) {
            toks.push(run.toLowerCase());
            continue;
        }
        const chars = Array.from(run);
        if (chars.length === 1) toks.push(run);
        for (let i = 0; i + 1 < chars.length; i++) toks.push(chars[i] + chars[i + 1]);
    }
    return toks;
};

const stem = (tok: string): string => {
    if (tok.length <= 3) return tok;
    for (const [pat, rep] of stem_rules) {
        if (pat.test(tok)) {
            const st = tok.replace(pat, rep);
            if (st.length >= 3) return st;
        }
    }
    return tok;
};

export const canonicalize_token = (tok: string): string => {
    if (!tok) return "";
    const low = tok.toLowerCase();
    if (cmap.has(low)) return cmap.get(low)!;
    const st = stem(low);
    return cmap.get(st) || st;
};

export const canonical_tokens_from_text = (text: string): string[] => {
    const res: string[] = [];
    for (const tok of tokenize(text)) {
        const can = canonicalize_token(tok);
        if (can && can.length > 1) {
            res.push(can);
        }
    }
    return res;
};

export const synonyms_for = (tok: string): Set<string> => {
    const can = canonicalize_token(tok);
    return slook.get(can) || new Set([can]);
};

export const build_search_doc = (text: string): string => {
    const can = canonical_tokens_from_text(text);
    const exp = new Set<string>();
    for (const tok of can) {
        exp.add(tok);
        const syns = slook.get(tok);
        if (syns) {
            syns.forEach((s) => exp.add(s));
        }
    }
    return Array.from(exp).join(" ");
};

export const build_fts_query = (text: string): string => {
    const can = canonical_tokens_from_text(text);
    if (!can.length) return "";
    const uniq = Array.from(new Set(can.filter((t) => t.length > 1)));
    return uniq.map((t) => `"${t}"`).join(" OR ");
};

export const canonical_token_set = (text: string): Set<string> => {
    return new Set(canonical_tokens_from_text(text));
};

export const add_synonym_tokens = (toks: Iterable<string>): Set<string> => {
    const res = new Set<string>();
    for (const tok of toks) {
        res.add(tok);
        const syns = slook.get(tok);
        if (syns) {
            syns.forEach((s) => res.add(canonicalize_token(s)));
        }
    }
    return res;
};
