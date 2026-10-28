import type { ResearchContact } from "../shared/research";
import { isWhatsAppNumber, normalizePhoneNumber } from "./research-phone";

type ContactType = ResearchContact["type"];
type ContactMethod = ResearchContact["method"];

export type ResearchPageLink = {
  href: string;
  text: string;
  context: string;
};

export type ResearchPageArtifact = {
  sourceUrl: string;
  text: string;
  links: ResearchPageLink[];
  jsonLd: unknown[];
};

export type ResearchTargetInput = {
  targetName: string;
  organization: string | null;
  defaultCountryCode?: string;
};

export type ContactCandidate = Pick<
  ResearchContact,
  "type" | "value" | "sourceUrl" | "method" | "confidence"
>;

type Draft = {
  type: ContactType;
  value: string;
  method: ContactMethod;
  confidence: number;
  priority: number;
};

type JsonLdNode = Record<string, unknown>;

type TextRange = {
  start: number;
  end: number;
};

const MAX_TEXT_CHARS = 2_000_000;
const MAX_LINKS = 2_000;
const MAX_JSONLD_NODES = 500;
const MAX_CANDIDATES = 50;
const NAME_WINDOW = 240;
const DEFAULT_COUNTRY_CODE = "62";

const EMAIL_VALUE_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const EMAIL_LOCAL_CHAR_PATTERN = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN_CHAR_PATTERN = /[A-Za-z0-9.-]/;
const EMAIL_LOCAL_MAX_LENGTH = 64;
const EMAIL_DOMAIN_MAX_LENGTH = 255;
const WHATSAPP_ME_PATTERN =
  /\b(?:https?:\/\/)?(?:www\.)?wa\.me\/[^\s<>"'`]+/gi;
const WHATSAPP_API_PATTERN =
  /\b(?:https?:\/\/)?(?:www\.)?api\.whatsapp\.com\/send\?[^\s<>"'`]+/gi;
const TEXT_PHONE_PATTERN = /\+?[0-9][0-9\s.\-()\u00A0]{5,}[0-9]/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}>]+$/;
const EXTENSION_SUFFIX_PATTERN = /^\s*(?:ext\.?|x|#)\s*[0-9]/i;
const BOUNDARY_PATTERN = /[\p{L}\p{N}_]/u;
const DIACRITIC_PATTERN = /\p{M}/gu;
const WHITESPACE_PATTERN = /\s+/g;
const LINKEDIN_PROFILE_PATTERN = /^\/(?:in|pub)\/[^/]+/i;
const GITHUB_USERNAME_PATTERN = /^[a-z0-9-]+$/i;
const ORCID_PATTERN = /^\/[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$/i;
const RESEARCHGATE_PROFILE_PATTERN = /^\/profile\/[^/]+/i;

const SOCIAL_HOSTS: readonly string[] = [
  "x.com",
  "twitter.com",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "youtube.com",
];

const RESERVED_GITHUB_PATHS: ReadonlySet<string> = new Set([
  "about",
  "account",
  "apps",
  "collections",
  "contact",
  "customer-stories",
  "dashboard",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "sessions",
  "settings",
  "site",
  "sponsors",
  "stars",
  "team",
  "topics",
  "trending",
  "users",
]);

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(DIACRITIC_PATTERN, "")
    .toLowerCase()
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is JsonLdNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function hasTarget(name: string, targetName: string): boolean {
  return normalizeText(name).includes(targetName);
}

function hasTargetInWindow(
  text: string,
  index: number,
  length: number,
  targetName: string,
): boolean {
  const start = Math.max(0, index - NAME_WINDOW);
  const end = index + length;
  const window = `${text.slice(start, index)}\n${text.slice(end, end + NAME_WINDOW)}`;

  return normalizeText(window).includes(targetName);
}

function normalizeEmail(raw: string): string | null {
  const decoded = safeDecode(raw.trim().replace(/^mailto:/i, ""));
  const address = decoded.split(/[?#]/)[0] ?? "";
  const value = address.trim().toLowerCase();

  return EMAIL_VALUE_PATTERN.test(value) ? value : null;
}

function addDraft(
  drafts: Draft[],
  type: ContactType,
  value: string,
  method: ContactMethod,
  confidence: number,
  priority: number,
): void {
  drafts.push({ type, value, method, confidence, priority });
}

function isLinkedInHost(host: string): boolean {
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

function isSocialHost(host: string): boolean {
  return SOCIAL_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

function normalizeProfileUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");

  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

function githubProfileUrl(url: URL): string | null {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const username = segments[0];
  if (segments.length !== 1 || username === undefined) {
    return null;
  }
  if (RESERVED_GITHUB_PATHS.has(username.toLowerCase())) {
    return null;
  }
  if (!GITHUB_USERNAME_PATTERN.test(username)) {
    return null;
  }

  return normalizeProfileUrl(url);
}

function profileUrl(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    return githubProfileUrl(url);
  }
  if (host === "scholar.google.com") {
    return url.pathname === "/" ? null : normalizeProfileUrl(url);
  }
  if (host === "orcid.org" || host === "www.orcid.org") {
    return ORCID_PATTERN.test(url.pathname) ? normalizeProfileUrl(url) : null;
  }
  if (host === "researchgate.net" || host === "www.researchgate.net") {
    return RESEARCHGATE_PROFILE_PATTERN.test(url.pathname)
      ? normalizeProfileUrl(url)
      : null;
  }

  return null;
}

function classifyUrl(url: URL, defaultCountryCode: string): Draft | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host === "wa.me" || host === "www.wa.me") {
    const segment = url.pathname.split("/")[1] ?? "";
    const phone = normalizePhoneNumber(safeDecode(segment), defaultCountryCode);
    if (phone === null || !isWhatsAppNumber(phone)) {
      return null;
    }

    return {
      type: "whatsapp",
      value: phone,
      method: "wa_me_link",
      confidence: 0.95,
      priority: 0,
    };
  }
  if (host === "api.whatsapp.com" || host === "www.api.whatsapp.com") {
    if (url.pathname.replace(/\/+$/, "") !== "/send") {
      return null;
    }
    const rawPhone = url.searchParams.get("phone");
    if (rawPhone === null) {
      return null;
    }
    const phone = normalizePhoneNumber(rawPhone, defaultCountryCode);
    if (phone === null || !isWhatsAppNumber(phone)) {
      return null;
    }

    return {
      type: "whatsapp",
      value: phone,
      method: "api_whatsapp_link",
      confidence: 0.9,
      priority: 1,
    };
  }
  if (isLinkedInHost(host)) {
    if (!LINKEDIN_PROFILE_PATTERN.test(url.pathname)) {
      return null;
    }

    return {
      type: "linkedin",
      value: normalizeProfileUrl(url),
      method: "linkedin_url",
      confidence: 0.95,
      priority: 2,
    };
  }
  if (isSocialHost(host)) {
    if (url.pathname === "" || url.pathname === "/") {
      return null;
    }

    return {
      type: "social",
      value: normalizeProfileUrl(url),
      method: "social_url",
      confidence: 0.8,
      priority: 5,
    };
  }
  const profile = profileUrl(url);
  if (profile === null) {
    return null;
  }

  return {
    type: "profile",
    value: profile,
    method: "profile_url",
    confidence: 0.7,
    priority: 7,
  };
}

function isPhoneBoundary(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text.charAt(start - 1);
  const after = end >= text.length ? "" : text.charAt(end);

  return !BOUNDARY_PATTERN.test(before) && !BOUNDARY_PATTERN.test(after);
}

function overlaps(ranges: readonly TextRange[], start: number, end: number): boolean {
  return ranges.some((range) => start < range.end && range.start < end);
}

function findEmails(text: string): Array<{ raw: string; index: number }> {
  const matches: Array<{ raw: string; index: number }> = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const at = text.indexOf("@", searchFrom);
    if (at === -1) {
      break;
    }
    searchFrom = at + 1;

    let start = at;
    const startLimit = Math.max(0, at - EMAIL_LOCAL_MAX_LENGTH);
    while (start > startLimit && EMAIL_LOCAL_CHAR_PATTERN.test(text.charAt(start - 1))) {
      start -= 1;
    }
    if (start > 0 && EMAIL_LOCAL_CHAR_PATTERN.test(text.charAt(start - 1))) {
      continue;
    }

    let end = at + 1;
    const endLimit = Math.min(text.length, at + 1 + EMAIL_DOMAIN_MAX_LENGTH);
    while (end < endLimit && EMAIL_DOMAIN_CHAR_PATTERN.test(text.charAt(end))) {
      end += 1;
    }

    const raw = text.slice(start, end).replace(/\.+$/, "");
    if (EMAIL_VALUE_PATTERN.test(raw.toLowerCase())) {
      matches.push({ raw, index: start });
    }
  }

  return matches;
}

function phoneFromWhatsAppMe(raw: string, defaultCountryCode: string): string | null {
  const withoutScheme = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "");
  const segment = withoutScheme.slice("wa.me/".length).split(/[/?#]/)[0] ?? "";
  const phone = normalizePhoneNumber(
    safeDecode(segment.replace(TRAILING_PUNCTUATION_PATTERN, "")),
    defaultCountryCode,
  );

  return phone !== null && isWhatsAppNumber(phone) ? phone : null;
}

function phoneFromWhatsAppApi(raw: string, defaultCountryCode: string): string | null {
  const queryStart = raw.indexOf("?");
  if (queryStart === -1) {
    return null;
  }
  const query = raw
    .slice(queryStart + 1)
    .replace(TRAILING_PUNCTUATION_PATTERN, "");
  const phone = normalizePhoneNumber(
    new URLSearchParams(query).get("phone") ?? "",
    defaultCountryCode,
  );

  return phone !== null && isWhatsAppNumber(phone) ? phone : null;
}

function collectTextArtifacts(
  text: string,
  targetName: string,
  defaultCountryCode: string,
  drafts: Draft[],
): void {
  const consumed: TextRange[] = [];

  WHATSAPP_ME_PATTERN.lastIndex = 0;
  for (
    let match = WHATSAPP_ME_PATTERN.exec(text);
    match !== null;
    match = WHATSAPP_ME_PATTERN.exec(text)
  ) {
    const raw = match[0];
    const index = match.index;
    consumed.push({ start: index, end: index + raw.length });
    if (!hasTargetInWindow(text, index, raw.length, targetName)) {
      continue;
    }
    const phone = phoneFromWhatsAppMe(raw, defaultCountryCode);
    if (phone !== null) {
      addDraft(drafts, "whatsapp", phone, "wa_me_link", 0.95, 0);
    }
  }

  WHATSAPP_API_PATTERN.lastIndex = 0;
  for (
    let match = WHATSAPP_API_PATTERN.exec(text);
    match !== null;
    match = WHATSAPP_API_PATTERN.exec(text)
  ) {
    const raw = match[0];
    const index = match.index;
    consumed.push({ start: index, end: index + raw.length });
    if (!hasTargetInWindow(text, index, raw.length, targetName)) {
      continue;
    }
    const phone = phoneFromWhatsAppApi(raw, defaultCountryCode);
    if (phone !== null) {
      addDraft(drafts, "whatsapp", phone, "api_whatsapp_link", 0.9, 1);
    }
  }

  for (const match of findEmails(text)) {
    consumed.push({ start: match.index, end: match.index + match.raw.length });
    if (!hasTargetInWindow(text, match.index, match.raw.length, targetName)) {
      continue;
    }
    const email = normalizeEmail(match.raw);
    if (email !== null) {
      addDraft(drafts, "email", email, "email_text", 0.7, 8);
    }
  }

  TEXT_PHONE_PATTERN.lastIndex = 0;
  for (
    let match = TEXT_PHONE_PATTERN.exec(text);
    match !== null;
    match = TEXT_PHONE_PATTERN.exec(text)
  ) {
    const raw = match[0];
    const index = match.index;
    const end = index + raw.length;
    if (overlaps(consumed, index, end)) {
      continue;
    }
    if (!isPhoneBoundary(text, index, end)) {
      continue;
    }
    if (EXTENSION_SUFFIX_PATTERN.test(text.slice(end, end + 12))) {
      continue;
    }
    if (!hasTargetInWindow(text, index, raw.length, targetName)) {
      continue;
    }
    const phone = normalizePhoneNumber(raw, defaultCountryCode);
    if (phone !== null) {
      addDraft(drafts, "phone", phone, "tel_link", 0.75, 6);
    }
  }
}

function collectLinkArtifacts(
  links: readonly ResearchPageLink[],
  sourceUrl: string,
  targetName: string,
  defaultCountryCode: string,
  drafts: Draft[],
): void {
  for (const link of links) {
    if (!hasTarget(link.text, targetName) && !hasTarget(link.context, targetName)) {
      continue;
    }

    const href = link.href.trim();
    if (href.length === 0) {
      continue;
    }

    const mailtoMatch = /^mailto:/i.exec(href);
    if (mailtoMatch !== null) {
      const email = normalizeEmail(href.slice(mailtoMatch[0].length));
      if (email !== null) {
        addDraft(drafts, "email", email, "email_text", 0.9, 3);
      }
      continue;
    }

    const telMatch = /^tel:/i.exec(href);
    if (telMatch !== null) {
      const raw = safeDecode(href.slice(telMatch[0].length).split(/[?#]/)[0] ?? "");
      const phone = normalizePhoneNumber(raw, defaultCountryCode);
      if (phone !== null) {
        addDraft(drafts, "phone", phone, "tel_link", 0.75, 6);
      }
      continue;
    }

    let url: URL;
    try {
      url = new URL(href, sourceUrl);
    } catch {
      continue;
    }
    const draft = classifyUrl(url, defaultCountryCode);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
}

function collectJsonLd(jsonLd: readonly unknown[]): {
  nodes: JsonLdNode[];
  strings: string[];
} {
  const nodes: JsonLdNode[] = [];
  const strings: string[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [...jsonLd].reverse();

  while (stack.length > 0 && nodes.length < MAX_JSONLD_NODES) {
    const current = stack.pop();
    if (typeof current === "string") {
      strings.push(current);
      continue;
    }
    if (current === null || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    nodes.push(current);
    for (const child of Object.values(current)) {
      if (typeof child === "string") {
        strings.push(child);
      } else if (typeof child === "object" && child !== null) {
        stack.push(child);
      }
    }
  }

  return { nodes, strings };
}

function asStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(asStrings);
  }
  if (isRecord(value) && typeof value.url === "string") {
    return [value.url];
  }

  return [];
}

function personName(node: JsonLdNode): string | null {
  const name = node.name;
  if (typeof name === "string") {
    return name;
  }
  if (Array.isArray(name)) {
    const first = name.find((entry): entry is string => typeof entry === "string");
    return first ?? null;
  }

  return null;
}

function hasPersonType(node: JsonLdNode): boolean {
  const type = node["@type"];

  return type === "Person" || (Array.isArray(type) && type.includes("Person"));
}

function matchesTargetName(name: string, targetName: string): boolean {
  const normalized = normalizeText(name);
  if (normalized === targetName) {
    return true;
  }
  if (!normalized.startsWith(targetName)) {
    return false;
  }
  const next = normalized.charAt(targetName.length);

  return next.length > 0 && !BOUNDARY_PATTERN.test(next);
}

function worksForNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(worksForNames);
  }
  if (typeof value === "string") {
    return [value];
  }
  if (isRecord(value) && typeof value.name === "string") {
    return [value.name];
  }

  return [];
}

function matchesOrganization(value: unknown, organization: string): boolean {
  const names = worksForNames(value).map(normalizeText).filter((name) => name.length > 0);
  if (names.length === 0) {
    return true;
  }

  return names.some(
    (name) => name.includes(organization) || organization.includes(name),
  );
}

function contactPoints(value: unknown): JsonLdNode[] {
  if (Array.isArray(value)) {
    return value.flatMap(contactPoints);
  }

  return isRecord(value) ? [value] : [];
}

function collectJsonLdArtifacts(
  nodes: readonly JsonLdNode[],
  targetName: string,
  organization: string | null,
  defaultCountryCode: string,
  drafts: Draft[],
): void {
  for (const node of nodes) {
    if (!hasPersonType(node)) {
      continue;
    }
    const name = personName(node);
    if (name === null || !matchesTargetName(name, targetName)) {
      continue;
    }
    if (organization !== null && !matchesOrganization(node.worksFor, organization)) {
      continue;
    }

    for (const raw of asStrings(node.telephone)) {
      const phone = normalizePhoneNumber(raw, defaultCountryCode);
      if (phone !== null) {
        addDraft(drafts, "phone", phone, "jsonld_telephone", 0.85, 4);
      }
    }
    for (const raw of asStrings(node.email)) {
      const email = normalizeEmail(raw);
      if (email !== null) {
        addDraft(drafts, "email", email, "email_text", 0.7, 8);
      }
    }
    for (const point of contactPoints(node.contactPoint)) {
      for (const raw of asStrings(point.telephone)) {
        const phone = normalizePhoneNumber(raw, defaultCountryCode);
        if (phone !== null) {
          addDraft(drafts, "phone", phone, "jsonld_telephone", 0.85, 4);
        }
      }
      for (const raw of asStrings(point.email)) {
        const email = normalizeEmail(raw);
        if (email !== null) {
          addDraft(drafts, "email", email, "email_text", 0.7, 8);
        }
      }
    }
    for (const raw of asStrings(node.sameAs)) {
      const url = parseHttpUrl(raw);
      if (url !== null) {
        const draft = classifyUrl(url, defaultCountryCode);
        if (draft !== null) {
          drafts.push(draft);
        }
      }
    }
  }
}

function organizationPresent(organization: string, haystack: string): boolean {
  const tokens = organization
    .split(" ")
    .filter((token) => token.length >= 3);

  return tokens.some((token) => haystack.includes(token));
}

function finalize(drafts: readonly Draft[], sourceUrl: string): ContactCandidate[] {
  const best = new Map<string, Draft>();
  for (const draft of drafts) {
    const key = `${draft.type}\u0000${draft.value}`;
    const existing = best.get(key);
    const isBetter =
      existing === undefined ||
      draft.confidence > existing.confidence ||
      (draft.confidence === existing.confidence && draft.priority < existing.priority);
    if (isBetter) {
      best.set(key, draft);
    }
  }

  const ranked = [...best.values()].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      compareText(left.type, right.type) ||
      compareText(left.value, right.value),
  );

  return ranked
    .slice(0, MAX_CANDIDATES)
    .map((draft) => ({
      type: draft.type,
      value: draft.value,
      sourceUrl,
      method: draft.method,
      confidence: draft.confidence,
    }))
    .sort(
      (left, right) =>
        compareText(left.type, right.type) ||
        compareText(left.value, right.value) ||
        compareText(left.sourceUrl, right.sourceUrl),
    );
}

export function extractResearchContacts(
  page: ResearchPageArtifact,
  target: ResearchTargetInput,
): ContactCandidate[] {
  const sourceUrl = parseHttpUrl(page.sourceUrl);
  const targetName = normalizeText(target.targetName);
  if (sourceUrl === null || targetName.length === 0) {
    return [];
  }

  const normalizedOrganization =
    target.organization === null ? "" : normalizeText(target.organization);
  const organization = normalizedOrganization.length === 0 ? null : normalizedOrganization;
  const defaultCountryCode = target.defaultCountryCode ?? DEFAULT_COUNTRY_CODE;
  const text = page.text.slice(0, MAX_TEXT_CHARS);
  const links = page.links.slice(0, MAX_LINKS);
  const { nodes, strings } = collectJsonLd(page.jsonLd);

  if (organization !== null) {
    const haystack = `${normalizeText(text)}\n${strings.map(normalizeText).join("\n")}`;
    if (!organizationPresent(organization, haystack)) {
      return [];
    }
  }

  const drafts: Draft[] = [];
  collectTextArtifacts(text, targetName, defaultCountryCode, drafts);
  collectLinkArtifacts(links, page.sourceUrl, targetName, defaultCountryCode, drafts);
  collectJsonLdArtifacts(
    nodes,
    targetName,
    organization,
    defaultCountryCode,
    drafts,
  );

  return finalize(drafts, page.sourceUrl);
}
