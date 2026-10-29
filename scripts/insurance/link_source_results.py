"""Link the complete source inventory to configured collectors and real trial evidence.

Matching rules are deliberately explicit. Sharing a host creates a candidate,
not a claim that a regulator directory, disclosure table or circular archive is
covered by a site's general-news feed. No requests or database writes are made.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import parse_qsl, urlsplit


# This is an explicit equivalence between a publisher homepage and its separately
# verified RSS entrance. The direct RSS entry remains a separate inventory row.
MANUAL_EQUIVALENTS = {
    ("insurance-source-0390", "rss-geneva"): "日内瓦协会主页与同一发布机构已验证的官方 RSS，对应目录中的直接 RSS 入口 insurance-source-0184。",
}

# A page-level alternate-feed declaration can be site-wide. Only roots and these
# documented editorial sections may map to that feed; specialized archives stay
# candidates until their own list/document extraction is implemented.
DECLARED_FEED_SECTIONS = {
    "insurance-source-0391",  # Australian insurance council news/resources
    "insurance-source-0392",  # New Zealand insurance council media releases
    "insurance-source-0399",  # South African insurance association news
    "insurance-source-0400",  # The same association's editorial blog
}

STATUS_LABELS = {
    "collected_in_trial": "已有真实入库试跑证据",
    "collector_list_verified": "原生采集器列表与日期已验证",
    "configured_enabled_validation_failed": "配置启用但最新预览未通过",
    "configured_enabled_unverified": "配置启用但缺少最终预览证据",
    "configured_paused": "已有适配配置并暂停",
    "waiting_authorized_wechat_service": "公众号等待授权获取服务",
    "candidate_adapter_only": "只有候选关联，尚未精确接入",
    "entry_access_limited": "本次入口存在访问限制",
    "entry_unavailable": "本次入口请求失败",
    "needs_specific_collection_endpoint": "需要定位具体增量采集入口",
    "not_configured": "目录已登记，尚未配置采集器",
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def url_parts(url: str | None):
    if not url:
        return None
    parsed = urlsplit(url)
    return {
        "host": parsed.netloc.lower().removeprefix("www."),
        "path": parsed.path.rstrip("/") or "/",
        "query": dict(parse_qsl(parsed.query, keep_blank_values=True)),
    }


def canonical(url: str | None):
    parts = url_parts(url)
    if parts is None:
        return None
    return (parts["host"], parts["path"], tuple(sorted(parts["query"].items())))


def collector_url(source):
    return source["config"].get("url") or source["config"].get("feedUrl")


def nfra_item(url):
    parsed = url_parts(url)
    if parsed and parsed["host"] == "nfra.gov.cn" and parsed["path"].lower() in {
        "/cbircweb/docinfo/selectdocbyitemidandchild", "/cn/view/pages/itemlist.html"
    }:
        return parsed["query"].get("itemId")
    return None


def match(entry, source):
    config = source["config"]
    if entry["catalogId"] in source.get("catalogIds", []):
        return {"basis": "reviewed_catalog_mapping", "reason": "根据材料原始机构与栏目逐项核对，并经真实采集验证后记录到配置。", "scope": source.get("catalogScope", "仅当前采集配置实际提供的条目，不代表覆盖整站、名录或附件。")}
    if source["kind"] == "mp_account":
        if entry.get("accountId") and entry["accountId"] == config.get("ghid"):
            return {"basis": "wechat_original_id", "reason": "公众号原始 ID 完全一致。", "scope": "此原始 ID 对应账号；授权获取服务尚未接入。"}
        return None
    target = collector_url(source)
    if entry.get("url") and canonical(entry["url"]) == canonical(target):
        return {"basis": "exact_normalized_url", "reason": "主机、路径、完整查询参数一致，仅归一化 http/https、www 和末尾斜线。", "scope": "当前配置所定义的列表或订阅；不包含自动展开全站栏目和附件。"}
    original_item = nfra_item(entry.get("url"))
    if original_item and original_item == nfra_item(target):
        return {"basis": "nfra_same_item_id", "reason": f"NFRA 列表页或前端 JSON 的 itemId={original_item} 一致，分页参数不改变栏目身份。", "scope": "该 itemId 栏目；不包含其他处罚、许可、地方分局或机构名录。"}
    original = url_parts(entry.get("url"))
    configured = url_parts(target)
    if original and configured and original["host"] == configured["host"] == "np-listapi.eastmoney.com" and original["path"] == configured["path"]:
        qualifier = re.search(r"\|channel=(\d+)$", entry["deduplicationKey"])
        if qualifier and qualifier.group(1) == configured["query"].get("column"):
            return {"basis": "eastmoney_same_column", "reason": f"同一接口路径且原始材料栏目 {qualifier.group(1)} 与请求 column 一致。", "scope": "该 column 栏目；其余财经频道未接入。"}
    key = (entry["catalogId"], source["id"])
    if key in MANUAL_EQUIVALENTS:
        return {"basis": "manual_same_publisher_equivalent", "reason": MANUAL_EQUIVALENTS[key], "scope": "仅该订阅实际提供的文章，不代表完整网站、研究档案或附件。"}
    if source["kind"] == "rss" and original:
        declared = entry.get("entryProbe", {}).get("discoveredFeeds", [])
        if canonical(target) in {canonical(feed) for feed in declared}:
            if original["path"] == "/" or entry["catalogId"] in DECLARED_FEED_SECTIONS:
                return {"basis": "observed_alternate_feed", "reason": "本次该入口 HTML 明确声明了当前配置的 RSS 或 Atom 地址。", "scope": "仅订阅实际发出的文章。声明可能为全站订阅，不保证该栏目所有页面、登记表或附件都进入订阅。"}
    return None


def candidate_reason(entry, source):
    if entry["catalogId"] in source.get("catalogCandidateIds", []):
        return "已核定为同机构的相关资料入口，原材料具体栏目的完整覆盖尚未确认。" + source.get("catalogScope", "")
    if source["kind"] == "mp_account" or not entry.get("url"):
        return None
    original = url_parts(entry["url"])
    configured = url_parts(collector_url(source))
    if not original or not configured:
        return None
    aliases = {original["host"]}
    final = url_parts(entry.get("entryProbe", {}).get("finalUrl"))
    if final:
        aliases.add(final["host"])
    if configured["host"] in aliases:
        return "同一主机或已观察到的重定向主机，但栏目、路径或内容范围未精确对应；不计入已接入。"
    if original["host"] == "cbrc.gov.cn" and source["id"].startswith("nfra-"):
        return "材料中的原银保监会旧域名入口，当前 NFRA 栏目只能作为候选，尚未核定该入口范围。"
    return None


def evidence_file(path):
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), {"path": path.as_posix(), "sha256": hashlib.sha256(raw).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=Path("industry/source-catalog.json"))
    parser.add_argument("--sources", type=Path, default=Path("industry/sources.json"))
    parser.add_argument("--preview", type=Path, action="append")
    parser.add_argument("--collection", type=Path, action="append")
    parser.add_argument("--trial", type=Path, default=Path(".data/trial/phase2-summary.json") if Path(".data/trial/phase2-summary.json").exists() else Path(".data/trial/latest.json"))
    parser.add_argument("--output", type=Path, default=Path("industry/source-runtime-map.json"))
    parser.add_argument("--report", type=Path, default=Path("docs/insurance-source-audit.md"))
    args = parser.parse_args()
    catalog = load(args.catalog)
    configured_data, source_input = evidence_file(args.sources)
    configured = configured_data["sources"]
    preview_paths = args.preview or [Path(".data/source-validation/final-enabled.json"), Path(".data/source-validation/phase2-international-collection1.json"), Path(".data/source-validation/phase2-final-new-collection.json")]
    collection_paths = args.collection or [Path(".data/source-validation/production-collection.json"), Path(".data/source-validation/production-collection-retry.json"), Path(".data/source-validation/phase2-international-collection1.json"), Path(".data/source-validation/phase2-final-new-collection.json")]
    previews = {}
    inputs = [source_input]
    for path in preview_paths:
        if not path.exists():
            continue
        data, preview_input = evidence_file(path)
        inputs.append(preview_input)
        for result in data.get("results", []):
            current = {"path": path.as_posix(), "checkedAt": data.get("checkedAt"),
                       "configBinding": "source_id_only", "status": result.get("status"),
                       "listed": result.get("listed"), "dated": result.get("dated"),
                       "bodyStatus": result.get("bodyStatus"),
                       "bodySample": result.get("bodySample"), "error": result.get("error"),
                       "collection": result.get("collection")}
            if result["id"] not in previews or str(current["checkedAt"]) >= str(previews[result["id"]]["checkedAt"]):
                previews[result["id"]] = current
    collections = {}
    collection_history = {}
    production_rounds = []
    model_trial = None
    def remember_collection(source_id, observation):
        collection_history.setdefault(source_id, []).append(observation)
        if source_id not in collections or str(observation.get("checkedAt")) >= str(collections[source_id].get("checkedAt")):
            collections[source_id] = observation
    if args.trial.exists():
        trial, trial_input = evidence_file(args.trial)
        inputs.append(trial_input)
        for result in trial.get("collections", []):
            remember_collection(result["sourceId"], {"path": args.trial.as_posix(), "checkedAt": trial.get("startedAt"), "phase": "initial_bounded_trial", **result})
        articles = trial.get("articles", [])
        counts = (trial.get("counts") or [{}])[0]
        model_trial = {"path": args.trial.as_posix(), "model": trial.get("model"), "finalizedAt": trial.get("finalizedAt"),
                       "requestedAnalyses": trial.get("requestedAnalyses"), "recordedArticles": len(articles),
                       "completedChains": sum(bool(article.get("chainComplete")) for article in articles),
                       "relevanceStates": dict(Counter(article.get("processing", {}).get("state", "unknown") for article in articles)),
                       "databaseCounts": counts, "hot": trial.get("hot"), "daily": trial.get("daily"),
                       "supersedes": trial.get("supersedes"), "analysisCallsRepeated": trial.get("analysisCallsRepeated")}
    for path in collection_paths:
        if not path.exists():
            continue
        data, collection_input = evidence_file(path)
        inputs.append(collection_input)
        round_statuses = Counter()
        round_failures = []
        for result in data.get("results", []):
            collected = result.get("collection") or {}
            collection_status = collected.get("status", result.get("collectionStatus", "not_run"))
            observation = {"path": path.as_posix(), "checkedAt": data.get("checkedAt"),
                           "phase": "isolated_collection_retest" if "retry" in path.stem else "production_collection",
                           "sourceId": result["id"], "status": collection_status,
                           "previewStatus": result.get("status"), "bodyStatus": result.get("bodyStatus"),
                           "found": collected.get("found"), "created": collected.get("created", 0),
                           "revised": collected.get("revised", 0), "error": collected.get("error") or result.get("error")}
            remember_collection(result["id"], observation)
            round_statuses[collection_status] += 1
            if collection_status != "ok":
                round_failures.append({"sourceId": result["id"], "status": collection_status,
                                       "previewStatus": result.get("status"), "error": observation["error"]})
        production_rounds.append({"path": path.as_posix(), "checkedAt": data.get("checkedAt"),
                                  "sourceCount": len(data.get("results", [])), "collectionStatuses": dict(round_statuses),
                                  "failures": round_failures})
    for source_id, history in collection_history.items():
        history.sort(key=lambda observation: str(observation.get("checkedAt")))
        collections[source_id] = {**collections[source_id], "attemptHistory": history}
    source_by_id = {source["id"]: source for source in configured}
    if len(source_by_id) != len(configured):
        raise ValueError("Duplicate collector IDs")
    before = json.dumps([entry.get("entryProbe") for entry in catalog["sources"]], ensure_ascii=False, sort_keys=True)
    rows = []
    reverse = {source["id"]: [] for source in configured}
    candidate_reverse = {source["id"]: [] for source in configured}
    for entry in catalog["sources"]:
        matches = []
        candidates = []
        for source in configured:
            exact = match(entry, source)
            if exact:
                linked = {"collectorId": source["id"], **exact}
                matches.append(linked)
                reverse[source["id"]].append({"catalogId": entry["catalogId"], **exact})
            else:
                reason = candidate_reason(entry, source)
                if reason:
                    candidates.append({"collectorId": source["id"], "reason": reason})
                    candidate_reverse[source["id"]].append({"catalogId": entry["catalogId"], "reason": reason})
        ids = [link["collectorId"] for link in matches]
        enabled = [source_id for source_id in ids if source_by_id[source_id].get("enabled", True)]
        preview_evidence = {source_id: previews[source_id] for source_id in ids if source_id in previews}
        collection_evidence = {source_id: collections[source_id] for source_id in ids if source_id in collections}
        if ids and all(source_by_id[source_id]["kind"] == "mp_account" for source_id in ids):
            status = "waiting_authorized_wechat_service"
        elif ids and not enabled:
            status = "configured_paused"
        elif any(collections.get(source_id, {}).get("status") == "ok" for source_id in enabled):
            status = "collected_in_trial"
        elif any(previews.get(source_id, {}).get("status") == "list_ok" for source_id in enabled):
            status = "collector_list_verified"
        elif any(source_id in previews for source_id in enabled):
            status = "configured_enabled_validation_failed"
        elif enabled:
            status = "configured_enabled_unverified"
        elif candidates:
            status = "candidate_adapter_only"
        elif entry.get("entryProbe", {}).get("outcome") == "access_challenge" or entry.get("entryProbe", {}).get("httpStatus") in (401, 403, 429):
            status = "entry_access_limited"
        elif entry.get("entryProbe", {}).get("outcome") in ("http_error", "network_or_parse_error"):
            status = "entry_unavailable"
        elif re.search(r"机构入口|名录|目录|名单|披露入口|查询|样例|样本", entry["name"]):
            status = "needs_specific_collection_endpoint"
        else:
            status = "not_configured"
        mapping = {"catalogId": entry["catalogId"], "name": entry["name"], "status": status,
                   "collectorIds": ids, "enabledCollectorIds": enabled, "matches": matches,
                   "candidateCollectors": candidates, "previewEvidence": preview_evidence,
                   "collectionEvidence": collection_evidence}
        entry["currentCollectionStatus"] = status
        entry["runtimeMapping"] = {key: value for key, value in mapping.items() if key not in ("catalogId", "name", "status")}
        rows.append(mapping)
    after = json.dumps([entry.get("entryProbe") for entry in catalog["sources"]], ensure_ascii=False, sort_keys=True)
    if before != after:
        raise AssertionError("Entry probes must remain unchanged")
    config_rows = []
    for source in configured:
        source_id = source["id"]
        config_rows.append({"collectorId": source_id, "name": source["name"], "kind": source["kind"],
                            "enabledInFile": source.get("enabled", True), "url": collector_url(source),
                            "catalogMatches": reverse[source_id],
                            "candidateCatalogEntries": candidate_reverse[source_id],
                            "previewEvidence": previews.get(source_id), "collectionEvidence": collections.get(source_id)})
    summary = {"catalogEntries": len(rows), "configuredCollectors": len(configured),
               "enabledCollectorsInFile": sum(source.get("enabled", True) for source in configured),
               "pausedCollectorsInFile": sum(not source.get("enabled", True) for source in configured),
               "catalogEntriesWithExactAdapters": sum(bool(row["collectorIds"]) for row in rows),
               "catalogEntriesWithEnabledAdapters": sum(bool(row["enabledCollectorIds"]) for row in rows),
               "unlinkedCollectorIds": [row["collectorId"] for row in config_rows if not row["catalogMatches"]],
               "observedCollectorPreviewCount": len(previews),
               "collectorPreviewCount": sum(source["id"] in previews for source in configured if source.get("enabled", True)),
               "collectorPreviewListOkCount": sum(previews.get(source["id"], {}).get("status") == "list_ok" for source in configured if source.get("enabled", True)),
               "collectorPreviewBodyOkCount": sum(previews.get(source["id"], {}).get("bodyStatus") == "ok" for source in configured if source.get("enabled", True)),
               "trialCollectedSourceCount": sum(result.get("status") == "ok" for result in collections.values()),
               "enabledCollectorsCollected": sum(collections.get(source["id"], {}).get("status") == "ok" for source in configured if source.get("enabled", True)),
               "trialCreatedRows": sum(attempt.get("created", 0) for history in collection_history.values() for attempt in history),
               "collectionAttemptCount": sum(len(history) for history in collection_history.values()),
               "catalogStatuses": dict(Counter(row["status"] for row in rows))}
    generated = datetime.now(timezone.utc).isoformat()
    result = {"schemaVersion": 1, "generatedAt": generated,
              "scope": "The user-inventory entries and configured runtime collectors are distinct populations. Mapping does not claim every document or attachment on a website is covered.",
              "rules": {"exact": "Normalized full URL; WeChat original ID; matching NFRA itemId; matching Eastmoney column; alternate-feed declaration on a homepage or explicitly reviewed editorial section; explicit manual equivalents in the script.",
                        "candidate": "Sharing a host, redirects or historical agency identity alone never counts as an exact adapter match.",
                        "evidence": "Preview establishes list/date/body observations. Trial collection establishes DB entrance only. Model completion and public publication are separate and are not inferred.",
                        "database": "enabledInFile is the source manifest snapshot, not a live DB enablement assertion. Trial statuses are actual recorded collectSource results. Seeding does not overwrite existing DB configurations.",
                        "binding": "Phase-one reports identify source IDs only. Phase-two reports also record sourceConfigSha256. Rerun validation after changing a collector's fields."},
              "inputs": inputs, "summary": summary, "productionRounds": production_rounds,
              "modelTrialEvidence": model_trial, "collectors": config_rows, "catalogEntries": rows}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    catalog["runtimeLinkage"] = {"generatedAt": generated, "mappingFile": args.output.as_posix(), "summary": summary}
    args.catalog.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.report.exists():
        report = args.report.read_text(encoding="utf-8")
        marker = "\n<!-- runtime-linkage:start -->"
        report = report.split(marker)[0]
        report = report.replace("目录中的 currentCollectionStatus 保留为 not_tested，entryProbe 表示已经执行的入口检查。", "目录中的 entryProbe 保留本次入口检查，currentCollectionStatus 由文末的运行映射步骤单独更新。")
        checked = datetime.fromisoformat(generated).astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
        statuses = "。".join(f"{STATUS_LABELS.get(key, key)} {value} 个" for key, value in sorted(summary["catalogStatuses"].items())) + "。"
        waiting = summary["catalogEntries"] - summary["catalogEntriesWithExactAdapters"]
        unlinked_text = "、".join(summary["unlinkedCollectorIds"]) or "无"
        first_round = production_rounds[0] if production_rounds else {}
        first_count = first_round.get("sourceCount", 0)
        first_ok = first_round.get("collectionStatuses", {}).get("ok", 0)
        body_limits = "、".join(source["id"] for source in configured if source.get("enabled", True) and previews.get(source["id"], {}).get("bodyStatus") != "ok") or "无"
        model_counts = model_trial.get("databaseCounts", {}) if model_trial else {}
        relevance_states = model_trial.get("relevanceStates", {}) if model_trial else {}
        hot_entries = (model_trial.get("hot") or {}).get("entries") if model_trial else None
        daily = (model_trial.get("daily") or {}) if model_trial else {}
        daily_text = "日报因其窗口内没有完成评判的有效内容而未生成" if daily.get("status") == "not_generated" and "nothing judged in its window" in str(daily.get("reason")) else "日报状态与原因按 modelTrialEvidence.daily 原样保留"
        report += f"""
<!-- runtime-linkage:start -->
## 目录与当前采集配置对账

北京时间 {checked}，材料目录保留 {summary['catalogEntries']} 个入口，`industry/sources.json` 配置 {summary['configuredCollectors']} 个采集源，其中配置文件启用 {summary['enabledCollectorsInFile']} 个、暂停 {summary['pausedCollectorsInFile']} 个。这两个数量属于不同范围。每个目录入口的适配关系、候选关系及证据路径见 [source-runtime-map.json](../industry/source-runtime-map.json)，目录中的 runtimeMapping 保留相同的逐条关联。没有删除尚未接入的入口，也没有用空的外部推送配置充当已接入。

精确关联到配置的目录入口 {summary['catalogEntriesWithExactAdapters']} 个，其中关联到启用配置 {summary['catalogEntriesWithEnabledAdapters']} 个，另外 {waiting} 个入口仍未精确接入。一个采集器可以对应原材料中的列表页和同栏目 JSON 两个入口，因此这些计数也不应与采集器数量相加。

尚未与目录入口精确对应的采集配置为 {unlinked_text}，它们在映射中保留候选目录关系，不计入该目录入口已经适配。尤其是乌干达 IRA 的全站新闻订阅与材料中的年度通函页，二者内容范围仍须单独验证。

{statuses}

最终原生采集器预览覆盖 {summary['collectorPreviewCount']} 个启用源，{summary['collectorPreviewListOkCount']} 个列表和日期验证通过，{summary['collectorPreviewBodyOkCount']} 个首条正文样本可确认。尚未确认正文的样本采集器为 {body_limits}，限制保留在 bodySample 内。列表验证、正文提取、入库、模型加工和公开发布分别判断。

真实采集首轮覆盖 {first_count} 个源，其中 {first_ok} 个返回入库成功。首轮逐条结果及错误完整保存在 `.data/source-validation/production-collection.json`，其后隔离补测保存在 `.data/source-validation/production-collection-retry.json`。本次唯一首轮失败为新西兰 ICNZ，在预览请求阶段超时、尚未执行该次入库，隔离补测已记录成功。累计已有 {summary['enabledCollectorsCollected']} / {summary['enabledCollectorsInFile']} 个启用源得到实际 collectSource 成功结果。映射中的 collectionEvidence.attemptHistory 保留初次受控试跑、首轮失败和隔离补测，未覆盖或隐藏失败记录。这些记录合计新建 {summary['trialCreatedRows']} 条文章。

这里的 collected_in_trial 只表示实际 collectSource 结果。模型及公开读取的独立最终证据见 `{model_trial.get('path') if model_trial else '未提供'}`。汇总保留各批原始报告与独立编辑修订记录，analysisCallsRepeated 为 {model_trial.get('analysisCallsRepeated') if model_trial else '未知'}。本次模型试跑完成 {model_trial.get('completedChains') if model_trial else '未知'} 条链路，其中相关性预筛 {relevance_states.get('pass', 0)} 条通过、{relevance_states.get('block', 0)} 条拦截，{model_counts.get('readable_items', '未知')} 条可公开阅读、{model_counts.get('selected', '未知')} 条精选、{model_counts.get('events', '未知')} 个事件。热点榜条目为 {hot_entries}，{daily_text}。初次历史回灌与原始发布时间保持原值。

按公众号原始 ID、NFRA 的 itemId、东方财富 column、完整 URL、经检查的订阅声明以及已核验的 catalogIds 建立关联，并保留各自覆盖范围。仅共享域名或重定向地址时只列候选。年度通函页、许可证、公司名录或披露表不会因为页面声明了全站 RSS 就视为这些专门栏目已被覆盖。启用状态取配置文件快照，实际数据库不会被 seed 脚本自动覆盖，因此此映射不冒充实时数据库配置审计。

运行 `python scripts/insurance/link_source_results.py` 可从第一轮与第二轮采集报告及模型汇总报告重建最终对账，默认输入路径见脚本参数。映射文件保存输入证据路径和 SHA-256。追加信源、完成更多试跑或修订配置后应重新验证并运行该脚本。第一轮预览记录仅绑定 source ID，第二轮增加配置 SHA-256。改过采集字段后必须重跑对应预览。该步骤不发出网络请求，也不修改数据库，并逐字比较 entryProbe 的 JSON 值，确保入口审计证据不被覆盖。
<!-- runtime-linkage:end -->
"""
        args.report.write_text(report, encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
