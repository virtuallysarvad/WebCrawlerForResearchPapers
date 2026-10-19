#!/usr/bin/env python3
"""
fetch_paper.py -- download an arXiv paper as HTML for Paper Crawler.

Why this script exists
----------------------
Browsers cannot fetch arxiv.org directly from a local page because of CORS.
This script downloads the paper HTML once, rewrites relative asset URLs to
absolute ones (so figures still load), and saves the metadata alongside it:

    papers/<id>.html   the paper itself
    papers/<id>.json   title, authors, date, abstract, source URL

Usage
-----
    python fetch_paper.py                 # Attention Is All You Need
    python fetch_paper.py 1706.03762
    python fetch_paper.py https://arxiv.org/abs/1706.03762
    python fetch_paper.py --batch "1706.03762 2005.14165 1810.04805"
    python fetch_paper.py 1706.03762 --force

Only the Python standard library is used. arXiv asks API users to be polite:
we send a descriptive User-Agent and keep at least 3 seconds between requests.
"""

from __future__ import annotations

import argparse
import html as html_lib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_PAPER = "1706.03762"  # "Attention Is All You Need"
BASE_DIR = Path(__file__).resolve().parent
PAPERS_DIR = BASE_DIR / "papers"

USER_AGENT = (
    "PaperCrawler/1.0 (educational arXiv reader; "
    "https://github.com/paper-crawler) Python-urllib"
)

ARXIV_API = "http://export.arxiv.org/api/query?id_list={id}"
HTML_SOURCES = (
    "https://arxiv.org/html/{id}",             # native HTML, mostly late 2023+
    "https://ar5iv.labs.arxiv.org/html/{id}",  # community HTML for older papers
)

REQUEST_GAP_SECONDS = 3.0   # arXiv API etiquette
TIMEOUT_SECONDS = 45
ATOM_NS = {"atom": "http://www.w3.org/2005/Atom",
           "arxiv": "http://arxiv.org/schemas/atom"}

_last_request_at = 0.0


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    print(message, flush=True)


def normalize_id(value: str) -> str:
    """Turn an arXiv URL, PDF name, or bare ID into a canonical ID.

    Accepts modern IDs (1706.03762, 1706.03762v5), old-style IDs
    (hep-th/9901001) and URLs such as arxiv.org/abs/1706.03762v2.
    """
    value = (value or "").strip()
    if not value:
        return DEFAULT_PAPER

    value = urllib.parse.unquote(value)
    # Remove a trailing .pdf and common URL noise.
    value = re.sub(r"\.pdf$", "", value, flags=re.I)
    value = value.split("?")[0].split("#")[0].rstrip("/")

    modern = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", value)
    if modern:
        return modern.group(1) + (modern.group(2) or "")

    old = re.search(r"([a-z][a-z\-]*(?:\.[a-z]{2})?/\d{7})(v\d+)?", value, re.I)
    if old:
        return old.group(1) + (old.group(2) or "")

    # Let arXiv decide, but keep the value URL-safe.
    return re.sub(r"\s+", "", value)


def versionless(paper_id: str) -> str:
    return re.sub(r"v\d+$", "", paper_id, flags=re.I)


def slugify_id(paper_id: str) -> str:
    """Filesystem-safe name used for papers/<id>.html."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", paper_id)


def polite_get(url: str) -> tuple[bytes, str, int]:
    """GET a URL, keeping a 3-second gap between arXiv requests.

    Returns (body, final_url, status). Raises urllib errors for non-2xx.
    """
    global _last_request_at
    elapsed = time.monotonic() - _last_request_at
    if _last_request_at and elapsed < REQUEST_GAP_SECONDS:
        wait = REQUEST_GAP_SECONDS - elapsed
        log(f"  (waiting {wait:.1f}s to be polite to arXiv)")
        time.sleep(wait)

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read()
            final_url = response.geturl()
            status = response.status
    except urllib.error.HTTPError:
        _last_request_at = time.monotonic()
        raise
    except urllib.error.URLError as exc:
        _last_request_at = time.monotonic()
        raise urllib.error.URLError(f"Network error for {url}: {exc.reason}") from exc

    _last_request_at = time.monotonic()
    return body, final_url, status


# ---------------------------------------------------------------------------
# Metadata (arXiv Atom API)
# ---------------------------------------------------------------------------

def fetch_metadata(paper_id: str) -> dict:
    """Read title, authors, date and abstract from the arXiv Atom API."""
    query_id = urllib.parse.quote(paper_id, safe="/.")
    url = ARXIV_API.format(id=query_id)
    log(f"  metadata: {url}")
    body, _, _ = polite_get(url)

    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise RuntimeError(f"Could not parse the arXiv API response: {exc}") from exc

    entry = root.find("atom:entry", ATOM_NS)
    if entry is None:
        raise RuntimeError("arXiv returned no entry for this ID.")

    def text(path: str) -> str:
        node = entry.find(path, ATOM_NS)
        return " ".join((node.text or "").split()) if node is not None else ""

    title = text("atom:title")
    # arXiv marks up line breaks in titles; collapse them for display.
    title = re.sub(r"\s+", " ", title).strip()
    if not title or title.lower() == "error":
        raise RuntimeError("arXiv returned an empty entry (is the ID correct?).")

    authors = []
    for author in entry.findall("atom:author", ATOM_NS):
        name = author.find("atom:name", ATOM_NS)
        if name is not None and name.text:
            authors.append(" ".join(name.text.split()))

    published = text("atom:published") or text("atom:updated")
    updated = text("atom:updated")
    summary = text("atom:summary")
    abs_url = ""
    id_node = entry.find("atom:id", ATOM_NS)
    if id_node is not None and id_node.text:
        abs_url = id_node.text.strip()

    primary = entry.find("arxiv:primary_category", ATOM_NS)
    category = primary.get("term", "") if primary is not None else ""

    return {
        "id": paper_id,
        "arxivId": paper_id,
        "title": title,
        "authors": authors,
        "published": published,
        "updated": updated,
        "date": (published or updated)[:10],
        "abstract": summary,
        "category": category,
        "absUrl": abs_url or f"https://arxiv.org/abs/{paper_id}",
    }


# ---------------------------------------------------------------------------
# HTML download + cleanup
# ---------------------------------------------------------------------------

_URL_ATTR_RE = re.compile(
    r"""(\b(?:src|href|poster|data|data-src|data-original|srcset)\s*=\s*)(["'])(.*?)\2""",
    re.IGNORECASE | re.DOTALL,
)
_CSS_URL_RE = re.compile(r"""url\(\s*(['"]?)([^)'"]+)\1\s*\)""", re.IGNORECASE)


def _absolute_url(base_url: str, value: str) -> str:
    value = html_lib.unescape(value.strip())
    if not value:
        return value
    low = value.lower()
    if low.startswith(("data:", "blob:", "mailto:", "tel:", "javascript:", "#")):
        return value
    return urllib.parse.urljoin(base_url, value)


def _rewrite_srcset(base_url: str, value: str) -> str:
    parts = []
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        bits = item.split()
        bits[0] = _absolute_url(base_url, bits[0])
        parts.append(" ".join(bits))
    return ", ".join(parts)


def rewrite_relative_urls(html: str, base_url: str) -> str:
    """Make image/CSS/script URLs absolute so the local page can load them.

    We deliberately keep the markup otherwise untouched: MathML, tables and
    arXiv's own classes must survive for the loader to render them correctly.
    """
    def replace_attr(match: re.Match) -> str:
        prefix, quote, value = match.groups()
        if prefix.lower().startswith("srcset"):
            new_value = _rewrite_srcset(base_url, value)
        else:
            new_value = _absolute_url(base_url, value)
        return f"{prefix}{quote}{html_lib.escape(new_value, quote=True)}{quote}"

    html = _URL_ATTR_RE.sub(replace_attr, html)

    def replace_css(match: re.Match) -> str:
        quote, value = match.groups()
        return f"url({quote}{_absolute_url(base_url, value)}{quote})"

    html = _CSS_URL_RE.sub(replace_css, html)

    # A <base> is a safety net for URLs our regexes did not catch. It is
    # harmless once assets are absolute, and the loader ignores it.
    if re.search(r"<base\b", html, re.I):
        html = re.sub(r"<base\b[^>]*>", "", html, flags=re.I)
    base_tag = f'<base href="{html_lib.escape(base_url, quote=True)}">'
    if re.search(r"<head\b[^>]*>", html, re.I):
        html = re.sub(r"(<head\b[^>]*>)", r"\1\n" + base_tag, html, count=1, flags=re.I)
    else:
        html = base_tag + html
    return html


def _looks_like_paper_html(body: bytes) -> bool:
    if len(body) < 4000:
        return False
    head = body[:200_000].decode("utf-8", errors="ignore").lower()
    if "<html" not in head and "<!doctype html" not in head:
        return False
    failure_markers = (
        "article not found",
        "no html for this paper",
        "html is not available",
        "does not have an html version",
        "there is no html version",
        "404 not found",
    )
    if any(marker in head for marker in failure_markers) and "<math" not in head:
        return False
    return True


def fetch_html(paper_id: str) -> tuple[str, str]:
    """Try arXiv native HTML, then ar5iv. Return (html, final_url)."""
    errors = []
    for template in HTML_SOURCES:
        url = template.format(id=urllib.parse.quote(paper_id, safe="/."))
        log(f"  html:     {url}")
        try:
            body, final_url, status = polite_get(url)
        except urllib.error.HTTPError as exc:
            errors.append(f"{url} -> HTTP {exc.code}")
            continue
        except Exception as exc:  # network failures should not abort the fallback
            errors.append(f"{url} -> {exc}")
            continue

        if status != 200 or not _looks_like_paper_html(body):
            errors.append(f"{url} -> no usable HTML ({len(body)} bytes)")
            continue

        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            text = body.decode("latin-1", errors="replace")
        log(f"  found {len(body) / 1024:.0f} KB of HTML")
        return rewrite_relative_urls(text, final_url), final_url

    detail = "\n    ".join(errors) if errors else "no sources tried"
    raise RuntimeError(
        "This paper has no HTML version on arXiv or ar5iv.\n"
        f"  Tried:\n    {detail}\n"
        "  Only papers with LaTeXML HTML (usually late 2023 onward) or an\n"
        "  ar5iv rendering can be used by Paper Crawler."
    )


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def download_paper(raw_id: str, force: bool = False) -> dict:
    paper_id = normalize_id(raw_id)
    paper_key = slugify_id(paper_id)
    PAPERS_DIR.mkdir(parents=True, exist_ok=True)
    html_path = PAPERS_DIR / f"{paper_key}.html"
    json_path = PAPERS_DIR / f"{paper_key}.json"

    if html_path.exists() and json_path.exists() and not force:
        log(f"OK papers/{html_path.name} already exists (use --force to refresh)")
        try:
            return json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass  # fall through to a fresh download

    log(f"\nPaper Crawler - fetching {paper_id}")
    metadata = fetch_metadata(paper_id)
    paper_html, final_url = fetch_html(paper_id)

    # Keep the version we actually downloaded in the metadata, but use the
    # canonical ID for filenames so switching versions is predictable.
    metadata.update({
        "id": paper_id,
        "paperKey": paper_key,
        "sourceHtmlUrl": final_url,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "htmlFile": f"{paper_key}.html",
    })

    html_path.write_text(paper_html, encoding="utf-8")
    json_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    log(f"OK saved papers/{html_path.name} ({len(paper_html) / 1024:.0f} KB)")
    log(f"OK saved papers/{json_path.name}")
    log(f"  {metadata['title']}")
    return metadata


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download an arXiv paper as HTML for Paper Crawler.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  python fetch_paper.py\n"
            "  python fetch_paper.py 1706.03762\n"
            "  python fetch_paper.py --batch \"1706.03762 2005.14165 1810.04805\"\n"
        ),
    )
    parser.add_argument("paper", nargs="?", default=DEFAULT_PAPER,
                        help="arXiv ID or URL (default: 1706.03762)")
    parser.add_argument("--batch", nargs="+", metavar="IDS",
                        help="space-separated list of IDs (quote the list)")
    parser.add_argument("--force", action="store_true",
                        help="re-download even if the paper is already saved")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if args.batch:
        raw_ids = []
        for item in args.batch:
            raw_ids.extend(item.split())
    else:
        raw_ids = [args.paper]

    if not raw_ids:
        raw_ids = [DEFAULT_PAPER]

    failures = 0
    saved = []
    for index, raw_id in enumerate(raw_ids):
        if index:
            # The polite_get helper also enforces this, but batch mode is
            # explicitly documented as spacing whole papers out.
            time.sleep(REQUEST_GAP_SECONDS)
        try:
            saved.append(download_paper(raw_id, force=args.force))
        except Exception as exc:
            failures += 1
            print(f"x {raw_id}: {exc}", file=sys.stderr, flush=True)

    if len(saved) > 1:
        log(f"\nDone: {len(saved)} paper(s) saved, {failures} failed.")
        for paper in saved:
            log(f"  - {paper.get('id')}  {paper.get('title')}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
