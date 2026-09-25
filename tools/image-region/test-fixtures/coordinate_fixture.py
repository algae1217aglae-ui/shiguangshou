import hashlib
import importlib.util
import json
from pathlib import Path
import sys


MODULE_PATH = Path(__file__).parents[1] / "detector-worker.py"
SPEC = importlib.util.spec_from_file_location("porch_detector_worker", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class Boxes:
    def __init__(self, xyxy):
        self.xyxy = [xyxy]
        self.cls = [41]
        self.conf = [0.99]


class Result:
    names = {41: "cup"}

    def __init__(self, xyxy):
        self.boxes = Boxes(xyxy)


class RedPixelModel:
    def predict(self, source, **_kwargs):
        points = []
        for y in range(source.height):
            for x in range(source.width):
                red, green, blue = source.getpixel((x, y))
                if red > 160 and red > green * 1.5 and red > blue * 1.5:
                    points.append((x, y))
        if not points:
            return []
        left = min(point[0] for point in points)
        top = min(point[1] for point in points)
        right = max(point[0] for point in points) + 1
        bottom = max(point[1] for point in points) + 1
        return [Result([left, top, right, bottom])]


def main():
    inbox = Path(sys.argv[1])
    relative_path = sys.argv[2]
    source = inbox / relative_path.split("/", 1)[1]
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    result = worker.detect_image(
        {"relativePath": relative_path, "expectedSha256": digest},
        inbox,
        RedPixelModel(),
        "coordinate-fixture-v1",
    )
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
