#!/usr/bin/env python3
"""
serve.py -- static file server + Claude explainer proxy for Paper Crawler.

    python serve.py            -> http://localhost:5173
    python serve.py --port 8080

The browser never sees the API key. The key is read from ANTHROPIC_API_KEY or
from a local .env file, and all Anthropic calls happen here.

Endpoints
---------
GET  /api/papers           list downloaded papers (papers/*.json)
GET  /api/status           whether AI is configured + model name (no secrets)
POST /api/explain          body: {paperId,title,section,text,level,sectionSlug?}
                           response: text/event-stream with live Claude output
GET  /api/cache            small summary of cached explanations (debugging)

Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration -- edit these freely
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
PAPERS_DIR = BASE_DIR / "papers"
CACHE_DIR = BASE_DIR / "cache"

# A current Claude Sonnet model. Override with CLAUDE_MODEL in the environment
# or .env if your account uses a different model id.
CLAUDE_MODEL = "claude-sonnet-4-5"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
MAX_OUTPUT_TOKENS = 500
MAX_SECTION_CHARS = 12_000
REQUEST_TIMEOUT_SECONDS = 120

# The prompt is intentionally kept in one place so it is easy to tune.
PROMPT_TEMPLATE = (
    "You are explaining the '{section}' section of the ML paper '{title}' "
    "to a {level}. In under 70 words: what this section says, why it matters, "
    "and any key number or result. Use plain English and one simple analogy if "
    "it helps. Define any jargon you use. Then output one line starting with "
    "'KEY:' containing the single most important exact phrase or number from "
    "the section text (copied exactly as written)."
)

LEVELS = {
    "beginner": "CS freshman",
    "student": "CS student who knows basic ML",
    "researcher": "ML researcher; be precise and technical",
}
DEFAULT_LEVEL = "student"

CACHE_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# .env + configuration helpers
# ---------------------------------------------------------------------------

def load_dotenv(path: Path = BASE_DIR / ".env") -> None:
    """Load KEY=VALUE lines from .env without overriding real env vars.

    Deliberately tiny: no dependency on python-dotenv.
    """
    if not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        # A real environment variable always wins over the file.
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()


def get_api_key() -> str:
    load_dotenv()  # pick up a key added while the server is running
    return os.environ.get("ANTHROPIC_API_KEY", "").strip()


def get_model() -> str:
    load_dotenv()
    return os.environ.get("CLAUDE_MODEL", "").strip() or CLAUDE_MODEL


def safe_slug(value: str, fallback: str = "section", limit: int = 60) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return (slug[:limit].strip("-") or fallback)


def safe_paper_id(value: str) -> str:
    value = (value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", value):
        return ""
    return value


def cache_path(paper_id: str, section_slug: str) -> Path:
    return CACHE_DIR / f"{paper_id}_{safe_slug(section_slug)}.json"


def read_cache(paper_id: str, section_slug: str, level: str) -> dict | None:
    path = cache_path(paper_id, section_slug)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = (data.get("levels") or {}).get(level)
    if not entry or not entry.get("text"):
        return None
    return entry


def write_cache(paper_id: str, section_slug: str, level: str, entry: dict) -> None:
    path = cache_path(paper_id, section_slug)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with CACHE_LOCK:
        data: dict = {}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
        data.setdefault("paperId", paper_id)
        data.setdefault("sectionSlug", safe_slug(section_slug))
        data.setdefault("levels", {})
        data["levels"][level] = entry
        data["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        # Write atomically so an interrupted request cannot corrupt the cache.
        temp = path.with_suffix(".tmp")
        temp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temp.replace(path)


# ---------------------------------------------------------------------------
# Paper listing
# ---------------------------------------------------------------------------

def list_papers() -> list[dict]:
    PAPERS_DIR.mkdir(parents=True, exist_ok=True)
    papers = []
    for json_path in PAPERS_DIR.glob("*.json"):
        try:
            meta = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        paper_key = meta.get("paperKey") or json_path.stem
        html_path = PAPERS_DIR / f"{paper_key}.html"
        if not html_path.exists() and not (PAPERS_DIR / f"{json_path.stem}.html").exists():
            continue
        papers.append({
            "id": meta.get("id") or json_path.stem,
            "paperKey": paper_key,
            "title": meta.get("title") or json_path.stem,
            "authors": meta.get("authors") or [],
            "date": meta.get("date") or meta.get("published", "")[:10],
            "abstract": meta.get("abstract") or "",
            "category": meta.get("category") or "",
            "absUrl": meta.get("absUrl") or f"https://arxiv.org/abs/{json_path.stem}",
            "htmlFile": f"{paper_key}.html",
            "sourceHtmlUrl": meta.get("sourceHtmlUrl") or f"https://arxiv.org/html/{meta.get('id') or json_path.stem}",
            "hasHtml": html_path.exists(),
            "fetchedAt": meta.get("fetchedAt") or "",
        })
    # Newest downloads first, but keep a stable title fallback.
    papers.sort(key=lambda p: (p.get("fetchedAt") or "", p["title"]), reverse=True)
    return papers


# ---------------------------------------------------------------------------
# Anthropic streaming
# ---------------------------------------------------------------------------

def build_prompt(section: str, title: str, level: str) -> str:
    level_text = LEVELS.get(level, LEVELS[DEFAULT_LEVEL])
    return PROMPT_TEMPLATE.format(
        section=section or "selected passage",
        title=title or "the paper",
        level=level_text,
    )


def anthropic_stream(prompt: str):
    """Yield ('text', str) / ('error', str) tuples from the Messages API."""
    import socket
    key = get_api_key()
    if not key:
        yield ("error", "No ANTHROPIC_API_KEY is set. Add it to .env, restart "
                        "python serve.py, and reload. The spider and markup "
                        "still work without AI.")
        return

    payload = {
        "model": get_model(),
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream": True,
        "temperature": 0.4,
        "messages": [{"role": "user", "content": prompt}],
    }
    request = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION,
            "accept": "text/event-stream",
        },
        method="POST",
    )

    try:
        response = urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        message = raw
        try:
            parsed = json.loads(raw)
            message = (parsed.get("error") or {}).get("message") or raw
        except ValueError:
            pass
        yield ("error", f"Anthropic API error {exc.code}: {message[:500]}")
        return
    except urllib.error.URLError as exc:
        yield ("error", f"Could not reach Anthropic: {exc.reason}")
        return
    except (TimeoutError, socket.timeout):
        yield ("error", "The Anthropic request timed out.")
        return

    try:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                event = json.loads(data)
            except ValueError:
                continue
            event_type = event.get("type")
            if event_type == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    yield ("text", delta["text"])
            elif event_type == "error":
                message = (event.get("error") or {}).get("message") or "Unknown API error"
                yield ("error", message)
                return
            elif event_type == "message_stop":
                return
    except Exception as exc:  # streaming socket errors
        yield ("error", f"Stream interrupted: {exc}")


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class PaperCrawlerHandler(SimpleHTTPRequestHandler):
    server_version = "PaperCrawler/1.0"
    protocol_version = "HTTP/1.0"  # SSE friendly: no Content-Length needed
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".svg": "image/svg+xml; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    # -- logging ---------------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # -- helpers ---------------------------------------------------------
    def send_json(self, data, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_sse_headers(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def send_sse(self, event: str, payload: dict | str) -> bool:
        data = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        try:
            self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode("utf-8"))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return False

    # -- routing ---------------------------------------------------------
    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/papers":
            self.send_json({"papers": list_papers()})
            return
        if path == "/api/status":
            key = get_api_key()
            self.send_json({
                "aiConfigured": bool(key),
                "model": get_model(),
                "levels": LEVELS,
                "defaultLevel": DEFAULT_LEVEL,
                "paperCount": len(list_papers()),
                "cacheDir": "cache/",
            })
            return
        if path == "/api/cache":
            files = sorted(p.name for p in CACHE_DIR.glob("*.json")) if CACHE_DIR.exists() else []
            self.send_json({"count": len(files), "files": files[:100]})
            return
        # Static files. Never serve .env or backend secrets.
        if path in ("/.env", "/.gitignore") or path.startswith("/cache/") or path.startswith("/.git/"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        return super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path != "/api/explain":
            self.send_json({"error": "Not found"}, status=404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 2_000_000:
            self.send_json({"error": "Invalid request body"}, status=400)
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_json({"error": "Body must be JSON"}, status=400)
            return

        paper_id = safe_paper_id(str(body.get("paperId", "")))
        section = str(body.get("section", "")).strip()[:200]
        title = str(body.get("title", "")).strip()[:300]
        text = str(body.get("text", "")).strip()
        level = str(body.get("level", DEFAULT_LEVEL)).lower()
        if level not in LEVELS:
            level = DEFAULT_LEVEL

        if not paper_id or not section or not text:
            self.send_json({"error": "paperId, section and text are required"}, status=400)
            return

        requested_slug = str(body.get("sectionSlug", "")).strip()
        if requested_slug.startswith("selection-"):
            # Include a content hash so different selections don't collide.
            digest = hashlib.sha1(text[:4000].encode("utf-8")).hexdigest()[:8]
            slug = f"selection-{safe_slug(section, 'passage', 32)}-{digest}"
        else:
            slug = safe_slug(requested_slug or section, "section")

        text = text[:MAX_SECTION_CHARS]
        prompt = build_prompt(section, title, level)
        cached = read_cache(paper_id, slug, level)

        self.send_sse_headers()

        if cached:
            self.send_sse("meta", {
                "cached": True,
                "model": cached.get("model", get_model()),
                "level": level,
                "section": section,
            })
            self.send_sse("delta", {"text": cached["text"]})
            self.send_sse("done", {
                "cached": True,
                "key": cached.get("key", ""),
                "section": section,
                "level": level,
            })
            return

        self.send_sse("meta", {
            "cached": False,
            "model": get_model(),
            "level": level,
            "section": section,
        })

        parts: list[str] = []
        failed = False
        for kind, value in anthropic_stream(prompt):
            if kind == "text":
                parts.append(value)
                if not self.send_sse("delta", {"text": value}):
                    failed = True
                    break
            elif kind == "error":
                failed = True
                self.send_sse("error", {"message": value})
                break

        if failed:
            return  # do not cache partial/error output

        full_text = "".join(parts).strip()
        key = ""
        match = re.search(r"(?im)^\s*KEY:\s*(.+?)\s*$", full_text)
        if match:
            key = match.group(1).strip().strip("`\"'“”").strip()
            key = re.sub(r"\s+", " ", key)

        if full_text:
            entry = {
                "text": full_text,
                "key": key,
                "model": get_model(),
                "level": level,
                "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            try:
                write_cache(paper_id, slug, level, entry)
            except OSError as exc:
                sys.stderr.write(f"cache write failed: {exc}\n")

        self.send_sse("done", {
            "cached": False,
            "key": key,
            "section": section,
            "level": level,
        })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Paper Crawler dev server")
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    PAPERS_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    httpd = ThreadingHTTPServer((args.host, args.port), PaperCrawlerHandler)
    url = f"http://localhost:{args.port}"
    papers = list_papers()
    print()
    print("  PAPER CRAWLER")
    print(f"  Serving {BASE_DIR}")
    print(f"  Open    {url}")
    print(f"  Papers  {len(papers)} found in papers/")
    if get_api_key():
        print(f"  Claude  configured (model: {get_model()})")
    else:
        print("  Claude  NOT configured -- add ANTHROPIC_API_KEY to .env")
        print("          The spider still works; explanations will be disabled.")
    print("  Ctrl+C to stop\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
