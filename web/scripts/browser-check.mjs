/* End-to-end smoke test of the built app in headless Chromium:
   serve dist/, open a sample PDF, wait for detection, exercise the editor
   a little, export, and verify the downloaded PDF contains form fields.
   Usage: node scripts/browser-check.mjs [--shots] */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";

const WEB = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(WEB, "..");
const DIST = path.join(WEB, "dist");
const SAMPLE = path.join(ROOT, "Doz. Vertrag Module BMO.pdf");
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp";

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const fail = (msg) => { console.error("FAIL:", msg); process.exitCode = 1; };

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#btn-open");

  // open the sample PDF
  await page.setInputFiles("#file-input", SAMPLE);
  await page.waitForSelector("#page-wrap:not([hidden])", { timeout: 30000 });
  await page.waitForFunction(
    () => document.getElementById("status").textContent.includes("Detection finished"),
    { timeout: 60000 },
  );
  const statusText = await page.textContent("#status");
  console.log("status:", statusText.trim());

  const fieldCount = await page.locator("#field-list .row").count();
  console.log("fields listed:", fieldCount);
  if (fieldCount !== 14) fail(`expected 14 fields (Python parity), got ${fieldCount}`);

  const overlayFields = await page.locator("#overlay g.field").count();
  if (overlayFields !== fieldCount) fail(`overlay shows ${overlayFields} fields != list ${fieldCount}`);

  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "app-detected.png") });

  // select the first field via the list, rename it, check editor commit
  await page.locator("#field-list .row").first().click();
  await page.fill("#f-name", "Renamed_Field");
  await page.press("#f-name", "Enter");
  const firstRow = await page.locator("#field-list .row").first().textContent();
  if (!firstRow.includes("Renamed_Field")) fail(`rename not reflected in list: ${firstRow}`);

  // undo the rename
  await page.keyboard.press("Escape"); // clear selection so focus leaves inputs
  await page.keyboard.press("Control+z");
  const afterUndo = await page.locator("#field-list .row").first().textContent();
  if (afterUndo.includes("Renamed_Field")) fail("undo did not revert the rename");

  // delete a field and undo
  await page.locator("#field-list .row").first().click();
  await page.keyboard.press("Escape");
  await page.locator("#field-list .row").first().click();
  await page.locator("#btn-delete").click();
  if ((await page.locator("#field-list .row").count()) !== fieldCount - 1) fail("delete did not remove a field");
  await page.locator("#btn-undo").click();
  if ((await page.locator("#field-list .row").count()) !== fieldCount) fail("undo did not restore the field");

  // draw a new field in add-field mode on an empty page area (bottom of the
  // page; scroll it into the window first so the mouse events land)
  await page.locator("#mode-draw").click();
  await page.evaluate(() => {
    const v = document.getElementById("viewport");
    v.scrollTop = v.scrollHeight;
  });
  const box = await page.locator("#overlay").boundingBox();
  const yA = box.y + box.height * 0.94;
  const yB = box.y + box.height * 0.965;
  await page.mouse.move(box.x + box.width * 0.62, yA);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, yB, { steps: 4 });
  await page.mouse.up();
  const afterDraw = await page.locator("#field-list .row").count();
  console.log("fields after draw:", afterDraw, "-", (await page.textContent("#status")).trim());
  if (afterDraw !== fieldCount + 1) fail(`draw-to-add did not add a field (${afterDraw})`);
  await page.keyboard.press("Control+z");

  // zoom and page render still alive
  await page.locator("#zoom-in").click();
  await page.waitForTimeout(400);
  const zoomLabel = await page.textContent("#zoom-label");
  if (!zoomLabel.includes("120")) fail(`zoom label ${zoomLabel}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, "app-zoomed.png") });

  // export and verify the download is a PDF with AcroForm fields
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.locator("#btn-export").click();
  const download = await downloadPromise;
  const outPath = path.join(SHOT_DIR, "browser-export.fillable.pdf");
  await download.saveAs(outPath);
  const bytes = fs.readFileSync(outPath);
  console.log("exported:", download.suggestedFilename(), bytes.length, "bytes");
  if (!bytes.subarray(0, 5).toString().startsWith("%PDF")) fail("export is not a PDF");
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
  const p0 = doc.loadPage(0);
  const widgets = p0.getWidgets();
  console.log("widgets in export:", widgets.length,
    JSON.stringify(widgets.slice(0, 3).map((w) => [w.getName(), w.getFieldType()])));
  if (widgets.length !== 14) fail(`export has ${widgets.length} widgets, expected 14`);

  const badErrors = errors.filter((e) => !e.includes("favicon"));
  if (badErrors.length) fail("console errors:\n" + badErrors.join("\n"));

  console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
} finally {
  await browser.close();
  server.close();
}
