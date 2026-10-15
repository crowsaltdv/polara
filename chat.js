import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";

const scrypt = promisify(crypto.scrypt);

export const CHANNELS = ["general", "links"];
// On a host, point LUNARIS_DATA_DIR at a persistent disk/volume so accounts and messages survive restarts and redeploys.
const DIR = (process.env.LUNARIS_DATA_DIR || process.env.POLARIS_DATA_DIR) || path.join(import.meta.dirname, "data");
const FILE = path.join(DIR, "chat.json"); // accounts and login sessions
const MSG_FILE = path.join(DIR, "messages.jsonl"); // every message ever sent, one per line, only ever appended to
const MEMORY_PER_CHANNEL = 50000; // newest messages kept ready in memory (older ones stay in the file)
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_USERS = 100000;
const MAX_STREAMS_TOTAL = 20000;
const MAX_TEXT = 2000;
const MAX_IMG = 3 * 1024 * 1024; // chat pictures (the page shrinks them before uploading, so most are far smaller)
const MAX_AVATAR = 400 * 1024;
const UPLOAD_QUOTA = (Number(process.env.CHAT_UPLOAD_MAX_MB) || 2000) * 1e6; // total space for chat pictures
const MAX_DM_MEMORY = 5000; // newest messages kept in memory per private conversation (older ones stay in the file)
// GIF search is powered by KLIPY (https://partner.klipy.com): set KLIPY_API_KEY on the server to turn it on
const KLIPY_KEY = process.env.KLIPY_API_KEY || "";
const KLIPY_BASE = (process.env.KLIPY_BASE || "https://api.klipy.com").replace(/\/+$/, "");
const KLIPY_FILTER = ["off", "low", "medium", "high"].includes(process.env.KLIPY_CONTENT_FILTER) ? process.env.KLIPY_CONTENT_FILTER : "medium";
// names that could be mistaken for staff or the system
const RESERVED = /^(admin|administrator|mod|moderator|staff|support|system|polaris|lunaris|sawyer|owner|official|root|server|bot|null|undefined)$/i;
// control characters and invisible/bidirectional-override characters used to spoof or break layouts
const JUNK = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const cleanText = (s) => s.replace(JUNK, "").replace(/\n{3,}/g, "\n\n").trim();

fs.mkdirSync(DIR, { recursive: true });

// ---------- loading ----------
const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};
let saved = readJson(FILE);
if (!saved && fs.existsSync(FILE)) {
	// the file is damaged: keep a copy for inspection and fall back to the last good backup instead of starting empty
	try {
		fs.copyFileSync(FILE, `${FILE}.corrupt-${Date.now()}`);
	} catch {}
	saved = readJson(FILE + ".bak");
	console.error("chat.json was unreadable; restored from chat.json.bak" + (saved ? "" : " (no usable backup found)"));
}
const db = { users: saved?.users || {}, sessions: saved?.sessions || {} };
const messages = Object.fromEntries(CHANNELS.map((c) => [c, []]));
const dms = new Map(); // "dm:alice~bob" -> messages of that private conversation
const dmIndex = new Map(); // user -> Map(other user -> { ts, from }), for the conversation list
const dmKey = (a, b) => "dm:" + [a.toLowerCase(), b.toLowerCase()].sort().join("~");
function addDm(m, trim) {
	let list = dms.get(m.ch);
	if (!list) dms.set(m.ch, (list = []));
	list.push(m);
	if (trim && list.length > MAX_DM_MEMORY) list.shift(); // only trims memory; the message stays in the file
	const [a, b] = m.ch.slice(3).split("~");
	for (const [x, y] of [[a, b], [b, a]]) {
		if (!dmIndex.has(x)) dmIndex.set(x, new Map());
		dmIndex.get(x).set(y, { ts: m.ts, from: m.u });
	}
}

// messages: the append-only log (older versions kept them inside chat.json, so those are carried over once)
function loadMessages() {
	if (fs.existsSync(MSG_FILE)) {
		const deleted = new Set();
		for (const line of fs.readFileSync(MSG_FILE, "utf8").split("\n")) {
			if (!line) continue;
			try {
				const m = JSON.parse(line);
				if (m.del) deleted.add(m.del);
				else if (messages[m.ch]) messages[m.ch].push(m);
				else if (typeof m.ch === "string" && m.ch.startsWith("dm:")) addDm(m, false);
			} catch {}
		}
		if (deleted.size) {
			for (const ch of CHANNELS) messages[ch] = messages[ch].filter((m) => !deleted.has(m.id));
			for (const [k, list] of dms) dms.set(k, list.filter((m) => !deleted.has(m.id)));
		}
	} else if (saved?.messages) {
		const lines = [];
		for (const ch of CHANNELS) {
			for (const m of saved.messages[ch] || []) {
				messages[ch].push(m);
				lines.push(JSON.stringify(m));
			}
		}
		if (lines.length) fs.writeFileSync(MSG_FILE, lines.join("\n") + "\n");
	}
	for (const ch of CHANNELS) {
		messages[ch].sort((a, b) => a.ts - b.ts);
		if (messages[ch].length > MEMORY_PER_CHANNEL) messages[ch].splice(0, messages[ch].length - MEMORY_PER_CHANNEL);
	}
	for (const list of dms.values()) {
		list.sort((a, b) => a.ts - b.ts);
		if (list.length > MAX_DM_MEMORY) list.splice(0, list.length - MAX_DM_MEMORY);
	}
}
loadMessages();
let lastTs = Math.max(0, ...CHANNELS.map((c) => messages[c].at(-1)?.ts || 0), ...[...dms.values()].map((l) => l.at(-1)?.ts || 0));

// ---------- saving ----------
const queue = [];
let appending = false;
function pump() {
	if (appending || !queue.length) return;
	appending = true;
	fs.appendFile(MSG_FILE, queue.splice(0).join(""), (err) => {
		if (err) console.error("couldn't save messages:", err);
		appending = false;
		pump();
	});
}

let saveTimer;
let saving = false;
let pending = false;
function save() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(writeUsers, 400);
}
function writeUsers() {
	if (saving) {
		pending = true; // never run two writes at once
		return;
	}
	saving = true;
	const done = () => {
		saving = false;
		if (pending) {
			pending = false;
			writeUsers();
		}
	};
	fs.writeFile(FILE + ".tmp", JSON.stringify({ users: db.users, sessions: db.sessions }), (err) => {
		if (err) {
			console.error("couldn't save accounts:", err);
			return done();
		}
		fs.copyFile(FILE, FILE + ".bak", () => fs.rename(FILE + ".tmp", FILE, () => done()));
	});
}
process.on("exit", () => {
	try {
		if (queue.length) fs.appendFileSync(MSG_FILE, queue.splice(0).join(""));
		fs.writeFileSync(FILE, JSON.stringify({ users: db.users, sessions: db.sessions }));
	} catch {}
});

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// The account named exactly "sawyer" is the owner and always an admin. Its password comes from ADMIN_PASSWORD (in .env locally, or an
// environment variable on a host) and is reset to it on every start, so the account can't be taken over or locked out by a rename.
// Without ADMIN_PASSWORD there is no owner. The owner can make other accounts admins; admins can delete messages, ban people and read DMs.
const OWNER = "sawyer";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const isOwner = (u) => !!u && u.name === OWNER && u.owner === true;
const isAdmin = (u) => !!u && (isOwner(u) || u.admin === true);
const publicUser = (u) => ({ name: u.name, hue: u.hue, av: u.av || 0, admin: isAdmin(u), owner: isOwner(u) });
const blockedOf = (u) => u.blocked || [];
async function ensureOwner() {
	if (!ADMIN_PASSWORD) {
		console.warn("ADMIN_PASSWORD is not set, so the \"sawyer\" admin account is switched off.");
		return;
	}
	const pw = async (password, salt) => (await scrypt(password, salt, 32)).toString("hex");
	let u = db.users[OWNER];
	let changed = false;
	if (!u) {
		u = db.users[OWNER] = { name: OWNER, hue: Math.floor(Math.random() * 360), created: Date.now() };
		changed = true;
	}
	if (u.name !== OWNER || u.owner !== true || u.banned) changed = true;
	u.name = OWNER;
	u.owner = true;
	delete u.banned;
	let same = false;
	if (u.salt && u.hash) same = crypto.timingSafeEqual(Buffer.from(await pw(ADMIN_PASSWORD, u.salt), "hex"), Buffer.from(u.hash, "hex"));
	if (!same) {
		u.salt = crypto.randomBytes(16).toString("hex");
		u.hash = await pw(ADMIN_PASSWORD, u.salt);
		changed = true;
	}
	if (changed) save();
}
ensureOwner().catch((e) => console.error("couldn't set up the owner account:", e));

// ---------- sessions ----------
// failed-login tracking per account, so a stranger can't guess one person's password
const fails = new Map();
const failCount = (key) => (fails.get(key) || []).filter((t) => Date.now() - t < 600e3).length;
const addFail = (key) => fails.set(key, [...(fails.get(key) || []).filter((t) => Date.now() - t < 600e3), Date.now()]);

function pruneSessions() {
	let changed = false;
	for (const [k, s] of Object.entries(db.sessions)) {
		if (Date.now() - s.created > SESSION_MS || !db.users[s.user]) {
			delete db.sessions[k];
			changed = true;
		}
	}
	if (changed) save();
}
pruneSessions();
setInterval(() => {
	for (const k of fails.keys()) if (!failCount(k)) fails.delete(k);
	pruneSessions();
}, 3600e3).unref();

function newSession(user) {
	const token = crypto.randomBytes(32).toString("hex");
	db.sessions[sha(token)] = { user: user.name.toLowerCase(), created: Date.now() };
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
	if (user.banned) return res.status(403).json({ error: "You are banned from chat.", banned: true });
	req.user = user;
	req.token = String(token);
	next();
}

// ---------- live clients (server-sent events) ----------
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
// private messages only go to the two people in the conversation
function sendTo(names, event, data) {
	const want = new Set(names.map((n) => n.toLowerCase()));
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const c of clients) if (want.has(c.user.name.toLowerCase())) c.res.write(payload);
}
setInterval(() => {
	for (const c of clients) c.res.write(": ping\n\n");
}, 25e3).unref();

// ---------- history helpers ----------
// messages are in time order, so "newer than" and "older than" can be found by walking from the end
function newer(list, ts) {
	let i = list.length;
	while (i > 0 && list[i - 1].ts > ts) i--;
	return list.slice(i);
}
function olderPage(list, before, limit) {
	let end = list.length;
	if (before) while (end > 0 && list[end - 1].ts >= before) end--;
	const start = Math.max(0, end - limit);
	return { messages: list.slice(start, end), more: start > 0 };
}

// ---------- pictures ----------
const UP_DIR = path.join(DIR, "uploads");
const AV_DIR = path.join(DIR, "avatars");
fs.mkdirSync(UP_DIR, { recursive: true });
fs.mkdirSync(AV_DIR, { recursive: true });
const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// works out what a file really is (and how big the picture is) from its first bytes, ignoring whatever the browser claims
function sniff(b) {
	try {
		if (b.length > 24 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return { ext: "png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
		if (b.length > 10 && b.toString("latin1", 0, 3) === "GIF") return { ext: "gif", w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
		if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
			let i = 2;
			while (i + 9 < b.length) {
				if (b[i] !== 0xff) {
					i++;
					continue;
				}
				const m = b[i + 1];
				if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
					i += m === 0xff ? 1 : 2;
					continue;
				}
				if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { ext: "jpg", h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
				i += 2 + b.readUInt16BE(i + 2);
			}
			return null;
		}
		if (b.length > 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
			const k = b.toString("latin1", 12, 16);
			if (k === "VP8 ") return { ext: "webp", w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
			if (k === "VP8L") {
				const v = b.readUInt32LE(21);
				return { ext: "webp", w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
			}
			if (k === "VP8X") return { ext: "webp", w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
		}
	} catch {}
	return null;
}
const sizeOk = (i) => i && i.w > 0 && i.h > 0 && i.w <= 10000 && i.h <= 10000 && i.w * i.h <= 50e6;

const uploads = new Map(); // picture id -> { ext, w, h }
let uploadBytes = 0;
for (const f of fs.readdirSync(UP_DIR)) {
	const m = /^([a-f0-9]{32})\.(png|jpg|gif|webp)$/.exec(f);
	if (!m) continue;
	try {
		const file = path.join(UP_DIR, f);
		const fd = fs.openSync(file, "r");
		const head = Buffer.alloc(131072);
		const n = fs.readSync(fd, head, 0, head.length, 0);
		fs.closeSync(fd);
		const info = sniff(head.subarray(0, n));
		uploadBytes += fs.statSync(file).size;
		if (sizeOk(info)) uploads.set(m[1], { ext: m[2], w: info.w, h: info.h, size: fs.statSync(file).size });
	} catch {}
}
const uploadLog = new Map(); // user -> recent upload times
const avatarFile = (u, ext) => path.join(AV_DIR, crypto.createHash("sha1").update(u.name.toLowerCase()).digest("hex").slice(0, 24) + "." + ext);

// ---------- GIFs (KLIPY) ----------
const gifHosts = new Set(); // hosts KLIPY handed out; together with klipy's own domains, the only places a message may point a GIF
const gifHostOk = (h) => /(^|\.)klipy\.(com|co)$/i.test(h) || gifHosts.has(h.toLowerCase());
const gifCache = new Map();
let gifCalls = [];
const clampInt = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

// ---------- theme cards ----------
const HEX = /^#[0-9a-f]{6}$/i;
function cleanTheme(t) {
	if (!t || typeof t !== "object" || !HEX.test(t.bg) || !HEX.test(t.ac)) return null;
	const out = { n: String(t.n || "").replace(JUNK, "").trim().slice(0, 40) || "Shared theme", bg: t.bg.toLowerCase(), ac: t.ac.toLowerCase() };
	if (typeof t.bi === "string" && /^https:\/\/[^\s"'<>\\]{4,500}$/.test(t.bi)) out.bi = t.bi;
	if (Number.isFinite(t.d)) out.d = Math.min(0.85, Math.max(0, Math.round(t.d * 100) / 100));
	if (Number.isFinite(t.bl)) out.bl = Math.min(30, Math.max(0, Math.round(t.bl)));
	if (typeof t.r === "boolean") out.r = t.r;
	if (typeof t.f === "string" && /^[A-Za-z0-9 ]{1,60}$/.test(t.f)) out.f = t.f;
	return out;
}

// one place builds every message (channel or private): text, a picture, a GIF or a theme card
function composeMessage(user, ch, body) {
	const part = {};
	const t = typeof body.text === "string" ? cleanText(body.text.slice(0, MAX_TEXT * 2)).slice(0, MAX_TEXT) : "";
	if (t) part.t = t;
	if (body.img != null) {
		const id = String((body.img && body.img.id) || "");
		const meta = uploads.get(id);
		if (!meta) return { error: "That picture isn't available." };
		part.img = { id, w: meta.w, h: meta.h };
	}
	if (body.gif != null) {
		let u;
		try {
			u = new URL(String(body.gif && body.gif.u));
		} catch {
			return { error: "That GIF isn't valid." };
		}
		if (u.protocol !== "https:" || !gifHostOk(u.hostname)) return { error: "That GIF isn't valid." };
		part.gif = { u: u.href, w: clampInt(body.gif.w, 20, 1000, 200), h: clampInt(body.gif.h, 20, 1000, 200), t: cleanText(String(body.gif.t || "").slice(0, 100)) };
	}
	if (body.theme != null) {
		const th = cleanTheme(body.theme);
		if (!th) return { error: "That theme isn't valid." };
		part.th = th;
	}
	if (!part.t && !part.img && !part.gif && !part.th) return { error: "Message is empty." };
	lastTs = Math.max(Date.now(), lastTs + 1); // strictly increasing, so paging by time never skips a message
	return { msg: { id: lastTs.toString(36) + crypto.randomBytes(3).toString("hex"), ch, u: user.name, h: user.hue, ...part, ts: lastTs } };
}
// which of the people in these messages have a profile picture (so the page knows where to look)
function avatarsFor(list) {
	const out = {};
	for (const m of list) {
		const u = db.users[m.u.toLowerCase()];
		if (u && u.av) out[u.name] = u.av;
	}
	return out;
}

export function chatRouter() {
	const r = express.Router();
	r.use(express.json({ limit: "16kb" }));

	async function hash(password, salt) {
		return (await scrypt(password, salt, 32)).toString("hex");
	}

	r.post("/signup", async (req, res) => {
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
		res.json({ token: newSession(user), user: publicUser(user), blocked: [] });
	});

	r.post("/login", async (req, res) => {
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
		if (user.banned) return res.status(403).json({ error: "You are banned from chat.", banned: true });
		fails.delete("u:" + uname);
		res.json({ token: newSession(user), user: publicUser(user), blocked: blockedOf(user) });
	});

	r.post("/logout", auth, (req, res) => {
		delete db.sessions[sha(req.token)];
		save();
		res.json({ ok: true });
	});

	r.get("/me", auth, (req, res) => res.json({ user: publicUser(req.user), blocked: blockedOf(req.user) }));

	// ?after=<time>  only messages newer than that   |   ?before=<time>&limit=<n>  a page of older messages
	r.get("/history", auth, (req, res) => {
		const ch = String(req.query.channel);
		if (!CHANNELS.includes(ch)) return res.status(400).json({ error: "Unknown channel." });
		const after = Number(req.query.after) || 0;
		if (after) {
			const list = newer(messages[ch], after).slice(-500);
			return res.json({ messages: list, av: avatarsFor(list) });
		}
		const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
		const page = olderPage(messages[ch], Number(req.query.before) || 0, limit);
		res.json({ ...page, av: avatarsFor(page.messages) });
	});

	r.post("/send", auth, (req, res) => {
		const body = req.body || {};
		if (!CHANNELS.includes(body.channel)) return res.status(400).json({ error: "Unknown channel." });
		const c = composeMessage(req.user, body.channel, body);
		if (c.error) return res.status(400).json({ error: c.error });
		const list = messages[body.channel];
		list.push(c.msg);
		if (list.length > MEMORY_PER_CHANNEL) list.shift(); // only trims memory; the message stays in the file
		queue.push(JSON.stringify(c.msg) + "\n");
		pump();
		broadcast("message", { ...c.msg, av: req.user.av || 0 });
		res.json({ ok: true });
	});

	// ---- private messages ----
	const findUser = (name) => (typeof name === "string" ? db.users[name.toLowerCase().slice(0, 40)] : null);
	r.get("/dm/list", auth, (req, res) => {
		const idx = dmIndex.get(req.user.name.toLowerCase()) || new Map();
		const out = [...idx]
			.map(([other, v]) => {
				const u = db.users[other];
				return u ? { name: u.name, hue: u.hue, av: u.av || 0, ts: v.ts, from: v.from } : null;
			})
			.filter(Boolean)
			.sort((a, b) => b.ts - a.ts)
			.slice(0, 100);
		res.json({ dms: out });
	});
	r.get("/dm/history", auth, (req, res) => {
		const other = findUser(req.query.with);
		if (!other) return res.status(404).json({ error: "That user doesn't exist." });
		const list = dms.get(dmKey(req.user.name, other.name)) || [];
		const after = Number(req.query.after) || 0;
		if (after) {
			const msgs = newer(list, after).slice(-500);
			return res.json({ messages: msgs, av: avatarsFor(msgs) });
		}
		const page = olderPage(list, Number(req.query.before) || 0, Math.min(200, Math.max(1, Number(req.query.limit) || 100)));
		res.json({ ...page, av: avatarsFor(page.messages), user: publicUser(other) });
	});
	r.post("/dm/send", auth, (req, res) => {
		const body = req.body || {};
		const to = findUser(body.to);
		if (!to) return res.status(404).json({ error: "That user doesn't exist." });
		if (to === req.user) return res.status(400).json({ error: "You can't message yourself." });
		if (blockedOf(to).includes(req.user.name.toLowerCase())) return res.status(403).json({ error: "You can't message this user." });
		if (blockedOf(req.user).includes(to.name.toLowerCase())) return res.status(403).json({ error: "You blocked this user. Unblock them to send a message." });
		const c = composeMessage(req.user, dmKey(req.user.name, to.name), body);
		if (c.error) return res.status(400).json({ error: c.error });
		addDm(c.msg, true);
		queue.push(JSON.stringify(c.msg) + "\n");
		pump();
		sendTo([req.user.name, to.name], "dm", { ...c.msg, av: req.user.av || 0 });
		res.json({ ok: true });
	});
	const setBlock = (on) => (req, res) => {
		const other = findUser((req.body || {}).name);
		if (!other || other === req.user) return res.status(400).json({ error: "That isn't a user you can block." });
		const set = new Set(blockedOf(req.user));
		if (on) set.add(other.name.toLowerCase());
		else set.delete(other.name.toLowerCase());
		req.user.blocked = [...set].slice(0, 500);
		save();
		res.json({ blocked: req.user.blocked });
	};
	r.post("/block", auth, setBlock(true));
	r.post("/unblock", auth, setBlock(false));

	// ---- profiles and admin tools ----
	const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: "Admins only." }));
	const ownerOnly = (req, res, next) => (isOwner(req.user) ? next() : res.status(403).json({ error: "Only the owner can do that." }));
	const isOnline = (u) => [...clients].some((c) => c.user === u);
	r.get("/profile", auth, (req, res) => {
		const u = findUser(req.query.name);
		if (!u) return res.status(404).json({ error: "That user doesn't exist." });
		const out = { ...publicUser(u), created: u.created || 0, online: isOnline(u), blockedByMe: blockedOf(req.user).includes(u.name.toLowerCase()) };
		if (isAdmin(req.user)) out.banned = !!u.banned;
		res.json(out);
	});
	// cuts the account's live connections right away (its sign-ins stay, so every request from it is answered with "banned")
	function kick(u) {
		for (const c of [...clients]) {
			if (c.user === u) {
				try {
					c.res.end();
				} catch {}
				clients.delete(c);
			}
		}
		broadcast("online", onlineList());
	}
	function removeMessage(id, ch, by) {
		const list = CHANNELS.includes(ch) ? messages[ch] : typeof ch === "string" && ch.startsWith("dm:") ? dms.get(ch) : null;
		if (!list) return false;
		const i = list.findIndex((m) => m.id === id);
		if (i < 0) return false;
		const [m] = list.splice(i, 1);
		queue.push(JSON.stringify({ del: id, ch, by, ts: Date.now() }) + "\n"); // the log is append-only, so a deletion is recorded as its own line
		pump();
		if (m.img && uploads.has(m.img.id)) {
			const up = uploads.get(m.img.id);
			uploads.delete(m.img.id);
			uploadBytes = Math.max(0, uploadBytes - (up.size || 0));
			fs.unlink(path.join(UP_DIR, `${m.img.id}.${up.ext}`), () => {});
		}
		if (CHANNELS.includes(ch)) broadcast("delete", { id, ch });
		else sendTo(ch.slice(3).split("~"), "delete", { id, ch });
		return true;
	}
	r.post("/admin/delete", auth, adminOnly, (req, res) => {
		const { id, channel } = req.body || {};
		if (!removeMessage(String(id), channel, req.user.name)) return res.status(404).json({ error: "That message is already gone." });
		res.json({ ok: true });
	});
	const canModerate = (req, target) => target && target !== req.user && !isOwner(target) && (!isAdmin(target) || isOwner(req.user));
	r.post("/admin/ban", auth, adminOnly, (req, res) => {
		const target = findUser((req.body || {}).name);
		if (!target) return res.status(404).json({ error: "That user doesn't exist." });
		if (!canModerate(req, target)) return res.status(403).json({ error: isAdmin(target) ? "Only the owner can ban another admin." : "You can't ban that account." });
		target.banned = { at: Date.now(), by: req.user.name };
		kick(target);
		save();
		res.json({ banned: true });
	});
	r.post("/admin/unban", auth, adminOnly, (req, res) => {
		const target = findUser((req.body || {}).name);
		if (!target) return res.status(404).json({ error: "That user doesn't exist." });
		delete target.banned;
		save();
		res.json({ banned: false });
	});
	r.post("/admin/promote", auth, ownerOnly, (req, res) => {
		const { name, admin } = req.body || {};
		const target = findUser(name);
		if (!target) return res.status(404).json({ error: "That user doesn't exist." });
		if (isOwner(target)) return res.status(400).json({ error: "The owner is always an admin." });
		if (admin) target.admin = true;
		else delete target.admin;
		save();
		broadcast("online", onlineList());
		res.json({ admin: !!admin });
	});
	r.get("/admin/users", auth, adminOnly, (req, res) => {
		const q = String(req.query.q || "").toLowerCase().slice(0, 20);
		const out = Object.values(db.users)
			.filter((u) => !q || u.name.toLowerCase().includes(q))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, 50)
			.map((u) => ({ ...publicUser(u), banned: !!u.banned, online: isOnline(u) }));
		res.json({ users: out });
	});
	// every private conversation, for admins
	r.get("/admin/dms", auth, adminOnly, (req, res) => {
		const q = String(req.query.user || "").toLowerCase().slice(0, 40);
		const out = [];
		for (const [key, list] of dms) {
			const [a, b] = key.slice(3).split("~");
			if (q && !a.includes(q) && !b.includes(q)) continue;
			const last = list.at(-1);
			if (!last) continue;
			out.push({ key, a: db.users[a]?.name || a, b: db.users[b]?.name || b, ts: last.ts, n: list.length, from: last.u, last: (last.t || (last.img ? "[picture]" : last.gif ? "[GIF]" : "[theme]")).slice(0, 80) });
		}
		out.sort((x, y) => y.ts - x.ts);
		res.json({ dms: out.slice(0, 200) });
	});
	r.get("/admin/dm", auth, adminOnly, (req, res) => {
		const key = String(req.query.key || "");
		if (!/^dm:[a-z0-9_.-]{1,40}~[a-z0-9_.-]{1,40}$/.test(key)) return res.status(400).json({ error: "Unknown conversation." });
		const list = dms.get(key) || [];
		const after = Number(req.query.after) || 0;
		if (after) {
			const msgs = newer(list, after).slice(-500);
			return res.json({ messages: msgs, av: avatarsFor(msgs) });
		}
		const page = olderPage(list, Number(req.query.before) || 0, Math.min(200, Math.max(1, Number(req.query.limit) || 100)));
		res.json({ ...page, av: avatarsFor(page.messages) });
	});

	// ---- pictures: the page shrinks them first; the server checks what they really are ----
	const rawBody = (limit) => express.raw({ type: () => true, limit });
	r.post("/upload", auth, rawBody(MAX_IMG), (req, res) => {
		const now = Date.now();
		const recent = (uploadLog.get(req.user.name) || []).filter((t) => now - t < 3600e3);
		if (recent.length >= 60) return res.status(429).json({ error: "That's a lot of pictures. Try again in a little while." });
		const buf = Buffer.isBuffer(req.body) ? req.body : null;
		const info = buf && buf.length ? sniff(buf) : null;
		if (!info || !sizeOk(info)) return res.status(415).json({ error: "That file isn't a picture Lunaris can use (PNG, JPEG, GIF or WebP)." });
		if (uploadBytes + buf.length > UPLOAD_QUOTA) return res.status(507).json({ error: "Picture uploads are full right now." });
		const id = crypto.randomBytes(16).toString("hex");
		fs.writeFile(path.join(UP_DIR, `${id}.${info.ext}`), buf, (err) => {
			if (err) return res.status(500).json({ error: "Couldn't save that picture." });
			uploads.set(id, { ext: info.ext, w: info.w, h: info.h, size: buf.length });
			uploadBytes += buf.length;
			uploadLog.set(req.user.name, [...recent, now]);
			res.json({ id, w: info.w, h: info.h });
		});
	});
	r.get("/img/:id", (req, res) => {
		const m = uploads.get(String(req.params.id));
		if (!m) return res.status(404).end();
		res.set("Cache-Control", "public, max-age=31536000, immutable"); // pictures never change, so browsers may keep them (the API default is no-store)
		res.sendFile(path.join(UP_DIR, `${req.params.id}.${m.ext}`), {
			maxAge: 365 * 24 * 3600e3,
			immutable: true,
			headers: { "Content-Type": MIME[m.ext], "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" },
		});
	});

	// ---- profile pictures ----
	r.post("/avatar", auth, rawBody(MAX_AVATAR), (req, res) => {
		const buf = Buffer.isBuffer(req.body) ? req.body : null;
		const info = buf && buf.length ? sniff(buf) : null;
		if (!info || !sizeOk(info) || info.ext === "gif") return res.status(415).json({ error: "Use a PNG, JPEG or WebP picture." });
		const u = req.user;
		const old = u.avx && avatarFile(u, u.avx);
		fs.writeFile(avatarFile(u, info.ext), buf, (err) => {
			if (err) return res.status(500).json({ error: "Couldn't save your picture." });
			if (old && u.avx !== info.ext) fs.unlink(old, () => {});
			u.avx = info.ext;
			u.av = Date.now();
			save();
			broadcast("profile", { name: u.name, av: u.av });
			res.json({ av: u.av });
		});
	});
	r.delete("/avatar", auth, (req, res) => {
		const u = req.user;
		if (u.avx) fs.unlink(avatarFile(u, u.avx), () => {});
		delete u.avx;
		delete u.av;
		save();
		broadcast("profile", { name: u.name, av: 0 });
		res.json({ av: 0 });
	});
	r.get("/avatar/:name", (req, res) => {
		const u = findUser(req.params.name);
		if (!u || !u.avx) return res.status(404).end();
		res.set("Cache-Control", "public, max-age=31536000, immutable"); // the page asks with ?v=<version>, so a new picture is a new address
		res.sendFile(avatarFile(u, u.avx), {
			maxAge: 365 * 24 * 3600e3,
			immutable: true,
			headers: { "Content-Type": MIME[u.avx], "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" },
		});
	});

	// ---- GIF search (KLIPY) ----
	r.get("/gifs", auth, async (req, res) => {
		if (!KLIPY_KEY) return res.status(503).json({ error: "GIF search isn't set up on this server yet (it needs a KLIPY_API_KEY)." });
		const q = String(req.query.q || "").replace(JUNK, "").trim().slice(0, 100);
		const page = clampInt(req.query.page, 1, 50, 1);
		const key = q.toLowerCase() + "|" + page;
		const hit = gifCache.get(key);
		if (hit && hit.exp > Date.now()) return res.json(hit.data);
		const now = Date.now();
		gifCalls = gifCalls.filter((t) => now - t < 60e3);
		if (gifCalls.length >= 80) return res.status(429).json({ error: "GIF search is busy. Try again in a moment." });
		gifCalls.push(now);
		const params = new URLSearchParams({ page: String(page), per_page: "24", customer_id: sha(req.user.name.toLowerCase()).slice(0, 24), content_filter: KLIPY_FILTER });
		if (q) params.set("q", q);
		try {
			const r2 = await fetch(`${KLIPY_BASE}/api/v1/${encodeURIComponent(KLIPY_KEY)}/gifs/${q ? "search" : "trending"}?${params}`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
			if (!r2.ok) throw new Error("status " + r2.status);
			const j = await r2.json();
			const pick = (size, order) => {
				const s = (size && typeof size === "object" ? size : {}) || {};
				for (const f of order) if (s[f] && typeof s[f].url === "string") return s[f];
				return null;
			};
			const items = [];
			for (const it of (j && j.data && j.data.data) || []) {
				const f = it.file || {};
				const small = pick(f.sm, ["webp", "gif"]) || pick(f.xs, ["webp", "gif"]) || pick(f.md, ["webp", "gif"]);
				// what gets sent in the chat: the smallest file that is still sharp at chat size (the hd webp is often a third of the md one)
				const sharp = ["hd", "md", "sm"].flatMap((z) => ["webp", "gif"].map((k) => (f[z] && f[z][k] && typeof f[z][k].url === "string" ? f[z][k] : null))).filter((x) => x && x.width >= 240);
				const full = sharp.sort((a, b) => (a.size || 1e12) - (b.size || 1e12))[0] || pick(f.md, ["webp", "gif"]) || pick(f.sm, ["webp", "gif"]) || pick(f.hd, ["webp", "gif"]);
				if (!small || !full) continue;
				try {
					for (const u of [small.url, full.url]) if (new URL(u).protocol === "https:") gifHosts.add(new URL(u).hostname.toLowerCase());
				} catch {
					continue;
				}
				if (gifHosts.size > 40) gifHosts.clear();
				items.push({ id: String(it.id || it.slug || items.length), t: String(it.title || "").slice(0, 100), p: small.url, pw: small.width || 0, ph: small.height || 0, u: full.url, w: full.width || 0, h: full.height || 0 });
			}
			const data = { items, next: j && j.data && j.data.has_next ? page + 1 : null };
			gifCache.set(key, { data, exp: now + 120e3 });
			if (gifCache.size > 300) gifCache.delete(gifCache.keys().next().value);
			res.json(data);
		} catch (e) {
			console.error("GIF search failed:", e && e.message);
			res.status(502).json({ error: "Couldn't reach the GIF service. Try again in a moment." });
		}
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
		if (clients.size >= MAX_STREAMS_TOTAL) return res.status(503).json({ error: "Chat is busy. Try again in a moment." });
		req.user = t.user;
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		const client = { res, user: req.user };
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
