/**
 * Run SQL against the database using DIRECT_URL / DATABASE_URL from .env.local.
 *   npm run sql -- "select count(*) from positions"
 *   npm run sql -- -f supabase/migrations/0002_something.sql
 */
import { readFileSync } from "node:fs";
import pg from "pg";

async function main() {
  const args = process.argv.slice(2);
  const sql = args[0] === "-f" ? readFileSync(args[1], "utf8") : args.join(" ");
  if (!sql.trim()) throw new Error('usage: npm run sql -- "<sql>" | -f <file.sql>');

  const client = new pg.Client({
    connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const res = await client.query(sql);
    for (const r of Array.isArray(res) ? res : [res]) {
      if (r.rows?.length) console.table(r.rows);
      else console.log(r.command, r.rowCount ?? "");
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
