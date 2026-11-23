import { createClient } from './api-client.js';

const app = document.querySelector('#app');
const ADMIN_EMAIL = 'nfirc@nfirc.local';
async function main() {
  const contentResponse = await fetch('/content.json', { cache: 'no-cache' });
  if (!contentResponse.ok) throw new Error(`Failed to load content.json (${contentResponse.status}).`);
  const content = await contentResponse.json();
  const text = (key, values) => {
    const template = key.split('.').reduce((value, part) => value?.[part], content);
    if (typeof template !== 'string') throw new Error(`Missing content string: ${key}`);
    return template.replace(/\{(\w+)\}/g, (_match, name) => String(values?.[name] ?? ''));
  };
  document.title = content.documentTitle;
  const initialLoading = app.querySelector('.loading');
  if (initialLoading) initialLoading.textContent = text('common.loadingPage');
  const supabase = createClient(content);
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
      if (options.src) element.src = options.src;
      if (options.alt !== undefined) element.alt = options.alt;
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
      if (status) status.textContent = text('common.voteAllocation', { count: allocated, allowed });
      const submit = ballot.querySelector('button[type="submit"]');
      if (submit) submit.disabled = allocated !== allowed || state.busy;
    }
    if (saved.focused) app.querySelector(`[data-preserve="${CSS.escape(saved.focused)}"]`)?.focus();
  }

  function movieMetadata(movie) {
    return [movie.duration, text('common.movieSpeed', { speed: Number(movie.speed || 1) })].filter(Boolean).join(' · ');
  }

  function render() {
    const saved = preserveInputs();
    app.replaceChildren();
    const header = make('header', { className: 'topbar' });
    const brand = make('a', { className: 'brand', href: '/', ariaLabel: text('common.homeAriaLabel') });
    brand.append(make('img', { className: 'brand-mark', src: '/nfirc_logo.png', alt: text('logoAlt') }), make('span', { text: text('brandName') }));
    header.append(brand);
    if (isAdminPage && state.user) {
      header.append(button(text('common.logout'), 'button-secondary button-small', logout));
    } else if (!isAdminPage) {
      header.append(make('a', { className: 'text-link', href: '/admin', text: text('common.adminLink') }));
    } else {
      header.append(make('a', { className: 'text-link', href: '/', text: text('common.voterLink') }));
    }
    app.append(header);

    if (state.loadError) {
      app.append(make('section', { className: 'panel' }));
      const error = app.querySelector('.panel');
      error.append(make('p', { className: 'notice notice-error', text: state.loadError }));
      error.append(button(text('common.reload'), 'button-secondary', () => loadData()));
    } else if (!state.settings) {
      app.append(make('p', { className: 'loading', text: text('common.loadingData') }));
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
    app.append(make('p', { className: 'footer-note', text: text('common.footer') }));
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
      const meta = movieMetadata(movie);
      if (meta) details.append(make('span', { className: 'movie-meta', text: meta }));
      row.append(details);
      if (showResults) row.append(make('span', { className: 'movie-score', text: text('common.movieScore', { count: counts.get(movie.id) || 0 }) }));
      list.append(row);
    }
    return list;
  }

  function renderVoter() {
    const phase = state.settings.phase;
    const title = phase === 'collecting' ? text('voter.collectingTitle') : text('voter.votingTitle');
    const description = phase === 'collecting'
      ? text('voter.collectingDescription')
      : text('voter.votingDescription');
    app.append(hero(text('voter.heroLabel'), title, description, phaseText(phase)));
    const count = make('span', { className: 'count', text: text('common.movieCount', { count: state.movies.length }) });
    const listPanel = panel(phase === 'collecting' ? text('voter.candidateList') : text('voter.liveResults'), count);
    if (state.movies.length) {
      listPanel.append(movieList(voteCounts(), phase !== 'collecting'));
    } else {
      listPanel.append(make('div', { className: 'empty-state', text: phase === 'collecting' ? text('voter.emptyCollecting') : text('voter.emptyVoting') }));
    }
    app.append(listPanel);

    if (phase === 'collecting' && state.settings.submissions_open) {
      renderSubmission();
    } else if (phase === 'voting') {
      renderBallot();
    } else if (phase === 'collecting') {
      const paused = make('section', { className: 'panel' });
      paused.append(make('p', { className: 'hint', text: text('voter.submissionsPaused') }));
      app.append(paused);
    } else {
      app.append(make('p', { className: 'hint', text: text('voter.finished') }));
    }
  }

  function renderSubmission() {
    const section = make('section', { className: 'panel' });
    section.append(make('p', { className: 'section-label', text: text('voter.addMovie') }));
    const form = make('form', { className: 'field-row' });
    const title = make('input', {
      className: 'field',
      type: 'text',
      name: 'title',
      placeholder: text('voter.moviePlaceholder'),
      required: true,
      max: 120,
      preserve: 'new-movie-title',
    });
    title.maxLength = 120;
    const submit = make('button', { className: 'button', type: 'submit', text: text('voter.submitMovie'), disabled: state.busy });
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
        setNotice(text('voter.movieSubmitted'));
      });
    });
    section.append(form);
    app.append(section);
  }

  function renderBallot() {
    const section = make('section', { className: 'panel' });
    const allowed = Number(state.settings.votes_per_person);
    section.append(make('p', { className: 'section-label', text: text('voter.ballotPrompt', { count: allowed }) }));
    if (!state.movies.length) {
      section.append(make('p', { className: 'hint', text: text('voter.emptyVoting') }));
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
      const metadata = movieMetadata(movie);
      movieInfo.append(make('span', { className: 'movie-meta', text: metadata }));
      const voteCount = make('input', {
        className: 'field vote-limit',
        type: 'number',
        name: 'movieVotes',
        value: 0,
        min: 0,
        max: allowed,
        step: 1,
        ariaLabel: text('voter.voteCountAriaLabel', { title: movie.title }),
        preserve: `vote-${movie.id}`,
      });
      voteCount.dataset.movieId = movie.id;
      row.append(movieInfo, voteCount);
      list.append(row);
    }
    const status = make('p', { className: 'hint', text: text('voter.voteAllocation', { count: 0, allowed }) });
    const submit = make('button', { className: 'button', type: 'submit', text: text('voter.submitBallot'), disabled: state.busy });
    list.addEventListener('input', () => {
      const total = [...list.querySelectorAll('input[type="number"]')]
        .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
      status.textContent = text('voter.voteAllocation', { count: total, allowed });
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
        setNotice(text('voter.voteSubmitted'));
      });
    });
    section.append(form);
    app.append(section);
  }

  function renderLogin() {
    app.append(hero(text('admin.loginHeroLabel'), text('admin.loginTitle'), text('admin.loginDescription')));
    const section = make('section', { className: 'panel' });
    const form = make('form');
    const usernameGroup = make('div', { className: 'field-group' });
    usernameGroup.append(make('label', { className: 'field-label', text: text('admin.usernameLabel') }));
    const username = make('input', { className: 'field', type: 'text', name: 'username', placeholder: text('admin.usernamePlaceholder'), autocomplete: 'username', required: true, preserve: 'admin-username' });
    usernameGroup.append(username);
    const passwordGroup = make('div', { className: 'field-group' });
    passwordGroup.append(make('label', { className: 'field-label', text: text('admin.passwordLabel') }));
    const password = make('input', { className: 'field', type: 'password', name: 'password', placeholder: text('admin.passwordPlaceholder'), autocomplete: 'current-password', required: true, preserve: 'admin-password' });
    passwordGroup.append(password);
    form.append(usernameGroup, passwordGroup);
    form.className = 'login-form';
    const submit = make('button', { className: 'button', type: 'submit', text: text('admin.loginButton'), disabled: state.busy });
    submit.style.marginTop = '16px';
    form.append(submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (username.value.trim() !== 'nfirc') {
        setNotice(text('admin.invalidCredentials'), true);
        return;
      }
      await runAction(async () => {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: ADMIN_EMAIL,
          password: password.value,
        });
        if (error || data.user?.email !== ADMIN_EMAIL) throw new Error(text('admin.invalidCredentials'));
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
    app.append(hero(text('admin.heroLabel'), text('admin.title'), text('admin.description'), phaseText(phase)));
    const settingsPanel = make('section', { className: 'panel' });
    const heading = make('div', { className: 'panel-heading' });
    heading.append(make('h2', { text: text('admin.settings') }));
    settingsPanel.append(heading);

    const setting = make('div', { className: 'setting-row' });
    const copy = make('div', { className: 'setting-copy' });
    copy.append(make('strong', { text: text('admin.submissionToggle') }), make('span', { text: phase === 'collecting' ? text('admin.submissionCollectingHelp') : text('admin.submissionVotingHelp') }));
    const toggle = make('input', { className: 'switch', type: 'checkbox', name: 'submissions_open', preserve: 'submissions-open', checked: state.settings.submissions_open, disabled: phase !== 'collecting' });
    toggle.setAttribute('aria-label', text('admin.submissionToggle'));
    toggle.addEventListener('change', async () => {
      await runAction(async () => {
        const { error } = await supabase.from('app_settings').update({ submissions_open: toggle.checked }).eq('id', true);
        if (error) throw error;
        await loadData();
        setNotice(toggle.checked ? text('admin.submissionOpened') : text('admin.submissionClosed'));
      });
    });
    setting.append(copy, toggle);
    settingsPanel.append(setting);

    const divider = make('div', { className: 'divider' });
    settingsPanel.append(divider);
    if (phase === 'collecting') {
      const voteSetting = make('div', { className: 'field-row' });
      const group = make('div', { className: 'field-group' });
      group.append(make('label', { className: 'field-label', text: text('admin.votesPerPerson') }));
      const limit = make('select', { className: 'field vote-limit', name: 'votes_per_person', preserve: 'vote-limit' });
      const max = 5;
      for (let amount = 1; amount <= max; amount += 1) {
        const option = make('option', { value: amount, text: text('admin.voteOption', { count: amount }) });
        option.selected = amount === Number(state.settings.votes_per_person);
        limit.append(option);
      }
      group.append(limit);
      const start = button(text('admin.startVoting'), '', async () => {
        const amount = Number(limit.value);
        if (!state.movies.length) {
          setNotice(text('admin.noMoviesToStart'), true);
          return;
        }
        await runAction(async () => {
          const { error } = await supabase.rpc('admin_start_voting', { p_votes_per_person: amount });
          if (error) throw error;
          await loadData();
          setNotice(text('admin.votingStarted'));
        });
      }, !state.movies.length || state.busy);
      voteSetting.append(group, start);
      settingsPanel.append(voteSetting);
      settingsPanel.append(make('p', { className: 'hint', text: text('admin.votingHelp') }));
    } else if (phase === 'voting') {
      settingsPanel.append(button(text('admin.finishVoting'), '', async () => {
        await runAction(async () => {
          const { error } = await supabase.rpc('admin_finish_voting');
          if (error) throw error;
          await loadData();
          setNotice(text('admin.votingFinished'));
        });
      }, state.busy));
    } else {
      const actions = make('div', { className: 'admin-tools' });
      actions.append(button(text('admin.revote'), 'button-secondary', async () => {
        await runAction(async () => {
          const { error } = await supabase.rpc('admin_start_voting', {
            p_votes_per_person: Number(state.settings.votes_per_person),
          });
          if (error) throw error;
          await loadData();
          setNotice(text('admin.revoteStarted'));
        });
      }, !state.movies.length || state.busy));
      settingsPanel.append(actions);
    }
    app.append(settingsPanel);

    const moviePanel = make('section', { className: 'panel' });
    const movieHeading = make('div', { className: 'panel-heading' });
    movieHeading.append(make('h2', { text: text('admin.allMovies') }), make('span', { className: 'count', text: text('common.adminMovieCount', { count: state.movies.length }) }));
    moviePanel.append(movieHeading);
    if (!state.movies.length) {
      moviePanel.append(make('div', { className: 'empty-state', text: text('admin.noMovies') }));
    } else {
      const list = make('ul', { className: 'movie-list' });
      for (const movie of state.movies) list.append(adminMovie(movie));
      moviePanel.append(list);
    }
    app.append(moviePanel);

    const resetPanel = make('section', { className: 'panel' });
    resetPanel.append(make('p', { className: 'section-label', text: text('admin.resetHeading') }));
    resetPanel.append(make('p', { className: 'hint', text: text('admin.resetHelp') }));
    resetPanel.append(button(text('admin.resetButton'), 'button-danger', async () => {
      if (!window.confirm(text('admin.confirmReset'))) return;
      await runAction(async () => {
        const { error } = await supabase.rpc('admin_clear_all');
        if (error) throw error;
        await loadData();
        setNotice(text('admin.resetComplete'));
      });
    }, state.busy));
    app.append(resetPanel);
  }

  function adminMovie(movie) {
    const row = make('li', { className: 'movie-row' });
    const form = make('form', { className: 'admin-movie' });
    const fields = make('div', { className: 'admin-fields' });
    const title = make('input', { className: 'field', type: 'text', name: 'title', value: movie.title, required: true, placeholder: text('admin.movieTitlePlaceholder'), preserve: `title-${movie.id}` });
    title.maxLength = 120;
    const duration = make('input', { className: 'field', type: 'text', name: 'duration', value: movie.duration || '', placeholder: text('admin.durationPlaceholder'), preserve: `duration-${movie.id}` });
    duration.maxLength = 80;
    const speed = make('select', { className: 'field', name: 'speed', preserve: `speed-${movie.id}` });
    for (const value of ['1', '1.25']) {
      const option = make('option', { value, text: text('admin.speedOption', { speed: value }) });
      option.selected = Number(movie.speed) === Number(value);
      speed.append(option);
    }
    const titleGroup = make('div', { className: 'field-group' });
    titleGroup.append(make('label', { className: 'field-label', text: text('admin.movieTitleLabel') }), title);
    const durationGroup = make('div', { className: 'field-group' });
    durationGroup.append(make('label', { className: 'field-label', text: text('admin.durationLabel') }), duration);
    const speedGroup = make('div', { className: 'field-group' });
    speedGroup.append(make('label', { className: 'field-label', text: text('admin.speedLabel') }), speed);
    fields.append(titleGroup, durationGroup, speedGroup);
    const actions = make('div', { className: 'admin-actions' });
    actions.append(button(text('admin.deleteMovie'), 'button-danger button-small', async () => {
      if (!window.confirm(text('admin.confirmDeleteMovie', { title: movie.title }))) return;
      await runAction(async () => {
        const { error } = await supabase.from('movies').delete().eq('id', movie.id);
        if (error) throw error;
        await loadData();
        setNotice(text('admin.movieDeleted'));
      });
    }, state.busy || state.settings.phase !== 'collecting'));
    actions.append(button(text('admin.saveMovie'), 'button-secondary button-small', () => form.requestSubmit(), state.busy));
    form.append(fields, actions);
    if (state.settings.phase !== 'collecting') {
      form.append(make('p', { className: 'hint', text: text('admin.editingDisabled') }));
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
        setNotice(text('admin.movieSaved'));
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
    if (phase === 'voting') return text('phase.voting');
    if (phase === 'finished') return text('phase.finished');
    return state.settings.submissions_open ? text('phase.collecting') : text('phase.submissionsPaused');
  }

  async function loadData() {
    const hadLoadError = Boolean(state.loadError);
    const [moviesResult, settingsResult] = await Promise.all([
      supabase.from('movies').select('id,title,duration,speed,created_at').order('created_at', { ascending: true }),
      supabase.from('app_settings').select('id,submissions_open,phase,votes_per_person').eq('id', true).single(),
    ]);
    if (moviesResult.error) throw moviesResult.error;
    if (settingsResult.error) throw settingsResult.error;
    const movies = moviesResult.data || [];
    const settings = settingsResult.data;
    let votes = [];
    if (settings.phase !== 'collecting') {
      const { data, error } = await supabase.from('votes').select('movie_id');
      if (error) throw error;
      votes = data || [];
    }
    const sortedVotes = (items) => [...items].sort((left, right) => left.movie_id.localeCompare(right.movie_id));
    const changed = hadLoadError
      || JSON.stringify(state.movies) !== JSON.stringify(movies)
      || JSON.stringify(state.settings) !== JSON.stringify(settings)
      || JSON.stringify(sortedVotes(state.votes)) !== JSON.stringify(sortedVotes(votes));
    state.loadError = '';
    state.movies = movies;
    state.settings = settings;
    state.votes = votes;
    if (changed) render();
  }

  async function runAction(action) {
    state.busy = true;
    render();
    try {
      await action();
    } catch (error) {
      console.error(error);
      setNotice(error?.message || text('common.actionFailed'), true);
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
      setNotice(text('common.loggedOut'));
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
      state.loadError = error?.message || text('common.dataLoadFailed');
      render();
    }
    supabase.channel('movie-vote-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'movies' }, refreshQuietly)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, refreshQuietly)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes' }, refreshQuietly)
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setNotice(text('common.realtimeDisconnected'), true);
        }
      });
  }

  async function refreshQuietly() {
    try {
      await loadData();
    } catch (error) {
      console.error(error);
      setNotice(error?.message || text('common.liveUpdateFailed'), true);
    }
  }

  initialize();
}

main().catch((error) => {
  console.error('Failed to load the website content.', error);
  const loading = app.querySelector('.loading');
  if (loading) loading.textContent = '無法載入網站文字，請重新整理頁面。';
});

