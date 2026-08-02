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
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  let count = 0;
  await sql.begin(async (tx) => {
    // Transaction-scoped lock makes concurrent API/container starts serialize
    // without holding a session lock after this transaction commits.
    await tx`select pg_advisory_xact_lock(hashtext('kotoba_loop_migrations'))`;
    await tx`create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;

    const applied = new Set(
      (await tx<{ name: string }[]>`select name from _migrations`).map((row) => row.name),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(path.join(dir, file), "utf8");
      await tx.unsafe(body);
      await tx`insert into _migrations (name) values (${file}) on conflict (name) do nothing`;
      console.log(`applied migration ${file}`);
      count += 1;
    }
  });
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
