from __future__ import annotations

import re
from typing import Dict, List, Tuple, Iterable, Any
from PyPDF2 import PdfReader
from pathlib import Path

def extract_text_by_page(pdf_path: str) -> Dict[int, str]:
    """Return mapping page_number (1-based) -> text."""
    reader = PdfReader(pdf_path)
    pages: Dict[int, str] = {}
    for i, page in enumerate(reader.pages, start=1):
        try:
            pages[i] = page.extract_text() or ""
        except Exception:
            pages[i] = ""
    return pages

def find_query_positions(pages: Dict[int, str], query: str) -> List[Dict]:
    """Return list of hits with page and snippet."""
    q = query.lower()
    hits = []
    for p, text in pages.items():
        if not text:
            continue
        idx = text.lower().find(q)
        if idx != -1:
            start = max(0, idx - 80)
            end = min(len(text), idx + len(query) + 80)
            snippet = text[start:end].replace("\n", " ")
            hits.append({"page": p, "snippet": snippet})
    return hits


_WORD_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_\-]+")


def tokenize(text: str) -> List[str]:
    return [t.lower() for t in _WORD_RE.findall(text or "")]


def chunk_text(text: str, *, chunk_chars: int = 1200, overlap_chars: int = 200) -> List[str]:
    if not text:
        return []
    chunk_chars = max(200, chunk_chars)
    overlap_chars = max(0, min(overlap_chars, chunk_chars - 1))

    chunks: List[str] = []
    i = 0
    n = len(text)
    while i < n:
        end = min(n, i + chunk_chars)
        chunk = text[i:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == n:
            break
        i = end - overlap_chars
    return chunks


def build_page_chunks(pages: Dict[int, str], *, chunk_chars: int = 1200, overlap_chars: int = 200) -> List[Dict[str, Any]]:
    """Create chunk objects from page->text mapping.

    Returns list of dicts: {page, text, tokens_set}
    """
    out: List[Dict[str, Any]] = []
    for page_num, page_text in pages.items():
        for chunk in chunk_text(page_text, chunk_chars=chunk_chars, overlap_chars=overlap_chars):
            toks = tokenize(chunk)
            out.append({"page": page_num, "text": chunk.replace("\n", " ").strip(), "tokens_set": set(toks)})
    return out


def score_overlap(query_tokens: Iterable[str], chunk_tokens_set: set[str]) -> int:
    score = 0
    for t in query_tokens:
        if t in chunk_tokens_set:
            score += 1
    return score

def simple_rag_search(pdf_dir: Path, query: str, top_k: int = 3) -> List[Tuple[str, int, str]]:
    """Simple RAG: search all PDFs, return top_k relevant chunks.
    Returns: List of (pdf_filename, page_number, text_snippet)
    """
    # Legacy helper kept for compatibility with older code paths.
    # It now uses token-overlap scoring over chunks.
    query_tokens = tokenize(query)
    if not query_tokens:
        return []

    scored: List[Tuple[int, str, int, str]] = []
    for pdf_file in pdf_dir.glob("*.pdf"):
        try:
            pages = extract_text_by_page(str(pdf_file))
            chunks = build_page_chunks(pages)
            for c in chunks:
                s = score_overlap(query_tokens, c["tokens_set"])
                if s > 0:
                    scored.append((s, pdf_file.name, int(c["page"]), str(c["text"])[:900]))
        except Exception:
            continue

    scored.sort(key=lambda x: x[0], reverse=True)
    return [(pdf, page, snippet) for _, pdf, page, snippet in scored[:top_k]]
