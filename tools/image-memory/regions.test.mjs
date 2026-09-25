import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fixedRegions,
  selectOnlineRegions,
  selectYoloRegions,
} from './regions.mjs';
import { REGION_V1 } from '../image-region/detector-spec.mjs';

test('fixedRegions returns the exact versioned center and corner crops', () => {
  assert.deepEqual(fixedRegions({ width: 100, height: 200 }).map(region => region.bbox), [
    { x: 0.15, y: 0.15, width: 0.7, height: 0.7 },
    { x: 0, y: 0, width: 0.65, height: 0.65 },
    { x: 0.35, y: 0, width: 0.65, height: 0.65 },
    { x: 0, y: 0.35, width: 0.65, height: 0.65 },
    { x: 0.35, y: 0.35, width: 0.65, height: 0.65 },
  ]);
});

test('selectYoloRegions pads, clamps, filters people and tiny boxes, then deduplicates deterministically', () => {
  const detections = [
    { bbox: { x: 0.8, y: 0.8, width: 0.2, height: 0.2 }, classId: 41, className: 'cup', confidence: 0.9 },
    { bbox: { x: 0.81, y: 0.81, width: 0.19, height: 0.19 }, classId: 41, className: 'cup', confidence: 0.8 },
    { bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.8 }, classId: 0, className: 'person', confidence: 0.99 },
    { bbox: { x: 0.2, y: 0.2, width: 0.01, height: 0.01 }, classId: 39, className: 'bottle', confidence: 0.95 },
    { bbox: { x: 0.05, y: 0.1, width: 0.3, height: 0.4 }, classId: 72, className: 'refrigerator', confidence: 0.7 },
  ];
  const selected = selectYoloRegions(detections, { width: 640, height: 480 }, REGION_V1);
  assert.equal(selected.length, 2);
  assert.equal(selected[0].className, 'cup');
  assert.deepEqual(selected[0].bbox, { x: 0.77, y: 0.77, width: 0.23, height: 0.23 });
  assert.equal(selected[1].className, 'refrigerator');
  assert.match(selected[0].regionId, /^yolo:/);
});

test('online selection takes at most three detected regions and fills five total with fixed regions', () => {
  const fixed = fixedRegions({ width: 640, height: 480 });
  const yolo = Array.from({ length: 5 }, (_, index) => ({
    regionId: `yolo:${index}`,
    channel: 'yolo',
    bbox: { x: index / 10, y: 0, width: 0.1, height: 0.1 },
    classId: 41,
    className: 'cup',
    detectorConfidence: 1 - index / 10,
  }));
  const selected = selectOnlineRegions({ fixed, yolo }, REGION_V1);
  assert.equal(selected.length, 5);
  assert.deepEqual(selected.map(region => region.channel), ['yolo', 'yolo', 'yolo', 'fixed', 'fixed']);
  assert.deepEqual(selectOnlineRegions({ fixed, yolo: [] }, REGION_V1), fixed);
});
