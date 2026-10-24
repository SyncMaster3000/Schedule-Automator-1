import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const parameters = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });

function requirePassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 10 ||
    password.length > 256
  ) {
    throw new Error("Пароль должен содержать от 10 до 256 символов");
  }
}

export function normalizeLogin(login) {
  if (typeof login !== "string") throw new Error("Логин обязателен");
  const normalized = login.normalize("NFKC").trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 100 ||
    !/^[\p{L}\p{N}._@-]+$/u.test(normalized)
  ) {
    throw new Error("Логин должен содержать от 3 до 100 допустимых символов");
  }
  return normalized;
}

export async function hashPassword(password) {
  requirePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    parameters.N,
    parameters.r,
    parameters.p,
    salt.toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password, encodedHash) {
  if (typeof password !== "string" || typeof encodedHash !== "string")
    return false;
  const [algorithm, rawN, rawR, rawP, rawSalt, rawExpected, ...extra] =
    encodedHash.split("$");
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (
    algorithm !== "scrypt" ||
    extra.length > 0 ||
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 16384 ||
    N > 262144 ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    r > 16 ||
    p < 1 ||
    p > 4 ||
    !rawSalt ||
    !rawExpected
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(rawSalt, "base64url");
    const expected = Buffer.from(rawExpected, "base64url");
    if (salt.length < 16 || expected.length < 32 || expected.length > 128)
      return false;
    const actual = Buffer.from(
      await scrypt(password, salt, expected.length, {
        N,
        r,
        p,
        maxmem: Math.max(64 * 1024 * 1024, 256 * N * r),
      }),
    );
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
