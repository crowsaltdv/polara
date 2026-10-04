import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";

const scrypt = promisify(crypto.scrypt);

export const CHANNELS = ["general", "links"];
// On a host, point POLARIS_DATA_DIR at a persistent disk/volume so accounts and messages survive restarts and redeploys.
const DIR = process.env.POLARIS_DATA_DIR || path.join(import.meta.dirname, "data");
const FILE = path.join(DIR, "chat.json"); // accounts and login sessions
const MSG_FILE = path.join(DIR, "messages.jsonl"); // every message ever sent, one per line, only ever appended to
const MEMORY_PER_CHANNEL = 50000; // newest messages kept ready in memory (older ones stay in the file)
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_USERS = 100000;
const MAX_STREAMS_TOTAL = 20000;
const MAX_TEXT = 2000;
// names that could be mistaken for staff or the system
const RESERVED = /^(admin|administrator|mod|moderator|staff|support|system|polaris|owner|official|root|server|bot|null|undefined)$/i;
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

// messages: the append-only log (older versions kept them inside chat.json, so those are carried over once)
function loadMessages() {
	if (fs.existsSync(MSG_FILE)) {
		for (const line of fs.readFileSync(MSG_FILE, "utf8").split("\n")) {
			if (!line) continue;
			try {
				const m = JSON.parse(line);
				if (messages[m.ch]) messages[m.ch].push(m);
			} catch {}
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
}
loadMessages();
let lastTs = Math.max(0, ...CHANNELS.map((c) => messages[c].at(-1)?.ts || 0));

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
const publicUser = (u) => ({ name: u.name, hue: u.hue });

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
		res.json({ token: newSession(user), user: publicUser(user) });
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
		fails.delete("u:" + uname);
		res.json({ token: newSession(user), user: publicUser(user) });
	});

	r.post("/logout", auth, (req, res) => {
		delete db.sessions[sha(req.token)];
		save();
		res.json({ ok: true });
	});

	r.get("/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

	// ?after=<time>  only messages newer than that   |   ?before=<time>&limit=<n>  a page of older messages
	r.get("/history", auth, (req, res) => {
		const ch = String(req.query.channel);
		if (!CHANNELS.includes(ch)) return res.status(400).json({ error: "Unknown channel." });
		const after = Number(req.query.after) || 0;
		if (after) return res.json({ messages: newer(messages[ch], after).slice(-500) });
		const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
		res.json(olderPage(messages[ch], Number(req.query.before) || 0, limit));
	});

	r.post("/send", auth, (req, res) => {
		const { channel, text } = req.body || {};
		if (!CHANNELS.includes(channel)) return res.status(400).json({ error: "Unknown channel." });
		const t = typeof text === "string" ? cleanText(text.slice(0, MAX_TEXT * 2)).slice(0, MAX_TEXT) : "";
		if (!t) return res.status(400).json({ error: "Message is empty." });
		lastTs = Math.max(Date.now(), lastTs + 1); // strictly increasing, so paging by time never skips a message
		const msg = {
			id: lastTs.toString(36) + crypto.randomBytes(3).toString("hex"),
			ch: channel,
			u: req.user.name,
			h: req.user.hue,
			t,
			ts: lastTs,
		};
		const list = messages[channel];
		list.push(msg);
		if (list.length > MEMORY_PER_CHANNEL) list.shift(); // only trims memory; the message stays in the file
		queue.push(JSON.stringify(msg) + "\n");
		pump();
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
