# 非公众号信源补接

## 本次交付范围

使用者要求暂不接公众号并继续补全其他来源。本轮新增 31 条采集渠道，启用后均取得项目 `collectSource` 成功结果和实际材料入库。它们明确对应原目录的 32 个入口的具体栏目，另为 1 个入口提供同机构新闻补充。原始 470 个入口、541 行引用及旧入口审计继续保留，未以机构主页、同机构新闻或空配置替代专门栏目。

北京时间 2026-10-30 20:01:29 的独立快照中，数据库共有 143 条配置、112 条启用。新增渠道保存 1129 条材料，其中 769 条有正文。这个数量包含尚未完成保险相关性判断的综合金融和财经材料，不代表保险新闻确认数量、精选数量或完整覆盖率。运行快照保存在 `.data/source-completion-20261030/final-state.json`。

## 配置与运行

新增配置写入 `industry/sources.json`，采集范围、历史策略及目录关联写入 `industry/insurance-ingestion.json`。数据库变更使用原有管理员创建与版本校验接口，并保留审计。新渠道每 360 分钟轮询，由原有免费采集进程读取。公众号的 23 条配置仍为暂停，其配置没有变化。当前运行一个免费采集进程，模型与推送开关关闭。

Daily News Egypt 和 IRCSL 的公开 WordPress 类型接口验证了两个不同分页及倒序日期，并通过原有 `archivePage` 启动回补，固定起点继续使用北京时间 2024 年 10 月 29 日零点。其余新渠道保留当前列表、尚未核验历史分页的限制。IRCSL 的 news 类型不能覆盖原目录的 circular 检索，后者保留同机构新闻补充关系。

牙买加 FSC 与津巴布韦 IPEC 的候选同已有公开 posts 接口重复。本轮空重复配置已审计撤销，既有采集器及材料保留。没有把这两个来源计作新增接入。

## 正文与时间边界

中国经济网、中东保险评论、Hamilton、DFSA 和财新仅接公开元数据。它们显式使用 `fetchPublicContent: false`，详情页可补标题、摘要和发布日期，但不顺带提取网页正文，也不进入后续网页正文提取。原有未设置该字段的行为保持不变，RSS 或 JSON 自带文本仍沿用原有处理。

本轮详情页曾将 28 条付费预览或订阅说明标成正文。已通过统一材料修订入口撤销这些正文标记、生成新版本，并保留审计，不把旧版本当作当前可信正文。对应证据为 `.data/source-completion-20261030/metadata-repair.json`。所有新渠道的站内全文及全文再分发开关均关闭。

日本金融厅官方订阅使用 JST。日期读取将这个明确时区规范为 UTC+09:00，不依赖执行机器时区，也不改变 CST 的既有来源偏移处理。四个真实订阅的 45 条日期比较中，25 条原本无法读取的 JST 日期恢复，其他 20 条没有变化。证据为 `.data/source-completion-20261030/date-corpus.json`。

## 新增渠道快照

下表的正文栏只反映当前保存状态。已核验正文样本不表示该渠道每一篇文章都有正文。

| 渠道 | 来源 | 接入边界 | 材料 | 正文 |
|---|---|---|---|---|
| supplement-0002 | 阿根廷｜Superintendencia de Seguros de la Nacion Argentina：官方机构入口 | 已核验正文样本 | 16 | 15 |
| supplement-0005 | 巴林｜Central Bank of Bahrain：官方机构入口 | 已核验正文样本 | 10 | 10 |
| supplement-0020 | 捷克｜Czech National Bank, Insurance Companies Regulation and Supervision Department：官方机构入口 | 已核验正文样本 | 10 | 10 |
| supplement-0024 | 爱沙尼亚｜Estonian Financial Supervision Authority：官方机构入口 | 已核验正文样本 | 119 | 102 |
| supplement-0027 | 匈牙利｜Magyar Nemzeti Bank：官方机构入口 | 已核验正文样本 | 8 | 8 |
| supplement-0030 | 印度尼西亚｜Indonesia Financial Services Authority (Otoritas Jasa Keuangan/OJK)：官方机构入口 | 已核验正文样本 | 10 | 10 |
| supplement-0032 | 日本｜Financial Services Agency (FSA)：官方机构入口 | 已核验正文样本 | 3 | 3 |
| supplement-0065 | 斯里兰卡｜Insurance Regulatory Commission of Sri Lanka：官方机构入口 | 已核验正文样本 | 15 | 12 |
| supplement-0071 | 乌克兰｜National Bank of Ukraine：官方机构入口 | 已核验正文样本 | 20 | 17 |
| supplement-0074 | 阿拉伯联合酋长国｜Dubai Financial Services Authority (DFSA)：官方机构入口 | 仅元数据 | 5 | 0 |
| supplement-0082 | 日本｜日本金融厅：保险监管公告及监测报告：日本金融厅：保险监管公告及监测报告 | 已核验正文样本 | 3 | 3 |
| supplement-0088 | 亚美尼亚｜Central Bank of Armenia（亚美尼亚央行）：亚美尼亚央行：保险监管线索 | 已核验正文样本 | 15 | 15 |
| supplement-0191 | 跨国共享｜Financial Stability Board (FSB)：金融稳定与保险恢复处置相关发布门户 | 已核验正文样本 | 10 | 10 |
| supplement-0196 | 中国内地｜中国人民财产保险股份有限公司：公司官网 | 已核验正文样本 | 5 | 5 |
| supplement-0210 | 中国内地｜友邦人寿保险有限公司：公司官网 | 已核验正文样本 | 30 | 26 |
| supplement-0246 | 中国内地｜财新传媒：金融频道保险监管主题 | 仅元数据 | 25 | 0 |
| supplement-0272 | 中国内地｜中国经济网：中国经济网（保险滚动） | 仅元数据 | 200 | 0 |
| supplement-0294 | 沙特阿拉伯／巴林／阿曼｜Middle East Insurance Review：沙特监管报道：Middle East Insurance Review：沙特监管报道 | 仅元数据 | 5 | 0 |
| supplement-0302 | 埃及｜Daily News Egypt：Daily News Egypt：FRA保险监管报道 | 已核验正文样本 | 340 | 340 |
| supplement-0312 | 美国纽约州 DFS | 已核验正文样本 | 10 | 10 |
| supplement-0337 | 阿鲁巴中央银行 | 已核验正文样本 | 10 | 10 |
| supplement-0354 | 塞舌尔 FSA | 已核验正文样本 | 8 | 2 |
| supplement-0362 | 法国 AMF（RSS 订阅目录） | 已核验正文样本 | 91 | 10 |
| supplement-0367 | 荷兰 AFM | 已核验正文样本 | 50 | 43 |
| supplement-0393 | Insurance Bureau of Canada（IBC） | 已核验正文样本 | 4 | 4 |
| supplement-0420 | Hamilton Insurance Group（百慕大） | 仅元数据 | 3 | 0 |
| supplement-0427 | SCOR（法国/全球） | 已核验正文样本 | 12 | 12 |
| supplement-0428 | Generali（意大利/全球） | 已核验正文样本 | 65 | 65 |
| supplement-0431 | Legal & General（英国） | 已核验正文样本 | 10 | 10 |
| supplement-0436 | American Banker（保险与金融机构报道） | 已核验正文样本 | 10 | 10 |
| supplement-0444 | The Royal Gazette（百慕大） | 已核验正文样本 | 7 | 7 |

## 尚未完成的范围

原表尚未跑通的 380 个入口中，23 个公众号按要求排除。本轮接通 357 个非公众号入口中的 32 个具体栏目，其余 325 个仍未完成原定范围。它们包括访问限制、失效地址、动态列表、日期规则、PDF 与文件、牌照及机构名录、查询参数和授权服务等情况。以前的 HTTP 失败只代表当时观测，不代表来源永久不可接入。

可搜索的逐项结果位于本任务输出目录的 `非公众号信源接入结果_20261030.html`。原定通函、许可名录和偿付能力披露仍保留自身的覆盖状态，不以同机构新闻标为完整接入。

## 验证

58 项信源专项测试通过。类型检查、前端构建和站点 smoke 通过。当时匿名资料库 API 能读取新增渠道及其材料，后续资料库已合并到全部保险动态，独立 API 已移除。新增 31 个渠道在专项核验时均有成功采集时间、入库材料及后续调度，没有最近错误，文件与数据库配置无漂移，五个元数据渠道没有确认正文。

全量后端测试未通过，结果为 955 项通过、38 项失败、6 项取消。失败包括评分样本与当前 event、axes 结构不一致，以及 Windows 子进程和退出测试。备份退出测试未自行结束，已停止对应测试进程及其模拟备份子进程。前端测试中的本机 Chromium 无法启动，返回 spawn UNKNOWN，串行重试也失败。没有把全量测试或浏览器检查记为通过。日志保存在 `.data/source-completion-20261030/`。
