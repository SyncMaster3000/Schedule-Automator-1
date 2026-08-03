import { computed, reactive } from "vue";
import {
  accessErrorKind,
  formatAccessDate,
  remainingAccessLabel,
} from "./accessPresentation";

export class ApiRequestError extends Error {
  constructor(message, { code = "request_failed", status = 0 } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
  }
}

export const sessionState = reactive({
  ready: false,
  navigationReady: false,
  loading: false,
  runtime: null,
  session: null,
  accessBlock: null,
  bootstrapError: "",
  now: Date.now(),
});

let initializationPromise = null;

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new ApiRequestError("Не удалось связаться с сервером");
  }

  if (response.status === 204) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiRequestError(
      `Некорректный ответ сервера (${response.status})`,
      {
        status: response.status,
      },
    );
  }

  if (!response.ok || body?.ok === false) {
    throw new ApiRequestError(body?.error || "Ошибка запроса", {
      code: body?.code,
      status: response.status,
    });
  }
  return body?.data;
}

function applyAccessError(error) {
  const kind = accessErrorKind(error?.code);
  if (kind === "blocked") {
    sessionState.session = null;
    sessionState.accessBlock = {
      code: error.code,
      message: error.message,
    };
    return true;
  }
  if (kind === "signed-out") {
    sessionState.session = null;
    sessionState.accessBlock = null;
    return true;
  }
  if (kind === "password-change") {
    if (sessionState.session?.user) {
      sessionState.session.user.mustChangePassword = true;
    }
    return true;
  }
  return false;
}

export async function refreshSession() {
  try {
    const data = await request("/api/auth/me");
    sessionState.session = data;
    sessionState.accessBlock = null;
    sessionState.now = Date.now();
    return data;
  } catch (error) {
    if (applyAccessError(error)) return null;
    throw error;
  }
}

export async function initializeSession({ force = false } = {}) {
  if (!force && initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    sessionState.loading = true;
    sessionState.bootstrapError = "";
    try {
      const runtime = await request("/api/runtime");
      sessionState.runtime = runtime;
      sessionState.session = null;
      sessionState.accessBlock = null;
      if (runtime?.mode === "web-demo") {
        await refreshSession();
      }
    } catch (error) {
      if (!applyAccessError(error)) {
        sessionState.bootstrapError =
          error?.message || "Не удалось подготовить приложение";
      }
    } finally {
      sessionState.loading = false;
      sessionState.ready = true;
    }
    return sessionState;
  })();
  return initializationPromise;
}

export async function login(loginValue, password) {
  sessionState.bootstrapError = "";
  try {
    const data = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ login: loginValue, password }),
    });
    sessionState.session = data;
    sessionState.accessBlock = null;
    sessionState.now = Date.now();
    return data;
  } catch (error) {
    applyAccessError(error);
    throw error;
  }
}

export async function changePassword(currentPassword, newPassword) {
  try {
    await request("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return refreshSession();
  } catch (error) {
    applyAccessError(error);
    throw error;
  }
}

export async function logout() {
  try {
    await request("/api/auth/logout", { method: "POST" });
  } catch {
    // Выход на клиенте должен сработать даже при недоступном сервере.
  } finally {
    sessionState.session = null;
    sessionState.accessBlock = null;
    sessionState.bootstrapError = "";
  }
}

export function prepareAnotherLogin() {
  sessionState.session = null;
  sessionState.accessBlock = null;
  sessionState.bootstrapError = "";
}

export function reportScheduleAccessError(error) {
  const handled = applyAccessError(error);
  if (!handled || typeof window === "undefined") return handled;
  window.location.hash = sessionState.accessBlock
    ? "#/demo-ended"
    : sessionState.session?.user?.mustChangePassword
      ? "#/change-password"
      : "#/login";
  return true;
}

export function updateSessionClock() {
  sessionState.now = Date.now();
  const expiresAt = sessionState.session?.demo?.expiresAt;
  const expiry = expiresAt ? new Date(expiresAt).valueOf() : Number.NaN;
  if (
    sessionState.runtime?.mode === "web-demo" &&
    sessionState.session &&
    Number.isFinite(expiry) &&
    expiry <= sessionState.now
  ) {
    reportScheduleAccessError(
      new ApiRequestError("Срок демонстрационного доступа закончился", {
        code: "demo_expired",
        status: 403,
      }),
    );
  }
}

export function markNavigationReady() {
  sessionState.navigationReady = true;
}

export const isWebDemo = computed(
  () => sessionState.runtime?.mode === "web-demo",
);

export const accessExpiryText = computed(() =>
  formatAccessDate(sessionState.session?.demo?.expiresAt),
);

export const accessRemainingText = computed(() =>
  remainingAccessLabel(sessionState.session?.demo?.expiresAt, sessionState.now),
);
