import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isAuthorized(authorization: string | undefined, token: string): boolean {
  return timingSafeEqual(digest(authorization ?? ""), digest(`Bearer ${token}`));
}
