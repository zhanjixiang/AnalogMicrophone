/**
 * 播放侧 AudioWorklet：环形缓冲 + 抖动缓冲 + 溢出/欠载处理。
 * 依赖 /dsp.js（需先于本文件 addModule）。
 */
class PlayerProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};

        this.ring = new DSP.RingBuffer(Math.round(sampleRate * 2));
        this.targetMs = Math.min(600, Math.max(10, opts.targetMs || 40));
        this.targetSamples = Math.round((sampleRate * this.targetMs) / 1000);

        this.playing = false;
        this.lastSample = 0;
        this.rampLeft = 0;
        this.rampFrom = 0;
        this.emptyBlocks = 0;

        this.underruns = 0;
        this.overruns = 0;
        this.droppedSamples = 0;
        this.blocks = 0;
        this.reportEvery = Math.max(1, Math.round(sampleRate / 128 / 4)); // 约 250ms

        this.port.onmessage = (event) => {
            const data = event.data || {};
            if (data.type === 'pcm') {
                const floats = DSP.int16ToFloat(new Int16Array(data.pcm));
                this.ring.write(floats);
            } else if (data.type === 'target') {
                this.setTarget(data.ms);
            } else if (data.type === 'reset') {
                this.ring.clear();
                this.playing = false;
                this.lastSample = 0;
                this.rampLeft = 0;
            }
        };
    }

    setTarget(ms) {
        this.targetMs = Math.min(600, Math.max(10, ms));
        this.targetSamples = Math.round((sampleRate * this.targetMs) / 1000);
        if (this.playing && this.ring.available > this.targetSamples + sampleRate * 0.5) {
            const skip = this.ring.available - this.targetSamples;
            this.ring.drop(skip);
            this.droppedSamples += skip;
            this.overruns++;
            this.rampLeft = 64;
            this.rampFrom = this.lastSample;
        }
    }

    report() {
        this.port.postMessage({
            type: 'stats',
            bufferedMs: (this.ring.available / sampleRate) * 1000,
            underruns: this.underruns,
            overruns: this.overruns,
            droppedMs: (this.droppedSamples / sampleRate) * 1000,
            playing: this.playing
        });
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        const frames = out.length;

        // 积压太多（网络抖动/手机时钟偏快）时追帧，只保留目标水位
        const highWater = this.targetSamples + Math.round(sampleRate * 0.5);
        if (this.ring.available > highWater) {
            const skip = this.ring.available - this.targetSamples;
            this.ring.drop(skip);
            this.droppedSamples += skip;
            this.overruns++;
            this.rampLeft = 64;
            this.rampFrom = this.lastSample;
        }

        if (!this.playing) {
            if (this.ring.available >= this.targetSamples) {
                this.playing = true;
                this.emptyBlocks = 0;
            } else {
                out.fill(0);
                this.blocks++;
                if (this.blocks % this.reportEvery === 0) this.report();
                return true;
            }
        }

        const got = this.ring.read(out);

        if (got < frames) {
            // 偶发抖动：只补静音，保持时基不变，避免每次都重新预充导致延迟累积
            out.fill(0, got);
            this.underruns++;
            this.emptyBlocks++;
            if (this.emptyBlocks > 20) {
                // 连续 50ms 以上没数据，才重新预充
                this.playing = false;
                this.emptyBlocks = 0;
                this.lastSample = 0;
                this.rampLeft = 0;
            }
        } else {
            this.emptyBlocks = 0;
            if (this.rampLeft > 0) {
                const total = 64;
                for (let i = 0; i < frames && this.rampLeft > 0; i++) {
                    const a = 1 - this.rampLeft / total;
                    out[i] = this.rampFrom * (1 - a) + out[i] * a;
                    this.rampLeft--;
                }
            }
            this.lastSample = out[frames - 1];
        }

        this.blocks++;
        if (this.blocks % this.reportEvery === 0) this.report();
        return true;
    }
}

registerProcessor('player-processor', PlayerProcessor);
