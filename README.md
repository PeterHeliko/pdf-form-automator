# pdf-form-automator

Turns flat (non-interactive) PDF forms into fillable PDFs, entirely in the
browser: open a PDF, likely fill-in areas are detected automatically,
review/edit them on the page, then export a copy with real AcroForm fields —
text, checkbox, date, and digital signature fields (`/Sig`).

No backend, no upload: everything runs locally via
[MuPDF.js](https://mupdfjs.readthedocs.io/) (WebAssembly). Nothing ever
leaves the machine.

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

## License

Built on MuPDF.js, which is AGPL-3.0: hosting this app publicly counts as
network distribution, so the page must offer its source — the app links to
this repository from its footer for that reason.
