/* ════════════════════════════════════════════════
   AminoFold3D — app.js
   Usa la API CESGA real (api-mock-cesga.onrender.com)
   + Mol* (PDBe-Molstar) para la visualización 3D
   + Visualización de pLDDT por residuo, PAE, etc.
   + Cola de procesos con seguimiento multi-job
   ════════════════════════════════════════════════ */

const API_BASE = 'https://api-mock-cesga.onrender.com';

// ── Estado de la aplicación ──────────────────────
let currentJobId = null;
let pollInterval = null;
let molstarPlugins = {};   // instancias PDBeMolstarPlugin por visor
let currentData = null;   // outputs completos del job

// ── Cola de trabajos ──────────────────────────────
let jobQueue = [];  // [{id, name, status, pollInterval, data}]
let _jobCounter = 0;
let _blobUrls = {};  // blob URLs por visor

// ── Elementos DOM ────────────────────────────────
const views = {
    idle: document.getElementById('view-idle'),
    polling: document.getElementById('view-polling'),
    results: document.getElementById('view-results'),
};
const fastaInput = document.getElementById('fasta-input');
const btnSubmit = document.getElementById('btn-submit');
const logsEl = document.getElementById('job-logs');
const statusTitle = document.getElementById('job-status-title');
const statusSub = document.getElementById('job-status-sub');
const progressBar = document.getElementById('progress-bar');
const proteinNameInput = document.getElementById('protein-name-input');
const autocompleteBox = document.getElementById('name-autocomplete');
const fastaPreviewCard = document.getElementById('fasta-preview-card');
const fastaPreviewPre = document.getElementById('fasta-preview-content');
const fastaPreviewStats = document.getElementById('fasta-preview-stats');
const compareToggleBtn = document.getElementById('btn-toggle-compare');
const compareToggleLabel = document.getElementById('compare-toggle-label');
const comparisonConfigPanel = document.getElementById('comparison-config-panel');
const compareProteinNameInput = document.getElementById('compare-protein-name-input');
const compareAutocompleteBox = document.getElementById('compare-name-autocomplete');
const compareFastaInput = document.getElementById('compare-fasta-input');
const compareFastaPreviewCard = document.getElementById('compare-fasta-preview-card');
const compareFastaPreviewPre = document.getElementById('compare-fasta-preview-content');
const compareFastaPreviewStats = document.getElementById('compare-fasta-preview-stats');
const singleResultsLayout = document.getElementById('single-results-layout');
const comparisonResultsLayout = document.getElementById('comparison-results-layout');
const singleDownloadActions = document.getElementById('single-download-actions');
const btnDownloadCompareReport = document.getElementById('btn-download-compare-report');

const proteinForms = {
    primary: {
        slot: 'primary',
        nameInput: proteinNameInput,
        fastaInput,
        autocompleteBox,
        previewCard: fastaPreviewCard,
        previewPre: fastaPreviewPre,
        previewStats: fastaPreviewStats,
        searchButtonId: 'btn-search-protein',
    },
    secondary: {
        slot: 'secondary',
        nameInput: compareProteinNameInput,
        fastaInput: compareFastaInput,
        autocompleteBox: compareAutocompleteBox,
        previewCard: compareFastaPreviewCard,
        previewPre: compareFastaPreviewPre,
        previewStats: compareFastaPreviewStats,
        searchButtonId: 'btn-search-compare-protein',
    },
};

const autocompleteState = {
    primary: { debounce: null, selectedIdx: -1 },
    secondary: { debounce: null, selectedIdx: -1 },
};

let comparisonPanelOpen = false;

function getProteinForm(slot = 'primary') {
    return proteinForms[slot] ?? proteinForms.primary;
}

function getSearchButtonIcon() {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Buscar';
}

function clearViewerInstance(viewerKey) {
    if (molstarPlugins[viewerKey]) {
        try { molstarPlugins[viewerKey].clear(); } catch (_) { }
        delete molstarPlugins[viewerKey];
    }
    if (_blobUrls[viewerKey]) {
        URL.revokeObjectURL(_blobUrls[viewerKey]);
        delete _blobUrls[viewerKey];
    }
}

function clearAllViewers() {
    const keys = new Set([...Object.keys(molstarPlugins), ...Object.keys(_blobUrls)]);
    keys.forEach(clearViewerInstance);
}

function slugifyProteinName(name) {
    return name.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '_') || 'proteina';
}

function humanizeFastaHeader(header) {
    return (header || '').replace(/^>/, '').trim().replace(/_/g, ' ') || 'Proteína';
}

function parseFasta(rawValue) {
    const raw = rawValue.trim();
    if (!raw.startsWith('>')) return null;
    const lines = raw.split('\n');
    const header = lines[0].slice(1).trim();
    const sequence = lines.slice(1).join('').replace(/\s/g, '').toUpperCase();
    if (!sequence) return null;
    return { header, sequence };
}

function prepareSequenceForSubmission(slot = 'primary') {
    const form = getProteinForm(slot);
    let sequence = form.fastaInput.value.trim();
    const parsed = parseFasta(sequence);

    if (!sequence || !parsed) {
        return { error: "Por favor, introduce una secuencia FASTA válida que comience con '>'" };
    }

    const displayName = form.nameInput.value.trim() || humanizeFastaHeader(parsed.header);
    const lines = sequence.split('\n');
    lines[0] = '>' + slugifyProteinName(displayName);
    sequence = lines.join('\n');
    form.fastaInput.value = sequence;
    updateFastaPreview(slot);

    return { sequence, displayName };
}

function createMemberJob(jobId, name, slot) {
    return {
        id: jobId,
        name,
        slot,
        status: 'PENDING',
        data: null,
        errorMessage: null,
        loadingResults: false,
    };
}

// ════════════════════════════════════════════════
// 1. Helpers de navegación
// ════════════════════════════════════════════════
function showView(viewId) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[viewId].classList.add('active');
}

/** Navegar al inicio desde cualquier vista */
function goHome() {
    // No resetear la cola de trabajos, solo volver a la vista idle
    clearInterval(pollInterval);
    clearAllViewers();
    currentData = null;
    showView('idle');
    // Refrescar la cola visual
    renderJobQueue();
}

function appendLog(msg) {
    logsEl.textContent += msg + '\n';
    logsEl.scrollTop = logsEl.scrollHeight;
}

// ════════════════════════════════════════════════
// 2. Presets — carga FASTA desde la API real
// ════════════════════════════════════════════════
async function loadPreset(proteinId, slot = 'primary') {
    const form = getProteinForm(slot);
    form.fastaInput.value = 'Cargando...';
    form.nameInput.value = proteinId;
    try {
        const res = await fetch(`${API_BASE}/proteins/${proteinId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        form.fastaInput.value = data.fasta_ready ?? '>Error al cargar';
        // Sync name from FASTA header or API
        const name = data.protein_name ?? data.name ?? proteinId;
        form.nameInput.value = name;
        updateFastaPreview(slot);
    } catch (e) {
        form.fastaInput.value = `>Error de red: ${e.message}`;
        updateFastaPreview(slot);
    }
}

// ════════════════════════════════════════════════
// 2b. Nombre de proteína — búsqueda y autocompletado
//     Carga dinámica desde la API en vez de hardcodear
// ════════════════════════════════════════════════

// Cache de proteínas cargadas desde la API
let _allProteins = [];   // [{protein_id, protein_name, organism, ...}, ...]
let _proteinsLoaded = false;
let _proteinsLoading = false;

/** Carga la lista completa de proteínas desde la API (se llama una vez) */
async function fetchProteinList() {
    if (_proteinsLoaded || _proteinsLoading) return;
    _proteinsLoading = true;
    try {
        const res = await fetch(`${API_BASE}/proteins/`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _allProteins = await res.json();
        _proteinsLoaded = true;
        console.log(`[AminoFold3D] ${_allProteins.length} proteínas cargadas desde la API`);
    } catch (e) {
        console.warn('[AminoFold3D] No se pudo cargar la lista de proteínas:', e.message);
    } finally {
        _proteinsLoading = false;
    }
}

// Cargar proteínas al iniciar la aplicación
fetchProteinList();

function onProteinNameInput(val) {
    onProteinNameInputFor('primary', val);
}

function onCompareProteinNameInput(val) {
    onProteinNameInputFor('secondary', val);
}

function onProteinNameInputFor(slot, val) {
    const state = autocompleteState[slot];
    clearTimeout(state.debounce);
    state.selectedIdx = -1;
    if (!val.trim()) { hideAutocomplete(slot); return; }

    state.debounce = setTimeout(() => {
        const q = val.toLowerCase().trim();
        // Filtrar proteínas que empiecen por lo que escribió el usuario
        // Buscamos en protein_name y protein_id
        const matches = _allProteins.filter(p => {
            const name = (p.protein_name || '').toLowerCase();
            const id = (p.protein_id || '').toLowerCase();
            return name.startsWith(q) || id.startsWith(q);
        });
        // Si no hay coincidencias por prefijo, buscar por inclusión
        const results = matches.length > 0 ? matches : _allProteins.filter(p => {
            const name = (p.protein_name || '').toLowerCase();
            const id = (p.protein_id || '').toLowerCase();
            return name.includes(q) || id.includes(q);
        });
        showAutocomplete(slot, results.slice(0, 8));
    }, 150);

    // También sincronizar nombre en la cabecera FASTA
    syncNameToFasta(val, false, slot);
}

function onNameKeyDown(e) {
    onNameKeyDownFor('primary', e);
}

function onCompareNameKeyDown(e) {
    onNameKeyDownFor('secondary', e);
}

function onNameKeyDownFor(slot, e) {
    const form = getProteinForm(slot);
    const state = autocompleteState[slot];
    const items = form.autocompleteBox.querySelectorAll('.ac-item');
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.selectedIdx = Math.min(state.selectedIdx + 1, items.length - 1);
        highlightAcItem(items, slot);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.selectedIdx = Math.max(state.selectedIdx - 1, 0);
        highlightAcItem(items, slot);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (state.selectedIdx >= 0 && items[state.selectedIdx]) {
            items[state.selectedIdx].click();
        } else {
            searchProteinByNameFor(slot);
        }
    } else if (e.key === 'Escape') {
        hideAutocomplete(slot);
    }
}

function highlightAcItem(items, slot) {
    const state = autocompleteState[slot];
    items.forEach((it, i) => {
        it.classList.toggle('ac-highlighted', i === state.selectedIdx);
    });
    // Scroll into view
    if (items[state.selectedIdx]) {
        items[state.selectedIdx].scrollIntoView({ block: 'nearest' });
    }
}

async function searchProteinByName() {
    return searchProteinByNameFor('primary');
}

async function searchCompareProteinByName() {
    return searchProteinByNameFor('secondary');
}

async function searchProteinByNameFor(slot) {
    const form = getProteinForm(slot);
    const name = form.nameInput.value.trim();
    if (!name) return;
    hideAutocomplete(slot);
    const btn = document.getElementById(form.searchButtonId);
    btn.disabled = true;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Buscando...';

    try {
        // Buscar primero en la caché local por nombre o id
        const q = name.toLowerCase().trim();
        const match = _allProteins.find(p =>
            (p.protein_name || '').toLowerCase() === q ||
            (p.protein_id || '').toLowerCase() === q
        );
        const proteinId = match ? match.protein_id : name.toLowerCase().replace(/\s+/g, '_');

        // Fetch detallado de la proteína para obtener la FASTA
        const res = await fetch(`${API_BASE}/proteins/${encodeURIComponent(proteinId)}`);
        if (res.ok) {
            const data = await res.json();
            form.fastaInput.value = data.fasta_ready ?? '';
            const displayName = data.protein_name ?? data.name ?? name;
            form.nameInput.value = displayName;
            updateFastaPreview(slot);
        } else {
            // Nada encontrado — al menos pon el nombre en el header del FASTA
            syncNameToFasta(name, true, slot);
            showNameNotFound(name, slot);
        }
    } catch (e) {
        syncNameToFasta(name, true, slot);
        showNameNotFound(name, slot);
    } finally {
        btn.disabled = false;
        btn.innerHTML = getSearchButtonIcon();
    }
}

function showNameNotFound(name, slot = 'primary') {
    const form = getProteinForm(slot);
    const hint = document.createElement('div');
    hint.className = 'name-not-found';
    hint.textContent = `"${name}" no encontrado en la API — añade tu secuencia manualmente.`;
    hint.style.cssText = 'font-size:.8rem;color:var(--plddt-low);margin-top:.4rem;';
    // Show briefly
    const group = form.nameInput.closest('.name-group');
    const old = group.querySelector('.name-not-found');
    if (old) old.remove();
    group.appendChild(hint);
    setTimeout(() => hint.remove(), 4000);
}

function showAutocomplete(slot, suggestions) {
    const form = getProteinForm(slot);
    form.autocompleteBox.innerHTML = '';
    if (!suggestions.length) { hideAutocomplete(slot); return; }
    suggestions.forEach((protein, idx) => {
        const item = document.createElement('div');
        item.className = 'ac-item';
        item.setAttribute('role', 'option');

        // Mostrar nombre + organismo + longitud
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ac-name';
        nameSpan.textContent = protein.protein_name || protein.protein_id;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'ac-meta';
        metaSpan.textContent = `${protein.organism || ''} · ${protein.length || '?'} aa`;

        item.appendChild(nameSpan);
        item.appendChild(metaSpan);

        item.onclick = () => selectSuggestion(slot, protein);
        form.autocompleteBox.appendChild(item);
    });
    form.autocompleteBox.classList.remove('hidden');
}

function hideAutocomplete(slot = 'primary') {
    const form = getProteinForm(slot);
    form.autocompleteBox.classList.add('hidden');
    form.autocompleteBox.innerHTML = '';
    autocompleteState[slot].selectedIdx = -1;
}

async function selectSuggestion(slot, protein) {
    const form = getProteinForm(slot);
    form.nameInput.value = protein.protein_name || protein.protein_id;
    hideAutocomplete(slot);
    // Fetch la FASTA de la proteína individual
    loadPreset(protein.protein_id, slot);
}

/** Writes/updates the >header line of the current FASTA with `name`. */
function syncNameToFasta(name, forceEmpty = false, slot = 'primary') {
    const form = getProteinForm(slot);
    const slug = slugifyProteinName(name);
    const cur = form.fastaInput.value;
    if (cur.startsWith('>')) {
        const lines = cur.split('\n');
        lines[0] = '>' + slug;
        form.fastaInput.value = lines.join('\n');
    } else if (forceEmpty || !cur.trim()) {
        form.fastaInput.value = '>' + slug + '\n';
    }
    updateFastaPreview(slot);
}

// ════════════════════════════════════════════════
// 2c. Cuando se edita el FASTA directamente
// ════════════════════════════════════════════════
function onFastaInput() {
    onFastaInputFor('primary');
}

function onCompareFastaInput() {
    onFastaInputFor('secondary');
}

function onFastaInputFor(slot = 'primary') {
    const form = getProteinForm(slot);
    const val = form.fastaInput.value;
    // Parse the header to sync the name input
    if (val.startsWith('>')) {
        const firstLine = val.split('\n')[0].slice(1).trim();
        if (firstLine) {
            form.nameInput.value = firstLine.replace(/_/g, ' ');
        }
    }
    updateFastaPreview(slot);
}

// ════════════════════════════════════════════════
// 2d. Previsualización del FASTA
// ════════════════════════════════════════════════
function updateFastaPreview(slot = 'primary') {
    const form = getProteinForm(slot);
    const parsed = parseFasta(form.fastaInput.value);
    if (!parsed) {
        form.previewCard.classList.add('hidden');
        return;
    }

    // Format: 60 chars per line
    const wrapped = parsed.sequence.match(/.{1,60}/g) || [];
    const formatted = '>' + parsed.header + '\n' + wrapped.join('\n');

    form.previewPre.textContent = formatted;
    form.previewStats.textContent = `${parsed.sequence.length} residuos · ${Math.round(parsed.sequence.length * 110 / 1000)} kDa est.`;
    form.previewCard.classList.remove('hidden');
}

// ════════════════════════════════════════════════
// 2e. Descarga del archivo .fasta
// ════════════════════════════════════════════════
function downloadFasta() {
    downloadFastaFor('primary');
}

function downloadCompareFasta() {
    downloadFastaFor('secondary');
}

function downloadFastaFor(slot = 'primary') {
    const form = getProteinForm(slot);
    const raw = form.fastaInput.value.trim();
    if (!raw) return;
    // Parse header for filename
    const firstLine = raw.startsWith('>') ? raw.split('\n')[0].slice(1).trim() : 'proteina';
    const safeSlug = firstLine.replace(/[^\w\-]/g, '_').toLowerCase() || 'proteina';
    const seqRaw = raw.split('\n').slice(1).join('').replace(/\s/g, '').toUpperCase();
    const wrapped = seqRaw.match(/.{1,60}/g) || [];
    const content = '>' + firstLine + '\n' + wrapped.join('\n') + '\n';
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeSlug + '.fasta';
    a.click();
    URL.revokeObjectURL(url);
}

function toggleComparisonSection() {
    setComparisonSectionOpen(!comparisonPanelOpen);
}

function closeComparisonSection() {
    setComparisonSectionOpen(false, { reset: true });
}

function setComparisonSectionOpen(isOpen, options = {}) {
    comparisonPanelOpen = isOpen;
    comparisonConfigPanel.classList.toggle('is-open', isOpen);
    comparisonConfigPanel.setAttribute('aria-hidden', String(!isOpen));
    compareToggleBtn.classList.toggle('active', isOpen);
    compareToggleBtn.setAttribute('aria-expanded', String(isOpen));
    compareToggleLabel.textContent = isOpen ? 'Ocultar proteína comparativa' : 'Comparar con otra molécula';

    if (!isOpen && options.reset) {
        resetComparisonInputs();
    }

    if (isOpen) {
        requestAnimationFrame(() => compareProteinNameInput.focus());
    }
}

function resetComparisonInputs() {
    compareProteinNameInput.value = '';
    compareFastaInput.value = '';
    hideAutocomplete('secondary');
    compareFastaPreviewCard.classList.add('hidden');
    compareFastaPreviewPre.textContent = '';
    compareFastaPreviewStats.textContent = '';
}

// ════════════════════════════════════════════════
// 3. Envío del job — POST /jobs/submit
//    Ahora añade a la cola en vez de cambiar de vista
// ════════════════════════════════════════════════
btnSubmit.addEventListener('click', async () => {
    const primary = prepareSequenceForSubmission('primary');
    if (primary.error) {
        alert(primary.error);
        return;
    }

    const compareRequested = comparisonPanelOpen;
    const secondary = compareRequested ? prepareSequenceForSubmission('secondary') : null;
    if (secondary?.error) {
        alert('Activa la comparativa solo cuando la proteína 2 tenga un FASTA válido.');
        return;
    }

    try {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Enviando...';

        if (compareRequested && secondary) {
            const comparativeRequests = [
                { slot: 'primary', displayName: primary.displayName, sequence: primary.sequence },
                { slot: 'secondary', displayName: secondary.displayName, sequence: secondary.sequence },
            ];
            const settled = await Promise.allSettled(
                comparativeRequests.map(item => submitPredictionJob(item.sequence))
            );

            const successful = [];
            const failed = [];

            settled.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    successful.push({
                        ...comparativeRequests[index],
                        response: result.value,
                    });
                } else {
                    failed.push(`${comparativeRequests[index].displayName}: ${result.reason?.message ?? result.reason}`);
                }
            });

            if (successful.length === 2) {
                addJobToQueue({
                    id: `cmp-${Date.now()}-${_jobCounter + 1}`,
                    name: `${primary.displayName} vs ${secondary.displayName}`,
                    status: 'PENDING',
                    createdAt: Date.now(),
                    data: null,
                    pollInterval: null,
                    errorMessage: null,
                    isComparison: true,
                    members: [
                        createMemberJob(successful[0].response.job_id, primary.displayName, 'primary'),
                        createMemberJob(successful[1].response.job_id, secondary.displayName, 'secondary'),
                    ],
                });
                setComparisonSectionOpen(false, { reset: true });
            } else if (successful.length === 1) {
                const survivor = successful[0];
                addJobToQueue(survivor.response.job_id, survivor.displayName);
                alert(`La comparativa no se lanzó completa.\n${failed.join('\n')}\n\n${survivor.displayName} sí quedó en cola como predicción individual.`);
            } else {
                throw new Error(failed.join(' | ') || 'No se pudieron lanzar las predicciones comparativas.');
            }
        } else {
            const data = await submitPredictionJob(primary.sequence);
            addJobToQueue(data.job_id, primary.displayName);
        }

        resetSubmitBtn();
    } catch (e) {
        alert('Error al conectar con la API CESGA:\n' + e.message);
        resetSubmitBtn();
    }
});

async function submitPredictionJob(sequence) {
    const payload = {
        fasta_sequence: sequence,
        fasta_filename: 'query.fasta',
        gpus: 1,
        cpus: 8,
        memory_gb: 32.0,
        max_runtime_seconds: 3600,
    };

    const res = await fetch(`${API_BASE}/jobs/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status}: ${errBody}`);
    }

    return res.json();
}

// ════════════════════════════════════════════════
// 3b. Cola de trabajos — gestión multi-job
// ════════════════════════════════════════════════

function addJobToQueue(jobIdOrConfig, jobName) {
    _jobCounter++;
    const job = typeof jobIdOrConfig === 'object' && jobIdOrConfig !== null
        ? {
            status: 'PENDING',
            createdAt: Date.now(),
            data: null,
            pollInterval: null,
            errorMessage: null,
            isComparison: false,
            ...jobIdOrConfig,
        }
        : {
            id: jobIdOrConfig,
            name: jobName,
            status: 'PENDING',
            createdAt: Date.now(),
            data: null,
            pollInterval: null,
            errorMessage: null,
            isComparison: false,
            members: [createMemberJob(jobIdOrConfig, jobName, 'primary')],
        };

    jobQueue.push(job);
    renderJobQueue();
    startJobPolling(job);
}

function startJobPolling(job) {
    job.pollInterval = setInterval(() => pollJobStatus(job), 3000);
    pollJobStatus(job);
}

async function pollJobStatus(job) {
    await Promise.all(job.members.map(member => updateMemberStatus(job, member)));
    finalizeJobState(job);
    renderJobQueue();
}

async function updateMemberStatus(job, member) {
    if (member.status === 'READY' || member.status === 'FAILED' || member.loadingResults) return;

    try {
        const res = await fetch(`${API_BASE}/jobs/${member.id}/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        member.status = data.status;
        if (data.status === 'COMPLETED') {
            await fetchMemberResults(member);
        } else if (data.status === 'FAILED') {
            member.status = 'FAILED';
            member.errorMessage = data.error_message ?? 'Error desconocido';
        }
    } catch (e) {
        console.warn(`[AminoFold3D] Error polling job ${member.id}:`, e.message);
    }
}

async function fetchMemberResults(member) {
    member.loadingResults = true;
    try {
        member.data = await fetchOutputsAndAccounting(member.id);
        member.status = 'READY';
    } catch (e) {
        member.status = 'FAILED';
        member.errorMessage = 'Error descargando resultados: ' + e.message;
    } finally {
        member.loadingResults = false;
    }
}

async function fetchOutputsAndAccounting(jobId) {
    const [outRes, accRes] = await Promise.all([
        fetch(`${API_BASE}/jobs/${jobId}/outputs`),
        fetch(`${API_BASE}/jobs/${jobId}/accounting`),
    ]);
    if (!outRes.ok) throw new Error(`outputs HTTP ${outRes.status}`);
    if (!accRes.ok) throw new Error(`accounting HTTP ${accRes.status}`);

    const outputs = await outRes.json();
    const accounting = await accRes.json();
    return { outputs, accounting };
}

function finalizeJobState(job) {
    const failedMember = job.members.find(member => member.status === 'FAILED');
    if (failedMember) {
        if (job.pollInterval) {
            clearInterval(job.pollInterval);
            job.pollInterval = null;
        }
        job.status = 'FAILED';
        job.errorMessage = failedMember.errorMessage ?? 'Error desconocido';
        return;
    }

    if (job.members.every(member => member.status === 'READY')) {
        if (job.pollInterval) {
            clearInterval(job.pollInterval);
            job.pollInterval = null;
        }
        job.status = 'READY';
        job.data = job.isComparison
            ? buildComparisonJobData(job)
            : {
                mode: 'single',
                jobId: job.members[0].id,
                outputs: job.members[0].data.outputs,
                accounting: job.members[0].data.accounting,
            };
        return;
    }

    if (job.members.some(member => ['RUNNING', 'COMPLETED', 'READY'].includes(member.status))) {
        job.status = 'RUNNING';
    } else {
        job.status = 'PENDING';
    }
}

function buildComparisonJobData(job) {
    const [primary, secondary] = job.members;
    return {
        mode: 'comparison',
        groupId: job.id,
        title: job.name,
        primary: {
            ...primary.data,
            jobId: primary.id,
            requestedName: primary.name,
        },
        secondary: {
            ...secondary.data,
            jobId: secondary.id,
            requestedName: secondary.name,
        },
    };
}

function viewJobResults(jobId) {
    const job = jobQueue.find(j => j.id === jobId);
    if (!job || !job.data) return;

    currentJobId = job.id;
    currentData = job.data;

    renderDashboard(job.data);
    showView('results');
}

function removeJobFromQueue(jobId) {
    const idx = jobQueue.findIndex(j => j.id === jobId);
    if (idx === -1) return;
    const job = jobQueue[idx];
    if (job.pollInterval) clearInterval(job.pollInterval);
    jobQueue.splice(idx, 1);
    renderJobQueue();
}

function renderJobQueue() {
    const section = document.getElementById('job-queue-section');
    const list = document.getElementById('job-queue-list');
    const countEl = document.getElementById('job-queue-count');

    if (jobQueue.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    const active = jobQueue.filter(j => j.status === 'PENDING' || j.status === 'RUNNING').length;
    const done = jobQueue.filter(j => j.status === 'READY' || j.status === 'COMPLETED').length;
    countEl.textContent = `${jobQueue.length} trabajo${jobQueue.length !== 1 ? 's' : ''} · ${active} activo${active !== 1 ? 's' : ''} · ${done} listo${done !== 1 ? 's' : ''}`;

    list.innerHTML = '';
    jobQueue.forEach(job => {
        const card = document.createElement('div');
        card.className = `job-card job-card--${job.status.toLowerCase()}`;
        card.id = `job-card-${job.id}`;

        const isActive = job.status === 'PENDING' || job.status === 'RUNNING';
        const isReady = job.status === 'READY' || job.status === 'COMPLETED';
        const isFailed = job.status === 'FAILED';

        // Status badge text
        const statusLabels = {
            'PENDING': 'En Cola',
            'RUNNING': 'Ejecutando',
            'COMPLETED': 'Listo',
            'READY': 'Listo',
            'FAILED': 'Error',
        };

        // Elapsed time
        const elapsed = formatElapsed(Date.now() - job.createdAt);
        const comparisonBadge = job.isComparison
            ? '<span class="job-status-badge job-status--compare">Comparativa</span>'
            : '';
        const jobIds = job.isComparison
            ? job.members.map(member => member.id).join(' · ')
            : job.id;

        card.innerHTML = `
            <div class="job-card-header">
                <div class="job-card-info">
                    <div class="job-card-name">${escapeHtml(job.name)}</div>
                    <div class="job-card-meta">
                        <span class="job-status-badge job-status--${job.status.toLowerCase()}">${statusLabels[job.status] ?? job.status}</span>
                        ${comparisonBadge}
                        <span class="job-card-elapsed">${elapsed}</span>
                        <span class="job-card-id">ID: ${jobIds}</span>
                    </div>
                </div>
                <div class="job-card-actions">
                    ${isReady ? `<button class="glass-btn small job-view-btn" onclick="viewJobResults('${job.id}')">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        Ver Resultados
                    </button>` : ''}
                    <button class="job-remove-btn" onclick="removeJobFromQueue('${job.id}')" title="Eliminar de la cola">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>
            <div class="job-card-preview">
                ${isActive ? `
                    <div class="job-mini-spinner">
                        <div class="spinner-inner mini">
                            <div class="spinner-line"></div>
                            <div class="spinner-line"></div>
                            <div class="spinner-line"></div>
                            <div class="spinner-circle">&#9679;</div>
                        </div>
                    </div>
                    <div class="job-progress-bar-container">
                        <div class="job-progress-bar"></div>
                    </div>
                    <div class="job-status-text">${job.isComparison
                    ? 'Comparando ambas proteínas en paralelo...'
                    : job.status === 'PENDING' ? 'Esperando recursos GPU...' : 'Generando MSA e inferencia neuronal...'}</div>
                    ${job.isComparison ? `
                        <div class="job-compare-summary">
                            ${job.members.map(member => `<div>${escapeHtml(member.name)}: ${memberStatusLabel(member.status)}</div>`).join('')}
                        </div>
                    ` : ''}
                ` : isReady ? `
                    <div class="job-ready-preview" onclick="viewJobResults('${job.id}')">
                        <div class="job-ready-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                <polyline points="22 4 12 14.01 9 11.01"/>
                            </svg>
                        </div>
                        <div class="job-ready-label">${job.isComparison
                    ? 'Comparativa completada — clic para abrir el análisis dual'
                    : 'Predicción completada — clic para ver estadísticas'}</div>
                    </div>
                ` : isFailed ? `
                    <div class="job-failed-preview">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                        <span>${escapeHtml(job.errorMessage || 'Error desconocido')}</span>
                    </div>
                ` : ''}
            </div>
        `;

        list.appendChild(card);
    });
}

function memberStatusLabel(status) {
    const labels = {
        PENDING: 'en cola',
        RUNNING: 'ejecutando',
        COMPLETED: 'descargando resultados',
        READY: 'listo',
        FAILED: 'error',
    };
    return labels[status] ?? status.toLowerCase();
}

function formatElapsed(ms) {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const rest = secs % 60;
    return `${mins}m ${rest}s`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Actualizar tiempos cada segundo
setInterval(() => {
    if (jobQueue.some(j => j.status === 'PENDING' || j.status === 'RUNNING')) {
        renderJobQueue();
    }
}, 1000);

// ════════════════════════════════════════════════
// 4. Polling — GET /jobs/{id}/status  cada 3 s
// ════════════════════════════════════════════════
function startPolling() {
    showView('polling');
    updateStepper('PENDING');
    logsEl.textContent = '';
    appendLog('> Job ' + currentJobId + ' enviado a CESGA Slurm');
    appendLog('> Esperando recursos GPU...');

    statusTitle.textContent = 'En Cola del CESGA';
    statusSub.textContent = 'Esperando recursos GPU libres...';

    pollInterval = setInterval(pollStatus, 3000);
}

async function pollStatus() {
    try {
        const res = await fetch(`${API_BASE}/jobs/${currentJobId}/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        appendLog(`> [${new Date().toLocaleTimeString()}] Estado: ${data.status}`);

        switch (data.status) {
            case 'PENDING':
                updateStepper('PENDING');
                statusTitle.textContent = 'En Cola del CESGA';
                statusSub.textContent = 'Esperando recursos GPU libres...';
                break;

            case 'RUNNING':
                updateStepper('RUNNING');
                statusTitle.textContent = 'Ejecutando AlphaFold2';
                statusSub.textContent = 'Generando MSA e inferencia neuronal...';
                break;

            case 'COMPLETED':
                updateStepper('COMPLETED');
                clearInterval(pollInterval);
                appendLog('> Job COMPLETADO — descargando resultados...');
                fetchResults();
                break;

            case 'FAILED':
                updateStepper('FAILED');
                clearInterval(pollInterval);
                appendLog('> [ERROR] El job falló en CESGA.');
                statusTitle.textContent = 'Error en el cálculo';
                statusSub.textContent = data.error_message ?? 'Error desconocido';
                progressBar.style.animation = 'none';
                progressBar.style.background = '#ff007b';
                resetSubmitBtn();
                break;

            default:
                appendLog(`> Estado desconocido: ${data.status}`);
        }
    } catch (e) {
        appendLog(`> [WARN] Error de red durante polling: ${e.message}`);
    }
}

// Stepper
function updateStepper(state) {
    const steps = {
        pending: document.getElementById('step-pending'),
        running: document.getElementById('step-running'),
        completed: document.getElementById('step-completed'),
    };
    const lines = {
        pr: document.getElementById('line-pending-running'),
        rc: document.getElementById('line-running-completed'),
    };

    // Reset
    Object.values(steps).forEach(s => s.className = 'step');
    Object.values(lines).forEach(l => l.className = 'step-line');

    if (state === 'PENDING') {
        steps.pending.classList.add('active');

    } else if (state === 'RUNNING') {
        steps.pending.classList.add('completed');
        lines.pr.classList.add('active');
        steps.running.classList.add('active');

    } else if (state === 'COMPLETED') {
        steps.pending.classList.add('completed');
        lines.pr.classList.add('active');
        steps.running.classList.add('completed');
        lines.rc.classList.add('active');
        steps.completed.classList.add('completed');

    } else if (state === 'FAILED') {
        steps.pending.classList.add('failed');
        steps.running.classList.add('failed');
        steps.completed.classList.add('failed');
    }
}

// ════════════════════════════════════════════════
// 5. Fetch de resultados — /outputs + /accounting
// ════════════════════════════════════════════════
async function fetchResults() {
    statusTitle.textContent = 'Descargando resultados...';

    try {
        const { outputs, accounting } = await fetchOutputsAndAccounting(currentJobId);

        currentData = {
            mode: 'single',
            jobId: currentJobId,
            outputs,
            accounting,
        };

        renderDashboard(currentData);
        showView('results');

    } catch (e) {
        alert('Error al cargar los resultados:\n' + e.message);
    } finally {
        resetSubmitBtn();
    }
}

// ════════════════════════════════════════════════
// 6. Render del dashboard completo
// ════════════════════════════════════════════════
function renderDashboard(dataOrOutputs, accounting = null) {
    const data = normalizeDashboardData(dataOrOutputs, accounting);
    clearAllViewers();

    if (data.mode === 'comparison') {
        renderComparisonDashboard(data);
    } else {
        renderSingleDashboard(data);
    }
}

function normalizeDashboardData(dataOrOutputs, accounting = null) {
    if (accounting) {
        return {
            mode: 'single',
            jobId: currentJobId,
            outputs: dataOrOutputs,
            accounting,
        };
    }

    if (dataOrOutputs?.mode) return dataOrOutputs;
    return {
        mode: 'single',
        jobId: currentJobId,
        outputs: dataOrOutputs?.outputs ?? dataOrOutputs,
        accounting: dataOrOutputs?.accounting ?? {},
    };
}

function setResultsMode(mode) {
    const badge = document.getElementById('res-source-badge');
    const labels = {
        plddt: document.getElementById('res-plddt-top-label'),
        pae: document.getElementById('res-pae-top-label'),
        length: document.getElementById('res-length-top-label'),
        mw: document.getElementById('res-mw-top-label'),
    };

    if (mode === 'comparison') {
        singleResultsLayout.classList.add('hidden');
        comparisonResultsLayout.classList.remove('hidden');
        singleDownloadActions.classList.add('hidden');
        btnDownloadCompareReport.classList.remove('hidden');
        badge.classList.add('is-comparison');
        labels.plddt.textContent = 'pLDDT P1/P2';
        labels.pae.textContent = 'PAE P1/P2';
        labels.length.textContent = 'Resid. P1/P2';
        labels.mw.textContent = 'Peso P1/P2';
    } else {
        singleResultsLayout.classList.remove('hidden');
        comparisonResultsLayout.classList.add('hidden');
        singleDownloadActions.classList.remove('hidden');
        btnDownloadCompareReport.classList.add('hidden');
        badge.classList.remove('is-comparison');
        labels.plddt.textContent = 'pLDDT global';
        labels.pae.textContent = 'PAE medio';
        labels.length.textContent = 'Residuos';
        labels.mw.textContent = 'Peso Mol.';
    }
}

function renderSingleDashboard(data) {
    setResultsMode('single');

    const outputs = data.outputs ?? {};
    const accounting = data.accounting ?? {};
    const meta = outputs.protein_metadata ?? {};
    const struct = outputs.structural_data ?? {};
    const conf = struct.confidence ?? {};
    const bio = outputs.biological_data ?? {};

    if (meta && Object.keys(meta).length) {
        document.getElementById('res-protein-name').textContent = meta.protein_name ?? 'Proteína desconocida';
        document.getElementById('res-protein-organism').textContent =
            `${meta.organism ?? '—'} · UniProt: ${meta.uniprot_id ?? '—'} · PDB: ${meta.pdb_id ?? '—'}`;
        document.getElementById('res-source-badge').textContent = meta.data_source === 'precomputed_database'
            ? 'Base de datos precalculada'
            : 'AlphaFold2 predicho';
    } else {
        document.getElementById('res-protein-name').textContent = data.requestedName ?? 'Proteína sintética';
        document.getElementById('res-protein-organism').textContent = 'Secuencia personalizada';
        document.getElementById('res-source-badge').textContent = 'AlphaFold2 predicho';
    }

    const plddt = conf.plddt_mean ?? 0;
    document.getElementById('res-plddt-top').textContent = plddt.toFixed(1);
    document.getElementById('res-plddt-top').style.color = plddtColor(plddt);
    document.getElementById('res-pae-top').textContent = (conf.mean_pae ?? 0).toFixed(2) + ' Å';
    document.getElementById('res-length-top').textContent = bio.sequence_properties?.length ?? '—';
    document.getElementById('res-mw-top').textContent =
        (bio.sequence_properties?.molecular_weight_kda ?? '—') + ' kDa';

    const plddtEl = document.getElementById('res-plddt');
    plddtEl.textContent = plddt.toFixed(1);
    plddtEl.style.color = plddtColor(plddt);
    document.getElementById('res-plddt-label').textContent = plddtLabel(plddt);

    renderPlddtHistogram(conf.plddt_histogram);
    renderPlddtChart(conf.plddt_per_residue ?? []);
    renderPaeMatrix(conf.pae_matrix ?? []);

    const ss = bio.secondary_structure_prediction;
    if (ss) renderSecondaryStructure(ss);

    const props = bio.sequence_properties;
    renderBioGrid([
        { label: 'Solubilidad', val: `${bio.solubility_prediction} (${bio.solubility_score?.toFixed(1)}%)` },
        { label: 'Estabilidad', val: bio.stability_status },
        { label: 'I. Instabilidad', val: bio.instability_index?.toFixed(2) },
        { label: 'Peso Mol.', val: props ? `${props.molecular_weight_kda} kDa` : '—' },
        { label: 'Cys (# res)', val: props?.cysteine_residues ?? '—' },
        { label: 'Aromáticos', val: props?.aromatic_residues ?? '—' },
    ]);

    const alerts = [];
    (bio.toxicity_alerts ?? []).forEach(a => alerts.push({ type: 'warning', text: '⚠️ Toxicidad: ' + a }));
    (bio.allergenicity_alerts ?? []).forEach(a => alerts.push({ type: 'info', text: 'ℹ️ Alergenicidad: ' + a }));
    renderAlerts(alerts);

    const acc = accounting.accounting ?? {};
    renderHPC([
        { label: 'GPU Horas', val: acc.gpu_hours?.toFixed(4) + ' h' },
        { label: 'CPU Horas', val: acc.cpu_hours?.toFixed(4) + ' h' },
        { label: 'RAM · Hora', val: acc.memory_gb_hours?.toFixed(2) + ' GB·h' },
        { label: 'Tiempo de pared', val: formatSeconds(acc.wall_time_seconds) },
        { label: 'Nodo', val: acc.node_name ?? '—' },
        { label: 'Partición', val: acc.partition ?? '—' },
    ]);

    const logsResult = document.getElementById('result-logs');
    logsResult.textContent = typeof outputs.logs === 'string'
        ? outputs.logs
        : JSON.stringify(outputs.logs, null, 2);

    const cifData = struct.cif_file;
    const pdbData = struct.pdb_file;
    init3DViewer(cifData || pdbData, cifData ? 'cif' : 'pdb', 'viewer-container', 'single');
}

function renderComparisonDashboard(data) {
    setResultsMode('comparison');

    const primary = extractProteinSummary(data.primary, 'Proteína 1');
    const secondary = extractProteinSummary(data.secondary, 'Proteína 2');
    const logsResult = document.getElementById('result-logs');

    document.getElementById('res-source-badge').textContent = 'Comparativa';
    document.getElementById('res-protein-name').textContent = `${primary.name} vs ${secondary.name}`;
    document.getElementById('res-protein-organism').textContent = `${primary.organism} vs ${secondary.organism}`;
    document.getElementById('res-plddt-top').textContent = `${primary.plddt.toFixed(1)} vs ${secondary.plddt.toFixed(1)}`;
    document.getElementById('res-plddt-top').style.color = 'var(--primary)';
    document.getElementById('res-pae-top').textContent = `${primary.pae.toFixed(2)} vs ${secondary.pae.toFixed(2)} Å`;
    document.getElementById('res-length-top').textContent = `${primary.length ?? '—'} vs ${secondary.length ?? '—'}`;
    document.getElementById('res-mw-top').textContent = `${formatShortNumber(primary.mw)} vs ${formatShortNumber(secondary.mw)} kDa`;

    const primaryScore = document.getElementById('compare-protein-one-score');
    const secondaryScore = document.getElementById('compare-protein-two-score');
    document.getElementById('compare-protein-one-title').textContent = primary.name;
    document.getElementById('compare-protein-two-title').textContent = secondary.name;
    primaryScore.textContent = `${primary.plddt.toFixed(1)} pLDDT`;
    primaryScore.style.color = plddtColor(primary.plddt);
    secondaryScore.textContent = `${secondary.plddt.toFixed(1)} pLDDT`;
    secondaryScore.style.color = plddtColor(secondary.plddt);

    renderComparisonSummary('compare-summary-one', primary);
    renderComparisonSummary('compare-summary-two', secondary);
    renderComparisonOverview(primary, secondary);
    renderComparisonDeltaGrid(primary, secondary);

    init3DViewer(primary.structureData, primary.structureFormat, 'compare-viewer-one', 'compare-one');
    init3DViewer(secondary.structureData, secondary.structureFormat, 'compare-viewer-two', 'compare-two');

    logsResult.textContent = buildComparisonLogs(primary, secondary);
}

function extractProteinSummary(data, fallbackName) {
    const outputs = data?.outputs ?? {};
    const accounting = data?.accounting ?? {};
    const meta = outputs.protein_metadata ?? {};
    const struct = outputs.structural_data ?? {};
    const conf = struct.confidence ?? {};
    const bio = outputs.biological_data ?? {};
    const props = bio.sequence_properties ?? {};
    const ss = bio.secondary_structure_prediction ?? {};

    return {
        name: meta.protein_name ?? data?.requestedName ?? fallbackName,
        organism: meta.organism ?? 'Secuencia personalizada',
        sourceLabel: meta.data_source === 'precomputed_database' ? 'Base de datos precalculada' : 'AlphaFold2 predicho',
        plddt: Number(conf.plddt_mean ?? 0),
        pae: Number(conf.mean_pae ?? 0),
        length: props.length ?? null,
        mw: props.molecular_weight_kda ?? null,
        stability: bio.stability_status ?? '—',
        solubility: bio.solubility_prediction ?? '—',
        solubilityScore: bio.solubility_score ?? null,
        dominantSecondary: dominantSecondaryStructure(ss),
        structureData: struct.cif_file || struct.pdb_file || '',
        structureFormat: struct.cif_file ? 'cif' : 'pdb',
        logs: typeof outputs.logs === 'string'
            ? outputs.logs
            : JSON.stringify(outputs.logs ?? {}, null, 2),
    };
}

function dominantSecondaryStructure(ss = {}) {
    const entries = [
        ['hélice α', ss.helix_percent ?? 0],
        ['hebra β', ss.strand_percent ?? 0],
        ['coil', ss.coil_percent ?? 0],
    ];
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
}

function renderComparisonSummary(targetId, summary) {
    const container = document.getElementById(targetId);
    container.innerHTML = `
        <p class="compare-summary-copy">${buildProteinSnapshotText(summary)}</p>
        <div class="compare-summary-stats">
            <span class="compare-summary-chip">PAE ${summary.pae.toFixed(2)} Å</span>
            <span class="compare-summary-chip">${summary.length ?? '—'} residuos</span>
            <span class="compare-summary-chip">${formatShortNumber(summary.mw)} kDa</span>
            <span class="compare-summary-chip">${summary.solubility}</span>
            <span class="compare-summary-chip">${summary.stability}</span>
        </div>
    `;
}

function buildProteinSnapshotText(summary) {
    const confidence = summary.plddt >= 70
        ? 'muestra una confianza estructural sólida'
        : 'presenta una confianza estructural más incierta';
    const solubility = summary.solubilityScore != null
        ? `solubilidad ${summary.solubility} (${summary.solubilityScore.toFixed(1)}%)`
        : `solubilidad ${summary.solubility}`;
    return `${summary.name} ${confidence}, con predominio de ${summary.dominantSecondary}, ${solubility} y estado ${summary.stability}.`;
}

function renderComparisonOverview(primary, secondary) {
    const container = document.getElementById('comparison-overview');
    const betterPlddt = primary.plddt >= secondary.plddt ? primary : secondary;
    const betterPae = primary.pae <= secondary.pae ? primary : secondary;
    const longer = (primary.length ?? 0) >= (secondary.length ?? 0) ? primary : secondary;

    container.innerHTML = `
        <div class="comparison-overview-item">
            <div class="comparison-overview-label">Mejor confianza global</div>
            <div class="comparison-overview-text">${betterPlddt.name} lidera con pLDDT ${betterPlddt.plddt.toFixed(1)}.</div>
        </div>
        <div class="comparison-overview-item">
            <div class="comparison-overview-label">Posicionamiento relativo</div>
            <div class="comparison-overview-text">${betterPae.name} tiene el PAE medio más bajo (${betterPae.pae.toFixed(2)} Å).</div>
        </div>
        <div class="comparison-overview-item">
            <div class="comparison-overview-label">Lectura rápida</div>
            <div class="comparison-overview-text">${buildComparisonNarrative(primary, secondary)} ${longer.length != null ? `${longer.name} es la cadena más larga (${longer.length} aa).` : ''}</div>
        </div>
    `;
}

function renderComparisonDeltaGrid(primary, secondary) {
    const container = document.getElementById('comparison-delta-grid');
    const items = [
        {
            label: 'pLDDT medio',
            left: `${primary.plddt.toFixed(1)}`,
            right: `${secondary.plddt.toFixed(1)}`,
            delta: `Δ ${Math.abs(primary.plddt - secondary.plddt).toFixed(1)}`,
        },
        {
            label: 'PAE medio',
            left: `${primary.pae.toFixed(2)} Å`,
            right: `${secondary.pae.toFixed(2)} Å`,
            delta: `Δ ${Math.abs(primary.pae - secondary.pae).toFixed(2)} Å`,
        },
        {
            label: 'Longitud',
            left: `${primary.length ?? '—'} aa`,
            right: `${secondary.length ?? '—'} aa`,
            delta: `Δ ${Math.abs((primary.length ?? 0) - (secondary.length ?? 0))} aa`,
        },
        {
            label: 'Estructura dominante',
            left: primary.dominantSecondary,
            right: secondary.dominantSecondary,
            delta: primary.dominantSecondary === secondary.dominantSecondary ? 'Perfil similar' : 'Perfil distinto',
        },
    ];

    container.innerHTML = items.map(item => `
        <div class="comparison-delta-item">
            <div class="comparison-delta-label">${item.label}</div>
            <div class="comparison-delta-values">
                <div class="comparison-delta-row">
                    <span class="comparison-delta-name">${primary.name}</span>
                    <span class="comparison-delta-value">${item.left}</span>
                </div>
                <div class="comparison-delta-row">
                    <span class="comparison-delta-name">${secondary.name}</span>
                    <span class="comparison-delta-value">${item.right}</span>
                </div>
            </div>
            <div class="comparison-delta-foot">${item.delta}</div>
        </div>
    `).join('');
}

function buildComparisonNarrative(primary, secondary) {
    const plddtDiff = Math.abs(primary.plddt - secondary.plddt);
    const paeDiff = Math.abs(primary.pae - secondary.pae);
    const confidenceLine = plddtDiff < 3
        ? 'Ambas proteínas tienen un nivel de confianza bastante parecido.'
        : `${(primary.plddt > secondary.plddt ? primary.name : secondary.name)} ofrece una geometría global más fiable.`;
    const paeLine = paeDiff < 1.5
        ? 'El PAE medio es muy cercano entre ambas.'
        : `${(primary.pae < secondary.pae ? primary.name : secondary.name)} conserva mejor el posicionamiento relativo entre dominios.`;
    return `${confidenceLine} ${paeLine}`;
}

function buildComparisonLogs(primary, secondary) {
    return [
        `=== ${primary.name} (${primary.sourceLabel}) ===`,
        primary.logs,
        '',
        `=== ${secondary.name} (${secondary.sourceLabel}) ===`,
        secondary.logs,
    ].join('\n');
}

// ════════════════════════════════════════════════
// 7. Mol* — Inicializar visor 3D
//    Usamos customData con Blob URL para evitar
//    límites de data: URI en cadenas grandes.
// ════════════════════════════════════════════════

function init3DViewer(structureData, format = 'cif', containerId = 'viewer-container', viewerKey = 'single') {
    const container = document.getElementById(containerId);
    if (!container) return;

    clearViewerInstance(viewerKey);
    container.innerHTML = '';
    if (!structureData) {
        container.textContent = 'Estructura no disponible';
        return;
    }

    // Crear blob URL — evita límites de data: URI
    const mimeType = format === 'cif' ? 'text/plain' : 'text/plain';
    const blob = new Blob([structureData], { type: mimeType });
    _blobUrls[viewerKey] = URL.createObjectURL(blob);

    // Instanciar PDBeMolstarPlugin (correcto, de pdbe-molstar@3.3.x)
    const plugin = new window.PDBeMolstarPlugin();
    molstarPlugins[viewerKey] = plugin;

    const options = {
        // customData en lugar de moleculeId para datos locales
        customData: {
            url: _blobUrls[viewerKey],
            format: format,       // 'cif' o 'pdb'
        },
        // Coloreado pLDDT automático (modo AlphaFold)
        alphafoldView: true,

        // Estética
        bgColor: '#0a0a0a',
        hideCanvasControls: ['selection', 'animation', 'controlToggle', 'controlInfo'],

        // No mostrar el panel lateral del PDBe por defecto
        pdbeLink: false,
        sequencePanel: false,
        landscapeLayout: false,
    };

    plugin.render(container, options);
}

// ════════════════════════════════════════════════
// 8. Render de gráficos
// ════════════════════════════════════════════════

/* ── 8a. Histograma pLDDT ─────────────────────── */
function renderPlddtHistogram(histogram) {
    if (!histogram) return;
    const container = document.getElementById('hist-bars');
    container.innerHTML = '';

    const buckets = [
        { key: 'low', color: 'var(--plddt-vlow)', label: 'Muy baja' },
        { key: 'medium', color: 'var(--plddt-low)', label: 'Baja' },
        { key: 'high', color: 'var(--plddt-high)', label: 'Alta' },
        { key: 'very_high', color: 'var(--plddt-vhigh)', label: 'Muy alta' },
    ];
    const maxVal = Math.max(...buckets.map(b => histogram[b.key] ?? 0), 1);

    buckets.forEach(b => {
        const val = histogram[b.key] ?? 0;
        const pct = (val / maxVal) * 100;
        const bar = document.createElement('div');
        bar.className = 'hist-bar';
        bar.style.cssText = `height:${pct}%; background:${b.color}; min-height:3px;`;
        bar.title = `${b.label}: ${val} residuos`;
        container.appendChild(bar);
    });
}

/* ── 8b. Gráfico pLDDT por residuo ────────────── */
function renderPlddtChart(perResidue) {
    const canvas = document.getElementById('plddt-canvas');
    if (!canvas || perResidue.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 300;
    const H = canvas.clientHeight || 60;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const n = perResidue.length;
    const barW = W / n;

    perResidue.forEach((val, i) => {
        const h = (val / 100) * H;
        ctx.fillStyle = plddtColorRaw(val);
        ctx.fillRect(i * barW, H - h, barW, h);
    });
}

/* ── 8c. Matriz PAE ────────────────────────────── */
function renderPaeMatrix(matrix) {
    const canvas = document.getElementById('pae-canvas');
    if (!canvas) return;
    if (!matrix || matrix.length === 0) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        return;
    }

    const n = matrix.length;
    const dpr = window.devicePixelRatio || 1;
    const S = Math.min(canvas.clientWidth || 240, 240);
    canvas.width = S * dpr;
    canvas.height = S * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const cellW = S / n;
    const cellH = S / n;
    const maxPae = 30;

    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const val = Math.min(matrix[i][j] ?? maxPae, maxPae);
            const t = val / maxPae; // 0=confiado, 1=incierto
            ctx.fillStyle = paeColor(t);
            ctx.fillRect(j * cellW, i * cellH, Math.ceil(cellW) + 0.5, Math.ceil(cellH) + 0.5);
        }
    }
}

/* ── 8d. Estructura secundaria ─────────────────── */
function renderSecondaryStructure(ss) {
    const container = document.getElementById('ss-bars');
    container.innerHTML = '';

    const items = [
        { label: 'Hélice α', pct: ss.helix_percent, color: '#7c3aed' },
        { label: 'Hebra β', pct: ss.strand_percent, color: '#0ea5e9' },
        { label: 'Coil', pct: ss.coil_percent, color: '#64748b' },
    ];

    items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'ss-row';
        row.innerHTML = `
            <span class="ss-label">${item.label}</span>
            <div class="ss-track">
                <div class="ss-fill" style="width:0%;background:${item.color}"></div>
            </div>
            <span class="ss-pct">${item.pct?.toFixed(1) ?? 0}%</span>
        `;
        container.appendChild(row);
        // Animar después del render
        requestAnimationFrame(() => {
            row.querySelector('.ss-fill').style.width = (item.pct ?? 0) + '%';
        });
    });
}

/* ── 8e. Bio Grid ──────────────────────────────── */
function renderBioGrid(items) {
    const container = document.getElementById('bio-grid');
    container.innerHTML = '';
    items.forEach(({ label, val }) => {
        const div = document.createElement('div');
        div.className = 'bio-item';
        div.innerHTML = `
            <div class="bio-item-label">${label}</div>
            <div class="bio-item-val">${val ?? '—'}</div>
        `;
        container.appendChild(div);
    });
}

/* ── 8f. Alerts ────────────────────────────────── */
function renderAlerts(alerts) {
    const section = document.getElementById('alerts-section');
    section.innerHTML = '';
    if (!alerts.length) return;
    const block = document.createElement('div');
    block.className = 'alerts-block';
    alerts.forEach(({ type, text }) => {
        const item = document.createElement('div');
        item.className = `alert-item ${type}`;
        item.textContent = text;
        block.appendChild(item);
    });
    section.appendChild(block);
}

/* ── 8g. HPC Stats ─────────────────────────────── */
function renderHPC(rows) {
    const container = document.getElementById('hpc-stats');
    container.innerHTML = '';
    rows.forEach(({ label, val }) => {
        if (!val || val === 'undefined h' || val === 'undefined') return;
        const row = document.createElement('div');
        row.className = 'hpc-row';
        row.innerHTML = `<span class="hpc-label">${label}</span><span class="hpc-val">${val}</span>`;
        container.appendChild(row);
    });
}

// ════════════════════════════════════════════════
// 9. Descarga de ficheros
// ════════════════════════════════════════════════
function downloadFile(type) {
    if (!currentData) return;
    if (currentData.mode === 'comparison') {
        alert('En modo comparativo usa el informe comparativo o abre cada proteína desde la cola para descargar su estructura individual.');
        return;
    }

    const struct = currentData.outputs.structural_data;
    const content = type === 'cif' ? struct.cif_file : struct.pdb_file;
    const ext = type === 'cif' ? '.cif' : '.pdb';
    const mimeType = 'text/plain';
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aminofold3d_${currentJobId ?? 'structure'}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
}

// Retrocompatibilidad con el botón antiguo
function downloadPDB() { downloadFile('pdb'); }

// Descarga JSON con datos de confianza (pLDDT, PAE, etc.)
function downloadConfidenceJSON() {
    if (!currentData) return;
    if (currentData.mode === 'comparison') {
        alert('La descarga JSON de confianza está disponible en modo individual. Para la comparativa usa el informe comparativo.');
        return;
    }

    const struct = currentData.outputs.structural_data;
    const conf = struct?.confidence;
    if (!conf) {
        alert('No hay datos de confianza disponibles.');
        return;
    }

    const meta = currentData.outputs.protein_metadata ?? {};
    const confidenceData = {
        protein_name: meta.protein_name ?? 'desconocida',
        organism: meta.organism ?? null,
        uniprot_id: meta.uniprot_id ?? null,
        pdb_id: meta.pdb_id ?? null,
        job_id: currentJobId,
        timestamp: new Date().toISOString(),
        confidence: {
            plddt_mean: conf.plddt_mean,
            mean_pae: conf.mean_pae,
            plddt_histogram: conf.plddt_histogram,
            plddt_per_residue: conf.plddt_per_residue ?? [],
            pae_matrix: conf.pae_matrix ?? null,
        },
    };

    const json = JSON.stringify(confidenceData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = (meta.protein_name ?? 'protein').toLowerCase().replace(/\s+/g, '_');
    a.download = `aminofold3d_${slug}_confidence.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function downloadComparisonReport() {
    if (!currentData || currentData.mode !== 'comparison') return;

    const primary = extractProteinSummary(currentData.primary, 'Proteína 1');
    const secondary = extractProteinSummary(currentData.secondary, 'Proteína 2');
    const report = buildComparisonReport(primary, secondary);
    const slug = `${slugifyProteinName(primary.name)}_vs_${slugifyProteinName(secondary.name)}`;
    const blob = new Blob([report], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aminofold3d_comparativa_${slug}.md`;
    a.click();
    URL.revokeObjectURL(url);
}

function buildComparisonReport(primary, secondary) {
    return `# Informe comparativo AminoFold3D

Fecha: ${new Date().toLocaleString('es-ES')}
Comparativa: ${primary.name} vs ${secondary.name}

## Resumen ejecutivo

${buildComparisonNarrative(primary, secondary)}

## Proteína 1: ${primary.name}

- Organismo: ${primary.organism}
- Fuente: ${primary.sourceLabel}
- pLDDT medio: ${primary.plddt.toFixed(2)}
- PAE medio: ${primary.pae.toFixed(2)} Å
- Longitud: ${primary.length ?? '—'} residuos
- Peso molecular: ${formatShortNumber(primary.mw)} kDa
- Solubilidad: ${primary.solubility}${primary.solubilityScore != null ? ` (${primary.solubilityScore.toFixed(1)}%)` : ''}
- Estabilidad: ${primary.stability}
- Estructura dominante: ${primary.dominantSecondary}

## Proteína 2: ${secondary.name}

- Organismo: ${secondary.organism}
- Fuente: ${secondary.sourceLabel}
- pLDDT medio: ${secondary.plddt.toFixed(2)}
- PAE medio: ${secondary.pae.toFixed(2)} Å
- Longitud: ${secondary.length ?? '—'} residuos
- Peso molecular: ${formatShortNumber(secondary.mw)} kDa
- Solubilidad: ${secondary.solubility}${secondary.solubilityScore != null ? ` (${secondary.solubilityScore.toFixed(1)}%)` : ''}
- Estabilidad: ${secondary.stability}
- Estructura dominante: ${secondary.dominantSecondary}

## Diferencias clave

- Diferencia de pLDDT medio: ${Math.abs(primary.plddt - secondary.plddt).toFixed(2)}
- Diferencia de PAE medio: ${Math.abs(primary.pae - secondary.pae).toFixed(2)} Å
- Diferencia de longitud: ${Math.abs((primary.length ?? 0) - (secondary.length ?? 0))} residuos
- Diferencia de peso molecular: ${Math.abs((primary.mw ?? 0) - (secondary.mw ?? 0)).toFixed(2)} kDa

## Conclusión rápida

${primary.plddt >= secondary.plddt ? primary.name : secondary.name} presenta la mayor confianza estructural global.
${primary.pae <= secondary.pae ? primary.name : secondary.name} muestra el mejor posicionamiento relativo entre residuos.
`;
}

// ════════════════════════════════════════════════
// 10. Reset
// ════════════════════════════════════════════════
function resetApp() {
    clearInterval(pollInterval);
    clearAllViewers();
    currentJobId = null;
    currentData = null;
    pollInterval = null;
    fastaInput.value = '';
    proteinNameInput.value = '';
    setComparisonSectionOpen(false, { reset: true });
    fastaPreviewCard.classList.add('hidden');
    fastaPreviewPre.textContent = '';
    fastaPreviewStats.textContent = '';
    logsEl.textContent = '> Initializing job...';
    progressBar.style.animation = '';
    progressBar.style.background = '';
    resetSubmitBtn();
    showView('idle');
}

// ════════════════════════════════════════════════
// 11. Funciones auxiliares
// ════════════════════════════════════════════════

function resetSubmitBtn() {
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        Predecir Estructura 3D`;
}

/** Devuelve el color pLDDT según el estándar AlphaFold */
function plddtColorRaw(val) {
    if (val > 90) return '#0053d6';   // azul oscuro = muy alta
    if (val > 70) return '#65cbf3';   // azul claro  = alta
    if (val > 50) return '#ffe928';   // amarillo     = baja
    return '#ff7d45';                  // naranja      = muy baja
}

function plddtColor(val) {
    if (val > 90) return 'var(--plddt-vhigh)';
    if (val > 70) return 'var(--plddt-high)';
    if (val > 50) return 'var(--plddt-low)';
    return 'var(--plddt-vlow)';
}

function plddtLabel(val) {
    if (val > 90) return 'Muy alta confianza';
    if (val > 70) return 'Alta confianza';
    if (val > 50) return 'Baja confianza';
    return 'Muy baja confianza';
}

/**
 * Color para la matriz PAE.
 * t = 0 → confiado (azul oscuro)
 * t = 1 → incierto (rojo)
 * Interpolamos por el gradiente clásico de AlphaFold PAE.
 */
function paeColor(t) {
    // Blue → Cyan → Yellow → Orange → Red
    const stops = [
        [0, 0, 127],  // azul oscuro
        [0, 0, 255],  // azul
        [0, 255, 255],  // cyan
        [255, 255, 0],  // amarillo
        [255, 127, 0],  // naranja
        [255, 0, 0],  // rojo
    ];
    const n = stops.length - 1;
    const i = Math.min(Math.floor(t * n), n - 1);
    const f = t * n - i;
    const a = stops[i], b = stops[i + 1];
    const r = Math.round(a[0] + (b[0] - a[0]) * f);
    const g = Math.round(a[1] + (b[1] - a[1]) * f);
    const bv = Math.round(a[2] + (b[2] - a[2]) * f);
    return `rgb(${r},${g},${bv})`;
}

function formatSeconds(secs) {
    if (!secs) return '—';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function formatShortNumber(val) {
    if (val == null || Number.isNaN(Number(val))) return '—';
    return Number(val).toFixed(1);
}

/* ════════════════════════════════════════════════
   12. CHATBOT — Asistente IA con Gemini
   ════════════════════════════════════════════════ */

const GEMINI_API_KEY = 'AIzaSyBk3kgRRGZCigiEUb6bAAJOLyizKOv4UWc';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// ── Estado del chat ──────────────────────────────
let chatHistory = [];   // array de {role, parts:[{text}]}
let chatIsOpen = false;
let chatTypingEl = null;

// ── Mensaje de bienvenida ────────────────────────
const WELCOME_MSG = `¡Hola! Soy el asistente IA de AminoFold3D 🧬

Puedo ayudarte a:
• Interpretar los resultados de tus predicciones (pLDDT, PAE, estructura secundaria)
• Explicar qué significa cada métrica en términos biológicos
• Evaluar el potencial farmacológico de la proteína
• Resumir los datos del job HPC del CESGA

Cuando hayas cargado una proteína, tendré acceso a todos sus datos en tiempo real. ¡Pregunta lo que quieras!`;

// ── Construir contexto con los datos actuales ────
function buildProteinContext() {
    if (!currentData) {
        return 'El investigador aún no ha cargado ninguna proteína. No hay datos de predicción disponibles todavía.';
    }

    if (currentData.mode === 'comparison') {
        const primary = extractProteinSummary(currentData.primary, 'Proteína 1');
        const secondary = extractProteinSummary(currentData.secondary, 'Proteína 2');
        return `
=== DATOS DE LA COMPARATIVA ACTUAL ===

PROTEÍNA 1:
- Nombre: ${primary.name}
- Organismo: ${primary.organism}
- pLDDT medio: ${primary.plddt.toFixed(2)}
- PAE medio: ${primary.pae.toFixed(2)} Å
- Longitud: ${primary.length ?? '—'} residuos
- Peso molecular: ${formatShortNumber(primary.mw)} kDa
- Solubilidad: ${primary.solubility}${primary.solubilityScore != null ? ` (${primary.solubilityScore.toFixed(1)}%)` : ''}
- Estabilidad: ${primary.stability}
- Estructura dominante: ${primary.dominantSecondary}

PROTEÍNA 2:
- Nombre: ${secondary.name}
- Organismo: ${secondary.organism}
- pLDDT medio: ${secondary.plddt.toFixed(2)}
- PAE medio: ${secondary.pae.toFixed(2)} Å
- Longitud: ${secondary.length ?? '—'} residuos
- Peso molecular: ${formatShortNumber(secondary.mw)} kDa
- Solubilidad: ${secondary.solubility}${secondary.solubilityScore != null ? ` (${secondary.solubilityScore.toFixed(1)}%)` : ''}
- Estabilidad: ${secondary.stability}
- Estructura dominante: ${secondary.dominantSecondary}

RESUMEN COMPARATIVO:
- Diferencia de pLDDT: ${Math.abs(primary.plddt - secondary.plddt).toFixed(2)}
- Diferencia de PAE: ${Math.abs(primary.pae - secondary.pae).toFixed(2)} Å
- Diferencia de longitud: ${Math.abs((primary.length ?? 0) - (secondary.length ?? 0))} residuos
- Lectura rápida: ${buildComparisonNarrative(primary, secondary)}

Job agrupado: ${currentJobId ?? '—'}
=== FIN DE DATOS ===`;
    }

    const out = currentData.outputs;
    const acc = currentData.accounting;
    const meta = out.protein_metadata ?? {};
    const struct = out.structural_data ?? {};
    const conf = struct.confidence ?? {};
    const bio = out.biological_data ?? {};
    const props = bio.sequence_properties ?? {};
    const ss = bio.secondary_structure_prediction ?? {};
    const hpc = acc.accounting ?? {};

    return `
=== DATOS DE LA PROTEÍNA ANALIZADA ===

METADATOS:
- Nombre: ${meta.protein_name ?? '—'}
- Organismo: ${meta.organism ?? '—'}
- UniProt ID: ${meta.uniprot_id ?? '—'}
- PDB ID: ${meta.pdb_id ?? '—'}
- Fuente: ${meta.data_source === 'precomputed_database' ? 'Base de datos precalculada' : 'AlphaFold2 predicho en el momento'}

CONFIANZA (pLDDT / PAE):
- pLDDT global medio: ${conf.plddt_mean?.toFixed(2) ?? '—'} / 100
- PAE medio: ${conf.mean_pae?.toFixed(2) ?? '—'} Å
- Distribución pLDDT: muy baja=${conf.plddt_histogram?.low ?? '—'} res, baja=${conf.plddt_histogram?.medium ?? '—'} res, alta=${conf.plddt_histogram?.high ?? '—'} res, muy alta=${conf.plddt_histogram?.very_high ?? '—'} res

ESTRUCTURA SECUNDARIA:
- Hélice α: ${ss.helix_percent?.toFixed(1) ?? '—'}%
- Hebra β: ${ss.strand_percent?.toFixed(1) ?? '—'}%
- Coil: ${ss.coil_percent?.toFixed(1) ?? '—'}%

PROPIEDADES BIOLÓGICAS:
- Longitud de secuencia: ${props.length ?? '—'} residuos
- Peso molecular estimado: ${props.molecular_weight_kda ?? '—'} kDa
- Residuos de cisteína: ${props.cysteine_residues ?? '—'}
- Residuos aromáticos: ${props.aromatic_residues ?? '—'}
- Solubilidad: ${bio.solubility_prediction ?? '—'} (${bio.solubility_score?.toFixed(1) ?? '—'}%)
- Estabilidad: ${bio.stability_status ?? '—'}
- Índice de inestabilidad: ${bio.instability_index?.toFixed(2) ?? '—'}
- Alertas de toxicidad: ${(bio.toxicity_alerts ?? []).join(', ') || 'Ninguna'}
- Alertas de alergenicidad: ${(bio.allergenicity_alerts ?? []).join(', ') || 'Ninguna'}

RECURSOS HPC (CESGA):
- Tiempo de pared: ${formatSeconds(hpc.wall_time_seconds)}
- GPU horas: ${hpc.gpu_hours?.toFixed(4) ?? '—'} h
- CPU horas: ${hpc.cpu_hours?.toFixed(4) ?? '—'} h
- RAM·hora: ${hpc.memory_gb_hours?.toFixed(2) ?? '—'} GB·h
- Nodo: ${hpc.node_name ?? '—'}
- Partición Slurm: ${hpc.partition ?? '—'}

Job ID: ${currentJobId ?? '—'}
=== FIN DE DATOS ===`;
}

// ── Prompt de sistema ────────────────────────────
function buildSystemPrompt() {
    return `Eres el asistente de IA de AminoFold3D, una plataforma de predicción de estructuras proteicas que usa AlphaFold2 en el supercomputador CESGA. Ayudas a investigadores científicos a interpretar los resultados de predicciones.

Responde siempre en español, de forma clara, científicamente precisa pero accesible. Usa emojis moderadamente para que la conversación sea más amena (🧬, 🔬, 📊, ✅, ⚠️). Sé conciso pero completo. Si el investigador pregunta algo que no está en los datos disponibles, indícalo con honestidad.

Cuando expliques métricas:
- pLDDT > 90: muy alta confianza (azul oscuro en visor)
- pLDDT 70-90: alta confianza (azul claro)
- pLDDT 50-70: baja confianza (amarillo)
- pLDDT < 50: muy baja confianza (naranja/rojo) — regiones desordenadas
- PAE bajo (azul): alta confianza en la posición relativa entre residuos
- PAE alto (rojo): baja confianza en la posición relativa

Contexto actual de la aplicación:
${buildProteinContext()}`;
}

// ── Llamar a la API de Gemini ────────────────────
async function callGemini(userMessage) {
    // Añadir mensaje del usuario al historial
    chatHistory.push({ role: 'user', parts: [{ text: userMessage }] });

    const body = {
        system_instruction: {
            parts: [{ text: buildSystemPrompt() }]
        },
        contents: chatHistory,
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024,
            topP: 0.95,
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    };

    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '(Sin respuesta)';

    // Añadir respuesta de la IA al historial
    chatHistory.push({ role: 'model', parts: [{ text: reply }] });

    return reply;
}

// ── Renderizar mensaje ───────────────────────────
function appendChatMsg(text, role = 'ai', isTyping = false) {
    const messagesEl = document.getElementById('chat-messages');
    const wrapper = document.createElement('div');
    wrapper.className = `chat-msg ${role}${isTyping ? ' typing' : ''}`;

    const avatarEl = document.createElement('div');
    avatarEl.className = 'chat-msg-avatar';
    avatarEl.setAttribute('aria-hidden', 'true');
    avatarEl.textContent = role === 'ai' ? '🤖' : 'Tú';

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'chat-bubble';

    if (isTyping) {
        bubbleEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    } else {
        // Simple markdown-lite: negrita **texto**, fenced con `código`
        bubbleEl.innerHTML = formatChatText(text);
    }

    wrapper.appendChild(avatarEl);
    wrapper.appendChild(bubbleEl);
    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    return wrapper;
}

// Formatea texto con markdown básico
function formatChatText(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code style="background:rgba(0,240,255,0.1);padding:1px 5px;border-radius:4px;font-family:var(--font-mono);font-size:0.82em;color:var(--primary)">$1</code>')
        .replace(/\n/g, '<br>');
}

// ── Enviar mensaje ───────────────────────────────
async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    const statusLabel = document.getElementById('chat-status-label');
    const suggestionsEl = document.getElementById('chat-suggestions');
    const text = input.value.trim();

    if (!text) return;

    // Renderizar mensaje del usuario
    appendChatMsg(text, 'user');
    input.value = '';
    input.style.height = '';
    input.focus();

    // Ocultar sugerencias tras primer mensaje
    suggestionsEl.style.display = 'none';

    // Bloquear UI mientras procesa
    sendBtn.disabled = true;
    statusLabel.textContent = 'Gemini está pensando...';

    // Mostrar indicador de escritura
    chatTypingEl = appendChatMsg('', 'ai', true);

    try {
        const reply = await callGemini(text);

        // Quitar typing, añadir respuesta real
        chatTypingEl.remove();
        chatTypingEl = null;
        appendChatMsg(reply, 'ai');
        statusLabel.textContent = 'Powered by Gemini · Listo';

    } catch (err) {
        chatTypingEl?.remove();
        chatTypingEl = null;
        appendChatMsg(`⚠️ Error al contactar con Gemini:\n${err.message}`, 'error');
        statusLabel.textContent = 'Error · Powered by Gemini';
        // Sacar el último mensaje del usuario del historial para poder reintentar
        chatHistory.pop();
    } finally {
        sendBtn.disabled = false;
    }
}

// ── Enviar sugerencia ────────────────────────────
function sendSuggestion(btn) {
    const input = document.getElementById('chat-input');
    input.value = btn.textContent;
    sendChatMessage();
}

// ── Toggle del panel ─────────────────────────────
function toggleChat() {
    const panel = document.getElementById('chat-panel');
    const fab = document.getElementById('chat-fab');
    const iconOpen = document.getElementById('chat-fab-icon-open');
    const iconClose = document.getElementById('chat-fab-icon-close');

    chatIsOpen = !chatIsOpen;

    if (chatIsOpen) {
        panel.classList.remove('hidden');
        fab.classList.add('is-open');
        iconOpen.style.display = 'none';
        iconClose.style.display = '';
        // Inicializar con bienvenida si es el primer uso
        const messages = document.getElementById('chat-messages');
        if (messages.children.length === 0) {
            appendChatMsg(WELCOME_MSG, 'ai');
        }
        // Foco en el input
        requestAnimationFrame(() => document.getElementById('chat-input').focus());
    } else {
        panel.classList.add('hidden');
        fab.classList.remove('is-open');
        iconOpen.style.display = '';
        iconClose.style.display = 'none';
    }
}

// ── Limpiar historial ────────────────────────────
function clearChat() {
    chatHistory = [];
    const messages = document.getElementById('chat-messages');
    messages.innerHTML = '';
    document.getElementById('chat-suggestions').style.display = '';
    appendChatMsg(WELCOME_MSG, 'ai');
    document.getElementById('chat-status-label').textContent = 'Powered by Gemini · Listo';
}

// ── Atajos de teclado ────────────────────────────
function onChatKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
}

// ── Auto-resize del textarea ─────────────────────
function autoresizeChat(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
