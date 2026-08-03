import { AuthError } from "./service.js";

function requiredObject(value) {
  return value && typeof value === "object" ? value : null;
}

export function createScheduleContextResolver(authService) {
  return async function resolveScheduleContext(token) {
    const session = requiredObject(await authService.me(token));
    const user = requiredObject(session?.user);
    const organization = requiredObject(session?.organization);
    if (
      typeof user?.id !== "string" ||
      typeof organization?.id !== "string" ||
      typeof user?.role !== "string"
    ) {
      throw new AuthError(
        401,
        "invalid_session_context",
        "Сессия не содержит данные организации",
      );
    }
    if (user.mustChangePassword) {
      throw new AuthError(
        403,
        "password_change_required",
        "Перед работой с расписанием измените временный пароль",
      );
    }
    return {
      organizationId: organization.id,
      userId: user.id,
      displayName:
        typeof user.displayName === "string" ? user.displayName : null,
      role: user.role,
    };
  };
}
