import express from "express";
import * as soundcloud from "./soundcloud.js";

// Song data comes from Apple's public iTunes catalog (charts, search, lookup).
// It exposes real songs with artwork and 30-second previews; full tracks are not available through it.
const HEADERS = { "User-Agent": "Mozilla/5.0 (Polaris music)" };
const GENRES = [
	["Pop", 14],
	["Hip-Hop / Rap", 18],
	["Rock", 21],
	["R&B / Soul", 15],
	["Country", 6],
	["Dance", 17],
	["Latin", 12],
	["Alternative", 20],
];

const cache = new Map();
function cached(key, ttl, fn) {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.v);
	return fn().then((v) => {
		cache.set(key, { at: Date.now(), v });
		if (cache.size > 300) cache.delete(cache.keys().next().value);
		return v;
	});
}

async function jget(url) {
	const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
	if (!r.ok) throw new Error(`upstream ${r.status}`);
	return JSON.parse(await r.text());
}

const art = (u) => (u ? u.replace(/\/\d+x\d+(bb|sr)?\.(jpg|png|webp)$/, "/400x400bb.jpg") : "");
const song = (r) => ({
	id: r.trackId,
	n: r.trackName,
	a: r.artistName,
	al: r.collectionName,
	c: r.collectionId,
	p: r.previewUrl,
	i: art(r.artworkUrl100),
	e: r.trackExplicitness === "explicit" ? 1 : 0,
	d: r.trackTimeMillis,
});
const album = (r) => ({
	id: r.collectionId,
	n: r.collectionName,
	a: r.artistName,
	i: art(r.artworkUrl100),
	e: r.collectionExplicitness === "explicit" ? 1 : 0,
});
const feedIds = (feed) => (feed.feed.entry || []).map((e) => e.id.attributes["im:id"]);

async function lookup(ids, entity) {
	if (!ids.length) return [];
	const j = await jget(`https://itunes.apple.com/lookup?id=${ids.join(",")}${entity ? `&entity=${entity}` : ""}`);
	return j.results;
}

async function topSongs(genre) {
	const feed = await jget(`https://itunes.apple.com/us/rss/topsongs/limit=24${genre ? `/genre=${genre}` : ""}/json`);
	const ids = feedIds(feed);
	const by = new Map((await lookup(ids)).filter((r) => r.trackId).map((r) => [String(r.trackId), r]));
	return ids.map((i) => by.get(i)).filter((r) => r && r.previewUrl).map(song);
}

async function topAlbums() {
	const feed = await jget("https://itunes.apple.com/us/rss/topalbums/limit=24/json");
	const ids = feedIds(feed);
	const by = new Map((await lookup(ids)).filter((r) => r.collectionId).map((r) => [String(r.collectionId), r]));
	return ids.map((i) => by.get(i)).filter(Boolean).map(album);
}

// ---- full-length songs from Audius (free, artist-uploaded music with an open streaming API) ----
const AUDIUS = "https://api.audius.co/v1";
const fullSong = (t) => ({
	id: "au_" + t.id,
	n: t.title,
	a: t.user?.name || "Unknown artist",
	al: "Audius",
	i: t.artwork?.["480x480"] || t.artwork?.["150x150"] || "",
	s: `/api/music/audius/stream?id=${t.id}`,
	d: (t.duration || 0) * 1000,
	e: 0,
});
const playable = (t) => t && t.is_streamable && !t.is_stream_gated && !t.is_delete && !t.is_unlisted && t.duration > 30;
async function audiusTrending() {
	const j = await jget(`${AUDIUS}/tracks/trending?app_name=Polaris&limit=40`);
	return j.data.filter(playable).slice(0, 24).map(fullSong);
}
async function audiusSearch(q) {
	const j = await jget(`${AUDIUS}/tracks/search?query=${encodeURIComponent(q)}&app_name=Polaris&limit=24`);
	return j.data.filter(playable).slice(0, 12).map(fullSong);
}
const hits = new Map();
function limited(ip) {
	const now = Date.now();
	const arr = (hits.get(ip) || []).filter((t) => now - t < 60e3);
	arr.push(now);
	hits.set(ip, arr);
	return arr.length > 90;
}

export function musicRouter() {
	const r = express.Router();
	r.use((req, res, next) => (limited(req.ip) ? res.status(429).json({ error: "Slow down a little." }) : next()));

	r.get("/browse", async (req, res) => {
		try {
			const v = await cached("browse", 3600e3, async () => {
				const jobs = [
					["Full songs: trending on Audius", "songs", audiusTrending()],
					["Top albums", "albums", topAlbums()],
					["Top hits", "songs", topSongs()],
					...GENRES.map(([name, id]) => [name, "songs", topSongs(id)]),
				];
				const done = await Promise.allSettled(jobs.map((j) => j[2]));
				const sections = [];
				done.forEach((d, i) => {
					if (d.status === "fulfilled" && d.value.length) sections.push({ t: jobs[i][0], k: jobs[i][1], items: d.value });
				});
				if (!sections.length) throw new Error("no data");
				return sections;
			});
			res.set("Cache-Control", "private, max-age=900").json({ sections: v });
		} catch {
			res.status(502).json({ error: "Couldn't load music right now. Try again in a moment." });
		}
	});

	r.get("/search", async (req, res) => {
		const q = String(req.query.q || "").trim().slice(0, 80);
		if (!q) return res.json({ songs: [], albums: [], full: [], soundcloud: [] });
		try {
			const v = await cached("s:" + q.toLowerCase(), 600e3, async () => {
				const enc = encodeURIComponent(q);
				const [s, a, f, sc] = await Promise.all([
					jget(`https://itunes.apple.com/search?term=${enc}&entity=song&limit=30`),
					jget(`https://itunes.apple.com/search?term=${enc}&entity=album&limit=12`),
					audiusSearch(q).catch(() => []),
					soundcloud.configured ? soundcloud.search(q).catch(() => []) : [],
				]);
				return { songs: s.results.filter((x) => x.previewUrl).map(song), albums: a.results.filter((x) => x.collectionId).map(album), full: f, soundcloud: sc };
			});
			res.set("Cache-Control", "private, max-age=300").json(v);
		} catch {
			res.status(502).json({ error: "Search isn't available right now." });
		}
	});

	// SoundCloud (official API): sends the browser straight to a short-lived link on SoundCloud's own servers
	r.get("/soundcloud/stream", async (req, res) => {
		const id = String(req.query.id || "");
		if (!soundcloud.configured || !/^\d{1,15}$/.test(id)) return res.status(404).end();
		try {
			const url = await soundcloud.streamUrl(id);
			if (!url || !/^https:\/\//i.test(url) && !process.env.SOUNDCLOUD_API) return res.status(404).end();
			res.set("Cache-Control", "no-store").redirect(302, url);
		} catch {
			res.status(502).end();
		}
	});

	r.get("/audius/stream", (req, res) => {
		const id = String(req.query.id || "");
		if (!/^[A-Za-z0-9]{1,16}$/.test(id)) return res.status(400).end();
		res.redirect(302, `${AUDIUS}/tracks/${id}/stream?app_name=Polaris`);
	});

	r.get("/album", async (req, res) => {
		const id = String(req.query.id || "");
		if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ error: "Bad album id." });
		try {
			const v = await cached("a:" + id, 3600e3, async () => {
				const rows = await lookup([id], "song");
				const head = rows.find((x) => x.wrapperType === "collection");
				if (!head) throw new Error("missing");
				return { album: album(head), tracks: rows.filter((x) => x.wrapperType === "track" && x.previewUrl).map(song) };
			});
			res.set("Cache-Control", "private, max-age=900").json(v);
		} catch {
			res.status(502).json({ error: "Couldn't load that album." });
		}
	});

	return r;
}
