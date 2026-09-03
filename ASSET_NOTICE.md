# Asset and trademark notice

## Whale-chan artwork

The repository owner supplied and authorized the Whale-chan artwork used by this project for inclusion in this release. Runtime derivatives include `assets/whale-chan.png` and the image data embedded in `lib/client.js`. Windows companion runtime assets are maintained under `windows/assets/`.

The MIT license in `LICENSE` applies to project code. It does **not** grant rights to third-party names, logos, or trademarks beyond what applicable law permits. If you redistribute or modify the character artwork, ensure that you have the necessary rights for your use.

## Live2D Cubism Core

`vendor/live2dcubismcore.min.js` is downloaded from the official Live2D Cubism SDK for Web hosting endpoint and copied to `lib/live2dcubismcore.min.js` during the build. Its own header identifies it as **Redistributable Code** under the [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html). Copyright © Live2D Inc.; the repository MIT license does not replace or modify that agreement.

Pinned source: `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`
SHA-256: `25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f`

The runtime is served locally by the DSH plugin, so importing a model does not require a Cubism CDN connection. Users remain responsible for having the rights to any Live2D models, textures, motions, expressions, and audio they import. No third-party sample model is bundled in the release.

`pixi-live2d-display`, `pixi.js`, and `fflate` are third-party dependencies and retain their respective licenses and notices.

## Trademarks and affiliation

DeepSeek and related names or marks belong to their respective owners. This community project is not affiliated with, sponsored by, or endorsed by DeepSeek. References are descriptive and identify interoperability with DeepSeek Harness.

If you believe an asset is attributed incorrectly or infringes your rights, open an issue at https://github.com/ali8772/dsh-web-gui/issues.
