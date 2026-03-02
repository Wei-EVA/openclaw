const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
};

export type NormalizedText = {
  raw: string;
  lower: string;
  collapsed: string;
  compact: string;
  leet: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function replaceLeet(value: string): string {
  return value
    .split("")
    .map((char) => LEET_MAP[char] ?? char)
    .join("");
}

export function normalizeText(value: string): NormalizedText {
  const normalized = value.normalize("NFKC");
  const lower = normalized.toLowerCase();
  const collapsed = normalizeWhitespace(lower);
  const compact = collapsed.replace(/[^a-z0-9]+/g, "");
  const leet = normalizeWhitespace(replaceLeet(collapsed.replace(/[^a-z0-9\s]+/g, " ")));
  return {
    raw: value,
    lower,
    collapsed,
    compact,
    leet,
  };
}

export function sampleContent(value: string, max = 220): string {
  const trimmed = normalizeWhitespace(value);
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...`;
}
