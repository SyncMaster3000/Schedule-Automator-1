export const DEFAULT_DEMO_CONTACT_URL = "https://t.me/SyncMaster30001";

const allowedProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);

export function normalizeSalesContactUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  // Migrate only the known old demo support address. Other configured contacts
  // keep their destination, including links with an explicit query or fragment.
  if (/^https:\/\/t\.me\/SyncMaster3000\/?$/i.test(raw)) {
    return DEFAULT_DEMO_CONTACT_URL;
  }
  try {
    const url = new URL(raw);
    return allowedProtocols.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function telegramContactLabel(value) {
  const normalized = normalizeSalesContactUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const handle = url.pathname.match(/^\/([A-Za-z0-9_]+)\/?$/)?.[1];
  return url.protocol === "https:" && url.hostname === "t.me" && handle
    ? `@${handle}`
    : null;
}
