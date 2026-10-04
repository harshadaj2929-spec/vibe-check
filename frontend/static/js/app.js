/* ════════════════════════════════════════════════════════════════════════════
   Vibe Check — app.js
   Orchestrates: form submit → API call → UI render → EQ bars + arc gauge
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
// Works both locally (same origin) and on HF Spaces (same origin)
const API_BASE = '';   // empty = same origin

const EQ_BAR_COUNT = 40;
const TYPEWRITER_SPEED_MS = 18;   // ms per char (narrative reveal)

// ── State ───────────────────────────────────────────────────────────────────
let currentVideoId = null;
let currentComments = [];
let typewriterTimer = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const analyzeForm    = document.getElementById('analyzeForm');
const analyzeBtn     = document.getElementById('analyzeBtn');
const urlInput       = document.getElementById('urlInput');
const inputHint      = document.getElementById('inputHint');
const agentStatus    = document.getElementById('agentStatus');
const agentMsg       = document.getElementById('agentMsg');
const results        = document.getElementById('results');
const errorToast     = document.getElementById('errorToast');
const errorMsgEl     = document.getElementById('errorMsg');

// Gauge
const vibeScoreLabel = document.getElementById('vibeScoreLabel');
const arcFill        = document.getElementById('arcFill');
const arcNeedle      = document.getElementById('arcNeedle');
const arcScoreBadge  = document.getElementById('arcScoreBadge');
const eqContainer    = document.getElementById('eqContainer');

// Stats
const statPos      = document.getElementById('statPos');
const statNeu      = document.getElementById('statNeu');
const statNeg      = document.getElementById('statNeg');
const statPosCount = document.getElementById('statPosCount');
const statNeuCount = document.getElementById('statNeuCount');
const statNegCount = document.getElementById('statNegCount');

// Narrative
const narrativeText = document.getElementById('narrativeText');

// Top comments
const topPos = document.getElementById('topPos');
const topNeu = document.getElementById('topNeu');
const topNeg = document.getElementById('topNeg');

// Q&A
const qaForm        = document.getElementById('qaForm');
const qaBtn         = document.getElementById('qaBtn');
const qaInput       = document.getElementById('qaInput');
const qaAnswerWrap  = document.getElementById('qaAnswerWrap');
const qaAnswerText  = document.getElementById('qaAnswerText');

// ── EQ bar generation ────────────────────────────────────────────────────────
function buildEqBars() {
  eqContainer.innerHTML = '';
  for (let i = 0; i < EQ_BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'eq-bar';
    bar.style.height = '4px';
    bar.style.background = '#2a2a36';
    eqContainer.appendChild(bar);
  }
}
buildEqBars();

// Map score (-100…+100) → EQ bar heights + colours
function animateEq(score) {
  const bars = eqContainer.querySelectorAll('.eq-bar');
  const norm = (score + 100) / 200;   // 0…1

  bars.forEach((bar, i) => {
    const pos = i / (EQ_BAR_COUNT - 1);  // 0…1 left→right

    // Height: peaks near the score's position, quieter away from it
    const proximity = 1 - Math.abs(pos - norm);
    // Wave-like base height + score-driven emphasis
    const baseH = 10 + Math.sin(pos * Math.PI * 3 + Date.now() / 800) * 5;
    const emphH = proximity ** 1.8 * 60;
    const h = Math.max(4, baseH + emphH);

    bar.style.height = `${h}px`;

    // Colour: red↔yellow↔green spectrum matching the arc gradient
    const r = Math.round(lerp(255, 0, norm));
    const g = Math.round(lerp(77,  230, norm));
    const b = Math.round(lerp(77,  118, norm));
    bar.style.background = `rgb(${r},${g},${b})`;
    // Glow on bars near the score
    const alpha = proximity ** 2 * 0.7;
    bar.style.boxShadow = `0 0 ${Math.round(proximity * 12)}px rgba(${r},${g},${b},${alpha})`;
  });
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Idle EQ animation when no score
let idleRaf = null;
function startIdleEq() {
  function frame() {
    const bars = eqContainer.querySelectorAll('.eq-bar');
    bars.forEach((bar, i) => {
      const t = Date.now() / 600;
      const h = 6 + Math.abs(Math.sin(t + i * 0.35)) * 14;
      bar.style.height = `${h}px`;
      bar.style.background = '#2a2a36';
      bar.style.boxShadow = 'none';
    });
    idleRaf = requestAnimationFrame(frame);
  }
  idleRaf = requestAnimationFrame(frame);
}

function stopIdleEq() {
  if (idleRaf) { cancelAnimationFrame(idleRaf); idleRaf = null; }
}

startIdleEq();

// ── Arc gauge animation ───────────────────────────────────────────────────────
// Arc path length ≈ 345px (half circle, r=110)
const ARC_LEN = 345;

function animateArc(score) {
  // score: -100…+100 → dashoffset: 345…0
  const norm = (score + 100) / 200;
  const offset = ARC_LEN * (1 - norm);
  arcFill.style.strokeDashoffset = offset;

  // Needle: -90deg (far left) … +90deg (far right), 0=centre
  const angle = norm * 180 - 90;
  arcNeedle.style.transform = `rotate(${angle}deg)`;
}

function setScoreDisplay(score) {
  vibeScoreLabel.textContent = (score >= 0 ? '+' : '') + score;
  arcScoreBadge.textContent  = (score >= 0 ? '+' : '') + score;

  // Badge colour
  const color = score > 20 ? 'var(--pos)' : score < -20 ? 'var(--neg)' : 'var(--neu)';
  arcScoreBadge.style.color = color;
  arcScoreBadge.style.textShadow = `0 0 24px ${color}`;
}

// ── Agent status messages ────────────────────────────────────────────────────
const STEPS = [
  'Fetching comments from YouTube…',
  'Classifying sentiment with xlm-roberta…',
  'Aggregating results…',
  'Insight Agent is writing your vibe summary…',
];

let stepIdx = 0;
let stepTimer = null;

function startAgentSteps() {
  stepIdx = 0;
  agentMsg.textContent = STEPS[0];
  agentStatus.hidden = false;

  stepTimer = setInterval(() => {
    stepIdx = Math.min(stepIdx + 1, STEPS.length - 1);
    agentMsg.textContent = STEPS[stepIdx];
  }, 2500);
}

function stopAgentSteps(msg = null) {
  clearInterval(stepTimer);
  if (msg) {
    agentMsg.textContent = msg;
    setTimeout(() => { agentStatus.hidden = true; }, 2000);
  } else {
    agentStatus.hidden = true;
  }
}

// ── Typewriter ───────────────────────────────────────────────────────────────
function typewrite(el, text, speed = TYPEWRITER_SPEED_MS) {
  if (typewriterTimer) clearInterval(typewriterTimer);
  el.classList.remove('done');
  el.textContent = '';
  let i = 0;
  typewriterTimer = setInterval(() => {
    el.textContent += text[i++];
    if (i >= text.length) {
      clearInterval(typewriterTimer);
      el.classList.add('done');
    }
  }, speed);
}

// ── Error toast ───────────────────────────────────────────────────────────────
function showError(msg) {
  errorMsgEl.textContent = msg;
  errorToast.hidden = false;
  setTimeout(() => { errorToast.hidden = true; }, 8000);
}

// ── Render results ────────────────────────────────────────────────────────────
function renderCommentList(container, comments, delay = 0) {
  container.innerHTML = '';
  (comments || []).forEach((text, i) => {
    const card = document.createElement('div');
    card.className = 'comment-card';
    card.textContent = text.length > 220 ? text.slice(0, 217) + '…' : text;
    card.style.animationDelay = `${delay + i * 80}ms`;
    container.appendChild(card);
  });
}

function renderResults(data) {
  // Stats
  statPos.textContent      = data.percentages.positive + '%';
  statNeu.textContent      = data.percentages.neutral  + '%';
  statNeg.textContent      = data.percentages.negative + '%';
  statPosCount.textContent = data.counts.positive + ' comments';
  statNeuCount.textContent = data.counts.neutral  + ' comments';
  statNegCount.textContent = data.counts.negative + ' comments';

  // Gauge
  stopIdleEq();
  const score = data.vibe_score;
  setScoreDisplay(score);
  animateArc(score);
  animateEq(score);

  // Narrative typewriter
  typewrite(narrativeText, data.narrative || '(no narrative available)');

  // Top comments
  renderCommentList(topPos, data.top_comments.positive, 0);
  renderCommentList(topNeu, data.top_comments.neutral,  80);
  renderCommentList(topNeg, data.top_comments.negative, 160);

  // Show results
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Analyze form submit ───────────────────────────────────────────────────────
analyzeForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }

  // Reset UI
  results.hidden = true;
  qaAnswerWrap.hidden = true;
  if (typewriterTimer) clearInterval(typewriterTimer);
  narrativeText.textContent = '';
  narrativeText.classList.remove('done');
  stopIdleEq();
  startIdleEq();

  // Loading state
  analyzeBtn.classList.add('loading');
  analyzeBtn.disabled = true;
  urlInput.disabled = true;
  startAgentSteps();

  try {
    const resp = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.detail || `Server error (${resp.status})`);
    }

    currentVideoId = data.video_id;
    currentComments = data.raw_comments || [];

    stopAgentSteps('Analysis complete ✓');
    stopIdleEq();
    renderResults(data);

  } catch (err) {
    stopAgentSteps();
    startIdleEq();
    showError(err.message || 'An unexpected error occurred. Please try again.');
  } finally {
    analyzeBtn.classList.remove('loading');
    analyzeBtn.disabled = false;
    urlInput.disabled = false;
  }
});

// ── Q&A form submit ───────────────────────────────────────────────────────────
qaForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const question = qaInput.value.trim();
  if (!question) { qaInput.focus(); return; }
  if (!currentComments.length) {
    showError('Run a vibe check first before asking questions!');
    return;
  }

  qaBtn.classList.add('loading');
  qaBtn.disabled = true;
  qaAnswerWrap.hidden = true;

  try {
    const resp = await fetch(`${API_BASE}/api/qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: currentVideoId,
        question,
        comments: currentComments,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.detail || `Server error (${resp.status})`);
    }

    qaAnswerWrap.hidden = false;
    typewrite(qaAnswerText, data.answer, TYPEWRITER_SPEED_MS);

  } catch (err) {
    showError(err.message || 'Q&A agent encountered an error.');
  } finally {
    qaBtn.classList.remove('loading');
    qaBtn.disabled = false;
  }
});

// ── Continuous EQ animation on score (re-render each frame) ─────────────────
let eqRaf = null;
let lastScore = null;

function startScoredEq(score) {
  lastScore = score;
  function frame() {
    animateEq(lastScore);
    eqRaf = requestAnimationFrame(frame);
  }
  if (eqRaf) cancelAnimationFrame(eqRaf);
  eqRaf = requestAnimationFrame(frame);
}

// Override animateEq to also kick off the live loop
const _animateEqOnce = animateEq;
window.animateEqLive = function(score) {
  stopIdleEq();
  if (eqRaf) cancelAnimationFrame(eqRaf);
  startScoredEq(score);
};

// Patch renderResults to call the live version after initial render
const _renderResults = renderResults;
window.renderResults = function(data) {
  _renderResults(data);
  window.animateEqLive(data.vibe_score);
};

// Keyboard shortcut — Enter on Q&A input already handled by form
// Focus URL input on page load
urlInput.focus();
