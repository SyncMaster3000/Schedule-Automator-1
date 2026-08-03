import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULE_CATEGORIES,
  UNSECTIONED_FOLDER_KEY,
  scheduleDescriptionTemplate,
  scheduleFolderKey,
} from "./scheduleCategories.js";

test("категории используют точные шаблоны описания", () => {
  assert.deepEqual(SCHEDULE_CATEGORIES, [
    "Переподготовка",
    "Повышение квалификации",
    "Обучающие курсы",
  ]);
  assert.equal(
    scheduleDescriptionTemplate("Переподготовка"),
    "учебных занятий по образовательной программе переподготовки руководящих работников и специалистов по специальности",
  );
  assert.equal(
    scheduleDescriptionTemplate("Повышение квалификации"),
    "учебных занятий по образовательной программе повышения квалификации",
  );
  assert.equal(
    scheduleDescriptionTemplate("Обучающие курсы"),
    "учебных занятий по образовательной программе обучающих курсов",
  );
});

test("неизвестная категория остаётся без раздела", () => {
  assert.equal(scheduleFolderKey(null), UNSECTIONED_FOLDER_KEY);
  assert.equal(scheduleFolderKey("Неизвестно"), UNSECTIONED_FOLDER_KEY);
  assert.equal(
    scheduleFolderKey("Переподготовка"),
    "Переподготовка",
  );
});
