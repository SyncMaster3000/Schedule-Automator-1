function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

export function itemMatchesGroupFilter(item, groupFilter) {
  if (!groupFilter) return true;
  const groupId = Number(groupFilter);
  return safeJsonArray(item.group_ids)
    .map((id) => Number(id))
    .includes(groupId);
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
