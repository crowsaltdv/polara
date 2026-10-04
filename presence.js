import express from "express";
import { rateLimit } from "./security.js";

// Counts people who currently have Polaris open. Each browser has a random id (kept in its localStorage) and
// checks in every 30 seconds; closing the page removes it immediately, and a browser that goes quiet drops
// off after PRESENCE_TTL_S seconds. Ids live only in memory: nothing is stored on disk and no IPs are kept.
const TTL = (Number(process.env.PRESENCE_TTL_S) || 150) * 1000;
const MAX_IDS = 50000;
const MAX_IDS_PER_IP = 10; // one network can't inflate the number by inventing visitors

const seen = new Map(); // id -> { t: last check-in, ip }
const byIp = new Map(); // ip -> Set(ids)
const ID = /^[a-f0-9]{24}$/;

function drop(id) {
	const v = seen.get(id);
	if (!v) return;
	seen.delete(id);
	const set = byIp.get(v.ip);
	if (set) {
		set.delete(id);
		if (!set.size) byIp.delete(v.ip);
	}
}

function prune() {
	const cutoff = Date.now() - TTL;
	for (const [id, v] of seen) if (v.t < cutoff) drop(id);
}
setInterval(prune, 10e3).unref();

// recount at most every 2 seconds so a burst of check-ins doesn't repeat the work
let cache = { at: 0, n: 0 };
function online() {
	const now = Date.now();
	if (now - cache.at > 2e3) {
		const cutoff = now - TTL;
		let n = 0;
		for (const v of seen.values()) if (v.t >= cutoff) n++;
		cache = { at: now, n };
	}
	return cache.n;
}

export function presenceRouter() {
	const r = express.Router();
	r.use(express.json({ limit: "200b" }));
	r.use(rateLimit({ windowMs: 60e3, max: 40, message: "Too many check-ins." }));

	r.post("/ping", (req, res) => {
		const id = req.body?.id;
		if (typeof id === "string" && ID.test(id)) {
			const known = seen.get(id);
			if (known) {
				known.t = Date.now();
			} else {
				// clear this network's expired visitors first, so stale entries never take up its slots
				const cutoff = Date.now() - TTL;
				for (const sid of [...(byIp.get(req.ip) || [])]) if ((seen.get(sid)?.t ?? 0) < cutoff) drop(sid);
				const set = byIp.get(req.ip) || new Set();
				if (set.size < MAX_IDS_PER_IP && seen.size < MAX_IDS) {
					seen.set(id, { t: Date.now(), ip: req.ip });
					set.add(id);
					byIp.set(req.ip, set);
					cache.at = 0; // a new visitor should show up right away
				}
			}
		}
		res.json({ online: online() });
	});

	r.post("/leave", (req, res) => {
		const id = req.body?.id;
		if (typeof id === "string" && ID.test(id)) {
			drop(id);
			cache.at = 0;
		}
		res.status(204).end();
	});

	return r;
}
