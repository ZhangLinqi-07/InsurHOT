// 通用写作约束由保险提示词控制。词表保持空，避免额外模型调用误改法规原文。
export const READER_WORDING: ReadonlyArray<readonly [RegExp, string]> = [];
