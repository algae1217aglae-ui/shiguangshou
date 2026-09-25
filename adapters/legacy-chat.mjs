// Optional original-host conversion. The core never imports this module.
import { memoryEntryAllowsImages, normalizeMemoryEntry } from '../memory-recall.mjs';

export function adaptLegacyChatEntry(entry) {
  if (!entry) return null;
  const memorySafe = memoryEntryAllowsImages({ ...entry, images: [...(Array.isArray(entry.images) ? entry.images : []), entry.peekFile, entry.voiceFile].filter(Boolean) });
  const text = String(entry.text || '')
    .replace(/<(心情|內心|英譯)>[\s\S]*?<\/\1>/g, '')
    .replace(/<語音>([\s\S]*?)<\/語音>/g, '$1')
    .replace(/<(附圖|檔案|貼圖)>[\s\S]*?<\/\1>/g, '').trim();
  const role = ['user', 'owner'].includes(entry.role) ? 'user' : 'assistant';
  const normalized = normalizeMemoryEntry({ ...entry, role, text, memorySafe });
  if (normalized) return normalized;
  // Preserve a hidden/empty row as a boundary instead of bridging across it after conversion.
  if (!entry.ts || Number.isNaN(new Date(entry.ts).getTime())) return null;
  return { messageId: entry.messageId, conversationId: entry.conversationId, ts: new Date(entry.ts).toISOString(), role, text: '', hidden: true, memorySafe: false };
}

export function adaptLegacyBridgeOptions({ bridgeKind, ...options } = {}) {
  return { ...options, supportsImageAttachments: bridgeKind === 'codex' };
}
