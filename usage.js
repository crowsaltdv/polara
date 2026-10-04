import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Counts the bytes the server sends so you can see where hosting bandwidth goes, and optionally caps it.
// Settings (environment variables, all optional):
//   PROXY_DAILY_MB     max proxied browsing per visitor per day        (default 1500, 0 = no limit)
//   PROXY_MONTHLY_GB   max proxied browsing for the whole site per month (default 0 = no limit)
//   STATIC_DAILY_MB    max site/game file downloads per visitor per day (default 3000, 0 = no limit)
const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
export const limits = {
	proxyDaily: num(process.env.PROXY_DAILY_MB, 1500) * 1e6,
	proxyMonthly: num(process.env.PROXY_MONTHLY_GB, 0) * 1e9,
	staticDaily: num(process.env.STATIC_DAILY_MB, 3000) * 1e6,
};

const DIR = process.env.POLARIS_DATA_DIR || path.join(import.meta.dirname, "data");
const FILE = path.join(DIR, "usage.json");
const dayKey = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);
// visitors are stored as a short hash, not as IP addresses
const who = (ip) => crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 12);

let data = { month: monthKey(), monthly: {}, day: dayKey(), daily: {} };
try {
	const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
	if (saved && typeof saved === "object") data = { ...data, ...saved };
} catch {}

function roll() {
	if (data.day !== dayKey()) {
		data.day = dayKey();
		data.daily = {};
	}
	if (data.month !== monthKey()) {
		data.month = monthKey();
		data.monthly = {};
	}
}

let dirty = false;
export function add(cat, bytes, ip) {
	if (!bytes) return;
	roll();
	data.monthly[cat] = (data.monthly[cat] || 0) + bytes;
	if (ip && (cat === "proxy" || cat === "static" || cat === "games")) {
		const k = who(ip);
		const d = (data.daily[k] ||= { proxy: 0, static: 0 });
		d[cat === "proxy" ? "proxy" : "static"] += bytes;
	}
	dirty = true;
}

const todayOf = (ip) => (roll(), data.daily[who(ip)] || { proxy: 0, static: 0 });
export const proxyBlocked = (ip) =>
	(limits.proxyDaily > 0 && todayOf(ip).proxy >= limits.proxyDaily) ||
	(limits.proxyMonthly > 0 && (data.monthly.proxy || 0) >= limits.proxyMonthly);
export const staticBlocked = (ip) => limits.staticDaily > 0 && todayOf(ip).static >= limits.staticDaily;

const mb = (n) => (n / 1e6).toFixed(n > 1e9 ? 0 : 1) + " MB";
export function summary() {
	roll();
	const parts = Object.entries(data.monthly)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k} ${mb(v)}`);
	const total = Object.values(data.monthly).reduce((a, b) => a + b, 0);
	return `[usage ${data.month}] total ${mb(total)} | ${parts.join(" | ") || "nothing yet"}`;
}

function save() {
	if (!dirty) return;
	dirty = false;
	// keep the per-visitor table from growing without bound
	const keys = Object.keys(data.daily);
	if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete data.daily[k];
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFile(FILE + ".tmp", JSON.stringify(data), (err) => {
		if (!err) fs.rename(FILE + ".tmp", FILE, () => {});
	});
}
setInterval(save, 30e3).unref();
setInterval(() => console.log(summary()), 30 * 60e3).unref();
process.on("exit", () => {
	try {
		fs.mkdirSync(DIR, { recursive: true });
		fs.writeFileSync(FILE, JSON.stringify(data));
	} catch {}
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
