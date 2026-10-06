/**
 * COUNTRY-SHAPED FORMATS: phone numbers and postal codes.
 *
 * The platform had one phone regex and one postal regex, both deliberately
 * loose — the comment on the phone one says so: "loose enough for the world's
 * numbering plans, strict enough to catch a typo". That is the right default
 * and the wrong only option. A study fielded in India wants a ten-digit mobile
 * and a six-digit PIN; one fielded in the United States wants ten digits and a
 * five-digit ZIP; the September review asked for both, twice — once for the
 * Text/Open-End subtypes and once for the fields inside a List question.
 *
 * So the loose check stays as "any country", and a question may name one.
 * Nothing changes for a question that does not.
 *
 * The table is deliberately short. Every entry here is a format somebody can
 * check against a real document, and a wrong rule is worse than a missing one
 * — it rejects a respondent who typed their own address correctly. Adding a
 * country is one line and a source; guessing at one is not.
 */

export interface CountryFormat {
  code: string;
  name: string;
  /** international dialling prefix, for phone formats */
  dial?: string;
  re: RegExp;
  example: string;
}

/** Digits only, so a number typed with spaces, dashes or brackets still matches. */
const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Phone formats, matched against the digits of what was typed with any
 * country code allowed in front. `re` is tested against the NATIONAL number
 * — the digits left once an international prefix for that country is removed.
 */
export const PHONE_FORMATS: readonly CountryFormat[] = [
  { code: "IN", name: "India", dial: "91", re: /^[6-9]\d{9}$/, example: "+91 98765 43210" },
  { code: "US", name: "United States", dial: "1", re: /^[2-9]\d{2}[2-9]\d{6}$/, example: "+1 415 555 0132" },
  { code: "CA", name: "Canada", dial: "1", re: /^[2-9]\d{2}[2-9]\d{6}$/, example: "+1 604 555 0132" },
  { code: "GB", name: "United Kingdom", dial: "44", re: /^\d{9,10}$/, example: "+44 7700 900123" },
  { code: "AU", name: "Australia", dial: "61", re: /^\d{9}$/, example: "+61 412 345 678" },
  { code: "DE", name: "Germany", dial: "49", re: /^\d{6,11}$/, example: "+49 151 23456789" },
  { code: "FR", name: "France", dial: "33", re: /^[1-9]\d{8}$/, example: "+33 6 12 34 56 78" },
  { code: "AE", name: "United Arab Emirates", dial: "971", re: /^\d{8,9}$/, example: "+971 50 123 4567" },
  { code: "SG", name: "Singapore", dial: "65", re: /^[3689]\d{7}$/, example: "+65 8123 4567" },
  { code: "ZA", name: "South Africa", dial: "27", re: /^\d{9}$/, example: "+27 82 123 4567" },
];

/**
 * THE RESPONDENT'S COUNTRY-CODE LIST (October 2026 review: "the respondent
 * should be able to select their country code from a dropdown … country names
 * and their corresponding international dialing codes"). Longer than
 * `PHONE_FORMATS`: a country here without a format there is offered and
 * checked loosely; one with a format is checked strictly.
 */
export const DIAL_CODES: readonly { code: string; name: string; dial: string; flag: string }[] = [
  { code: "IN", name: "India", dial: "91", flag: "🇮🇳" },
  { code: "US", name: "United States", dial: "1", flag: "🇺🇸" },
  { code: "GB", name: "United Kingdom", dial: "44", flag: "🇬🇧" },
  { code: "AE", name: "United Arab Emirates", dial: "971", flag: "🇦🇪" },
  { code: "AU", name: "Australia", dial: "61", flag: "🇦🇺" },
  { code: "CA", name: "Canada", dial: "1", flag: "🇨🇦" },
  { code: "DE", name: "Germany", dial: "49", flag: "🇩🇪" },
  { code: "FR", name: "France", dial: "33", flag: "🇫🇷" },
  { code: "SG", name: "Singapore", dial: "65", flag: "🇸🇬" },
  { code: "ZA", name: "South Africa", dial: "27", flag: "🇿🇦" },
  { code: "SA", name: "Saudi Arabia", dial: "966", flag: "🇸🇦" },
  { code: "QA", name: "Qatar", dial: "974", flag: "🇶🇦" },
  { code: "KW", name: "Kuwait", dial: "965", flag: "🇰🇼" },
  { code: "OM", name: "Oman", dial: "968", flag: "🇴🇲" },
  { code: "BH", name: "Bahrain", dial: "973", flag: "🇧🇭" },
  { code: "PK", name: "Pakistan", dial: "92", flag: "🇵🇰" },
  { code: "BD", name: "Bangladesh", dial: "880", flag: "🇧🇩" },
  { code: "LK", name: "Sri Lanka", dial: "94", flag: "🇱🇰" },
  { code: "NP", name: "Nepal", dial: "977", flag: "🇳🇵" },
  { code: "MY", name: "Malaysia", dial: "60", flag: "🇲🇾" },
  { code: "ID", name: "Indonesia", dial: "62", flag: "🇮🇩" },
  { code: "PH", name: "Philippines", dial: "63", flag: "🇵🇭" },
  { code: "TH", name: "Thailand", dial: "66", flag: "🇹🇭" },
  { code: "VN", name: "Vietnam", dial: "84", flag: "🇻🇳" },
  { code: "CN", name: "China", dial: "86", flag: "🇨🇳" },
  { code: "JP", name: "Japan", dial: "81", flag: "🇯🇵" },
  { code: "KR", name: "South Korea", dial: "82", flag: "🇰🇷" },
  { code: "NZ", name: "New Zealand", dial: "64", flag: "🇳🇿" },
  { code: "IE", name: "Ireland", dial: "353", flag: "🇮🇪" },
  { code: "NL", name: "Netherlands", dial: "31", flag: "🇳🇱" },
  { code: "ES", name: "Spain", dial: "34", flag: "🇪🇸" },
  { code: "IT", name: "Italy", dial: "39", flag: "🇮🇹" },
  { code: "PT", name: "Portugal", dial: "351", flag: "🇵🇹" },
  { code: "SE", name: "Sweden", dial: "46", flag: "🇸🇪" },
  { code: "CH", name: "Switzerland", dial: "41", flag: "🇨🇭" },
  { code: "BR", name: "Brazil", dial: "55", flag: "🇧🇷" },
  { code: "MX", name: "Mexico", dial: "52", flag: "🇲🇽" },
  { code: "NG", name: "Nigeria", dial: "234", flag: "🇳🇬" },
  { code: "KE", name: "Kenya", dial: "254", flag: "🇰🇪" },
  { code: "EG", name: "Egypt", dial: "20", flag: "🇪🇬" },
];

/**
 * The country a number written with a "+" prefix belongs to, when it is one
 * the platform can check strictly — so a respondent who picked "+91" from the
 * list is held to India's format, not the loose any-country check. The
 * longest matching dialing code wins ("+971" is the UAE, not "+97…").
 */
/**
 * The country to check a phone answer against. `"pick"` is the setting that
 * puts the country-code list in front of the respondent, so their own "+code"
 * decides; any other value is a configured country (or none — the loose,
 * any-country check every question authored before had, which stays as it
 * was: an answer like "+1 (555) 123-4567" is not suddenly refused).
 */
export function phoneCountryFor(setting: string | undefined, value: string): string | undefined {
  return setting === PHONE_PICK ? phoneCountryFromPrefix(value) : setting || undefined;
}
/** The phone-country setting value meaning "the respondent chooses from the code list". */
export const PHONE_PICK = "pick";

export function phoneCountryFromPrefix(value: string): string | undefined {
  const v = value.trim();
  if (!v.startsWith("+")) return undefined;
  const d = v.replace(/\D/g, "");
  const hit = [...PHONE_FORMATS].sort((a, b) => (b.dial?.length ?? 0) - (a.dial?.length ?? 0))
    .find((f) => f.dial && d.startsWith(f.dial) && d.length > f.dial.length);
  return hit?.code;
}

export const POSTAL_FORMATS: readonly CountryFormat[] = [
  { code: "IN", name: "India (PIN)", re: /^[1-9]\d{5}$/, example: "560001" },
  { code: "US", name: "United States (ZIP)", re: /^\d{5}(-\d{4})?$/, example: "94107 or 94107-1234" },
  { code: "CA", name: "Canada", re: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/, example: "V6B 4Y8" },
  { code: "GB", name: "United Kingdom", re: /^[A-Za-z]{1,2}\d[A-Za-z\d]?[ ]?\d[A-Za-z]{2}$/, example: "SW1A 1AA" },
  { code: "AU", name: "Australia", re: /^\d{4}$/, example: "3000" },
  { code: "DE", name: "Germany", re: /^\d{5}$/, example: "10115" },
  { code: "FR", name: "France", re: /^\d{5}$/, example: "75008" },
  { code: "SG", name: "Singapore", re: /^\d{6}$/, example: "238823" },
  { code: "ZA", name: "South Africa", re: /^\d{4}$/, example: "8001" },
];

export const phoneFormat = (code?: string) =>
  code ? PHONE_FORMATS.find((f) => f.code === code) : undefined;
export const postalFormat = (code?: string) =>
  code ? POSTAL_FORMATS.find((f) => f.code === code) : undefined;

/** The loose, region-agnostic phone check — the platform's long-standing default. */
export function looksLikeAnyPhone(value: string): boolean {
  return /^[+()\-.\s\d]{7,}$/.test(value) && digits(value).length >= 7;
}

/**
 * A phone number against a country, or against nothing in particular.
 * Returns null when it is acceptable, or the reason it is not.
 */
export function checkPhone(value: string, country?: string): string | null {
  const fmt = phoneFormat(country);
  if (!fmt) return looksLikeAnyPhone(value) ? null : "Please enter a valid phone number.";
  let d = digits(value);
  /* an international prefix for this country is allowed, with or without the + */
  if (fmt.dial && d.startsWith(fmt.dial) && d.length > fmt.dial.length) d = d.slice(fmt.dial.length);
  /* a national trunk "0" is how people write their own number at home */
  if (d.startsWith("0")) d = d.slice(1);
  return fmt.re.test(d) ? null : `Please enter a valid ${fmt.name} phone number (e.g. ${fmt.example}).`;
}

/** The loose postal check the platform shipped with. */
export function looksLikeAnyPostal(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9\- ]{2,9}$/.test(value);
}

export function checkPostal(value: string, country?: string): string | null {
  const fmt = postalFormat(country);
  if (!fmt) return looksLikeAnyPostal(value) ? null : "Please enter a valid postal code.";
  return fmt.re.test(value.trim()) ? null : `Please enter a valid ${fmt.name} postal code (e.g. ${fmt.example}).`;
}

/**
 * A web address. Deliberately accepts a bare host — respondents type
 * "example.com" far more often than "https://example.com", and rejecting that
 * loses a real answer to a formality the survey can add itself.
 */
export function checkUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "Please enter a web address.";
    if (!u.hostname.includes(".") || u.hostname.endsWith(".")) return "Please enter a valid web address.";
    return null;
  } catch {
    return "Please enter a valid web address.";
  }
}

/**
 * CURRENCIES a question may be denominated in. The platform had one hard-coded
 * "$" prefix on currency fields and no way to change it, which the review
 * reported from both directions — the Numeric Currency question showed no
 * symbol at all, and the List field showed a dollar sign to studies that were
 * not priced in dollars.
 */
export const CURRENCIES: readonly { code: string; symbol: string; name: string }[] = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "Pound Sterling" },
  { code: "INR", symbol: "₹", name: "Indian Rupee" },
  { code: "AED", symbol: "د.إ", name: "UAE Dirham" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "SGD", symbol: "S$", name: "Singapore Dollar" },
  { code: "ZAR", symbol: "R", name: "South African Rand" },
];

/**
 * The symbol to put beside a numeric input, and which side it goes.
 * `currencySymbol` is the escape hatch for anything not in the list — the
 * review asked for "an empty/custom currency-symbol field" as an alternative
 * to the dropdown, and this is both.
 */
export function affixFor(settings: {
  currencyCode?: string;
  currencySymbol?: string;
  symbolSide?: "left" | "right";
}, fallback?: string): { text: string; side: "left" | "right" } | null {
  const text =
    settings.currencySymbol?.trim() ||
    CURRENCIES.find((c) => c.code === settings.currencyCode)?.symbol ||
    fallback ||
    "";
  if (!text) return null;
  return { text, side: settings.symbolSide ?? "left" };
}
