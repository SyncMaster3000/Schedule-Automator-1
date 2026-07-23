import test from "node:test";
import assert from "node:assert/strict";
import { lessonUtpSource, topicUtpName, uniqueUtpName } from "./utpSources.js";

test("источник импортированного занятия содержит УТП, дисциплину и файл", () => {
  const source = lessonUtpSource({
    topic_id: 10,
    discipline_name: "Тактика",
    utp_name: "Тактика 2026",
    utp_source: "Тактика 2026",
    utp_source_file: "УТП_Тактика_2026.docx",
  });

  assert.equal(source.name, "Тактика 2026");
  assert.match(source.title, /Дисциплина: Тактика/);
  assert.match(source.title, /Файл: УТП_Тактика_2026\.docx/);
});

test("занятие без темы не получает выдуманный источник", () => {
  assert.equal(
    lessonUtpSource({
      topic_id: null,
      custom_title: "Организационное мероприятие",
    }),
    null,
  );
});

test("старые темы получают безопасный fallback без изменения данных", () => {
  const legacyTopic = { id: 4, discipline_name: "" };
  assert.equal(topicUtpName(legacyTopic), "Без названия УТП");
  assert.equal(legacyTopic.utp_name, undefined);
});

test("старое имя файла с ошибочной кодировкой читается без изменения базы", () => {
  const legacyTopic = {
    id: 5,
    utp_source: "Ð£Ð¢ÐŸ_Ð¢Ð°ÐºÑ‚Ð¸ÐºÐ°_2026.docx",
  };
  assert.equal(topicUtpName(legacyTopic), "УТП Тактика 2026");
  assert.match(legacyTopic.utp_source, /^Ð/);
});

test("одинаковые названия нескольких УТП становятся различимыми", () => {
  assert.equal(
    uniqueUtpName("Тактика 2026", [
      { utp_name: "Тактика 2026" },
      { utp_name: "Тактика 2026 (2)" },
    ]),
    "Тактика 2026 (3)",
  );
});
