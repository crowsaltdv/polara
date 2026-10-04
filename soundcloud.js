// SoundCloud through its official API (https://developers.soundcloud.com), using the server-side "client credentials" flow.
//
// It only switches on when you give the server your own app credentials as environment variables:
//   SOUNDCLOUD_CLIENT_ID      your app's client_id
//   SOUNDCLOUD_CLIENT_SECRET  your app's client_secret
// (Register an app at developers.soundcloud.com; SoundCloud currently requires an Artist Pro account for that.)
// Without them SoundCloud simply doesn't appear in the music tab.
//
// SoundCloud's terms for custom players require crediting the uploader, crediting SoundCloud, and linking back to the
// track's SoundCloud page. The music tab shows the uploader's name, a "SoundCloud" label, and a "View on SoundCloud" link.
const ID = process.env.SOUNDCLOUD_CLIENT_ID;
const SECRET = process.env.SOUNDCLOUD_CLIENT_SECRET;
const API = (process.env.SOUNDCLOUD_API || "https://api.soundcloud.com").replace(/\/$/, "");
const AUTH = (process.env.SOUNDCLOUD_AUTH || "https://secure.soundcloud.com").replace(/\/$/, "");

export const configured = Boolean(ID && SECRET);

let token = null;
let tokenExpires = 0;
async function getToken(force = false) {
	if (!force && token && Date.now() < tokenExpires - 60e3) return token;
	const r = await fetch(`${AUTH}/oauth/token`, {
		method: "POST",
		headers: {
			Authorization: "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64"),
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json; charset=utf-8",
		},
		body: "grant_type=client_credentials",
		signal: AbortSignal.timeout(12000),
	});
	if (!r.ok) throw new Error(`soundcloud auth ${r.status}`);
	const j = await r.json();
	token = j.access_token;
	tokenExpires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
	return token;
}

async function call(path, init = {}) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await fetch(`${API}${path}`, {
			redirect: "manual",
			signal: AbortSignal.timeout(15000),
			...init,
			headers: { Authorization: `OAuth ${await getToken(attempt > 0)}`, Accept: "application/json; charset=utf-8" },
		});
		if (r.status === 401 && attempt === 0) continue; // the token expired: get a fresh one and retry once
		return r;
	}
}

const art = (u) => (u ? u.replace("-large.", "-t500x500.") : "");
const mapTrack = (t) => ({
	id: "sc_" + t.id,
	n: String(t.title || "Untitled").slice(0, 160),
	a: String(t.user?.username || "Unknown artist").slice(0, 80),
	al: "SoundCloud",
	i: art(t.artwork_url || t.user?.avatar_url),
	s: `/api/music/soundcloud/stream?id=${t.id}`,
	d: Number(t.duration) || 0,
	e: 0,
	u: /^https:\/\/(www\.)?soundcloud\.com\//i.test(t.permalink_url || "") ? t.permalink_url : "",
});

export async function search(q) {
	const r = await call(`/tracks?q=${encodeURIComponent(q)}&access=playable&limit=24&linked_partitioning=true`);
	if (!r.ok) throw new Error(`soundcloud search ${r.status}`);
	const j = await r.json();
	const list = Array.isArray(j) ? j : j.collection || [];
	return list.filter((t) => t && t.id && t.streamable !== false && (!t.access || t.access === "playable")).slice(0, 12).map(mapTrack);
}

// a short-lived direct link to the audio file, so the music itself never passes through this server
export async function streamUrl(id) {
	const r = await call(`/tracks/${id}/streams`);
	if (r.ok) {
		const j = await r.json();
		if (j.http_mp3_128_url) return j.http_mp3_128_url;
	}
	const s = await call(`/tracks/${id}/stream`);
	const loc = s.headers.get("location");
	if (s.status >= 300 && s.status < 400 && loc) return loc;
	return null;
}
