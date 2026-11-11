#!/usr/bin/env node
'use strict';

/**
 * WebMic 服务端
 * - 托管接收页 / 手机发送页
 * - WebSocket 中继：发送端 -> 同房间所有接收端（零解码、零缓冲）
 * - 提供二维码与局域网信息接口
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const { ensureCertificate, localIPs } = require('./lib/certs');
const { createStaticHandler } = require('./lib/static');
const { listenDual } = require('./lib/dual');

const PUBLIC_DIR = path.join(__dirname, 'public');
const LIB_DIR = path.join(__dirname, 'lib');
const CERT_DIR = path.join(__dirname, 'certs');

const ROOM_RE = /^[0-9A-Za-z]{1,8}$/;
const MAX_BACKLOG = 256 * 1024; // 接收端积压超过该值就直接丢帧，避免内存暴涨

function parseArgs(argv) {
    const opts = { httpPort: 8080, httpsPort: 8443, https: true };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--no-https') opts.https = false;
        else if (arg === '--http-port') opts.httpPort = parseInt(argv[++i], 10);
        else if (arg === '--https-port') opts.httpsPort = parseInt(argv[++i], 10);
        else if (arg === '--help' || arg === '-h') opts.help = true;
    }
    return opts;
}

function usage() {
    console.log([
        '用法: node server.js [选项]',
        '',
        '  --http-port <端口>     主端口，默认 8080（同时支持 http 和 https）',
        '  --https-port <端口>    额外 HTTPS 端口，默认 8443（兼容旧地址，可选）',
        '  --no-https             只启动 HTTP（手机将无法使用麦克风）',
        '  -h, --help             显示帮助'
    ].join('\n'));
}

function normalizeRoom(value) {
    if (typeof value !== 'string') return null;
    const room = value.trim();
    if (!ROOM_RE.test(room)) return null;
    return room.toUpperCase();
}

// ---------------------------------------------------------------- 房间管理

const rooms = new Map();

function getRoom(code) {
    let room = rooms.get(code);
    if (!room) {
        room = { code: code, sender: null, receivers: new Set() };
        rooms.set(code, room);
    }
    return room;
}

function eachReceiver(room, fn) {
    room.receivers.forEach((client) => {
        if (client.readyState === client.OPEN) fn(client);
    });
}

function notify(room, payload) {
    const text = JSON.stringify(payload);
    eachReceiver(room, (client) => client.send(text));
}

function detach(client) {
    const room = client.room ? rooms.get(client.room) : null;
    if (!room) return;

    if (client.role === 'sender' && room.sender === client) {
        room.sender = null;
        notify(room, { type: 'peer', role: 'sender', online: false });
    } else if (client.role === 'receiver') {
        room.receivers.delete(client);
    }

    if (!room.sender && room.receivers.size === 0) rooms.delete(room.code);
    client.room = null;
    client.role = null;
}

function join(client, msg) {
    const roomCode = normalizeRoom(msg.room);
    if (!roomCode) {
        client.send(JSON.stringify({ type: 'error', message: '房间号只能是 1-8 位字母或数字' }));
        return;
    }

    const role = msg.role === 'sender' ? 'sender' : 'receiver';
    detach(client);

    const room = getRoom(roomCode);
    client.room = roomCode;
    client.role = role;

    if (role === 'sender') {
        if (room.sender && room.sender !== client) {
            room.sender.send(JSON.stringify({ type: 'error', message: '该房间已有其他手机在推流' }));
            room.sender.close(4001, 'replaced by another sender');
        }
        room.sender = client;
        client.send(JSON.stringify({ type: 'joined', room: roomCode, role: role, roomCode: roomCode }));
        notify(room, { type: 'peer', role: 'sender', online: true });
        console.log(`[房间 ${roomCode}] 手机已连接，接收端 ${room.receivers.size} 个`);
    } else {
        room.receivers.add(client);
        client.send(JSON.stringify({
            type: 'joined',
            room: roomCode,
            role: role,
            senderOnline: !!room.sender
        }));
        if (room.sender) {
            room.sender.send(JSON.stringify({ type: 'peer', role: 'receiver', online: true }));
        }
        console.log(`[房间 ${roomCode}] 接收端接入（共 ${room.receivers.size} 个）`);
    }
}

function relayAudio(client, data) {
    const room = client.room ? rooms.get(client.room) : null;
    if (!room || room.receivers.size === 0) return;

    eachReceiver(room, (receiver) => {
        if (receiver.bufferedAmount > MAX_BACKLOG) return; // 对方网络跟不上，丢帧保实时
        receiver.send(data, { binary: true }, () => {});
    });
}

// ---------------------------------------------------------------- WS 服务

function attachWebSocket(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, maxPayload: 1 << 20 });

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.room = null;
        ws.role = null;

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                if (ws.role === 'sender') relayAudio(ws, data);
                return;
            }

            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch (e) {
                return;
            }
            if (!msg || typeof msg !== 'object') return;

            switch (msg.type) {
                case 'hello':
                    join(ws, msg);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
                    break;
                case 'bye':
                    detach(ws);
                    ws.close(1000, 'bye');
                    break;
                default:
                    break;
            }
        });

        ws.on('close', () => detach(ws));
        ws.on('error', (err) => {
            console.warn('WebSocket 错误:', err.message);
            detach(ws);
        });
    });

    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                ws.terminate();
                return;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch (e) { /* ignore */ }
        });
    }, 15000);
    heartbeat.unref();

    wss.on('close', () => clearInterval(heartbeat));
    return wss;
}

// ---------------------------------------------------------------- HTTP 路由

function sendJSON(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store'
    });
    res.end(text);
}

function createRequestHandler(opts, staticHandler) {
    return function handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;

        if (pathname === '/api/info') {
            sendJSON(res, 200, {
                httpPort: opts.httpPort,
                httpsPort: opts.https ? opts.httpsPort : null,
                // 接收端口本身就能走 https，前端用它拼"其他电脑的接收地址"
                receiverHttpsPort: opts.https ? opts.httpPort : null,
                ips: localIPs()
            });
            return;
        }

        if (pathname === '/api/qr') {
            const text = url.searchParams.get('text') || '';
            if (!text || text.length > 512) {
                sendJSON(res, 400, { error: 'text 参数缺失或过长' });
                return;
            }
            QRCode.toString(text, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' })
                .then((svg) => {
                    res.writeHead(200, {
                        'Content-Type': 'image/svg+xml; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(svg);
                })
                .catch(() => sendJSON(res, 500, { error: '二维码生成失败' }));
            return;
        }

        if (pathname === '/dsp.js') {
            fs.readFile(path.join(LIB_DIR, 'dsp.js'), (err, buf) => {
                if (err) {
                    res.writeHead(404).end('Not Found');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/javascript; charset=utf-8',
                    'Content-Length': buf.length,
                    'Cache-Control': 'no-store'
                });
                res.end(buf);
            });
            return;
        }

        if (pathname === '/cert') {
            const certPath = path.join(CERT_DIR, 'cert.pem');
            fs.readFile(certPath, (err, buf) => {
                if (err) {
                    res.writeHead(404).end('Not Found');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'application/x-x509-ca-cert',
                    'Content-Disposition': 'attachment; filename="webmic.crt"',
                    'Content-Length': buf.length
                });
                res.end(buf);
            });
            return;
        }

        if (pathname === '/favicon.ico') {
            res.writeHead(204).end();
            return;
        }

        staticHandler(req, res, () => {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
        });
    };
}

// ---------------------------------------------------------------- 启动

function listen(server, port, label) {
    return new Promise((resolve, reject) => {
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`${label} 端口 ${port} 已被占用，可以用 --http-port / --https-port 换一个端口`));
            } else {
                reject(err);
            }
        });
        server.listen(port, '0.0.0.0', () => resolve());
    });
}

function printBanner(opts, certInfo) {
    const ips = certInfo && certInfo.ips ? certInfo.ips : localIPs();
    const primaryIP = ips[0] || '127.0.0.1';

    console.log('');
    console.log('  WebMic 已启动');
    console.log('  ------------------------------------------------');
    console.log(`  本机接收页:      http://localhost:${opts.httpPort}`);
    if (opts.https) {
        console.log(`  其他电脑接收页:  https://${primaryIP}:${opts.httpPort}`);
        console.log(`  手机发送页:      https://${primaryIP}:${opts.httpPort}/mic`);
        console.log(`  （${opts.httpPort} 端口同时支持 http 和 https，首次用 https 需点"高级 → 继续访问"）`);
    } else {
        console.log(`  其他电脑接收页:  http://${primaryIP}:${opts.httpPort}`);
        console.log('  警告: 已禁用 HTTPS，手机浏览器将无法获取麦克风权限');
    }
    console.log('  ------------------------------------------------');
    console.log('  提示: 接收页里选择 "CABLE Input"，然后在微信/OBS/音乐软件里');
    console.log('        把麦克风设为 "CABLE Output"。');
    console.log('');
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        usage();
        return;
    }

    const staticHandler = createStaticHandler(PUBLIC_DIR);
    const handler = createRequestHandler(opts, staticHandler);

    const httpServer = http.createServer(handler);
    attachWebSocket(httpServer);

    let httpsServer = null;
    let certInfo = null;
    if (opts.https) {
        certInfo = ensureCertificate(CERT_DIR);
        if (certInfo.generated) console.log('已生成新的自签名证书: certs/cert.pem');
        httpsServer = https.createServer({ key: certInfo.key, cert: certInfo.cert }, handler);
        attachWebSocket(httpsServer);
    }

    let front = null;
    try {
        if (opts.https) {
            // 接收端口（默认 8080）同时接受 http 和 https
            front = await listenDual(opts.httpPort, httpServer, httpsServer, '0.0.0.0', 'HTTP/HTTPS');
        } else {
            await listen(httpServer, opts.httpPort, 'HTTP');
        }
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
        return;
    }

    if (opts.https) {
        // 兼容旧地址：HTTPS 端口仍然单独监听，即使它不可用也不影响接收端口
        try {
            await listen(httpsServer, opts.httpsPort, 'HTTPS');
        } catch (err) {
            console.error(err.message);
            console.error(`HTTPS 端口不可用，但 ${opts.httpPort} 端口仍同时提供 http/https。`);
        }
    }

    printBanner(opts, certInfo);

    const shutdown = () => {
        console.log('\n正在关闭...');
        if (front) front.close();
        httpServer.close();
        if (httpsServer && httpsServer.listening) httpsServer.close();
        setTimeout(() => process.exit(0), 200);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('启动失败:', err.message);
    process.exitCode = 1;
});
