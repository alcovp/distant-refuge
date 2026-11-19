import { timingSafeEqual } from 'node:crypto';
import { createPostingSessions } from './posting-sessions.mjs';

const reject = (status, message) => Object.assign(new Error(message), { status });

export function createPostingAccess({ origin, secretPath }) {
  const secure = origin.startsWith('https://');
  const name = secure ? '__Host-refuge_session' : 'refuge_session';
  const sessions = createPostingSessions({ secretPath });
  function token(req) {
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim());
    const matches = cookies.filter(part => part.startsWith(name + '='));
    if (matches.length !== 1) return '';
    const value = matches[0].slice(name.length + 1);
    return /^[a-zA-Z0-9_.-]{1,256}$/.test(value) ? value : '';
  }
  function setCookie(res, value) {
    res.setHeader('Set-Cookie', name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''));
  }
  function validCsrf(expected, submitted) {
    const a = Buffer.from(submitted || '');
    const b = Buffer.from(expected || '');
    if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw reject(403, 'Reopen the form in this browser and try again.');
    }
  }
  return {
    formCsrf(req, res) {
      const session = token(req);
      const existing = sessions.csrf(session);
      if (existing) return existing;
      const guest = sessions.issue();
      setCookie(res, guest);
      return sessions.csrf(guest);
    },
    authorize(req, csrf) {
      const session = token(req);
      validCsrf(sessions.csrf(session), csrf);
      return session;
    },
  };
}
