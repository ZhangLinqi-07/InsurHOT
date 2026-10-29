"""Attach entry-only observations to the catalog and write an honest coverage report."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=Path("industry/source-catalog.json"))
    parser.add_argument("--results", type=Path, default=Path(".data/source-audit/entry-results.json"))
    parser.add_argument("--report", type=Path, default=Path("docs/insurance-source-audit.md"))
    args = parser.parse_args()
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    audit = json.loads(args.results.read_text(encoding="utf-8"))
    observations = {result["catalogId"]: result for result in audit["results"]}
    for source in catalog["sources"]:
        result = observations.get(source["catalogId"])
        if result:
            source["entryProbe"] = {key: result[key] for key in ["checkedAt", "scope", "outcome", "requestedUrl", "finalUrl", "httpStatus", "contentType", "pageTitle", "candidateCount", "itemCount", "samples", "candidateSamples", "discoveredFeeds", "error", "responseFile", "sha256"] if key in result}
    catalog["entryAudit"] = {key: audit[key] for key in ["checkedAt", "scope", "totalEntries", "outcomes"]}
    args.catalog.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    labels = {
        "http_error": "HTTP 错误响应", "network_or_parse_error": "连接、DNS、TLS、超时或格式错误",
        "html_candidates_unverified": "HTML 内观察到文章链接候选，尚未验证采集规则",
        "html_no_article_candidates": "HTML 可读取，通用启发式未识别文章候选",
        "json_response_unmapped": "JSON 可解析，尚未映射到项目文章结构",
        "non_html_response": "其他格式响应", "needs_paid_provider": "公众号等待授权获取服务",
        "access_challenge": "访问验证或安全检查页面", "rss_entries_parsed": "RSS 或 Atom 条目已解析",
        "rss_empty": "RSS 或 Atom 可解析但无条目", "missing_or_nonpublic_url": "入口缺失或非公网地址",
    }
    outcomes = Counter(result["outcome"] for result in audit["results"])
    summary = catalog["summary"]
    checked = datetime.fromisoformat(audit["checkedAt"]).astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    outcomes_text = "。".join(f"{labels.get(key, key)} {value} 条" for key, value in sorted(outcomes.items())) + "。"
    covered_urls = sum(bool(result.get("requestedUrl")) for result in audit["results"])
    success_responses = sum(200 <= result.get("httpStatus", 0) < 300 for result in audit["results"])
    docs = "，".join(f"{document['name']} 的 {document['tableRows']} 行" for document in catalog["documents"])
    report = f"""# 保险行业信源入口实测

## 来源和覆盖范围

本次依据用户提供的三份材料构建目录，分别为 {docs}。共保留 {summary['inputRows']} 行原始登记信息，归并为 {summary['uniqueEntries']} 个入口，其中公网 URL {summary['publicUrlEntries']} 个，微信公众号原始 ID {summary['wechatAccounts']} 个。归并依据为规范化的主机、路径、查询参数及显式栏目或频道号。同一机构的不同栏目和网页与 RSS 入口仍可分别保留，所以入口数量不代表独立机构数量。

全量可追溯目录见 [source-catalog.json](../industry/source-catalog.json)。每个入口保留材料文件名、行号、原始状态、原始表格行及历史收录数字，三份材料还记录 SHA-256。历史材料中的在用、已核实和历史收录数字均保留为原始证据。本次从未把这些数字写成本地站点当前运营统计。

第一份材料还引用《逐条获取方式与状态说明.md》，该文件未在本次输入中提供，在材料相邻目录也未找到。目录保留原来的状态链接，部分历史接口的完整请求参数仍需另行核对。

## 本次真实请求

结果汇总于北京时间 {checked}。共完成 {audit['totalEntries']} 个入口记录的检查，覆盖 {covered_urls} 个含公网 URL 的入口，其中 {success_responses} 个入口得到 HTTP 2xx 响应。部分历史频道共用尚未填写完整参数的接口地址，所以含 URL 的入口数量也不能理解为互不相同的网址数量。公众号记录只登记对授权获取服务的依赖，未以普通网页请求代替公众号采集，也未调用付费公众号服务。

{outcomes_text}

请求使用显式的审计 User-Agent，全局最多六个工作线程，同一主机串行，每次连接超时八秒、读取超时十二秒，最多跟随五次公开地址重定向，每个响应最多保存 1.5 MB。未尝试破解验证码、绕过访问限制、使用登录凭据或穿透付费墙。网络失败、403、404 和验证页面都按观测记录，不推断来源永久不可用。

## 如何解读结果

这份报告检验入口响应与可见列表线索。HTTP 200、首页可读和页面中发现若干链接，都不足以证明生产采集成功。HTML 候选由 URL 形状和链接文字启发式识别，其中可能包含导航、旧文或无关内容。HTML 未发现候选也无法证明网站没有文章。

RSS 条目解析只证明本次响应中能读取条目，其标题、链接、日期和正文仍须经过项目自身的 collector 预览、详情提取、时间规则、模型加工及公开读取验证。JSON 可解析同样需要配置正确的数组路径、字段路径和文章地址。本次特意把这些状态与完整采集流程分开存储，目录中的 entryProbe 保留入口检查，currentCollectionStatus 由独立的运行映射步骤更新。

资料中出现的机构主页、监管者名录、许可证查询、单篇样例、公司披露起点和论文或文件入口，全部保留在目录中。它们需要分别定位动态栏目或增量策略，不能直接当作持续新闻列表启用。征求意见、正式法规、协会声明与研究报告的法律效力也需要在行业提示词及摘要中区分。

## 原始证据与复现

逐条结果位于本地忽略目录 `.data/source-audit/entry-results.json` 和逐条写入的 `.data/source-audit/entry-results.jsonl`。收到的原始响应存为 `.data/source-audit/responses/<catalogId>.body`，结果记录其 SHA-256、响应码、最终地址和重定向链。文件名中的 catalogId 与目录中的 ID 对应，便于核对本次请求结果。原始响应仅供本地验证，未作为网站全文再分发授权。

这些审计脚本需要 Python 3.10 或更高版本，网络探测脚本额外使用 requests 包。重新整理输入可运行 `python scripts/insurance/source_inventory.py <材料路径> <材料路径> <材料路径>`。重新探测可运行 `python scripts/insurance/audit_entries.py`，需要复用 URL 未变化的已有结果时增加 `--resume`。最后运行 `python scripts/insurance/report_entry_audit.py` 把本次入口证据附到目录并重建此报告。重新整理目录会移除旧的 entryProbe，随后重新附加本次结果即可。
"""
    args.report.write_text(report, encoding="utf-8")
    print(json.dumps({"catalog": str(args.catalog), "report": str(args.report), "entries": len(observations), "outcomes": dict(outcomes)}, ensure_ascii=False))
