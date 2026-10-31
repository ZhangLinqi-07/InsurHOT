# 保险可核查评分 V0.1

本站后续已移除 LLM 相关性预筛，程序检查后直接规则分类、评分和精选，见 [当前工作流](insurance-workflow.md)。下文已有试筛结果与回执属于历史记录，暂停的半年积压仍保持暂停。

2026-10-30 使用者明确批准在 localhost:3000 启用。原草案中尚未上线的状态说明已由本次批准替代。七类权重、T1 60 / T1_5 65 / T2 76 保留，门槛尚未用人工保险样本校准。

锚点全文在 industry/prompts/selection-score-auditable.md。每轴只能使用 0/2/4/6/8/10。程序验证正文段落引文、计算加权总分并应用压分规则，3分上限向下取2，总分30上限单独保留。

2026-10-30 使用者授权自动决定精选资格。两次评分的证据均通过验证后，平均分达到现有信源门槛即成为精选候选。类型、阶段、原始轴分差至少4及跨越门槛的分歧保留在 reviewReasons 中，不再要求人工复核。缺少依据、引文无法核验或评分不完整时，自动判为本版本不入选，保留原始材料与评分记录。decisionPolicy 为 verified-mean-v1，decision 记录 selected、below-threshold 或 insufficient-evidence。新闻身份、归组、新增价值仍按原流程判断。

scripts/insurance/resolve-held.ts 将旧待复核记录冻结为清单，复用已保存的模型回答重新验证原文证据并生成 rule 来源的新分析。旧分析、原始模型分数和回执保留，相关性记录的复核标记与公开投影同步更新，并记录操作审计。文章版本或最新分析变化时跳过，人工更正继续优先。新入选候选使用原有归组流程。此操作不重新调用评分或写作模型，归组仍使用既有回执与模型预算。

analyses.output.rubric 保存两次原始回答、逐轴分数及理由、引文位置、程序复算值、压分前后记录、原文快照及哈希、模型与提示词版本。capturedAt 是本次读取快照时间，fetchedAt 对历史资料使用原材料修订入库时间并明确标注依据；没有历史时间时为 null，不虚构网络抓取时刻。原始回执记录请求和响应。后台内容诊断可展开查看；人工分数/精选/文字修正继续使用现有带操作者、时间、原因及前后值的 audit_log，不覆盖原评分。

中国积压处理使用 modules/insurance/backend/source-scope.ts 的明确来源映射，不能从中文内容推定来源属地。筛选文章相关性不会修改 source-catalog 的来源信任或采集验证状态。未接入、未授权的入口没有文章可供评分，保留原状态。

通过 scripts/insurance/local-node.mjs --models scripts/insurance/process-backlog.ts --run 执行固定中国积压清单。加 --translate 处理外文原文标题与摘录。省略 --run 只准备清单、输出数量和预算。清单和逐条结果保存在 .data/auditable-v01。预算不自动扩大；已知未发送的预算/停用/拥塞/服务不可用可续跑，结果未知的请求停止并保留待核对状态。所有付费调用经过原有回执、熔断和预算，不因打开页面触发。CAMEL 未配置账单单价时金额估算明确不可用，提供调用量区间而不编造金额。

preview_translations 按 article_id/revision 保存原文与中译文、输入哈希、提示词版本、模型、回执。全部动态的来源卡片使用已保存中译，详情保留原文标题和原文链接，未完成翻译时显示原文。无原文摘录时译文也为 null。原文 articles 和修订历史不被翻译覆盖。

## 更新与回退

新增迁移 0090_preview_translations.sql 只有一条建表语句，不改写原有数据。先用 pg_dump 保存本机数据库，再运行 db:migrate。修改前文件和原有工作 diff 位于 .data/auditable-v01/baseline。上线需重新构建网页并重启现有 API 与网页进程。

评分回退将 .env 中 SCORE_RUBRIC_VERSION 改为 legacy 并重启 API/模型处理进程。旧提示词、旧回执和旧分析保留，回退不删除新审查数据，不重跑已完成资料，也不自动恢复被暂缓的精选。恢复代码时使用 baseline 内相应原文件并保留使用者此前的未提交改动。翻译表可在代码回退时继续保留，避免丢失已付费结果；不在生产库执行破坏性回滚。只在独立测试库验证事务回滚。

验证时全套既有评分测试用 SCORE_RUBRIC_VERSION=legacy，继续覆盖旧格式和回退兼容；V0.1 使用单独 rubric-v01.test.ts 和 rubric.standalone.test.ts 验证新契约，所有模型请求只连本地假服务。
