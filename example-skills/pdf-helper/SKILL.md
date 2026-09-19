---
name: pdf-helper
description: Use when a task requires working with PDF files - extracting text or metadata, merging or splitting documents, rotating pages, or filling forms. Guides the agent to pick the right tool, verify results, and never destroy the original file.
allowed-tools: Bash, Read, Write
license: MIT
metadata:
  version: 1.0.0
---

# PDF helper

Work with PDF files safely and predictably: inspect, extract, merge, split,
and repair - without ever destroying the user's original document.

## When to use

Load this skill when the user mentions PDF files and any of the following:

- extracting text (or specific pages) from one or more PDFs,
- merging multiple PDFs into one document,
- splitting or rotating pages,
- reading metadata (page count, title, author, encryption status),
- repairing a PDF that fails to open or parse.

## Workflow

1. Inspect before you act. Get the page count and check whether the PDF has a
   text layer before choosing an extraction strategy.
2. Copy first, mutate later. Never operate on the user's only copy. Create a
   working copy in a temporary directory and keep the original untouched
   until the final result is verified.
3. Prefer the smallest tool that solves the task (see Tools below); drop to a
   general-purpose PDF library only when composition is needed.
4. Verify every mutation by re-opening the output and checking page counts,
   file size, and a text sample from the first and last page.

## Tools

Command-line tools, in order of preference:

- pdftotext (poppler-utils): fastest text extraction; supports page ranges
  with the -f and -l flags, and -layout to preserve reading order.
- qpdf: structural operations (split, rotate, decrypt, linearize, recover)
  without interpreting page content; ideal for "damaged file" repair.
- ocrmypdf: adds a text layer to scanned PDFs (rasterize + OCR); run it when
  extraction yields (almost) no text but the file renders visually.

Python libraries, when a script must compose several operations:

- pypdf: merge, split, rotate, encrypt, and read metadata; pure Python, safe
  to install into a scratch virtual environment.
- pdfplumber: layout-aware extraction (tables, coordinates) when plain
  pdftotext loses structure.

Typical recipes:

- Extract text: run pdftotext with -layout on a working copy, then read and
  summarize the resulting text file.
- Merge: with pypdf, append each source's pages to a PdfWriter, write the
  result, then verify the output page count equals the sum of the inputs.
- Split: write each page (or requested page range) with pypdf, one output
  file per range, verifying the count of produced files.
- No text layer: if extraction returns (almost) nothing but the file renders,
  treat it as scanned, run OCR over a copy, then retry extraction.
- Damaged file: run qpdf with --recover on a copy first, then proceed on the
  recovered output.

## Verification checklist

- The output opens without errors.
- Page counts match expectations (sum for merges, ranges for splits).
- A sample of extracted text is non-empty and sane.
- The original file is unchanged (compare size and modification time).

## Errors

- "file is damaged": recover with qpdf, then retry the operation.
- Password-protected: ask the user for the password; never guess.
- Huge files (over ~100 MB): process page ranges instead of whole documents
  and prefer streaming CLI tools over loading the file into memory.

## Helper scripts

Reusable scripts for repeated workflows live in `scripts/`. Add a file there
when a recipe is needed more than once, keep it self-contained, and mention
it from this body so future edits stay consistent.
