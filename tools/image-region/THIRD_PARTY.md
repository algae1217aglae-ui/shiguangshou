# Third-party detector assets

This optional local detector pins the following upstream artifacts:

- Ultralytics `8.4.161`, upstream repository and license: https://github.com/ultralytics/ultralytics
- PyTorch `2.14.0`: https://pypi.org/project/torch/2.14.0/
- Torchvision `0.29.0`: https://pypi.org/project/torchvision/0.29.0/
- YOLO26n weights from Ultralytics assets tag `v8.4.0`: https://github.com/ultralytics/assets/releases/tag/v8.4.0

The upstream Ultralytics `LICENSE` is saved into the ignored local runtime during preparation. Photo Recall is distributed under AGPL-3.0-only; upstream packages and weights retain their own licenses. No runtime, wheels, or model weights are bundled. See ../../THIRD_PARTY.md and ../../LICENSE for the distribution boundaries and notices. The runtime manifest does not record or substitute for a user's license acceptance.
