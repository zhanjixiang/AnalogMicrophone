(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };

    var el = {
        statusDot: $('status-dot'),
        statusText: $('status-text'),
        startBtn: $('start-btn'),
        btnHint: $('btn-hint'),
        btnIcon: $('btn-icon'),
        meter: $('meter'),
        device: $('device'),
        refreshDevices: $('refresh-devices'),
        pickDevice: $('pick-device'),
        deviceHint: $('device-hint'),
        target: $('target'),
        targetValue: $('target-value'),
        qr: $('qr'),
        roomCode: $('room-code'),
        senderUrl: $('sender-url'),
        statBuffer: $('stat-buffer'),
        statUnderrun: $('stat-underrun'),
        statLatency: $('stat-latency'),
        recordBtn: $('record-btn'),
        recordInfo: $('record-info'),
        diagCable: $('diag-cable'),
        diagStereo: $('diag-stereo'),
        modeHint: $('mode-hint'),
        sink: $('sink'),
        toast: $('toast'),
        secureHint: $('secure-hint'),
        secureLink: $('secure-link')
    };

    var state = {
        room: '',
        ws: null,
        running: false,
        ctx: null,
        node: null,
        analyser: null,
        sinkMode: 'none',
        attempt: 0,
        reconnectTimer: null,
        pingTimer: null,
        rafId: null,
        rtt: null,
        targetMs: 40,
        labelsReady: false,
        inputLabelsReady: false,
        hasCable: false,
        hasStereoMix: false,
        picked: null,
        recording: false,
        recordChunks: [],
        recordBytes: 0,
        recordStart: 0,
        recordTimer: null
    };

    // 20 分钟 48kHz/16bit 单声道约 115MB，超过后自动收尾，避免把浏览器内存吃满
    var RECORD_LIMIT_BYTES = 20 * 60 * 48000 * 2;

    function toast(text) {
        el.toast.textContent = text;
        el.toast.classList.add('show');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(function () { el.toast.classList.remove('show'); }, 3200);
    }

    function setStatus(text, kind) {
        el.statusText.textContent = text;
        el.statusDot.classList.remove('on', 'wait');
        if (kind) el.statusDot.classList.add(kind);
    }

    function normalizeRoom(value) {
        return String(value || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 8).toUpperCase();
    }

    function randomRoom() {
        return String(1000 + Math.floor(Math.random() * 9000));
    }

    // 同一个端口现在也支持 https，把当前地址换成 https:// 即可
    function secureReceiverUrl() {
        return 'https://' + location.hostname +
            (location.port ? ':' + location.port : '') +
            location.pathname + location.search;
    }

    function showSecureHint() {
        if (!el.secureHint || window.isSecureContext) return;
        var url = secureReceiverUrl();
        if (el.secureLink) {
            el.secureLink.href = url;
            el.secureLink.textContent = url;
        }
        el.secureHint.hidden = false;
    }

    // ------------------------------------------------------------ 电平表

    var barCount = 24;
    var bars = [];
    for (var i = 0; i < barCount; i++) {
        var span = document.createElement('span');
        el.meter.appendChild(span);
        bars.push(span);
    }

    function animateMeter() {
        if (!state.analyser) return;
        var data = new Uint8Array(state.analyser.frequencyBinCount);
        state.analyser.getByteFrequencyData(data);
        el.meter.classList.add('live');
        for (var i = 0; i < barCount; i++) {
            var idx = Math.min(data.length - 1, Math.floor((i / barCount) * data.length));
            bars[i].style.height = Math.max(4, (data[idx] / 255) * 100) + '%';
        }
        state.rafId = requestAnimationFrame(animateMeter);
    }

    function stopMeter() {
        if (state.rafId) cancelAnimationFrame(state.rafId);
        state.rafId = null;
        el.meter.classList.remove('live');
        bars.forEach(function (b) { b.style.height = '4%'; });
    }

    // ------------------------------------------------------------ 输出设备

    function withTimeout(promise, ms) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { reject(new Error('超时')); }, ms);
            promise.then(
                function (v) { clearTimeout(timer); resolve(v); },
                function (e) { clearTimeout(timer); reject(e); }
            );
        });
    }

    var STEREO_MIX_RE = /stereo\s*mix|立体声混音|what\s*u\s*hear|wave\s*out\s*mix|loopback|混音/i;
    var CABLE_RE = /cable\s*input|vb-audio|virtual\s*cable|cable\s*output/i;

    function setDiag(node, text, kind) {
        if (!node) return;
        node.textContent = text;
        node.classList.remove('good', 'bad', 'muted');
        node.classList.add(kind);
    }

    /**
     * 根据能看到的设备名给出"这台电脑适合哪种用法"的提示。
     * 注意：Chrome 在没拿到麦克风权限时不会暴露 audioinput 的名字，
     * 所以检测不到名字时只能显示"未知"，不能武断地说没有立体声混音。
     */
    function updateDiagnostics() {
        if (state.hasCable) setDiag(el.diagCable, '已安装', 'good');
        else if (state.labelsReady) setDiag(el.diagCable, '未安装', 'bad');
        else setDiag(el.diagCable, '未授权识别', 'muted');

        if (state.hasStereoMix) setDiag(el.diagStereo, '已启用', 'good');
        else if (state.inputLabelsReady) setDiag(el.diagStereo, '未找到', 'bad');
        else setDiag(el.diagStereo, '未知（需授权）', 'muted');

        if (!el.modeHint) return;

        if (state.hasCable) {
            el.modeHint.innerHTML = '<span class="good">检测到虚拟声卡</span>：在"播放到哪个设备"里选 <code>CABLE Input</code>，' +
                '然后在微信 / OBS / 音乐软件里把麦克风选成 <code>CABLE Output</code>。唱歌、乐器推荐这种方式。';
        } else if (state.hasStereoMix) {
            el.modeHint.innerHTML = '<span class="good">检测到立体声混音</span>：保持"系统默认输出"，' +
                '在会议软件里把麦克风选成 <code>立体声混音</code> 即可零安装使用。' +
                '想只录手机的声音，请直接点上面的"录制为 WAV"。';
        } else if (!state.inputLabelsReady && !state.labelsReady) {
            el.modeHint.innerHTML = '设备名还没解锁：点 <strong>刷新</strong> 并允许一次麦克风权限，才能自动识别。' +
                '没有麦克风时，可以直接点 <strong>选择…</strong> 手动指定 <code>CABLE Input</code>。';
        } else if (!state.inputLabelsReady) {
            el.modeHint.innerHTML = '看不到输入设备名（当前授权只解锁了输出设备）。' +
                '零安装用法：会议选 <code>立体声混音</code>、OBS 用「应用程序音频采集」、只录音就点上面的"录制为 WAV"。';
        } else {
            el.modeHint.innerHTML = '没有检测到虚拟声卡或立体声混音。会议 / 直播 / 录音仍可零安装使用' +
                '（见下方说明）；<strong>唱歌 / 乐器</strong>需要安装 VB-Audio Virtual Cable。';
        }
    }

    async function refreshDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        try {
            var devices = await withTimeout(navigator.mediaDevices.enumerateDevices(), 3000);
            var outputs = devices.filter(function (d) { return d.kind === 'audiooutput' && d.deviceId; });
            var inputs = devices.filter(function (d) { return d.kind === 'audioinput'; });
            var previous = el.device.value;
            el.device.innerHTML = '';

            var def = document.createElement('option');
            def.value = '';
            def.textContent = '系统默认输出';
            el.device.appendChild(def);

            var cableId = '';
            var hasCable = false;
            outputs.forEach(function (d, index) {
                var opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || ('输出设备 ' + (index + 1));
                el.device.appendChild(opt);
                if (CABLE_RE.test(d.label || '')) {
                    hasCable = true;
                    if (!cableId) cableId = d.deviceId;
                }
            });

            if (previous) el.device.value = previous;
            else if (cableId) el.device.value = cableId;

            // selectAudioOutput() 选中的设备不一定出现在 enumerateDevices 结果里，手动补进去
            if (state.picked && !outputs.some(function (d) { return d.deviceId === state.picked.deviceId; })) {
                var pickedOpt = document.createElement('option');
                pickedOpt.value = state.picked.deviceId;
                pickedOpt.textContent = state.picked.label;
                el.device.appendChild(pickedOpt);
                if (!el.device.value) el.device.value = state.picked.deviceId;
            }

            var labeled = state.labelsReady || outputs.some(function (d) { return !!d.label; });
            state.labelsReady = labeled;
            if (el.deviceHint) el.deviceHint.hidden = labeled;

            state.hasCable = hasCable;
            state.hasStereoMix = inputs.some(function (d) { return STEREO_MIX_RE.test(d.label || ''); });
            state.inputLabelsReady = inputs.some(function (d) { return !!d.label; });
            updateDiagnostics();
        } catch (e) { /* 忽略 */ }
    }

    /**
     * Chrome 在用户授权之前不会暴露任何一个具名的音频输出设备，
     * 而没有麦克风的台式机又无法通过 getUserMedia 授权。
     * selectAudioOutput() 可以在不申请麦克风权限的情况下拿到设备 ID，正好用于选 CABLE Input。
     */
    async function pickOutputDevice() {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.selectAudioOutput !== 'function') {
            toast('当前浏览器不支持直接选择输出设备，请改用 Chrome / Edge');
            return;
        }
        try {
            var device = await navigator.mediaDevices.selectAudioOutput();
            if (!device || !device.deviceId) return;
            state.picked = { deviceId: device.deviceId, label: device.label || '已选择的输出设备' };
            state.labelsReady = true;
            await refreshDevices();
            el.device.value = device.deviceId;
            if (state.running) await applySink(device.deviceId);
            toast('已选择：' + state.picked.label);
        } catch (e) {
            if (e && e.name !== 'AbortError') toast('选择输出设备失败：' + (e.message || e.name));
        }
    }

    /**
     * Chrome/Edge 在用户授权麦克风之前只会返回一个匿名的默认输出设备。
     * 为了能列出 "CABLE Input" 并指定给它，这里申请一次权限后立刻释放（不录音）。
     */
    async function unlockDeviceLabels() {
        if (state.labelsReady) return true;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
        try {
            var stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 8000);
            stream.getTracks().forEach(function (t) { t.stop(); });
            state.labelsReady = true;
            return true;
        } catch (e) {
            return false;
        }
    }

    // ------------------------------------------------------------ WebSocket

    function connectSocket() {
        if (state.ws) {
            try { state.ws.close(); } catch (e) { /* ignore */ }
        }

        var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var ws = new WebSocket(scheme + location.host);
        ws.binaryType = 'arraybuffer';
        state.ws = ws;

        ws.onopen = function () {
            if (state.ws !== ws) return;
            state.attempt = 0;
            ws.send(JSON.stringify({ type: 'hello', role: 'receiver', room: state.room }));
            startPing();
        };

        ws.onmessage = function (event) {
            if (typeof event.data === 'string') {
                handleControl(event.data);
                return;
            }
            if (!state.node || !state.running) return;

            // 录制需要保留原始数据，必须复制一份再转移给 AudioWorklet
            if (state.recording) captureChunk(event.data);

            // 直接把 ArrayBuffer 转移进 AudioWorklet，避免主线程拷贝
            state.node.port.postMessage({ type: 'pcm', pcm: event.data }, [event.data]);
        };

        ws.onclose = function () {
            if (state.ws !== ws) return;
            stopPing();
            if (state.running) {
                setStatus('连接断开，正在重连…', 'wait');
                scheduleReconnect();
            }
        };

        ws.onerror = function () {
            if (state.ws === ws && state.running) setStatus('连接异常，正在重试…', 'wait');
        };
    }

    function handleControl(text) {
        var msg;
        try { msg = JSON.parse(text); } catch (e) { return; }

        if (msg.type === 'joined') {
            if (msg.senderOnline) setStatus('手机已连接，正在接收', 'on');
            else setStatus('等待手机连接…', 'wait');
        } else if (msg.type === 'peer' && msg.role === 'sender') {
            if (msg.online) setStatus('手机已连接，正在接收', 'on');
            else setStatus('手机已断开，等待重连…', 'wait');
        } else if (msg.type === 'pong') {
            if (typeof msg.t === 'number') {
                state.rtt = Math.round(performance.now() - msg.t);
                el.statLatency.textContent = state.rtt + ' ms';
            }
        } else if (msg.type === 'error') {
            toast(msg.message || '服务器报错');
        }
    }

    function scheduleReconnect() {
        clearTimeout(state.reconnectTimer);
        var delay = DSP.backoffDelay(state.attempt++, 800, 8000);
        state.reconnectTimer = setTimeout(function () {
            if (state.running) connectSocket();
        }, delay);
    }

    function startPing() {
        stopPing();
        state.pingTimer = setInterval(function () {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
            }
        }, 5000);
    }

    function stopPing() {
        clearInterval(state.pingTimer);
        state.pingTimer = null;
    }

    // ------------------------------------------------------------ 录制 WAV

    function pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function formatDuration(ms) {
        var total = Math.max(0, Math.floor(ms / 1000));
        var m = Math.floor(total / 60);
        var s = total % 60;
        return pad2(m) + ':' + pad2(s);
    }

    function updateRecordInfo() {
        if (!state.recording) return;
        el.recordInfo.textContent = '录制中 ' + formatDuration(Date.now() - state.recordStart) +
            ' · ' + formatBytes(state.recordBytes);
    }

    /** 收到手机发来的 10ms PCM，录制时复制一份留存（原数据要转移给 Worklet） */
    function captureChunk(buffer) {
        if (!buffer || !buffer.byteLength) return;
        if (state.recordBytes + buffer.byteLength > RECORD_LIMIT_BYTES) {
            finishRecording('已达到 20 分钟上限，录音已自动保存');
            return;
        }
        try {
            state.recordChunks.push(new Int16Array(buffer.slice(0)));
            state.recordBytes += buffer.byteLength;
        } catch (e) {
            console.warn('录制缓存失败', e);
            finishRecording('内存不足，录音已提前保存');
        }
    }

    function startRecording() {
        if (!state.running) {
            toast('请先点击开始接收');
            return;
        }
        if (state.recording) return;
        state.recording = true;
        state.recordChunks = [];
        state.recordBytes = 0;
        state.recordStart = Date.now();

        el.recordBtn.textContent = '■ 停止并保存';
        el.recordBtn.classList.add('recording');
        updateRecordInfo();
        clearInterval(state.recordTimer);
        state.recordTimer = setInterval(updateRecordInfo, 500);
        toast('开始录制，停止时会自动下载 WAV');
    }

    function finishRecording(message) {
        if (!state.recording) return;
        state.recording = false;
        clearInterval(state.recordTimer);
        state.recordTimer = null;

        var chunks = state.recordChunks;
        var bytes = state.recordBytes;
        var duration = Date.now() - state.recordStart;
        state.recordChunks = [];
        state.recordBytes = 0;

        el.recordBtn.textContent = '● 录制为 WAV';
        el.recordBtn.classList.remove('recording');
        el.recordBtn.disabled = !state.running;

        if (!chunks.length) {
            el.recordInfo.textContent = '未录制';
            toast('没有收到音频数据，检查手机是否已连接');
            return;
        }

        try {
            var wav = DSP.encodeWav(chunks, 48000, 1);
            var blob = new Blob([wav], { type: 'audio/wav' });
            var url = URL.createObjectURL(blob);

            var now = new Date();
            var stamp = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
                '-' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
            var a = document.createElement('a');
            a.href = url;
            a.download = 'webmic-' + (state.room || 'rec') + '-' + stamp + '.wav';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 30000);

            el.recordInfo.textContent = '已保存 ' + formatDuration(duration) + ' · ' + formatBytes(bytes);
            toast(message || '录音已保存');
        } catch (e) {
            console.error(e);
            el.recordInfo.textContent = '保存失败';
            toast('生成 WAV 失败：' + (e && e.message ? e.message : e));
        }
    }

    // ------------------------------------------------------------ 播放

    async function routeOutput(sourceNode) {
        var deviceId = el.device.value;

        if (typeof state.ctx.setSinkId === 'function') {
            try {
                await state.ctx.setSinkId(deviceId);
                sourceNode.connect(state.ctx.destination);
                state.sinkMode = 'context';
                return;
            } catch (e) {
                console.warn('AudioContext.setSinkId 失败，改用 audio 元素', e);
            }
        }

        var dest = state.ctx.createMediaStreamDestination();
        sourceNode.connect(dest);
        el.sink.srcObject = dest.stream;
        if (typeof el.sink.setSinkId === 'function') {
            try { await el.sink.setSinkId(deviceId); } catch (e) { console.warn(e); }
        }
        try { await el.sink.play(); } catch (e) { console.warn('audio.play 失败', e); }
        state.sinkMode = 'element';
    }

    async function applySink(deviceId) {
        if (state.sinkMode === 'context') {
            await state.ctx.setSinkId(deviceId);
        } else if (state.sinkMode === 'element' && typeof el.sink.setSinkId === 'function') {
            await el.sink.setSinkId(deviceId);
        }
    }

    async function start() {
        if (!window.isSecureContext) {
            showSecureHint();
            toast('当前是 http:// 地址，浏览器不允许接收音频，请改用 ' + secureReceiverUrl());
            return;
        }

        if (!state.room) {
            toast('房间号无效');
            return;
        }

        el.startBtn.disabled = true;
        setStatus('正在启动…', 'wait');

        try {
            var Ctx = window.AudioContext || window.webkitAudioContext;

            // 设备名没解锁时，至少刷新一次列表（授权由"选择…/刷新"按钮负责）
            if (!state.labelsReady) await refreshDevices();

            var ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
            if (ctx.state === 'suspended') await ctx.resume();

            await ctx.audioWorklet.addModule('/dsp.js');
            await ctx.audioWorklet.addModule('/player-worklet.js');

            var node = new AudioWorkletNode(ctx, 'player-processor', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: { targetMs: state.targetMs }
            });

            var analyser = ctx.createAnalyser();
            analyser.fftSize = 64;
            analyser.smoothingTimeConstant = 0.8;
            node.connect(analyser);

            state.ctx = ctx;
            state.node = node;
            state.analyser = analyser;

            node.port.onmessage = function (event) {
                var data = event.data;
                if (!data || data.type !== 'stats') return;
                el.statBuffer.textContent = Math.round(data.bufferedMs) + ' ms';
                el.statUnderrun.textContent = String(data.underruns);
            };

            await routeOutput(analyser);

            state.running = true;
            connectSocket();
            animateMeter();
            updateRunningUI(true);
            setStatus('等待手机连接…', 'wait');
        } catch (err) {
            console.error(err);
            setStatus('启动失败', null);
            toast('无法启动音频输出：' + (err && err.message ? err.message : err));
            stop();
        } finally {
            el.startBtn.disabled = false;
        }
    }

    function stop() {
        state.running = false;
        if (state.recording) finishRecording('已停止接收，录音已保存');
        clearTimeout(state.reconnectTimer);
        stopPing();
        stopMeter();

        if (state.ws) {
            try {
                if (state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'bye' }));
                state.ws.close();
            } catch (e) { /* ignore */ }
            state.ws = null;
        }

        if (state.node) {
            try { state.node.disconnect(); } catch (e) { /* ignore */ }
        }
        if (state.analyser) {
            try { state.analyser.disconnect(); } catch (e) { /* ignore */ }
        }
        if (state.ctx) {
            try { state.ctx.close(); } catch (e) { /* ignore */ }
        }
        el.sink.srcObject = null;

        state.node = null;
        state.analyser = null;
        state.ctx = null;

        updateRunningUI(false);
        setStatus('已停止', null);
        el.statBuffer.textContent = '--';
        el.statLatency.textContent = '--';
    }

    function updateRunningUI(running) {
        el.startBtn.classList.toggle('live', running);
        el.btnHint.textContent = running ? '点击停止接收' : '点击开始接收手机的声音';
        el.btnIcon.innerHTML = running
            ? '<rect x="6" y="6" width="12" height="12" rx="2"></rect>'
            : '<path d="M5 3l14 9-14 9V3z"></path>';
        el.startBtn.setAttribute('aria-label', running ? '停止接收' : '开始接收');
        if (el.recordBtn) el.recordBtn.disabled = !running;
        if (!running && el.recordInfo && !state.recording) {
            // 保留"已保存 …"的结果展示，其他情况回到未录制
            if (!/^已保存/.test(el.recordInfo.textContent)) el.recordInfo.textContent = '未录制';
        }
    }

    // ------------------------------------------------------------ 房间信息与二维码

    async function initRoom() {
        var params = new URLSearchParams(location.search);
        var room = normalizeRoom(params.get('room') || localStorage.getItem('webmic.room') || '');
        if (!room) room = randomRoom();
        state.room = room;
        localStorage.setItem('webmic.room', room);
        el.roomCode.textContent = room;

        var info;
        try {
            var res = await fetch('/api/info');
            info = await res.json();
        } catch (e) {
            info = null;
        }

        var ip = location.hostname;
        if (info && Array.isArray(info.ips) && info.ips.length) {
            if (info.ips.indexOf(location.hostname) === -1) ip = info.ips[0];
        }

        var securePort = info && (info.receiverHttpsPort || info.httpsPort);
        var url;
        if (location.protocol === 'https:') {
            url = location.origin + '/mic?room=' + room;
        } else if (securePort) {
            url = 'https://' + ip + ':' + securePort + '/mic?room=' + room;
        } else {
            url = 'http://' + ip + ':' + (info ? info.httpPort : location.port) + '/mic?room=' + room;
        }

        el.senderUrl.textContent = url;
        el.qr.src = '/api/qr?text=' + encodeURIComponent(url);
    }

    // ------------------------------------------------------------ 事件

    el.startBtn.addEventListener('click', function () {
        if (state.running) stop();
        else start();
    });

    if (el.recordBtn) {
        el.recordBtn.addEventListener('click', function () {
            if (state.recording) finishRecording();
            else startRecording();
        });
    }

    el.refreshDevices.addEventListener('click', function () {
        unlockDeviceLabels()
            .then(function () { return refreshDevices(); })
            .then(function () { toast(state.labelsReady ? '设备列表已刷新' : '仍然没有拿到设备名，可以点"选择…"直接挑选'); });
    });

    el.pickDevice.addEventListener('click', pickOutputDevice);

    el.target.addEventListener('input', function () {
        state.targetMs = parseInt(el.target.value, 10) || 40;
        el.targetValue.textContent = state.targetMs + ' ms';
        if (state.node) state.node.port.postMessage({ type: 'target', ms: state.targetMs });
    });

    el.device.addEventListener('change', async function () {
        if (!state.running) return;
        try {
            await applySink(el.device.value);
            toast('已切换输出设备');
        } catch (e) {
            toast('切换输出设备失败：' + e.message);
        }
    });

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', function () { refreshDevices(); });
    }

    window.addEventListener('beforeunload', function () {
        if (state.ws) {
            try { state.ws.send(JSON.stringify({ type: 'bye' })); } catch (e) { /* ignore */ }
        }
    });

    // ------------------------------------------------------------ 初始化

    (function init() {
        state.targetMs = parseInt(el.target.value, 10) || 40;
        el.targetValue.textContent = state.targetMs + ' ms';
        if (navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === 'function') {
            el.pickDevice.hidden = false;
        }
        updateRunningUI(false);
        initRoom();
        refreshDevices();
        showSecureHint();
    })();
})();
