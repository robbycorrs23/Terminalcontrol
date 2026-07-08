# File upload (any type), extending image drop — design

**Date:** 2026-07-08
**Status:** implemented with assumed defaults (user was AFK during clarification;
defaults noted below — revisit if wrong)

## Goal

Dropping or picking *any* file on a terminal box uploads it and types its
absolute path into that pane's prompt — exactly what image drop does today,
without the images-only restriction. Claude Code can then read the file.

## Decisions (assumed defaults)

1. **Any file type; keep the ~20MB effective cap.** Transport stays base64
   JSON under the existing `express.json({ limit: "30mb" })` (base64 ≈ +33%).
   Oversized files are skipped client-side with a console error; server
   returns 413 if one slips through. No streaming/multipart rework.
2. **Files only, no folders.** A dropped directory is detected
   (`webkitGetAsEntry().isDirectory`) and skipped — never uploaded as a
   zero-byte phantom file.
3. **One 📎 button replaces 🖼.** Tooltip "Add file(s) to prompt"; the picker
   accepts all types (images included — an image is just a file).

## Changes

### Server (`server/index.js`)
- `POST /api/panes/:id/file` — same handler as today's image route, minus the
  `image/` mime check. `POST /api/panes/:id/image` stays as an alias so
  already-open tabs (old client bundle) keep working.
- Data-URL regex tolerates an **empty mime** (`data:;base64,…`), which
  browsers produce for files with unknown types.
- Extension: keep the original filename's extension; if none, fall back to a
  mime-derived one only for well-known types, else no extension.
- Upload dir renamed `fleetview-images` → `fleetview-uploads`.

### Client (`client/src/terminal.ts`)
- Drop handler: accept any `Files` drop; skip directory entries; skip files
  over the size cap (console error, matching the existing failure pattern).
- `dropImages` → `dropFiles`; posts to `/file`.
- Title-bar button: 🖼 → 📎, `accept` unrestricted.

### Invariants preserved
- No PTY involvement in the upload; the path is *typed* into the prompt, the
  user submits.
- Sanitized basename in a unique `drop-*` temp subdir; identical names never
  clobber. Sanitization strips spaces, so space-joined multi-paths stay valid.

## Testing
- Live-server drive (scratch pane, throwaway session id): POST a `.txt`, a
  no-extension/no-mime file, and an oversized payload to `/file`; confirm
  path returned, file bytes intact, 4xx on oversize; confirm `/image` alias
  still accepts an image.
- `tsc --noEmit`, `node --check`, vite build.
