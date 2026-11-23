async function request(path, options) {
  const settings = options || {};
  const headers = {};
  if (settings.body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(path, {
      method: settings.method || 'GET',
      credentials: 'same-origin',
      headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
    });
  } catch (error) {
    return { data: null, error: { message: error.message || '無法連接網站伺服器。' } };
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    if (response.ok) return { data: null, error: { message: '伺服器回應格式錯誤。' } };
  }
  if (!response.ok) {
    return {
      data: null,
      error: { message: data.error || `伺服器錯誤 (${response.status})` },
    };
  }
  return { data, error: null };
}

function tableRequest(table, method, body, id) {
  if (table === 'movies' && method === 'POST') return request('/api/movies', { method, body });
  if (table === 'app_settings' && method === 'PATCH') return request('/api/admin/settings', { method, body });
  if (table === 'movies' && method === 'PATCH' && id) {
    return request(`/api/admin/movies/${encodeURIComponent(id)}`, { method, body });
  }
  if (table === 'movies' && method === 'DELETE' && id) {
    return request(`/api/admin/movies/${encodeURIComponent(id)}`, { method });
  }
  return Promise.resolve({ data: null, error: { message: '不支援的資料庫操作。' } });
}

export function createClient() {
  const auth = {
    async getSession() {
      const result = await request('/api/session');
      return {
        data: { session: result.data?.user ? { user: result.data.user } : null },
        error: result.error,
      };
    },
    async signInWithPassword(credentials) {
      const result = await request('/api/login', { method: 'POST', body: credentials });
      return { data: { user: result.data?.user }, error: result.error };
    },
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signOut() {
      return request('/api/logout', { method: 'POST', body: {} });
    },
  };

  return {
    auth,
    from(table) {
      const query = { method: 'GET', body: undefined, id: undefined };
      const builder = {
        select() {
          query.method = 'GET';
          return builder;
        },
        eq(column, value) {
          if (column === 'id') query.id = value;
          return builder;
        },
        order() {
          return builder;
        },
        async single() {
          const result = await request('/api/data');
          return { data: result.data?.settings || null, error: result.error };
        },
        insert(body) {
          return tableRequest(table, 'POST', body);
        },
        update(body) {
          query.method = 'PATCH';
          query.body = body;
          return builder;
        },
        delete() {
          query.method = 'DELETE';
          return builder;
        },
        async execute() {
          if (query.method !== 'GET') return tableRequest(table, query.method, query.body, query.id);
          const result = await request('/api/data');
          if (result.error) return result;
          if (table === 'movies') return { data: result.data.movies, error: null };
          if (table === 'votes') return { data: result.data.votes, error: null };
          if (table === 'app_settings') return { data: [result.data.settings], error: null };
          return { data: null, error: { message: '不支援的資料表。' } };
        },
        then(resolve, reject) {
          return builder.execute().then(resolve, reject);
        },
      };
      return builder;
    },
    async rpc(name, args) {
      const endpoints = {
        admin_start_voting: ['/api/admin/voting/start', { votes_per_person: args?.p_votes_per_person }],
        admin_finish_voting: ['/api/admin/voting/finish', {}],
        admin_clear_all: ['/api/admin/reset', {}],
      };
      const endpoint = endpoints[name];
      if (!endpoint) return { data: null, error: { message: '不支援的管理操作。' } };
      return request(endpoint[0], { method: 'POST', body: endpoint[1] });
    },
    functions: {
      invoke(name, options) {
        if (name !== 'cast-vote') {
          return Promise.resolve({ data: null, error: { message: '不支援的函式。' } });
        }
        return request('/api/vote', { method: 'POST', body: options?.body || {} });
      },
    },
    channel() {
      const callbacks = [];
      let timer;
      const channel = {
        on(_event, _filter, callback) {
          callbacks.push(callback);
          return channel;
        },
        subscribe(callback) {
          callback?.('SUBSCRIBED');
          timer = window.setInterval(() => {
            if (callbacks[0]) void callbacks[0]();
          }, 2000);
          return channel;
        },
        unsubscribe() {
          window.clearInterval(timer);
        },
      };
      return channel;
    },
  };
}
