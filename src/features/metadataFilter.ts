export const normalizeMetadataFilterText = (source: string): string => source.trim().toLowerCase();

type MetadataFilterToken =
  | { mode: 'contains'; text: string }
  | { mode: 'pair'; key: string; value: string };

const parseMetadataFilterTokens = (source: string): MetadataFilterToken[] =>
  normalizeMetadataFilterText(source)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const separatorIndex = token.indexOf('=');
      if (separatorIndex > 0) {
        const key = token.slice(0, separatorIndex).trim();
        const value = token.slice(separatorIndex + 1).trim();
        if (key && value) {
          return { mode: 'pair', key, value } as const;
        }
      }

      return { mode: 'contains', text: token } as const;
    });

export const matchesMetadataFilter = (
  metadata: Record<string, string>,
  filterText: string
): boolean => {
  const tokens = parseMetadataFilterTokens(filterText);
  if (tokens.length === 0) {
    return true;
  }

  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return false;
  }

  return tokens.every((token) => {
    if (token.mode === 'pair') {
      return entries.some(([key, value]) => {
        const normalizedKey = key.toLowerCase();
        const normalizedValue = String(value).toLowerCase();
        return normalizedKey.includes(token.key) && normalizedValue.includes(token.value);
      });
    }

    return entries.some(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      const normalizedValue = String(value).toLowerCase();
      return (
        normalizedKey.includes(token.text) ||
        normalizedValue.includes(token.text)
      );
    });
  });
};
