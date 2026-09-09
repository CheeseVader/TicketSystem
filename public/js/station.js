const socket = io();

let andonFirstConnect=true;
function forceFreshReload(){const u=new URL(location.href);u.searchParams.set('_r10',Date.now());location.replace(u)}
socket.on('server:hello',info=>{if(!info?.bootId)return;const k='andon_station_r10_boot';const old=sessionStorage.getItem(k);sessionStorage.setItem(k,info.bootId);if(old&&old!==info.bootId)return forceFreshReload();loadActive();});
socket.on('connect',()=>{if(!andonFirstConnect)loadActive();andonFirstConnect=false;});

const code = location.pathname.split('/').pop().toUpperCase();

const title = document.getElementById('stationTitle');
const statusBox = document.getElementById('stationStatus');
const activeTickets = document.getElementById('activeTickets');
const categoryModal = document.getElementById('categoryModal');
const categoryGrid = document.getElementById('categoryGrid');
const categoryModalTitle = document.getElementById('categoryModalTitle');
const categoryModalHelp = document.getElementById('categoryModalHelp');
const closeCategoryModal = document.getElementById('closeCategoryModal');
const backButton = document.getElementById('backButton');
const otherModal = document.getElementById('otherModal');
const otherNotes = document.getElementById('otherNotes');
const cancelOther = document.getElementById('cancelOther');
const submitOther = document.getElementById('submitOther');
const confirmationModal = document.getElementById('confirmationModal');
const confirmationTitle = document.getElementById('confirmationTitle');
const confirmationMessage = document.getElementById('confirmationMessage');
const confirmationDetail = document.getElementById('confirmationDetail');
const closeConfirmation = document.getElementById('closeConfirmation');

let selectedDepartment = null;
let pendingOtherCategory = null;
let confirmationTimer = null;
let sending = false;

// Fallback local: el popup SIEMPRE puede abrir aunque la API de categorias falle.
const FALLBACK_CATEGORIES = {
  systems: [
    { code: 'smes', label: 'SMES', icon: '🏭' },
    { code: 'printer', label: 'IMPRESORA', icon: '🖨️' },
    { code: 'pc', label: 'PC', icon: '🖥️' },
    { code: 'other', label: 'OTROS', icon: '⋯' }
  ],
  maintenance: [
    { code: 'strap', label: 'STRAP', icon: '🔧' },
    { code: 'other', label: 'OTROS', icon: '⋯' }
  ]
};

const categoryCache = JSON.parse(JSON.stringify(FALLBACK_CATEGORIES));
const deptName = d => d === 'systems' ? 'Sistemas' : 'Mantenimiento';
const deptIcon = d => d === 'systems' ? '🖥️' : '🛠️';

const stationMatch = code.match(/^L(\d+)-E(\d+)$/);
title.textContent = stationMatch ? `Línea ${stationMatch[1]} - Estación ${stationMatch[2]}` : code;

function tick() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('es-MX');
}
setInterval(tick, 1000);
tick();

function show(msg, type = 'info') {
  statusBox.className = `status-box ${type}`;
  statusBox.textContent = msg;
}

function categoryLabel(ticket) {
  if (ticket.category_label) return ticket.category_label;
  const known = (categoryCache[ticket.department] || []).find(x => x.code === ticket.category);
  return known?.label || ticket.category || 'Categoría pendiente';
}

function renderTicket(ticket) {
  const dept = ticket.department;
  let el = document.querySelector(`[data-ticket="${dept}"]`);
  if (!el) {
    el = document.createElement('div');
    el.dataset.ticket = dept;
    el.className = `ticket-pill ${dept}`;
    activeTickets.appendChild(el);
  }
  const stateMap={unassigned:'SIN ASIGNAR',assigned:'ASIGNADO',in_progress:'EN PROGRESO',waiting:'EN ESPERA',escalated:'ESCALADO',resolved:'RESUELTO',closed:'CERRADO'};
  const state=stateMap[ticket.status]||String(ticket.status||'SOLICITADO').toUpperCase();
  const tech = ticket.attended_by_name ? ` · ${ticket.attended_by_name}` : '';
  el.innerHTML = `<strong>${deptIcon(dept)} ${deptName(dept)} · ${categoryLabel(ticket)}</strong><span>${state}${tech}</span>`;
}

async function loadActive() {
  try {
    const r = await fetch(`/api/stations/${encodeURIComponent(code)}/requests`, { cache: 'no-store' });
    const rows = await r.json();
    if (!r.ok) return;
    activeTickets.innerHTML = '';
    rows.forEach(renderTicket);
  } catch (_) {}
}

function renderCategories(categories) {
  categoryGrid.innerHTML = categories.map(cat => `
    <button class="category-button ${selectedDepartment}" data-category="${cat.code}" type="button">
      <span class="category-icon">${cat.icon || '•'}</span>
      <strong>${cat.label}</strong>
    </button>
  `).join('');

  categoryGrid.querySelectorAll('.category-button').forEach(button => {
    button.addEventListener('click', () => {
      if (sending) return;
      const category = button.dataset.category;
      if (category === 'other') {
        pendingOtherCategory = category;
        otherNotes.value = '';
        otherModal.classList.remove('hidden');
        setTimeout(() => otherNotes.focus(), 50);
        return;
      }
      sendRequest(selectedDepartment, category, '');
    });
  });
}

function openCategories(department) {
  selectedDepartment = department;
  categoryModalTitle.textContent = deptName(department).toUpperCase();
  categoryModalHelp.textContent = `Selecciona el tipo de apoyo de ${deptName(department)}.`;

  // Mostrar botones INMEDIATAMENTE. No esperar una llamada HTTP.
  renderCategories(categoryCache[department] || FALLBACK_CATEGORIES[department]);
  categoryModal.classList.remove('hidden');
  document.body.classList.add('modal-open');

  // Sincronizar con BD en segundo plano. Si falla, conserva el fallback.
  fetch(`/api/categories?department=${encodeURIComponent(department)}`, { cache: 'no-store' })
    .then(async r => {
      const data = await r.json();
      if (!r.ok || !Array.isArray(data) || !data.length) return;
      categoryCache[department] = data;
      if (selectedDepartment === department && !categoryModal.classList.contains('hidden')) {
        renderCategories(data);
      }
    })
    .catch(() => {});
}

function closeCategories() {
  categoryModal.classList.add('hidden');
  document.body.classList.remove('modal-open');
  selectedDepartment = null;
}

function closeOther() {
  pendingOtherCategory = null;
  otherModal.classList.add('hidden');
}

function speakOperatorMessage(text) {
  if (!window.speechSynthesis || !text) return;

  const speak = () => {
    const voices = window.speechSynthesis.getVoices();

    if (!voices.length) return false;

    const u = new SpeechSynthesisUtterance(text);

    u.lang = 'es-US';
    u.rate = 1.30;
    u.pitch = 1.05;
    u.volume = 1;

    u.voice =
      voices.find(v => v.name === 'Google español de Estados Unidos') ||
      voices.find(v => String(v.lang || '').toLowerCase() === 'es-us') ||
      voices.find(v => String(v.lang || '').toLowerCase().startsWith('es')) ||
      voices[0] ||
      null;

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);

    return true;
  };

  if (speak()) return;

  const onVoicesChanged = () => {
    if (speak()) {
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
    }
  };

  window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);

  let attempts = 0;

  const timer = setInterval(() => {
    attempts++;

    if (speak() || attempts >= 20) {
      clearInterval(timer);
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
    }
  }, 250);
}

function speakOperatorConfirmation(department, label) {
  const area = deptName(department);
  const category = String(label || '').trim();

  speakOperatorMessage(
    `Solicitud de ${area} enviada. Categoría ${category}. Se atenderá enseguida.`
  );
}
function showConfirmationPopup(department, label) {
  if (confirmationTimer) clearTimeout(confirmationTimer);
  confirmationTitle.textContent = 'Solicitud recibida';
  confirmationMessage.textContent = 'Se atenderá enseguida.';
  confirmationDetail.textContent = `${deptIcon(department)} ${deptName(department)} · ${label}`;
  confirmationModal.classList.remove('hidden');
  confirmationTimer = setTimeout(hideConfirmationPopup, 3500);
}

function hideConfirmationPopup() {
  if (confirmationTimer) clearTimeout(confirmationTimer);
  confirmationTimer = null;
  confirmationModal.classList.add('hidden');
}

async function sendRequest(department, category, notes = '') {
  if (!department || !category || sending) return;
  sending = true;
  document.querySelectorAll('.category-button,.support').forEach(x => x.disabled = true);
  show('Enviando solicitud...', 'warning');

  try {
    const r = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stationCode: code,
        department,
        category,
        requestedBy: 'Operador de estación',
        notes
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo enviar la solicitud.');

    const cat = (categoryCache[department] || []).find(x => x.code === category);
    const label = cat?.label || category.toUpperCase();

    otherModal.classList.add('hidden');
    categoryModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    selectedDepartment = null;
    pendingOtherCategory = null;

    renderTicket({ department, category, category_label: label, status: 'requested' });
    show('Solicitud activa. Se atenderá enseguida.', 'success');
    showConfirmationPopup(department, label);
    speakOperatorConfirmation(department, label);
    await loadActive();
  } catch (e) {
    show(e.message, 'error');
  } finally {
    sending = false;
    document.querySelectorAll('.category-button,.support').forEach(x => x.disabled = false);
  }
}

// Primer nivel: NUNCA envia solicitud; solo abre el popup.
document.querySelectorAll('.support').forEach(button => {
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    openCategories(button.dataset.dept);
  });
});

backButton.addEventListener('click', closeCategories);
closeCategoryModal.addEventListener('click', closeCategories);
categoryModal.addEventListener('click', e => { if (e.target === categoryModal) closeCategories(); });
cancelOther.addEventListener('click', closeOther);
otherModal.addEventListener('click', e => { if (e.target === otherModal) closeOther(); });
submitOther.addEventListener('click', async () => {
  const dept = selectedDepartment;
  const cat = pendingOtherCategory;
  const notes = otherNotes.value.trim();
  await sendRequest(dept, cat, notes);
});
closeConfirmation.addEventListener('click', hideConfirmationPopup);
confirmationModal.addEventListener('click', e => { if (e.target === confirmationModal) hideConfirmationPopup(); });

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!otherModal.classList.contains('hidden')) return closeOther();
  if (!categoryModal.classList.contains('hidden')) return closeCategories();
  if (!confirmationModal.classList.contains('hidden')) hideConfirmationPopup();
});

socket.on('request:changed', evt => {
  if (evt.stationCode !== code || !evt.department) return;

  if (evt.action === 'assigned') {
    speakOperatorMessage(
      `Su solicitud de ${deptName(evt.department)} ha sido asignada. Enseguida será atendida.`
    );
    loadActive();
    return;
  }

  if (evt.action === 'resolved' || evt.action === 'closed') {
    const el = document.querySelector(`[data-ticket="${evt.department}"]`);
    if (el) {
      const strong = el.querySelector('strong')?.textContent || deptName(evt.department);
      el.innerHTML = `<strong>${strong}</strong><span>${evt.action==='closed'?'CERRADO':'RESUELTO'}</span>`;
      setTimeout(() => el.remove(), 5000);
    }
    show(evt.action==='closed'?`${deptName(evt.department)} cerró la incidencia.`:`${deptName(evt.department)} marcó la solicitud como resuelta.`, 'success');
  } else {
    loadActive();
  }
});

loadActive();



