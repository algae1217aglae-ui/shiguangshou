import sharp from 'sharp';

const FIXED_BOXES = Object.freeze([
  Object.freeze({ x: 0.15, y: 0.15, width: 0.7, height: 0.7 }),
  Object.freeze({ x: 0, y: 0, width: 0.65, height: 0.65 }),
  Object.freeze({ x: 0.35, y: 0, width: 0.65, height: 0.65 }),
  Object.freeze({ x: 0, y: 0.35, width: 0.65, height: 0.65 }),
  Object.freeze({ x: 0.35, y: 0.35, width: 0.65, height: 0.65 }),
]);

function regionError(message, code = 'IMAGE_REGION_INVALID') {
  return Object.assign(new Error(message), { code, retryable: false });
}

const round = value => Math.round(value * 1e6) / 1e6;

function validBox(box) {
  return box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]))
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= 1 + 1e-9 && box.y + box.height <= 1 + 1e-9;
}

function stableId(channel, box, suffix = '') {
  return `${channel}:${[box.x, box.y, box.width, box.height].map(value => round(value).toFixed(6)).join(':')}${suffix}`;
}

function descriptor(channel, bbox, extra = {}) {
  const normalized = Object.fromEntries(Object.entries(bbox).map(([key, value]) => [key, round(value)]));
  return {
    regionId: stableId(channel, normalized, channel === 'yolo' ? `:${extra.classId}` : ''),
    channel,
    bbox: normalized,
    classId: extra.classId ?? null,
    className: extra.className ?? null,
    detectorConfidence: extra.detectorConfidence ?? null,
  };
}

export function fixedRegions(decoded) {
  if (!Number.isFinite(decoded?.width) || !Number.isFinite(decoded?.height) || decoded.width < 1 || decoded.height < 1) throw regionError('decoded dimensions are invalid');
  return FIXED_BOXES.map(box => descriptor('fixed', box));
}

function paddedBox(box, fraction) {
  const px = box.width * fraction;
  const py = box.height * fraction;
  const x = Math.max(0, box.x - px);
  const y = Math.max(0, box.y - py);
  return {
    x,
    y,
    width: Math.min(1, box.x + box.width + px) - x,
    height: Math.min(1, box.y + box.height + py) - y,
  };
}

function intersectionOverUnion(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

export function selectYoloRegions(detections, decoded, config) {
  const rows = [];
  for (const detection of Array.isArray(detections) ? detections : []) {
    if (detection?.classId === 0 || !validBox(detection?.bbox) || !Number.isFinite(detection?.confidence)) continue;
    const bbox = paddedBox(detection.bbox, config.paddingFraction);
    if (bbox.width * decoded.width < config.minimumCropPixels || bbox.height * decoded.height < config.minimumCropPixels) continue;
    rows.push(descriptor('yolo', bbox, {
      classId: Number.isInteger(detection.classId) ? detection.classId : null,
      className: String(detection.className || '').slice(0, 80) || null,
      detectorConfidence: detection.confidence,
    }));
  }
  rows.sort((left, right) => (right.detectorConfidence - left.detectorConfidence)
    || ((left.classId ?? 999) - (right.classId ?? 999))
    || left.regionId.localeCompare(right.regionId));
  const selected = [];
  for (const row of rows) {
    if (selected.some(kept => intersectionOverUnion(kept.bbox, row.bbox) >= config.detectorPostNmsIou)) continue;
    selected.push(row);
    if (selected.length >= config.detectorMaxRegions) break;
  }
  return selected;
}

export function selectOnlineRegions({ fixed = [], yolo = [] } = {}, config) {
  const selected = yolo.slice(0, config.onlineMaxYoloRegionsPerQuery);
  for (const region of fixed) {
    if (selected.length >= config.onlineMaxRegionsPerQuery) break;
    selected.push(region);
  }
  return selected;
}

function pixelBox(box, decoded) {
  if (!validBox(box)) throw regionError('region bbox is invalid');
  const left = Math.max(0, Math.floor(box.x * decoded.width));
  const top = Math.max(0, Math.floor(box.y * decoded.height));
  const right = Math.min(decoded.width, Math.ceil((box.x + box.width) * decoded.width));
  const bottom = Math.min(decoded.height, Math.ceil((box.y + box.height) * decoded.height));
  if (right <= left || bottom <= top) throw regionError('region bbox is empty');
  return { left, top, width: right - left, height: bottom - top };
}

export async function cropRegionBlobs(decoded, descriptors) {
  if (!decoded?.data || !Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || !Number.isInteger(decoded.channels)) throw regionError('decoded image is invalid');
  if (!Array.isArray(descriptors) || descriptors.length > 5) throw regionError('at most five region crops are allowed');
  const base = sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: decoded.channels } });
  try {
    return await Promise.all(descriptors.map(async item => {
      const crop = base.clone().extract(pixelBox(item.bbox, decoded)).png();
      try { return await crop.toBuffer(); } finally { crop.destroy(); }
    }));
  } finally { base.destroy(); }
}
