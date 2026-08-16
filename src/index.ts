import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PgContextRepository } from "./pg-repository.js";
import { HttpResourceReader } from "./document-ingest.js";
import { PgExtensionStateRepository } from "./pg-extension-state-repository.js";
const c = loadConfig(),
  repository = new PgContextRepository(c.DATABASE_URL);
await repository.migrate();
const extensionRepository = new PgExtensionStateRepository(
  c.DATABASE_URL,
  "ch",
);
await extensionRepository.migrate();
const app = buildApp({
  repository,
  extensionRepository,
  internalToken: c.INTERNAL_SERVICE_TOKEN,
  resourceReader: new HttpResourceReader(
    c.RESOURCE_URL,
    c.INTERNAL_SERVICE_TOKEN,
  ),
  logger: { level: c.LOG_LEVEL },
});
await app.listen({ host: c.HOST, port: c.PORT });
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
