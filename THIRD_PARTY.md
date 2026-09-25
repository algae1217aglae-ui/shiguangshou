# 第三方程式與模型

拾光獸 (Shiguangshou) 自有程式以 AGPL-3.0-only 發布。以下依賴各保留上游授權，本專案不重新授權它們。原始碼包不含 node_modules、Python 環境、模型權重或使用者資料；安裝時需保留第三方套件隨附的 LICENSE/NOTICE。

| 元件 | 本版使用版本 | 上游授權／來源 |
|---|---|---|
| Transformers.js | 4.3.0 | Apache-2.0，https://github.com/huggingface/transformers.js |
| sharp | 0.35.4 | Apache-2.0，https://github.com/lovell/sharp |
| ONNX Runtime Node | 1.30.0 | MIT，https://github.com/microsoft/onnxruntime |
| protobufjs | 7.6.6 | BSD-3-Clause，https://github.com/protobufjs/protobuf.js |
| Ultralytics | 8.4.161 | AGPL-3.0，https://github.com/ultralytics/ultralytics |
| YOLO26n | assets v8.4.0 | Ultralytics 模型授權：https://www.ultralytics.com/license |
| PyTorch／Torchvision | 2.14.0／0.29.0 | 各套件隨附 BSD 類授權及第三方通知：https://github.com/pytorch/pytorch 、https://github.com/pytorch/vision |
| CLIP／Xenova ONNX 轉換 | model-manifest.json 中固定 revision | 原 CLIP：https://github.com/openai/CLIP/blob/main/LICENSE（MIT）；轉換模型卡：https://huggingface.co/Xenova/clip-vit-base-patch32 |

Node 的完整依賴版本、完整性雜湊與套件授權欄位在 package-lock.json。sharp 所帶 libvips 及其他原生元件有自己的第三方通知；若另行打包二進位檔或容器，需一併保留並履行這些授權。

YOLO 準備器保存上游 LICENSE，並將解析出的 Python 套件 wheels 與雜湊鎖在使用者本機 runtime。這不是把套件或模型改成 拾光獸 (Shiguangshou) 的授權。具體固定 SHA、URL 和版本見 tools/image-region/detector-spec.mjs。

不要將「AGPL 可商用」解讀成可以省略對應原始碼義務，也不要把使用者照片、聊天或金鑰當成需要公開的程式碼。
