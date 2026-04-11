/* ════════════════════════════════════════════════
   BioHack — app.js
   Usa la API CESGA real (api-mock-cesga.onrender.com)
   + Mol* (PDBe-Molstar) para la visualización 3D
   + Visualización de pLDDT por residuo, PAE, etc.
   ════════════════════════════════════════════════ */

const API_BASE = 'https://api-mock-cesga.onrender.com';

// ── Estado de la aplicación ──────────────────────
let currentJobId = null;
let molstarPlugin = null;   // instancia PDBeMolstarPlugin
let currentData = null;   // outputs completos del job
let jobsPollInterval = null;
let activePollingJobId = null;
const jobsById = new Map();

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
const jobsListEl = document.getElementById('jobs-list');
const aaEditorCard = document.getElementById('aa-editor-card');
const aaSequenceTrack = document.getElementById('aa-sequence-track');
const aaChainStats = document.getElementById('aa-chain-stats');
const aaLegendCard = document.getElementById('aa-legend-card');
const aaLegendChip = document.getElementById('aa-legend-chip');
const aaLegendName = document.getElementById('aa-legend-name');
const aaLegendMeta = document.getElementById('aa-legend-meta');
const aaReplaceSelect = document.getElementById('aa-replace-select');
const proteinSkyEl = document.getElementById('protein-sky');
const proteinCaptureToastEl = document.getElementById('protein-capture-toast');

let selectedResidueIndex = null;
let proteinSkyTimer = null;
let proteinSpawnPool = [];
let proteinCaptureToastTimer = null;

const PROTEIN_SPAWN_LIMIT = 8;
const PROTEIN_MAX_ON_SCREEN = 2;

// ════════════════════════════════════════════════
// 1. Helpers de navegación
// ════════════════════════════════════════════════
function showView(viewId) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[viewId].classList.add('active');
    updateProteinSkyVisibility(viewId === 'idle');
}

function goHome() {
    backToJobs();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function appendLog(msg) {
    logsEl.textContent += msg + '\n';
    logsEl.scrollTop = logsEl.scrollHeight;
}

// ════════════════════════════════════════════════
// 2. Presets — carga FASTA desde la API real
// ════════════════════════════════════════════════
async function loadPreset(proteinId) {
    fastaInput.value = 'Cargando...';
    proteinNameInput.value = proteinId;
    try {
        const res = await fetch(`${API_BASE}/proteins/${proteinId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fastaInput.value = data.fasta_ready ?? '>Error al cargar';
        // Sync name from FASTA header or API
        const name = data.protein_name ?? data.name ?? proteinId;
        proteinNameInput.value = name;
        updateFastaPreview();
    } catch (e) {
        fastaInput.value = `>Error de red: ${e.message}`;
        updateFastaPreview();
    }
}

// ════════════════════════════════════════════════
// 2b. Nombre de proteína — búsqueda y autocompletado
// ════════════════════════════════════════════════

// Catálogo oficial de proteínas conocidas en la API (22)
const CATALOG_PROTEINS = [
    { id: 'ubiquitin', name: 'Ubiquitin' },
    { id: 'histone_h4', name: 'Histone H4' },
    { id: 'thioredoxin', name: 'Thioredoxin' },
    { id: 'cytochrome_c', name: 'Cytochrome c' },
    { id: 'insulin_human', name: 'Insulin' },
    { id: 'beta2_microglobulin', name: 'Beta-2-microglobulin' },
    { id: 'rnase_a', name: 'Ribonuclease A' },
    { id: 'lysozyme', name: 'Lysozyme C (Chicken)' },
    { id: 'hemoglobin_alpha', name: 'Hemoglobin alpha' },
    { id: 'hemoglobin_beta', name: 'Hemoglobin beta' },
    { id: 'lysozyme_human', name: 'Lysozyme C (Human)' },
    { id: 'calmodulin', name: 'Calmodulin' },
    { id: 'sod1', name: 'Superoxide dismutase 1' },
    { id: 'myoglobin', name: 'Myoglobin' },
    { id: 'adenylate_kinase', name: 'Adenylate kinase 1' },
    { id: 'gfp', name: 'Green Fluorescent Protein' },
    { id: 'chymotrypsin', name: 'Chymotrypsin C' },
    { id: 'pcna', name: 'PCNA' },
    { id: 'p53', name: 'Tumor protein p53' },
    { id: 'egfr_kinase', name: 'EGFR kinase domain' },
    { id: 'amylase', name: 'Pancreatic alpha-amylase' },
    { id: 'serum_albumin', name: 'Human serum albumin' },
];

const CATALOG_PDB_MAP = {
    ubiquitin: '1UBQ',
    histone_h4: '1AOI',
    thioredoxin: '1ERU',
    cytochrome_c: '1HRC',
    insulin_human: '4MIF',
    beta2_microglobulin: '1LDS',
    rnase_a: '1FS3',
    lysozyme: '1LYZ',
    hemoglobin_alpha: '1A3N',
    hemoglobin_beta: '1A3N',
    lysozyme_human: '1LZ1',
    calmodulin: '1CLL',
    sod1: '1PU0',
    myoglobin: '1MBN',
    adenylate_kinase: '4AKE',
    gfp: '1GFL',
    chymotrypsin: '1CHY',
    pcna: '1AXC',
    p53: '2OCJ',
    egfr_kinase: '1IVO',
    amylase: '1BVN',
    serum_albumin: '1AO6',
};

const _catalogLookup = new Map();
CATALOG_PROTEINS.forEach(p => {
    _catalogLookup.set(normalizeProteinKey(p.id), p.id);
    _catalogLookup.set(normalizeProteinKey(p.id.replace(/_/g, ' ')), p.id);
    _catalogLookup.set(normalizeProteinKey(p.name), p.id);
});

let _acDebounce = null;

function onProteinNameInput(val) {
    clearTimeout(_acDebounce);
    if (!val.trim()) { hideAutocomplete(); return; }
    // Sugerencias locales solo del catálogo oficial
    const q = normalizeProteinKey(val);
    const matches = CATALOG_PROTEINS
        .filter(p => normalizeProteinKey(p.id).includes(q) || normalizeProteinKey(p.name).includes(q))
        .slice(0, 8)
        .map(p => p.id);
    showAutocomplete(matches);
    // Also sync name into the FASTA header if textarea already has content
    syncNameToFasta(val);
}

function onNameKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); searchProteinByName(); }
    if (e.key === 'Escape') { hideAutocomplete(); }
}

async function searchProteinByName() {
    const name = proteinNameInput.value.trim();
    if (!name) return;
    const resolvedProteinId = resolveCatalogProteinId(name);
    hideAutocomplete();
    const btn = document.getElementById('btn-search-protein');
    btn.disabled = true;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Buscando...';

    try {
        if (!resolvedProteinId) {
            showNameNotFound(name, true);
            return;
        }

        const res = await fetch(`${API_BASE}/proteins/${encodeURIComponent(resolvedProteinId)}`);
        if (res.ok) {
            const data = await res.json();
            fastaInput.value = data.fasta_ready ?? '';
            const displayName = data.protein_name ?? data.name ?? resolvedProteinId;
            proteinNameInput.value = displayName;
            updateFastaPreview();
        } else {
            showNameNotFound(name, true);
        }
    } catch (e) {
        showNameNotFound(name, true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Buscar';
    }
}

function showNameNotFound(name, strictCatalog = false) {
    const hint = document.createElement('div');
    hint.className = 'name-not-found';
    hint.textContent = strictCatalog
        ? `"${name}" no está en el catálogo de 22 proteínas conocidas. Usa un ID válido o pega FASTA libre (resultado sintético).`
        : `"${name}" no encontrado en la API — añade tu secuencia manualmente.`;
    hint.style.cssText = 'font-size:.8rem;color:var(--plddt-low);margin-top:.4rem;';
    // Show briefly
    const group = proteinNameInput.closest('.name-group');
    const old = group.querySelector('.name-not-found');
    if (old) old.remove();
    group.appendChild(hint);
    setTimeout(() => hint.remove(), 4000);
}

function showAutocomplete(suggestions) {
    autocompleteBox.innerHTML = '';
    if (!suggestions.length) { hideAutocomplete(); return; }
    suggestions.forEach(s => {
        const item = document.createElement('div');
        item.className = 'ac-item';
        item.textContent = s;
        item.setAttribute('role', 'option');
        item.onclick = () => selectSuggestion(s);
        autocompleteBox.appendChild(item);
    });
    autocompleteBox.classList.remove('hidden');
}

function hideAutocomplete() {
    autocompleteBox.classList.add('hidden');
    autocompleteBox.innerHTML = '';
}

function selectSuggestion(name) {
    proteinNameInput.value = name;
    hideAutocomplete();
    loadPreset(name);
}

function normalizeProteinKey(value) {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function resolveCatalogProteinId(rawValue) {
    return _catalogLookup.get(normalizeProteinKey(rawValue)) ?? null;
}

const AMINO_ACID_INFO = {
    A: { name: 'Alanina', three: 'ALA', type: 'No polar', mass: 71.08 },
    R: { name: 'Arginina', three: 'ARG', type: 'Básico (+)', mass: 156.19 },
    N: { name: 'Asparagina', three: 'ASN', type: 'Polar', mass: 114.10 },
    D: { name: 'Aspartato', three: 'ASP', type: 'Ácido (-)', mass: 115.09 },
    C: { name: 'Cisteína', three: 'CYS', type: 'Polar azufrada', mass: 103.15 },
    Q: { name: 'Glutamina', three: 'GLN', type: 'Polar', mass: 128.13 },
    E: { name: 'Glutamato', three: 'GLU', type: 'Ácido (-)', mass: 129.12 },
    G: { name: 'Glicina', three: 'GLY', type: 'No polar', mass: 57.05 },
    H: { name: 'Histidina', three: 'HIS', type: 'Básico (+)', mass: 137.14 },
    I: { name: 'Isoleucina', three: 'ILE', type: 'No polar', mass: 113.16 },
    L: { name: 'Leucina', three: 'LEU', type: 'No polar', mass: 113.16 },
    K: { name: 'Lisina', three: 'LYS', type: 'Básico (+)', mass: 128.17 },
    M: { name: 'Metionina', three: 'MET', type: 'No polar azufrada', mass: 131.19 },
    F: { name: 'Fenilalanina', three: 'PHE', type: 'Aromático', mass: 147.18 },
    P: { name: 'Prolina', three: 'PRO', type: 'No polar', mass: 97.12 },
    S: { name: 'Serina', three: 'SER', type: 'Polar', mass: 87.08 },
    T: { name: 'Treonina', three: 'THR', type: 'Polar', mass: 101.11 },
    W: { name: 'Triptófano', three: 'TRP', type: 'Aromático', mass: 186.21 },
    Y: { name: 'Tirosina', three: 'TYR', type: 'Aromático polar', mass: 163.18 },
    V: { name: 'Valina', three: 'VAL', type: 'No polar', mass: 99.13 },
};

const AMINO_ACID_CODES = Object.keys(AMINO_ACID_INFO);

function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
    }
    return a;
}

function initProteinSpawnPool() {
    if (proteinSpawnPool.length) return;
    proteinSpawnPool = shuffleArray(CATALOG_PROTEINS)
        .slice(0, PROTEIN_SPAWN_LIMIT)
        .map(p => ({ ...p }));
}

function scheduleNextProteinSpawn() {
    if (!proteinSkyEl || !views.idle.classList.contains('active')) return;
    if (!proteinSpawnPool.length) return;
    const delay = 2600 + Math.floor(Math.random() * 2600);
    proteinSkyTimer = setTimeout(() => {
        if (proteinSkyEl.childElementCount < PROTEIN_MAX_ON_SCREEN) {
            spawnProteinFlyer();
        }
        scheduleNextProteinSpawn();
    }, delay);
}

function updateProteinSkyVisibility(visible) {
    if (!proteinSkyEl) return;
    if (!visible) {
        if (proteinSkyTimer) {
            clearTimeout(proteinSkyTimer);
            proteinSkyTimer = null;
        }
        proteinSkyEl.innerHTML = '';
        return;
    }
    initProteinSpawnPool();
    if (!proteinSkyTimer && proteinSpawnPool.length > 0) {
        scheduleNextProteinSpawn();
    }
}

function spawnProteinFlyer() {
    if (!proteinSkyEl || !proteinSpawnPool.length) return;
    const protein = proteinSpawnPool.shift();
    if (!protein) return;

    const el = document.createElement('button');
    el.type = 'button';
    const direction = Math.random() > 0.5 ? 'dir-lr' : 'dir-rl';
    const topPct = 12 + Math.floor(Math.random() * 66);
    const duration = 13 + Math.floor(Math.random() * 12);
    el.className = `protein-flyer ${direction}`;
    el.style.top = `${topPct}vh`;
    el.style.setProperty('--fly-dur', `${duration}s`);
    const pdbId = CATALOG_PDB_MAP[protein.id];
    const thumbUrl = pdbId
        ? `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`
        : '';
    el.innerHTML = `
        ${thumbUrl ? `<img class="protein-flyer-img" src="${thumbUrl}" alt="${protein.name}" loading="lazy">` : ''}
    `;
    el.title = protein.name;
    const imgEl = el.querySelector('.protein-flyer-img');
    if (imgEl) {
        imgEl.onerror = () => {
            imgEl.style.display = 'none';
        };
    }
    el.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (el.classList.contains('captured')) return;
        el.classList.add('captured');
        showProteinCapturePopup(protein.name);
        try {
            await loadPreset(protein.id);
        } finally {
            setTimeout(() => el.remove(), 560);
        }
    };
    el.addEventListener('animationend', () => el.remove());
    proteinSkyEl.appendChild(el);
}

function showProteinCapturePopup(name) {
    if (!proteinCaptureToastEl) return;
    proteinCaptureToastEl.textContent = `Capturada: ${name}`;
    proteinCaptureToastEl.classList.remove('hidden');
    if (proteinCaptureToastTimer) clearTimeout(proteinCaptureToastTimer);
    proteinCaptureToastTimer = setTimeout(() => {
        proteinCaptureToastEl.classList.add('hidden');
    }, 2200);
}

/** Writes/updates the >header line of the current FASTA with `name`. */
function syncNameToFasta(name, forceEmpty = false) {
    const slug = name.trim().toLowerCase().replace(/\s+/g, '_');
    const cur = fastaInput.value;
    if (cur.startsWith('>')) {
        const lines = cur.split('\n');
        lines[0] = '>' + slug;
        fastaInput.value = lines.join('\n');
    } else if (forceEmpty || !cur.trim()) {
        fastaInput.value = '>' + slug + '\n';
    }
    updateFastaPreview();
}

// ════════════════════════════════════════════════
// 2c. Cuando se edita el FASTA directamente
// ════════════════════════════════════════════════
function onFastaInput() {
    const val = fastaInput.value;
    // Parse the header to sync the name input
    if (val.startsWith('>')) {
        const firstLine = val.split('\n')[0].slice(1).trim();
        if (firstLine) {
            proteinNameInput.value = firstLine.replace(/_/g, ' ');
        }
    }
    updateFastaPreview();
}

// ════════════════════════════════════════════════
// 2d. Previsualización del FASTA
// ════════════════════════════════════════════════
function updateFastaPreview() {
    const raw = fastaInput.value.trim();
    if (!raw || !raw.startsWith('>')) {
        fastaPreviewCard.classList.add('hidden');
        renderAminoAcidEditor('');
        return;
    }
    // Parse
    const lines = raw.split('\n');
    const header = lines[0];  // >name
    const seqRaw = lines.slice(1).join('').replace(/\s/g, '').toUpperCase();
    if (!seqRaw) {
        fastaPreviewCard.classList.add('hidden');
        renderAminoAcidEditor('');
        return;
    }

    // Format: 60 chars per line
    const wrapped = seqRaw.match(/.{1,60}/g) || [];
    const formatted = header + '\n' + wrapped.join('\n');

    fastaPreviewPre.textContent = formatted;
    const seqStats = computeSequenceStats(seqRaw);
    fastaPreviewStats.textContent = `${seqStats.length} residuos · ${seqStats.mw_kda.toFixed(2)} kDa · Aromáticos ${seqStats.aromatic}`;
    fastaPreviewCard.classList.remove('hidden');
    renderAminoAcidEditor(seqRaw);
}

function getCurrentFastaSequence() {
    const raw = fastaInput.value.trim();
    if (!raw.startsWith('>')) return '';
    return raw.split('\n').slice(1).join('').replace(/\s/g, '').toUpperCase();
}

function setCurrentFastaSequence(newSequence) {
    const raw = fastaInput.value.trim();
    if (!raw.startsWith('>')) return;
    const header = raw.split('\n')[0];
    const wrapped = String(newSequence).match(/.{1,60}/g) || [];
    fastaInput.value = `${header}\n${wrapped.join('\n')}`;
}

function computeSequenceStats(sequence) {
    const seq = String(sequence || '');
    const length = seq.length;
    let mwDa = 18.015;
    let aromatic = 0;
    let basic = 0;
    let acidic = 0;
    for (const aa of seq) {
        const info = AMINO_ACID_INFO[aa];
        mwDa += info ? info.mass : 110.0;
        if (aa === 'F' || aa === 'W' || aa === 'Y') aromatic += 1;
        if (aa === 'K' || aa === 'R' || aa === 'H') basic += 1;
        if (aa === 'D' || aa === 'E') acidic += 1;
    }
    return {
        length,
        mw_kda: mwDa / 1000,
        aromatic,
        basic,
        acidic,
    };
}

function renderAminoAcidEditor(sequence) {
    const seq = String(sequence || '').toUpperCase();
    if (!seq || !aaEditorCard || !aaSequenceTrack) {
        aaEditorCard?.classList.add('hidden');
        aaSequenceTrack && (aaSequenceTrack.innerHTML = '');
        aaLegendCard?.classList.add('hidden');
        selectedResidueIndex = null;
        return;
    }

    aaEditorCard.classList.remove('hidden');
    aaSequenceTrack.innerHTML = '';

    const stats = computeSequenceStats(seq);
    aaChainStats.textContent = `${stats.length} aa · ${stats.mw_kda.toFixed(2)} kDa · Arom ${stats.aromatic} · +${stats.basic}/-${stats.acidic}`;

    for (let i = 0; i < seq.length; i += 1) {
        const aa = seq[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'aa-token';
        if (i === selectedResidueIndex) btn.classList.add('selected');
        btn.textContent = aa;
        btn.title = `Posición ${i + 1}: ${aa}`;
        btn.onclick = () => selectResidue(i);
        aaSequenceTrack.appendChild(btn);
    }

    if (selectedResidueIndex == null || selectedResidueIndex >= seq.length) {
        selectedResidueIndex = 0;
    }
    renderResidueLegend(seq, selectedResidueIndex);
}

function selectResidue(index) {
    selectedResidueIndex = index;
    renderAminoAcidEditor(getCurrentFastaSequence());
}

function renderResidueLegend(sequence, index) {
    const aa = sequence[index];
    const info = AMINO_ACID_INFO[aa];
    if (!aa || !info) {
        aaLegendCard.classList.add('hidden');
        return;
    }
    aaLegendCard.classList.remove('hidden');
    aaLegendChip.textContent = aa;
    aaLegendName.textContent = info.name;
    aaLegendMeta.textContent = `Posición ${index + 1} · ${info.three} · ${info.type}`;

    const previous = aaReplaceSelect.value;
    aaReplaceSelect.innerHTML = '';
    AMINO_ACID_CODES.forEach(code => {
        const opt = document.createElement('option');
        opt.value = code;
        const i = AMINO_ACID_INFO[code];
        opt.textContent = `${code} — ${i.name}`;
        aaReplaceSelect.appendChild(opt);
    });
    aaReplaceSelect.value = previous && AMINO_ACID_INFO[previous] ? previous : aa;
}

function applyResidueChange() {
    const seq = getCurrentFastaSequence();
    if (!seq || selectedResidueIndex == null || selectedResidueIndex >= seq.length) return;
    const replacement = aaReplaceSelect.value;
    if (!AMINO_ACID_INFO[replacement]) return;

    const chars = seq.split('');
    chars[selectedResidueIndex] = replacement;
    setCurrentFastaSequence(chars.join(''));
    updateFastaPreview();
}

// ════════════════════════════════════════════════
// 2e. Descarga del archivo .fasta
// ════════════════════════════════════════════════
function downloadFasta() {
    const raw = fastaInput.value.trim();
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

// ════════════════════════════════════════════════
// 3. Envío del job — POST /jobs/submit
// ════════════════════════════════════════════════
btnSubmit.addEventListener('click', async () => {
    let sequence = fastaInput.value.trim();

    if (!sequence || !sequence.startsWith('>')) {
        alert("Por favor, introduce una secuencia FASTA válida que comience con '>'");
        return;
    }

    // Ensure the name field is reflected in the FASTA header
    const nameVal = proteinNameInput.value.trim();
    if (nameVal && sequence.startsWith('>')) {
        const slug = nameVal.toLowerCase().replace(/\s+/g, '_');
        const lines = sequence.split('\n');
        lines[0] = '>' + slug;
        sequence = lines.join('\n');
        fastaInput.value = sequence;
    }

    try {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Enviando...';

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

        const data = await res.json();
        const jobId = data.job_id;
        const proteinLabel = inferProteinDisplayName(sequence, nameVal);
        upsertJob({
            job_id: jobId,
            protein_name: proteinLabel,
            status: 'PENDING',
            logs: [
                `> Job ${jobId} enviado a CESGA Slurm`,
                '> Esperando recursos GPU...'
            ],
        });
        ensureJobsPolling();
        renderJobsList();
    } catch (e) {
        alert('Error al conectar con la API CESGA:\n' + e.message);
    } finally {
        resetSubmitBtn();
    }
});

// ════════════════════════════════════════════════
// 4. Cola de trabajos y polling en background
// ════════════════════════════════════════════════
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function inferProteinDisplayName(sequence, fallbackName = '') {
    const cleaned = String(fallbackName || '').trim();
    if (cleaned) return cleaned;
    if (String(sequence).startsWith('>')) {
        const header = sequence.split('\n')[0].slice(1).trim();
        if (header) return header;
    }
    return 'proteina_sintetica';
}

function upsertJob(payload) {
    const existing = jobsById.get(payload.job_id) ?? {};
    const merged = {
        job_id: payload.job_id,
        protein_name: payload.protein_name ?? existing.protein_name ?? payload.job_id,
        status: payload.status ?? existing.status ?? 'PENDING',
        outputs: payload.outputs ?? existing.outputs ?? null,
        logs: payload.logs ?? existing.logs ?? [],
        error_message: payload.error_message ?? existing.error_message ?? null,
        openWhenReady: payload.openWhenReady ?? existing.openWhenReady ?? false,
        loadingOutputs: payload.loadingOutputs ?? existing.loadingOutputs ?? false,
        created_at: existing.created_at ?? Date.now(),
    };
    jobsById.set(payload.job_id, merged);
    return merged;
}

function appendJobLog(job, msg) {
    const logs = Array.isArray(job.logs) ? job.logs : [];
    logs.push(msg);
    while (logs.length > 120) logs.shift();
    job.logs = logs;
}

function displayStatus(status) {
    if (status === 'COMPLETED') return 'READY';
    return status ?? 'PENDING';
}

function statusClass(status) {
    if (status === 'COMPLETED') return 'ready';
    if (status === 'RUNNING') return 'running';
    if (status === 'FAILED' || status === 'CANCELLED') return 'failed';
    return 'pending';
}

function renderJobsList() {
    if (!jobsListEl) return;
    const jobs = [...jobsById.values()].sort((a, b) => b.created_at - a.created_at);
    if (!jobs.length) {
        jobsListEl.innerHTML = '<div class="jobs-empty">Aún no hay trabajos enviados.</div>';
        return;
    }
    jobsListEl.innerHTML = '';
    jobs.forEach(job => {
        const item = document.createElement('div');
        item.className = 'job-item';

        const canVisualize = job.status === 'COMPLETED' || job.status === 'RUNNING' || job.status === 'PENDING';
        item.innerHTML = `
            <div class="job-main">
                <div class="job-name">${job.protein_name || job.job_id}</div>
                <div class="job-id">${job.job_id}</div>
            </div>
            <div class="job-actions">
                <span class="job-status ${statusClass(job.status)}">${displayStatus(job.status)}</span>
                <button class="glass-btn small ${canVisualize ? '' : 'secondary'}" ${canVisualize ? '' : 'disabled'} data-job-view="${job.job_id}">
                    Visualizar
                </button>
            </div>
        `;
        const btn = item.querySelector('button[data-job-view]');
        if (btn) btn.addEventListener('click', () => visualizeJob(job.job_id));
        jobsListEl.appendChild(item);
    });
}

renderJobsList();
renderAminoAcidEditor('');
updateProteinSkyVisibility(views.idle.classList.contains('active'));

function ensureJobsPolling() {
    if (jobsPollInterval) return;
    jobsPollInterval = setInterval(pollJobsStatus, 3000);
}

async function pollJobsStatus() {
    const candidates = [...jobsById.values()].filter(j => !TERMINAL_STATES.has(j.status));
    if (!candidates.length) return;

    await Promise.all(candidates.map(async (job) => {
        try {
            const res = await fetch(`${API_BASE}/jobs/${job.job_id}/status`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const prev = job.status;
            job.status = data.status ?? prev;
            if (data.error_message) job.error_message = data.error_message;

            if (job.status !== prev) {
                appendJobLog(job, `> [${new Date().toLocaleTimeString()}] Estado: ${job.status}`);
                if (job.status === 'FAILED') {
                    appendJobLog(job, `> [ERROR] ${job.error_message ?? 'Error desconocido'}`);
                }
                if (job.status === 'COMPLETED') {
                    appendJobLog(job, '> Job COMPLETADO — listo para visualizar');
                }
            }

            if (activePollingJobId === job.job_id) {
                renderPollingForJob(job);
            }

            if (job.status === 'COMPLETED' && job.openWhenReady && !job.outputs) {
                await loadJobOutputs(job.job_id, true);
            }
        } catch (e) {
            appendJobLog(job, `> [WARN] Error de red durante polling: ${e.message}`);
            if (activePollingJobId === job.job_id) renderPollingForJob(job);
        }
    }));

    renderJobsList();
}

function renderPollingForJob(job) {
    showView('polling');
    statusTitle.textContent = `Trabajo: ${job.protein_name ?? job.job_id}`;
    logsEl.textContent = (job.logs && job.logs.length) ? job.logs.join('\n') : '> Esperando estado del job...';
    logsEl.scrollTop = logsEl.scrollHeight;

    if (job.status === 'PENDING') {
        updateStepper('PENDING');
        statusSub.textContent = 'Esperando recursos GPU libres...';
        progressBar.style.animation = '';
        progressBar.style.background = '';
    } else if (job.status === 'RUNNING') {
        updateStepper('RUNNING');
        statusSub.textContent = 'Generando MSA e inferencia neuronal...';
        progressBar.style.animation = '';
        progressBar.style.background = '';
    } else if (job.status === 'COMPLETED') {
        updateStepper('COMPLETED');
        statusSub.textContent = 'Descargando resultados...';
        progressBar.style.animation = '';
        progressBar.style.background = '';
    } else {
        updateStepper('FAILED');
        statusSub.textContent = job.error_message ?? 'Error en el cálculo';
        progressBar.style.animation = 'none';
        progressBar.style.background = '#ff007b';
    }
}

function backToJobs() {
    activePollingJobId = null;
    showView('idle');
    renderJobsList();
}

async function visualizeJob(jobId) {
    const job = jobsById.get(jobId);
    if (!job) return;

    if (job.outputs) {
        openJobResults(job);
        return;
    }
    if (job.status === 'COMPLETED') {
        await loadJobOutputs(jobId, true);
        return;
    }
    if (job.status === 'FAILED' || job.status === 'CANCELLED') {
        alert('Este trabajo no está disponible para visualizar porque finalizó con error.');
        return;
    }

    job.openWhenReady = true;
    activePollingJobId = jobId;
    renderPollingForJob(job);
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
// 5. Fetch de resultados — /outputs
// ════════════════════════════════════════════════
async function loadJobOutputs(jobId, openWhenReady = false) {
    const job = jobsById.get(jobId);
    if (!job || job.loadingOutputs) return;
    job.loadingOutputs = true;
    try {
        const outRes = await fetch(`${API_BASE}/jobs/${jobId}/outputs`);

        if (!outRes.ok) throw new Error(`outputs HTTP ${outRes.status}`);

        const outputs = await outRes.json();
        job.outputs = outputs;
        job.status = 'COMPLETED';
        job.openWhenReady = false;

        if (openWhenReady || activePollingJobId === jobId) {
            openJobResults(job);
        }
    } catch (e) {
        alert('Error al cargar los resultados:\n' + e.message);
        appendJobLog(job, `> [ERROR] No se pudieron cargar outputs: ${e.message}`);
    } finally {
        job.loadingOutputs = false;
        renderJobsList();
    }
}

function openJobResults(job) {
    currentJobId = job.job_id;
    currentData = { outputs: job.outputs };
    activePollingJobId = null;
    renderDashboard(job.outputs);
    showView('results');
}

// ════════════════════════════════════════════════
// 6. Render del dashboard completo
// ════════════════════════════════════════════════
function renderDashboard(outputs) {

    // ─── 6a. Top bar ────────────────────────────
    const meta = outputs.protein_metadata;
    const struct = outputs.structural_data;
    const bio = outputs.biological_data ?? {};
    const apiConf = struct?.confidence ?? {};
    const pdbStats = buildStatsFromPdb(struct?.pdb_file ?? '');
    const conf = pdbStats.confidence;
    const paeMatrix = Array.isArray(apiConf.pae_matrix) ? apiConf.pae_matrix : [];
    const meanPae = Number.isFinite(apiConf.mean_pae) ? apiConf.mean_pae : computeMeanPae(paeMatrix);

    // Nombre y organismo
    if (meta) {
        document.getElementById('res-protein-name').textContent = meta.protein_name ?? 'Proteína desconocida';
        document.getElementById('res-protein-organism').textContent =
            `${meta.organism ?? '—'} · UniProt: ${meta.uniprot_id ?? '—'} · PDB: ${meta.pdb_id ?? '—'}`;
        document.getElementById('res-source-badge').textContent = meta.data_source === 'precomputed_database'
            ? 'Base de datos precalculada'
            : 'AlphaFold2 predicho';
    } else {
        document.getElementById('res-protein-name').textContent = 'Proteína sintética';
        document.getElementById('res-protein-organism').textContent = 'Secuencia personalizada · Datos sintéticos (no reales)';
        document.getElementById('res-source-badge').textContent = 'Datos sintéticos';
    }

    // Stats rápidos de la top bar
    const plddt = conf.plddt_mean;
    document.getElementById('res-plddt-top').textContent = Number.isFinite(plddt) ? plddt.toFixed(1) : '—';
    document.getElementById('res-plddt-top').style.color = Number.isFinite(plddt) ? plddtColor(plddt) : '';
    document.getElementById('res-pae-top').textContent = Number.isFinite(meanPae)
        ? `${meanPae.toFixed(2)} Å`
        : 'No disponible';

    // ─── 6b. pLDDT grande + histograma ──────────
    const plddtEl = document.getElementById('res-plddt');
    plddtEl.textContent = Number.isFinite(plddt) ? plddt.toFixed(1) : '—';
    plddtEl.style.color = Number.isFinite(plddt) ? plddtColor(plddt) : '';
    document.getElementById('res-plddt-label').textContent = Number.isFinite(plddt)
        ? plddtLabel(plddt)
        : 'No disponible en PDB';

    renderPlddtHistogram(conf.plddt_histogram ?? { low: 0, medium: 0, high: 0, very_high: 0 });
    renderPlddtChart(conf.plddt_per_residue ?? []);

    // ─── 6c. PAE matrix ─────────────────────────
    renderPaeMatrix(paeMatrix);

    // ─── 6d. JSON de confianza ───────────────────
    const confidenceJsonEl = document.getElementById('confidence-json');
    if (confidenceJsonEl) {
        confidenceJsonEl.textContent = JSON.stringify(apiConf, null, 2);
    }

    // ─── 6e. Avisos de confianza ─────────────────

    const alerts = [];
    if (!meta) {
        alerts.push({
            type: 'warning',
            text: '⚠️ Esta secuencia no pertenece al catálogo conocido. Los datos biológicos/estructurales son sintéticos y no representan una proteína real.'
        });
    }
    if (conf.plddt_histogram?.low > 0) {
        alerts.push({
            type: 'warning',
            text: `⚠️ ${conf.plddt_histogram.low} residuos con pLDDT < 50 (muy baja confianza).`
        });
    }
    if ((conf.plddt_histogram?.low ?? 0) + (conf.plddt_histogram?.medium ?? 0) > 0) {
        alerts.push({
            type: 'info',
            text: 'ℹ️ Revisa regiones con pLDDT bajo antes de interpretar estructura/localización de dominios.'
        });
    }
    if (Number.isFinite(meanPae)) {
        alerts.push({
            type: 'info',
            text: `ℹ️ PAE medio del modelo: ${meanPae.toFixed(2)} Å.`
        });
    }
    renderAlerts(alerts);

    // ─── 6f. Logs del job ────────────────────────
    const logsResult = document.getElementById('result-logs');
    logsResult.textContent = typeof outputs.logs === 'string'
        ? outputs.logs
        : JSON.stringify(outputs.logs, null, 2);

    // ─── 6g. Visor 3D — Mol* ─────────────────────
    // Priorizamos PDB para mantener coherencia con las métricas derivadas del PDB
    const pdbData = struct.pdb_file;
    const cifData = struct.cif_file;
    init3DViewer(pdbData || cifData, pdbData ? 'pdb' : 'cif');
}

const RESIDUE_MASS_DA = {
    ALA: 71.08, ARG: 156.19, ASN: 114.10, ASP: 115.09, CYS: 103.15,
    GLN: 128.13, GLU: 129.12, GLY: 57.05, HIS: 137.14, ILE: 113.16,
    LEU: 113.16, LYS: 128.17, MET: 131.19, PHE: 147.18, PRO: 97.12,
    SER: 87.08, THR: 101.11, TRP: 186.21, TYR: 163.18, VAL: 99.13,
};

function buildStatsFromPdb(pdbText) {
    const residues = [];
    const seen = new Set();
    const plddtPerResidue = [];
    const plddtBuckets = { low: 0, medium: 0, high: 0, very_high: 0 };

    const lines = String(pdbText || '').split('\n');
    for (const line of lines) {
        if (!line.startsWith('ATOM')) continue;
        const atomName = line.slice(12, 16).trim();
        const resName = line.slice(17, 20).trim().toUpperCase();
        const chain = line.slice(21, 22).trim() || '_';
        const resSeq = line.slice(22, 26).trim();
        const iCode = line.slice(26, 27).trim();
        const resid = `${chain}:${resSeq}:${iCode}:${resName}`;
        if (!seen.has(resid)) {
            seen.add(resid);
            residues.push(resName);
        }

        // AlphaFold suele guardar pLDDT en B-factor.
        if (atomName === 'CA') {
            const bfactor = Number(line.slice(60, 66).trim());
            if (Number.isFinite(bfactor)) {
                plddtPerResidue.push(bfactor);
                if (bfactor > 90) plddtBuckets.very_high += 1;
                else if (bfactor > 70) plddtBuckets.high += 1;
                else if (bfactor > 50) plddtBuckets.medium += 1;
                else plddtBuckets.low += 1;
            }
        }
    }

    const length = residues.length;
    const mwDa = residues.reduce((acc, r) => acc + (RESIDUE_MASS_DA[r] ?? 110.0), 18.015);
    const aromaticResidues = residues.filter(r => r === 'PHE' || r === 'TRP' || r === 'TYR' || r === 'HIS').length;
    const cysteineResidues = residues.filter(r => r === 'CYS').length;
    const plddtMean = plddtPerResidue.length
        ? plddtPerResidue.reduce((a, b) => a + b, 0) / plddtPerResidue.length
        : null;

    return {
        sequence_properties: {
            length,
            molecular_weight_kda: mwDa / 1000,
            cysteine_residues: cysteineResidues,
            aromatic_residues: aromaticResidues,
        },
        confidence: {
            plddt_mean: plddtMean,
            plddt_histogram: plddtBuckets,
            plddt_per_residue: plddtPerResidue,
        },
    };
}


// ════════════════════════════════════════════════
// 7. Mol* — Inicializar visor 3D
//    Usamos customData con Blob URL para evitar
//    límites de data: URI en cadenas grandes.
// ════════════════════════════════════════════════
let _blobUrl = null;  // guardamos para revocar al resetear

function init3DViewer(structureData, format = 'cif') {
    const container = document.getElementById('viewer-container');

    // Destruir instancia anterior si existe
    if (molstarPlugin) {
        try { molstarPlugin.clear(); } catch (_) { }
        molstarPlugin = null;
    }
    container.innerHTML = '';

    // Revocar blob anterior
    if (_blobUrl) {
        URL.revokeObjectURL(_blobUrl);
        _blobUrl = null;
    }

    // Crear blob URL — evita límites de data: URI
    const mimeType = format === 'cif' ? 'text/plain' : 'text/plain';
    const blob = new Blob([structureData], { type: mimeType });
    _blobUrl = URL.createObjectURL(blob);

    // Instanciar PDBeMolstarPlugin (correcto, de pdbe-molstar@3.3.x)
    molstarPlugin = new window.PDBeMolstarPlugin();

    const options = {
        // customData en lugar de moleculeId para datos locales
        customData: {
            url: _blobUrl,
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

    molstarPlugin.render(container, options);
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
        const dpr = window.devicePixelRatio || 1;
        const S = Math.min(canvas.clientWidth || 240, 240);
        canvas.width = S * dpr;
        canvas.height = S * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(0, 0, S, S);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '12px var(--font-sans, sans-serif)';
        ctx.textAlign = 'center';
        ctx.fillText('PAE no disponible desde PDB', S / 2, S / 2);
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

// ════════════════════════════════════════════════
// 9. Descarga de ficheros
// ════════════════════════════════════════════════
function downloadFile(type) {
    if (!currentData) return;
    const struct = currentData.outputs.structural_data;
    const content = type === 'cif' ? struct.cif_file : struct.pdb_file;
    const ext = type === 'cif' ? '.cif' : '.pdb';
    const mimeType = 'text/plain';
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `protein3d_${currentJobId ?? 'structure'}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
}

// Retrocompatibilidad con el botón antiguo
function downloadPDB() { downloadFile('pdb'); }

function downloadConfidenceJson() {
    if (!currentData) return;
    const confidence = currentData.outputs?.structural_data?.confidence ?? {};
    const content = JSON.stringify(confidence, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `protein3d_${currentJobId ?? 'structure'}_confidence.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function downloadLogs() {
    if (!currentData) return;
    const logs = currentData.outputs?.logs;
    const content = typeof logs === 'string' ? logs : JSON.stringify(logs ?? {}, null, 2);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `protein3d_${currentJobId ?? 'structure'}_logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

// ════════════════════════════════════════════════
// 10. Reset
// ════════════════════════════════════════════════
function resetApp() {
    if (molstarPlugin) {
        try { molstarPlugin.clear(); } catch (_) { }
        molstarPlugin = null;
    }
    if (_blobUrl) {
        URL.revokeObjectURL(_blobUrl);
        _blobUrl = null;
    }
    currentJobId = null;
    currentData = null;
    fastaInput.value = '';
    proteinNameInput.value = '';
    fastaPreviewCard.classList.add('hidden');
    fastaPreviewPre.textContent = '';
    renderAminoAcidEditor('');
    logsEl.textContent = '> Initializing job...';
    progressBar.style.animation = '';
    progressBar.style.background = '';
    resetSubmitBtn();
    backToJobs();
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

function computeMeanPae(matrix) {
    if (!Array.isArray(matrix) || matrix.length === 0) return null;
    let sum = 0;
    let count = 0;
    for (const row of matrix) {
        if (!Array.isArray(row)) continue;
        for (const val of row) {
            const n = Number(val);
            if (Number.isFinite(n)) {
                sum += n;
                count += 1;
            }
        }
    }
    return count > 0 ? (sum / count) : null;
}

function formatSeconds(secs) {
    if (!secs) return '—';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

/* ════════════════════════════════════════════════
   12. CHATBOT — Asistente IA con Grok (vía Puter.js)
   ════════════════════════════════════════════════ */

const GROK_MODELS = ['x-ai/grok-4.20', 'x-ai/grok-4-1-fast', 'x-ai/grok-3-mini-fast'];
const GROK_TIMEOUT_MS = 25000;

// ── Estado del chat ──────────────────────────────
let chatHistory = [];   // array de {role, content} (formato OpenAI/Grok)
let chatIsOpen = false;
let chatTypingEl = null;

// ── Mensaje de bienvenida ────────────────────────
const WELCOME_MSG = `¡Hola! Soy el asistente IA de Protein3D 🧬

Puedo ayudarte a:
• Interpretar los resultados de tus predicciones (pLDDT y PAE)
• Explicar qué significa cada métrica en términos biológicos
• Resumir las regiones de mayor y menor confianza estructural

Cuando hayas cargado una proteína, tendré acceso a todos sus datos en tiempo real. ¡Pregunta lo que quieras!`;

// ── Construir contexto con los datos actuales ────
function buildProteinContext() {
    if (!currentData) {
        return 'El investigador aún no ha cargado ninguna proteína. No hay datos de predicción disponibles todavía.';
    }

    const out = currentData.outputs;
    const meta = out.protein_metadata ?? {};
    const struct = out.structural_data ?? {};
    const conf = struct.confidence ?? {};
    const plddtHist = conf.plddt_histogram ?? {};

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
- Distribución pLDDT: muy baja=${plddtHist.low ?? '—'} res, baja=${plddtHist.medium ?? '—'} res, alta=${plddtHist.high ?? '—'} res, muy alta=${plddtHist.very_high ?? '—'} res

Job ID: ${currentJobId ?? '—'}
=== FIN DE DATOS ===`;
}

// ── Prompt de sistema ────────────────────────────
function buildSystemPrompt() {
    return `Eres un Asistente Experto en Bioinformática de Protein3D, especializado en el análisis estructural de proteínas mediante AlphaFold2 y computación de alto rendimiento (HPC) en el supercomputador CESGA. Tu objetivo es proporcionar análisis rigurosos, precisos y de alto nivel científico a investigadores.

REGLAS DE COMPORTAMIENTO:
1. Tono: Profesional, científico, analítico y preciso, pero capaz de explicar conceptos complejos de forma didáctica.
2. Idioma: Español técnico.
3. Integración de Datos: Utiliza TODOS los datos proporcionados en el "Contexto actual" para fundamentar tus respuestas. Si faltan datos, indícalo.
4. Emojis: Úsalos de forma profesional (🧬, 🔴, 🔵, ⚠️) para ayudar a estructurar la información visualmente.

GUÍA TÉCNICA PARA TUS EXPLICACIONES:
- pLDDT (Confianza Local):
    - > 90 (Azul oscuro): Estructura altamente confiable, similar a resolución experimental atomística. Ideal para diseño de fármacos.
    - 70-90 (Azul claro): Buena confianza en la morfología del esqueleto.
    - 50-70 (Amarillo): Baja confianza; tratar con precaución. Podría ser una región flexible.
    - < 50 (Naranja): Muy baja confianza. Suele indicar regiones intrínsecamente desordenadas (IDRs) o que no se pliegan de forma estable sin ligandos.
- PAE (Error de Alineación): Explica la confianza en la orientación relativa de los dominios. PAE bajo entre dos puntos indica que su posición relativa es correcta.
- Propiedades Biológicas: Correlaciona la estructura con la solubilidad y estabilidad proporcionadas. Por ejemplo, si hay muchas hélices alfa y baja solubilidad, analiza qué podría estar ocurriendo.

Contexto actual de la proteína en el sistema:
${buildProteinContext()}`;
}

async function ensurePuterReady() {
    if (!window.puter || !window.puter.ai || !window.puter.auth) {
        throw new Error('Puter.js no está disponible. Verifica la carga de https://js.puter.com/v2/');
    }

    if (!puter.auth.isSignedIn()) {
        // Debe ejecutarse desde una acción de usuario para evitar bloqueo de popup
        try {
            await puter.auth.signIn({ attempt_temp_user_creation: true });
        } catch (err) {
            throw new Error(`No se pudo iniciar sesión en Puter. Permite popups/cookies y reintenta. Detalle: ${err?.message ?? 'desconocido'}`);
        }
    }
}

async function withTimeout(promise, ms) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error('Tiempo de espera agotado al consultar Grok'));
        }, ms);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
}

// ── Llamar a la API de Grok (vía Puter.js) ──────
async function callGrok(userMessage) {
    await ensurePuterReady();

    // Añadir mensaje del usuario al historial (formato OpenAI)
    chatHistory.push({ role: 'user', content: userMessage });

    // Construir mensajes: system prompt + historial
    const messages = [
        { role: 'system', content: buildSystemPrompt() },
        ...chatHistory,
    ];

    let response = null;
    let lastErr = null;
    for (const model of GROK_MODELS) {
        try {
            response = await withTimeout(
                puter.ai.chat(messages, {
                    model,
                    temperature: 0.7,
                    max_tokens: 8192,
                }),
                GROK_TIMEOUT_MS
            );
            break;
        } catch (err) {
            lastErr = err;
        }
    }
    if (!response) throw lastErr ?? new Error('No fue posible obtener respuesta de Grok');

    const reply = response?.message?.content ?? '(Sin respuesta)';

    // Añadir respuesta de la IA al historial
    chatHistory.push({ role: 'assistant', content: reply });

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
    statusLabel.textContent = 'Grok está pensando...';

    // Mostrar indicador de escritura
    chatTypingEl = appendChatMsg('', 'ai', true);

    try {
        const reply = await callGrok(text);

        // Quitar typing, añadir respuesta real
        chatTypingEl.remove();
        chatTypingEl = null;
        appendChatMsg(reply, 'ai');
        statusLabel.textContent = 'Powered by Grok · Listo';

    } catch (err) {
        chatTypingEl?.remove();
        chatTypingEl = null;
        appendChatMsg(`⚠️ Error al contactar con Grok:\n${err.message}`, 'error');
        statusLabel.textContent = 'Error · Powered by Grok';
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
    document.getElementById('chat-status-label').textContent = 'Powered by Grok · Listo';
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
