import { server as wispServer } from "@mercuryworkshop/wisp-js/server";
import * as usage from "./usage.js";

const wisp = wispServer.options;

// ---- generic per-IP rate limiter (express middleware) ----
export function rateLimit({ windowMs = 60e3, max = 120, message = "Too many requests. Slow down a little." } = {}) {
	const hits = new Map();
	setInterval(() => {
		const now = Date.now();
		for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
	}, windowMs).unref();
	return (req, res, next) => {
		const now = Date.now();
		const arr = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
		arr.push(now);
		hits.set(req.ip, arr);
		if (arr.length > max) {
			res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
			return res.status(429).json({ error: message });
		}
		next();
	};
}

// ---- response headers ----
export function securityHeaders(req, res, next) {
	res.set({
		"Referrer-Policy": "no-referrer",
		"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
	});
	// block <object>/<embed> plugins and <base> hijacking; everything else stays open because games and the proxy need it.
	// Game pages are left out: most of them are tiny wrappers that load the game from a CDN through <base href>.
	if (!req.path.startsWith("/games/")) res.set("Content-Security-Policy", "object-src 'none'; base-uri 'self'");
	if (req.path.startsWith("/api/")) {
		res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
	}
	if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
	next();
}

// ---- the web proxy (Wisp) is the riskiest part of a public site, so lock down where it may connect ----
export function configureWisp() {
	Object.assign(wisp, {
		allow_private_ips: false, // no reaching the server's own network
		allow_loopback_ips: false,
		allow_direct_ip: false, // destinations must be hostnames, not raw IPs
		allow_udp_streams: false, // web browsing only needs TCP
		port_whitelist: [80, 443, 8080, 8443], // no SSH, mail, SMB, databases, ...
		hostname_blacklist: [
			/(^|\.)localhost$/i,
			/\.(local|internal|lan|home|corp|onion)$/i,
			// optional: refuse the big video-streaming networks, which are what burns through hosting bandwidth (PROXY_BLOCK_VIDEO=1)
			...(process.env.PROXY_BLOCK_VIDEO === "1"
				? [/(^|\.)googlevideo\.com$/i, /(^|\.)ttvnw\.net$/i, /(^|\.)twitchcdn\.net$/i, /(^|\.)tiktokcdn(-us|-eu)?\.com$/i, /(^|\.)nflxvideo\.net$/i, /(^|\.)vimeocdn\.com$/i, /(^|\.)dmcdn\.net$/i]
				: []),
		],
		stream_limit_total: 150, // open connections per visitor session
		// stream_limit_per_host stays off: in wisp-js 0.4.1 it iterates a plain object with for...of and throws,
		// which would break every connection. The total limit above and the per-IP caps below do the job.
		stream_limit_per_host: -1,
	});
}

// ---- cap proxy websocket connections per visitor, and meter + cap the data they carry ----
export function guardUpgrades(server, routeUpgrade, getIp, { maxActive = 6, maxPerMinute = 40 } = {}) {
	const active = new Map();
	const recent = new Map();
	const tracked = new Map(); // socket -> { ip, last }
	setInterval(() => {
		const now = Date.now();
		for (const [k, v] of recent) if (!v.some((t) => now - t < 60e3)) recent.delete(k);
	}, 60e3).unref();
	// every 2 seconds, count what each proxy connection moved and cut off visitors who passed their limit
	setInterval(() => {
		for (const [socket, t] of tracked) {
			const total = socket.bytesRead + socket.bytesWritten;
			usage.add("proxy", total - t.last, t.ip);
			t.last = total;
			if (usage.proxyBlocked(t.ip)) socket.destroy();
		}
	}, 2e3).unref();
	server.on("upgrade", (req, socket, head) => {
		socket.on("error", () => {});
		if (!req.url?.startsWith("/wisp/")) return socket.destroy();
		const ip = getIp(req);
		const now = Date.now();
		const arr = (recent.get(ip) || []).filter((t) => now - t < 60e3);
		arr.push(now);
		recent.set(ip, arr);
		if (usage.proxyBlocked(ip)) {
			socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return socket.destroy();
		}
		if ((active.get(ip) || 0) >= maxActive || arr.length > maxPerMinute) {
			socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return socket.destroy();
		}
		active.set(ip, (active.get(ip) || 0) + 1);
		tracked.set(socket, { ip, last: 0 });
		socket.on("close", () => {
			const t = tracked.get(socket);
			if (t) usage.add("proxy", socket.bytesRead + socket.bytesWritten - t.last, t.ip);
			tracked.delete(socket);
			const n = (active.get(ip) || 1) - 1;
			if (n <= 0) active.delete(ip);
			else active.set(ip, n);
		});
		routeUpgrade(req, socket, head);
	});
}