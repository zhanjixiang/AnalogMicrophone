'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const selfsigned = require('selfsigned');

/** 本机所有非回环 IPv4 地址 */
function localIPs() {
    const result = [];
    const interfaces = os.networkInterfaces();
    Object.keys(interfaces).forEach((name) => {
        (interfaces[name] || []).forEach((info) => {
            if (info.family === 'IPv4' && !info.internal) {
                result.push(info.address);
            }
        });
    });
    return result;
}

function certCoversIPs(certPath, ips) {
    if (!fs.existsSync(certPath)) return false;
    try {
        const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
        const san = cert.subjectAltName || '';
        return ips.every((ip) => san.indexOf('IP Address:' + ip) !== -1);
    } catch (e) {
        return false;
    }
}

/**
 * 确保 certs/ 下有可用的自签名证书。
 * 新增网卡 IP 后旧证书会失效（手机访问会报错），因此 IP 变化时自动重签。
 */
function ensureCertificate(certDir) {
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    const ips = localIPs();

    if (fs.existsSync(keyPath) && certCoversIPs(certPath, ips)) {
        return {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
            ips: ips,
            generated: false
        };
    }

    fs.mkdirSync(certDir, { recursive: true });

    const altNames = [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' }
    ].concat(ips.map((ip) => ({ type: 7, ip: ip })));

    const pems = selfsigned.generate(
        [{ name: 'commonName', value: 'WebMic Local' }],
        {
            days: 3650,
            keySize: 2048,
            algorithm: 'sha256',
            extensions: [
                { name: 'basicConstraints', cA: true },
                {
                    name: 'keyUsage',
                    digitalSignature: true,
                    keyEncipherment: true,
                    keyCertSign: true
                },
                { name: 'extKeyUsage', serverAuth: true },
                { name: 'subjectAltName', altNames: altNames }
            ]
        }
    );

    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);

    return {
        key: Buffer.from(pems.private),
        cert: Buffer.from(pems.cert),
        ips: ips,
        generated: true
    };
}

module.exports = { ensureCertificate: ensureCertificate, localIPs: localIPs };
