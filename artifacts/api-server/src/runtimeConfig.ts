const allowedSalesProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);

export function salesContactUrl(): string | null {
  const raw = String(
    process.env.SALES_CONTACT_URL || process.env.VITE_SALES_CONTACT_URL || "",
  ).trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    return allowedSalesProtocols.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
