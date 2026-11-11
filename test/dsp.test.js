'use strict';

const test = require('node:test');
const assert = require('node:assert');
const DSP = require('../lib/dsp');

test('floatToInt16 会裁剪到 [-1,1] 并正确缩放', () => {
    const out = DSP.floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    assert.deepStrictEqual(Array.from(out), [0, 32767, -32768, 32767, -32768, 16383]);
});

test('int16ToFloat 与 floatToInt16 互转误差很小', () => {
    const src = new Float32Array([0.1, -0.25, 0.75, -0.999]);
    const back = DSP.int16ToFloat(DSP.floatToInt16(src));
    for (let i = 0; i < src.length; i++) {
        assert.ok(Math.abs(back[i] - src[i]) < 1 / 16000, 'sample ' + i);
    }
});

test('downmix 多声道取平均', () => {
    const left = new Float32Array([1, -1, 0.5]);
    const right = new Float32Array([0, 1, 0.5]);
    const mono = DSP.downmix([left, right]);
    assert.deepStrictEqual(Array.from(mono), [0.5, 0, 0.5]);
});

test('downmix 单声道原样返回', () => {
    const mono = DSP.downmix([new Float32Array([0.2, -0.3])]);
    assert.ok(Math.abs(mono[0] - 0.2) < 1e-6);
    assert.ok(Math.abs(mono[1] + 0.3) < 1e-6);
});

test('peak 返回最大绝对值', () => {
    assert.ok(Math.abs(DSP.peak(new Float32Array([0.1, -0.8, 0.3])) - 0.8) < 1e-6);
});

test('Resampler 44100 -> 48000 输出样本数符合比例', () => {
    const total = 44100;
    const input = new Float32Array(total);
    const resampler = new DSP.Resampler(44100, 48000);

    let produced = 0;
    const block = 128;
    for (let offset = 0; offset < total; offset += block) {
        const slice = input.subarray(offset, Math.min(total, offset + block));
        produced += resampler.process(slice).length;
    }

    const expected = (total * 48000) / 44100;
    assert.ok(Math.abs(produced - expected) <= block, `produced=${produced} expected≈${expected}`);
});

test('Resampler 同采样率时几乎原样输出', () => {
    const resampler = new DSP.Resampler(48000, 48000);
    const input = new Float32Array(128);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((i / 128) * Math.PI * 2);
    const out = resampler.process(input);
    assert.strictEqual(out.length, 127);
    for (let i = 0; i < out.length; i++) {
        assert.ok(Math.abs(out[i] - input[i]) < 1e-6);
    }
});

test('Resampler 降采样 48000 -> 16000 约为三分之一', () => {
    const resampler = new DSP.Resampler(48000, 16000);
    let produced = 0;
    const block = 128;
    for (let i = 0; i < 48000; i += block) {
        const chunk = new Float32Array(block).fill(0.25);
        produced += resampler.process(chunk).length;
    }
    assert.ok(Math.abs(produced - 16000) <= block, 'produced=' + produced);
});

test('RingBuffer 基本读写顺序正确', () => {
    const rb = new DSP.RingBuffer(8);
    rb.write(new Float32Array([1, 2, 3]));
    assert.strictEqual(rb.available, 3);

    const out = new Float32Array(2);
    assert.strictEqual(rb.read(out), 2);
    assert.deepStrictEqual(Array.from(out), [1, 2]);
    assert.strictEqual(rb.available, 1);
});

test('RingBuffer 环形回绕后数据顺序正确', () => {
    const rb = new DSP.RingBuffer(5);
    rb.write(new Float32Array([1, 2, 3]));
    const first = new Float32Array(2);
    rb.read(first);
    rb.write(new Float32Array([4, 5, 6]));

    const out = new Float32Array(4);
    assert.strictEqual(rb.read(out), 4);
    assert.deepStrictEqual(Array.from(out), [3, 4, 5, 6]);
});

test('RingBuffer 满时丢弃最旧数据并返回丢弃数', () => {
    const rb = new DSP.RingBuffer(4);
    rb.write(new Float32Array([1, 2, 3, 4]));
    const dropped = rb.write(new Float32Array([5, 6]));
    assert.strictEqual(dropped, 2);
    assert.strictEqual(rb.available, 4);

    const out = new Float32Array(4);
    rb.read(out);
    assert.deepStrictEqual(Array.from(out), [3, 4, 5, 6]);
});

test('RingBuffer 写入超过容量时只保留尾部', () => {
    const rb = new DSP.RingBuffer(3);
    const dropped = rb.write(new Float32Array([1, 2, 3, 4, 5]));
    assert.strictEqual(dropped, 2);
    const out = new Float32Array(3);
    rb.read(out);
    assert.deepStrictEqual(Array.from(out), [3, 4, 5]);
});

test('RingBuffer 数据不足时 read 返回实际长度', () => {
    const rb = new DSP.RingBuffer(8);
    rb.write(new Float32Array([1, 2]));
    const out = new Float32Array(4);
    assert.strictEqual(rb.read(out), 2);
    assert.strictEqual(rb.available, 0);
});

test('RingBuffer drop 只丢弃最旧样本', () => {
    const rb = new DSP.RingBuffer(8);
    rb.write(new Float32Array([1, 2, 3, 4]));
    assert.strictEqual(rb.drop(2), 2);
    const out = new Float32Array(2);
    rb.read(out);
    assert.deepStrictEqual(Array.from(out), [3, 4]);
});

test('backoffDelay 落在给定区间内', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
        const delay = DSP.backoffDelay(attempt, 800, 8000);
        assert.ok(delay >= 800 * 0.85, 'attempt ' + attempt + ' => ' + delay);
        assert.ok(delay <= 8000 * 1.15, 'attempt ' + attempt + ' => ' + delay);
    }
});

test('encodeWav 写出合法的 16bit PCM 头', () => {
    const chunks = [new Int16Array([100, -100]), new Int16Array([32767, -32768])];
    const buffer = DSP.encodeWav(chunks, 48000, 1);
    const view = new DataView(buffer);

    function str(offset, len) {
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
        return s;
    }

    assert.strictEqual(str(0, 4), 'RIFF');
    assert.strictEqual(str(8, 4), 'WAVE');
    assert.strictEqual(str(12, 4), 'fmt ');
    assert.strictEqual(str(36, 4), 'data');

    assert.strictEqual(buffer.byteLength, 44 + 8);
    assert.strictEqual(view.getUint32(4, true), 36 + 8);
    assert.strictEqual(view.getUint16(20, true), 1);
    assert.strictEqual(view.getUint16(22, true), 1);
    assert.strictEqual(view.getUint32(24, true), 48000);
    assert.strictEqual(view.getUint32(28, true), 96000);
    assert.strictEqual(view.getUint16(32, true), 2);
    assert.strictEqual(view.getUint16(34, true), 16);
    assert.strictEqual(view.getUint32(40, true), 8);

    assert.deepStrictEqual(
        [view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)],
        [100, -100, 32767, -32768]
    );
});

test('encodeWav 空输入也能生成只有头的文件', () => {
    const buffer = DSP.encodeWav([], 48000, 1);
    assert.strictEqual(buffer.byteLength, 44);
    assert.strictEqual(new DataView(buffer).getUint32(40, true), 0);
});
