import { buildApp } from "./app";
import { env } from "./env";

const app = await buildApp();
const config = env();

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`Kotoba API listening on http://${config.HOST}:${config.PORT}`);
