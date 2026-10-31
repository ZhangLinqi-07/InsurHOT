// The news lists partition the audited source inventory by publisher location.
export const DOMESTIC_SOURCE_IDS = [
  "bbt-insurance", "caa-10", "caa-4", "cbimc-commentary", "cbimc-insurance", "cbimc-insurance-news", "cbimc-insurance-opinion",
  "chinalife-news", "chinare-news", "cisf-news", "cpic-news", "eastmoney-insurance", "eeo-insurance", "gov-policy",
  "iachina-news", "iachina-notices", "isc-news", "jrj-insurance", "pbc-news", "picc-news", "pingan-news", "shie-notices",
  "nfra-915", "nfra-916", "nfra-917", "nfra-919", "nfra-925", "nfra-928", "nfra-951", "nfra-954",
  "sina-56757", "sina-56850", "sina-56852", "sina-56854",
  "supplement-0196", "supplement-0210", "supplement-0246", "supplement-0272",
] as const;
export const DOMESTIC_ACCOUNT_PREFIX = "mp-gh_";

// Report editions retain their separate, evidence-based event-market assignments.
export const MARKET_MATCH = {
  "domestic": {
    "tags": [
      "market:domestic",
      "中国内地",
      "港澳台"
    ],
    "jurisdiction": "(?:中国|中华人民共和国|香港|澳门|台湾|\\m(?:china|prc|hong[ -]kong|maca[ou]|taiwan)\\M)"
  },
  "foreign": {
    "tags": [
      "market:foreign",
      "欧洲",
      "北美",
      "拉美与加勒比",
      "非洲与中东"
    ],
    "jurisdiction": "(?:美国|英国|欧洲|欧盟|德国|法国|瑞士|意大利|西班牙|荷兰|比利时|卢森堡|爱尔兰|奥地利|波兰|捷克|匈牙利|罗马尼亚|希腊|葡萄牙|丹麦|瑞典|挪威|芬兰|冰岛|俄罗斯|乌克兰|日本|韩国|朝鲜|新加坡|马来西亚|泰国|印度尼西亚|印尼|菲律宾|越南|柬埔寨|老挝|缅甸|印度|巴基斯坦|孟加拉|尼泊尔|斯里兰卡|澳大利亚|澳洲|新西兰|加拿大|墨西哥|巴西|智利|阿根廷|哥伦比亚|秘鲁|拉美|加勒比|非洲|中东|土耳其|以色列|沙特|阿联酋|卡塔尔|埃及|南非|肯尼亚|尼日利亚|加纳|境外|海外|国外|中国以外|中国之外|不含中国|不包括中国|除中国|非中国|\\m(?:united states|u\\.s|usa|us|united kingdom|u\\.k|uk|britain|england|scotland|wales|europe|european union|eu|germany|france|switzerland|italy|spain|netherlands|belgium|luxembourg|ireland|austria|poland|czechia|hungary|romania|greece|portugal|denmark|sweden|norway|finland|iceland|russia|ukraine|japan|korea|singapore|malaysia|thailand|indonesia|philippines|vietnam|cambodia|laos|myanmar|india|pakistan|bangladesh|nepal|sri lanka|australia|new zealand|canada|mexico|brazil|chile|argentina|colombia|peru|latin america|caribbean|africa|middle east|turkey|israel|saudi arabia|uae|qatar|egypt|kenya|nigeria|ghana|overseas|foreign|outside china|excluding china|except china)\\M)"
  }
} as const;

// Negated China does not prove domestic coverage; global/Asia-Pacific alone remain unknown.
export const DOMESTIC_MARKET_EXCLUSIONS = "(?:中国(?:以外|之外)|(?:不含|不包括|除|非)(?:中国(?:内地|大陆|香港|澳门|台湾)?|香港|澳门|台湾)|\\m(?:outside|excluding|except|not including)\\s+(?:china|hong[ -]kong|maca[ou]|taiwan)\\M)";
