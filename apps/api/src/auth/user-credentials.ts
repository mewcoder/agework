import { randomInt } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { UserRole, UserStatus } from "@agework/shared/api";

export type { UserRole };

const VALID_ROLES: readonly UserRole[] = ["super_admin", "admin", "user"];
const VALID_STATUSES: readonly UserStatus[] = ["pending", "active", "disabled"];

export const SUPER_ADMIN_USERNAME = "admin";
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 32;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LETTER_PATTERN = /[A-Za-z]/;
const DIGIT_PATTERN = /\d/;
const WHITESPACE_PATTERN = /\s/;

const TEMP_PASSWORD_LENGTH = 18;
const UPPERCASE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const LETTERS = `${UPPERCASE}${LOWERCASE}`;
const TEMP_PASSWORD_CHARS = `${LETTERS}${DIGITS}`;

export function normalizeUsername(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new BadRequestException("用户名不能为空");
  }

  const username = raw.trim();
  if (username.length < USERNAME_MIN_LENGTH) {
    throw new BadRequestException(
      `用户名至少需要 ${USERNAME_MIN_LENGTH} 个字符`
    );
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    throw new BadRequestException(
      `用户名不能超过 ${USERNAME_MAX_LENGTH} 个字符`
    );
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new BadRequestException(
      "用户名只能包含字母、数字、下划线和短横线，并以字母或数字开头"
    );
  }

  return username;
}

export function assertPasswordForLogin(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new BadRequestException("密码不能为空");
  }
  if (raw.length > PASSWORD_MAX_LENGTH) {
    throw new BadRequestException(`密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符`);
  }
  return raw;
}

export function assertPasswordForSet(raw: unknown, username?: string): string {
  const password = assertPasswordForLogin(raw);
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new BadRequestException(`密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符`);
  }
  if (WHITESPACE_PATTERN.test(password)) {
    throw new BadRequestException("密码不能包含空白字符");
  }
  if (!LETTER_PATTERN.test(password) || !DIGIT_PATTERN.test(password)) {
    throw new BadRequestException("密码需要同时包含字母和数字");
  }
  if (username && password.toLowerCase() === username.toLowerCase()) {
    throw new BadRequestException("密码不能和用户名相同");
  }

  return password;
}

export function assertSuperAdminPasswordForSet(
  raw: unknown,
  username = SUPER_ADMIN_USERNAME
): string {
  return assertPasswordForSet(raw, username);
}

export function normalizeRole(raw: unknown, fallback: UserRole = "user") {
  const role = raw ?? fallback;
  if ((VALID_ROLES as readonly string[]).includes(role as string)) {
    return role as UserRole;
  }
  throw new BadRequestException("不支持的用户角色");
}

export function normalizeStatus(raw: unknown) {
  if ((VALID_STATUSES as readonly string[]).includes(raw as string)) {
    return raw as UserStatus;
  }
  throw new BadRequestException("不支持的用户状态");
}

export function generateTemporaryPassword(
  length = TEMP_PASSWORD_LENGTH
): string {
  const chars = [pick(LETTERS), pick(DIGITS)];

  while (chars.length < length) {
    chars.push(pick(TEMP_PASSWORD_CHARS));
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

function pick(pool: string): string {
  return pool[randomInt(pool.length)];
}
