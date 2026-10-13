#!/usr/bin/env python3
"""Incrementally collect Korean Eternal Return character patch notes."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import urllib.request
from html.parser import HTMLParser
from pathlib import Path


BASE_URL = "https://playeternalreturn.com"
LIST_URL = f"{BASE_URL}/api/v1/posts/news?category=patchnote&page={{page}}&hl=ko-KR"
HEADERS = {
    "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Cookie": "locale=ko_KR",
    "User-Agent": "niah.site patch collector/1.0 (+https://niah.site)",
}


def fetch_text(url: str) -> str:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", "replace")


def fetch_json(url: str):
    return json.loads(fetch_text(url))


def normalize(value: str) -> str:
    return re.sub(r"\s+", "", value or "").replace("&", "앤드").casefold()


def clean_text(value: str) -> str:
    return " ".join((value or "").replace("\xa0", " ").split())


class ArticleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.content_depth = 0
        self.list_depth = 0
        self.block = None
        self.strong_depth = 0
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "div":
            if self.content_depth:
                self.content_depth += 1
            elif "er-article-detail__content" in attributes.get("class", ""):
                self.content_depth = 1
        if not self.content_depth:
            return
        if tag == "li":
            self.list_depth += 1
        if tag in {"p", "h1", "h2", "h3", "h4", "h5", "h6"} and self.block is None:
            self.block = {"tag": tag, "parts": [], "strong": [], "list_depth": self.list_depth}
        if tag == "strong" and self.block is not None:
            self.strong_depth += 1
        if tag == "br" and self.block is not None:
            self.block["parts"].append(" ")

    def handle_data(self, data):
        if self.block is None:
            return
        self.block["parts"].append(data)
        if self.strong_depth:
            self.block["strong"].append(data)

    def handle_endtag(self, tag):
        if not self.content_depth:
            return
        if tag == "strong" and self.strong_depth:
            self.strong_depth -= 1
        if self.block is not None and tag == self.block["tag"]:
            text = clean_text("".join(self.block["parts"]))
            if text:
                self.blocks.append({
                    "tag": tag,
                    "text": text,
                    "strong": clean_text("".join(self.block["strong"])),
                    "list_depth": self.block["list_depth"],
                })
            self.block = None
            self.strong_depth = 0
        if tag == "li" and self.list_depth:
            self.list_depth -= 1
        if tag == "div":
            self.content_depth -= 1


def parse_version(title: str) -> str | None:
    matches = re.findall(r"(?<!\d)(\d{1,2}\.\d+(?:[a-z])?)(?!\d)", title, re.I)
    return matches[-1].lower() if matches else None


def parse_characters(html: str, character_names: list[str]):
    parser = ArticleParser()
    parser.feed(html)
    lookup = {normalize(name): name for name in character_names}
    entries = {}
    current = None
    current_target = ""
    list_started = False

    for block in parser.blocks:
        text = block["text"]
        matched_name = lookup.get(normalize(text))
        strong_matches = normalize(block["strong"]) == normalize(text)
        if matched_name and strong_matches:
            current = entries.setdefault(matched_name, {"character": matched_name, "comment": "", "changes": []})
            current_target = ""
            list_started = False
            continue
        # A bold standalone label is a section boundary even when a newly
        # released character has not reached the local manifest yet. Without
        # this guard, its description and changes are attached to the previous
        # known character.
        if strong_matches and block["strong"]:
            current = None
            current_target = ""
            list_started = False
            continue
        if block["tag"].startswith("h"):
            current = None
            current_target = ""
            list_started = False
            continue
        if current is None:
            continue
        depth = int(block["list_depth"])
        if depth == 0:
            if not list_started and not current["comment"]:
                current["comment"] = text
            continue
        list_started = True
        if depth == 1 and "→" not in text:
            current_target = text
            continue
        if "→" in text or depth >= 2:
            change = {"target": current_target if depth >= 2 else "", "text": text}
            if change not in current["changes"]:
                current["changes"].append(change)

    return [entry for entry in entries.values() if entry["changes"]]


def atomic_write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def collect(data_dir: Path, pages: int, dry_run: bool, force: bool = False) -> dict:
    manifest = json.loads((data_dir / "character_manifest.json").read_text(encoding="utf-8"))
    output_path = data_dir / "character_patches.json"
    existing = json.loads(output_path.read_text(encoding="utf-8")) if output_path.exists() else []
    by_id = {int(item["id"]): item for item in existing if item.get("id") is not None}
    discovered = {}
    for page in range(1, pages + 1):
        payload = fetch_json(LIST_URL.format(page=page))
        for article in payload.get("articles", []):
            locale = article.get("i18ns", {}).get("ko_KR", {})
            title = clean_text(locale.get("title", ""))
            version = parse_version(title)
            if version:
                discovered[int(article["id"])] = (article, title, version)

    active_major = max(int(item[2].split(".", 1)[0]) for item in discovered.values())
    discovered = {
        article_id: item
        for article_id, item in discovered.items()
        if int(item[2].split(".", 1)[0]) == active_major
    }
    by_id = {
        article_id: item
        for article_id, item in by_id.items()
        if str(item.get("patch_version", "")).split(".", 1)[0] == str(active_major)
    }

    fetched = 0
    added = 0
    updated = 0
    skipped = 0
    for article_id, (article, title, version) in discovered.items():
        old = by_id.get(article_id)
        if not force and old and old.get("updated_at") == article.get("updated_at"):
            skipped += 1
            continue
        url = f"{BASE_URL}/posts/news/{article_id}?hl=ko-KR"
        characters = parse_characters(fetch_text(url), list(manifest.get("characters", {})))
        fetched += 1
        if not characters:
            skipped += 1
            continue
        item = {
            "id": article_id,
            "patch_version": version,
            "patch_series": re.sub(r"[a-z]+$", "", version),
            "title": title,
            "published_at": article.get("created_at"),
            "updated_at": article.get("updated_at"),
            "url": url,
            "characters": characters,
        }
        by_id[article_id] = item
        if old:
            updated += 1
        else:
            added += 1

    result = sorted(by_id.values(), key=lambda item: (item.get("published_at") or "", int(item.get("id", 0))))
    if not dry_run:
        atomic_write_json(output_path, result)
    return {
        "articles": len(result),
        "discovered": len(discovered),
        "fetched": fetched,
        "added": added,
        "updated": updated,
        "skipped": skipped,
        "dryRun": dry_run,
        "activeMajor": active_major,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--pages", type=int, default=2)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="reparse discovered articles even when timestamps match")
    args = parser.parse_args()
    if args.pages < 1 or args.pages > 10:
        parser.error("--pages must be between 1 and 10")
    try:
        result = collect(Path(args.data_dir), args.pages, args.dry_run, args.force)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(f"patch collection failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

