export function postgresIntegerArray(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("Ожидался массив целых идентификаторов");
  }

  const integers = values.map((value) => {
    const integer = Number(value);
    if (!Number.isSafeInteger(integer)) {
      throw new TypeError("Идентификатор должен быть безопасным целым числом");
    }
    return integer;
  });

  return `{${integers.join(",")}}`;
}
