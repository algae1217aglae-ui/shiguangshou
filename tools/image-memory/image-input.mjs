import { createImageMemoryRoots, decodeImageMemoryImage, resolveImageMemoryImage } from './source-paths.mjs';

// 第一、二階段的相容層。第三階段 production 呼叫端傳完整 roots；舊測試與尚未遷移的
// helper 仍可只給 inboxDir，安全規則由同一支有限根 adapter 執行。
export async function resolveInboxImage(relativePath, inboxDir) {
  return resolveImageMemoryImage(relativePath, createImageMemoryRoots({ inboxDir }));
}

export async function decodeImage(relativePath, inboxDir) {
  return decodeImageMemoryImage(relativePath, createImageMemoryRoots({ inboxDir }));
}

export { createImageMemoryRoots, decodeImageMemoryImage, resolveImageMemoryImage } from './source-paths.mjs';
