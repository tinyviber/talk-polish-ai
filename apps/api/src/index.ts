import { env } from "./env";
import { buildApp } from "./app";

const config = env();
const app = await buildApp(config);

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`Kotoba API listening on http://${config.HOST}:${config.PORT}`);
