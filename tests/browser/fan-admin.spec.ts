import { test, expect } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:4173";

test("platform admin onboards an artist and sees which settings switch off features on", async ({ page }) => {
  const login = await page.request.post("/api/admin/login", {
    headers: { Origin: ORIGIN },
    data: { token: "browser-test-only-platform-admin-token-123456789" },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto("/admin/artists");
  await expect(page.getByRole("heading", { name: "Artists, limits and usage" })).toBeVisible();
  const name = "Browser Artist " + Date.now();
  await page.getByLabel("Artist name").fill(name);
  await page.getByRole("button", { name: "Create artist and key" }).click();
  const key = page.getByLabel(`Performer key for ${name}`);
  await expect(key).toHaveValue(/^[a-f0-9]{64}$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("link", { name: "Configuration" }).click();
  await expect(page.getByRole("heading", { name: "What is switched on" })).toBeVisible();
  const media = page.locator(".config-list li").filter({ hasText: "Album upload, playback and release downloads" });
  await expect(media).toContainText("Off");
  await expect(media).toContainText("MEDIA_BUCKET");
});

test("a fan finds their music journey, data export and erasure controls with keyboard access", async ({ page }) => {
  await page.goto("/");
  await page.request.post("/api/session", { headers: { Origin: ORIGIN }, data: {} });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your Sound Waves" })).toBeVisible();
  // Skip link moves focus to the main landmark.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();

  await expect(page.getByText("Join a live show and share a Sound Wave to start your collection.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download everything Our Jam stores about you" })).toHaveAttribute("href", "/api/account/export");
  await page.getByText("Erase this profile").click();
  const erase = page.getByRole("button", { name: "Erase my profile" });
  await expect(erase).toBeDisabled();
  await page.getByLabel("Type ERASE MY PROFILE to confirm").fill("ERASE MY PROFILE");
  await expect(erase).toBeEnabled();
  await expect(page).toHaveTitle(/Your music · Our Jam/);
  const missing = await page.goto("/receipt/AAAAAAAAAAAAAAAAAAAAAA");
  expect(missing?.ok()).toBeTruthy();
  await expect(page.getByRole("alert")).toHaveText("This receipt is no longer shared.");
});
