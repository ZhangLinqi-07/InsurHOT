"""Preserve user-supplied source tables with line-level provenance.

Usage: python scripts/insurance/source_inventory.py <source.md> [<source.md> ...]
This catalog is evidence and discovery input. It is not an enabled collector list.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def normalize_url(value: str) -> str | None:
    text = re.sub(r"\[([^]]*)\]\(([^)]+)\)", r"\2", value).replace("`", "").strip()
    match = re.search(r"https?://[^\s<>\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+|(?:www\.|[a-z0-9-]+\.)[a-z0-9.-]+\.[a-z]{2,}(?:/[^\s<>\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]*)?", text, re.I)
    if not match:
        return None
    url = match.group().rstrip("，。；）)]")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def key_for(url: str | None, account: str | None, address: str, name: str) -> str:
    if account:
        return "wechat:" + account.lower()
    if not url:
        return "unresolved:" + address.strip() + ":" + name
    parsed = urlsplit(url)
    host = parsed.netloc.lower().removeprefix("www.")
    path = parsed.path.rstrip("/") or "/"
    query = urlencode(sorted(parse_qsl(parsed.query, keep_blank_values=True)))
    qualifier = re.search(r"(?:栏目|频道)\s*([0-9]+)", address)
    return urlunsplit(("", host, path, query, "")) + ("|channel=" + qualifier.group(1) if qualifier else "")


def build(paths: list[Path]) -> dict:
    records: dict[str, dict] = {}
    documents = []
    for path in paths:
        data = path.read_bytes()
        text = data.decode("utf-8-sig")
        section = ""
        table = False
        row_count = 0
        for line_number, line in enumerate(text.splitlines(), 1):
            if line.startswith("#"):
                section = line.lstrip("#").strip()
                table = False
            if line.startswith("| 信源 |"):
                table = True
                continue
            if not table or not line.startswith("|") or re.match(r"^\|\s*[-:]", line):
                continue
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) != 8:
                raise ValueError(f"{path.name}:{line_number}: expected 8 columns, got {len(cells)}")
            name, method, address, interval, collected, selected, recent, status = cells
            source_id = re.match(r"^(S\d+)\s+", name)
            original_id = source_id.group(1) if source_id else None
            clean_name = re.sub(r"^S\d+\s+", "", name)
            account_match = re.search(r"gh_[A-Za-z0-9]+", address)
            account = account_match.group() if account_match else None
            url = normalize_url(address) if not account else None
            key = key_for(url, account, address, clean_name)
            tier = "T1_5" if ("险企官方" in section or "T1.5" in section) else "T1" if ("监管与政府" in section or "协会与机构" in section or "T1" in section) else "T2"
            reference = {
                "document": path.name, "line": line_number, "originalId": original_id,
                "name": clean_name, "section": section, "method": method,
                "address": address, "interval": interval, "originalStatus": status,
                "historicalCounts": {"collected": collected, "selected": selected, "recent": recent},
                "rawRow": line,
            }
            if key not in records:
                records[key] = {"catalogId": f"insurance-source-{len(records) + 1:04d}", "name": clean_name,
                                "url": url, "accountId": account, "deduplicationKey": key,
                                "tier": tier, "methods": [], "aliases": [], "references": [],
                                "currentCollectionStatus": "not_tested"}
            record = records[key]
            for field, value in [("methods", method), ("aliases", clean_name)]:
                if value not in record[field]:
                    record[field].append(value)
            record["references"].append(reference)
            row_count += 1
        documents.append({"name": path.name, "sha256": hashlib.sha256(data).hexdigest(), "tableRows": row_count})
    values = list(records.values())
    return {
        "schemaVersion": 1,
        "purpose": "User source inventory with original evidence. Historical statuses are not current success claims. Collector configurations live in industry/sources.json.",
        "deduplication": "Account ID or normalized hostname/path/query plus explicit channel qualifier. Distinct columns/channels remain separate. Original rows are preserved.",
        "documents": documents,
        "summary": {"inputRows": sum(d["tableRows"] for d in documents), "uniqueEntries": len(values),
                    "wechatAccounts": sum(bool(r["accountId"]) for r in values),
                    "publicUrlEntries": sum(bool(r["url"]) for r in values),
                    "tiers": dict(Counter(r["tier"] for r in values))},
        "sources": values,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("documents", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("industry/source-catalog.json"))
    args = parser.parse_args()
    catalog = build(args.documents)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(catalog["summary"], ensure_ascii=False))
