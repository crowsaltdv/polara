import path from "node:path";

try {
	process.loadEnvFile(path.join(import.meta.dirname, ".env"));
} catch {}

process.env.KLIPY_API_KEY ||= "JC9ws1hO0J0Xz09zfMtqYOxvcODZrbuxlDK6H9RE68VAGhNevQinalD7pBmveaOC";
process.env.ADMIN_PASSWORD ||= "102000";
