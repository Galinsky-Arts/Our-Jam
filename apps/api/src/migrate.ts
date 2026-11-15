import { postgres, migrate } from "./db.js";
import { provisionRuntimeRole } from "./runtime-role.js";
const url = process.env.DATABASE_URL_UNPOOLED;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is required for migrations.");
if (new URL(url).hostname.includes("-pooler"))
  throw new Error("Migrations require the direct connection.");
const db = postgres(url);
try {
  await migrate(db);
  console.log("Our Jam migrations applied.");
  const runtimeRole = await provisionRuntimeRole(db, {
    password: process.env.RUNTIME_ROLE_PASSWORD || undefined,
  });
  console.log(JSON.stringify({ runtimeRole }));
} finally {
  await db.close();
}
