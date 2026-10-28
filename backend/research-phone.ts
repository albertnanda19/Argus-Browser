const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const COUNTRY_CODE_PATTERN = /^[1-9][0-9]{0,2}$/;
const SEPARATOR_PATTERN = /[\s.()-]/g;
const PHONE_BODY_PATTERN = /^\+?[0-9]+$/;
const LETTER_OR_EXTENSION_PATTERN = /[a-z#]/i;

function normalizeCountryCode(value: string): string | null {
  const trimmed = value.trim().replace(/^\+/, "");

  return COUNTRY_CODE_PATTERN.test(trimmed) ? trimmed : null;
}

export function normalizePhoneNumber(
  raw: string,
  defaultCountryCode = "62",
): string | null {
  const countryCode = normalizeCountryCode(defaultCountryCode);
  if (countryCode === null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 || LETTER_OR_EXTENSION_PATTERN.test(trimmed)) {
    return null;
  }

  const compact = trimmed.replace(SEPARATOR_PATTERN, "");
  if (!PHONE_BODY_PATTERN.test(compact)) {
    return null;
  }

  let digits: string;
  if (compact.startsWith("+")) {
    digits = compact.slice(1);
  } else if (compact.startsWith("00")) {
    digits = compact.slice(2);
  } else if (compact.startsWith("0")) {
    digits = `${countryCode}${compact.slice(1)}`;
  } else if (compact.startsWith(countryCode)) {
    digits = compact;
  } else {
    return null;
  }

  const value = `+${digits}`;

  return E164_PATTERN.test(value) ? value : null;
}

export function isWhatsAppNumber(value: string): boolean {
  return !value.startsWith("+62") || value.startsWith("+628");
}
