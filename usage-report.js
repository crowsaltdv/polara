// Prints how much bandwidth the server has sent this month, by category.  Run:  npm run usage
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(process.env.POLARIS_DATA_DIR || path.join(import.meta.dirname, "data"), "usage.json");
let d;
try {
	d = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {
	console.log("No usage recorded yet. Start the server first.");
	process.exit(0);
}
const mb = (n) => (n / 1e6).toFixed(1).padStart(10) + " MB";
const rows = Object.entries(d.monthly || {}).sort((a, b) => b[1] - a[1]);
const total = rows.reduce((a, [, v]) => a + v, 0);
console.log(`Bandwidth sent in ${d.month}:`);
for (const [k, v] of rows) console.log(`  ${k.padEnd(8)}${mb(v)}  ${((v / total) * 100).toFixed(0).padStart(3)}%`);
console.log(`  ${"TOTAL".padEnd(8)}${mb(total)}`);
console.log("\n  proxy   = web browsing through the Browser/Apps tabs");
console.log("  games   = game files    static = the site itself    api = chat/music/fonts    img = background-image proxy");
