import { describe, expect, it } from "vitest";
import { resolveChildSafetyConfig } from "../config.js";
import { collectUrlsFromText, scanUrlRules } from "./url-rules.js";

describe("url-rules", () => {
  const config = resolveChildSafetyConfig({
    childSafety: {
      enabled: true,
      mode: "shadow",
      allowedDomains: ["khanacademy.org", "bbc.co.uk"],
    },
  });

  it("extracts urls from text", () => {
    const urls = collectUrlsFromText("Read https://khanacademy.org/math and https://example.com");
    expect(urls).toHaveLength(2);
  });

  it("flags domains outside allowlist", () => {
    const findings = scanUrlRules({
      text: "Try https://example.com/article",
      config,
    });
    expect(findings.some((finding) => finding.category === "external_domain")).toBe(true);
  });

  it("allows whitelisted domains", () => {
    const findings = scanUrlRules({
      text: "Study at https://www.khanacademy.org/math",
      config,
    });
    expect(findings).toHaveLength(0);
  });

  it("flags deceptive hostnames that only contain allowlisted text", () => {
    const findings = scanUrlRules({
      text: "Read this https://khanacademy.org.evil.com/lesson",
      config,
    });
    expect(findings.some((finding) => finding.category === "external_domain")).toBe(true);
  });

  it("keeps allowlisted host with port and fragment", () => {
    const findings = scanUrlRules({
      text: "Open https://www.khanacademy.org:443/math#unit-test",
      config,
    });
    expect(findings).toHaveLength(0);
  });
});
