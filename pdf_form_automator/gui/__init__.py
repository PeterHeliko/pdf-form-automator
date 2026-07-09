"""Tkinter GUI: open a flat PDF, review and edit detected fields, export.

Launch with:  python -m pdf_form_automator.gui [PDF]
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    from .app import App

    app = App(args[0] if args else None)
    app.mainloop()
    return 0
