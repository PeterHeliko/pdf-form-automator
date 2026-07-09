"""Candidate post-processing: unique field names, stripping existing fields."""

from __future__ import annotations

import fitz

from .heuristics import Candidate, slugify

TYPE_SUFFIX = {"date": "Datum", "signature": "Unterschrift", "checkbox": "Checkbox"}


def assign_names(candidates: list[Candidate]) -> None:
    used: set[str] = set()
    for cand in candidates:
        base = cand.name or slugify(cand.label)
        if base == "Feld" and cand.ftype in TYPE_SUFFIX:
            base = TYPE_SUFFIX[cand.ftype]
        name = base
        n = 2
        while name in used:
            name = f"{base}_{n}"
            n += 1
        used.add(name)
        cand.name = name


def strip_existing_fields(doc: fitz.Document) -> int:
    """Delete all existing form fields. Returns how many were removed."""
    removed = 0
    for page in doc:
        widgets = list(page.widgets())
        for w in widgets:
            page.delete_widget(w)
            removed += 1
    return removed
