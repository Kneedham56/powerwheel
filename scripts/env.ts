/**
 * Load .env.local when it exists (local machine). In cloud sessions the same
 * variables come from the environment's settings instead.
 */
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
