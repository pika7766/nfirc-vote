async function request(path, options, messages) {
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
    return { data: null, error: { message: error.message || messages.connectionFailed } };
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    if (response.ok) return { data: null, error: { message: messages.invalidResponse } };
  }
  if (!response.ok) {
    return {
      data: null,
      error: { message: data.error || messages.requestFailed.replace('{status}', response.status) },
    };
  }
  return { data, error: null };
}

function tableRequest(table, method, body, id, messages) {
  if (table === 'movies' && method === 'POST') return request('/api/movies', { method, body }, messages);
  if (table === 'app_settings' && method === 'PATCH') return request('/api/admin/settings', { method, body }, messages);
  if (table === 'movies' && method === 'PATCH' && id) {
    return request(`/api/admin/movies/${encodeURIComponent(id)}`, { method, body }, messages);
  }
  if (table === 'movies' && method === 'DELETE' && id) {
    return request(`/api/admin/movies/${encodeURIComponent(id)}`, { method }, messages);
  }
  return Promise.resolve({ data: null, error: { message: messages.unsupportedDatabaseOperation } });
}

export function createClient(content) {
  const messages = content.api;
  const auth = {
    async getSession() {
      const result = await request('/api/session', undefined, messages);
      return {
        data: { session: result.data?.user ? { user: result.data.user } : null },
        error: result.error,
      };
    },
    async signInWithPassword(credentials) {
      const result = await request('/api/login', { method: 'POST', body: credentials }, messages);
      return { data: { user: result.data?.user }, error: result.error };
    },
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signOut() {
      return request('/api/logout', { method: 'POST', body: {} }, messages);
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
          const result = await request('/api/data', undefined, messages);
          return { data: result.data?.settings || null, error: result.error };
        },
        insert(body) {
          return tableRequest(table, 'POST', body, undefined, messages);
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
          if (query.method !== 'GET') return tableRequest(table, query.method, query.body, query.id, messages);
          const result = await request('/api/data', undefined, messages);
          if (result.error) return result;
          if (table === 'movies') return { data: result.data.movies, error: null };
          if (table === 'votes') return { data: result.data.votes, error: null };
          if (table === 'app_settings') return { data: [result.data.settings], error: null };
          return { data: null, error: { message: messages.unsupportedTable } };
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
        admin_prepare_revote: ['/api/admin/voting/prepare-revote', {}],
        admin_clear_all: ['/api/admin/reset', {}],
      };
      const endpoint = endpoints[name];
      if (!endpoint) return { data: null, error: { message: messages.unsupportedAdminOperation } };
      return request(endpoint[0], { method: 'POST', body: endpoint[1] }, messages);
    },
    functions: {
      invoke(name, options) {
        if (name !== 'cast-vote') {
          return Promise.resolve({ data: null, error: { message: messages.unsupportedFunction } });
        }
        return request('/api/vote', { method: 'POST', body: options?.body || {} }, messages);
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
