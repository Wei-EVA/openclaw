import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("child safety config schema", () => {
  it("accepts childSafety config", () => {
    const parsed = OpenClawSchema.safeParse({
      childSafety: {
        enabled: true,
        mode: "shadow",
        ageBand: "9-12",
        riskThresholds: {
          blockAbove: 0.9,
          rewriteAbove: 0.75,
          escalateAbove: 0.95,
        },
        allowedDomains: ["khanacademy.org"],
        blockedCategories: ["adult_content", "violence"],
      },
    });
    expect(parsed.success).toBe(true);
  });
});
