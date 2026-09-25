const PRIVATE_TEXT = /(?:私密照|色照|裸照|不要存|不要留|只給你看)/i;
const PRIVATE_PATH = /(?:private|intimate|nude|nsfw|sexy)/i;
const KEEP_FIELDS = [
  'text', 'images', 'messageId', 'conversationId', 'memorySafe', 'private',
];

function normalizedRole(role) {
  return ['user', 'assistant'].includes(role) ? role : null;
}

export function memoryEntryAllowsImages(entry) {
  if (!entry || entry.hidden === true || entry.private === true || entry.memorySafe === false) return false;
  const media = [
    ...(Array.isArray(entry.images) ? entry.images : []),
  ].filter(Boolean);
  return !PRIVATE_TEXT.test(String(entry.text || '')) && !media.some(value => PRIVATE_PATH.test(String(value)));
}

export function memoryEntryAllowsContext(entry) {
  return !!entry && entry.hidden !== true && entry.private !== true && entry.memorySafe !== false
    && memoryEntryAllowsImages(entry);
}

export function normalizeMemoryEntry(entry) {
  if (!entry || entry.hidden || !normalizedRole(entry.role) || !entry.ts || Number.isNaN(new Date(entry.ts).getTime())) return null;
  const out = { ts: new Date(entry.ts).toISOString(), role: normalizedRole(entry.role) };
  for (const key of KEEP_FIELDS) {
    if (key === 'ts' || key === 'role') continue;
    const value = entry[key];
    if (value !== undefined && value !== null && value !== '' && (value !== false || key === 'memorySafe')) out[key] = value;
  }
  if (out.text) {
    out.text = String(out.text).trim();
  }

  const explicitlyPrivate = entry.memorySafe === false;
  if (explicitlyPrivate && !String(out.text || '').trim()) return null;
  if (!memoryEntryAllowsImages({ ...out, memorySafe: entry.memorySafe })) {
    delete out.images;
  }
  const visible = String(out.text || '').trim() || (Array.isArray(out.images) && out.images.length);
  return visible ? out : null;
}

