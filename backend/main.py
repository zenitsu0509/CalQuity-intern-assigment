import asyncio
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from pdf_utils import (
    build_page_chunks,
    extract_text_by_page,
    find_query_positions,
    score_overlap,
    tokenize,
)


load_dotenv()

app = FastAPI(title="intersala-2 backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PDF_STORAGE = Path(__file__).parent / "pdfs"
PDF_STORAGE.mkdir(exist_ok=True)

JOB_QUEUES: Dict[str, asyncio.Queue] = {}
UPLOAD_QUEUES: Dict[str, asyncio.Queue] = {}

# In-memory index built on upload.
# Each chunk: {pdf_id, title, page, text, tokens_set}
DOC_CHUNKS: list[dict[str, Any]] = []
DOC_UPLOAD_ORDER: list[str] = []


def rag_search_index(query: str, *, top_k: int = 4) -> list[dict[str, Any]]:
    q_tokens = tokenize(query)
    if not q_tokens or not DOC_CHUNKS:
        return []
    scored: list[tuple[int, dict[str, Any]]] = []
    for ch in DOC_CHUNKS:
        s = score_overlap(q_tokens, ch["tokens_set"])
        if s > 0:
            scored.append((s, ch))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:top_k]]


def fallback_recent_chunks(*, top_k: int = 3) -> list[dict[str, Any]]:
    """If retrieval returns 0 hits, fall back to the most recently uploaded PDF's first chunks."""
    if not DOC_UPLOAD_ORDER:
        return []
    recent = DOC_UPLOAD_ORDER[-1]
    chunks = [c for c in DOC_CHUNKS if c.get("pdf_id") == recent]
    chunks.sort(key=lambda c: (int(c.get("page", 0)), len(str(c.get("text", "")))))
    return chunks[:top_k]


def sse_format(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _safe_pdf_filename(original: str) -> str:
    name = (original or "").strip().replace("\\", "_").replace("/", "_")
    name = re.sub(r"[^a-zA-Z0-9._-]+", "_", name)
    if not name.lower().endswith(".pdf"):
        name = f"{name}.pdf" if name else f"upload_{uuid.uuid4().hex}.pdf"
    return name


class ThinkTagStripper:
    """Streaming filter that removes <think>...</think> and <thinking>...</thinking>."""

    def __init__(self) -> None:
        self._buf = ""
        self._in_tag: Optional[str] = None  # "think" or "thinking"

    def _find_start(self, s: str) -> Optional[tuple[int, str, int]]:
        i1 = s.find("<think>")
        i2 = s.find("<thinking>")
        if i1 == -1 and i2 == -1:
            return None
        if i2 == -1 or (i1 != -1 and i1 < i2):
            return i1, "think", len("<think>")
        return i2, "thinking", len("<thinking>")

    def feed(self, text: str) -> str:
        if not text:
            return ""

        self._buf += text
        out: list[str] = []

        while self._buf:
            if self._in_tag:
                end_tag = f"</{self._in_tag}>"
                end = self._buf.find(end_tag)
                if end == -1:
                    # keep small tail in case closing tag spans chunks
                    if len(self._buf) > 64:
                        self._buf = self._buf[-64:]
                    return "".join(out)
                self._buf = self._buf[end + len(end_tag) :]
                self._in_tag = None
                continue

            found = self._find_start(self._buf)
            if not found:
                out.append(self._buf)
                self._buf = ""
                break

            start, tag, tag_len = found
            if start > 0:
                out.append(self._buf[:start])
            self._buf = self._buf[start + tag_len :]
            self._in_tag = tag

        return "".join(out)

    def flush(self) -> str:
        if self._in_tag:
            # inside think tag: drop remaining buffer
            self._buf = ""
            return ""
        out = self._buf
        self._buf = ""
        return out


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/upload_pdf")
async def upload_pdf(background: BackgroundTasks, file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only .pdf files supported")

    upload_id = uuid.uuid4().hex
    q: asyncio.Queue = asyncio.Queue()
    UPLOAD_QUEUES[upload_id] = q

    original_name = file.filename
    safe_name = _safe_pdf_filename(original_name)
    # Avoid collisions
    if (PDF_STORAGE / safe_name).exists():
        safe_name = f"{Path(safe_name).stem}_{uuid.uuid4().hex[:8]}.pdf"

    data = await file.read()

    async def worker() -> None:
        try:
            await q.put(("progress", {"text": "Saving file", "progress": 35}))
            dest = PDF_STORAGE / safe_name
            dest.write_bytes(data)

            await q.put(("progress", {"text": "Extracting text", "progress": 75}))
            pages = extract_text_by_page(str(dest))
            total_pages = len(pages)

            await q.put(("progress", {"text": f"Chunking {total_pages} pages", "progress": 85}))
            page_chunks = build_page_chunks(pages, chunk_chars=1200, overlap_chars=200)

            await q.put(("progress", {"text": f"Indexing {len(page_chunks)} chunks", "progress": 92}))

            # Update global in-memory index
            global DOC_CHUNKS, DOC_UPLOAD_ORDER
            DOC_CHUNKS = [c for c in DOC_CHUNKS if c.get("pdf_id") != safe_name]
            title = Path(safe_name).stem
            for c in page_chunks:
                DOC_CHUNKS.append(
                    {
                        "pdf_id": safe_name,
                        "title": title,
                        "page": int(c["page"]),
                        "text": str(c["text"]),
                        "tokens_set": c["tokens_set"],
                    }
                )
            DOC_UPLOAD_ORDER = [d for d in DOC_UPLOAD_ORDER if d != safe_name]
            DOC_UPLOAD_ORDER.append(safe_name)

            await q.put(("done", {"message": "Document ready to chat!", "filename": safe_name, "pages": total_pages, "chunks": len(page_chunks)}))
        except Exception as e:
            await q.put(("error", {"message": str(e)}))

    background.add_task(worker)
    return {"upload_id": upload_id, "filename": safe_name}


@app.get("/upload_progress/{upload_id}")
async def upload_progress(upload_id: str):
    q = UPLOAD_QUEUES.get(upload_id)
    if not q:
        raise HTTPException(status_code=404, detail="Upload not found")

    async def event_generator():
        try:
            while True:
                event_type, payload = await q.get()
                yield sse_format(event_type, payload)
                if event_type in ("done", "error"):
                    break
        finally:
            UPLOAD_QUEUES.pop(upload_id, None)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/generate")
async def generate(prompt: Dict[str, Any], background: BackgroundTasks) -> dict:
    """Enqueue a generation job and return job id. Body: {"prompt":"..."}."""
    text = prompt.get("prompt") if isinstance(prompt, dict) else None
    if not text:
        raise HTTPException(status_code=400, detail="Missing prompt")

    job_id = uuid.uuid4().hex
    q: asyncio.Queue = asyncio.Queue()
    JOB_QUEUES[job_id] = q

    async def worker(job_id: str, prompt_text: str) -> None:
        q = JOB_QUEUES[job_id]
        try:
            await q.put(("tool", {"step": "thinking", "text": "Analyzing your question"}))
            await asyncio.sleep(0.05)

            await q.put(("tool", {"step": "searching_documents", "text": "Searching PDF documents..."}))
            await asyncio.sleep(0.05)

            rag_results = rag_search_index(prompt_text, top_k=4)
            if not rag_results:
                rag_results = fallback_recent_chunks(top_k=3)
                await q.put(("tool", {"step": "retrieving_context", "text": f"No direct hits; using recent document context ({len(rag_results)} chunks)"}))
            else:
                await q.put(("tool", {"step": "retrieving_context", "text": f"Found {len(rag_results)} relevant sections"}))

            context_parts: list[str] = []
            citations: list[dict] = []
            for idx, r in enumerate(rag_results, start=1):
                pdf_id = str(r["pdf_id"])
                title = str(r["title"])
                page_num = int(r["page"])
                snippet = str(r["text"])[:900]
                context_parts.append(f"[{idx}] (PDF: {pdf_id}, page {page_num}) {snippet}")
                citations.append({"id": idx, "title": title, "pdf_id": pdf_id, "page": page_num})

            context = "\n\n".join(context_parts) if context_parts else "No relevant documents found."

            await q.put(("tool", {"step": "generating_answer", "text": "Generating response with LLM..."}))

            system_prompt = (
                "You are a helpful assistant. Use the provided PDF context snippets to answer. "
                "If the answer is not present in the context, say you couldn't find it in the uploaded PDFs. "
                "Cite sources with numbered citations like [1], [2] inline. "
                "Do not reveal chain-of-thought. Do not output <think> or <thinking> blocks."
            )
            user_prompt = (
                f"Context from documents:\n{context}\n\n"
                f"Question: {prompt_text}\n\n"
                "Answer using the context above."
            )

            if not os.getenv("GROQ_API_KEY"):
                await q.put(("text", {"chunk": "Error: GROQ_API_KEY not set. Add it to backend/.env"}))
            else:
                try:
                    from groq import Groq

                    groq_client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))
                    model = os.getenv("GROQ_MODEL", "qwen/qwen3-32b")
                    stripper = ThinkTagStripper()

                    stream = groq_client.chat.completions.create(
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        model=model,
                        temperature=0.5,
                        max_tokens=1024,
                        stream=True,
                    )

                    for chunk in stream:
                        delta = chunk.choices[0].delta
                        content = getattr(delta, "content", None)
                        if not content:
                            continue
                        safe = stripper.feed(content)
                        if safe:
                            await q.put(("text", {"chunk": safe}))
                        await asyncio.sleep(0)

                    tail = stripper.flush()
                    if tail:
                        await q.put(("text", {"chunk": tail}))
                except Exception as e:
                    await q.put(("text", {"chunk": f"Error calling Groq API: {str(e)}"}))

            for citation in citations:
                await q.put(("citation", citation))

            await q.put(("done", {"status": "finished"}))
        except Exception as e:
            await q.put(("text", {"chunk": f"Error: {str(e)}"}))
            await q.put(("done", {"status": "error"}))

    background.add_task(worker, job_id, text)
    return {"job_id": job_id}


@app.get("/stream/{job_id}")
async def stream(job_id: str):
    q = JOB_QUEUES.get(job_id)
    if not q:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        try:
            while True:
                event_type, payload = await q.get()
                yield sse_format(event_type, payload)
                if event_type == "done":
                    break
        finally:
            JOB_QUEUES.pop(job_id, None)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/pdf/{pdf_id}")
async def get_pdf(pdf_id: str):
    p = PDF_STORAGE / pdf_id
    if not p.exists():
        raise HTTPException(status_code=404, detail="PDF not found")
    return FileResponse(p, media_type="application/pdf")


@app.get("/pdf_search/{pdf_id}")
async def pdf_search(pdf_id: str, q: str):
    p = PDF_STORAGE / pdf_id
    if not p.exists():
        raise HTTPException(status_code=404, detail="PDF not found")
    pages = extract_text_by_page(str(p))
    hits = find_query_positions(pages, q)
    return {"hits": hits}
