/** Minimal i18n: English/German UI strings. The language defaults to the
 * browser language (German variants → de, anything else → en) and can be
 * overridden with the toolbar switcher (persisted in localStorage). */

export type Lang = "en" | "de";

const STORAGE_KEY = "pfa-lang";

const STRINGS = {
  en: {
    open: "Open…",
    openTitle: "Open a PDF (or drop one anywhere)",
    select: "Select",
    selectTitle: "Select and edit fields (Esc)",
    addField: "Add field",
    addFieldTitle: "Drag a rectangle where a field is missing",
    newType: "New type",
    redetect: "Re-detect",
    redetectTitle: "Discard edits and re-run detection",
    export: "Export…",
    exportTitle: "Write the fillable PDF",
    prevPageTitle: "Previous page (PageUp)",
    nextPageTitle: "Next page (PageDown)",
    zoomInTitle: "Zoom in (Ctrl++)",
    zoomOutTitle: "Zoom out (Ctrl+-)",
    langTitle: "Language",
    fieldsOnPage: "Fields on this page",
    selectedField: "Selected field",
    selectedFields: "Selected fields ({n})",
    fName: "Name",
    fLabel: "Label",
    fType: "Type",
    fMultiline: "Multiline",
    delete: "Delete (Del)",
    undo: "Undo",
    redo: "Redo",
    unnamed: "(unnamed)",
    emptyLine1: "Open a flat PDF form — likely fill-in areas are detected and turned into real, fillable AcroForm fields (text, checkbox, date, signature).",
    emptyLine2: "Everything runs locally in your browser; no file leaves this machine.",
    emptyOpen: "Open a PDF…",
    orDrop: "or drop one anywhere.",
    srcLink: "Source code",
    builtOn: "built on",
    srcLinkShort: "Source",
    dropHint: "Drop the PDF to open it",
    statusStart: "Open a PDF to begin.",
    opening: "Opening {name} …",
    cannotOpen: "Cannot open {name}: {err}",
    engineError: "PDF engine error: {err}",
    detectingPage: "Detecting fields – page {p}/{n} …",
    detectionFinished: "Detection finished: {n} field(s). Review/edit them, then Export.",
    detectionFailed: "Detection failed: {err}",
    addFieldHint: "Add field: drag a rectangle where a field is missing – it snaps to lines/boxes there, or is placed as drawn.",
    addedFields: "Added {n} field(s) ({note}).",
    noteSnapped: "snapped to page geometry",
    noteAsDrawn: "no matching geometry, field placed as drawn",
    alreadyCovered: "A field already covers that area.",
    deletedFields: "Deleted {n} field(s) – Ctrl+Z to undo.",
    undoDone: "Undo: one step on page {p}.",
    redoDone: "Redo: one step on page {p}.",
    nothingToUndo: "Nothing to undo.",
    nothingToRedo: "Nothing to redo.",
    confirmRedetect: "This discards your edits and re-runs detection. Continue?",
    confirmExportRunning: "Detection is still running. Export with the fields found so far?",
    nothingToExport: "There are no form fields to write.",
    exporting: "Exporting …",
    exported: "Exported {name}  ({summary})",
    exportFailed: "Export failed: {err}",
    typeAuto: "auto",
    typeText: "text",
    typeCheckbox: "checkbox",
    typeDate: "date",
    typeSignature: "signature",
  },
  de: {
    open: "Öffnen…",
    openTitle: "PDF öffnen (oder irgendwo ins Fenster ziehen)",
    select: "Auswählen",
    selectTitle: "Felder auswählen und bearbeiten (Esc)",
    addField: "Feld hinzufügen",
    addFieldTitle: "Rechteck aufziehen, wo ein Feld fehlt",
    newType: "Neuer Typ",
    redetect: "Neu erkennen",
    redetectTitle: "Änderungen verwerfen und Erkennung neu ausführen",
    export: "Exportieren…",
    exportTitle: "Ausfüllbares PDF erzeugen",
    prevPageTitle: "Vorherige Seite (Bild auf)",
    nextPageTitle: "Nächste Seite (Bild ab)",
    zoomInTitle: "Vergrössern (Strg++)",
    zoomOutTitle: "Verkleinern (Strg+-)",
    langTitle: "Sprache",
    fieldsOnPage: "Felder auf dieser Seite",
    selectedField: "Ausgewähltes Feld",
    selectedFields: "Ausgewählte Felder ({n})",
    fName: "Name",
    fLabel: "Beschriftung",
    fType: "Typ",
    fMultiline: "Mehrzeilig",
    delete: "Löschen (Entf)",
    undo: "Rückgängig",
    redo: "Wiederholen",
    unnamed: "(unbenannt)",
    emptyLine1: "Ein flaches PDF-Formular öffnen — mögliche Ausfüllbereiche werden erkannt und in echte, ausfüllbare AcroForm-Felder umgewandelt (Text, Checkbox, Datum, Unterschrift).",
    emptyLine2: "Alles läuft lokal im Browser; keine Datei verlässt diesen Rechner.",
    emptyOpen: "PDF öffnen…",
    orDrop: "oder eine Datei hineinziehen.",
    srcLink: "Quellcode",
    builtOn: "basiert auf",
    srcLinkShort: "Quellcode",
    dropHint: "PDF loslassen zum Öffnen",
    statusStart: "Zum Start ein PDF öffnen.",
    opening: "Öffne {name} …",
    cannotOpen: "{name} kann nicht geöffnet werden: {err}",
    engineError: "Fehler in der PDF-Engine: {err}",
    detectingPage: "Erkenne Felder – Seite {p}/{n} …",
    detectionFinished: "Erkennung abgeschlossen: {n} Feld(er). Prüfen/bearbeiten, dann exportieren.",
    detectionFailed: "Erkennung fehlgeschlagen: {err}",
    addFieldHint: "Feld hinzufügen: Rechteck aufziehen, wo ein Feld fehlt – es rastet an Linien/Boxen ein oder wird wie gezeichnet platziert.",
    addedFields: "{n} Feld(er) hinzugefügt ({note}).",
    noteSnapped: "an der Seitengeometrie eingerastet",
    noteAsDrawn: "keine passende Geometrie, Feld wie gezeichnet platziert",
    alreadyCovered: "Dort liegt bereits ein Feld.",
    deletedFields: "{n} Feld(er) gelöscht – Strg+Z macht es rückgängig.",
    undoDone: "Rückgängig: ein Schritt auf Seite {p}.",
    redoDone: "Wiederholt: ein Schritt auf Seite {p}.",
    nothingToUndo: "Nichts rückgängig zu machen.",
    nothingToRedo: "Nichts zu wiederholen.",
    confirmRedetect: "Das verwirft Ihre Änderungen und führt die Erkennung neu aus. Fortfahren?",
    confirmExportRunning: "Die Erkennung läuft noch. Mit den bisher gefundenen Feldern exportieren?",
    nothingToExport: "Es gibt keine Formularfelder zu schreiben.",
    exporting: "Exportiere …",
    exported: "{name} exportiert  ({summary})",
    exportFailed: "Export fehlgeschlagen: {err}",
    typeAuto: "auto",
    typeText: "Text",
    typeCheckbox: "Checkbox",
    typeDate: "Datum",
    typeSignature: "Unterschrift",
  },
} as const;

export type MsgKey = keyof typeof STRINGS.en;

function browserDefault(): Lang {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => l?.toLowerCase().startsWith("de")) ? "de" : "en";
}

let lang: Lang = (() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "de" || saved === "en" ? saved : browserDefault();
})();

export function currentLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  lang = l;
  localStorage.setItem(STORAGE_KEY, l);
}

export function t(key: MsgKey, params?: Record<string, string | number>): string {
  let s: string = STRINGS[lang][key] ?? STRINGS.en[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** Display name for a field type value ("text" | "checkbox" | ...). */
export function typeName(ftype: string): string {
  const key = ("type" + ftype.charAt(0).toUpperCase() + ftype.slice(1)) as MsgKey;
  return STRINGS[lang][key] !== undefined ? t(key) : ftype;
}
