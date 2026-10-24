import { normalizeSalesContactUrl } from "../../../lib/demoContact.mjs";

export function demoRegistrationEnabled(): boolean {
  return process.env.DEMO_PUBLIC_REGISTRATION_ENABLED === "true";
}

export function salesContactUrl(): string | null {
  return normalizeSalesContactUrl(
    process.env.SALES_CONTACT_URL || process.env.VITE_SALES_CONTACT_URL || "",
  );
}
