import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client, closeDatabase } from "./client";

/**
 * Applies every .sql file in ./migrations in lexical order and records it in
 * `_migrations`. Deliberately tiny — no external migration runner needed.
 */
export async function runMigrations() {
  const sql = client();
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

  await sql`create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;

  const applied = new Set(
    (await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(path.join(dir, file), "utf8");
    await sql.unsafe(body);
    await sql`insert into _migrations (name) values (${file})`;
    console.log(`applied migration ${file}`);
    count += 1;
  }
  console.log(count === 0 ? "migrations up to date" : `applied ${count} migration(s)`);
}

if (import.meta.main) {
  runMigrations()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error("migration failed:", error instanceof Error ? error.message : error);
      await closeDatabase();
      process.exit(1);
    });
}
