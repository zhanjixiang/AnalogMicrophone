/**
 * 共享 DSP 工具：浏览器（普通页面 + AudioWorklet）与 Node（测试 / 服务端）通用。
 * 用 UMD 包装，不依赖构建工具。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.DSP = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** Float32 [-1,1] -> Int16LE 定点数 */
    function floatToInt16(input, out) {
        const len = input.length;
        const dst = out && out.length >= len ? out : new Int16Array(len);
        for (let i = 0; i < len; i++) {
            let s = input[i];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            dst[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return dst;
    }

    /** Int16LE -> Float32 [-1,1] */
    function int16ToFloat(input, out) {
        const len = input.length;
        const dst = out && out.length >= len ? out : new Float32Array(len);
        for (let i = 0; i < len; i++) dst[i] = input[i] / 0x8000;
        return dst;
    }

    /** 多声道 -> 单声道（直接相加后取平均） */
    function downmix(channels) {
        const channelCount = channels.length;
        if (channelCount === 0) return new Float32Array(0);
        const frames = channels[0].length;
        const out = new Float32Array(frames);
        if (channelCount === 1) {
            out.set(channels[0]);
            return out;
        }
        for (let c = 0; c < channelCount; c++) {
            const ch = channels[c];
            for (let i = 0; i < frames; i++) out[i] += ch[i];
        }
        const scale = 1 / channelCount;
        for (let i = 0; i < frames; i++) out[i] *= scale;
        return out;
    }

    /** 峰值电平，用于界面电平表 */
    function peak(input) {
        let max = 0;
        for (let i = 0; i < input.length; i++) {
            const v = input[i] < 0 ? -input[i] : input[i];
            if (v > max) max = v;
        }
        return max;
    }

    /**
     * 流式线性插值重采样器，跨数据块保留相位与上一块最后一个样本。
     * 线性插值对语音/唱歌足够，且计算量极小。
     */
    function Resampler(fromRate, toRate) {
        this.ratio = fromRate / toRate;
        this.pos = 0;
        this.prev = 0;
    }

    Resampler.prototype.process = function (input) {
        const n = input.length;
        if (n === 0) return new Float32Array(0);

        const maxOut = Math.ceil(n / this.ratio) + 2;
        const out = new Float32Array(maxOut);
        let outLen = 0;
        let pos = this.pos;
        const prev = this.prev;

        while (pos < n - 1 && outLen < maxOut) {
            const i0 = Math.floor(pos);
            const frac = pos - i0;
            const s0 = i0 < 0 ? prev : input[i0];
            const s1 = i0 + 1 < 0 ? prev : input[i0 + 1];
            out[outLen++] = s0 + (s1 - s0) * frac;
            pos += this.ratio;
        }

        this.prev = input[n - 1];
        this.pos = pos - n;

        return out.subarray(0, outLen);
    };

    Resampler.prototype.reset = function () {
        this.pos = 0;
        this.prev = 0;
    };

    /**
     * 定长环形缓冲。满时丢弃最旧数据（接收端追帧场景，比直接覆盖新数据安全）。
     */
    function RingBuffer(capacity) {
        this.capacity = Math.max(1, capacity | 0);
        this.buf = new Float32Array(this.capacity);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.count = 0;
    }

    Object.defineProperty(RingBuffer.prototype, 'available', {
        get: function () { return this.count; }
    });

    Object.defineProperty(RingBuffer.prototype, 'free', {
        get: function () { return this.capacity - this.count; }
    });

    /** 写入数据，返回因溢出被丢弃的旧样本数 */
    RingBuffer.prototype.write = function (input) {
        const len = input.length;
        if (len === 0) return 0;

        let dropped = 0;
        if (len >= this.capacity) {
            // 只保留最后 capacity 个样本
            dropped = this.count + (len - this.capacity);
            const offset = len - this.capacity;
            for (let i = 0; i < this.capacity; i++) this.buf[i] = input[offset + i];
            this.readIndex = 0;
            this.writeIndex = 0;
            this.count = this.capacity;
            return dropped;
        }

        if (this.count + len > this.capacity) {
            dropped = this.count + len - this.capacity;
            this.readIndex = (this.readIndex + dropped) % this.capacity;
            this.count -= dropped;
        }

        const cap = this.capacity;
        const first = Math.min(len, cap - this.writeIndex);
        this.buf.set(input.subarray(0, first), this.writeIndex);
        if (first < len) this.buf.set(input.subarray(first), 0);
        this.writeIndex = (this.writeIndex + len) % cap;
        this.count += len;
        return dropped;
    };

    /**
     * 读取固定长度。数据不足时返回实际长度（调用方自行补静音），不阻塞。
     */
    RingBuffer.prototype.read = function (out) {
        const len = Math.min(out.length, this.count);
        if (len === 0) return 0;
        const cap = this.capacity;
        const first = Math.min(len, cap - this.readIndex);
        out.set(this.buf.subarray(this.readIndex, this.readIndex + first), 0);
        if (first < len) {
            // 注意：这里用 len-first 个元素从 0 开始拷贝
            out.set(this.buf.subarray(0, len - first), first);
        }
        this.readIndex = (this.readIndex + len) % cap;
        this.count -= len;
        return len;
    };

    /** 丢弃最旧的 n 个样本，返回实际丢弃数 */
    RingBuffer.prototype.drop = function (n) {
        const removed = Math.min(n, this.count);
        this.readIndex = (this.readIndex + removed) % this.capacity;
        this.count -= removed;
        return removed;
    };

    RingBuffer.prototype.clear = function () {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.count = 0;
    };

    /** 指数退避重连间隔：attempt 从 0 开始 */
    function backoffDelay(attempt, minMs, maxMs) {
        const min = minMs || 1000;
        const max = maxMs || 10000;
        const base = Math.min(max, min * Math.pow(1.7, attempt));
        return Math.round(base * (0.85 + Math.random() * 0.3));
    }

    /**
     * 把若干段 Int16 PCM 拼成 16bit 单声道/多声道 WAV。
     * chunks 里每个元素是 Int16Array，按顺序首尾相接。
     */
    function encodeWav(chunks, sampleRate, channels) {
        const ch = channels || 1;
        const rate = sampleRate || 48000;

        let frames = 0;
        for (let i = 0; i < chunks.length; i++) frames += chunks[i].length;

        const dataBytes = frames * 2;
        const buffer = new ArrayBuffer(44 + dataBytes);
        const view = new DataView(buffer);

        function writeString(offset, text) {
            for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
        }

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataBytes, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);              // PCM
        view.setUint16(22, ch, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * ch * 2, true);  // byte rate
        view.setUint16(32, ch * 2, true);         // block align
        view.setUint16(34, 16, true);             // bits per sample
        writeString(36, 'data');
        view.setUint32(40, dataBytes, true);

        // 主流浏览器都跑在小端平台，直接按 Int16 写入即可
        const out = new Int16Array(buffer, 44);
        let offset = 0;
        for (let i = 0; i < chunks.length; i++) {
            out.set(chunks[i], offset);
            offset += chunks[i].length;
        }

        return buffer;
    }

    return {
        floatToInt16: floatToInt16,
        int16ToFloat: int16ToFloat,
        downmix: downmix,
        peak: peak,
        Resampler: Resampler,
        RingBuffer: RingBuffer,
        backoffDelay: backoffDelay,
        encodeWav: encodeWav
    };
});
