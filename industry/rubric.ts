// V0.1 is provisional until calibrated on the user's labelled insurance examples.
export const RUBRIC_VERSION = "insurance-auditable-v0.1";
export const RUBRIC_AXES = ["sig", "nov", "cred", "reson", "act"] as const;
export const RUBRIC_ANCHORS = {
  sig: ["无可识别的保险制度、业务、风险或研究意义", "礼节性活动、宣传包装等，未显示实质变化", "明确但局部的业务、方法或经营变化，影响范围有限", "对特定市场、业务群体或研究问题有明确且有分量的影响", "对较大相关群体的保障、资本、定价、监管或重要研究认知构成重大变化", "材料支持系统性、结构性的重大变化，足以显著改变行业制度、风险承担或核心认知"],
  nov: ["没有可辨认的新事实、结果或方法", "重述已披露内容，主要是措辞或包装变化", "有明确的新细节、小幅更新或局部补充", "有能改变读者理解或判断的新事实、新结果或新方法", "有重要的新发现、机制、能力或实质转折，并交代比较基准", "有重大且清晰可辨的新知识或新变化，明显重构相关问题的既有理解"],
  cred: ["没有可用依据，或核心主张被材料直接否定", "仅有模糊说法、传闻或无法核对的断言", "有具体主张，但关键口径、出处或方法不足", "主体、动作、时间及依据清楚，足以支持界定后的核心事实，但仍有重要限制", "有可追溯原始文本、数据或明确方法，对核心主张提供充分支持，范围和限制清楚", "对界定后的核心主张，证据完整、直接、可复核，关键口径与条件充分明确，无重大未解释矛盾"],
  reson: ["无法说明与目标读者的关系", "仅对极少数直接参与者有意义，未见更广的参考价值", "与一个明确的专业细分群体相关", "与特定市场或业务领域中相当一部分目标读者相关", "与多个目标读者群体的研究、经营、保障或风险判断密切相关", "与适用范围内绝大多数目标读者的核心判断直接相关"],
  act: ["无可辨认的使用、学习或调整路径", "仅提供一般启发，无法形成具体下一步", "有具体方向或方法线索，但缺少关键材料或条件", "有明确的学习、业务调整或研究使用路径，具备主要材料", "有可访问的文本、数据、工具或步骤，适用读者可在已说明条件下使用", "交付物与步骤充分完整，适用条件、限制及核验办法明确，可直接执行并检查结果"],
} as const;
export const RUBRIC_WEIGHTS = {
  model_release: [3, 2, 2, 2, 1], product_launch: [2, 2, 1, 2, 3], tool_or_prompt: [1, 2, 1, 2, 4],
  research_paper: [5, 3, 1, 0, 1], industry_event: [3, 1, 2, 4, 0], opinion_analysis: [1, 3, 1, 4, 1], tutorial_explainer: [1, 1, 1, 3, 4],
} as const;
export const RUBRIC_CAPS = {
  slogan: { sig: 4 }, routine: { sig: 3 }, promotion: { sig: 2 }, unsupported_promotion: { nov: 3, cred: 4 },
  testimonial: { nov: 3, sig: 4 }, roundup: { sig: 3 }, ceremonial: { sig: 3 }, overgeneralized: { sig: 4, reson: 3 },
  conflicting_or_incomplete: { total: 30 },
} as const;

/** Explicit rollback keeps old receipts and analyses intact. */
export function activeRubric(version = process.env.SCORE_RUBRIC_VERSION ?? RUBRIC_VERSION): boolean {
  if (![RUBRIC_VERSION, "legacy"].includes(version)) throw new Error(`Unknown SCORE_RUBRIC_VERSION: ${version}`);
  return version === RUBRIC_VERSION;
}
