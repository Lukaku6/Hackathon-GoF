/* ════════════════════════════════════════════════
   BioHack — app.js
   Usa la API CESGA real (api-mock-cesga.onrender.com)
   + Mol* (PDBe-Molstar) para la visualización 3D
   + Visualización de pLDDT por residuo, PAE, etc.
   ════════════════════════════════════════════════ */

const API_BASE = 'https://api-mock-cesga.onrender.com';

// ── Estado de la aplicación ──────────────────────
let currentJobId = null;
let pollInterval = null;
let molstarPlugin = null;   // instancia PDBeMolstarPlugin
let currentData = null;   // outputs completos del job

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

// ════════════════════════════════════════════════
// 1. Helpers de navegación
// ════════════════════════════════════════════════
function showView(viewId) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[viewId].classList.add('active');
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
        console.log(`[BioHack] ${_allProteins.length} proteínas cargadas desde la API`);
    } catch (e) {
        console.warn('[BioHack] No se pudo cargar la lista de proteínas:', e.message);
    } finally {
        _proteinsLoading = false;
    }
}

// Cargar proteínas al iniciar la aplicación
fetchProteinList();

let _acDebounce = null;
let _acSelectedIdx = -1;  // índice de la sugerencia seleccionada con teclado

function onProteinNameInput(val) {
    clearTimeout(_acDebounce);
    _acSelectedIdx = -1;
    if (!val.trim()) { hideAutocomplete(); return; }

    _acDebounce = setTimeout(() => {
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
        showAutocomplete(results.slice(0, 8));
    }, 150);

    // También sincronizar nombre en la cabecera FASTA
    syncNameToFasta(val);
}

function onNameKeyDown(e) {
    const items = autocompleteBox.querySelectorAll('.ac-item');
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _acSelectedIdx = Math.min(_acSelectedIdx + 1, items.length - 1);
        highlightAcItem(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _acSelectedIdx = Math.max(_acSelectedIdx - 1, 0);
        highlightAcItem(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_acSelectedIdx >= 0 && items[_acSelectedIdx]) {
            items[_acSelectedIdx].click();
        } else {
            searchProteinByName();
        }
    } else if (e.key === 'Escape') {
        hideAutocomplete();
    }
}

function highlightAcItem(items) {
    items.forEach((it, i) => {
        it.classList.toggle('ac-highlighted', i === _acSelectedIdx);
    });
    // Scroll into view
    if (items[_acSelectedIdx]) {
        items[_acSelectedIdx].scrollIntoView({ block: 'nearest' });
    }
}

async function searchProteinByName() {
    const name = proteinNameInput.value.trim();
    if (!name) return;
    hideAutocomplete();
    const btn = document.getElementById('btn-search-protein');
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
            fastaInput.value = data.fasta_ready ?? '';
            const displayName = data.protein_name ?? data.name ?? name;
            proteinNameInput.value = displayName;
            updateFastaPreview();
        } else {
            // Nada encontrado — al menos pon el nombre en el header del FASTA
            syncNameToFasta(name, true);
            showNameNotFound(name);
        }
    } catch (e) {
        syncNameToFasta(name, true);
        showNameNotFound(name);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Buscar';
    }
}

function showNameNotFound(name) {
    const hint = document.createElement('div');
    hint.className = 'name-not-found';
    hint.textContent = `"${name}" no encontrado en la API — añade tu secuencia manualmente.`;
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

        item.onclick = () => selectSuggestion(protein);
        autocompleteBox.appendChild(item);
    });
    autocompleteBox.classList.remove('hidden');
}

function hideAutocomplete() {
    autocompleteBox.classList.add('hidden');
    autocompleteBox.innerHTML = '';
    _acSelectedIdx = -1;
}

async function selectSuggestion(protein) {
    proteinNameInput.value = protein.protein_name || protein.protein_id;
    hideAutocomplete();
    // Fetch la FASTA de la proteína individual
    loadPreset(protein.protein_id);
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
        return;
    }
    // Parse
    const lines = raw.split('\n');
    const header = lines[0];  // >name
    const seqRaw = lines.slice(1).join('').replace(/\s/g, '').toUpperCase();
    if (!seqRaw) { fastaPreviewCard.classList.add('hidden'); return; }

    // Format: 60 chars per line
    const wrapped = seqRaw.match(/.{1,60}/g) || [];
    const formatted = header + '\n' + wrapped.join('\n');

    fastaPreviewPre.textContent = formatted;
    fastaPreviewStats.textContent = `${seqRaw.length} residuos · ${Math.round(seqRaw.length * 110 / 1000)} kDa est.`;
    fastaPreviewCard.classList.remove('hidden');
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
        currentJobId = data.job_id;

        startPolling();
    } catch (e) {
        alert('Error al conectar con la API CESGA:\n' + e.message);
        resetSubmitBtn();
    }
});

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
        const [outRes, accRes] = await Promise.all([
            fetch(`${API_BASE}/jobs/${currentJobId}/outputs`),
            fetch(`${API_BASE}/jobs/${currentJobId}/accounting`),
        ]);

        if (!outRes.ok) throw new Error(`outputs HTTP ${outRes.status}`);
        if (!accRes.ok) throw new Error(`accounting HTTP ${accRes.status}`);

        const outputs = await outRes.json();
        const accounting = await accRes.json();

        currentData = { outputs, accounting };

        renderDashboard(outputs, accounting);
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
function renderDashboard(outputs, accounting) {

    // ─── 6a. Top bar ────────────────────────────
    const meta = outputs.protein_metadata;
    const struct = outputs.structural_data;
    const conf = struct.confidence;
    const bio = outputs.biological_data;

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
        document.getElementById('res-protein-organism').textContent = 'Secuencia personalizada';
    }

    // Stats rápidos de la top bar
    const plddt = conf.plddt_mean;
    document.getElementById('res-plddt-top').textContent = plddt.toFixed(1);
    document.getElementById('res-plddt-top').style.color = plddtColor(plddt);
    document.getElementById('res-pae-top').textContent = (conf.mean_pae ?? 0).toFixed(2) + ' Å';
    document.getElementById('res-length-top').textContent = bio.sequence_properties?.length ?? '—';
    document.getElementById('res-mw-top').textContent =
        (bio.sequence_properties?.molecular_weight_kda ?? '—') + ' kDa';

    // ─── 6b. pLDDT grande + histograma ──────────
    const plddtEl = document.getElementById('res-plddt');
    plddtEl.textContent = plddt.toFixed(1);
    plddtEl.style.color = plddtColor(plddt);
    document.getElementById('res-plddt-label').textContent = plddtLabel(plddt);

    renderPlddtHistogram(conf.plddt_histogram);
    renderPlddtChart(conf.plddt_per_residue ?? []);

    // ─── 6c. PAE matrix ─────────────────────────
    if (conf.pae_matrix) {
        renderPaeMatrix(conf.pae_matrix);
    }

    // ─── 6d. Estructura secundaria ───────────────
    const ss = bio.secondary_structure_prediction;
    if (ss) renderSecondaryStructure(ss);

    // ─── 6e. Análisis biológico ──────────────────
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

    // ─── 6f. HPC Accounting ──────────────────────
    const acc = accounting.accounting;
    renderHPC([
        { label: 'GPU Horas', val: acc.gpu_hours?.toFixed(4) + ' h' },
        { label: 'CPU Horas', val: acc.cpu_hours?.toFixed(4) + ' h' },
        { label: 'RAM · Hora', val: acc.memory_gb_hours?.toFixed(2) + ' GB·h' },
        { label: 'Tiempo de pared', val: formatSeconds(acc.wall_time_seconds) },
        { label: 'Nodo', val: acc.node_name ?? '—' },
        { label: 'Partición', val: acc.partition ?? '—' },
    ]);

    // ─── 6g. Logs del job ────────────────────────
    const logsResult = document.getElementById('result-logs');
    logsResult.textContent = typeof outputs.logs === 'string'
        ? outputs.logs
        : JSON.stringify(outputs.logs, null, 2);

    // ─── 6h. Visor 3D — Mol* ─────────────────────
    // Preferimos mmCIF (nativo de Mol*) sobre PDB
    const cifData = struct.cif_file;
    const pdbData = struct.pdb_file;
    init3DViewer(cifData || pdbData, cifData ? 'cif' : 'pdb');
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
    if (!canvas || !matrix || matrix.length === 0) return;

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
    const struct = currentData.outputs.structural_data;
    const content = type === 'cif' ? struct.cif_file : struct.pdb_file;
    const ext = type === 'cif' ? '.cif' : '.pdb';
    const mimeType = 'text/plain';
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `biohack_${currentJobId ?? 'structure'}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
}

// Retrocompatibilidad con el botón antiguo
function downloadPDB() { downloadFile('pdb'); }

// ════════════════════════════════════════════════
// 10. Reset
// ════════════════════════════════════════════════
function resetApp() {
    clearInterval(pollInterval);
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
    pollInterval = null;
    fastaInput.value = '';
    proteinNameInput.value = '';
    fastaPreviewCard.classList.add('hidden');
    fastaPreviewPre.textContent = '';
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
const WELCOME_MSG = `¡Hola! Soy el asistente IA de BioHack 🧬

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
    return `Eres el asistente de IA de BioHack, una plataforma de predicción de estructuras proteicas que usa AlphaFold2 en el supercomputador CESGA. Ayudas a investigadores científicos a interpretar los resultados de predicciones.

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
