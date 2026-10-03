import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";

const scrypt = promisify(crypto.scrypt);

export const CHANNELS = ["general", "links"];
const DIR = path.join(import.meta.dirname, "data");
const FILE = path.join(DIR, "chat.json");
const KEEP = 300; // messages kept per channel
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_USERS = 20000;
const MAX_SESSIONS_PER_USER = 8;
const MAX_STREAMS_PER_USER = 4;
const MAX_STREAMS_PER_IP = 12;
// names that could be mistaken for staff or the system
const RESERVED = /^(admin|administrator|mod|moderator|staff|support|system|polaris|owner|official|root|server|bot|null|undefined)$/i;
// control characters and invisible/bidirectional-override characters used to spoof or break layouts
const JUNK = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const cleanText = (s) => s.replace(JUNK, "").replace(/\n{3,}/g, "\n\n").trim();

let db = { users: {}, sessions: {}, messages: {} };
try {
	db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
} catch {}
for (const c of CHANNELS) db.messages[c] ||= [];

let saveTimer;
function save() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		fs.mkdirSync(DIR, { recursive: true });
		fs.writeFile(FILE + ".tmp", JSON.stringify(db), (err) => {
			if (!err) fs.rename(FILE + ".tmp", FILE, () => {});
		});
	}, 400);
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const publicUser = (u) => ({ name: u.name, hue: u.hue });

// simple per-key sliding window limiter
const hits = new Map();
function limited(key, max, ms) {
	const now = Date.now();
	const arr = (hits.get(key) || []).filter((t) => now - t < ms);
	arr.push(now);
	hits.set(key, arr);
	return arr.length > max;
}
setInterval(() => {
	const now = Date.now();
	for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k);
}, 600e3).unref();

// failed-login tracking per account, so a stranger can't guess one person's password
const fails = new Map();
const failCount = (key) => (fails.get(key) || []).filter((t) => Date.now() - t < 600e3).length;
const addFail = (key) => fails.set(key, [...(fails.get(key) || []).filter((t) => Date.now() - t < 600e3), Date.now()]);
setInterval(() => {
	for (const k of fails.keys()) if (!failCount(k)) fails.delete(k);
}, 600e3).unref();

function newSession(user) {
	const token = crypto.randomBytes(32).toString("hex");
	const key = user.name.toLowerCase();
	const mine = Object.entries(db.sessions).filter(([, s]) => s.user === key).sort((a, b) => a[1].created - b[1].created);
	while (mine.length >= MAX_SESSIONS_PER_USER) delete db.sessions[mine.shift()[0]];
	db.sessions[sha(token)] = { user: key, created: Date.now() };
	save();
	return token;
}

// one-time, short-lived tickets let the live stream authenticate without putting the login token in a URL
const tickets = new Map();
setInterval(() => {
	const now = Date.now();
	for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
}, 30e3).unref();

function auth(req, res, next) {
	const h = req.headers.authorization || "";
	const token = h.startsWith("Bearer ") ? h.slice(7) : "";
	const s = token && db.sessions[sha(String(token))];
	const user = s && Date.now() - s.created < SESSION_MS && db.users[s.user];
	if (!user) return res.status(401).json({ error: "Please log in again." });
	req.user = user;
	req.token = String(token);
	next();
}

// ---- live clients (server-sent events) ----
const clients = new Set();
function onlineList() {
	const seen = new Map();
	for (const c of clients) seen.set(c.user.name, c.user);
	return [...seen.values()].map(publicUser).sort((a, b) => a.name.localeCompare(b.name));
}
function broadcast(event, data) {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const c of clients) c.res.write(payload);
}
setInterval(() => {
	for (const c of clients) c.res.write(": ping\n\n");
}, 25e3).unref();

export function chatRouter() {
	const r = express.Router();
	r.use(express.json({ limit: "2kb" }));

	async function hash(password, salt) {
		return (await scrypt(password, salt, 32)).toString("hex");
	}

	r.post("/signup", async (req, res) => {
		if (limited("su:" + req.ip, 6, 3600e3)) return res.status(429).json({ error: "Too many accounts created from this network. Try again later." });
		const { username, password } = req.body || {};
		if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{3,20}$/.test(username))
			return res.status(400).json({ error: "Username must be 3-20 characters: letters, numbers, . _ -" });
		if (typeof password !== "string" || password.length < 6 || password.length > 100)
			return res.status(400).json({ error: "Password must be at least 6 characters." });
		const key = username.toLowerCase();
		if (RESERVED.test(username)) return res.status(400).json({ error: "That username isn't available." });
		if (db.users[key]) return res.status(409).json({ error: "That username is taken." });
		if (Object.keys(db.users).length >= MAX_USERS) return res.status(503).json({ error: "Sign-ups are closed right now." });
		const salt = crypto.randomBytes(16).toString("hex");
		const user = {
			name: username,
			salt,
			hash: await hash(password, salt),
			hue: Math.floor(Math.random() * 360),
			created: Date.now(),
		};
		if (db.users[key]) return res.status(409).json({ error: "That username is taken." });
		db.users[key] = user;
		res.json({ token: newSession(user), user: publicUser(user) });
	});

	r.post("/login", async (req, res) => {
		if (limited("li:" + req.ip, 10, 60e3)) return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
		const { username, password } = req.body || {};
		const uname = typeof username === "string" ? username.toLowerCase().slice(0, 40) : "";
		if (failCount("u:" + uname) >= 6) return res.status(429).json({ error: "Too many wrong passwords for that account. Try again in 10 minutes." });
		const user = uname && db.users[uname];
		const bad = () => {
			addFail("u:" + uname);
			return res.status(401).json({ error: "Wrong username or password." });
		};
		if (!user || typeof password !== "string" || password.length > 100) return bad();
		const a = Buffer.from(await hash(password, user.salt), "hex");
		const b = Buffer.from(user.hash, "hex");
		if (!crypto.timingSafeEqual(a, b)) return bad();
		fails.delete("u:" + uname);
		res.json({ token: newSession(user), user: publicUser(user) });
	});

	r.post("/logout", auth, (req, res) => {
		delete db.sessions[sha(req.token)];
		save();
		res.json({ ok: true });
	});

	r.get("/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

	r.get("/history", auth, (req, res) => {
		const ch = String(req.query.channel);
		if (!CHANNELS.includes(ch)) return res.status(400).json({ error: "Unknown channel." });
		res.json({ messages: db.messages[ch].slice(-100) });
	});

	r.post("/send", auth, (req, res) => {
		const { channel, text } = req.body || {};
		if (!CHANNELS.includes(channel)) return res.status(400).json({ error: "Unknown channel." });
		const t = typeof text === "string" ? cleanText(text.slice(0, 1000)).slice(0, 500) : "";
		if (!t) return res.status(400).json({ error: "Message is empty." });
		if (limited("msg:" + req.user.name, 8, 10e3)) return res.status(429).json({ error: "Slow down a little." });
		if ((t.match(/https?:\/\//gi) || []).length > 3) return res.status(400).json({ error: "Too many links in one message." });
		const last = db.messages[channel].filter((m) => m.u === req.user.name).slice(-1)[0];
		if (last && last.t === t && Date.now() - last.ts < 30e3) return res.status(429).json({ error: "You just sent that." });
		const msg = {
			id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
			ch: channel,
			u: req.user.name,
			h: req.user.hue,
			t,
			ts: Date.now(),
		};
		const list = db.messages[channel];
		list.push(msg);
		if (list.length > KEEP) list.splice(0, list.length - KEEP);
		save();
		broadcast("message", msg);
		res.json({ ok: true });
	});

	r.post("/ticket", auth, (req, res) => {
		const ticket = crypto.randomBytes(24).toString("hex");
		tickets.set(ticket, { user: req.user, exp: Date.now() + 60e3 });
		res.json({ ticket });
	});

	r.get("/stream", (req, res) => {
		const t = tickets.get(String(req.query.ticket || ""));
		tickets.delete(String(req.query.ticket || ""));
		if (!t || t.exp < Date.now()) return res.status(401).json({ error: "Please reconnect." });
		const mine = [...clients].filter((c) => c.user === t.user).length;
		const fromIp = [...clients].filter((c) => c.ip === req.ip).length;
		if (mine >= MAX_STREAMS_PER_USER || fromIp >= MAX_STREAMS_PER_IP) return res.status(429).json({ error: "Too many open chat connections." });
		req.user = t.user;
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		const client = { res, user: req.user, ip: req.ip };
		clients.add(client);
		res.write(`event: online\ndata: ${JSON.stringify(onlineList())}\n\n`);
		broadcast("online", onlineList());
		req.on("close", () => {
			clients.delete(client);
			broadcast("online", onlineList());
		});
	});

	return r;
}
