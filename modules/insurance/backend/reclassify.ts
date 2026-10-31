import { sql } from "@aihot/backend/db";
import { refreshPublicationClassification } from "@aihot/backend/publication/publish";
import { correctReportClassification } from "@aihot/backend/reports/correct";

/** Classification and frozen report moves commit together; no provider requests or new selection. */
export async function reclassifyInsuranceArticle(id: string) {
  return sql.begin(async tx => {
    const result = await refreshPublicationClassification(tx, id);
    if (result.categoryChanged) await correctReportClassification(tx, id, "保险关键词分类 v2");
    return result;
  });
}
