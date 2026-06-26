/* ═══════════════════════════════════════════════════════════
   Dostt Leaderboard — frontend
   Handles: data fetch, render, auto-refresh, drift tracking
═══════════════════════════════════════════════════════════ */

// ── DOM refs ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const loading        = $('loading-state');
const errorBanner    = $('error-banner');
const tabToday       = $('tab-today');
const tabYesterday   = $('tab-yesterday');
const pendingCard    = $('pending-card');
const lbWrap         = $('lb-list');
const podiumEl       = $('podium');
const lbRows         = $('lb-rows');
const streakSection  = $('streak-section');
const refreshBtn     = $('refresh-btn');
const lastUpdatedEl  = $('last-updated');

// ── State ─────────────────────────────────────────────────────────
let yesterdayLoaded = false;
let todayData       = null;
let tickerInterval  = null;
let refreshInterval = null;


// ── Drift tracker ─────────────────────────────────────────────────
// Improved drift logic: tracks velocity across multiple polls
// to project time-to-rank and detect rank momentum.
const drift = {
  history: [], // [{time, myTalktime, myRank, gapToNextSecs}]
  maxHistory: 6,

  push(data) {
    if (!data || !data.qualified) return;
    this.history.push({
      time: Date.now(),
      myTalktime: data.my_talktime_secs || 0,
      myRank:     data.my_display_rank || null,
      gapToNextSecs: data.gap_to_next_secs || 0
    });
    if (this.history.length > this.maxHistory) this.history.shift();
  },

  // Talktime seconds earned per real second (smoothed over last 2 polls)
  velocityPerSec() {
    if (this.history.length < 2) return null;
    const a = this.history[this.history.length - 2];
    const b = this.history[this.history.length - 1];
    const dtSec = (b.time - a.time) / 1000;
    if (dtSec < 1) return null;
    const dTalk = b.myTalktime - a.myTalktime;
    return dTalk / dtSec;
  },

  // Smoothed velocity over all history for stable projections
  velocitySmoothed() {
    if (this.history.length < 2) return null;
    const first = this.history[0];
    const last  = this.history[this.history.length - 1];
    const dtSec = (last.time - first.time) / 1000;
    if (dtSec < 1) return null;
    const dTalk = last.myTalktime - first.myTalktime;
    return dTalk / dtSec;
  },

  // Minutes of real time to close current gap at smoothed velocity
  minsToNextRank(gapSecs) {
    const v = this.velocitySmoothed();
    if (!v || v <= 0 || !gapSecs || gapSecs <= 0) return null;
    return Math.round(gapSecs / v / 60);
  },

  // Positive = rank improved (lower number = better), negative = got worse
  rankDelta() {
    if (this.history.length < 2) return 0;
    const a = this.history[this.history.length - 2];
    const b = this.history[this.history.length - 1];
    if (a.myRank === null || b.myRank === null) return 0;
    return a.myRank - b.myRank;
  },

  // Gap trend: negative = gap is closing (good), positive = opening (bad)
  gapTrend() {
    if (this.history.length < 2) return 0;
    const a = this.history[this.history.length - 2];
    const b = this.history[this.history.length - 1];
    return b.gapToNextSecs - a.gapToNextSecs;
  },

  // Estimated talktime right now (interpolated since last poll)
  estimateLiveTalktime(baseTime, baseTalktime) {
    const v = this.velocityPerSec();
    if (!v) return baseTalktime;
    const elapsed = (Date.now() - baseTime) / 1000;
    return Math.round(baseTalktime + v * elapsed);
  }
};

// ── Helpers ───────────────────────────────────────────────────────
function fmtTalktime(secs) {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

function fmtTalktimeLong(secs) {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
  return `${m}m ${String(sec).padStart(2,'0')}s`;
}

function rankClass(rank) {
  if (rank === 1) return 'r1';
  if (rank === 2) return 'r2';
  if (rank === 3) return 'r3';
  return '';
}

function rankLabel(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return '#' + rank;
}

function rewardForRank(rank) {
  if (rank === 1) return '₹1,500';
  if (rank === 2) return '₹1,000';
  if (rank === 3) return '₹500';
  return '—';
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove('hidden');
  setTimeout(() => errorBanner.classList.add('hidden'), 6000);
}

function setLoading(on) {
  loading.classList.toggle('hidden', !on);
}

function dayAbbr(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return ['S','M','T','W','T','F','S'][d.getDay()];
}

// ── Tab switching ──────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    tabToday.classList.toggle('hidden', tab !== 'today');
    tabYesterday.classList.toggle('hidden', tab !== 'yesterday');

    if (tab === 'yesterday' && !yesterdayLoaded) loadYesterday();
  });
});

$('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

refreshBtn.addEventListener('click', async () => {
  if (refreshBtn.classList.contains('spinning')) return;
  refreshBtn.classList.add('spinning');
  await loadToday();
  refreshBtn.classList.remove('spinning');
});

$('terms-btn').addEventListener('click', () => {
  $('terms-page').classList.remove('hidden');
  window.scrollTo(0, 0);
});

$('terms-back-btn').addEventListener('click', () => {
  $('terms-page').classList.add('hidden');
});

// ── Today ─────────────────────────────────────────────────────────
async function loadToday() {
  try {
    const res = await fetch('/api/leaderboard/today');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    todayData = data;
    drift.push(data);
    renderToday(data);
    loadStreak();
    startLiveTicker(data);
  } catch (err) {
    showError('Could not load leaderboard — retrying in 10 minutes.');
    console.error(err);
  }
}

function renderToday(data) {
  setLoading(false);

  if (data.last_refreshed_at && lastUpdatedEl) {
    lastUpdatedEl.textContent = 'Updated ' + data.last_refreshed_at;
    lastUpdatedEl.classList.remove('hidden');
  }

  if (!data.qualified) {
    renderPending(data);
    return;
  }

  pendingCard.classList.add('hidden');
  renderPool(data);
}

function renderPending(data) {
  lbWrap.classList.add('hidden');
  podiumEl.classList.add('hidden');
  pendingCard.classList.remove('hidden');

  const secs = data.my_talktime_secs || 0;
  const pct  = data.progress_percent != null ? data.progress_percent : Math.min(99, Math.floor((secs / 600) * 100));
  const bar  = $('pending-bar');
  bar.style.width = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = pct + '%'; }));
  $('pending-label').textContent = `${data.my_talktime_display || fmtTalktime(secs)} / 10m`;
}

function renderPool(data) {
  if ((!data.top3 || !data.top3.length) && (!data.pool_below || !data.pool_below.length)) {
    lbWrap.classList.add('hidden');
    podiumEl.classList.add('hidden');
    return;
  }

  const prevPool = drift.history.length >= 2
    ? (drift.history[drift.history.length - 2] || null)
    : null;

  renderPodium(data);
  renderFlatRows(data, prevPool);
}

function renderPodium(data) {
  const top3 = data.top3 || [];
  if (!top3.length) { podiumEl.classList.add('hidden'); return; }

  podiumEl.classList.remove('hidden');

  const slots = {};
  top3.forEach(m => { slots[m.display_rank] = m; });

  const rewardMap    = { 1: '₹1,500', 2: '₹1,000', 3: '₹500' };
  const medalColors  = { 1: 'var(--gold)', 2: 'var(--silver)', 3: 'var(--bronze)' };

  function slotHTML(rank) {
    const m = slots[rank];
    if (!m) return `<div class="podium-slot p${rank} empty"></div>`;
    const isMe = m.is_me;
    const avatarIdx = (Number(m.user_id) % 3) + 1;
    const crown = rank === 1 ? `<div class="podium-crown">👑</div>` : '';
    return `
      <div class="podium-slot p${rank}${isMe ? ' is-me' : ''}">
        ${crown}
        <div class="podium-circle r${rank}${isMe ? ' me' : ''}">
          <img class="podium-avatar" src="/brand/avatar${avatarIdx}.jpeg" alt="">
          <span class="podium-rank-badge rb${rank}">${rank}</span>
        </div>
        <div class="podium-tt">${fmtTalktime(m.talktime_secs)}</div>
        <div class="podium-rew" style="color:${medalColors[rank]}">${rewardMap[rank]}</div>
        ${isMe ? `<div class="podium-you-label">You</div>` : ''}
      </div>
    `;
  }

  // DOM order: p2 (left), p1 (center), p3 (right) — CSS order property elevates p1
  podiumEl.innerHTML = slotHTML(2) + slotHTML(1) + slotHTML(3);
}

function renderFlatRows(data, prevPool) {
  const rest = data.pool_below || [];
  lbRows.innerHTML = '';

  if (!rest.length) {
    lbWrap.classList.add('hidden');
    return;
  }

  lbWrap.classList.remove('hidden');
  const maxTime = data.max_talktime_secs || 1;

  // Compute lead over next from pool data
  const myPoolRow       = rest.find(m => m.is_me);
  const nextBelow       = myPoolRow ? rest.find(m => m.display_rank === myPoolRow.display_rank + 1) : null;
  const leadOverNextSecs = myPoolRow && nextBelow
    ? Math.max(0, myPoolRow.talktime_secs - nextBelow.talktime_secs) : 0;

  rest.forEach((member, idx) => {
    const isMe = member.is_me;
    const rank = member.display_rank;
    const pct  = Math.max(4, (member.talktime_secs / maxTime) * 100);

    const row = document.createElement('div');
    row.className = 'lb-row' + (isMe ? ' is-me' : '');
    row.dataset.userId = member.user_id;
    row.style.setProperty('--i', idx);

    // Build inline gap/lead hint for the YOU row so it stays inside the sticky element
    let meHint = '';
    if (isMe) {
      if (data.my_display_rank > 1 && data.gap_to_next_secs > 0 && data.gap_to_next_rank) {
        const gapMins = Math.ceil(data.gap_to_next_secs / 60);
        const eta = drift.minsToNextRank(data.gap_to_next_secs);
        meHint = `<div class="lb-me-hint">
          <strong>${gapMins}m</strong> behind #${data.gap_to_next_rank}
          ${eta ? `· ~${eta}m at pace` : ''}
        </div>`;
      } else if (leadOverNextSecs > 0) {
        meHint = `<div class="lb-me-hint lb-me-hint--lead">
          ${fmtTalktime(leadOverNextSecs)} ahead of #${(data.my_display_rank || 0) + 1}
        </div>`;
      }
    }

    row.innerHTML = `
      <div class="lb-rank">
        <span class="lb-rank-num">#${rank}</span>
        <span class="lb-you-chip">YOU</span>
      </div>
      <div class="lb-talktime">
        <div class="lb-bar-track">
          <div class="lb-bar-fill ${isMe ? 'me' : 'other'}" style="width:0%" data-target="${pct.toFixed(1)}"></div>
        </div>
        <div class="lb-bar-label">${fmtTalktime(member.talktime_secs)}</div>
        ${meHint}
      </div>
    `;

    lbRows.appendChild(row);
  });

  requestAnimationFrame(() => {
    document.querySelectorAll('.lb-bar-fill[data-target]').forEach(bar => {
      bar.style.transition = 'width 0.8s cubic-bezier(0.4,0,0.2,1)';
      bar.style.width = bar.dataset.target + '%';
    });

    // Start list from top — sticky keeps the YOU row visible at bottom
    lbWrap.scrollTop = 0;
  });

  const delta = drift.rankDelta();
  if (prevPool && delta !== 0) {
    const meRow = lbRows.querySelector('.lb-row.is-me');
    if (meRow) {
      const cls = delta > 0 ? 'rank-up' : 'rank-down';
      meRow.classList.add(cls);
      setTimeout(() => meRow.classList.remove(cls), 700);
    }
  }
}

// ── Live ticker — interpolates talktime between polls ─────────────
let tickerBase = { time: Date.now(), talktime: 0 };

function startLiveTicker(data) {
  if (tickerInterval) clearInterval(tickerInterval);
  if (!data.qualified) return;

  tickerBase = { time: Date.now(), talktime: data.my_talktime_secs };

  tickerInterval = setInterval(() => {
    if (!todayData || !todayData.qualified) return;
    const est = drift.estimateLiveTalktime(tickerBase.time, tickerBase.talktime);
    const meLabel = lbRows.querySelector('.lb-row.is-me .lb-bar-label');
    if (meLabel) meLabel.textContent = fmtTalktime(est);
  }, 1000);
}

// ── Streak ─────────────────────────────────────────────────────────
async function loadStreak() {
  renderStreak(null); // show section immediately with empty state
  try {
    const res = await fetch('/api/leaderboard/streak');
    if (!res.ok) return;
    const data = await res.json();
    if (data) renderStreak(data);
  } catch {
    // real data unavailable — section visible with empty state
  }
}

function renderStreak(data) {
  streakSection.classList.remove('hidden');

  const days     = data && data.days ? data.days : Array(7).fill(false);
  const streak   = data ? Number(data.current_streak) : 0;
  const daysTo   = data ? Number(data.days_to_bonus)  : 7;

  // dots 1–7: filled in order as streak grows; dot N = streak day N
  const tilesHtml = Array.from({ length: 7 }, (_, idx) => {
    const dayNum   = idx + 1;
    const filled   = dayNum <= streak;
    const isLatest = dayNum === streak;
    const cls      = filled ? (isLatest ? 'today-filled' : 'filled') : 'empty';

    return `
      <div class="streak-tile">
        <div class="streak-tile-dot ${cls}">${filled ? '✓' : ''}</div>
        <div class="streak-tile-day">${dayNum}</div>
      </div>
    `;
  }).join('');

  const bonusMsg = daysTo > 0
    ? `<span>${daysTo} day${daysTo !== 1 ? 's' : ''} to ₹100 bonus</span>`
    : `<span style="color:var(--accent)">🎉 Bonus unlocked!</span>`;

  streakSection.innerHTML = `
    <div class="streak-heading">7-Day Streak</div>
    <div class="streak-tiles">${tilesHtml}</div>
    <div class="streak-stats">
      <div class="streak-count">
        <span>${streak}</span>day${streak !== 1 ? 's' : ''} streak
      </div>
      <div class="streak-to-bonus">${bonusMsg}</div>
    </div>
  `;
}

// ── Yesterday ─────────────────────────────────────────────────────
async function loadYesterday() {
  yesterdayLoaded = true;
  const content = $('yesterday-content');
  content.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>`;

  try {
    const res = await fetch('/api/leaderboard/yesterday');
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderYesterday(data, content);
  } catch {
    content.innerHTML = `<div class="yest-empty">Could not load yesterday's data.</div>`;
  }
}

function renderYesterday(data, container) {
  if (!data || data.launch_day) {
    container.innerHTML = `
      <div class="yest-launch-day">
        <div class="yest-launch-icon">🎉</div>
        <div class="yest-launch-title">Welcome to Dostt Leaderboard!</div>
        <div class="yest-launch-sub">This is Day 1. Come back tomorrow to see your finish position and streak.</div>
      </div>`;
    return;
  }
  if (!data.talktime_secs) {
    container.innerHTML = `<div class="yest-empty">No data yet — come back tomorrow.</div>`;
    return;
  }

  const rankCard = data.display_rank != null ? `
    <div class="yest-card">
      <div class="yest-card-icon">🏅</div>
      <div class="yest-card-body">
        <div class="yest-card-label">Finish position</div>
        <div class="yest-card-value">Rank #${data.display_rank}</div>
      </div>
    </div>` : `
    <div class="yest-card yest-card--muted">
      <div class="yest-card-icon">🏅</div>
      <div class="yest-card-body">
        <div class="yest-card-label">Finish position</div>
        <div class="yest-card-value yest-card-value--dim">Available tomorrow</div>
      </div>
    </div>`;

  container.innerHTML = `
    <div class="yest-grid">
      <div class="yest-card">
        <div class="yest-card-icon"><img src="/brand/Phone.png" alt=""></div>
        <div class="yest-card-body">
          <div class="yest-card-label">Talktime yesterday</div>
          <div class="yest-card-value">${data.talktime_display}</div>
        </div>
      </div>
      ${rankCard}
    </div>
  `;
}

// ── Auto-refresh every 10 minutes ─────────────────────────────────
function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    await loadToday();
  }, 10 * 60 * 1000);
}

// ── Mode picker ────────────────────────────────────────────────────
const modePage = $('mode-page');
const modeChip = $('mode-chip');

function applyModeChip(mode) {
  if (!modeChip) return;
  modeChip.textContent = mode === 'test' ? 'TEST' : 'LIVE';
  modeChip.className = `mode-chip ${mode}`;
}

async function startLeaderboard() {
  setLoading(true);
  await loadToday();
  startAutoRefresh();
}

// ── Boot ──────────────────────────────────────────────────────────
(async function init() {
  const res  = await fetch('/api/auth/mode');
  const { mode, show_chip } = await res.json();

  if (!mode) {
    modePage.classList.remove('hidden');
    modePage.querySelectorAll('.mode-card').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.classList.add('picking');
        await fetch('/api/auth/set-mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: btn.dataset.mode })
        });
        modePage.classList.add('hidden');
        if (show_chip) applyModeChip(btn.dataset.mode);
        startLeaderboard();
      });
    });
    return;
  }

  if (show_chip) applyModeChip(mode);
  startLeaderboard();
})();
