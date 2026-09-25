import argparse
from contextlib import redirect_stdout
from io import BytesIO
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys


def install_network_guard(socket_module=None):
    if socket_module is None:
        import socket as socket_module
    audit = {"attempts": 0}
    base_socket = socket_module.socket

    def deny(*_args, **_kwargs):
        audit["attempts"] += 1
        raise RuntimeError("detector network access is disabled")

    class GuardedSocket(base_socket):
        def connect(self, address):
            return deny(address)

        def connect_ex(self, address):
            return deny(address)

        def sendto(self, data, address):
            return deny(data, address)

    socket_module.socket = GuardedSocket
    socket_module.create_connection = deny
    socket_module.getaddrinfo = deny
    socket_module.gethostbyname = deny
    socket_module.gethostbyname_ex = deny
    socket_module.gethostbyaddr = deny
    return audit


def configure_runtime_environment(runtime_dir):
    runtime = Path(runtime_dir).resolve(strict=False)
    values = {
        "PORCH_DETECTOR_RUNTIME": runtime,
        "YOLO_CONFIG_DIR": runtime / "config" / "ultralytics",
        "MPLCONFIGDIR": runtime / "cache" / "matplotlib",
        "TORCH_HOME": runtime / "cache" / "torch",
        "XDG_CACHE_HOME": runtime / "cache",
        "HF_HOME": runtime / "cache" / "huggingface",
        "TRANSFORMERS_CACHE": runtime / "cache" / "huggingface" / "transformers",
    }
    for key, path in values.items():
        os.environ[key] = str(path)
        if key != "PORCH_DETECTOR_RUNTIME":
            path.mkdir(parents=True, exist_ok=True)
    os.environ["YOLO_AUTOINSTALL"] = "false"
    os.environ["YOLO_OFFLINE"] = "true"
    os.environ["PYTHONNOUSERSITE"] = "1"


if os.environ.get("PORCH_DETECTOR_RUNTIME"):
    configure_runtime_environment(os.environ["PORCH_DETECTOR_RUNTIME"])

NETWORK_AUDIT = {"attempts": 0}
if os.environ.get("PORCH_DETECTOR_NETWORK_DISABLED") == "1":
    NETWORK_AUDIT = install_network_guard()

from PIL import Image, ImageOps, UnidentifiedImageError


MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40 * 1000 * 1000
MAX_LINE_BYTES = 1024 * 1024
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP", "GIF"}


class WorkerError(Exception):
    def __init__(self, message, code="DETECTOR_UNAVAILABLE", retryable=True):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _root_map(roots):
    if isinstance(roots, (str, Path)):
        return {"inbox": Path(roots)}
    return {str(key): Path(value) for key, value in dict(roots or {}).items() if value}


def _resolve_direct_child(relative_path, roots):
    value = str(relative_path or "").replace("\\", "/")
    match = re.fullmatch(r"(inbox|life-photos|gallery)/[^/:]+", value, re.IGNORECASE)
    if not match or ".." in value:
        raise WorkerError("image path must name one direct allowed-root child", "IMAGE_PATH_INVALID", False)
    root_name = match.group(1).lower()
    root = _root_map(roots).get(root_name)
    if root is None:
        raise WorkerError("image root is unavailable", "IMAGE_ROOT_UNAVAILABLE", False)
    path = root / value.split("/", 1)[1]
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise WorkerError("image format is not supported", "IMAGE_FORMAT_UNSUPPORTED", False)
    try:
        link_stat = path.lstat()
    except FileNotFoundError as error:
        raise WorkerError("image does not exist", "IMAGE_NOT_FOUND", False) from error
    is_reparse = bool(getattr(link_stat, "st_file_attributes", 0) & 0x400)
    if path.is_symlink() or is_reparse or not path.is_file():
        raise WorkerError("image link is not allowed", "IMAGE_LINK_REJECTED", False)
    inbox_real = root.resolve(strict=True)
    target_real = path.resolve(strict=True)
    if target_real.parent != inbox_real:
        raise WorkerError("image resolves outside inbox", "IMAGE_PATH_INVALID", False)
    if link_stat.st_size > MAX_FILE_BYTES:
        raise WorkerError("image exceeds 20 MiB", "IMAGE_FILE_TOO_LARGE", False)
    return target_real, link_stat


def load_oriented_image(relative_path, roots, expected_sha256):
    if not re.fullmatch(r"[0-9a-fA-F]{64}", str(expected_sha256 or "")):
        raise WorkerError("expected image SHA is invalid", "PROTOCOL_INVALID_REQUEST", False)
    path, before = _resolve_direct_child(relative_path, roots)
    try:
        data = path.read_bytes()
    except OSError as error:
        raise WorkerError("image cannot be read", "IMAGE_READ_FAILED") from error
    if len(data) > MAX_FILE_BYTES:
        raise WorkerError("image exceeds 20 MiB", "IMAGE_FILE_TOO_LARGE", False)
    if len(data) != before.st_size:
        raise WorkerError("image changed while it was being read", "IMAGE_CHANGED_DURING_READ")
    digest = hashlib.sha256(data).hexdigest()
    if digest.lower() != str(expected_sha256).lower():
        raise WorkerError("image changed while it was being read", "IMAGE_CHANGED_DURING_READ")
    try:
        with Image.open(BytesIO(data)) as source:
            if source.format not in SUPPORTED_FORMATS:
                raise WorkerError("image format is not supported", "IMAGE_FORMAT_UNSUPPORTED", False)
            source.seek(0)
            width, height = source.size
            if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
                raise WorkerError("image exceeds 40 megapixels", "IMAGE_PIXEL_LIMIT", False)
            oriented = ImageOps.exif_transpose(source).convert("RGB").copy()
    except WorkerError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise WorkerError("image could not be decoded", "IMAGE_DECODE_FAILED", False) from error
    if oriented.width * oriented.height > MAX_PIXELS:
        raise WorkerError("image exceeds 40 megapixels", "IMAGE_PIXEL_LIMIT", False)
    after = path.stat()
    if after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns:
        raise WorkerError("image changed while it was being read", "IMAGE_CHANGED_DURING_READ")
    return oriented


def _to_list(value):
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "tolist"):
        value = value.tolist()
    return value


def _scalar(value):
    value = _to_list(value)
    while isinstance(value, (list, tuple)) and len(value) == 1:
        value = value[0]
    return value


def detect_image(request, roots, model, detector_version):
    image = load_oriented_image(request.get("relativePath"), roots, request.get("expectedSha256"))
    with redirect_stdout(sys.stderr):
        results = model.predict(source=image, device="cpu", save=False, verbose=False, imgsz=640, conf=0.25, iou=0.70, max_det=20)
    first = results[0] if results else None
    boxes = getattr(first, "boxes", None)
    xyxy = _to_list(getattr(boxes, "xyxy", [])) or []
    classes = _to_list(getattr(boxes, "cls", [])) or []
    confidences = _to_list(getattr(boxes, "conf", [])) or []
    names = getattr(first, "names", {}) or {}
    detections = []
    for coordinates, class_value, confidence_value in list(zip(xyxy, classes, confidences))[:20]:
        coordinates = _to_list(coordinates)
        if not isinstance(coordinates, (list, tuple)) or len(coordinates) != 4:
            raise WorkerError("detector returned malformed coordinates", "DETECTOR_PROTOCOL_ERROR")
        x1, y1, x2, y2 = [float(item) for item in coordinates]
        class_id = int(_scalar(class_value))
        confidence = float(_scalar(confidence_value))
        values = (x1, y1, x2, y2, confidence)
        if not all(math.isfinite(item) for item in values) or x2 <= x1 or y2 <= y1:
            raise WorkerError("detector returned non-finite coordinates", "DETECTOR_PROTOCOL_ERROR")
        x1 = max(0.0, min(float(image.width), x1))
        y1 = max(0.0, min(float(image.height), y1))
        x2 = max(x1, min(float(image.width), x2))
        y2 = max(y1, min(float(image.height), y2))
        class_name = str(names.get(class_id, class_id))[:80]
        detections.append({
            "bbox": {
                "x": x1 / image.width,
                "y": y1 / image.height,
                "width": (x2 - x1) / image.width,
                "height": (y2 - y1) / image.height,
            },
            "classId": class_id,
            "className": class_name,
            "confidence": confidence,
        })
    return {
        "detections": detections,
        "rawDetectionCount": len(xyxy),
        "orientedWidth": image.width,
        "orientedHeight": image.height,
        "detectorVersion": detector_version,
        "networkAttemptCount": NETWORK_AUDIT["attempts"],
    }


def warm_model(model):
    with Image.new("RGB", (640, 640), (127, 127, 127)) as image:
        with redirect_stdout(sys.stderr):
            model.predict(source=image, device="cpu", save=False, verbose=False, imgsz=640, conf=0.25, iou=0.70, max_det=20)


def _public_error(error):
    message = re.sub(r"[A-Za-z]:\\[^\s]+|/[\w./-]+", "[path]", str(error))[:200]
    return {
        "code": getattr(error, "code", "DETECTOR_UNAVAILABLE"),
        "message": message or "detector failed",
        "retryable": bool(getattr(error, "retryable", True)),
    }


def run_cli():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--inbox", required=True)
    parser.add_argument("--life-photos", default="")
    parser.add_argument("--gallery", default="")
    parser.add_argument("--weight", required=True)
    parser.add_argument("--detector-version", required=True)
    parser.add_argument("--runtime", required=True)
    args, _ = parser.parse_known_args()
    roots = {"inbox": Path(args.inbox), "life-photos": Path(args.life_photos) if args.life_photos else None, "gallery": Path(args.gallery) if args.gallery else None}
    configure_runtime_environment(args.runtime)
    with redirect_stdout(sys.stderr):
        from ultralytics import YOLO, settings
        settings.update({"sync": False})
        model = YOLO(str(Path(args.weight).resolve(strict=True)))
        warm_model(model)
    for raw in sys.stdin.buffer:
        if len(raw) > MAX_LINE_BYTES:
            response = {"id": None, "ok": False, "error": {"code": "PROTOCOL_LINE_TOO_LARGE", "message": "protocol line exceeds one MiB", "retryable": False}}
            print(json.dumps(response, allow_nan=False), flush=True)
            continue
        request = None
        try:
            request = json.loads(raw.decode("utf-8"))
            if request.get("id") is None or request.get("op") not in {"detect", "stats", "shutdown"}:
                raise WorkerError("invalid detector request", "PROTOCOL_INVALID_REQUEST", False)
            if request["op"] == "stats":
                result = {"loaded": True, "detectorVersion": args.detector_version, "networkAttemptCount": NETWORK_AUDIT["attempts"]}
            elif request["op"] == "shutdown":
                result = {"shuttingDown": True}
            else:
                result = detect_image(request, roots, model, args.detector_version)
            print(json.dumps({"id": request["id"], "ok": True, "result": result}, allow_nan=False), flush=True)
            if request["op"] == "shutdown":
                return
        except Exception as error:
            print(json.dumps({"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": _public_error(error)}, allow_nan=False), flush=True)


if __name__ == "__main__":
    run_cli()
