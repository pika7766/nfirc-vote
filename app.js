import { createClient } from './api-client.js';

const app = document.querySelector('#app');
const ADMIN_EMAIL = 'nfirc@nfirc.local';
function main() {
  const supabase = createClient();
  const isAdminPage = /\/admin\/?$/.test(window.location.pathname);
  const state = {
    movies: [],
    settings: null,
    votes: [],
    user: null,
    busy: false,
    notice: '',
    noticeIsError: false,
    loadError: '',
  };

  function make(tag, options) {
    const element = document.createElement(tag);
    if (options) {
      if (options.className) element.className = options.className;
      if (options.text !== undefined) element.textContent = options.text;
      if (options.type) element.type = options.type;
      if (options.name) element.name = options.name;
      if (options.value !== undefined) element.value = options.value;
      if (options.href) element.href = options.href;
      if (options.placeholder) element.placeholder = options.placeholder;
      if (options.disabled) element.disabled = true;
      if (options.required) element.required = true;
      if (options.min !== undefined) element.min = options.min;
      if (options.max !== undefined) element.max = options.max;
      if (options.step !== undefined) element.step = options.step;
      if (options.autocomplete) element.autocomplete = options.autocomplete;
      if (options.checked) element.checked = true;
      if (options.role) element.setAttribute('role', options.role);
      if (options.ariaLabel) element.setAttribute('aria-label', options.ariaLabel);
      if (options.preserve) element.dataset.preserve = options.preserve;
    }
    return element;
  }

  function button(label, className, onClick, disabled) {
    const control = make('button', { type: 'button', text: label, className: `button ${className || ''}`.trim(), disabled });
    control.addEventListener('click', onClick);
    return control;
  }

  function panel(title, content) {
    const section = make('section', { className: 'panel' });
    const heading = make('div', { className: 'panel-heading' });
    heading.append(make('h2', { text: title }), content);
    section.append(heading);
    return section;
  }

  function setNotice(message, isError) {
    state.notice = message;
    state.noticeIsError = Boolean(isError);
    const notice = app.querySelector('.notice');
    if (notice) {
      notice.textContent = message;
      notice.classList.toggle('notice-error', state.noticeIsError);
    } else {
      render();
    }
  }

  function preserveInputs() {
    const values = new Map();
    for (const element of app.querySelectorAll('[data-preserve]')) {
      values.set(element.dataset.preserve, {
        value: element.value,
        checked: element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : undefined,
      });
    }
    const focused = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.preserve
      : null;
    return { values, focused };
  }

  function restoreInputs(saved) {
    for (const element of app.querySelectorAll('[data-preserve]')) {
      const previous = saved.values.get(element.dataset.preserve);
      if (!previous) continue;
      if (previous.checked !== undefined && element instanceof HTMLInputElement) element.checked = previous.checked;
      else element.value = previous.value;
    }
    const ballot = app.querySelector('form[data-ballot]');
    if (ballot) {
      const allowed = Number(state.settings.votes_per_person);
      const allocated = [...ballot.querySelectorAll('input[type="number"]')]
        .reduce((total, input) => total + (Number(input.value) || 0), 0);
      const status = ballot.querySelector('.hint');
      if (status) status.textContent = `已分配 ${allocated} / ${allowed} 票`;
      const submit = ballot.querySelector('button[type="submit"]');
      if (submit) submit.disabled = allocated !== allowed || state.busy;
    }
    if (saved.focused) app.querySelector(`[data-preserve="${CSS.escape(saved.focused)}"]`)?.focus();
  }

  function render() {
    const saved = preserveInputs();
    app.replaceChildren();
    const header = make('header', { className: 'topbar' });
    const brand = make('a', { className: 'brand', href: '/', ariaLabel: '回到電影票選首頁' });
    brand.append(make('span', { className: 'brand-mark', text: '映' }), make('span', { text: 'NFIRC 社課電影票選' }));
    header.append(brand);
    if (isAdminPage && state.user) {
      header.append(button('登出', 'button-secondary button-small', logout));
    } else if (!isAdminPage) {
      header.append(make('a', { className: 'text-link', href: '/admin', text: '管理員入口' }));
    } else {
      header.append(make('a', { className: 'text-link', href: '/', text: '回到投票頁' }));
    }
    app.append(header);

    if (state.loadError) {
      app.append(make('section', { className: 'panel' }));
      const error = app.querySelector('.panel');
      error.append(make('p', { className: 'notice notice-error', text: state.loadError }));
      error.append(button('重新載入', 'button-secondary', () => loadData()));
    } else if (!state.settings) {
      app.append(make('p', { className: 'loading', text: '正在連線至 Supabase…' }));
    } else if (isAdminPage && !state.user) {
      renderLogin();
    } else if (isAdminPage) {
      renderAdmin();
    } else {
      renderVoter();
    }

    if (state.notice && state.settings && !(isAdminPage && !state.user)) {
      let notice = app.querySelector('.notice');
      if (!notice) {
        notice = make('p', { className: 'notice' });
        app.append(notice);
      }
      notice.textContent = state.notice;
      notice.classList.toggle('notice-error', state.noticeIsError);
    }
    app.append(make('p', { className: 'footer-note', text: '資料即時同步 · powered by Supabase' }));
    restoreInputs(saved);
  }

  function hero(label, title, description, status) {
    const section = make('section', { className: 'hero' });
    section.append(make('p', { className: 'eyebrow', text: label }), make('h1', { text: title }), make('p', { className: 'intro', text: description }));
    if (status) {
      const statusBadge = make('span', { className: `status-pill status-${state.settings.phase}`, text: status });
      section.append(statusBadge);
    }
    return section;
  }

  function movieList(counts, showResults) {
    const list = make('ul', { className: 'movie-list' });
    for (const movie of state.movies) {
      const row = make('li', { className: 'movie-row' });
      const details = make('div', { className: 'movie-main' });
      details.append(make('span', { className: 'movie-title', text: movie.title }));
      const meta = [movie.duration, movie.speed && Number(movie.speed) !== 1 ? `${movie.speed} 倍速` : ''].filter(Boolean).join(' · ');
      if (meta) details.append(make('span', { className: 'movie-meta', text: meta }));
      row.append(details);
      if (showResults) row.append(make('span', { className: 'movie-score', text: `${counts.get(movie.id) || 0} 票` }));
      list.append(row);
    }
    return list;
  }

  function renderVoter() {
    const phase = state.settings.phase;
    const title = phase === 'collecting' ? '這次社課，想看哪一部？' : '一起選出今晚的電影';
    const description = phase === 'collecting'
      ? '把想看的電影加進候選清單，等大家一起決定今晚的片單。'
      : '候選片單已確定，選出你最想看的電影吧。';
    app.append(hero('MOVIE NIGHT · NFIRC', title, description, phaseText(phase)));
    const count = make('span', { className: 'count', text: `${state.movies.length} 部電影` });
    const listPanel = panel(phase === 'collecting' ? '目前的候選片單' : '即時票數', count);
    if (state.movies.length) {
      listPanel.append(movieList(voteCounts(), phase !== 'collecting'));
    } else {
      listPanel.append(make('div', { className: 'empty-state', text: phase === 'collecting' ? '還沒有電影，來當第一個提名的人吧。' : '目前沒有可投票的電影。' }));
    }
    app.append(listPanel);

    if (phase === 'collecting' && state.settings.submissions_open) {
      renderSubmission();
    } else if (phase === 'voting') {
      renderBallot();
    } else if (phase === 'collecting') {
      const paused = make('section', { className: 'panel' });
      paused.append(make('p', { className: 'hint', text: '目前暫停新增電影，請稍後再來看看。' }));
      app.append(paused);
    } else {
      app.append(make('p', { className: 'hint', text: '投票已結束，以上是本次社課的最終結果。' }));
    }
  }

  function renderSubmission() {
    const section = make('section', { className: 'panel' });
    section.append(make('p', { className: 'section-label', text: '新增一部電影' }));
    const form = make('form', { className: 'field-row' });
    const title = make('input', {
      className: 'field',
      type: 'text',
      name: 'title',
      placeholder: '輸入電影名稱',
      required: true,
      max: 120,
      preserve: 'new-movie-title',
    });
    title.maxLength = 120;
    const submit = make('button', { className: 'button', type: 'submit', text: '提交電影', disabled: state.busy });
    form.append(title, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const movieTitle = title.value.trim();
      if (!movieTitle) return;
      await runAction(async () => {
        const { error } = await supabase.from('movies').insert({ title: movieTitle });
        if (error) throw error;
        const currentTitle = app.querySelector('input[data-preserve="new-movie-title"]');
        if (currentTitle) currentTitle.value = '';
        await loadData();
        setNotice('電影已加入候選清單。');
      });
    });
    section.append(form);
    app.append(section);
  }

  function renderBallot() {
    const section = make('section', { className: 'panel' });
    const allowed = Number(state.settings.votes_per_person);
    section.append(make('p', { className: 'section-label', text: `請分配 ${allowed} 票（每個 IP 可投票一次）` }));
    if (!state.movies.length) {
      section.append(make('p', { className: 'hint', text: '目前沒有可投票的電影。' }));
      app.append(section);
      return;
    }
    const form = make('form');
    form.dataset.ballot = 'true';
    const list = make('ul', { className: 'movie-list' });
    for (const movie of state.movies) {
      const row = make('li', { className: 'movie-row' });
      const movieInfo = make('span', { className: 'movie-main' });
      movieInfo.append(make('span', { className: 'movie-title', text: movie.title }));
      if (movie.duration) movieInfo.append(make('span', { className: 'movie-meta', text: `${movie.duration}${Number(movie.speed) !== 1 ? ` · ${movie.speed} 倍速` : ''}` }));
      const voteCount = make('input', {
        className: 'field vote-limit',
        type: 'number',
        name: 'movieVotes',
        value: 0,
        min: 0,
        max: allowed,
        step: 1,
        ariaLabel: `${movie.title} 投票數`,
        preserve: `vote-${movie.id}`,
      });
      voteCount.dataset.movieId = movie.id;
      row.append(movieInfo, voteCount);
      list.append(row);
    }
    const status = make('p', { className: 'hint', text: `已分配 0 / ${allowed} 票` });
    const submit = make('button', { className: 'button', type: 'submit', text: '送出我的票', disabled: state.busy });
    list.addEventListener('input', () => {
      const total = [...list.querySelectorAll('input[type="number"]')]
        .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
      status.textContent = `已分配 ${total} / ${allowed} 票`;
      submit.disabled = total !== allowed || state.busy;
    });
    form.append(list, status, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const movieIds = [];
      for (const input of form.querySelectorAll('input[type="number"]')) {
        const votes = Number(input.value);
        if (!Number.isInteger(votes) || votes < 0 || votes > allowed) return;
        for (let count = 0; count < votes; count += 1) movieIds.push(input.dataset.movieId);
      }
      if (movieIds.length !== allowed) return;
      await runAction(async () => {
        const { error } = await supabase.functions.invoke('cast-vote', { body: { movieIds } });
        if (error) {
          if (error.context instanceof Response) {
            const response = await error.context.json();
            if (typeof response.error === 'string') throw new Error(response.error);
          }
          throw error;
        }
        await loadData();
        setNotice('投票成功，票數已即時更新。');
      });
    });
    section.append(form);
    app.append(section);
  }

  function renderLogin() {
    app.append(hero('ADMIN · NFIRC', '管理員登入', '登入後即可管理電影清單與投票設定。'));
    const section = make('section', { className: 'panel' });
    const form = make('form');
    const usernameGroup = make('div', { className: 'field-group' });
    usernameGroup.append(make('label', { className: 'field-label', text: '管理員帳號' }));
    const username = make('input', { className: 'field', type: 'text', name: 'username', placeholder: '帳號', autocomplete: 'username', required: true, preserve: 'admin-username' });
    usernameGroup.append(username);
    const passwordGroup = make('div', { className: 'field-group' });
    passwordGroup.append(make('label', { className: 'field-label', text: '密碼' }));
    const password = make('input', { className: 'field', type: 'password', name: 'password', placeholder: '密碼', autocomplete: 'current-password', required: true, preserve: 'admin-password' });
    passwordGroup.append(password);
    form.append(usernameGroup, passwordGroup);
    form.className = 'login-form';
    const submit = make('button', { className: 'button', type: 'submit', text: '登入管理員', disabled: state.busy });
    submit.style.marginTop = '16px';
    form.append(submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (username.value.trim() !== 'nfirc') {
        setNotice('帳號或密碼錯誤。', true);
        return;
      }
      await runAction(async () => {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: ADMIN_EMAIL,
          password: password.value,
        });
        if (error || data.user?.email !== ADMIN_EMAIL) throw new Error('帳號或密碼錯誤。');
        state.user = data.user;
        password.value = '';
        state.notice = '';
        render();
      });
    });
    section.append(form);
    app.append(section);
    if (state.notice) {
      const notice = make('p', { className: 'notice notice-error', text: state.notice });
      app.append(notice);
    }
  }

  function renderAdmin() {
    const phase = state.settings.phase;
    app.append(hero('ADMIN PANEL', '電影與投票管理', '管理候選電影、開放投稿，並即時掌握投票狀況。', phaseText(phase)));
    const settingsPanel = make('section', { className: 'panel' });
    const heading = make('div', { className: 'panel-heading' });
    heading.append(make('h2', { text: '整體設定' }));
    settingsPanel.append(heading);

    const setting = make('div', { className: 'setting-row' });
    const copy = make('div', { className: 'setting-copy' });
    copy.append(make('strong', { text: '開放使用者提交電影' }), make('span', { text: phase === 'collecting' ? '只在收集階段開放投稿。' : '投票開始後會自動關閉投稿。' }));
    const toggle = make('input', { className: 'switch', type: 'checkbox', name: 'submissions_open', preserve: 'submissions-open', checked: state.settings.submissions_open, disabled: phase !== 'collecting' });
    toggle.setAttribute('aria-label', '開放使用者提交電影');
    toggle.addEventListener('change', async () => {
      await runAction(async () => {
        const { error } = await supabase.from('app_settings').update({ submissions_open: toggle.checked }).eq('id', true);
        if (error) throw error;
        await loadData();
        setNotice(toggle.checked ? '已開放電影投稿。' : '已暫停電影投稿。');
      });
    });
    setting.append(copy, toggle);
    settingsPanel.append(setting);

    const divider = make('div', { className: 'divider' });
    settingsPanel.append(divider);
    if (phase === 'collecting') {
      const voteSetting = make('div', { className: 'field-row' });
      const group = make('div', { className: 'field-group' });
      group.append(make('label', { className: 'field-label', text: '每人可投幾票' }));
      const limit = make('select', { className: 'field vote-limit', name: 'votes_per_person', preserve: 'vote-limit' });
      const max = 5;
      for (let amount = 1; amount <= max; amount += 1) {
        const option = make('option', { value: amount, text: `${amount} 票` });
        option.selected = amount === Number(state.settings.votes_per_person);
        limit.append(option);
      }
      group.append(limit);
      const start = button('開始投票', '', async () => {
        const amount = Number(limit.value);
        if (!state.movies.length) {
          setNotice('至少需要一部電影才能開始投票。', true);
          return;
        }
        await runAction(async () => {
          const { error } = await supabase.rpc('admin_start_voting', { p_votes_per_person: amount });
          if (error) throw error;
          await loadData();
          setNotice('投票已開始，電影投稿已關閉。');
        });
      }, !state.movies.length || state.busy);
      voteSetting.append(group, start);
      settingsPanel.append(voteSetting);
      settingsPanel.append(make('p', { className: 'hint', text: '可設定每人 1–5 票；投票者可將多票分配給同一部電影。開始投票會清除上一輪票數。' }));
    } else if (phase === 'voting') {
      settingsPanel.append(button('結束投票', '', async () => {
        await runAction(async () => {
          const { error } = await supabase.rpc('admin_finish_voting');
          if (error) throw error;
          await loadData();
          setNotice('投票已結束，最終結果已公布。');
        });
      }, state.busy));
    } else {
      const actions = make('div', { className: 'admin-tools' });
      actions.append(button('重新投票', 'button-secondary', async () => {
        await runAction(async () => {
          const { error } = await supabase.rpc('admin_start_voting', {
            p_votes_per_person: Number(state.settings.votes_per_person),
          });
          if (error) throw error;
          await loadData();
          setNotice('已清除上一輪結果並重新開始投票。');
        });
      }, !state.movies.length || state.busy));
      settingsPanel.append(actions);
    }
    app.append(settingsPanel);

    const moviePanel = make('section', { className: 'panel' });
    const movieHeading = make('div', { className: 'panel-heading' });
    movieHeading.append(make('h2', { text: '目前所有電影' }), make('span', { className: 'count', text: `${state.movies.length} 部` }));
    moviePanel.append(movieHeading);
    if (!state.movies.length) {
      moviePanel.append(make('div', { className: 'empty-state', text: '目前沒有電影。' }));
    } else {
      const list = make('ul', { className: 'movie-list' });
      for (const movie of state.movies) list.append(adminMovie(movie));
      moviePanel.append(list);
    }
    app.append(moviePanel);

    const resetPanel = make('section', { className: 'panel' });
    resetPanel.append(make('p', { className: 'section-label', text: '重設社課資料' }));
    resetPanel.append(make('p', { className: 'hint', text: '刪除所有電影和投票紀錄，並重新開放投稿。此操作無法復原。' }));
    resetPanel.append(button('刪除目前所有資料', 'button-danger', async () => {
      if (!window.confirm('確定刪除所有電影和投票紀錄？此操作無法復原。')) return;
      await runAction(async () => {
        const { error } = await supabase.rpc('admin_clear_all');
        if (error) throw error;
        await loadData();
        setNotice('資料已清除，現在可以重新投稿。');
      });
    }, state.busy));
    app.append(resetPanel);
  }

  function adminMovie(movie) {
    const row = make('li', { className: 'movie-row' });
    const form = make('form', { className: 'admin-movie' });
    const fields = make('div', { className: 'admin-fields' });
    const title = make('input', { className: 'field', type: 'text', name: 'title', value: movie.title, required: true, placeholder: '電影名稱', preserve: `title-${movie.id}` });
    title.maxLength = 120;
    const duration = make('input', { className: 'field', type: 'text', name: 'duration', value: movie.duration || '', placeholder: '片長，例如 2 小時', preserve: `duration-${movie.id}` });
    duration.maxLength = 80;
    const speed = make('select', { className: 'field', name: 'speed', preserve: `speed-${movie.id}` });
    for (const value of ['1', '1.25']) {
      const option = make('option', { value, text: `${value} 倍速` });
      option.selected = Number(movie.speed) === Number(value);
      speed.append(option);
    }
    const titleGroup = make('div', { className: 'field-group' });
    titleGroup.append(make('label', { className: 'field-label', text: '電影名稱' }), title);
    const durationGroup = make('div', { className: 'field-group' });
    durationGroup.append(make('label', { className: 'field-label', text: '片長' }), duration);
    const speedGroup = make('div', { className: 'field-group' });
    speedGroup.append(make('label', { className: 'field-label', text: '播放倍速' }), speed);
    fields.append(titleGroup, durationGroup, speedGroup);
    const actions = make('div', { className: 'admin-actions' });
    actions.append(button('刪除此電影', 'button-danger button-small', async () => {
      if (!window.confirm(`確定刪除「${movie.title}」？`)) return;
      await runAction(async () => {
        const { error } = await supabase.from('movies').delete().eq('id', movie.id);
        if (error) throw error;
        await loadData();
        setNotice('電影已刪除。');
      });
    }, state.busy || state.settings.phase !== 'collecting'));
    actions.append(button('儲存編輯', 'button-secondary button-small', () => form.requestSubmit(), state.busy));
    form.append(fields, actions);
    if (state.settings.phase !== 'collecting') {
      form.append(make('p', { className: 'hint', text: '投票開始後不可刪除電影，以保留已投票者的紀錄。' }));
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const movieTitle = title.value.trim();
      if (!movieTitle) return;
      await runAction(async () => {
        const { error } = await supabase.from('movies')
          .update({ title: movieTitle, duration: duration.value.trim() || null, speed: Number(speed.value) })
          .eq('id', movie.id);
        if (error) throw error;
        await loadData();
        setNotice('電影資料已更新。');
      });
    });
    row.append(form);
    return row;
  }

  function voteCounts() {
    const counts = new Map();
    for (const vote of state.votes) {
      counts.set(vote.movie_id, (counts.get(vote.movie_id) || 0) + Number(vote.count || 1));
    }
    return counts;
  }

  function phaseText(phase) {
    if (phase === 'voting') return '投票進行中';
    if (phase === 'finished') return '投票已結束';
    return state.settings.submissions_open ? '開放投稿中' : '暫停投稿';
  }

  async function loadData() {
    state.loadError = '';
    const [moviesResult, settingsResult] = await Promise.all([
      supabase.from('movies').select('id,title,duration,speed,created_at').order('created_at', { ascending: true }),
      supabase.from('app_settings').select('id,submissions_open,phase,votes_per_person').eq('id', true).single(),
    ]);
    if (moviesResult.error) throw moviesResult.error;
    if (settingsResult.error) throw settingsResult.error;
    state.movies = moviesResult.data || [];
    state.settings = settingsResult.data;
    if (state.settings.phase !== 'collecting') {
      const { data, error } = await supabase.from('votes').select('movie_id');
      if (error) throw error;
      state.votes = data || [];
    } else {
      state.votes = [];
    }
    render();
  }

  async function runAction(action) {
    state.busy = true;
    render();
    try {
      await action();
    } catch (error) {
      console.error(error);
      setNotice(error?.message || '操作失敗，請稍後再試。', true);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function logout() {
    await runAction(async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      state.user = null;
      setNotice('已登出。');
      render();
    });
  }

  async function initialize() {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) {
      state.loadError = sessionError.message;
      render();
      return;
    }
    state.user = sessionData.session?.user?.email === ADMIN_EMAIL ? sessionData.session.user : null;
    supabase.auth.onAuthStateChange((_event, session) => {
      state.user = session?.user?.email === ADMIN_EMAIL ? session.user : null;
      render();
    });
    try {
      await loadData();
    } catch (error) {
      state.loadError = error?.message || '無法讀取資料，請確認 Supabase 設定。';
      render();
    }
    supabase.channel('movie-vote-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'movies' }, refreshQuietly)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, refreshQuietly)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes' }, refreshQuietly)
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setNotice('即時連線中斷，請重新整理頁面。', true);
        }
      });
  }

  async function refreshQuietly() {
    try {
      await loadData();
    } catch (error) {
      console.error(error);
      setNotice(error?.message || '即時更新失敗。', true);
    }
  }

  initialize();
}

main();

