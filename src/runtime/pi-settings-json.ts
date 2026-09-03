/** Parse decoded settings.json text with the same leading UTF-8 BOM tolerance as Pi. */
export function parsePiSettingsJson(content: string): unknown {
  return JSON.parse(content.startsWith("\uFEFF") ? content.slice(1) : content) as unknown;
}
