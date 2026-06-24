# 樱桃听书 · 手机版（PWA）

独立的手机端，只做**阅读 + 播放预生成音频**，不含任何引擎、合成、训练。数据来源是从电脑端导出的「听书包」。

## 与电脑端的关系

1. 电脑端生成好某章音频后，在「设置 - 本地预训练音频管理」点该章的 **「手机包」** 按钮，导出一个 `.tsp.zip`（内含逐句文本 + 音频 + manifest.json）。
2. 把这个包传到手机，在手机版「书架 - 导入听书包」里导入，即可离线阅读、逐句高亮、点句播放。

## 听书包格式（cherry-tingshu-pack-v1）

```
xxx.tsp.zip
├── manifest.json   { format, book, chapter, voice, speed, sentences:[...], audio:[ "audio/0.wav", null, ... ] }
└── audio/          0.wav, 1.wav, ...   （缺失的句子在 audio 数组里为 null）
```

## 本地预览（开发）

手机版是纯静态文件。任意静态服务器即可：

```bash
cd mobile
python -m http.server 8090
# 手机与电脑同一局域网，手机浏览器访问 http://<电脑IP>:8090
```

注意：Service Worker 需要 `https` 或 `localhost`；局域网 IP 下 PWA 安装/离线可能受限，正式分发请用 https 或下一步用 Capacitor 打包成 APK。

## 打包成 APK（后续）

技术栈为 PWA + Capacitor。后续步骤（占位，未来补充）：

```bash
npm i -D @capacitor/cli @capacitor/core @capacitor/android
npx cap init "樱桃听书" "com.cherry.tingshu" --web-dir=.
npx cap add android
npx cap copy
npx cap open android   # 在 Android Studio 里构建 APK
```

## 现状

- 已实现：导入听书包、书架、阅读器（逐句高亮 + 点句/上一句/下一句/播放暂停 + 倍速跟随包）、主题色与字号设置、明暗切换、离线外壳缓存。
- 未做：多章合并为整书、阅读进度记忆、跨设备同步、Capacitor 实机打包。
