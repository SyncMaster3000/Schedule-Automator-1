import { isIP } from "node:net";

export function canonicalAddress(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6 || value.includes("%")) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

// Render documents that its public Cloudflare edge replaces this single-IP
// header. Never use XFF as a fallback: its chain can include caller input.
// The boundary applies to the existing public free web service, not private
// backends. Local development ignores every forwarding header.
export function registrationAddress(
  request,
  {
    production = process.env.NODE_ENV === "production",
    render = process.env.RENDER === "true" &&
      Boolean(process.env.RENDER_EXTERNAL_HOSTNAME),
  } = {},
) {
  if (!production) return canonicalAddress(request.socket.remoteAddress);
  if (!render) return null;
  return canonicalAddress(request.header("cf-connecting-ip"));
}
