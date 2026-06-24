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

直接双击 **`预览手机版.bat`**：会起一个本地静态服务器(端口 8090)，并打印本机和局域网访问地址；手机与电脑连同一个 WiFi，用手机浏览器打开打印出的 `http://<电脑IP>:8090` 即可。

> Service Worker 需要 `https` 或 `localhost`；局域网 IP 下离线/安装受限，但阅读与播放不受影响。

## 打包成 APK

双击 **`打包APK.bat`**：全自动完成 Capacitor 初始化、添加 Android 平台、**自动下载 Android SDK 与 JDK 21、把 Gradle 指向国内镜像**，最后用 Gradle 构建出 `CherryTingShu.apk`（输出在本目录）。

前置要求：**只需 Node.js**。Android SDK 与 JDK 21 由脚本自动下载安装（无需 Android Studio）。

- 首次运行会联网下载几百 MB（SDK + JDK + Gradle + 依赖），耗时较久；之后再打包很快。
- 产物 `CherryTingShu.apk` 是 debug 包，手机安装时需允许“安装未知来源应用”。
- 已实测可成功构建（约 3.9MB）。

> 注意：当前网页用到 JSZip / FontAwesome 的 CDN。要做到 APK 完全脱网可用，需先把这两个库**本地化**（可让助手代办）。

## 现状

- 已实现：导入听书包、书架、阅读器（逐句高亮 + 点句/上一句/下一句/播放暂停 + 倍速跟随包）、主题色与字号设置、明暗切换、离线外壳缓存。
- 未做：多章合并为整书、阅读进度记忆、跨设备同步、Capacitor 实机打包。
