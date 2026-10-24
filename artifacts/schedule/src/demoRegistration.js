export function demoRegistrationValidation(input) {
  const organizationName = String(input.organizationName || "").trim();
  const displayName = String(input.displayName || "").trim();
  const login = String(input.login || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();

  if (organizationName.length < 3 || organizationName.length > 200) {
    return "Название учреждения должно содержать от 3 до 200 символов";
  }
  if (displayName.length < 2 || displayName.length > 150) {
    return "Имя должно содержать от 2 до 150 символов";
  }
  if (
    login.length < 3 ||
    login.length > 100 ||
    !/^[\p{L}\p{N}._@-]+$/u.test(login)
  ) {
    return "Логин: от 3 до 100 букв, цифр или символов . _ @ - без пробелов";
  }
  if (
    typeof input.password !== "string" ||
    input.password.length < 10 ||
    input.password.length > 256
  ) {
    return "Пароль должен содержать от 10 до 256 символов";
  }
  if (input.password !== input.confirmation) return "Пароли не совпадают";
  return "";
}

export function demoRegistrationState() {
  return {
    submitting: false,
    account: null,
    error: "",
    signInError: "",
    uncertain: false,
  };
}

// Keep successful creation separate from sign-in: a failed sign-in must never
// cause another account-creation request, including a second form submission.
export function createDemoRegistrationFlow({
  registerDemo,
  login,
  state = demoRegistrationState(),
}) {
  return {
    state,
    async submit(input) {
      if (state.submitting || state.account) return null;
      state.error = demoRegistrationValidation(input);
      state.uncertain = false;
      if (state.error) return null;

      state.submitting = true;
      try {
        const account = await registerDemo({
          organizationName: input.organizationName.trim(),
          displayName: input.displayName.trim(),
          login: input.login,
          password: input.password,
          website: input.website || "",
        });
        if (!account || typeof account.login !== "string") {
          throw new Error("Некорректный ответ сервера после регистрации");
        }
        state.account = account;
        try {
          return await login(state.account.login, input.password);
        } catch (error) {
          state.signInError = error?.message || "Не удалось выполнить вход";
          return null;
        }
      } catch (error) {
        state.error = error?.message || "Не удалось создать учётную запись";
        state.uncertain = !error?.status || error.status >= 500;
        return null;
      } finally {
        state.submitting = false;
      }
    },
  };
}
