export const UNNAMED_DISCIPLINE = "Без указания дисциплины";

function sectionDepth(topic) {
  const number = String(topic.utp_number || "").replace(/\.$/, "");
  if (/^\d+(?:\.\d+)*$/.test(number)) return number.split(".").length;
  if (/^[IVXLCDM]+$/i.test(number)) return 1;
  return null;
}

// Новые импорты уже содержат discipline_name. Для ранее загруженных УТП
// восстанавливаем группу по строкам-разделам: 1.3 становится дисциплиной,
// а более глубокая строка 1.3.2 остается ее внутренним разделом.
export function enrichTopicsWithDisciplines(topics) {
  let currentName = "";
  let rootDepth = null;
  return (topics || []).map((topic) => {
    const explicitName = String(topic.discipline_name || "").trim();
    if (explicitName) {
      currentName = explicitName;
    } else if (topic.is_section) {
      const depth = sectionDepth(topic);
      if (depth != null && (rootDepth == null || depth <= rootDepth)) {
        rootDepth = depth;
        currentName = String(topic.title || "").trim();
      }
    }
    return {
      ...topic,
      discipline_name: explicitName || currentName || UNNAMED_DISCIPLINE,
    };
  });
}

export function groupTopicsByDiscipline(topics) {
  const groups = [];
  for (const topic of enrichTopicsWithDisciplines(topics)) {
    const name = topic.discipline_name || UNNAMED_DISCIPLINE;
    let group = groups[groups.length - 1];
    if (!group || group.name !== name) {
      group = { key: `${groups.length}-${name}`, name, topics: [] };
      groups.push(group);
    }
    group.topics.push(topic);
  }
  return groups;
}
