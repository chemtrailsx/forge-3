/**
 * Best-effort guess at which country the cook is in.
 *
 * Asked of the browser rather than of the cook, because it is the sort of
 * thing that should already be known: nobody wants to be interviewed before
 * they can start cooking, and getting it wrong is not neutral — it produces
 * confident recommendations for shops and brands that do not exist where they
 * live.
 *
 * A guess, and treated as one: it is only recorded if nothing is on file, and
 * anything the cook actually says ("I'm in India") overrides it through
 * ordinary memory.
 */

/**
 * Timezones whose country cannot be read off the locale.
 *
 * Someone in Mumbai with their phone in `en-GB` reports Britain, which is the
 * exact case this exists for. Only the large, unambiguous ones — a zone that
 * spans countries is worse than no answer.
 */
const ZONE_REGIONS: Record<string, string> = {
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Asia/Colombo': 'LK',
  'Asia/Karachi': 'PK',
  'Asia/Dhaka': 'BD',
  'Asia/Kathmandu': 'NP',
  'Asia/Dubai': 'AE',
  'Asia/Singapore': 'SG',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Asia/Bangkok': 'TH',
  'Asia/Jakarta': 'ID',
  'Asia/Manila': 'PH',
  'Australia/Sydney': 'AU',
  'Pacific/Auckland': 'NZ',
  'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE',
  'Africa/Johannesburg': 'ZA',
  'America/Sao_Paulo': 'BR',
  'America/Mexico_City': 'MX',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
};

/** Reads the region subtag from a locale: "en-IN" -> "IN". */
export function regionFromLocale(locale: string | undefined): string | null {
  if (!locale) return null;
  const match = /^[A-Za-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(locale);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function regionFromTimeZone(zone: string | undefined): string | null {
  if (!zone) return null;
  return ZONE_REGIONS[zone] ?? null;
}

/**
 * The timezone is preferred over the locale.
 *
 * A language setting says what someone reads; a timezone says where they are
 * standing, and standing is what decides whether a shop is reachable.
 */
export function resolveRegion(
  locale: string | undefined,
  timeZone: string | undefined,
): string | null {
  return regionFromTimeZone(timeZone) ?? regionFromLocale(locale);
}

/** Browser-side entry point. Returns undefined rather than guessing wildly. */
export function detectRegion(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  let zone: string | undefined;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    zone = undefined;
  }
  return resolveRegion(navigator.language, zone) ?? undefined;
}
