# pdf-form-automator — browser app

A fully client-side port of the Python tool in `../pdf_form_automator/`:
open a flat (non-interactive) PDF form in the browser, likely fill-in areas
are detected automatically, review/edit them on the page, then export a real
fillable AcroForm PDF (text, checkbox, date, and signature fields).

**No backend.** Everything — rendering, detection, editing, writing the PDF —
runs locally in the browser via [mupdf.js](https://mupdfjs.readthedocs.io/)
(the WebAssembly build of the same MuPDF engine PyMuPDF wraps). The AI
(Ollama) verification pass of the Python tool was intentionally dropped;
detection is the same pure-geometry heuristics.

## Usage

```sh
npm install
npm run dev        # dev server
npm run build      # static site in dist/ — host anywhere, no server logic
npm run preview    # serve the built dist/
```

Open a PDF via the toolbar or drag & drop. Detected fields appear as colored
overlays (blue text, orange date, green checkbox, red signature). Edit like
in the desktop GUI:

- click to select; Ctrl/Shift extends; drag empty space for rubber-band select
- drag fields to move, drag the handles to resize, arrows nudge (Shift = 5pt)
- **Add field** mode: drag a rectangle where a field is missing — it snaps to
  page geometry (lines, boxes, checkbox squares) or is placed as drawn;
  "New type" overrides the detected type
- sidebar edits name/label (primary field) and type/multiline (whole selection)
- Del deletes, Ctrl+Z/Ctrl+Y undo/redo (200 steps, works across pages)
- Export… downloads `<name>.fillable.pdf`

## Architecture

```
src/geometry.ts    fitz.Rect semantics (the heuristics depend on them exactly)
src/extract.ts     rawdict/get_drawings equivalents from mupdf.js structured
                   text + a custom JS device      (port of extract.py)
src/tables.ts      lines_strict table finder      (port of pymupdf/table.py)
src/heuristics.ts  five field detectors + dedupe  (port of heuristics.py)
src/fields.ts      unique field naming            (port of fields.py)
src/writer.ts      AcroForm widgets as raw PDF objects, incl. /Sig
                   (port of writer.py, pikepdf pass included)
src/worker/        web worker that owns the wasm engine and open document
src/ui/            toolbar/canvas/sidebar app     (port of gui/)
```

mupdf objects never leave the worker; `PageData`/`Candidate` travel as JSON.
The "Add field" snap (`detectInRegion`) runs synchronously on the main thread
against the cached page geometry, like the Tk app.

## Tests

```sh
npm test           # parity gates against the Python implementation
npm run smoke      # headless-browser end-to-end test (needs npx playwright install chromium)
npm run fixtures   # regenerate test/expected/* with the Python pipeline
```

`test/parity.test.ts` asserts that extraction (lines, spans, segments, boxes,
tables) and the final candidate list byte-match the Python pipeline (±1pt) on
the sample PDFs in the repo root; `test/writer.test.ts` does the same for the
fields of the exported PDF against `test/expected-fillable/*` (generated with
the Python CLI, `--no-ai`). Regenerate both after changing the Python side.

## Deploying to GitHub Pages

The repo ships a workflow (`.github/workflows/pages.yml`) that builds `web/`
and deploys `dist/` to GitHub Pages on every push to `main`:

1. Push the repository to GitHub (`PeterHeliko/pdf-form-automator`).
2. In the repo settings → **Pages**, set *Source* to **GitHub Actions**.
3. Push to `main` (or run the workflow manually). The app appears at
   `https://peterheliko.github.io/pdf-form-automator/`.

The build uses relative asset paths (`base: "./"` in `vite.config.ts`), so it
works from the project subpath without configuration. The sample PDFs and the
test fixtures derived from them are intentionally **not** committed (they
contain personal data); CI only builds and deploys, the parity tests run
locally.

## License note

mupdf.js is AGPL-3.0 (as is PyMuPDF). Using the app locally or inside your
organization is unproblematic; **publicly hosting** it counts as network
distribution, so the page must offer its complete corresponding source (e.g.
link this repository) unless you have a commercial Artifex license.
