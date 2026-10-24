export function normalizeLogin(login: string): string;
export function hashPassword(password: string): Promise<string>;
export function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean>;
