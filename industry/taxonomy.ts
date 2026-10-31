// 保险行业的初始分类与词表。category key 和主题 slug 发布后保持稳定。
// 集团、保险法人及资产管理机构的主体身份须按原文分别核对。
export const CATEGORIES = [
  {
    "key": "regulation",
    "tagColor": "indigo",
    "label": "监管",
    "feedLabel": "保险监管",
    "section": "监管",
    "guide": "政府部门推动的公共制度及监管事项。政策制定；行政监管；医保管理；社会保障制度；执法许可；行业规范。"
  },
  {
    "key": "industry",
    "tagColor": "orange",
    "label": "企业",
    "feedLabel": "保险企业",
    "section": "企业",
    "guide": "保险主体自身的经营或组织事项。经营业绩；资本股权；并购重组；组织人事；企业合作；经营网络。"
  },
  {
    "key": "market",
    "tagColor": "turquoise",
    "label": "市场",
    "feedLabel": "保险市场",
    "section": "市场",
    "guide": "行业总体及细分市场的变化。行业规模；供需变化；渠道结构；市场竞争；保费走势；保障覆盖。"
  },
  {
    "key": "paper",
    "tagColor": "blue",
    "label": "研究",
    "feedLabel": "保险研究",
    "section": "研究",
    "guide": "形成研究结论或可复用知识的内容。学术论文；研究报告；实证分析；精算方法；风险模型；调查测评。"
  },
  {
    "key": "products",
    "tagColor": "turquoise",
    "label": "产品",
    "feedLabel": "保险产品",
    "section": "产品",
    "guide": "保险保障内容及交易安排的变化。产品发布；保障责任；保险条款；费率定价；投保条件；配套服务。"
  },
  {
    "key": "claims",
    "tagColor": "orange",
    "label": "理赔",
    "feedLabel": "保险理赔",
    "section": "理赔",
    "guide": "保险给付及保险消费者服务事项。赔付服务；拒赔争议；保险诉讼；投诉处理；保险欺诈案件。"
  },
  {
    "key": "reinsurance",
    "tagColor": "violet",
    "label": "再保险",
    "feedLabel": "再保险",
    "section": "再保险",
    "guide": "再保险交易及风险转移安排。再保续约；分保合约；再保容量；临分；转分保；保险证券化。"
  },
  {
    "key": "investment",
    "tagColor": "green",
    "label": "投资",
    "feedLabel": "保险投资",
    "section": "投资",
    "guide": "保险资金的配置及投资业务事项。资产配置；股票持仓；债券投资；另类投资；保险资管；资产负债管理。"
  },
  {
    "key": "insurtech",
    "tagColor": "green",
    "label": "科技",
    "feedLabel": "保险科技",
    "section": "科技",
    "guide": "技术在保险业务中的应用。人工智能；智能核保；理赔自动化；业务系统；数据治理；网络安全。"
  },
  {
    "key": "risk",
    "tagColor": "purple",
    "label": "风险",
    "feedLabel": "保险风险",
    "section": "风险",
    "guide": "保险相关的风险暴露及损失变化。巨灾损失；可保性；保障缺口；气候风险；新兴风险；风险减量。"
  },
  {
    "key": "other",
    "tagColor": "blue",
    "label": "其他",
    "feedLabel": "其他保险资讯",
    "section": "其他",
    "guide": "标题和摘要完全未命中关键词库的新闻。保留完整标题摘要，供后续补充词条后重新分类。"
  }
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

// 已发布的旧分类地址与历史报告仍可读取，新分类不再分配到该类。
export const LEGACY_CATEGORIES = [{ key: "opinion", label: "解读", feedLabel: "保险观点与实践" }] as const;
export const LEGACY_SECTION_LABELS: readonly string[] = ["监管与规则", "行业与经营", "产品与市场", "再保险与风险", "保险科技", "研究与数据", "解读与实践"];

// 保险资讯没有可统一计数且已确认的新发布类别。
export const RELEASE: { category: string; tag: string; unit: string } | null = null;
export const PLAIN_TERMS: readonly string[] = ["保险", "再保险", "精算", "偿付能力", "保费", "理赔", "ai", "api", "ils", "ifrs 17", "sfcr", "ipo", "ceo"];

// 保留接口已有七类技术标识，保险语义见 selection-score.md 和 content-understanding.md。
// model_release 仅指精算、巨灾、风险等模型的实质发布，监管规则归 industry_event。
export const ITEM_TYPES = ["model_release", "product_launch", "tool_or_prompt", "research_paper", "industry_event", "opinion_analysis", "tutorial_explainer"] as const;

export const CATEGORY_TAGS = [
  "政策/监管",
  "执法/许可",
  "统计/披露",
  "行业动态",
  "产品更新",
  "再保险/巨灾",
  "保险科技",
  "论文/研究",
  "教程/实践",
  "观点/解读",
  "模型发布",
  "其他"
] as const;
export const TOPIC_TAGS = [
  "中国内地",
  "港澳台",
  "亚太",
  "欧洲",
  "北美",
  "拉美与加勒比",
  "非洲与中东",
  "人身险",
  "财产险",
  "健康险",
  "养老保险",
  "农业保险",
  "巨灾保险",
  "再保险",
  "自保保险",
  "ILS/巨灾债券",
  "偿付能力",
  "财务报告",
  "资产管理",
  "消费者保护",
  "保险中介",
  "承保与定价",
  "理赔",
  "气候风险",
  "AI/智能体",
  "数据与隐私",
  "反欺诈",
  "精算",
  "社会保障"
] as const;
export const ENTITY_TAGS = [
  "金融监管总局",
  "中国人民银行",
  "中国保险行业协会",
  "中国精算师协会",
  "中国保险学会",
  "上海保险交易所",
  "中国保险保障基金",
  "IAIS",
  "日内瓦协会",
  "EIOPA",
  "NAIC",
  "APRA",
  "FCA",
  "PRA",
  "中国人寿",
  "中国平安",
  "中国人保",
  "中国太保",
  "新华保险",
  "中国再保",
  "泰康",
  "阳光保险",
  "中国太平",
  "中国信保",
  "Allianz",
  "AXA",
  "Zurich",
  "Swiss Re",
  "Munich Re",
  "Hannover Re",
  "SCOR",
  "Generali",
  "Aviva",
  "Lloyd's",
  "Chubb",
  "AIG",
  "MetLife",
  "Manulife",
  "QBE"
] as const;
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  "监管政策": "政策/监管",
  "政策法规": "政策/监管",
  "征求意见": "政策/监管",
  "监管处罚": "执法/许可",
  "行政许可": "执法/许可",
  "财报": "统计/披露",
  "业绩披露": "统计/披露",
  "公司动态": "行业动态",
  "融资": "行业动态",
  "并购": "行业动态",
  "产品发布": "产品更新",
  "再保": "再保险",
  "巨灾债券": "ILS/巨灾债券",
  "人工智能": "AI/智能体",
  "AI": "AI/智能体",
  "教程": "教程/实践",
  "评论": "观点/解读",
  "观点": "观点/解读",
  "研究报告": "论文/研究",
  "精算研究": "论文/研究"
};

export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; orgNames?: string[]; otherNames?: string[] }> = {
  "nfra": {
    "name": "国家金融监督管理总局",
    "displayTag": "金融监管总局",
    "aliases": [
      "国家金融监督管理总局",
      "金融监管总局",
      "NFRA",
      "National Financial Regulatory Administration"
    ]
  },
  "pbc": {
    "name": "中国人民银行",
    "displayTag": "中国人民银行",
    "aliases": [
      "中国人民银行",
      "People's Bank of China",
      "PBOC"
    ]
  },
  "iachina": {
    "name": "中国保险行业协会",
    "displayTag": "中国保险行业协会",
    "aliases": [
      "中国保险行业协会",
      "中保协",
      "Insurance Association of China"
    ]
  },
  "caa": {
    "name": "中国精算师协会",
    "displayTag": "中国精算师协会",
    "aliases": [
      "中国精算师协会",
      "China Association of Actuaries"
    ]
  },
  "isc": {
    "name": "中国保险学会",
    "displayTag": "中国保险学会",
    "aliases": [
      "中国保险学会",
      "Insurance Society of China"
    ]
  },
  "shie": {
    "name": "上海保险交易所",
    "displayTag": "上海保险交易所",
    "aliases": [
      "上海保险交易所",
      "Shanghai Insurance Exchange"
    ]
  },
  "cisf": {
    "name": "中国保险保障基金",
    "displayTag": "中国保险保障基金",
    "aliases": [
      "中国保险保障基金",
      "China Insurance Security Fund"
    ]
  },
  "iais": {
    "name": "国际保险监督官协会",
    "displayTag": "IAIS",
    "aliases": [
      "IAIS",
      "International Association of Insurance Supervisors",
      "国际保险监督官协会"
    ]
  },
  "geneva": {
    "name": "日内瓦协会",
    "displayTag": "日内瓦协会",
    "aliases": [
      "The Geneva Association",
      "Geneva Association",
      "日内瓦协会"
    ]
  },
  "eiopa": {
    "name": "欧洲保险和职业养老金管理局",
    "displayTag": "EIOPA",
    "aliases": [
      "EIOPA",
      "European Insurance and Occupational Pensions Authority"
    ]
  },
  "naic": {
    "name": "美国保险监督官协会",
    "displayTag": "NAIC",
    "aliases": [
      "NAIC",
      "National Association of Insurance Commissioners",
      "美国保险监督官协会"
    ]
  },
  "apra": {
    "name": "澳大利亚审慎监管局",
    "displayTag": "APRA",
    "aliases": [
      "APRA",
      "Australian Prudential Regulation Authority"
    ]
  },
  "fca": {
    "name": "英国金融行为监管局",
    "displayTag": "FCA",
    "aliases": [
      "FCA",
      "Financial Conduct Authority"
    ]
  },
  "pra": {
    "name": "英国审慎监管局",
    "displayTag": "PRA",
    "aliases": [
      "PRA",
      "Prudential Regulation Authority"
    ]
  },
  "chinalife": {
    "name": "中国人寿",
    "displayTag": "中国人寿",
    "aliases": [
      "中国人寿",
      "China Life"
    ]
  },
  "pingan": {
    "name": "中国平安",
    "displayTag": "中国平安",
    "aliases": [
      "中国平安",
      "Ping An"
    ]
  },
  "picc": {
    "name": "中国人保",
    "displayTag": "中国人保",
    "aliases": [
      "中国人保",
      "中国人民保险集团",
      "PICC Group"
    ]
  },
  "cpic": {
    "name": "中国太保",
    "displayTag": "中国太保",
    "aliases": [
      "中国太保",
      "中国太平洋保险",
      "China Pacific Insurance",
      "CPIC"
    ]
  },
  "newchinalife": {
    "name": "新华保险",
    "displayTag": "新华保险",
    "aliases": [
      "新华保险",
      "新华人寿",
      "New China Life"
    ]
  },
  "chinare": {
    "name": "中国再保",
    "displayTag": "中国再保",
    "aliases": [
      "中国再保",
      "中国再保险",
      "China Re"
    ]
  },
  "taikang": {
    "name": "泰康",
    "displayTag": "泰康",
    "aliases": [
      "泰康保险集团",
      "泰康人寿",
      "Taikang"
    ]
  },
  "sunshine": {
    "name": "阳光保险",
    "displayTag": "阳光保险",
    "aliases": [
      "阳光保险",
      "Sunshine Insurance"
    ]
  },
  "taiping": {
    "name": "中国太平",
    "displayTag": "中国太平",
    "aliases": [
      "中国太平",
      "China Taiping"
    ]
  },
  "sinosure": {
    "name": "中国信保",
    "displayTag": "中国信保",
    "aliases": [
      "中国出口信用保险公司",
      "中国信保",
      "Sinosure"
    ]
  },
  "allianz": {
    "name": "Allianz",
    "displayTag": "Allianz",
    "aliases": [
      "Allianz",
      "安联"
    ]
  },
  "axa": {
    "name": "AXA",
    "displayTag": "AXA",
    "aliases": [
      "AXA",
      "安盛"
    ]
  },
  "zurich": {
    "name": "Zurich Insurance Group",
    "displayTag": "Zurich",
    "aliases": [
      "Zurich Insurance",
      "苏黎世保险"
    ]
  },
  "swissre": {
    "name": "Swiss Re",
    "displayTag": "Swiss Re",
    "aliases": [
      "Swiss Re",
      "瑞士再保险",
      "瑞再"
    ]
  },
  "munichre": {
    "name": "Munich Re",
    "displayTag": "Munich Re",
    "aliases": [
      "Munich Re",
      "慕尼黑再保险",
      "慕再"
    ]
  },
  "hannoverre": {
    "name": "Hannover Re",
    "displayTag": "Hannover Re",
    "aliases": [
      "Hannover Re",
      "汉诺威再保险"
    ]
  },
  "scor": {
    "name": "SCOR",
    "displayTag": "SCOR",
    "aliases": [
      "SCOR",
      "法国再保险"
    ]
  },
  "generali": {
    "name": "Generali",
    "displayTag": "Generali",
    "aliases": [
      "Generali",
      "忠利保险"
    ]
  },
  "aviva": {
    "name": "Aviva",
    "displayTag": "Aviva",
    "aliases": [
      "Aviva",
      "英杰华"
    ]
  },
  "lloyds": {
    "name": "Lloyd's",
    "displayTag": "Lloyd's",
    "aliases": [
      "Lloyd's",
      "Lloyd’s",
      "劳合社"
    ]
  },
  "chubb": {
    "name": "Chubb",
    "displayTag": "Chubb",
    "aliases": [
      "Chubb",
      "安达保险"
    ]
  },
  "aig": {
    "name": "AIG",
    "displayTag": "AIG",
    "aliases": [
      "AIG",
      "American International Group",
      "美国国际集团"
    ]
  },
  "metlife": {
    "name": "MetLife",
    "displayTag": "MetLife",
    "aliases": [
      "MetLife",
      "大都会人寿"
    ]
  },
  "manulife": {
    "name": "Manulife",
    "displayTag": "Manulife",
    "aliases": [
      "Manulife",
      "宏利"
    ]
  },
  "qbe": {
    "name": "QBE",
    "displayTag": "QBE",
    "aliases": [
      "QBE",
      "昆士兰保险"
    ]
  }
};

// 只用明确机构名匹配，避免把城市、人名或无保险语境的普通名词当作保险主体。
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "nfra", name: "国家金融监督管理总局", patterns: [/国家金融监督管理总局|金融监管总局|\bNFRA\b|\bNational Financial Regulatory Administration\b/i] },
  { id: "pbc", name: "中国人民银行", patterns: [/中国人民银行|\bPeople's Bank of China\b|\bPBOC\b/i] },
  { id: "iachina", name: "中国保险行业协会", patterns: [/中国保险行业协会|中保协|\bInsurance Association of China\b/i] },
  { id: "caa", name: "中国精算师协会", patterns: [/中国精算师协会|\bChina Association of Actuaries\b/i] },
  { id: "isc", name: "中国保险学会", patterns: [/中国保险学会|\bInsurance Society of China\b/i] },
  { id: "shie", name: "上海保险交易所", patterns: [/上海保险交易所|\bShanghai Insurance Exchange\b/i] },
  { id: "cisf", name: "中国保险保障基金", patterns: [/中国保险保障基金|\bChina Insurance Security Fund\b/i] },
  { id: "iais", name: "国际保险监督官协会", patterns: [/\bIAIS\b|\bInternational Association of Insurance Supervisors\b|国际保险监督官协会/i] },
  { id: "geneva", name: "日内瓦协会", patterns: [/\bThe Geneva Association\b|\bGeneva Association\b|日内瓦协会/i] },
  { id: "eiopa", name: "欧洲保险和职业养老金管理局", patterns: [/\bEIOPA\b|\bEuropean Insurance and Occupational Pensions Authority\b/i] },
  { id: "naic", name: "美国保险监督官协会", patterns: [/\bNAIC\b|\bNational Association of Insurance Commissioners\b|美国保险监督官协会/i] },
  { id: "apra", name: "澳大利亚审慎监管局", patterns: [/\bAPRA\b|\bAustralian Prudential Regulation Authority\b/i] },
  { id: "fca", name: "英国金融行为监管局", patterns: [/\bFCA\b|\bFinancial Conduct Authority\b/i] },
  { id: "pra", name: "英国审慎监管局", patterns: [/\bPRA\b|\bPrudential Regulation Authority\b/i] },
  { id: "chinalife", name: "中国人寿", patterns: [/中国人寿|\bChina Life\b/i] },
  { id: "pingan", name: "中国平安", patterns: [/中国平安|\bPing An\b/i] },
  { id: "picc", name: "中国人保", patterns: [/中国人保|中国人民保险集团|\bPICC Group\b/i] },
  { id: "cpic", name: "中国太保", patterns: [/中国太保|中国太平洋保险|\bChina Pacific Insurance\b|\bCPIC\b/i] },
  { id: "newchinalife", name: "新华保险", patterns: [/新华保险|新华人寿|\bNew China Life\b/i] },
  { id: "chinare", name: "中国再保", patterns: [/中国再保|中国再保险|\bChina Re\b/i] },
  { id: "taikang", name: "泰康", patterns: [/泰康保险集团|泰康人寿|\bTaikang\b/i] },
  { id: "sunshine", name: "阳光保险", patterns: [/阳光保险|\bSunshine Insurance\b/i] },
  { id: "taiping", name: "中国太平", patterns: [/中国太平|\bChina Taiping\b/i] },
  { id: "sinosure", name: "中国信保", patterns: [/中国出口信用保险公司|中国信保|\bSinosure\b/i] },
  { id: "allianz", name: "Allianz", patterns: [/\bAllianz\b|安联/i] },
  { id: "axa", name: "AXA", patterns: [/\bAXA\b|安盛/i] },
  { id: "zurich", name: "Zurich Insurance Group", patterns: [/\bZurich Insurance\b|苏黎世保险/i] },
  { id: "swissre", name: "Swiss Re", patterns: [/\bSwiss Re\b|瑞士再保险|瑞再/i] },
  { id: "munichre", name: "Munich Re", patterns: [/\bMunich Re\b|慕尼黑再保险|慕再/i] },
  { id: "hannoverre", name: "Hannover Re", patterns: [/\bHannover Re\b|汉诺威再保险/i] },
  { id: "scor", name: "SCOR", patterns: [/\bSCOR\b|法国再保险/i] },
  { id: "generali", name: "Generali", patterns: [/\bGenerali\b|忠利保险/i] },
  { id: "aviva", name: "Aviva", patterns: [/\bAviva\b|英杰华/i] },
  { id: "lloyds", name: "Lloyd's", patterns: [/\bLloyd's\b|Lloyd’s|劳合社/i] },
  { id: "chubb", name: "Chubb", patterns: [/\bChubb\b|安达保险/i] },
  { id: "aig", name: "AIG", patterns: [/\bAIG\b|\bAmerican International Group\b|美国国际集团/i] },
  { id: "metlife", name: "MetLife", patterns: [/\bMetLife\b|大都会人寿/i] },
  { id: "manulife", name: "Manulife", patterns: [/\bManulife\b|宏利/i] },
  { id: "qbe", name: "QBE", patterns: [/\bQBE\b|昆士兰保险/i] },
];

// 机构专属域名仅用于识别发布方，不表示其文章只有该机构一个主体。
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  {
    "entityId": "nfra",
    "domains": [
      "nfra.gov.cn"
    ]
  },
  {
    "entityId": "pbc",
    "domains": [
      "pbc.gov.cn"
    ]
  },
  {
    "entityId": "iachina",
    "domains": [
      "iachina.cn"
    ]
  },
  {
    "entityId": "caa",
    "domains": [
      "e-caa.org.cn"
    ]
  },
  {
    "entityId": "isc",
    "domains": [
      "isc-org.cn"
    ]
  },
  {
    "entityId": "shie",
    "domains": [
      "shie.com.cn"
    ]
  },
  {
    "entityId": "cisf",
    "domains": [
      "cisf.cn"
    ]
  },
  {
    "entityId": "iais",
    "domains": [
      "iais.org"
    ]
  },
  {
    "entityId": "geneva",
    "domains": [
      "genevaassociation.org"
    ]
  },
  {
    "entityId": "eiopa",
    "domains": [
      "eiopa.europa.eu"
    ]
  },
  {
    "entityId": "naic",
    "domains": [
      "naic.org"
    ]
  },
  {
    "entityId": "apra",
    "domains": [
      "apra.gov.au"
    ]
  },
  {
    "entityId": "fca",
    "domains": [
      "fca.org.uk"
    ]
  },
  {
    "entityId": "chinalife",
    "domains": [
      "chinalife.com.cn"
    ]
  },
  {
    "entityId": "pingan",
    "domains": [
      "pingan.cn"
    ]
  },
  {
    "entityId": "picc",
    "domains": [
      "picc.com.cn"
    ]
  },
  {
    "entityId": "cpic",
    "domains": [
      "cpic.com.cn"
    ]
  },
  {
    "entityId": "newchinalife",
    "domains": [
      "newchinalife.com"
    ]
  },
  {
    "entityId": "chinare",
    "domains": [
      "chinare.com.cn"
    ]
  },
  {
    "entityId": "allianz",
    "domains": [
      "allianz.com"
    ]
  },
  {
    "entityId": "axa",
    "domains": [
      "axa.com"
    ]
  },
  {
    "entityId": "zurich",
    "domains": [
      "zurich.com"
    ]
  },
  {
    "entityId": "swissre",
    "domains": [
      "swissre.com"
    ]
  },
  {
    "entityId": "munichre",
    "domains": [
      "munichre.com"
    ]
  },
  {
    "entityId": "hannoverre",
    "domains": [
      "hannover-re.com"
    ]
  },
  {
    "entityId": "scor",
    "domains": [
      "scor.com"
    ]
  },
  {
    "entityId": "generali",
    "domains": [
      "generali.com"
    ]
  },
  {
    "entityId": "aviva",
    "domains": [
      "aviva.com"
    ]
  },
  {
    "entityId": "lloyds",
    "domains": [
      "lloyds.com"
    ]
  },
  {
    "entityId": "chubb",
    "domains": [
      "chubb.com"
    ]
  },
  {
    "entityId": "aig",
    "domains": [
      "aig.com"
    ]
  },
  {
    "entityId": "metlife",
    "domains": [
      "metlife.com"
    ]
  },
  {
    "entityId": "manulife",
    "domains": [
      "manulife.com"
    ]
  },
  {
    "entityId": "qbe",
    "domains": [
      "qbe.com"
    ]
  }
];

export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
