import { registerIdentity } from "./identity.js";
import { registerCommerce } from "./commerce.js";
import {
  createApp as createCoreApp,
  type AppConfig as CoreAppConfig,
} from "./app-core.js";
import type { Database } from "./db.js";
import type { GenerationConfig } from "./generation.js";
import { configuredGeneration } from "./generation-config.js";
import { registerGenerationControls } from "./provider-controls.js";
import { registerAlbumUploads } from "./album-uploads.js";
import { registerEventStreamShutdown } from "./event-stream-shutdown.js";
import { registerComparisonAdmin } from "./comparison-admin.js";
import { registerComparisonRateAdmin } from "./comparison-rate-admin.js";
import { registerFanJourneys } from "./fan-journeys.js";
import { registerArtistAdministration } from "./admin-artists.js";
import { registerEventExport } from "./event-export.js";
export type AppConfig = CoreAppConfig & { generation?: GenerationConfig; webPush?: unknown };
export async function createApp(db: Database, config: AppConfig) {
  const app = await createCoreApp(db, config);
  registerEventStreamShutdown(app);
  registerComparisonAdmin(app, db);
  registerComparisonRateAdmin(app, db);
  registerGenerationControls(
    app,
    db,
    config.generation ?? configuredGeneration(config.mediaStore),
  );
  await registerAlbumUploads(app, db, config.origin, config.mediaStore);
  if (config.commerce)
    await registerCommerce(
      app,
      db,
      config.origin,
      config.commerce,
      config.mediaStore,
      config.identity,
    );
  await registerIdentity(app, db, config.origin, config.identity);
  registerFanJourneys(app, db);
  registerEventExport(app, db, Boolean(config.mediaStore));
  const generation = config.generation ?? configuredGeneration(config.mediaStore);
  registerArtistAdministration(app, db, () => ({
    operatorToken: Boolean(config.operatorToken && config.operatorToken.length >= 32),
    adminToken: Boolean((config.adminToken ?? config.commerce?.adminToken ?? "").length >= 32),
    media: config.mediaStore ? (config.mediaVerified ? "verified" : "configured") : "not_configured",
    generation: Boolean(generation) && Boolean(config.providerReady),
    email: Boolean(config.email),
    commerce: Boolean(config.commerce?.enabled),
    identity: Boolean(config.identity),
    webPush: Boolean(config.webPush),
  }));
  return app;
}
