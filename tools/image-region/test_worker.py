import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

from PIL import Image


MODULE_PATH = Path(__file__).with_name("detector-worker.py")
SPEC = importlib.util.spec_from_file_location("porch_detector_worker", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class DetectorWorkerValidationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="porch-detector-worker-")
        self.inbox = Path(self.temp.name) / "inbox"
        self.inbox.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_auto_orient_sha_and_first_frame_share_the_sharp_coordinate_space(self):
        image_path = self.inbox / "oriented.jpg"
        image = Image.new("RGB", (20, 10), "black")
        for x in range(0, 5):
            for y in range(0, 5):
                image.putpixel((x, y), (255, 0, 0))
        exif = Image.Exif()
        exif[274] = 6
        image.save(image_path, exif=exif)

        oriented = worker.load_oriented_image("inbox/oriented.jpg", self.inbox, sha256(image_path))
        self.assertEqual(oriented.size, (10, 20))
        self.assertEqual(oriented.getpixel((7, 2))[0] > 180, True)
        with self.assertRaisesRegex(worker.WorkerError, "changed") as caught:
            worker.load_oriented_image("inbox/oriented.jpg", self.inbox, "0" * 64)
        self.assertEqual(caught.exception.code, "IMAGE_CHANGED_DURING_READ")

        gif_path = self.inbox / "animated.gif"
        red = Image.new("RGB", (8, 6), "red")
        blue = Image.new("RGB", (8, 6), "blue")
        red.save(gif_path, save_all=True, append_images=[blue], duration=100, loop=0)
        first = worker.load_oriented_image("inbox/animated.gif", self.inbox, sha256(gif_path))
        self.assertGreater(first.getpixel((2, 2))[0], 240)
        self.assertLess(first.getpixel((2, 2))[2], 10)

    def test_real_direct_child_format_size_pixel_and_symlink_boundaries(self):
        ok = self.inbox / "ok.png"
        Image.new("RGB", (16, 12), "white").save(ok)
        self.assertEqual(worker.load_oriented_image("inbox/ok.png", self.inbox, sha256(ok)).size, (16, 12))
        for bad in ("../ok.png", "inbox/sub/ok.png", str(ok)):
            with self.assertRaises(worker.WorkerError):
                worker.load_oriented_image(bad, self.inbox, sha256(ok))
        unsupported = self.inbox / "plain.jpg"
        unsupported.write_text("not image", encoding="utf-8")
        with self.assertRaises(worker.WorkerError) as caught:
            worker.load_oriented_image("inbox/plain.jpg", self.inbox, sha256(unsupported))
        self.assertEqual(caught.exception.code, "IMAGE_DECODE_FAILED")
        oversized = self.inbox / "oversized.jpg"
        with oversized.open("wb") as handle:
            handle.truncate(20 * 1024 * 1024 + 1)
        with self.assertRaises(worker.WorkerError) as caught:
            worker.load_oriented_image("inbox/oversized.jpg", self.inbox, sha256(oversized))
        self.assertEqual(caught.exception.code, "IMAGE_FILE_TOO_LARGE")
        link = self.inbox / "link.png"
        try:
            os.symlink(ok, link)
        except OSError:
            pass
        else:
            with self.assertRaises(worker.WorkerError) as caught:
                worker.load_oriented_image("inbox/link.png", self.inbox, sha256(ok))
            self.assertEqual(caught.exception.code, "IMAGE_LINK_REJECTED")

    def test_detection_output_is_normalized_bounded_and_json_safe(self):
        image_path = self.inbox / "scene.png"
        Image.new("RGB", (100, 50), "white").save(image_path)

        class Boxes:
            xyxy = [[10, 5, 50, 25]]
            cls = [41]
            conf = [0.75]

        class Result:
            boxes = Boxes()
            names = {41: "cup"}

        class Model:
            def predict(self, **kwargs):
                self.kwargs = kwargs
                return [Result()]

        model = Model()
        result = worker.detect_image({
            "relativePath": "inbox/scene.png", "expectedSha256": sha256(image_path)
        }, self.inbox, model, "detector-v1")
        self.assertEqual(result["detections"][0]["bbox"], {"x": 0.1, "y": 0.1, "width": 0.4, "height": 0.4})
        self.assertEqual(result["rawDetectionCount"], 1)
        self.assertEqual(result["orientedWidth"], 100)
        self.assertEqual(model.kwargs["save"], False)
        json.dumps(result, allow_nan=False)

    def test_runtime_environment_is_offline_and_tool_owned_before_model_import(self):
        runtime = Path(self.temp.name) / "runtime"
        worker.configure_runtime_environment(runtime)
        self.assertEqual(os.environ["YOLO_AUTOINSTALL"], "false")
        self.assertEqual(os.environ["YOLO_OFFLINE"], "true")
        self.assertEqual(Path(os.environ["YOLO_CONFIG_DIR"]).is_relative_to(runtime), True)
        self.assertEqual(Path(os.environ["MPLCONFIGDIR"]).is_relative_to(runtime), True)
        self.assertEqual(Path(os.environ["TORCH_HOME"]).is_relative_to(runtime), True)

    def test_model_warmup_runs_a_real_in_memory_forward_before_ready(self):
        class Model:
            def __init__(self):
                self.calls = []

            def predict(self, **kwargs):
                self.calls.append(kwargs)
                return []

        model = Model()
        worker.warm_model(model)
        self.assertEqual(len(model.calls), 1)
        call = model.calls[0]
        self.assertIsInstance(call["source"], Image.Image)
        self.assertEqual(call["source"].size, (640, 640))
        self.assertEqual(call["device"], "cpu")
        self.assertEqual(call["save"], False)
        self.assertEqual(call["verbose"], False)
        self.assertEqual(call["imgsz"], 640)

    def test_network_guard_blocks_and_counts_socket_connections(self):
        class FakeBaseSocket:
            def connect(self, address):
                return address

            def connect_ex(self, address):
                return address

            def sendto(self, data, address):
                return (data, address)

        class FakeSocketModule:
            socket = FakeBaseSocket

            @staticmethod
            def create_connection(address, *args, **kwargs):
                return address

            @staticmethod
            def getaddrinfo(host, port, *args, **kwargs):
                return (host, port)

        audit = worker.install_network_guard(FakeSocketModule)
        guarded = FakeSocketModule.socket()
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            guarded.connect(("example.com", 443))
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            guarded.connect_ex(("example.com", 443))
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            FakeSocketModule.create_connection(("example.com", 443))
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            guarded.sendto(b"hello", ("example.com", 53))
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            FakeSocketModule.getaddrinfo("example.com", 443)
        self.assertEqual(audit["attempts"], 5)


if __name__ == "__main__":
    unittest.main()
