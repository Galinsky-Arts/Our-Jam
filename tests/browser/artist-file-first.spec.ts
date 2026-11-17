import { test, expect } from "@playwright/test";
import { operatorSession } from "./helpers";

test("independent artists choose files, not hosted audio links, for new sessions", async ({ page }) => {
  await page.goto("/performer");
  await operatorSession(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Create a jam around your songs." })).toBeVisible();
  await expect(page.getByLabel("Upload track (MP3 or WAV)")).toBeVisible();
  await expect(page.getByLabel("Track audio URL (HTTPS)")).toHaveCount(0);
  await expect(page.getByText("no outside hosting needed.")).toBeVisible();
  // The browser fixture intentionally has no private media store. The show can
  // still be created, with the album played from this device, and the page
  // explains exactly what storage would add.
  await expect(page.getByText("Private audio storage is not connected on this server.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create and upload album" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create show (album stays on this device)" })).toBeEnabled();
});
