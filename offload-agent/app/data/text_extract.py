"""Extract plain text from files for injection into LLM prompts.

Supported formats:
  - .txt, .md, .csv, .json, .xml, .log, .yml, .yaml — read as UTF-8 text
  - .pdf — page-by-page text extraction via pymupdf (pip install pymupdf)

Usage:
    from app.data.text_extract import extract_texts_from_directory

    # Returns list of (filename, extracted_text) pairs
    texts = extract_texts_from_directory(some_path)
"""

import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger("agent")

# Plain-text file extensions — read as-is with UTF-8 decoding.
_PLAINTEXT_EXTENSIONS = {
    ".txt", ".md", ".csv", ".json", ".xml",
    ".log", ".yml", ".yaml",
}


def extract_text_from_pdf(path: Path) -> Optional[str]:
    """Extract text from a PDF file using pymupdf.

    Returns the concatenated text of all pages, or None if no text was found.
    Raises ImportError if pymupdf is not installed.
    """
    import fitz  # pymupdf

    pages = []
    doc = fitz.open(str(path))
    try:
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text().strip()
            if text:
                pages.append(text)
            logger.info(
                f"PDF page {page_num + 1}/{len(doc)} of {path.name}: "
                f"{len(text)} chars extracted"
            )
    finally:
        doc.close()

    if not pages:
        return None
    return "\n\n".join(pages)


def extract_text_from_file(path: Path) -> Optional[str]:
    """Extract text from a single file based on its extension.

    Returns the extracted text, or None if the file type is not supported
    or contains no extractable text.
    """
    ext = path.suffix.lower()

    if ext == ".pdf":
        try:
            return extract_text_from_pdf(path)
        except ImportError:
            logger.error(
                "pymupdf is not installed — cannot extract PDF text. "
                "Install it with: pip install pymupdf"
            )
            raise

    if ext in _PLAINTEXT_EXTENSIONS:
        try:
            text = path.read_text(encoding="utf-8").strip()
            return text if text else None
        except UnicodeDecodeError:
            logger.warning(f"Could not decode {path.name} as UTF-8, skipping")
            return None

    return None


def extract_texts_from_directory(data_path: Path) -> list[tuple[str, str]]:
    """Scan a directory for text-extractable files.

    Returns a list of ``(filename, extracted_text)`` pairs, sorted by
    filename.  Files that yield no text are silently skipped.
    """
    results = []
    if not data_path.exists():
        return results

    for f in sorted(data_path.iterdir()):
        if not f.is_file():
            continue
        text = extract_text_from_file(f)
        if text:
            logger.info(f"Extracted {len(text)} chars from {f.name}")
            results.append((f.name, text))

    return results
