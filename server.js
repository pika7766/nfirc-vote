import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const requiredEnvironment = [
  'DATABASE_URL',
  'DATABASE_CA_CERT_BASE64',
  'ADMIN_PASSWORD',
  'SESSION_SECRET',
  'VOTE_IP_HASH_SECRET',
];
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
if (process.env.SESSION_SECRET.length < 32 || process.env.VOTE_IP_HASH_SECRET.length < 32) {
  throw new Error('SESSION_SECRET and VOTE_IP_HASH_SECRET must each be at least 32 characters.');
}

let databaseUrl;
try {
  databaseUrl = new URL(process.env.DATABASE_URL);
} catch {
  throw new Error('DATABASE_URL must be a valid PostgreSQL connection string.');
}
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
  throw new Error('DATABASE_URL must use the postgres or postgresql protocol.');
}
for (const parameter of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
  databaseUrl.searchParams.delete(parameter);
}

const databaseCa = Buffer.from(process.env.DATABASE_CA_CERT_BASE64, 'base64').toString('utf8');
if (!databaseCa.includes('-----BEGIN CERTIFICATE-----')) {
  throw new Error('DATABASE_CA_CERT_BASE64 must contain the Supabase CA certificate encoded as base64.');
}

const ADMIN_EMAIL = 'nfirc@nfirc.local';
const ADMIN_USERNAME = 'nfirc';
const SESSION_COOKIE = 'nfirc_session';
const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const pool = new Pool({
  connectionString: databaseUrl.toString(),
  ssl: { ca: databaseCa, rejectUnauthorized: true },
  max: 5,
  connectionTimeoutMillis: 10000,
});
const loginAttempts = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value, headers) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, '不允許的來源。');
  }
  if (originHost !== request.headers.host) throw new HttpError(403, '不允許的來源。');
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, '請使用 JSON 格式送出資料。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '請求資料過大。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '請求資料格式錯誤。');
  }
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '請求資料格式錯誤。');
  }
  return value;
}

function requestIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  return forwarded?.split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
}

function signedSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', process.env.SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function getSession(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  const token = cookie.slice(SESSION_COOKIE.length + 1);
  const [encoded, suppliedSignature] = token.split('.');
  if (!encoded || !suppliedSignature) return null;
  const expectedSignature = createHmac('sha256', process.env.SESSION_SECRET).update(encoded).digest();
  let provided;
  try {
    provided = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expectedSignature.length || !timingSafeEqual(provided, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.username !== ADMIN_USERNAME || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(request) {
  const session = getSession(request);
  if (!session) throw new HttpError(401, '請先登入管理員。');
  return session;
}

function cookieHeader(request, token, maxAge) {
  const protocol = request.headers['x-forwarded-proto']?.split(',')[0].trim();
  const secure = protocol === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function equalSecret(left, right) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function checkLoginRate(request) {
  const ip = requestIp(request);
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 10) throw new HttpError(429, '登入嘗試次數過多，請稍後再試。');
  recent.push(now);
  loginAttempts.set(ip, recent);
}

async function getPublicData() {
  const [settingsResult, moviesResult] = await Promise.all([
    pool.query('select id, submissions_open, phase, votes_per_person from public.app_settings where id = true'),
    pool.query('select id, title, duration, speed, created_at from public.movies order by created_at asc'),
  ]);
  const settings = settingsResult.rows[0];
  if (!settings) throw new Error('The app_settings row is missing.');
  let votes = [];
  if (settings.phase !== 'collecting') {
    const result = await pool.query(
      'select movie_id, count(*)::int as count from public.votes group by movie_id',
    );
    votes = result.rows;
  }
  return { settings, movies: moviesResult.rows, votes };
}

async function withTransaction(action) {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('begin');
    began = true;
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) {
    if (began) await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function validUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function validMovieInput(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const duration = typeof input.duration === 'string' ? input.duration.trim() : '';
  const speed = Number(input.speed ?? 1);
  if (!title || title.length > 120) throw new HttpError(400, '電影名稱需為 1–120 個字。');
  if (duration.length > 80) throw new HttpError(400, '片長不可超過 80 個字。');
  if (![1, 1.25].includes(speed)) throw new HttpError(400, '播放倍速只能選 1 或 1.25。');
  return { title, duration: duration || null, speed };
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  const method = request.method;

  if (method === 'GET' && pathname === '/api/health') {
    await pool.query('select 1');
    sendJson(response, 200, { status: 'ok' });
    return true;
  }

  if (method === 'GET' && pathname === '/api/session') {
    const session = getSession(request);
    sendJson(response, 200, { user: session ? { email: ADMIN_EMAIL } : null });
    return true;
  }

  if (method === 'POST' && pathname === '/api/login') {
    requireSameOrigin(request);
    checkLoginRate(request);
    const input = requireObject(await readJson(request));
    if (input.email !== ADMIN_EMAIL
        || typeof input.password !== 'string'
        || !equalSecret(input.password, process.env.ADMIN_PASSWORD)) {
      throw new HttpError(401, '帳號或密碼錯誤。');
    }
    loginAttempts.delete(requestIp(request));
    const token = signedSession({
      username: ADMIN_USERNAME,
      expiresAt: Date.now() + SESSION_LIFETIME_SECONDS * 1000,
    });
    sendJson(response, 200, { user: { email: ADMIN_EMAIL } }, {
      'Set-Cookie': cookieHeader(request, token, SESSION_LIFETIME_SECONDS),
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/logout') {
    requireSameOrigin(request);
    await readJson(request);
    sendJson(response, 200, { success: true }, {
      'Set-Cookie': cookieHeader(request, '', 0),
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/data') {
    sendJson(response, 200, await getPublicData());
    return true;
  }

  if (method === 'POST' && pathname === '/api/movies') {
    requireSameOrigin(request);
    const input = requireObject(await readJson(request));
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 120) throw new HttpError(400, '電影名稱需為 1–120 個字。');
    const movie = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'select phase, submissions_open from public.app_settings where id = true for share',
      );
      if (!rows[0] || rows[0].phase !== 'collecting' || !rows[0].submissions_open) {
        throw new HttpError(403, '目前沒有開放新增電影。');
      }
      const result = await client.query(
        'insert into public.movies (title) values ($1) returning id, title, duration, speed, created_at',
        [title],
      );
      return result.rows[0];
    });
    sendJson(response, 201, { movie });
    return true;
  }

  if (method === 'POST' && pathname === '/api/vote') {
    requireSameOrigin(request);
    const input = requireObject(await readJson(request));
    const movieIds = input.movieIds;
    if (!Array.isArray(movieIds)
        || movieIds.length < 1
        || movieIds.length > 5
        || !movieIds.every(validUuid)) {
      throw new HttpError(400, '請選擇有效的電影票數。');
    }
    const voterHash = createHmac('sha256', process.env.VOTE_IP_HASH_SECRET)
      .update(requestIp(request))
      .digest('hex');
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        'select phase, votes_per_person from public.app_settings where id = true for share',
      );
      const settings = rows[0];
      if (!settings || settings.phase !== 'voting') throw new HttpError(409, '目前沒有開放投票。');
      if (movieIds.length !== settings.votes_per_person) {
        throw new HttpError(400, `請分配剛好 ${settings.votes_per_person} 票。`);
      }
      const uniqueMovieIds = [...new Set(movieIds)];
      const movies = await client.query('select id from public.movies where id = any($1::uuid[])', [uniqueMovieIds]);
      if (movies.rowCount !== uniqueMovieIds.length) throw new HttpError(400, '有電影已不存在，請重新整理。');

      let ballot;
      try {
        ballot = await client.query(
          'insert into public.ballots (voter_hash) values ($1) returning id',
          [voterHash],
        );
      } catch (error) {
        if (error.code === '23505') throw new HttpError(409, '這個 IP 已經投過票了。');
        throw error;
      }
      await client.query(
        'insert into public.votes (ballot_id, movie_id) select $1, unnest($2::uuid[])',
        [ballot.rows[0].id, movieIds],
      );
    });
    sendJson(response, 201, { success: true });
    return true;
  }

  if (pathname.startsWith('/api/admin/')) {
    requireAdmin(request);
    requireSameOrigin(request);

    if (method === 'PATCH' && pathname === '/api/admin/settings') {
      const input = requireObject(await readJson(request));
      if (typeof input.submissions_open !== 'boolean') throw new HttpError(400, '設定值無效。');
      const updated = await withTransaction(async (client) => {
        const { rows } = await client.query(
          'select phase from public.app_settings where id = true for update',
        );
        if (!rows[0] || rows[0].phase !== 'collecting') {
          throw new HttpError(409, '投票開始後不能更改投稿設定。');
        }
        return client.query(
          'update public.app_settings set submissions_open = $1, updated_at = now() where id = true',
          [input.submissions_open],
        );
      });
      sendJson(response, 200, { success: true, rowCount: updated.rowCount });
      return true;
    }

    const movieRoute = pathname.match(/^\/api\/admin\/movies\/([^/]+)$/);
    if (movieRoute && !validUuid(movieRoute[1])) throw new HttpError(400, '電影識別碼無效。');
    if (movieRoute && method === 'PATCH') {
      const input = validMovieInput(requireObject(await readJson(request)));
      const result = await pool.query(
        'update public.movies set title = $1, duration = $2, speed = $3 where id = $4 returning id',
        [input.title, input.duration, input.speed, movieRoute[1]],
      );
      if (!result.rowCount) throw new HttpError(404, '找不到這部電影。');
      sendJson(response, 200, { success: true });
      return true;
    }
    if (movieRoute && method === 'DELETE') {
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          'select phase from public.app_settings where id = true for update',
        );
        if (!rows[0] || rows[0].phase !== 'collecting') {
          throw new HttpError(409, '投票期間不能刪除電影。');
        }
        const result = await client.query('delete from public.movies where id = $1', [movieRoute[1]]);
        if (!result.rowCount) throw new HttpError(404, '找不到這部電影。');
      });
      sendJson(response, 200, { success: true });
      return true;
    }

    if (method === 'POST' && pathname === '/api/admin/voting/start') {
      const input = requireObject(await readJson(request));
      const amount = Number(input.votes_per_person);
      if (!Number.isInteger(amount) || amount < 1 || amount > 5) {
        throw new HttpError(400, '每人票數需為 1–5 票。');
      }
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          'select id from public.app_settings where id = true for update',
        );
        if (!rows[0]) throw new Error('The app_settings row is missing.');
        const movies = await client.query('select count(*)::int as count from public.movies');
        if (movies.rows[0].count < 1) throw new HttpError(409, '至少需要一部電影才能開始投票。');
        await client.query('delete from public.ballots');
        await client.query(
          `update public.app_settings
           set phase = 'voting', submissions_open = false, votes_per_person = $1, updated_at = now()
           where id = true`,
          [amount],
        );
      });
      sendJson(response, 200, { success: true });
      return true;
    }

    if (method === 'POST' && pathname === '/api/admin/voting/finish') {
      await readJson(request);
      const result = await pool.query(
        `update public.app_settings
         set phase = 'finished', submissions_open = false, updated_at = now()
         where id = true and phase = 'voting'`,
      );
      if (!result.rowCount) throw new HttpError(409, '目前沒有進行中的投票。');
      sendJson(response, 200, { success: true });
      return true;
    }

    if (method === 'POST' && pathname === '/api/admin/reset') {
      await readJson(request);
      await withTransaction(async (client) => {
        await client.query('select id from public.app_settings where id = true for update');
        await client.query('delete from public.ballots');
        await client.query('delete from public.movies');
        await client.query(
          `update public.app_settings
           set submissions_open = true, phase = 'collecting', votes_per_person = 1, updated_at = now()
           where id = true`,
        );
      });
      sendJson(response, 200, { success: true });
      return true;
    }

    throw new HttpError(404, '找不到管理 API。');
  }

  return false;
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/admin', ['index.html', 'text/html; charset=utf-8']],
  ['/admin/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/api-client.js', ['api-client.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (await handleApi(request, response, url)) return;
    }
    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      const [filename, contentType] = staticFiles.get(url.pathname);
      const content = await readFile(new URL(`./${filename}`, import.meta.url));
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
      });
      response.end(content);
      return;
    }
    sendJson(response, 404, { error: '找不到此頁面。' });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error('Request failed:', error.message);
    sendJson(response, status, { error: status >= 500 ? '伺服器發生錯誤，請稍後再試。' : error.message });
  }
});

const port = Number(process.env.PORT || 10000);
await pool.query('select 1');
server.listen(port, '0.0.0.0', () => {
  console.log(`Movie voting server listening on port ${port}.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
