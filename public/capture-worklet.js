/**
 * 采集侧 AudioWorklet：多声道 -> 单声道 -> 重采样到 48kHz -> Int16，每 10ms 发一块。
 * 依赖 /dsp.js（需先于本文件 addModule）。
 */
class CaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.targetRate = opts.targetRate || 48000;
        this.chunkFrames = opts.chunkFrames || 480;
        this.resampler = new DSP.Resampler(sampleRate, this.targetRate);
        this.acc = new Float32Array(this.chunkFrames * 8);
        this.accLen = 0;
        this.muted = false;

        this.port.onmessage = (event) => {
            const data = event.data || {};
            if (data.type === 'mute') {
                this.muted = !!data.value;
            } else if (data.type === 'reset') {
                this.resampler.reset();
                this.accLen = 0;
            }
        };
    }

    flushChunk() {
        if (this.accLen < this.chunkFrames) return;

        const chunk = this.acc.subarray(0, this.chunkFrames);
        if (this.muted) chunk.fill(0);

        const pcm = DSP.floatToInt16(chunk);
        this.port.postMessage({ type: 'pcm', pcm: pcm }, [pcm.buffer]);

        // 把剩余数据前移
        this.acc.copyWithin(0, this.chunkFrames, this.accLen);
        this.accLen -= this.chunkFrames;
    }

    process(inputs) {
        const input = inputs[0];
        const frames = input && input.length ? input[0].length : 128;

        let mono;
        if (input && input.length) {
            mono = DSP.downmix(input);
        } else {
            mono = new Float32Array(frames);
        }

        const resampled = this.resampler.process(mono);

        let offset = 0;
        while (offset < resampled.length) {
            const space = this.acc.length - this.accLen;
            const take = Math.min(space, resampled.length - offset);
            this.acc.set(resampled.subarray(offset, offset + take), this.accLen);
            this.accLen += take;
            offset += take;
            this.flushChunk();
        }

        // 有 1 个输出通道但保持静音，只是为了确保节点被音频图持续拉取
        return true;
    }
}

registerProcessor('capture-processor', CaptureProcessor);
