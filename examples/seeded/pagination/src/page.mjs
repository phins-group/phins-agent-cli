export function page(items, index, size) {
  if (!Number.isInteger(index) || index < 0 ||
      !Number.isInteger(size) || size <= 0) {
    throw new RangeError("Invalid page or size");
  }
  const start = index * size;
  return items.slice(start, start + size - 1);
}

