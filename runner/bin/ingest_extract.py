#!/usr/bin/env python3
# Text extractor for the ingest pipeline. Prints plain text/markdown to stdout, exit 0.
# Prefers Microsoft markitdown (MIT, broad Office/PDF/HTML/email -> markdown); falls back
# to pdfplumber (MIT) for digital PDFs. Exit 1 = extraction failed (e.g. scanned PDF w/o OCR).
import sys


def main():
    if len(sys.argv) < 2:
        sys.exit(2)
    f = sys.argv[1]

    # 1) markitdown — the broad default
    try:
        from markitdown import MarkItDown
        text = MarkItDown().convert(f).text_content
        if text and text.strip():
            sys.stdout.write(text)
            return
    except Exception:
        pass

    # 2) pdfplumber fallback for digital PDFs
    if f.lower().endswith(".pdf"):
        try:
            import pdfplumber
            with pdfplumber.open(f) as pdf:
                text = "\n".join((p.extract_text() or "") for p in pdf.pages)
            if text and text.strip():
                sys.stdout.write(text)
                return
        except Exception:
            pass

    # nothing worked (scanned image PDF needs OCR — OCRmyPDF, a later phase)
    sys.exit(1)


main()
