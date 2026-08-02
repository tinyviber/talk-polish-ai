import { z } from "zod";

export const appModeSchema = z.enum(["demo", "api"]);
export type AppMode = z.infer<typeof appModeSchema>;

/** Explicit build-time mode. An omitted value is the safe local demo default. */
export const configuredAppMode = appModeSchema.parse(import.meta.env["VITE_APP_MODE"] ?? "demo");
export const apiBaseUrl = (import.meta.env["VITE_API_URL"] ?? "http://localhost:3333").replace(
  /\/$/,
  "",
);
