const MODE_CONFIG = {
  deals: {
    endpoint: '/api/deals',
    title: 'STEAM DEALS',
    subtitle: '실시간 할인 스캐너 · Steam 공식 검색 API 기반',
    showMinDiscount: true,
    sortOptions: [
      ['discount_desc', '할인율 높은순'],
      ['discount_asc', '할인율 낮은순'],
      ['price_asc', '가격 낮은순'],
      ['price_desc', '가격 높은순'],
      ['name', '이름순']
    ],
    defaultSort: 'discount_desc',
    emptyMessage: '조건에 맞는 게임이 없습니다. 최소 할인율을 낮춰보세요.'
  },
  horror: {
    endpoint: '/api/horror',
    title: 'HORROR GAMES',
    subtitle: '공포 게임 모음 · Steam 공식 검색 API 기반',
    showMinDiscount: false,
    sortOptions: [
      ['review_desc', '평점 좋은순'],
      ['price_asc', '가격 낮은순'],
      ['price_desc', '가격 높은순'],
      ['name', '이름순']
    ],
    defaultSort: 'review_desc',
    emptyMessage: '조건에 맞는 공포 게임이 없습니다.'
  }
};

let currentMode = 'deals';
const modeData = { deals: null, horror: null };
let allItems = [];
let itadEnabled = false;

const grid = document.getElementById('grid');
const statusEl = document.getElementById('status');
const emptyEl = document.getElementById('empty');
const fetchedAtEl = document.getElementById('fetchedAt');
const pageTitleEl = document.getElementById('pageTitle');
const pageSubtitleEl = document.getElementById('pageSubtitle');
const tabDealsEl = document.getElementById('tabDeals');
const tabHorrorEl = document.getElementById('tabHorror');
const sortEl = document.getElementById('sort');
const minDiscountFieldEl = document.getElementById('minDiscountField');
const minDiscountEl = document.getElementById('minDiscount');
const minDiscountValEl = document.getElementById('minDiscountVal');
const genreEl = document.getElementById('genre');
const playModeEl = document.getElementById('playMode');
const hideNegativeEl = document.getElementById('hideNegative');
const refreshBtn = document.getElementById('refresh');
const accessGateEl = document.getElementById('accessGate');
const accessGateMessageEl = document.getElementById('accessGateMessage');
const accessCodeInputEl = document.getElementById('accessCodeInput');
const accessCodeSubmitEl = document.getElementById('accessCodeSubmit');

const modalOverlayEl = document.getElementById('modalOverlay');
const modalImageEl = document.getElementById('modalImage');
const modalTagEl = document.getElementById('modalTag');
const modalRecordBadgeEl = document.getElementById('modalRecordBadge');
const modalTitleEl = document.getElementById('modalTitle');
const modalGenresEl = document.getElementById('modalGenres');
const modalDescEl = document.getElementById('modalDesc');
const modalMetaEl = document.getElementById('modalMeta');
const modalHistoryEl = document.getElementById('modalHistory');
const modalPriceEl = document.getElementById('modalPrice');
const modalSteamLinkEl = document.getElementById('modalSteamLink');
const modalCloseEl = document.getElementById('modalClose');

let lastFocusedCard = null;

const ACCESS_CODE_KEY = 'steamDealsAccessCode';

function getStoredAccessCode() {
  return localStorage.getItem(ACCESS_CODE_KEY) || '';
}

(function captureAccessCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const codeFromUrl = params.get('code');
  if (codeFromUrl) {
    localStorage.setItem(ACCESS_CODE_KEY, codeFromUrl);
    params.delete('code');
    const cleanUrl = location.pathname + (params.toString() ? '?' + params.toString() : '');
    history.replaceState({}, '', cleanUrl);
  }
})();

function showAccessGate(message) {
  accessGateMessageEl.textContent = message;
  accessGateEl.style.display = 'block';
  grid.style.display = 'none';
  statusEl.textContent = '';
}

function hideAccessGate() {
  accessGateEl.style.display = 'none';
  grid.style.display = 'grid';
}

function priceToNumber(str) {
  const digits = (str || '').replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : Infinity;
}

function tierClass(discount) {
  if (discount >= 70) return 'tier-high';
  if (discount >= 40) return 'tier-mid';
  return 'tier-low';
}

function metacriticClass(score) {
  if (score >= 75) return 'mc-high';
  if (score >= 50) return 'mc-mid';
  return 'mc-low';
}

function renderSkeleton(count) {
  grid.innerHTML = Array.from({ length: count })
    .map(() => `
      <div class="skeleton-card">
        <div class="sk-media"></div>
        <div class="sk-line" style="width: 80%"></div>
        <div class="sk-line" style="width: 50%"></div>
        <div class="sk-line" style="width: 40%; margin-left: auto;"></div>
      </div>
    `)
    .join('');
}

function populateGenreOptions() {
  const genres = new Set();
  for (const it of allItems) for (const g of it.genres || []) genres.add(g);
  const sorted = Array.from(genres).sort((a, b) => a.localeCompare(b, 'ko'));
  const current = genreEl.value;
  genreEl.innerHTML = '<option value="">전체</option>' + sorted.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  genreEl.value = sorted.includes(current) ? current : '';
}

function populateSortOptions(mode) {
  const config = MODE_CONFIG[mode];
  sortEl.innerHTML = config.sortOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  sortEl.value = config.defaultSort;
}

function deltaBadge(it) {
  if (it.discountDelta === null || it.discountDelta === undefined) return '<span>신규 기록</span>';
  if (it.discountDelta > 0) return `<span class="delta-up">▲ 지난번보다 ${it.discountDelta}%p 더 할인</span>`;
  if (it.discountDelta < 0) return `<span class="delta-down">▼ 지난번보다 ${-it.discountDelta}%p 할인폭 감소</span>`;
  return '<span>지난번과 동일</span>';
}

const REVIEW_TIER_CLASS = {
  '압도적으로 긍정적': 'rp4',
  '매우 긍정적': 'rp3',
  '긍정적': 'rp2',
  '대체로 긍정적': 'rp1',
  '복합적': 'rn0',
  '대체로 부정적': 'rn1',
  '부정적': 'rn2',
  '매우 부정적': 'rn3',
  '압도적으로 부정적': 'rn4'
};

const REVIEW_TIER_RANK = { rp4: 8, rp3: 7, rp2: 6, rp1: 5, rn0: 4, rn1: 3, rn2: 2, rn3: 1, rn4: 0 };

function reviewTierClass(text) {
  if (REVIEW_TIER_CLASS[text]) return REVIEW_TIER_CLASS[text];
  if (/긍정/.test(text || '')) return 'rp2';
  if (/부정/.test(text || '')) return 'rn2';
  return 'rn0';
}

function reviewRank(it) {
  if (!it.reviewText) return -1;
  return REVIEW_TIER_RANK[reviewTierClass(it.reviewText)];
}

function reviewChip(it) {
  if (!it.reviewText) return '';
  return `<span class="review-chip ${reviewTierClass(it.reviewText)}">${escapeHtml(it.reviewText)}</span>`;
}

function modeChipsHtml(it) {
  return [
    it.singleplayer ? '<span class="mode-chip">싱글</span>' : '',
    it.multiplayer ? '<span class="mode-chip">멀티</span>' : ''
  ].join('');
}

function metacriticChipHtml(it) {
  return it.metacritic
    ? `<span class="metacritic-chip ${metacriticClass(it.metacritic.score)}">MC ${it.metacritic.score}</span>`
    : '';
}

function historyRightText(it) {
  const hasAllTimeLow = it.allTimeLowCut !== null && it.allTimeLowCut !== undefined;
  if (!itadEnabled) return 'API 키 미설정';
  return hasAllTimeLow ? `역대 최고 -${it.allTimeLowCut}%` : '역대 기록 없음';
}

function tagBadgeHtml(it) {
  return it.discount > 0 ? `<span class="tag ${tierClass(it.discount)}">-${it.discount}%</span>` : '';
}

function priceRowHtml(it) {
  const orig = it.discount > 0 ? `<span class="price-orig">${escapeHtml(it.originalPrice)}</span>` : '';
  return `${orig}<span class="price-final">${escapeHtml(it.finalPrice)}</span>`;
}

function openModal(it) {
  modalImageEl.src = it.image;
  if (it.discount > 0) {
    modalTagEl.className = `tag ${tierClass(it.discount)}`;
    modalTagEl.textContent = `-${it.discount}%`;
    modalTagEl.style.display = '';
  } else {
    modalTagEl.style.display = 'none';
  }
  modalRecordBadgeEl.style.display = it.isNewAllTimeLow ? 'flex' : 'none';
  modalTitleEl.textContent = it.name;
  modalGenresEl.innerHTML = (it.genres || []).map((g) => `<span class="genre-chip">${escapeHtml(g)}</span>`).join('');
  modalDescEl.textContent = it.shortDescription || '';
  modalMetaEl.innerHTML = `${reviewChip(it)}${modeChipsHtml(it)}${metacriticChipHtml(it)}`;
  modalHistoryEl.innerHTML = `<span>${deltaBadge(it)}</span><span>${escapeHtml(historyRightText(it))}</span>`;
  modalPriceEl.innerHTML = priceRowHtml(it);
  modalSteamLinkEl.href = it.url;

  modalOverlayEl.hidden = false;
  document.body.style.overflow = 'hidden';
  modalCloseEl.focus();
}

function closeModal() {
  modalOverlayEl.hidden = true;
  document.body.style.overflow = '';
  if (lastFocusedCard) lastFocusedCard.focus();
}

modalCloseEl.addEventListener('click', closeModal);
modalOverlayEl.addEventListener('click', (e) => {
  if (e.target === modalOverlayEl) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlayEl.hidden) closeModal();
});

function render() {
  const config = MODE_CONFIG[currentMode];
  const minDiscount = config.showMinDiscount ? parseInt(minDiscountEl.value, 10) : 0;
  const sortMode = sortEl.value;
  const genre = genreEl.value;
  const playMode = playModeEl.value;
  const hideNegative = hideNegativeEl.checked;

  let items = allItems.filter((it) => {
    if (it.discount < minDiscount) return false;
    if (genre && !(it.genres || []).includes(genre)) return false;
    if (playMode === 'single' && !(it.singleplayer && !it.multiplayer)) return false;
    if (playMode === 'multi' && !it.multiplayer) return false;
    if (hideNegative && /부정/.test(it.reviewText || '')) return false;
    return true;
  });

  items.sort((a, b) => {
    if (sortMode === 'discount_desc') return b.discount - a.discount;
    if (sortMode === 'discount_asc') return a.discount - b.discount;
    if (sortMode === 'price_asc') return priceToNumber(a.finalPrice) - priceToNumber(b.finalPrice);
    if (sortMode === 'price_desc') return priceToNumber(b.finalPrice) - priceToNumber(a.finalPrice);
    if (sortMode === 'review_desc') return reviewRank(b) - reviewRank(a);
    if (sortMode === 'name') return a.name.localeCompare(b.name, 'ko');
    return 0;
  });

  grid.innerHTML = '';
  emptyEl.textContent = config.emptyMessage;
  emptyEl.style.display = items.length ? 'none' : 'block';

  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${it.name} 상세보기`);

    const genreChips = (it.genres || [])
      .slice(0, 3)
      .map((g) => `<span class="genre-chip">${escapeHtml(g)}</span>`)
      .join('');

    const recordBadge = it.isNewAllTimeLow
      ? `<span class="record-badge"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l2.09 4.26 4.7.68-3.4 3.31.8 4.68L8 11.77l-4.19 2.16.8-4.68L1.21 5.94l4.7-.68L8 1z"/></svg>역대 최저가 갱신</span>`
      : '';

    card.innerHTML = `
      <div class="card-media">
        <img src="${it.image}" loading="lazy" alt="">
        ${tagBadgeHtml(it)}
        ${recordBadge}
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(it.name)}</div>
        ${genreChips ? `<div class="genre-row">${genreChips}</div>` : ''}
        ${it.shortDescription ? `<div class="card-desc">${escapeHtml(it.shortDescription)}</div>` : ''}
        <div class="meta-row">
          ${reviewChip(it)}
          ${modeChipsHtml(it)}
          ${metacriticChipHtml(it)}
        </div>
        <div class="history-row">
          <span>${deltaBadge(it)}</span>
          <span>${escapeHtml(historyRightText(it))}</span>
        </div>
        <div class="price-row">
          ${priceRowHtml(it)}
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      lastFocusedCard = card;
      openModal(it);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        lastFocusedCard = card;
        openModal(it);
      }
    });

    grid.appendChild(card);
  }

  statusEl.textContent = `총 ${items.length}개 표시 중 (전체 ${allItems.length}개 중)`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function applyModeChrome(mode) {
  const config = MODE_CONFIG[mode];
  pageTitleEl.textContent = config.title;
  pageSubtitleEl.textContent = config.subtitle;
  tabDealsEl.classList.toggle('active', mode === 'deals');
  tabHorrorEl.classList.toggle('active', mode === 'horror');
  minDiscountFieldEl.style.display = config.showMinDiscount ? '' : 'none';
  minDiscountEl.value = 0;
  minDiscountValEl.textContent = '0%';
  populateSortOptions(mode);
}

async function loadMode(mode, { force = false } = {}) {
  const accessCode = getStoredAccessCode();
  if (!accessCode) {
    showAccessGate('이 사이트는 초대받은 사람만 볼 수 있어요. 받은 접근 코드를 입력해주세요.');
    return;
  }

  if (!force && modeData[mode]) {
    applyLoadedData(mode);
    return;
  }

  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  if (!modeData[mode]) {
    statusEl.textContent = '불러오는 중... (첫 실행 시 장르/멀티플레이/평점 정보 수집으로 다소 시간이 걸릴 수 있습니다)';
    renderSkeleton(12);
  }
  try {
    const res = await fetch(`${MODE_CONFIG[mode].endpoint}?count=150`, {
      headers: { 'X-Access-Code': accessCode }
    });

    if (res.status === 401) {
      localStorage.removeItem(ACCESS_CODE_KEY);
      showAccessGate('접근 코드가 올바르지 않아요. 다시 입력해주세요.');
      return;
    }
    if (res.status === 429) {
      statusEl.textContent = '요청이 너무 잦아요. 잠시 후 다시 시도해주세요.';
      return;
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    hideAccessGate();
    modeData[mode] = data;
    applyLoadedData(mode);
  } catch (e) {
    statusEl.textContent = '불러오기 실패: ' + e.message;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
  }
}

function applyLoadedData(mode) {
  const data = modeData[mode];
  allItems = data.items;
  itadEnabled = data.itadEnabled;
  fetchedAtEl.textContent = '마지막 갱신 ' + new Date(data.fetchedAt).toLocaleString('ko-KR');
  populateGenreOptions();
  render();
}

function switchMode(mode) {
  if (mode === currentMode && modeData[mode]) return;
  currentMode = mode;
  applyModeChrome(mode);
  loadMode(mode);
}

function submitAccessCode() {
  const value = accessCodeInputEl.value.trim();
  if (!value) return;
  localStorage.setItem(ACCESS_CODE_KEY, value);
  loadMode(currentMode);
}

accessCodeSubmitEl.addEventListener('click', submitAccessCode);
accessCodeInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAccessCode();
});

tabDealsEl.addEventListener('click', () => switchMode('deals'));
tabHorrorEl.addEventListener('click', () => switchMode('horror'));

sortEl.addEventListener('change', render);
genreEl.addEventListener('change', render);
playModeEl.addEventListener('change', render);
hideNegativeEl.addEventListener('change', render);
minDiscountEl.addEventListener('input', () => {
  minDiscountValEl.textContent = minDiscountEl.value + '%';
  render();
});
refreshBtn.addEventListener('click', () => loadMode(currentMode, { force: true }));

applyModeChrome(currentMode);
loadMode(currentMode);
