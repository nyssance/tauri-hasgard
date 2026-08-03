import { expect, test } from "../fixtures.js";

test("controls forms, a native dialog, and keyboard focus in the main window", async ({
  window,
}) => {
  await window.getByRole("textbox", { name: "Display name" }).fill("Nyssance");
  await window.getByRole("button", { name: "Save", exact: true }).click();
  await expect(window.getByRole("status")).toHaveText("Saved Nyssance");

  await window
    .getByRole("button", { name: "Open dialog", exact: true })
    .click();
  await expect(window.getByRole("dialog")).toBeVisible();
  await window.getByRole("button", { name: "Close", exact: true }).click();

  await window.getByRole("textbox", { name: "Display name" }).click();
  await window.press("TAB");
  await expect(
    window.evaluate("document.activeElement && document.activeElement.id"),
  ).resolves.toBe("save");
});

test("targets a real secondary window without leaking commands to main", async ({
  hasgard,
  window,
}) => {
  await window
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  const settings = await hasgard.waitForWindow("settings", 5_000);
  await settings
    .locator('html[data-hasgard-ready="true"]')
    .waitFor({ state: "attached", timeoutMs: 5_000 });
  await settings.getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(settings.getByRole("status")).toHaveText("Applied dark");
  await expect(
    window.getByRole("heading", { name: "Hasgard fixture", exact: true }),
  ).toBeVisible();
});

test("handles 80 unequal-height turns and captures the real webview", async ({
  window,
}) => {
  await expect(window.locator("[data-turn]").count()).resolves.toBe(80);
  await expect(window.locator('[data-turn="80"]')).toHaveText(
    /Turn 80, line 4/,
  );
  const screenshot = await window.screenshot();
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});
