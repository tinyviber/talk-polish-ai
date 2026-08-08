import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

const RETIRED_PATHS = new Set(["practice", "progress", "saved"]);

/** Preserve retired MVP URLs without shipping their separate route chunks. */
export const Route = createFileRoute("/$legacy")({
  beforeLoad: ({ params }) => {
    if (RETIRED_PATHS.has(params.legacy)) throw redirect({ to: "/" });
    throw notFound();
  },
  component: () => null,
});
