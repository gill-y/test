// Generates a self-signed HTTPS certificate for local testing (server/certs/).
// The certificate covers localhost and every LAN IPv4 address of this computer,
// so a Quest or phone on the same Wi-Fi can open https://<lan-ip>:8443/.
// Browsers will warn once; choose "Advanced -> Proceed". See README for details
// and for the mkcert / adb-reverse alternatives that avoid the warning.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'certs');
fs.mkdirSync(dir, { recursive: true });

const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4')
  .map((i) => i.address);

const altNames = [
  { type: 2, value: 'localhost' },
  ...ips.map((ip) => ({ type: 7, ip })),
];

const pems = selfsigned.generate([{ name: 'commonName', value: 'SeeThrough local relay' }], {
  days: 825,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ],
});

fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
console.log(`Wrote ${dir}\\key.pem and cert.pem for: localhost, ${ips.join(', ')}`);
