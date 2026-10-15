// Reads settings from a local .env file (KEY=value lines) when there is one. It is never committed, so secrets such as
// KLIPY_API_KEY stay on your machine; on a host, set the same names as environment variables instead. Real environment
// variables always win over the file.
import path from "node:path";

try {
	process.loadEnvFile(path.join(import.meta.dirname, ".env"));
} catch {}
