# pdf-form-automator

Turns flat (non-interactive) PDF forms into fillable PDFs, **entirely in the
browser**: open a PDF, likely fill-in areas are detected automatically,
review/edit them on the page, then export a copy with real AcroForm fields —
text fields, checkboxes, date fields and real digital **signature fields**
(`/Sig`, e.g. next to "Unterschrift:").

No backend, no upload: rendering, detection, editing and writing the PDF all
run locally via [MuPDF.js](https://mupdfjs.readthedocs.io/) (WebAssembly).
Nothing ever leaves the machine.

## How detection works

Text and vector graphics are extracted per page and normalized, then a set of
geometric heuristics places field candidates:

- `Label: ______` fill-in lines (split at labels sitting on the same line)
- labeled boxes with empty space (right of the label or below it)
- tables — empty cells become fields named `<column>_<row>`; fully filled
  rows (e.g. example rows) are skipped
- small empty squares → checkboxes, labeled by the text next to them
- keywords classify fields: *Unterschrift/Signature* → signature,
  *Datum/Date* → date

Overlapping candidates are trimmed or dropped, names are uniquified on
export, and any form fields already present in the input are stripped.

## Using the editor

Detected fields appear as colored overlays (blue = text, orange = date,
green = checkbox, red = signature):

- click to select; `Ctrl`/`Shift` extends; drag over empty space for a
  rubber-band selection; `Ctrl+A` selects all fields on the page
- drag fields to move, drag the white handles to resize, arrow keys nudge
  (`Shift` = 5 pt); the whole selection moves/resizes together
- **Add field** mode: drag a rectangle where detection missed something — it
  snaps to fill-in lines, boxes or checkbox squares found there (with relaxed
  thresholds), otherwise the field is placed exactly as drawn; *New type*
  forces a type instead of the auto-classification
- the sidebar edits name/label (primary field) and type/multiline (whole
  selection); `Del` deletes; `Ctrl+Z` / `Ctrl+Y` undo/redo (200 steps,
  works across pages)
- `PgUp`/`PgDn` turn pages, `Ctrl` + wheel or `Ctrl+±` zooms
- pages you edited are never overwritten by detection results that arrive
  later; *Re-detect* re-runs detection from scratch
- **Export…** downloads `<name>.fillable.pdf`; the input file is never
  modified

Notes: date fields are ordinary text fields (colored/named as dates, no
JavaScript validation). Signature fields are empty digital-signature fields —
Acrobat Reader and other capable viewers offer certificate-based or drawn
signing on them.

## Development

```sh
cd web
npm install
npm run dev        # dev server
npm run build      # typecheck + static site in dist/
npm test           # unit tests
npm run smoke      # headless-browser end-to-end test
                   # (once: npx playwright install chromium)
```

The smoke test generates a synthetic test form on the fly, runs the full
open → detect → edit → export flow in Chromium and verifies the exported
PDF's fields.

Code layout (`web/src/`):

```
geometry.ts    rectangle math the heuristics depend on
extract.ts     text spans + normalized line geometry per page
tables.ts      table finder (ruling-line based)
heuristics.ts  the field detectors + overlap dedupe
fields.ts      unique field naming
writer.ts      AcroForm widgets as raw PDF objects, incl. /Sig
worker/        web worker that owns the wasm engine and open document
ui/            toolbar / page canvas / sidebar app
```

mupdf objects never leave the worker; page data and candidates travel as
JSON. The "Add field" snap runs synchronously on the main thread against the
cached page geometry.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` builds `web/` and deploys `dist/` to GitHub
Pages on every push to `main`. One-time setup: repo **Settings → Pages →
Source: GitHub Actions**. The app then appears at
`https://peterheliko.github.io/pdf-form-automator/`.

The build uses relative asset paths, so it also works from any static file
host or subpath without configuration.

## License

Built on MuPDF.js, which is **AGPL-3.0** — hosting this app publicly counts
as network distribution, so the page must offer its complete corresponding
source. The app links to this repository from its footer for that reason.

This project began as a Python desktop tool (PyMuPDF + Tkinter, optional
local-AI verification); the browser port was verified field-for-field
against it before the Python side was retired.
