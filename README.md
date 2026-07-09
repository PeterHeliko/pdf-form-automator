# pdf-form-automator

Turns flat (non-interactive) PDFs into fillable PDFs, fully locally: it detects
where form fields belong and writes real AcroForm fields into a copy of the
document — text fields, checkboxes, date fields and real digital **signature
fields** (`/Sig`, e.g. next to "Unterschrift:").

> **Browser version:** [`web/`](web/) contains a TypeScript port that runs
> entirely in the browser (no server, no AI) with the same detection
> heuristics, editor and export — see [web/README.md](web/README.md).
> Pushed to `main`, it auto-deploys to GitHub Pages.

## How it works

1. **Geometric heuristics** (always on, instant): text and vector graphics are
   extracted with PyMuPDF and normalized. Detected patterns:
   - `Label: ______` fill-in lines (split at labels sitting on the same line)
   - labeled boxes with empty space (right of the label or below it)
   - tables — empty cells become fields named `<column>_<row>`; fully filled
     rows (e.g. example rows) are skipped
   - small empty squares → checkboxes, labeled by the text next to them
   - keywords classify fields: *Unterschrift/Signature* → signature,
     *Datum/Date* → date
2. **Local AI verification** (default, needs [Ollama](https://ollama.com)): the
   page is rendered with numbered candidate boxes and a local vision model
   (default `qwen2.5vl`) confirms/rejects candidates, improves field names and
   reports missed fill-in areas. Model suggestions for *new* fields are only
   accepted when they snap to real page geometry, and the model may only
   reject weakly-evidenced candidates — checkboxes, labeled fields and table
   cells are trusted from geometry. If Ollama is not running, the tool falls
   back to heuristics with a warning.
3. **Writing**: existing form fields are stripped (leftovers from earlier
   attempts are common), widgets are added with PyMuPDF, and signature fields
   are injected with pikepdf as `/FT /Sig` widget annotations.

Nothing ever leaves the machine.

## Setup

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Usage

```sh
.venv/bin/python -m pdf_form_automator "Formular.pdf"
# -> Formular.fillable.pdf + Formular.fillable.fields.p1.png (preview overlay)
```

Multiple PDFs can be given at once. Options:

| Option | Effect |
| --- | --- |
| `-o OUTPUT` | output path (single input only) |
| `--no-ai` | skip the Ollama pass, heuristics only (instant) |
| `--model NAME` | Ollama vision model (default `qwen2.5vl`) |
| `--keep-existing` | don't strip fields already present in the PDF |
| `--no-preview` | don't write the preview overlay PNGs |
| `--debug` | print detected geometry and all candidates |

The preview PNG shows every placed field: blue = text, orange = date,
green = checkbox, red = signature. If a field landed wrong, re-run with
`--no-ai` (or a different `--model`) and compare.

## GUI

```sh
.venv/bin/python -m pdf_form_automator.gui ["Formular.pdf"]
```

A Tkinter editor (no extra dependencies, needs the system Tk that ships with
Python). Workflow:

1. **Open…** a PDF — detection runs in the background (AI pass included when
   Ollama is reachable and *AI check* is ticked); pages become editable as
   soon as their heuristics finish.
2. Click a field to select it; drag to move, drag the white handles to
   resize, arrow keys nudge (Shift = 5 pt). `Ctrl`/`Shift`+click or dragging
   a rectangle over empty space selects multiple fields (`Ctrl+A` = all on
   the page); the whole selection moves/resizes together, and a type change
   in the sidebar applies to every selected field. The sidebar edits name,
   label, type and multiline. `Del` deletes the selection. Every edit is
   undoable: `Ctrl+Z` undo, `Ctrl+Shift+Z`/`Ctrl+Y` redo.
3. **Add field**: drag a rectangle where detection missed something — it
   snaps to fill-in lines, boxes or checkbox squares found there (with
   relaxed thresholds), otherwise the field is placed exactly as drawn.
   *New type* forces a type instead of the auto-classification.
4. **Export…** writes the fillable PDF (same pipeline as the CLI: names
   uniquified, existing fields stripped, signature fields via pikepdf).

Field colors match the CLI previews. `PgUp/PgDn` turn pages, `Ctrl` + mouse
wheel or `Ctrl+±` zooms. Pages you edited are never overwritten by detection
results that arrive later; *Re-detect* re-runs detection from scratch.

## Notes

- The input file is never modified; output defaults to `<name>.fillable.pdf`.
- Date fields are ordinary text fields (colored/named as dates); no JavaScript
  format validation is added.
- Signature fields are empty digital-signature fields — Acrobat Reader and
  other capable viewers offer certificate-based or drawn signing on them.
