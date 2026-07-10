/* End-to-end smoke test of the built app in headless Chromium.

   A small synthetic form (three "Label: ___" fill-in lines and a checkbox
   square) is generated with mupdf on the fly, so the test needs no sample
   documents. It serves dist/, opens the form, waits for detection,
   exercises the editor, exports, and verifies the downloaded PDF's fields.

   Usage: node scripts/browser-check.mjs [--shots]   (once: npx playwright install chromium)
*/

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright";
import * as mupdf from "mupdf";

const WEB = path.resolve(import.meta.dirname, "..");
const DIST = path.join(WEB, "dist");
const SHOTS = process.argv.includes("--shots");
const OUT_DIR = process.env.SHOT_DIR ?? os.tmpdir();

// ---------------------------------------------------------- synthetic form

function makeTestPdf() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  // a small white image: Word-style checkbox inserted as an inline image
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  pix.clear(255);
  const image = doc.addImage(new mupdf.Image(pix));
  pix.destroy();
  const contents = `
    0 G 1 w
    BT /F0 12 Tf 72 720 Td (Name:) Tj ET
    110 716 m 400 716 l S
    BT /F0 12 Tf 72 680 Td (Datum:) Tj ET
    115 676 m 280 676 l S
    BT /F0 12 Tf 72 640 Td (Unterschrift:) Tj ET
    145 636 m 350 636 l S
    72 590 10 10 re S
    BT /F0 12 Tf 90 592 Td (Einverstanden) Tj ET
    q 12 0 0 12 72 520 cm /Im0 Do Q
    BT /F0 12 Tf 92 523 Td (Zutreffend) Tj ET
    72 380 250 60 re S
    BT /F0 11 Tf 78 425 Td (Bemerkungen) Tj ET
  `;
  const page = doc.addPage([0, 0, 595, 842], 0, { Font: { F0: font }, XObject: { Im0: image } }, contents);
  doc.insertPage(-1, page);
  const bytes = doc.saveToBuffer("").asUint8Array().slice();
  doc.destroy();
  return bytes;
}

// expected detection on the synthetic form: Name (text), Datum (date),
// Unterschrift (signature), Einverstanden (drawn-square checkbox),
// Zutreffend (image checkbox), Bemerkungen (caption box -> field below)
const EXPECTED_FIELDS = 6;

// ------------------------------------------------------------------ server

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

// ------------------------------------------------------------------- test

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const fail = (msg) => { console.error("FAIL:", msg); process.exitCode = 1; };

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#btn-open");

  await page.setInputFiles("#file-input", {
    name: "testform.pdf", mimeType: "application/pdf", buffer: Buffer.from(makeTestPdf()),
  });
  await page.waitForSelector("#page-wrap:not([hidden])", { timeout: 30000 });
  await page.waitForFunction(
    () => document.getElementById("status").textContent.includes("Detection finished"),
    { timeout: 60000 },
  );
  console.log("status:", (await page.textContent("#status")).trim());

  const fieldCount = await page.locator("#field-list .row").count();
  console.log("fields listed:", fieldCount);
  if (fieldCount !== EXPECTED_FIELDS) fail(`expected ${EXPECTED_FIELDS} fields, got ${fieldCount}`);

  const listedTypes = await page.locator("#field-list .row .ftype").allTextContents();
  for (const t of ["text", "date", "signature", "checkbox"]) {
    if (!listedTypes.includes(t)) fail(`missing detected field type ${t} (got ${listedTypes})`);
  }

  const overlayFields = await page.locator("#overlay g.field").count();
  if (overlayFields !== fieldCount) fail(`overlay shows ${overlayFields} fields != list ${fieldCount}`);

  if (SHOTS) await page.screenshot({ path: path.join(OUT_DIR, "app-detected.png") });

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
  await page.locator("#btn-delete").click();
  if ((await page.locator("#field-list .row").count()) !== fieldCount - 1) fail("delete did not remove a field");
  await page.locator("#btn-undo").click();
  if ((await page.locator("#field-list .row").count()) !== fieldCount) fail("undo did not restore the field");

  // draw a new field in add-field mode on an empty page area; the mode
  // toggle must reflect the active mode
  await page.locator("#mode-draw").click();
  if (!(await page.locator("#mode-draw").getAttribute("class"))?.includes("active")) {
    fail("Add-field mode button not marked active");
  }
  if ((await page.locator("#mode-select").getAttribute("class"))?.includes("active")) {
    fail("Select mode button still marked active in draw mode");
  }
  const activeBg = await page.locator("#mode-draw").evaluate((b) => getComputedStyle(b).backgroundColor);
  const inactiveBg = await page.locator("#mode-select").evaluate((b) => getComputedStyle(b).backgroundColor);
  if (activeBg === inactiveBg) fail(`mode toggle not visually distinct (both ${activeBg})`);
  const box = await page.locator("#overlay").boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.53, { steps: 4 });
  await page.mouse.up();
  const afterDraw = await page.locator("#field-list .row").count();
  console.log("fields after draw:", afterDraw, "-", (await page.textContent("#status")).trim());
  if (afterDraw !== fieldCount + 1) fail(`draw-to-add did not add a field (${afterDraw})`);
  await page.keyboard.press("Control+z");

  // zoom still renders
  await page.locator("#zoom-in").click();
  await page.waitForTimeout(400);
  const zoomLabel = await page.textContent("#zoom-label");
  if (!zoomLabel.includes("120")) fail(`zoom label ${zoomLabel}`);
  if (SHOTS) await page.screenshot({ path: path.join(OUT_DIR, "app-zoomed.png") });

  // export and verify the download is a PDF with the right AcroForm fields
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.locator("#btn-export").click();
  const download = await downloadPromise;
  const outPath = path.join(OUT_DIR, "browser-export.fillable.pdf");
  await download.saveAs(outPath);
  const bytes = fs.readFileSync(outPath);
  console.log("exported:", download.suggestedFilename(), bytes.length, "bytes");
  if (!bytes.subarray(0, 5).toString().startsWith("%PDF")) fail("export is not a PDF");
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
  const widgets = doc.loadPage(0).getWidgets();
  const types = widgets.map((w) => w.getFieldType()).sort();
  console.log("widgets in export:", widgets.length,
    JSON.stringify(widgets.map((w) => [w.getName(), w.getFieldType()])));
  if (widgets.length !== EXPECTED_FIELDS) fail(`export has ${widgets.length} widgets, expected ${EXPECTED_FIELDS}`);
  // date fields are written as ordinary text widgets (like the original tool)
  if (JSON.stringify(types) !== JSON.stringify(["checkbox", "checkbox", "signature", "text", "text", "text"])) {
    fail(`export field types ${types}`);
  }

  // i18n: a German browser locale defaults the UI to German, and the
  // toolbar switcher flips it back
  const dePage = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "de-DE" });
  await dePage.goto(`http://127.0.0.1:${port}/`);
  await dePage.waitForSelector("#btn-open");
  const deOpen = (await dePage.textContent("#btn-open")).trim();
  console.log("de locale toolbar:", deOpen, "-", (await dePage.textContent("#status")).trim());
  if (deOpen !== "Öffnen…") fail(`German locale did not localize UI (got ${deOpen})`);
  await dePage.selectOption("#lang", "en");
  if ((await dePage.textContent("#btn-open")).trim() !== "Open…") fail("language switcher did not switch to English");
  await dePage.close();

  const badErrors = errors.filter((e) => !e.includes("favicon"));
  if (badErrors.length) fail("console errors:\n" + badErrors.join("\n"));

  console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
} finally {
  await browser.close();
  server.close();
}
