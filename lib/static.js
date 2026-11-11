'use strict';

const fs = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
};

/**
 * 极简静态文件服务。
 * 路由约定：/ -> receiver.html，/mic -> sender.html，其余按 public/ 下的真实路径查找。
 */
function createStaticHandler(publicDir) {
    const root = path.resolve(publicDir);

    return function serve(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Method Not Allowed');
            return;
        }

        let urlPath;
        try {
            urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        } catch (e) {
            res.writeHead(400).end('Bad Request');
            return;
        }

        if (urlPath === '/' || urlPath === '') urlPath = '/receiver.html';
        else if (urlPath === '/mic' || urlPath === '/mic/') urlPath = '/sender.html';

        const filePath = path.resolve(root, '.' + urlPath);
        if (filePath !== root && filePath.indexOf(root + path.sep) !== 0) {
            res.writeHead(403).end('Forbidden');
            return;
        }

        fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) {
                if (typeof next === 'function') return next();
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME[ext] || 'application/octet-stream',
                'Content-Length': stat.size,
                'Cache-Control': 'no-store'
            });
            if (req.method === 'HEAD') {
                res.end();
                return;
            }
            fs.createReadStream(filePath).pipe(res);
        });
    };
}

module.exports = { createStaticHandler: createStaticHandler };
