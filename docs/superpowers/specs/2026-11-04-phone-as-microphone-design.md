# 手机当麦克风（WebMic）设计说明

日期：2026-11-04
状态：已确认，进入实现

## 1. 目标

把手机变成 Windows 系统里真实可选的麦克风设备。电脑（或电视）没有麦克风时，
微信 / Zoom / OBS / 音乐软件可以在输入设备里选到它。

主要场景：**唱歌 / 乐器**，因此以低延迟为第一优先级。

## 2. 关键约束与结论

| 约束 | 结论 |
|---|---|
| 浏览器 `getUserMedia` 只在安全上下文可用 | 手机端必须走 HTTPS，首次启动自动生成自签名证书 |
| 唱歌需要低延迟 | 不使用 MediaRecorder/Opus（延迟 150ms+），改用 AudioWorklet 直采 PCM |
| Windows 要有"麦克风"设备 | 安装 VB-Audio Virtual Cable，程序把声音写入 `CABLE Input`，应用里选 `CABLE Output` |
| 电视上跑不了 Node | 接收端做成网页，电视浏览器打开即可 |
| 手机端不能依赖 CDN | 去掉 Tailwind / FontAwesome，改手写 CSS |

## 3. 架构

```
手机 sender.html
  getUserMedia(关闭 AEC/降噪/AGC)
  → AudioWorklet 采集 + 降混单声道 + 重采样到 48kHz
  → Int16LE，每 10ms 一帧
        │  wss
        ▼
server.js（PC）
  静态托管 + WebSocket 中继（房间制，零解码、零缓冲）
        │  ws
        ▼
receiver.html（PC / 电视）
  AudioWorklet 环形缓冲 + 抖动缓冲(默认 40ms)
  → AudioContext.setSinkId("CABLE Input")
  → 应用里选 "CABLE Output" 作为麦克风
```

## 4. 组件

| 文件 | 职责 |
|---|---|
| `server.js` | HTTP/HTTPS 静态托管、WS 中继、房间管理、二维码接口 |
| `lib/certs.js` | 首次启动生成含全部内网 IP 的自签名证书，IP 变化时自动重签 |
| `lib/static.js` | 静态文件服务与 MIME |
| `lib/dsp.js` | 重采样、Int16 转换、环形缓冲（浏览器与 Node 共用，可单测） |
| `public/sender.html` + `sender.js` | 手机端：连接、采集、电平表、断线重连 |
| `public/receiver.html` + `receiver.js` | 接收端：设备选择、播放、抖动缓冲配置、二维码 |
| `public/capture-worklet.js` | 采集侧 AudioWorklet |
| `public/player-worklet.js` | 播放侧 AudioWorklet（环形缓冲、欠载/溢出处理） |
| `test/dsp.test.js` | `node --test` 单元测试 |

## 5. 协议

控制帧（JSON 文本）：

- `{type:"hello", role:"sender"|"receiver", room:"1234"}`
- `{type:"joined", room, senderOnline}`（服务端 → 接收端）
- `{type:"peer", role, online}`（在线状态变化）
- `{type:"ping"}` / `{type:"pong"}`

音频帧：二进制 `Int16LE`，48kHz，单声道，每帧 10ms（480 样本 = 960 字节）。
服务端不解析音频内容，收到即转发给同房间所有接收端。

房间：接收端生成 4 位房间号并展示二维码 `https://<内网IP>:8443/mic?room=xxxx`。
同房间只允许一个发送端，后加入者顶掉先加入者。

## 6. 延迟策略

- 采集：AudioWorklet，128 样本回调，不经过 MediaRecorder。
- 网络：局域网内 10ms 分片，服务端零缓冲。
- 播放：环形缓冲预调度，目标水位默认 40ms（20–120ms 可调）。
- 漂移：水位超过目标 +500ms 时丢弃多余样本并做 64 样本交叉淡化；
  欠载时补静音并重新预充，记录欠载次数供界面显示。
- 手机端关闭 `echoCancellation` / `noiseSuppression` / `autoGainControl`，
  唱歌时建议戴耳机，避免啸叫。

## 7. 错误处理

- 端口被占用：启动失败并给出明确提示和换端口参数。
- 手机非 HTTPS：页面检测 `isSecureContext` 直接提示改用 https 地址。
- 麦克风被拒绝：显示原因与修复步骤（权限、证书信任）。
- 断线：两端指数退避自动重连（1s → 10s），采集不中断。
- 接收端无 `AudioContext.setSinkId`：降级为
  `MediaStreamDestination → <audio>.setSinkId()`。
- 接收端在非安全上下文（`http://` + 非 localhost）打开：页面顶部给出黄色提示和
  `https://同一端口` 链接，点开始时不进入音频初始化，避免只报 `addModule` 的 TypeError。
- 页面进入后台：请求 Wake Lock 防止息屏/节流；不支持时给出提示。

## 8. 端口

- `8080` HTTP + HTTPS **同一端口双协议**：`http://localhost:8080` 免证书，给本机用；
  `https://<内网IP>:8080` 给第二台电脑 / 电视 / 手机发送页用
  （浏览器只在安全上下文里暴露 AudioWorklet 与设备选择）。
  实现见 `lib/dual.js`：读取连接首字节，`0x16` 交给 https server，其余交给 http server。
- `8443` HTTPS：兼容旧地址，仍然单独监听；连不上也不影响 8080。

## 9. 验收

1. `node --test` 全部通过（重采样比例、Int16 转换、环形缓冲溢出/欠载）。
2. `npm start` 后 `http://localhost:8080` 可打开接收页，`https://localhost:8443/mic` 可打开发送页。
3. 模拟客户端脚本：发送二进制帧，接收端能原样收到，房间隔离正确。
4. 手动验收：装好 VB-Cable → 接收页选 `CABLE Input` → OBS/录音机选 `CABLE Output` → 手机说话有电平、无爆音。

## 10. 不做的事（YAGNI）

- 公网穿透 / 账号体系 / 多发送端混音。
- 自研虚拟声卡驱动（Windows 内核签名，成本与风险都不合理）。
- 原生 PortAudio 播放后端（浏览器方案已满足延迟要求）。

## 11. 实现补充（开发中确认）

- **输出设备权限**：Chrome 在用户授权前只会返回一个匿名的默认输出设备，
  没有麦克风的台式机又无法通过 `getUserMedia` 授权。
  因此接收页优先使用 `navigator.mediaDevices.selectAudioOutput()`（Chrome/Edge 120+，
  无需麦克风权限）直接挑选 `CABLE Input`；不支持的浏览器回退为"授权一次麦克风后刷新列表"。
- **播放抖动处理**：水面低于目标水位时只补静音、不立即重建队列，
  连续 50ms 无数据才重新预充，避免每次抖动都累计一次 40ms 延迟。
- **接收端 binaryType**：必须显式设为 `arraybuffer`，否则 WebSocket 给的是 Blob，
  无法零拷贝转移进 AudioWorklet。
- **证书**：以自签名 CA 形式生成（`basicConstraints: cA=true`），
  便于 iPhone 在"证书信任设置"里开启完全信任；并提供 `/cert` 下载。

