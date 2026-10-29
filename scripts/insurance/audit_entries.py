"""Probe public source entries without calling paid services or an LLM.

An entry probe measures transport and visible list evidence only. A separate
production-collector preview is needed before a source is enabled.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import ipaddress
import json
from pathlib import Path
import re
import threading
import time
from urllib.parse import urljoin, urlsplit
import xml.etree.ElementTree as ET

import requests


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.in_title = False
        self.link = None
        self.links = []
        self.feeds = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "a" and attrs.get("href"):
            self.link = {"href": attrs["href"], "text": ""}
        if tag == "link" and attrs.get("href") and re.search(r"rss|atom", attrs.get("type", ""), re.I):
            self.feeds.append(attrs["href"])

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.link:
            self.link["text"] = re.sub(r"\s+", " ", self.link["text"]).strip()
            self.links.append(self.link)
            self.link = None

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.link:
            self.link["text"] += data


LOCKS = defaultdict(threading.Lock)
MAX_BYTES = 1_500_000


def public_address(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        return False
    if parsed.hostname.lower() in ("localhost", "metadata.google.internal"):
        return False
    try:
        return ipaddress.ip_address(parsed.hostname).is_global
    except ValueError:
        return True


def probe(source, output):
    source_id = source["catalogId"]
    started = time.monotonic()
    result = {"catalogId": source_id, "name": source["name"], "requestedUrl": source.get("url"),
              "checkedAt": datetime.now(timezone.utc).isoformat(), "scope": "entry_response_only"}
    if source.get("accountId"):
        return dict(result, outcome="needs_paid_provider", reason="WeChat account requires configured authorized collection provider; not called.")
    url = source.get("url")
    if not url or not public_address(url):
        return dict(result, outcome="missing_or_nonpublic_url")
    host = urlsplit(url).hostname.lower()
    with LOCKS[host]:
        try:
            session = requests.Session()
            session.headers.update({"User-Agent": "InsuranceHotSourceAudit/0.1 (+local source validation)",
                                    "Accept": "application/rss+xml, application/atom+xml, application/json, text/html;q=0.9, */*;q=0.5"})
            redirects = []
            for _ in range(6):
                response = session.get(url, timeout=(8, 12), allow_redirects=False, stream=True)
                if response.is_redirect:
                    following = urljoin(url, response.headers.get("location", ""))
                    redirects.append({"url": url, "status": response.status_code, "location": following})
                    response.close()
                    if not public_address(following):
                        raise ValueError("nonpublic redirect refused")
                    url = following
                    continue
                break
            else:
                raise ValueError("redirect limit exceeded")
            chunks = []
            size = 0
            truncated = False
            for chunk in response.iter_content(65536):
                if size + len(chunk) > MAX_BYTES:
                    chunks.append(chunk[:MAX_BYTES - size])
                    truncated = True
                    break
                chunks.append(chunk)
                size += len(chunk)
            raw = b"".join(chunks)
            response.close()
            body_file = output / "responses" / (source_id + ".body")
            body_file.write_bytes(raw)
            charset = re.search(r"charset=[\"']?([a-zA-Z0-9_-]+)", response.headers.get("content-type", "") + raw[:1000].decode("ascii", "ignore"), re.I)
            encoding = charset.group(1) if charset else "utf-8"
            try:
                text = raw.decode(encoding, "replace")
            except LookupError:
                text = raw.decode("utf-8", "replace")
            result.update({"finalUrl": url, "httpStatus": response.status_code, "contentType": response.headers.get("content-type", ""),
                           "redirects": redirects, "bytesSaved": len(raw), "truncated": truncated,
                           "sha256": hashlib.sha256(raw).hexdigest(), "responseFile": body_file.as_posix()})
            if response.status_code >= 400:
                result["outcome"] = "http_error"
            elif re.search(r"<(?:rss|feed)(?:\s|>)", text[:1000], re.I):
                root = ET.fromstring(raw)
                items = root.findall(".//item") + root.findall("{http://www.w3.org/2005/Atom}entry")
                samples = []
                for item in items[:5]:
                    title = item.findtext("title") or item.findtext("{http://www.w3.org/2005/Atom}title")
                    link = item.findtext("link")
                    if not link:
                        node = item.find("{http://www.w3.org/2005/Atom}link")
                        link = node.attrib.get("href") if node is not None else None
                    date = item.findtext("pubDate") or item.findtext("{http://www.w3.org/2005/Atom}published") or item.findtext("{http://www.w3.org/2005/Atom}updated")
                    samples.append({"title": title, "url": link, "publishedAtRaw": date})
                result.update(outcome="rss_entries_parsed" if items else "rss_empty", itemCount=len(items), samples=samples)
            elif text.lstrip().startswith(("{", "[")):
                parsed = json.loads(text)
                result.update(outcome="json_response_unmapped", jsonRootType=type(parsed).__name__,
                              jsonRootKeys=list(parsed)[:30] if isinstance(parsed, dict) else None,
                              rootArrayCount=len(parsed) if isinstance(parsed, list) else None)
            elif "html" in response.headers.get("content-type", "").lower() or "<html" in text[:2000].lower():
                page = Page()
                page.feed(text)
                candidates = []
                seen = set()
                for link in page.links:
                    target = urljoin(url, link["href"])
                    if target in seen or not target.startswith(("http://", "https://")) or len(link["text"]) < 12:
                        continue
                    if re.search(r"/20\d{2}/|/20\d{6}|\d{5,}\.s?html|/news/[^/?#]+|/press[-/]?.+|/article/|/media[-/].+|/releases/", target, re.I):
                        candidates.append({"title": link["text"][:300], "url": target})
                        seen.add(target)
                challenge = re.search(r"access denied|just a moment|verify (?:that )?you are human|attention required|captcha|security check|robot check|访问验证|人机验证|拒绝访问", page.title + " " + re.sub(r"<[^>]+>", " ", text[:3000]), re.I)
                result.update(outcome="access_challenge" if challenge else "html_candidates_unverified" if candidates else "html_no_article_candidates", pageTitle=page.title.strip()[:400],
                              candidateCount=len(candidates), candidateSamples=candidates[:20],
                              discoveredFeeds=list(dict.fromkeys(urljoin(url, href) for href in page.feeds))[:10])
            else:
                result["outcome"] = "non_html_response"
        except Exception as error:
            result.update(outcome="network_or_parse_error", error=type(error).__name__ + ": " + str(error)[:350])
        finally:
            result["durationSeconds"] = round(time.monotonic() - started, 2)
            time.sleep(0.2)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=Path("industry/source-catalog.json"))
    parser.add_argument("--output", type=Path, default=Path(".data/source-audit"))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--resume", action="store_true", help="Reuse saved results when the catalog ID and requested URL match")
    args = parser.parse_args()
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    sources = catalog["sources"][:args.limit]
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "responses").mkdir(exist_ok=True)
    previous = {}
    results_file = args.output / "entry-results.jsonl"
    if args.resume and results_file.exists():
        for line in results_file.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            previous[record["catalogId"]] = record
    results = [previous[s["catalogId"]] for s in sources if s["catalogId"] in previous
               and previous[s["catalogId"]].get("requestedUrl") == s.get("url")]
    done_ids = {r["catalogId"] for r in results}
    pending = [source for source in sources if source["catalogId"] not in done_ids]
    with results_file.open("w", encoding="utf-8") as stream:
        for result in results:
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
        stream.flush()
        with ThreadPoolExecutor(max_workers=6) as pool:
            jobs = {pool.submit(probe, source, args.output): source for source in pending}
            for job in as_completed(jobs):
                result = job.result()
                results.append(result)
                stream.write(json.dumps(result, ensure_ascii=False) + "\n")
                stream.flush()
                if len(results) % 25 == 0:
                    print(json.dumps({"completed": len(results), "of": len(sources), "outcomes": dict(Counter(r["outcome"] for r in results))}), flush=True)
    results.sort(key=lambda r: r["catalogId"])
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "scope": "Entry transport and visible list evidence only; not end-to-end collector success.",
              "totalEntries": len(results), "outcomes": dict(Counter(r["outcome"] for r in results)), "results": results}
    (args.output / "entry-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "results"}, ensure_ascii=False), flush=True)
