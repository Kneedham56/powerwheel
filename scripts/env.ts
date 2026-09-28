/**
 * Load env for scripts:
 *  - ENV_FILE=<path> loads that file (e.g. ENV_FILE=.env.demo for the demo database);
 *  - otherwise .env.local when it exists (local machine);
 *  - in cloud sessions the variables come from the environment's settings instead.
 */
import { existsSync } from "node:fs";

const file = process.env.ENV_FILE || ".env.local";
if (existsSync(file)) process.loadEnvFile(file);
else if (process.env.ENV_FILE) throw new Error(`ENV_FILE ${file} not found`);
