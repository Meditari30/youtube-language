# YouTube Language Translator

一个 Chrome Manifest V3 扩展，用 Google Translate 翻译 YouTube 当前显示的字幕，并在播放器上方叠加双语字幕。

## 功能

- 翻译 YouTube 页面当前字幕文本。
- 默认翻译为简体中文。
- 可在弹窗里切换目标语言、源语言、字幕位置、字号和是否显示原字幕。
- 使用后台 service worker 请求 `translate.googleapis.com`，并带有简单内存缓存。
- 版本 1.1.0 改为读取 YouTube 字幕轨道并按播放时间渲染，不再监听整个页面 DOM，显著降低 YouTube 卡顿风险。
- 支持每个视频的字幕翻译缓存、后台翻译去重、并发限制和前置预翻译。

## 安装

1. 打开 Chrome，进入 `chrome://extensions/`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录：`C:\Users\Admin\youtube-language-translator-extension`。
5. 打开 YouTube 视频，先开启 YouTube 自带字幕，再点击扩展图标调整设置。

## 更新已安装的本地扩展

1. 打开 `chrome://extensions/`。
2. 找到 `YouTube Language Translator`。
3. 点击扩展卡片上的刷新按钮。
4. 刷新 YouTube 页面。

## 注意

- 插件依赖 YouTube 页面已经显示字幕；它不会识别视频音频。
- 当前使用 Google Translate 的公开接口，适合个人使用和演示。如果要发布到商店或高频使用，建议改为 Google Cloud Translation API 并加入 API Key 配置。
- YouTube 页面结构可能变动；如果字幕选择器失效，需要更新 `content.js` 中的 `.ytp-caption-segment` 读取逻辑。
