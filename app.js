"use strict";

const config = globalThis.DomesticInventoryConfig;
const authGate = document.querySelector('#auth-gate');
const appShell = document.querySelector('#app-shell');
const authStatus = document.querySelector('#auth-status');
const list = document.querySelector('#device-list');
const search = document.querySelector('#search');
const empty = document.querySelector('#empty-state');
const deviceDialog = document.querySelector('#device-dialog');
const detailDialog = document.querySelector('#detail-dialog');
const form = document.querySelector('#device-form');
const syncBanner = document.querySelector('#sync-banner');
const syncLabel = document.querySelector('#sync-label');
const syncDetail = document.querySelector('#sync-detail');
const syncIndicator = document.querySelector('#sync-indicator');
const BUCKET = 'domestic-inventory';
const MAX_PDF_BYTES = 20 * 1024 * 1024;
let client = null;
let user = null;
let profileName = '';
let devices = [];
let documents = [];
let revision = 0;
let baseState = { version: 1, devices: [], documents: [] };
let pending = false;
let syncing = false;
let changeCounter = 0;
let conflictContext = null;
let refreshAfterConflict = false;
let room = 'all';
let retryTimer = null;
let syncTimer = null;

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}
function setSync(mode, label, detail, symbol) {
  syncBanner.classList.toggle('sync-pending', mode === 'pending');
  syncBanner.classList.toggle('sync-error', mode === 'error');
  syncLabel.textContent = label;
  syncDetail.textContent = detail;
  syncIndicator.textContent = symbol;
}
function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function warrantyInfo(value) {
  if (!value) return { label: 'Garantie non renseignée', detail: 'Date de fin de garantie non renseignée', className: 'unknown' };
  const [year, month, day] = value.split('-').map(Number);
  const end = new Date(year, month - 1, day, 23, 59, 59);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const remaining = Math.ceil((end - today) / 86400000);
  const formatted = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(end);
  if (remaining < 0) return { label: 'Garantie expirée', detail: `Garantie terminée le ${formatted}`, className: 'expired' };
  return { label: `Sous garantie · ${remaining === 0 ? 'expire aujourd’hui' : `encore ${remaining} j`}`, detail: `Sous garantie jusqu’au ${formatted}`, className: 'active' };
}
function readableError(error) {
  if (!navigator.onLine) return 'Hors connexion. Les changements restent sur cet appareil.';
  if (error?.code === '40001' || /concurrent|revision|changed/i.test(error?.message || '')) return 'L’inventaire a changé sur un autre appareil. Vos changements restent en attente pour éviter tout écrasement.';
  if (error?.code === '42501' || /denied|permission|row-level/i.test(error?.message || '')) return 'Ce compte n’est pas autorisé à accéder à cet inventaire.';
  return 'Connexion impossible. Vos changements locaux sont conservés et seront réessayés.';
}
function stateNow() { return { version: 1, devices: structuredClone(devices), documents: structuredClone(documents) }; }
function cacheKey() { return `domestic-inventory:v1:${user.id}:${config.inventoryId}`; }
function authCacheKey() { return `domestic-inventory:authorized:${user.id}:${config.inventoryId}`; }
function readCache() {
  try { return JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch { return null; }
}
function saveCache() {
  if (!user) return;
  try { localStorage.setItem(cacheKey(), JSON.stringify({ revision, baseState, state: stateNow(), pending })); }
  catch { setSync('error', 'Stockage local indisponible', 'Les changements ne seront pas conservés hors ligne.', '!'); }
}
function render() {
  const query = search.value.trim().toLocaleLowerCase('fr');
  const visible = devices.filter(d => (room === 'all' || d.room === room) && `${d.name} ${d.room} ${d.brand} ${d.model} ${d.serialNumber || ''}`.toLocaleLowerCase('fr').includes(query));
  list.innerHTML = visible.map(d => {
    const w = warrantyInfo(d.warrantyEndDate);
    const manualCount = documents.filter(f => f.deviceId === d.id && f.kind === 'manual').length;
    return `<article class="device-card"><div class="device-thumb ${d.thumb || 'thumb-fridge'}" aria-hidden="true">${d.icon || '⌂'}</div><div class="device-main"><p class="device-room">${escapeHtml(d.room)} · ${escapeHtml(d.brand || 'Marque à renseigner')}</p><h3>${escapeHtml(d.name)}</h3><p class="device-model">${escapeHtml(d.model || 'Modèle non renseigné')}</p><span class="warranty-badge ${w.className}">${w.label}</span><br><button class="manual-link manual-button" type="button" data-open="${d.id}"><span class="pdf-badge">PDF</span> ${manualCount ? `${manualCount} document${manualCount === 1 ? '' : 's'}` : 'Ajouter un document'} <span aria-hidden="true">↗</span></button></div><button class="device-open" type="button" aria-label="Voir ${escapeHtml(d.name)}" data-open="${d.id}">›</button></article>`;
  }).join('');
  empty.hidden = visible.length > 0;
  document.querySelector('#item-count').textContent = String(devices.length);
  document.querySelectorAll('.filter').forEach(button => {
    const count = button.dataset.room === 'all' ? devices.length : devices.filter(d => d.room === button.dataset.room).length;
    button.querySelector('span').textContent = String(count);
  });
  const documentList = document.querySelector('#document-list');
  document.querySelector('#document-count').textContent = `${documents.length} fichier${documents.length === 1 ? '' : 's'}`;
  document.querySelector('#documents-empty').hidden = documents.length > 0;
  documentList.innerHTML = documents.map(file => {
    const device = devices.find(item => item.id === file.deviceId);
    return `<button type="button" class="document-row" data-download="${file.id}"><span class="pdf-large">PDF</span><span><b>${escapeHtml(file.fileName)}</b><small>${escapeHtml(device?.name || 'Appareil')} · ${file.kind === 'manual' ? 'Mode d’emploi' : 'Document'}</small></span><span class="document-arrow">↗</span></button>`;
  }).join('');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function same(a, b) { return JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null)); }
function mergeState(base, local, remote) {
  const result = { version: 1, devices: [], documents: [] };
  const conflicts = [];
  const group = state => {
    const ids = new Set([...(state.devices || []).map(item => item.id), ...(state.documents || []).map(item => item.deviceId)]);
    return new Map([...ids].map(id => [id, {
      device: (state.devices || []).find(item => item.id === id) || null,
      documents: (state.documents || []).filter(item => item.deviceId === id).sort((a, b) => a.id.localeCompare(b.id))
    }]));
  };
  const maps = [base, local, remote].map(group);
  for (const id of new Set(maps.flatMap(map => [...map.keys()]))) {
    const [before, ours, theirs] = maps.map(map => map.get(id));
    const localChanged = !same(before, ours);
    const remoteChanged = !same(before, theirs);
    if (localChanged && remoteChanged && !same(ours, theirs)) {
      const device = ours?.device || theirs?.device || before?.device;
      conflicts.push({ key: `device:${id}`, id, label: device?.name || 'Appareil supprimé', local: ours, remote: theirs, choice: null });
      continue;
    }
    const selected = localChanged ? ours : theirs;
    if (selected?.device) result.devices.push(selected.device);
    if (selected) result.documents.push(...selected.documents);
  }
  return { state: result, conflicts };
}
function showConflictChoices() {
  const notice = document.querySelector('#conflict-notice');
  notice.hidden = !conflictContext;
  document.querySelector('#add-item').disabled = Boolean(conflictContext);
  document.querySelector('#nav-add').disabled = Boolean(conflictContext);
  if (!conflictContext) return;
  document.querySelector('#conflict-items').innerHTML = conflictContext.conflicts.map(conflict => `
    <article class="conflict-item"><b>${escapeHtml(conflict.label)}</b><div>
      <button type="button" data-conflict-choice="local" data-conflict-key="${escapeHtml(conflict.key)}" class="${conflict.choice === 'local' ? 'chosen' : ''}">Garder ma version</button>
      <button type="button" data-conflict-choice="remote" data-conflict-key="${escapeHtml(conflict.key)}" class="${conflict.choice === 'remote' ? 'chosen' : ''}">Garder la version partagée</button>
    </div></article>`).join('');
}
function persistLocalChange() {
  changeCounter += 1;
  pending = true;
  saveCache();
  setSync('pending', 'Modifications en attente', 'Envoi automatique vers votre inventaire…', '↑');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 700);
}
async function syncNow() {
  if (!client || !user || syncing || !navigator.onLine) return;
  const cached = readCache();
  if (!pending && !cached?.pending) return refreshRemote();
  syncing = true;
  try {
    const sentState = stateNow();
    const sentCounter = changeCounter;
    const { data, error } = await client.rpc('inventory_save', {
      inventory: config.inventoryId,
      expected_revision: revision,
      new_state: sentState
    });
    if (error) throw error;
    revision = Number(data);
    baseState = sentState;
    pending = sentCounter !== changeCounter;
    saveCache();
    if (pending) {
      setSync('pending', 'Modifications en attente', 'Envoi des derniers changements…', '↑');
      clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 250);
    } else {
      setSync('ok', 'Inventaire synchronisé', `Mis à jour à ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`, '✓');
    }
  } catch (error) {
    pending = true;
    saveCache();
    setSync('error', 'Synchronisation en attente', readableError(error), '!');
    if (error?.code === '40001' || /concurrent|revision|changed/i.test(error?.message || '')) refreshAfterConflict = true;
    if (error?.code === '42501' && user) { localStorage.removeItem(authCacheKey()); await client.auth.signOut(); }
  } finally {
    syncing = false;
    if (refreshAfterConflict) { refreshAfterConflict = false; setTimeout(refreshRemote, 0); }
  }
}
async function refreshRemote() {
  if (!client || !user || syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const { data, error } = await client.rpc('inventory_read', { inventory: config.inventoryId });
    if (error) throw error;
    const cached = readCache();
    if (cached?.pending) {
      if (Number(cached.revision) !== Number(data.revision)) {
        const remote = data.state || { version: 1, devices: [], documents: [] };
        const merged = mergeState(cached.baseState || { version: 1, devices: [], documents: [] }, cached.state, remote);
        if (merged.conflicts.length) {
          devices = cached.state.devices || [];
          documents = cached.state.documents || [];
          revision = Number(cached.revision);
          baseState = cached.baseState || baseState;
          pending = true;
          conflictContext = { revision: Number(data.revision), base: baseState, remote, merged: merged.state, conflicts: merged.conflicts };
          showConflictChoices();
          saveCache();
          setSync('error', 'Choix requis', 'Choisissez quelle version garder pour les éléments modifiés sur les deux appareils.', '!');
        } else {
          devices = merged.state.devices;
          documents = merged.state.documents;
          revision = Number(data.revision);
          baseState = remote;
          pending = !same(merged.state, remote);
          conflictContext = null;
          showConflictChoices();
          saveCache();
          render();
          if (pending) {
            setSync('pending', 'Synchronisation des changements fusionnés', 'Les modifications indépendantes sont réunies.', '↑');
            clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 250);
          } else setSync('ok', 'Inventaire synchronisé', 'Les changements partagés sont à jour.', '✓');
        }
        render();
        return;
      }
      devices = cached.state.devices || [];
      documents = cached.state.documents || [];
      revision = Number(data.revision);
      baseState = data.state;
      pending = true;
      saveCache();
      render();
      setSync('pending', 'Modifications en attente', 'Reprise de la synchronisation…', '↑');
      clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 300);
      return;
    }
    revision = Number(data.revision);
    baseState = data.state || { version: 1, devices: [], documents: [] };
    devices = baseState.devices || [];
    documents = baseState.documents || [];
    pending = false;
    conflictContext = null;
    showConflictChoices();
    saveCache();
    render();
    setSync('ok', 'Inventaire synchronisé', `Vérifié à ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`, '✓');
  } catch (error) {
    if (error?.code === '42501' && user) { localStorage.removeItem(authCacheKey()); await client.auth.signOut(); return; }
    const cached = readCache();
    if (cached) {
      revision = Number(cached.revision || 0); baseState = cached.baseState || baseState;
      devices = cached.state?.devices || []; documents = cached.state?.documents || [];
      pending = Boolean(cached.pending); render();
    }
    setSync('error', 'Inventaire hors connexion', readableError(error), '!');
  } finally { syncing = false; }
}
document.querySelector('#conflict-items').addEventListener('click', event => {
  const button = event.target.closest('[data-conflict-choice]');
  if (!button || !conflictContext) return;
  const conflict = conflictContext.conflicts.find(item => item.key === button.dataset.conflictKey);
  if (!conflict) return;
  conflict.choice = button.dataset.conflictChoice;
  showConflictChoices();
  if (conflictContext.conflicts.some(item => !item.choice)) return;
  const resolved = structuredClone(conflictContext.merged);
  for (const item of conflictContext.conflicts) {
    const selected = item.choice === 'local' ? item.local : item.remote;
    if (selected?.device) resolved.devices.push(selected.device);
    if (selected) resolved.documents.push(...selected.documents);
  }
  devices = resolved.devices;
  documents = resolved.documents;
  revision = conflictContext.revision;
  baseState = conflictContext.remote;
  pending = !same(resolved, baseState);
  conflictContext = null;
  showConflictChoices();
  render(); saveCache();
  if (pending) {
    setSync('pending', 'Synchronisation des choix…', 'Envoi de la version rapprochée.', '↑');
    clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 250);
  } else setSync('ok', 'Inventaire synchronisé', 'Les versions sont réunies.', '✓');
});
async function authorizeAndOpen(authUser) {
  user = authUser;
  conflictContext = null;
  showConflictChoices();
  authStatus.textContent = 'Vérification des droits d’accès…';
  try {
    const { data: membership, error } = await client.from('inventory_members').select('inventory_id').eq('inventory_id', config.inventoryId).eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    if (!membership) {
      localStorage.removeItem(authCacheKey());
      await client.auth.signOut();
      user = null;
      authStatus.textContent = 'Ce compte ne figure pas parmi les utilisateurs autorisés.';
      return;
    }
    localStorage.setItem(authCacheKey(), '1');
    authGate.hidden = true;
    appShell.hidden = false;
    document.querySelector('#account-name').textContent = '';
    document.querySelector('#sign-out').textContent = (user.email || 'M').slice(0, 1).toUpperCase();
    document.querySelector('#sign-out').setAttribute('aria-label', 'Se déconnecter');
    await loadProfileName();
    const cached = readCache();
    if (cached) {
      revision = Number(cached.revision || 0); baseState = cached.baseState || baseState;
      devices = cached.state?.devices || []; documents = cached.state?.documents || [];
      pending = Boolean(cached.pending); render();
      if (pending) setSync('pending', 'Modifications en attente', 'Synchronisation de vos changements…', '↑');
    }
    await refreshRemote();
    clearInterval(retryTimer);
    retryTimer = setInterval(() => { if (document.visibilityState === 'visible' && !conflictContext) pending ? syncNow() : refreshRemote(); }, 15000);
  } catch (error) {
    const cached = user && readCache();
    const previouslyAuthorized = user && localStorage.getItem(authCacheKey()) === '1';
    if (!navigator.onLine && previouslyAuthorized && cached) {
      authGate.hidden = true;
      appShell.hidden = false;
      devices = cached.state?.devices || [];
      documents = cached.state?.documents || [];
      revision = Number(cached.revision || 0);
      baseState = cached.baseState || baseState;
      pending = Boolean(cached.pending);
      render();
      setSync(pending ? 'pending' : 'error', pending ? 'Modifications en attente' : 'Inventaire hors connexion', 'Les droits seront revérifiés dès le retour de la connexion.', pending ? '↑' : '!');
      clearInterval(retryTimer);
      retryTimer = setInterval(() => { if (navigator.onLine && document.visibilityState === 'visible') pending ? syncNow() : refreshRemote(); }, 15000);
      return;
    }
    user = null;
    authStatus.textContent = readableError(error);
  }
}
function makeClient() {
  const factory = globalThis.CasaSupabase?.createClient;
  if (!config?.url || !config?.publishableKey || !factory) {
    authStatus.textContent = 'Configuration Supabase manquante. Vérifiez supabase-config.js et le chargement du client.';
    return;
  }
  client = factory(config.url, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  client.auth.getSession().then(({ data, error }) => {
    if (error) throw error;
    if (data.session) authorizeAndOpen(data.session.user);
  }).catch(error => { authStatus.textContent = readableError(error); });
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      user = null; appShell.hidden = true; authGate.hidden = false;
      clearInterval(retryTimer); clearTimeout(syncTimer); devices = []; documents = []; pending = false; conflictContext = null; showConflictChoices(); render();
  }
  });
}
async function loadProfileName() {
  if (!client || !user) return;
  try {
    const { data, error } = await client.rpc('inventory_profile');
    if (error) return;
    profileName = String(data || '').trim();
    document.querySelector('#account-name').textContent = profileName;
    document.querySelector('#sign-out').textContent = (profileName || user.email || 'M').slice(0, 1).toUpperCase();
    document.querySelector('#sign-out').setAttribute('aria-label', `Se déconnecter${profileName ? ` (${profileName})` : ''}`);
  } catch { /* Profile display is optional; access still uses inventory_members. */ }
}
document.querySelector('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!client) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  authStatus.textContent = 'Connexion…';
  const { data, error } = await client.auth.signInWithPassword({ email: document.querySelector('#auth-email').value.trim(), password: document.querySelector('#auth-password').value });
  button.disabled = false;
  if (error) { authStatus.textContent = 'Connexion refusée. Vérifiez vos identifiants ou demandez l’accès à l’administrateur.'; return; }
  authStatus.textContent = '';
  await authorizeAndOpen(data.user);
});
document.querySelector('#sign-out').addEventListener('click', async () => { if (pending && !confirm('Des changements ne sont pas encore synchronisés. Se déconnecter les laissera sur cet appareil. Continuer ?')) return; await client?.auth.signOut(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && user && !conflictContext) pending ? syncNow() : refreshRemote(); });
window.addEventListener('online', () => { if (user && !conflictContext) pending ? syncNow() : refreshRemote(); });
search.addEventListener('input', render);
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  room = button.dataset.room;
  document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button));
  render();
}));
document.querySelectorAll('[data-room-shortcut]').forEach(button => button.addEventListener('click', () => {
  room = button.dataset.roomShortcut;
  document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item.dataset.room === room));
  render(); document.querySelector('#inventory-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
}));
function openDeviceForm(device = null) {
  form.reset();
  form.dataset.editId = device?.id || '';
  form.querySelector('h2').textContent = device ? 'Modifier l’appareil' : 'Ajouter un appareil';
  form.elements.name.value = device?.name || '';
  form.elements.room.value = device?.room || 'Cuisine';
  form.elements.brand.value = device?.brand || '';
  form.elements.model.value = device?.model || '';
  form.elements.warranty.value = device?.warrantyEndDate || '';
  form.elements.serialNumber.value = device?.serialNumber || '';
  form.elements.purchaseDate.value = device?.purchaseDate || '';
  form.elements.notes.value = device?.notes || '';
  deviceDialog.showModal();
}
document.querySelector('#add-item').addEventListener('click', () => openDeviceForm());
document.querySelector('#nav-add').addEventListener('click', () => openDeviceForm());
list.addEventListener('click', event => {
  const open = event.target.closest('[data-open]');
  if (!open) return;
  const device = devices.find(item => item.id === open.dataset.open);
  if (!device) return;
  document.querySelector('#detail-icon').textContent = device.icon || '⌂';
  document.querySelector('#detail-name').textContent = device.name;
  document.querySelector('#detail-subtitle').textContent = [device.brand, device.model, device.room].filter(Boolean).join(' · ');
  const warranty = warrantyInfo(device.warrantyEndDate);
  const warrantyBox = document.querySelector('#detail-warranty');
  warrantyBox.className = `detail-warranty ${warranty.className === 'unknown' ? 'no-warranty' : warranty.className === 'expired' ? 'expired' : ''}`;
  warrantyBox.textContent = warranty.detail;
  const deviceFiles = documents.filter(item => item.deviceId === device.id);
  document.querySelector('#detail-files').innerHTML = deviceFiles.length ? deviceFiles.map(file => `<div class="detail-manual"><span class="pdf-large">PDF</span><span><b>${escapeHtml(file.fileName)}</b><small>${file.kind === 'manual' ? 'Mode d’emploi' : file.kind === 'invoice' ? 'Facture' : 'Document'}</small></span><button type="button" data-download="${file.id}" aria-label="Ouvrir ${escapeHtml(file.fileName)}">↗</button></div>`).join('') : '<p class="no-files">Aucun document ajouté pour le moment.</p>';
  document.querySelector('#edit-device').dataset.editId = device.id;
  detailDialog.showModal();
});
document.querySelector('#detail-files').addEventListener('click', async event => {
  const button = event.target.closest('[data-download]'); if (!button) return;
  await openDocument(button.dataset.download);
});
document.querySelector('#document-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-download]'); if (button) await openDocument(button.dataset.download);
});
async function openDocument(id) {
  const file = documents.find(item => item.id === id); if (!file) return;
  const tab = window.open('about:blank', '_blank');
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(file.storagePath, 300);
  if (error) { tab?.close(); toast('Impossible d’ouvrir ce document pour le moment.'); return; }
  if (tab) tab.location = data.signedUrl;
  else window.location.assign(data.signedUrl);
}
document.querySelector('#close-detail').addEventListener('click', () => detailDialog.close());
document.querySelector('#edit-device').addEventListener('click', event => {
  const device = devices.find(item => item.id === event.currentTarget.dataset.editId);
  if (device) { detailDialog.close(); openDeviceForm(device); }
});
document.querySelector('#device-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  if (!user) return;
  if (conflictContext) { event.preventDefault(); toast('Résolvez les modifications en conflit avant de continuer.'); return; }
  const data = new FormData(event.currentTarget);
  const name = String(data.get('name') || '').trim(); if (!name) return;
  const editId = event.currentTarget.dataset.editId;
  let device = editId ? devices.find(item => item.id === editId) : null;
  if (!device) device = { id: crypto.randomUUID(), icon: '⌂', thumb: 'thumb-fridge', updatedAt: new Date().toISOString() };
  Object.assign(device, {
    name, room: String(data.get('room')), brand: String(data.get('brand') || '').trim(),
    model: String(data.get('model') || '').trim(), warrantyEndDate: String(data.get('warranty') || ''),
    serialNumber: String(data.get('serialNumber') || '').trim(), purchaseDate: String(data.get('purchaseDate') || ''),
    notes: String(data.get('notes') || '').trim(), updatedAt: new Date().toISOString()
  });
  if (editId) devices = devices.map(item => item.id === editId ? device : item);
  else devices.unshift(device);
  const file = data.get('document');
  event.currentTarget.reset(); delete event.currentTarget.dataset.editId;
  deviceDialog.close(); render(); persistLocalChange();
  if (file instanceof File && file.size) await uploadDocument(device, file);
  toast(editId ? 'Fiche mise à jour.' : 'Appareil ajouté.');
});
async function uploadDocument(device, file) {
  if (file.type !== 'application/pdf' || file.size > MAX_PDF_BYTES) { toast('Choisissez un PDF de 20 Mo maximum.'); return; }
  const storagePath = `${config.inventoryId}/${device.id}/${crypto.randomUUID()}.pdf`;
  setSync('pending', 'Envoi du document…', 'Téléversement sécurisé du PDF.', '↑');
  const { error } = await client.storage.from(BUCKET).upload(storagePath, file, { contentType: 'application/pdf', upsert: false });
  if (error) { setSync('error', 'Document non envoyé', readableError(error), '!'); toast('Le PDF n’a pas pu être envoyé.'); return; }
  documents.push({ id: crypto.randomUUID(), deviceId: device.id, kind: 'manual', fileName: file.name, storagePath, mimeType: 'application/pdf', byteSize: file.size, createdAt: new Date().toISOString() });
  render(); persistLocalChange();
}
document.querySelector('#more-button').addEventListener('click', () => toast(user?.email || 'Compte autorisé'));
document.querySelectorAll('.nav-item[href]').forEach(item => item.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(link => link.classList.remove('selected'));
  item.classList.add('selected');
}));
window.addEventListener('beforeunload', event => { if (pending) { event.preventDefault(); event.returnValue = ''; } });
render();
makeClient();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
