import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

let sql: ReturnType<typeof postgres> | undefined;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function client() {
  if (!sql) {
    sql = postgres(env().DATABASE_URL, { max: 10, onnotice: () => {} });
  }
  return sql;
}

export function db() {
  if (!dbInstance) {
    dbInstance = drizzle(client(), { schema });
  }
  return dbInstance;
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await client()`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase() {
  await sql?.end({ timeout: 5 });
  sql = undefined;
  dbInstance = undefined;
}

export { schema };
