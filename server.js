import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import express from "express";
import { bootstrap } from "@mercuryworkshop/proxy-bootstrap";
import { chatRouter } from "./chat.js";
import { musicRouter } from "./music.js";
import { rateLimit, securityHeaders, configureWisp, guardUpgrades } from "./security.js";

// A public site must not go down because one odd connection hit a bug: log it and keep serving.
process.on("uncaughtException", (err) => console.error("Unexpected error (still running):", err));
process.on("unhandledRejection", (err) => console.error("Unexpected rejection (still running):", err));

// Scramjet bootstrap: serves /sw.js, /bootstrap-init.js, /controller/*, /scram/*,
// /clients/* and the /wisp/ websocket that the proxy tunnels traffic through.
configureWisp();
const { routeRequest, routeUpgrade } = await bootstrap();

const app = express();
const PORT = process.env.PORT || 3030;
app.disable("x-powered-by");

// Behind a reverse proxy / CDN (Cloudflare, Caddy, nginx...), set TRUST_PROXY=1 so rate limits see real visitor IPs.
const TRUST = process.env.TRUST_PROXY;
if (TRUST) app.set("trust proxy", /^\d+$/.test(TRUST) ? Number(TRUST) : TRUST);
const visitorIp = (req) => (TRUST ? String(req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.socket.remoteAddress : req.socket.remoteAddress);

app.use(securityHeaders);
app.use((req, res, next) => {
	if (routeRequest(req, res)) return;
	next();
});

app.use("/api", rateLimit({ windowMs: 60e3, max: 300 }));
app.use("/api/chat", chatRouter());
app.use("/api/music", musicRouter());

// Google Fonts catalog for the font picker (via fontsource's public metadata), cached for a day
let fonts = null;
let fontsAt = 0;
app.get("/api/fonts", async (req, res) => {
	try {
		if (!fonts || Date.now() - fontsAt > 864e5) {
			const r = await fetch("https://api.fontsource.org/v1/fonts?type=google", { signal: AbortSignal.timeout(12000) });
			if (!r.ok) throw new Error(`fontsource ${r.status}`);
			const list = await r.json();
			fonts = list.map((f) => [f.family, f.category, f.weights]);
			fontsAt = Date.now();
		}
		res.set("Cache-Control", "public, max-age=3600").json(fonts);
	} catch {
		if (fonts) return res.json(fonts);
		res.status(502).json({ error: "Font catalog unavailable" });
	}
});

// ---- image proxy: lets the WebGL rain effect read remote background images (browsers block that without CORS) ----
function privateAddress(ip) {
	if (net.isIPv6(ip)) {
		const l = ip.toLowerCase();
		if (l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || /^fe[89ab]/.test(l)) return true;
		const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		return m ? privateAddress(m[1]) : false;
	}
	const [a, b] = ip.split(".").map(Number);
	return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
// checked at connection time, so a hostname can't switch to an internal address between the check and the request
function guardedLookup(hostname, options, cb) {
	dns.lookup(hostname, { all: true }).then(
		(addrs) => {
			if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return cb(new Error("blocked address"));
			if (options && options.all) cb(null, addrs);
			else cb(null, addrs[0].address, addrs[0].family);
		},
		(err) => cb(err),
	);
}
const IMG_TYPE = /^image\/(png|jpe?g|webp|gif|avif)(;|$)/i;
function fetchImage(url, hops = 0) {
	return new Promise((resolve, reject) => {
		if (hops > 3 || !/^https?:$/.test(url.protocol)) return reject(new Error("bad url"));
		if (net.isIP(url.hostname) && privateAddress(url.hostname)) return reject(new Error("blocked address"));
		const lib = url.protocol === "https:" ? https : http;
		const req = lib.get(url, { lookup: guardedLookup, timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 (Polaris image proxy)", Accept: "image/*" } }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				try {
					return resolve(fetchImage(new URL(res.headers.location, url), hops + 1));
				} catch (e) {
					return reject(e);
				}
			}
			const type = res.headers["content-type"] || "";
			if (res.statusCode !== 200 || !IMG_TYPE.test(type)) {
				res.resume();
				return reject(new Error("not an image"));
			}
			const chunks = [];
			let size = 0;
			res.on("data", (c) => {
				size += c.length;
				if (size > 25e6) return req.destroy(new Error("too large"));
				chunks.push(c);
			});
			res.on("end", () => resolve({ type: type.split(";")[0], buf: Buffer.concat(chunks) }));
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", reject);
	});
}
app.get("/api/img", rateLimit({ windowMs: 60e3, max: 40 }), async (req, res) => {
	try {
		const { type, buf } = await fetchImage(new URL(String(req.query.u || "")));
		res.set({
			"Content-Type": type,
			"Cache-Control": "public, max-age=86400",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		}).send(buf);
	} catch {
		res.status(502).end();
	}
});

// ---- static files: only the site itself is public (never server code, data, dotfiles or package files) ----
const PUBLIC = /^\/(?:$|index\.html$|games\.js$|games\/|vendor\/)/;
app.use((req, res, next) => (PUBLIC.test(req.path) ? next() : res.status(404).end()));
app.use(express.static(import.meta.dirname, { dotfiles: "deny" }));

// never leak stack traces
app.use((err, req, res, next) => {
	if (res.headersSent) return next(err);
	res.status(err.status >= 400 && err.status < 500 ? err.status : 500).json({ error: "That request couldn't be processed." });
});

const server = http.createServer(app);
server.requestTimeout = 60e3;
server.headersTimeout = 20e3;
server.maxHeadersCount = 100;
guardUpgrades(server, routeUpgrade, visitorIp);

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") {
		console.error(`\nPolaris can't start: port ${PORT} is already in use.\nAnother copy is probably still running. Close its window (or end node.exe in Task Manager) and run start.bat again.\n`);
	} else {
		console.error(err);
	}
	process.exit(1);
});

server.listen(PORT, () => {
	console.log(`Polaris is running on http://localhost:${PORT}`);
});
