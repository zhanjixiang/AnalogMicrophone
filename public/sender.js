(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };

    var el = {
        statusDot: $('status-dot'),
        statusText: $('status-text'),
        startBtn: $('start-btn'),
        btnHint: $('btn-hint'),
        btnIcon: $('btn-icon'),
        room: $('room'),
        muteBtn: $('mute-btn'),
        micDevice: $('mic-device'),
        meter: $('meter'),
        statTime: $('stat-time'),
        statSent: $('stat-sent'),
        statRtt: $('stat-rtt'),
        secureHint: $('secure-hint'),
        toast: $('toast')
    };

    var CHUNK_FRAMES = 480; // 10ms @ 48kHz
    var state = {
        room: '',
        ws: null,
        running: false,
        muted: false,
        deviceId: '',
        stream: null,
        ctx: null,
        node: null,
        analyser: null,
        attempt: 0,
        reconnectTimer: null,
        pingTimer: null,
        tickTimer: null,
        rafId: null,
        sentFrames: 0,
        startedAt: 0,
        rtt: null,
        wakeLock: null
    };

    // ------------------------------------------------------------ 小工具

    var toastTimer = null;
    function toast(text) {
        el.toast.textContent = text;
        el.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 3200);
    }

    function setStatus(text, kind) {
        el.statusText.textContent = text;
        el.statusDot.classList.remove('on', 'wait');
        if (kind) el.statusDot.classList.add(kind);
    }

    function formatDuration(ms) {
        var total = Math.floor(ms / 1000);
        var m = Math.floor(total / 60);
        var s = total % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function normalizeRoom(value) {
        return String(value || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 8).toUpperCase();
    }

    function wsUrl() {
        var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
        return scheme + location.host;
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
            var v = data[idx] / 255;
            bars[i].style.height = Math.max(4, v * 100) + '%';
        }
        state.rafId = requestAnimationFrame(animateMeter);
    }

    function stopMeter() {
        if (state.rafId) cancelAnimationFrame(state.rafId);
        state.rafId = null;
        el.meter.classList.remove('live');
        bars.forEach(function (b) { b.style.height = '4%'; });
    }

    // ------------------------------------------------------------ WebSocket

    function connectSocket() {
        if (state.ws) {
            try { state.ws.close(); } catch (e) { /* ignore */ }
        }

        var ws = new WebSocket(wsUrl());
        ws.binaryType = 'arraybuffer';
        state.ws = ws;

        ws.onopen = function () {
            if (state.ws !== ws) return;
            state.attempt = 0;
            ws.send(JSON.stringify({ type: 'hello', role: 'sender', room: state.room }));
            setStatus('已连接，正在发送', 'on');
            startPing();
        };

        ws.onmessage = function (event) {
            if (typeof event.data !== 'string') return;
            var msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }
            if (msg.type === 'pong') {
                if (typeof msg.t === 'number') {
                    state.rtt = Math.round(performance.now() - msg.t);
                    el.statRtt.textContent = state.rtt + ' ms';
                }
            } else if (msg.type === 'error') {
                toast(msg.message || '服务器报错');
            }
        };

        ws.onclose = function () {
            if (state.ws !== ws) return;
            stopPing();
            el.statRtt.textContent = '--';
            if (state.running) {
                setStatus('连接断开，正在重连…', 'wait');
                scheduleReconnect();
            }
        };

        ws.onerror = function () {
            if (state.ws === ws && state.running) setStatus('连接异常，正在重试…', 'wait');
        };
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

    // ------------------------------------------------------------ 音频采集

    function micConstraints() {
        var audio = {
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: { ideal: 48000 }
        };
        if (state.deviceId) audio.deviceId = { exact: state.deviceId };
        return { audio: audio, video: false };
    }

    async function openMic() {
        try {
            var stream = await navigator.mediaDevices.getUserMedia(micConstraints());
            state.stream = stream;
            return stream;
        } catch (err) {
            // 之前选过的外接麦克风可能已经拔掉，回退到默认设备再试一次
            if (state.deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
                state.deviceId = '';
                localStorage.removeItem('webmic.mic');
                el.micDevice.value = '';
                var fallback = await navigator.mediaDevices.getUserMedia(micConstraints());
                state.stream = fallback;
                return fallback;
            }
            throw err;
        }
    }

    async function buildAudioGraph(stream) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        var ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
        if (ctx.state === 'suspended') await ctx.resume();

        await ctx.audioWorklet.addModule('/dsp.js');
        await ctx.audioWorklet.addModule('/capture-worklet.js');

        var source = ctx.createMediaStreamSource(stream);
        var node = new AudioWorkletNode(ctx, 'capture-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { targetRate: 48000, chunkFrames: CHUNK_FRAMES }
        });

        // 节点必须连到 destination 才会被音频图持续拉取；用 0 增益避免本机回声
        var silent = ctx.createGain();
        silent.gain.value = 0;
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.75;

        source.connect(node);
        node.connect(silent);
        source.connect(analyser);
        analyser.connect(silent);
        silent.connect(ctx.destination);

        node.port.onmessage = function (event) {
            var data = event.data;
            if (!data || data.type !== 'pcm') return;
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(data.pcm.buffer);
                state.sentFrames++;
            }
        };

        state.ctx = ctx;
        state.node = node;
        state.analyser = analyser;
    }

    function teardownAudio() {
        stopMeter();
        if (state.node) {
            try { state.node.port.postMessage({ type: 'reset' }); } catch (e) { /* ignore */ }
            try { state.node.disconnect(); } catch (e) { /* ignore */ }
        }
        if (state.analyser) {
            try { state.analyser.disconnect(); } catch (e) { /* ignore */ }
        }
        if (state.stream) {
            state.stream.getTracks().forEach(function (t) { t.stop(); });
        }
        if (state.ctx) {
            try { state.ctx.close(); } catch (e) { /* ignore */ }
        }
        state.node = null;
        state.analyser = null;
        state.stream = null;
        state.ctx = null;
    }

    async function refreshMicList() {
        try {
            var devices = await navigator.mediaDevices.enumerateDevices();
            var inputs = devices.filter(function (d) { return d.kind === 'audioinput'; });
            var current = el.micDevice.value;
            el.micDevice.innerHTML = '<option value="">手机默认麦克风</option>';
            inputs.forEach(function (d, index) {
                var opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || ('麦克风 ' + (index + 1));
                el.micDevice.appendChild(opt);
            });
            if (current) el.micDevice.value = current;
        } catch (e) { /* 忽略 */ }
    }

    // ------------------------------------------------------------ 启停

    async function start() {
        var room = normalizeRoom(el.room.value);
        if (!room) {
            toast('请先填写电脑上显示的 4 位房间号');
            el.room.focus();
            return;
        }
        if (!window.isSecureContext) {
            el.secureHint.hidden = false;
            toast('请用 https:// 地址打开本页才能使用麦克风');
            return;
        }

        state.room = room;
        localStorage.setItem('webmic.room', room);
        el.startBtn.disabled = true;
        setStatus('正在获取麦克风…', 'wait');

        try {
            var stream = await openMic();
            await buildAudioGraph(stream);

            state.running = true;
            state.muted = false;
            state.sentFrames = 0;
            state.startedAt = Date.now();

            connectSocket();
            animateMeter();
            startTick();
            requestWakeLock();
            updateRunningUI(true);
        } catch (err) {
            teardownAudio();
            state.running = false;
            updateRunningUI(false);

            var name = err && err.name;
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                setStatus('麦克风被拒绝', null);
                toast('麦克风权限被拒绝，请在浏览器设置里允许后刷新页面');
            } else if (name === 'NotFoundError') {
                setStatus('没有可用麦克风', null);
                toast('没有找到麦克风设备');
            } else if (name === 'NotReadableError') {
                setStatus('麦克风被占用', null);
                toast('麦克风被其他应用占用，请关闭后重试');
            } else {
                setStatus('启动失败', null);
                toast('启动失败：' + (err && err.message ? err.message : err));
            }
        } finally {
            el.startBtn.disabled = false;
        }
    }

    function stop() {
        state.running = false;
        clearTimeout(state.reconnectTimer);
        stopPing();
        stopTick();
        stopMeter();
        releaseWakeLock();

        if (state.ws) {
            try {
                if (state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({ type: 'bye' }));
                }
                state.ws.close();
            } catch (e) { /* ignore */ }
            state.ws = null;
        }

        teardownAudio();
        updateRunningUI(false);
        setStatus('已停止', null);
    }

    function updateRunningUI(running) {
        el.startBtn.classList.toggle('live', running);
        el.btnHint.textContent = running ? '点击停止发送' : '点击开启麦克风';
        el.btnIcon.innerHTML = running
            ? '<rect x="6" y="6" width="12" height="12" rx="2"></rect>'
            : '<path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"></path><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"></path>';
        el.muteBtn.hidden = !running;
        el.muteBtn.textContent = state.muted ? '取消静音' : '静音';
        if (!running) {
            el.statTime.textContent = '00:00';
            el.statSent.textContent = '0';
            el.statRtt.textContent = '--';
        }
        el.startBtn.setAttribute('aria-label', running ? '停止发送' : '开始发送');
    }

    function startTick() {
        stopTick();
        state.tickTimer = setInterval(function () {
            el.statTime.textContent = formatDuration(Date.now() - state.startedAt);
            el.statSent.textContent = String(state.sentFrames);
        }, 500);
    }

    function stopTick() {
        clearInterval(state.tickTimer);
        state.tickTimer = null;
    }

    // ------------------------------------------------------------ 唤醒锁

    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                state.wakeLock = await navigator.wakeLock.request('screen');
            }
        } catch (e) { /* 不支持就算了 */ }
    }

    function releaseWakeLock() {
        if (state.wakeLock) {
            try { state.wakeLock.release(); } catch (e) { /* ignore */ }
            state.wakeLock = null;
        }
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && state.running && !state.wakeLock) {
            requestWakeLock();
        }
    });

    // ------------------------------------------------------------ 事件绑定

    el.startBtn.addEventListener('click', function () {
        if (state.running) stop();
        else start();
    });

    el.muteBtn.addEventListener('click', function () {
        if (!state.node) return;
        state.muted = !state.muted;
        state.node.port.postMessage({ type: 'mute', value: state.muted });
        el.muteBtn.textContent = state.muted ? '取消静音' : '静音';
        el.meter.classList.toggle('muted', state.muted);
    });

    el.room.addEventListener('input', function () {
        el.room.value = normalizeRoom(el.room.value);
    });

    el.micDevice.addEventListener('change', async function () {
        state.deviceId = el.micDevice.value;
        localStorage.setItem('webmic.mic', state.deviceId);
        if (!state.running) return;
        try {
            teardownAudio();
            var stream = await openMic();
            await buildAudioGraph(stream);
            animateMeter();
            toast('已切换麦克风');
        } catch (e) {
            toast('切换麦克风失败，正在停止');
            stop();
        }
    });

    // ------------------------------------------------------------ 初始化

    (function init() {
        var params = new URLSearchParams(location.search);
        var room = normalizeRoom(params.get('room') || localStorage.getItem('webmic.room') || '');
        if (room) {
            el.room.value = room;
            localStorage.setItem('webmic.room', room);
        }

        state.deviceId = localStorage.getItem('webmic.mic') || '';
        if (state.deviceId) el.micDevice.value = state.deviceId;

        if (!window.isSecureContext) {
            el.secureHint.hidden = false;
            el.startBtn.disabled = true;
        }

        updateRunningUI(false);
        refreshMicList();

        // 被系统挂起后恢复音频上下文
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && state.ctx && state.ctx.state === 'suspended') {
                state.ctx.resume();
            }
        });

        window.addEventListener('beforeunload', function () {
            if (state.ws) {
                try { state.ws.send(JSON.stringify({ type: 'bye' })); } catch (e) { /* ignore */ }
            }
        });
    })();
})();
