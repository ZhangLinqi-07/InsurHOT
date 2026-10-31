import type { FastifyInstance } from "fastify";
import { loadRadar } from "@aihot/backend/publication/radar";

export function registerInsuranceRadar(app: FastifyInstance) {
  app.get("/api/site/insurance/radar", { schema: { querystring: {
    type: "object", additionalProperties: false,
    properties: { days: { type: "string", enum: ["30", "90", "all"] } },
  } } }, async (request, reply) => {
    const { days = "90" } = request.query as { days?: "30" | "90" | "all" };
    reply.header("Cache-Control", "no-store");
    return loadRadar(days === "all" ? null : days === "30" ? 30 : 90);
  });
}
