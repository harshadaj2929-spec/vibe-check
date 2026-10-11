/* ═══════════════════════════════════════════════════════════════════
   Vibe Check — app.js  (v2)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── Global state ─────────────────────────────────────────────────────────────
let currentComments   = [];
let currentClassified = [];
let activeFlagFilter      = 'all';
let activeSentimentFilter = 'all';
const STEPS = ['fetching','classifying','aggregating','insight','similar_video','comparing'];

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function getSavedData() {
  try { return JSON.parse(sessionStorage.getItem('vibeData')); } catch { return null; }
}

function showError(msg) {
  $('errorMsg').textContent = msg;
  $('errorToast').hidden = false;
}
function clearError() { $('errorToast').hidden = true; }

// ── Cold-start detection ──────────────────────────────────────────────────────
(async function checkServer() {
  const start = Date.now();
  let up = false;
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    up = r.ok;
  } catch { /* server sleeping */ }

  if (!up) {
    const banner = $('coldStartBanner');
    const bar    = $('coldBar');
    banner.hidden = false;
    const WARMUP = 35000; // ms
    const tick = setInterval(() => {
      const pct = Math.min(100, (Date.now() - start) / WARMUP * 100);
      bar.style.width = pct + '%';
      if (pct >= 100) {
        clearInterval(tick);
        banner.hidden = true;
      }
    }, 300);

    // Retry until alive
    const retry = setInterval(async () => {
      try {
        const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
        if (r.ok) { clearInterval(retry); clearInterval(tick); banner.hidden = true; }
      } catch { /* still sleeping */ }
    }, 4000);
  }
})();

// ── SPA Router ────────────────────────────────────────────────────────────────
function navigate() {
  const hash = window.location.hash || '#/home';
  document.querySelectorAll('.page-view').forEach(p => { p.hidden = true; });
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

  let pageId = 'page-home';
  if (hash === '#/comments')      pageId = 'page-comments';
  if (hash === '#/similar-video') pageId = 'page-similar';
  if (hash === '#/comparison')    pageId = 'page-comparison';
  if (hash === '#/ask-comments')  pageId = 'page-ask-comments';

  $(pageId).hidden = false;
  const link = document.querySelector(`.nav-link[href="${hash}"]`);
  if (link) link.classList.add('active');

  renderPage(pageId);
}
window.addEventListener('hashchange', navigate);
document.addEventListener('DOMContentLoaded', navigate);

// ── Page renderers ────────────────────────────────────────────────────────────
function renderPage(pageId) {
  const data = getSavedData();
  if (data?.raw_comments)   currentComments   = data.raw_comments;
  if (data?.classified_comments) currentClassified = data.classified_comments;

  switch (pageId) {
    case 'page-home':
      if (data) populateHomeData(data);
      break;
    case 'page-comments':
      if (!data) { $('empty-comments-list').hidden = false; $('comments-list-results').hidden = true; }
      else       { $('empty-comments-list').hidden = true;  $('comments-list-results').hidden = false; renderCategorizedComments(data); }
      break;
    case 'page-similar':
      renderSimilarPage(data);
      break;
    case 'page-comparison':
      renderComparisonPage(data);
      break;
    case 'page-ask-comments':
      if (!data) { $('empty-ask-comments').hidden = false; $('ask-comments-results').hidden = true; }
      else       { $('empty-ask-comments').hidden = true;  $('ask-comments-results').hidden = false; }
      break;
  }
}

// ── Count-up animation ────────────────────────────────────────────────────────
function countUp(el, target, suffix = '%', dur = 800) {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || target === 0) { el.textContent = target + suffix; return; }
  const start = Date.now();
  const raf = () => {
    const t = Math.min(1, (Date.now() - start) / dur);
    el.textContent = Math.round(t * target) + suffix;
    if (t < 1) requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}

// ── Home population ───────────────────────────────────────────────────────────
function populateHomeData(data) {
  $('home-results').hidden = false;

  // Vibe score + needle
  const score = data.vibe_score || 0;
  $('vibeScoreLabel').textContent = score;
  $('arcScoreBadge').textContent  = score;
  const needleAngle = (score / 100) * 180;
  $('arcNeedle').setAttribute('transform', `rotate(${needleAngle}, 130, 130)`);

  // Equaliser bars
  const eq = $('eqContainer');
  eq.innerHTML = '';
  for (let i = 0; i < 20; i++) {
    const bar = document.createElement('div');
    bar.className = 'eq-bar';
    const h = 20 + Math.random() * 60;
    const t = i / 19;
    const r = Math.round(255 * (1 - t));
    const g = Math.round(77 + t * 153);
    const b = Math.round(77 + t * 41);
    bar.style.cssText = `height:${h}%;background:rgb(${r},${g},${b});animation-delay:${(Math.random()*0.5).toFixed(2)}s`;
    eq.appendChild(bar);
  }

  // Sentiment
  const sp = data.sentiment_percentages || {};
  const sc = data.sentiment_counts || {};
  countUp($('statPos'), sp.positive || 0);
  countUp($('statNeu'), sp.neutral  || 0);
  countUp($('statNeg'), sp.negative || 0);
  $('statPosCount').textContent = (sc.positive || 0) + ' comments';
  $('statNeuCount').textContent = (sc.neutral  || 0) + ' comments';
  $('statNegCount').textContent = (sc.negative || 0) + ' comments';

  // Safety
  const fp = data.flag_percentages || {};
  const fc = data.flag_counts || {};
  $('statHate').textContent = (fp.hate || 0) + '%';
  $('statGood').textContent = (fp.good || 0) + '%';
  $('statBad' ).textContent = (fp.bad  || 0) + '%';
  $('statNone').textContent = (fp.none || 0) + '%';
  $('statHateCount').textContent = (fc.hate || 0) + ' comments';
  $('statGoodCount').textContent = (fc.good || 0) + ' comments';
  $('statBadCount' ).textContent = (fc.bad  || 0) + ' comments';
  $('statNoneCount').textContent = (fc.none || 0) + ' comments';

  // Narrative (backend returns top-level `narrative`, not nested)
  $('narrativeText').textContent = data.narrative || 'Narrative not available.';

  // Quick comparison card
  if (data.comparison && data.comparison.sentiment_comparison && data.similar_video) {
    const c = data.comparison;
    const sv = data.similar_video;
    $('quickCompTitle').textContent = `vs. ${sv.title?.slice(0, 50) || 'Similar Video'}`;
    const pp = c.sentiment_comparison?.primary || {};
    const sp2 = c.sentiment_comparison?.similar || {};
    $('qcPriPos').style.width = (pp.positive || 0) + '%';
    $('qcPriNeu').style.width = (pp.neutral  || 0) + '%';
    $('qcPriNeg').style.width = (pp.negative || 0) + '%';
    $('qcSimPos').style.width = (sp2.positive || 0) + '%';
    $('qcSimNeu').style.width = (sp2.neutral  || 0) + '%';
    $('qcSimNeg').style.width = (sp2.negative || 0) + '%';
    $('qcSummary').textContent = c.summary || '';
    $('quickCompCard').hidden = false;
  } else {
    $('quickCompCard').hidden = true;
  }
}

// ── Similar Video page ────────────────────────────────────────────────────────
function renderSimilarPage(data) {
  if (!data) {
    $('empty-similar').hidden = false; $('similar-results').hidden = true; $('similar-unavailable').hidden = true; return;
  }
  if (!data.similar_video || !data.similar_video.title) {
    $('empty-similar').hidden = true; $('similar-results').hidden = true; $('similar-unavailable').hidden = false; return;
  }
  $('empty-similar').hidden = true; $('similar-unavailable').hidden = true; $('similar-results').hidden = false;

  const sv = data.similar_video;
  $('svTitle').textContent   = sv.title;
  $('svChannel').textContent = sv.channel_title || '—';
  $('svScore').textContent   = sv.score != null ? sv.score.toFixed(3) : '—';
  const link = $('svLink');
  link.href = `https://www.youtube.com/watch?v=${sv.video_id}`;

  const sa = data.similar_analysis;
  if (sa) {
    const sp2 = sa.sentiment_percentages || {};
    const fp2 = sa.flag_percentages || {};
    $('svPos').textContent  = (sp2.positive || 0) + '%';
    $('svNeu').textContent  = (sp2.neutral  || 0) + '%';
    $('svNeg').textContent  = (sp2.negative || 0) + '%';
    $('svHate').textContent = (fp2.hate || 0) + '%';
    $('svGood').textContent = (fp2.good || 0) + '%';
    $('svBad').textContent  = (fp2.bad  || 0) + '%';
    $('svNone').textContent = (fp2.none || 0) + '%';
    $('svVibeScore').textContent = sa.vibe_score ?? '—';
    $('svTotalCount').textContent = sa.total || 0;
  }
}

// ── Comparison page ───────────────────────────────────────────────────────────
function renderComparisonPage(data) {
  if (!data) {
    $('empty-comparison').hidden = false; $('comparison-results').hidden = true; $('comparison-unavailable').hidden = true; return;
  }
  const c = data.comparison;
  if (!c || !c.sentiment_comparison) {
    $('empty-comparison').hidden = true; $('comparison-results').hidden = true; $('comparison-unavailable').hidden = false; return;
  }
  $('empty-comparison').hidden = true; $('comparison-unavailable').hidden = true; $('comparison-results').hidden = false;

  const pp = c.sentiment_comparison?.primary || {};
  const sp = c.sentiment_comparison?.similar || {};
  $('compPriPos').textContent  = (pp.positive || 0) + '%';
  $('compPriNeu').textContent  = (pp.neutral  || 0) + '%';
  $('compPriNeg').textContent  = (pp.negative || 0) + '%';
  $('compPriVibe').textContent = c.vibe_comparison?.primary ?? '—';
  $('compPriSafe').textContent = (c.safety_comparison?.primary?.hate || 0) + '%';
  $('compSimPos').textContent  = (sp.positive || 0) + '%';
  $('compSimNeu').textContent  = (sp.neutral  || 0) + '%';
  $('compSimNeg').textContent  = (sp.negative || 0) + '%';
  $('compSimVibe').textContent = c.vibe_comparison?.similar ?? '—';
  $('compSimSafe').textContent = (c.safety_comparison?.similar?.hate || 0) + '%';
  $('compWinner').textContent  = c.winner || '—';
  $('compSummary').textContent = c.summary || '';
  $('compReason').textContent  = c.reason  || '';
  $('compStatusBadge').textContent = c.status === 'partial' ? '⚡ deterministic fallback' : '✓ AI narrative';
}

// ── Agent stepper ─────────────────────────────────────────────────────────────
function stepperSet(step, state) {
  // state: 'active' | 'done'
  const el = $(`step-${step}`);
  if (!el) return;
  el.classList.remove('active', 'done');
  el.classList.add(state);
  const statusEl = el.querySelector('.step-status');
  if (statusEl) statusEl.textContent = state === 'active' ? '…' : '✓';
}
function stepperReset() {
  STEPS.forEach(s => {
    const el = $(`step-${s}`);
    if (el) { el.classList.remove('active','done'); el.querySelector('.step-status').textContent = ''; }
  });
}

// ── Analyze form ──────────────────────────────────────────────────────────────
const analyzeForm = $('analyzeForm');
const urlInput    = $('urlInput');
const analyzeBtn  = $('analyzeBtn');
const agentStepper = $('agentStepper');
const homeSkeleton = $('homeSkeleton');

let sseSource = null;

if (analyzeForm) {
  analyzeForm.addEventListener('submit', async e => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    clearError();
    analyzeBtn.classList.add('loading');
    analyzeBtn.disabled = true;

    // Show stepper + skeleton
    agentStepper.hidden = false;
    homeSkeleton.hidden = false;
    $('home-results').hidden = true;
    $('quickCompCard').hidden = true;
    stepperReset();

    // Open SSE for live step updates
    if (sseSource) sseSource.close();
    const encoded = encodeURIComponent(url);
    sseSource = new EventSource(`/api/analyze/stream?url=${encoded}`);
    const doneSteps = new Set();
    sseSource.onmessage = evt => {
      const d = JSON.parse(evt.data);
      const step = d.step;
      if (!step || step === 'done') { sseSource.close(); return; }
      // Mark previous steps done
      STEPS.forEach(s => {
        if (s !== step && !doneSteps.has(s)) {
          const idx = STEPS.indexOf(s);
          const cur  = STEPS.indexOf(step);
          if (idx < cur) { stepperSet(s, 'done'); doneSteps.add(s); }
        }
      });
      stepperSet(step, 'active');
    };
    sseSource.onerror = () => sseSource.close();

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Analysis failed');
      }

      const data = await res.json();

      // Mark all steps done
      STEPS.forEach(s => stepperSet(s, 'done'));

      sessionStorage.setItem('vibeData', JSON.stringify(data));
      currentComments   = data.raw_comments || [];
      currentClassified = data.classified_comments || [];

      homeSkeleton.hidden = true;

      if (window.location.hash !== '#/home' && window.location.hash !== '') {
        window.location.hash = '#/home';
      } else {
        populateHomeData(data);
      }

    } catch (err) {
      homeSkeleton.hidden = true;
      agentStepper.hidden = true;
      showError(err.message || 'Something went wrong.');
    } finally {
      analyzeBtn.classList.remove('loading');
      analyzeBtn.disabled = false;
      if (sseSource) { sseSource.close(); sseSource = null; }
    }
  });
}

// ── Q&A form ──────────────────────────────────────────────────────────────────
const qaForm       = $('qaForm');
const qaInput      = $('qaInput');
const qaBtn        = $('qaBtn');
const qaAnswerWrap = $('qaAnswerWrap');
const qaAnswerText = $('qaAnswerText');

if (qaForm) {
  qaForm.addEventListener('submit', async e => {
    e.preventDefault();
    const q = qaInput.value.trim();
    if (!q) return;
    clearError();
    qaBtn.classList.add('loading');
    qaAnswerWrap.hidden = true;

    try {
      const res = await fetch('/api/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, comments: currentComments })
      });
      if (!res.ok) throw new Error('Q&A request failed');
      const d = await res.json();
      qaAnswerText.textContent = d.answer;
      qaAnswerWrap.hidden = false;
    } catch (err) {
      showError(err.message || 'Q&A failed.');
    } finally {
      qaBtn.classList.remove('loading');
    }
  });
}

// ── Comment filter buttons ────────────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    activeFlagFilter = e.currentTarget.dataset.flag;
    renderCategorizedComments(getSavedData(), false);
  });
});

document.querySelectorAll('.filter-sentiment-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    document.querySelectorAll('.filter-sentiment-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    activeSentimentFilter = e.currentTarget.dataset.sentiment;
    renderCategorizedComments(getSavedData(), false);
  });
});

// ── Categorized comments renderer ─────────────────────────────────────────────
const FLAG_ICONS  = { hate: '🔴', good: '🟢', bad: '🟠', none: '⚪' };
const FLAG_COLORS = { hate: 'var(--neg)', good: 'var(--pos)', bad: 'orange', none: 'var(--muted)' };

function renderCategorizedComments(data, updateCounts = true) {
  if (!data || !data.classified_comments) return;
  const comments = data.classified_comments;

  if (updateCounts) {
    const fc = data.flag_counts || {};
    $('count-all' ).textContent = comments.filter(c => c.status === 'success').length;
    $('count-hate').textContent = fc.hate || 0;
    $('count-good').textContent = fc.good || 0;
    $('count-bad' ).textContent = fc.bad  || 0;
    $('count-none').textContent = fc.none || 0;
  }

  const container = $('categorized-comments-container');
  const filtered  = comments.filter(c => {
    if (c.status !== 'success') return false;
    const mFlag = activeFlagFilter === 'all' || c.flag === activeFlagFilter;
    const mSent = activeSentimentFilter === 'all' || c.sentiment === activeSentimentFilter;
    return mFlag && mSent;
  });

  // Header
  const HEADERS = {
    all:  { icon: '',   label: 'ALL COMMENTS',            desc: 'All successfully classified comments.' },
    hate: { icon: '🔴', label: 'HATED COMMENTS',          desc: 'Comments containing targeted harassment, abuse, threats, slurs, or hateful content.' },
    good: { icon: '🟢', label: 'GOOD COMMENTS',           desc: 'Meaningful praise, constructive criticism, useful discussion, substantive feedback.' },
    bad:  { icon: '🟠', label: 'BAD COMMENTS',            desc: 'Low-quality, spam, promotional, or irrelevant content.' },
    none: { icon: '⚪', label: 'NEUTRAL / OTHER',         desc: 'Standard comments that do not trigger safety flags.' },
  };
  const h = HEADERS[activeFlagFilter] || HEADERS.all;
  const color = FLAG_COLORS[activeFlagFilter] || 'var(--fg)';

  let html = `<div style="margin-bottom:1.5rem;">
    <h3 style="color:${color};">${h.icon} ${h.label}</h3>
    <p style="color:var(--muted); font-size:0.9rem;">${h.desc}</p>
  </div>`;

  if (filtered.length === 0) {
    const emptyMsg = (activeFlagFilter === 'hate' && activeSentimentFilter === 'all')
      ? 'No hateful comments detected — a great sign!'
      : 'No comments match the selected filters.';
    html += `<div class="empty-category">${emptyMsg}</div>`;
    container.innerHTML = html;
    return;
  }

  container.innerHTML = html;

  filtered.forEach((c, idx) => {
    const card     = document.createElement('div');
    const flagKey  = c.flag || 'none';
    const sentKey  = c.sentiment || 'neutral';
    card.className = `cat-comment-card flag-${flagKey} sent-${sentKey}`;

    const flagStr = flagKey.charAt(0).toUpperCase() + flagKey.slice(1);
    const sentStr = sentKey.charAt(0).toUpperCase() + sentKey.slice(1);
    const icon    = FLAG_ICONS[flagKey] || '⚪';
    const fColor  = FLAG_COLORS[flagKey] || 'var(--muted)';

    let inner = `<div class="cat-comment-text">"${escHtml(c.text)}"</div>
      <div class="cat-comment-meta">
        <span class="sent-badge sent-badge-${sentKey}">${sentStr}</span>
        <span class="flag-badge" style="color:${fColor};">${icon} ${flagStr}</span>
      </div>`;

    if (c.mixed || c.evidence?.length || c.reason) {
      const detId = `det-${idx}`;
      inner += `<button class="cat-comment-details-toggle" onclick="document.getElementById('${detId}').hidden=!document.getElementById('${detId}').hidden">View classification details</button>
        <div class="cat-comment-details" id="${detId}" hidden>
          ${c.mixed !== undefined ? `<p><strong>Mixed:</strong> ${c.mixed ? 'Yes' : 'No'}</p>` : ''}
          ${c.confidence ? `<p><strong>Confidence:</strong> ${c.confidence}</p>` : ''}
          ${c.evidence?.length ? `<p><strong>Evidence:</strong> ${escHtml(c.evidence.join(' '))}</p>` : ''}
          ${c.reason ? `<p><strong>Reason:</strong> ${escHtml(c.reason)}</p>` : ''}
        </div>`;
    }

    card.innerHTML = inner;
    container.appendChild(card);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
