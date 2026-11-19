import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

const templates = ['bootstrap.conf', 'distant-refuge.conf', 'forum-proxy.inc', 'forum-locations.inc'];

function nginxHost(value, label) {
  const host = value.replace(/^\[(.*)\]$/, '$1');
  if (isIP(host) === 6 && !host.includes('%')) return '[' + host + ']';
  if (value.length <= 253 && value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) {
    return value;
  }
  throw new Error(label + ' must contain a valid hostname or IP address.');
}

function nginxPort(value, label) {
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) {
    throw new Error(label + ' must be a port from 1 to 65535.');
  }
  return value;
}

function nginxPath(value, label) {
  if (!isAbsolute(value) || /["\\$\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(label + ' must be an absolute path without quotes, backslashes, dollar signs or control characters.');
  }
  return '"' + value + '"';
}

function render(name, env) {
  if (!templates.includes(name)) throw new Error('Choose a configuration: ' + templates.join(', '));
  let origin;
  try { origin = new URL(env.PUBLIC_ORIGIN); } catch { /* See the configuration error below. */ }
  if (origin?.protocol !== 'https:' || origin.href !== origin.origin + '/') {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin.');
  }
  const serverName = nginxHost(origin.hostname, 'PUBLIC_ORIGIN');
  const httpsPort = nginxPort(origin.port || '443', 'PUBLIC_ORIGIN');
  const host = nginxHost(env.HOST || '127.0.0.1', 'HOST');
  const upstreamHost = host === '0.0.0.0' ? '127.0.0.1' : host === '[::]' ? '[::1]' : host;
  const certificateDir = '/etc/letsencrypt/live/' + serverName;
  const values = {
    serverName, authority: origin.host, httpsPort,
    upstream: upstreamHost + ':' + nginxPort(env.PORT || '3000', 'PORT'),
    certificate: nginxPath(env.TLS_CERT_PATH || certificateDir + '/fullchain.pem', 'TLS_CERT_PATH'),
    certificateKey: nginxPath(env.TLS_KEY_PATH || certificateDir + '/privkey.pem', 'TLS_KEY_PATH'),
  };
  const file = name === 'forum-locations.inc' ? name : name + '.tmpl';
  const template = readFileSync(new URL(file, import.meta.url), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error('Unknown nginx template field: ' + key);
    return values[key];
  });
}

try {
  process.stdout.write(render(process.argv[2], process.env));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
