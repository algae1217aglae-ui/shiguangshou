const PRIVATE_TEXT = /(?:私密照|色照|裸照|不要存|不要留|只給你看)/i;
const PRIVATE_PATH = /(?:private|intimate|nude|nsfw|sexy)/i;
const KEEP_FIELDS = [
  'role', 'text', 'en', 'files', 'images', 'tools', 'mood', 'inner', 'ts',
  'voice', 'voiceText', 'voiceEn', 'sticker', 'voiceFile', 'voiceDur',
  'thinking', 'peekFile', 'body', 'steps', 'card', 'options', 'answer',
  'answeredAt', 'dismissed', 'popup', 'quiet', 'messageId', 'conversationId', 'memorySafe',
];

function normalizedRole(role) {
  return ['user', 'owner'].includes(role) ? 'user' : 'resident';
}

export function memoryEntryAllowsImages(entry) {
  if (!entry || entry.memorySafe === false) return false;
  const media = [
    ...(Array.isArray(entry.images) ? entry.images : []),
    entry.peekFile,
    entry.voiceFile,
  ].filter(Boolean);
  return !PRIVATE_TEXT.test(String(entry.text || '')) && !media.some(value => PRIVATE_PATH.test(String(value)));
}

export function memoryEntryAllowsContext(entry) {
  return !!entry && entry.hidden !== true && entry.private !== true && entry.memorySafe !== false
    && memoryEntryAllowsImages(entry);
}

export function normalizeMemoryEntry(entry) {
  if (!entry || entry.hidden || !entry.ts || Number.isNaN(new Date(entry.ts).getTime())) return null;
  const out = { ts: new Date(entry.ts).toISOString(), role: normalizedRole(entry.role) };
  for (const key of KEEP_FIELDS) {
    if (key === 'ts' || key === 'role') continue;
    const value = entry[key];
    if (value !== undefined && value !== null && value !== '' && (value !== false || key === 'memorySafe')) out[key] = value;
  }
  if (out.text) {
    out.text = String(out.text)
      .replace(/<(心情|內心|英譯)>[\s\S]*?<\/\1>/g, '')
      .replace(/<語音>([\s\S]*?)<\/語音>/g, '$1')
      .replace(/<(附圖|檔案|貼圖)>[\s\S]*?<\/\1>/g, '')
      .trim();
  }

  const explicitlyPrivate = entry.memorySafe === false;
  if (explicitlyPrivate && !String(out.text || '').trim()) return null;
  if (!memoryEntryAllowsImages({ ...out, memorySafe: entry.memorySafe })) {
    delete out.images;
    delete out.peekFile;
  }
  const visible = String(out.text || '').trim() || out.sticker || out.voiceFile ||
    (Array.isArray(out.images) && out.images.length) || (Array.isArray(out.files) && out.files.length) || out.card || out.popup;
  return visible ? out : null;
}

