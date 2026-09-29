import { q } from "../../core/db";
import { delete_memory } from "../../memory/hsg";
import { p } from "../../utils";
import {
    update_user_summary,
    auto_update_user_summaries,
} from "../../memory/user_summary";

export const usr = (app: any) => {
    app.get("/users/:user_id/summary", async (req: any, res: any) => {
        try {
            const { user_id } = req.params;
            if (!user_id)
                return res.status(400).json({ error: "user_id required" });

            const user = await q.get_user.get(user_id);
            if (!user) return res.status(404).json({ error: "user not found" });

            res.json({
                user_id: user.user_id,
                summary: user.summary,
                reflection_count: user.reflection_count,
                updated_at: user.updated_at,
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post(
        "/users/:user_id/summary/regenerate",
        async (req: any, res: any) => {
            try {
                const { user_id } = req.params;
                if (!user_id)
                    return res.status(400).json({ err: "user_id required" });

                await update_user_summary(user_id);
                const user = await q.get_user.get(user_id);

                res.json({
                    ok: true,
                    user_id,
                    summary: user?.summary,
                    reflection_count: user?.reflection_count,
                });
            } catch (err: any) {
                res.status(500).json({ err: err.message });
            }
        },
    );

    app.post("/users/summaries/regenerate-all", async (req: any, res: any) => {
        try {
            const result = await auto_update_user_summaries();
            res.json({ ok: true, updated: result.updated });
        } catch (err: any) {
            res.status(500).json({ err: err.message });
        }
    });

    app.get("/users/:user_id/memories", async (req: any, res: any) => {
        try {
            const { user_id } = req.params;
            if (!user_id)
                return res.status(400).json({ err: "user_id required" });

            const l = req.query.l ? parseInt(req.query.l) : 100;
            const u = req.query.u ? parseInt(req.query.u) : 0;

            const r = await q.all_mem_by_user.all(user_id, l, u);
            const i = r.map((x: any) => ({
                id: x.id,
                content: x.content,
                tags: p(x.tags),
                metadata: p(x.meta),
                created_at: x.created_at,
                updated_at: x.updated_at,
                last_seen_at: x.last_seen_at,
                salience: x.salience,
                decay_lambda: x.decay_lambda,
                primary_sector: x.primary_sector,
                version: x.version,
            }));
            res.json({ user_id, items: i });
        } catch (err: any) {
            res.status(500).json({ err: err.message });
        }
    });

    app.delete("/users/:user_id/memories", async (req: any, res: any) => {
        try {
            const { user_id } = req.params;
            if (!user_id)
                return res.status(400).json({ err: "user_id required" });

            let deleted = 0;
            while (true) {
                const mems = await q.all_mem_by_user.all(user_id, 100, 0);
                if (!mems.length) break;
                for (const m of mems) {
                    if (await delete_memory(m.id)) deleted++;
                }
            }

            res.json({ ok: true, deleted });
        } catch (err: any) {
            res.status(500).json({ err: err.message });
        }
    });
};
