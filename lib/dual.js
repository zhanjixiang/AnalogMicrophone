'use strict';

const net = require('net');

const TLS_HANDSHAKE = 0x16; // TLS ClientHello 记录的第一个字节
const SNIFF_TIMEOUT_MS = 10000;

/**
 * 让同一个端口同时接受 HTTP 与 HTTPS。
 *
 * 连接进来后先读第一个数据包：
 * - 首字节 0x16 → TLS 握手，交给 https server；
 * - 否则按明文 HTTP 交给 http server。
 *
 * 前提：httpServer / httpsServer 都不要自己 listen，端口由这里统一接管。
 * 这样 `https://IP:8080` 和 `http://localhost:8080` 都能用，不用额外开端口。
 */
function listenDual(port, httpServer, httpsServer, host, label) {
    const name = label || 'HTTP/HTTPS';

    const front = net.createServer((socket) => {
        // 只连不发数据的客户端（端口扫描、健康检查）不应该一直占着连接
        socket.setTimeout(SNIFF_TIMEOUT_MS, () => socket.destroy());
        socket.once('error', () => socket.destroy());

        socket.once('data', (chunk) => {
            socket.setTimeout(0);
            socket.pause();
            socket.unshift(chunk);

            if (chunk[0] === TLS_HANDSHAKE) {
                httpsServer.emit('connection', socket);
            } else {
                httpServer.emit('connection', socket);
            }

            // 等两个 server 挂好各自的解析器后再放行已缓冲的数据
            process.nextTick(() => socket.resume());
        });
    });

    return new Promise((resolve, reject) => {
        front.once('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                reject(new Error(`${name} 端口 ${port} 已被占用，可以用 --http-port / --https-port 换一个端口`));
            } else {
                reject(err);
            }
        });
        front.listen(port, host || '0.0.0.0', () => resolve(front));
    });
}

module.exports = { listenDual: listenDual };
