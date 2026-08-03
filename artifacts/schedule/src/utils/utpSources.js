export const UNNAMED_UTP = "Без названия УТП";
export const UNNAMED_DISCIPLINE = "Без указания дисциплины";

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalized(value) {
  return clean(value).toLocaleLowerCase("ru-RU");
}

const WINDOWS_1252_BYTES = new Map(
  Array.from("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ", (character, index) => [
    character,
    [
      0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c,
      0x8e, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b,
      0x9c, 0x9e, 0x9f,
    ][index],
  ]),
);

function repairSourceEncoding(value) {
  const text = String(value || "");
  if (!/[ÐÑ]/u.test(text)) return text;

  const bytes = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code <= 255 ? code : WINDOWS_1252_BYTES.get(character);
  });
  if (bytes.some((byte) => byte == null)) return text;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
    return decoded || text;
  } catch {
    return text;
  }
}

export function humanizeUtpFileName(value) {
  const fileName = repairSourceEncoding(value).split(/[\\/]/).pop() || "";
  return clean(fileName.replace(/\.docx$/i, "").replace(/_+/g, " "));
}

function usefulDisciplineName(value) {
  const discipline = clean(value);
  if ([UNNAMED_DISCIPLINE, "Без названия дисциплины"].includes(discipline)) {
    return "";
  }
  return discipline;
}

export function topicUtpName(topic) {
  return (
    clean(topic?.utp_name) ||
    humanizeUtpFileName(topic?.utp_source) ||
    humanizeUtpFileName(topic?.utp_source_file) ||
    usefulDisciplineName(topic?.discipline_name) ||
    UNNAMED_UTP
  );
}

export function uniqueUtpName(preferredName, existingTopics = []) {
  const baseName = clean(preferredName) || UNNAMED_UTP;
  const usedNames = new Set(
    existingTopics.map((topic) => normalized(topicUtpName(topic))),
  );
  if (!usedNames.has(normalized(baseName))) return baseName;

  let suffix = 2;
  while (usedNames.has(normalized(`${baseName} (${suffix})`))) suffix += 1;
  return `${baseName} (${suffix})`;
}

export function lessonUtpSource(item) {
  if (!item?.topic_id) return null;

  const name = topicUtpName(item);
  const discipline = clean(item.discipline_name) || UNNAMED_DISCIPLINE;
  const fileName = clean(item.utp_source_file);
  const details = [`УТП: ${name}`, `Дисциплина: ${discipline}`];
  if (fileName) details.push(`Файл: ${fileName}`);

  return {
    name,
    discipline,
    fileName: fileName || null,
    title: details.join("\n"),
  };
}
