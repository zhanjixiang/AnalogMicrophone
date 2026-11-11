'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const HTTP_PORT = 18000 + Math.floor(Math.random() * 400);
const HTTPS_PORT = HTTP_PORT + 500;
const BASE = 'http://127.0.0.1:' + HTTP_PORT;

let child = null;

function httpGet(pathname) {
    return new Promise((resolve, reject) => {
        const req = http.get(BASE + pathname, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 用 https 访问同一个 HTTP_PORT，验证端口双协议 */
function httpsGet(pathname) {
    return new Promise((resolve, reject) => {
        const req = https.get({
            host: '127.0.0.1',
            port: HTTP_PORT,
            path: pathname,
            rejectUnauthorized: false
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    });
}

async function waitForServer(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await httpGet('/api/info');
            if (res.status === 200) return JSON.parse(res.body);
        } catch (e) { /* 还没起来 */ }
        await sleep(200);
    }
    throw new Error('服务未在超时时间内启动');
}

function openSocket() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://127.0.0.1:' + HTTP_PORT);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

/** 把文本/二进制消息排队，便于按顺序断言 */
function track(ws) {
    const queue = [];
    const waiters = [];
    ws.on('message', (data, isBinary) => {
        const item = { data: data, isBinary: isBinary };
        if (waiters.length) waiters.shift()(item);
        else queue.push(item);
    });
    return {
        next: function (timeoutMs) {
            const timeout = timeoutMs || 3000;
            if (queue.length) return Promise.resolve(queue.shift());
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('等待消息超时')), timeout);
                waiters.push((item) => { clearTimeout(timer); resolve(item); });
            });
        },
        size: function () { return queue.length; }
    };
}

function hello(ws, role, room) {
    ws.send(JSON.stringify({ type: 'hello', role: role, room: room }));
}

// Node 16 的 test 模块没有 before/after 钩子，这里用一个共享的启动 Promise
const ready = (async () => {
    child = spawn(process.execPath, ['server.js', '--http-port', String(HTTP_PORT), '--https-port', String(HTTPS_PORT)], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.resume();
    child.stderr.resume();
    await waitForServer(45000);
})();

process.on('exit', () => {
    if (child) child.kill();
});

test('接收页可以访问', async () => {
    await ready;
    const res = await httpGet('/');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /WebMic/);
});

test('手机发送页可以访问 /mic', async () => {
    await ready;
    const res = await httpGet('/mic?room=1234');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /开始发送|WebMic/);
});

test('/api/info 返回端口信息', async () => {
    await ready;
    const res = await httpGet('/api/info');
    assert.strictEqual(res.status, 200);
    const info = JSON.parse(res.body);
    assert.strictEqual(info.httpPort, HTTP_PORT);
    assert.strictEqual(info.httpsPort, HTTPS_PORT);
    assert.strictEqual(info.receiverHttpsPort, HTTP_PORT);
    assert.ok(Array.isArray(info.ips));
});

test('同一个端口同时接受 http 和 https', async () => {
    await ready;

    const page = await httpsGet('/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /WebMic/);

    const info = await httpsGet('/api/info');
    assert.strictEqual(info.status, 200);
    assert.strictEqual(JSON.parse(info.body).httpPort, HTTP_PORT);
});

test('同一端口上的 wss 也能正常加入房间', async () => {
    await ready;
    const ws = new WebSocket('wss://127.0.0.1:' + HTTP_PORT, { rejectUnauthorized: false });
    const incoming = track(ws);

    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });

    hello(ws, 'receiver', '4321');
    const msg = JSON.parse((await incoming.next()).data.toString());
    assert.strictEqual(msg.type, 'joined');
    ws.close();
});

test('/api/qr 返回 SVG 二维码', async () => {
    await ready;
    const res = await httpGet('/api/qr?text=' + encodeURIComponent('https://example.com/mic'));
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /svg/);
    assert.match(res.body, /<svg/);
});

test('/dsp.js 与静态资源可加载', async () => {
    await ready;
    const dsp = await httpGet('/dsp.js');
    assert.strictEqual(dsp.status, 200);
    assert.match(dsp.body, /Resampler/);

    const css = await httpGet('/app.css');
    assert.strictEqual(css.status, 200);
    assert.match(css.headers['content-type'], /css/);

    const wk = await httpGet('/capture-worklet.js');
    assert.strictEqual(wk.status, 200);
    assert.match(wk.body, /registerProcessor/);
});

test('目录穿越被拒绝', async () => {
    await ready;
    const res = await httpGet('/../server.js');
    assert.ok(res.status === 403 || res.status === 404, '实际状态码 ' + res.status);
});

test('音频帧会原样转发给同房间接收端', async () => {
    await ready;
    const sender = await openSocket();
    const receiver = await openSocket();
    const senderIn = track(sender);
    const receiverIn = track(receiver);

    hello(sender, 'sender', '1234');
    await senderIn.next();

    hello(receiver, 'receiver', '1234');
    const joined = JSON.parse((await receiverIn.next()).data.toString());
    assert.strictEqual(joined.type, 'joined');
    assert.strictEqual(joined.senderOnline, true);

    const payload = Buffer.alloc(960);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

    sender.send(payload);

    const received = await receiverIn.next();
    assert.ok(received.isBinary, '应该是二进制帧');
    assert.deepStrictEqual(received.data, payload);

    sender.close();
    receiver.close();
});

test('不同房间之间不会串音', async () => {
    await ready;
    const sender = await openSocket();
    const other = await openSocket();
    const senderIn = track(sender);
    const otherIn = track(other);

    hello(sender, 'sender', '1111');
    await senderIn.next();
    hello(other, 'receiver', '2222');
    await otherIn.next();

    sender.send(Buffer.from([1, 2, 3, 4]));

    await assert.rejects(otherIn.next(600), /超时/);

    sender.close();
    other.close();
});

test('同一房间第二个发送端会顶掉第一个', async () => {
    await ready;
    const first = await openSocket();
    const second = await openSocket();
    const firstIn = track(first);
    const secondIn = track(second);

    hello(first, 'sender', '7777');
    await firstIn.next();

    const closed = new Promise((resolve) => first.once('close', (code) => resolve(code)));
    hello(second, 'sender', '7777');
    await secondIn.next();

    const code = await closed;
    assert.strictEqual(code, 4001);

    second.close();
});

test('非法房间号会返回错误', async () => {
    await ready;
    const ws = await openSocket();
    const incoming = track(ws);
    ws.send(JSON.stringify({ type: 'hello', role: 'sender', room: '带有中文' }));
    const msg = JSON.parse((await incoming.next()).data.toString());
    assert.strictEqual(msg.type, 'error');
    ws.close();
});

// 必须放在最后：否则子进程会一直占着事件循环，导致测试进程不退出
test('关闭测试服务器', async () => {
    await ready;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
});
