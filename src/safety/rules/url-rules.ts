import type { ChildSafetyResolvedConfig, SafetyFinding } from "../types.js";

const URL_RE = /https?:\/\/[^\s)\]}>"']+/gi;

function extractHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

function isAllowedDomain(hostname: string, allowed: string[]): boolean {
  for (const domain of allowed) {
    if (!domain) {
      continue;
    }
    if (hostname === domain) {
      return true;
    }
    if (hostname.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

export function collectUrlsFromText(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  return [...new Set(matches)];
}

export function scanUrlRules(params: {
  text?: string;
  urls?: string[];
  config: ChildSafetyResolvedConfig;
}): SafetyFinding[] {
  if (!params.config.blockedCategories.includes("external_domain")) {
    return [];
  }
  const urlPool = [
    ...(params.urls ?? []),
    ...(params.text ? collectUrlsFromText(params.text) : []),
  ].filter(Boolean);
  if (urlPool.length === 0 || params.config.allowedDomains.length === 0) {
    return [];
  }

  const findings: SafetyFinding[] = [];
  const seenHosts = new Set<string>();
  for (const candidate of urlPool) {
    const host = extractHost(candidate);
    if (!host || seenHosts.has(host)) {
      continue;
    }
    seenHosts.add(host);
    if (!isAllowedDomain(host, params.config.allowedDomains)) {
      findings.push({
        category: "external_domain",
        score: 0.65,
        layer: "L1_url",
        signal: host,
      });
    }
  }
  return findings;
}
