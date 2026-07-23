function parseJsonArray(value) {
  if (Array.isArray(value)) return { value, valid: true };
  try {
    const parsed = JSON.parse(value || "[]");
    return { value: Array.isArray(parsed) ? parsed : [], valid: Array.isArray(parsed) };
  } catch {
    return { value: [], valid: false };
  }
}

export function itemMatchesGroupFilter(item, groupFilter) {
  if (!groupFilter) return true;
  const groupId = Number(groupFilter);
  const parsedGroupIds = parseJsonArray(item.group_ids);
  if (!parsedGroupIds.valid) return false;
  const groupIds = parsedGroupIds.value.map((id) => Number(id));
  // Общая запись группового расписания может храниться как без group_ids, так и
  // с идентификаторами обеих групп. В обоих случаях она видима при фильтре
  // любой затрагиваемой группы и требует явного предупреждения при обмене.
  if (!groupIds.length && !String(item.group_label || "").trim()) return true;
  return groupIds.includes(groupId);
}

export function visibleSelectableItems(
  items,
  { groupMode = false, groupFilter = "", isEmptyItem = () => false } = {},
) {
  return items.filter(
    (item) =>
      !isEmptyItem(item) &&
      (!groupMode || itemMatchesGroupFilter(item, groupFilter)),
  );
}

export function selectedIdsInScope(selectedIds, selectableItems) {
  const selected = new Set(selectedIds);
  return selectableItems
    .map((item) => item.id)
    .filter((id) => selected.has(id));
}
