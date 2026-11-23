// =============================================================================
// --- 1. ESTADO DA APLICAÇÃO ---
// Variáveis globais que guardam o estado da aplicação.
// =============================================================================
let posts = [];
let currentUserProfile = {};
let currentSection = 'feed';
let postToDelete = null;
let editQuillInstances = {};
let quill;
let activeFeedFilter = 'Todos';
let sagScheduleInitialized = false;
let sagClockIntervalId = null;
let socketListenersInitialized = false;
let currentViewMode = localStorage.getItem('zabbixViewMode') || 'grid';
let problemasEmCache = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function initSagScheduleIfNeeded(sagData) {
  if (sagScheduleInitialized) return;
    if (!Array.isArray(sagData)) return;

  const hasSag = document.getElementById('scheduleCalendar');
  if (!hasSag) return;

  renderCalendar(sagData);

  const updateClockAndPlantonista = () => {
    const now = new Date();
    const timeString = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dateString = now.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const timeElement = document.getElementById('currentTime');
    const dateElement = document.getElementById('currentDate');
    if (timeElement) timeElement.textContent = timeString;
    if (dateElement) dateElement.textContent = dateString;

    updateCurrentPlantonista(sagData, now);
  };

  if (sagClockIntervalId) clearInterval(sagClockIntervalId);
  updateClockAndPlantonista();
  sagClockIntervalId = setInterval(updateClockAndPlantonista, 60000);
  
  sagScheduleInitialized = true;
}

// =============================================================================
// --- 2. FUNÇÃO PRINCIPAL DE INICIALIZAÇÃO (PONTO DE ENTRADA) ---
// Orquestra a inicialização de todas as funcionalidades da página.
// =============================================================================
async function fetchUserProfile() {
    try {
        const response = await fetch('/api/profile', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
        });
        if (!response.ok && response.status !== 304) {
            window.location.href = 'login.html';
            return false;
        }
        currentUserProfile = await response.json();
        window.currentUserProfile = currentUserProfile;
        return true;
    } catch (error) {
        console.error('Erro ao buscar perfil do usuário, redirecionando:', error);
        window.location.href = 'login.html';
        return false;
    }
}

class BaseConhecimento {
    constructor() {
        this.apiUrl = '/api/bse';
        this.documents = [];
        this.folders = [];
        this.filteredItems = []; 
        this.currentPath = '/';
        this.breadcrumb = [{ name: 'Base de conhecimento', path: '' }];
        this.isViewingDocument = false;
        this.currentDocument = null;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.loadItems();
    }

    setupEventListeners() {
      const refreshBtn = document.getElementById('bseRefreshBtn');
      const searchInput = document.getElementById('bseSearchInput');
      const backBtn = document.getElementById('bseBackBtn');
      const closeViewer = document.getElementById('bseCloseViewer');
      const listEl = document.getElementById('bseItemsList');
      const breadcrumbEl = document.getElementById('bseBreadcrumb');

        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.loadItems());
        }
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.filterItems(e.target.value));
        }
        if (backBtn) {
            backBtn.addEventListener('click', () => this.navigateBack());
        }
        if (closeViewer) {
            closeViewer.addEventListener('click', () => this.closeDocumentViewer());
        }

        if (listEl) {
            listEl.addEventListener('click', (e) => {
                const itemElement = e.target.closest('.bse-folder-item, .bse-document-item');
                if (!itemElement) return;

                const type = itemElement.dataset.type;
                const path = itemElement.dataset.path;
                const name = itemElement.dataset.name;
                const id = itemElement.dataset.id;

                if (type === 'folder') {
                    this.openFolder(path, name);
                } else if (type === 'document') {
                    this.openDocument(path, name, id);
                }
          });
      }

      if (breadcrumbEl) {
          breadcrumbEl.addEventListener('click', (e) => {
              const breadcrumbItem = e.target.closest('.bse-breadcrumb-item');
              if (breadcrumbItem && breadcrumbItem.dataset.index && !breadcrumbItem.classList.contains('active')) {
                  const index = parseInt(breadcrumbItem.dataset.index, 10);
                  this.navigateToBreadcrumb(index);
              }
          });
      }
  }
          

    async loadItems() {
        const loadingEl = document.getElementById('bseLoading');
        const statusEl = document.getElementById('bseStatusText');
        const listEl = document.getElementById('bseItemsList');

        if (loadingEl) loadingEl.style.display = 'flex';
        if (statusEl) statusEl.textContent = 'Carregando...';
        if (listEl) listEl.innerHTML = ''; 

        try {
            const response = await fetch(`${this.apiUrl}/items?path=${encodeURIComponent(this.currentPath)}`, {
                credentials: 'include'
            });

            if (!response.ok) throw new Error('Erro ao carregar itens do servidor');

            const data = await response.json();
            this.folders = data.folders || [];
            this.documents = data.documents || [];

            this.filteredItems = [...this.folders, ...this.documents].sort((a, b) => a.name.localeCompare(b.name));
            this.renderItems();

            if (statusEl) {
                statusEl.textContent = `${this.folders.length} pastas, ${this.documents.length} documentos`;
            }
        } catch (error) {
            console.error('Erro ao carregar itens:', error);
            if (statusEl) statusEl.textContent = 'Falha ao carregar.';
            if (listEl) listEl.innerHTML = '<div class="bse-empty-state"><p>Não foi possível carregar os itens.</p></div>';
        } finally {
            if (loadingEl) loadingEl.style.display = 'none';
        }

        this.updateBreadcrumb();
        this.updateBackButton();
    }

    filterItems(searchTerm) {
        const term = searchTerm.toLowerCase().trim();
        const allItems = [...this.folders, ...this.documents];

        if (!term) {
            this.filteredItems = allItems.sort((a, b) => a.name.localeCompare(b.name));
        } else {
            this.filteredItems = allItems.filter(item =>
                item.name.toLowerCase().includes(term) ||
                (item.author && item.author.toLowerCase().includes(term))
            ).sort((a, b) => a.name.localeCompare(b.name));
        }

        this.renderItems();

        const statusEl = document.getElementById('bseStatusText');
        if (statusEl) {
            if (term) {
                statusEl.textContent = `${this.filteredItems.length} itens encontrados`;
            } else {
                statusEl.textContent = `${this.folders.length} pastas, ${this.documents.length} documentos`;
            }
        }
    }

    renderItems() {
        const listEl = document.getElementById('bseItemsList');
        if (!listEl) return;

        if (this.filteredItems.length === 0) {
            listEl.innerHTML = `
                <div class="bse-empty-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                        <polyline points="13,2 13,9 20,9"></polyline>
                    </svg>
                    <p>Nenhum item encontrado</p>
                </div>`;
            return;
        }

            listEl.innerHTML = this.filteredItems.map(item => {
                if (item.itemCount !== undefined) { 
                    return `
                        <div class="bse-folder-item" data-type="folder" data-path="${item.path}" data-name="${item.name}">
                            <div class="bse-folder-icon"><i class="fa-solid fa-folder-open"></i></div>
                            <div class="bse-folder-info">
                                <div class="bse-folder-name">${item.name}</div>
                                <div class="bse-folder-meta">
                                    <span>${item.itemCount} itens</span>
                                    <span>${this.formatDate(item.created)}</span>
                                </div>
                            </div>
                        </div>`;
                } else { 
                    return `
                        <div class="bse-document-item" data-type="document" data-path="${item.path}" data-name="${item.name}" data-id="${item.id}">
                            <div class="bse-document-icon ${item.type}">${this.getDocumentIcon(item.type)}</div>
                            <div class="bse-document-info">
                                <div class="bse-document-name">${item.name}</div>
                                <div class="bse-document-meta">
                                    <span>${this.formatFileSize(item.size)}</span>
                                    <span>${item.author}</span>
                                    <span>${this.formatDate(item.modified)}</span>
                                </div>
                            </div>
                        </div>`;
                }
            }).join('');
                }

    openFolder(path, name) {
        this.closeDocumentViewer();
        this.currentPath = path;
        this.breadcrumb.push({ name, path });
        this.loadItems();
    }

    navigateBack() {
        this.closeDocumentViewer();
        if (this.breadcrumb.length > 1) {
            this.breadcrumb.pop();
            const previous = this.breadcrumb[this.breadcrumb.length - 1];
            this.currentPath = previous.path;
            this.loadItems();
        }
    }

    updateBreadcrumb() {
    const breadcrumbEl = document.getElementById('bseBreadcrumb');
    if (!breadcrumbEl) return;

    let html = '';
    
    this.breadcrumb.forEach((item, index) => {
        const isLast = index === this.breadcrumb.length - 1;

        if (isLast) {
            html += `<span class="bse-breadcrumb-item active">${item.name}</span>`;
        } else {
            html += `<span class="bse-breadcrumb-item" data-index="${index}">${item.name}</span>`;
        }

        if (!isLast) {
            html += '<span class="bse-breadcrumb-separator"></span>';
        }
    });

    breadcrumbEl.innerHTML = html;
}

    navigateToBreadcrumb(index) {
    this.closeDocumentViewer(); 
    if (index < this.breadcrumb.length - 1) {
        this.breadcrumb = this.breadcrumb.slice(0, index + 1);
        this.currentPath = this.breadcrumb[index].path;
        this.loadItems();
    }
}

    updateBackButton() {
        const backBtn = document.getElementById('bseBackBtn');
        if (backBtn) {
            backBtn.classList.toggle('bse-is-hidden', this.breadcrumb.length <= 1);
        }
    }

async openDocument(path, name, id) {
    this.isViewingDocument = true;
    this.currentDocument = { path, name, id };

    const mainView = document.querySelector('.bse-main-view');
    const documentViewer = document.getElementById('bseDocumentViewer');
    const viewerTitle = document.getElementById('bseViewerTitle');
    const viewerContent = document.getElementById('bseViewerContent');

    if (mainView) mainView.classList.add('viewing');
    if (documentViewer) documentViewer.classList.remove('bse-is-hidden');
    if (viewerTitle) viewerTitle.textContent = name;
    
    if (viewerContent) {
        viewerContent.innerHTML = '<div class="bse-viewer-loading"><div class="bse-spinner"></div><span>Carregando documento...</span></div>';
    }

    try {
        const documentType = name.split('.').pop().toLowerCase();
        const contentUrl = `${this.apiUrl}/content${path}`;
        const response = await fetch(contentUrl, { credentials: 'include' });
        if (!response.ok) throw new Error(`Falha ao baixar o arquivo: ${response.statusText}`);
        const fileData = await response.blob();
        if (viewerContent) viewerContent.innerHTML = ''; 
        if (documentType === 'xlsx') {
            if (typeof ExcelJS === 'undefined') {
                throw new Error('A biblioteca ExcelJS não foi carregada.');
            }
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(await fileData.arrayBuffer());
            const worksheet = workbook.worksheets[0];
            if (!worksheet) throw new Error('A planilha não contém abas.');
            const rows = [];
            worksheet.eachRow(row => {
                rows.push(row.values.map(value => {
                    if (value && typeof value === 'object') return value.text || value.result || '';
                    return value ?? '';
                }).slice(1));
            });
            const table = rows.map((row, rowIndex) =>
                `<tr>${row.map(value => `<${rowIndex === 0 ? 'th' : 'td'}>${escapeHtml(value)}</${rowIndex === 0 ? 'th' : 'td'}>`).join('')}</tr>`
            ).join('');
            if (viewerContent) {
                viewerContent.innerHTML = `<div class="table-responsive"><table>${table}</table></div>`;
            }

        } else if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp'].includes(documentType)) {
            viewerContent.innerHTML = `<div class="bse-viewer-image-container"><img src="${URL.createObjectURL(fileData)}" alt="${name}"></div>`;

        } else if (documentType === 'docx') {
            if (typeof mammoth === 'undefined') throw new Error('A biblioteca mammoth.js não foi carregada.');
            const arrayBuffer = await fileData.arrayBuffer();
            const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
            viewerContent.innerHTML = `<div class="docx-wrapper"><div class="docx">${result.value}</div></div>`;

        } else if (['pdf', 'txt'].includes(documentType)) {
            const fileUrl = URL.createObjectURL(fileData);
            viewerContent.innerHTML = `<iframe class="bse-viewer-iframe" src="${fileUrl}"></iframe>`;
        
        } else {
             viewerContent.innerHTML = `<div class="bse-empty-state"><p>O seu navegador iniciará o download ou abrirá o arquivo <strong>${name}</strong> em uma nova guia.</p></div>`;
             window.open(contentUrl, '_blank');
        }
    } catch (error) {
        console.error('Erro ao carregar documento:', error);
        if (viewerContent) {
            viewerContent.innerHTML = `<div class="bse-empty-state"><p>Falha ao carregar o documento.</p></div>`;
        }
    }
}
    closeDocumentViewer() {
        this.isViewingDocument = false;
        this.currentDocument = null;

        const mainView = document.querySelector('.bse-main-view');
        const documentViewer = document.getElementById('bseDocumentViewer');
        
        if (mainView) mainView.classList.remove('viewing');
        if (documentViewer) documentViewer.classList.add('bse-is-hidden');
    }
    
    getDocumentIcon(type) {
        const icons = { pdf: '<i class="fa-solid fa-file-pdf"></i>', docx: '<i class="fa-solid fa-file-word"></i>', pptx: '📊', txt: '📃', xlsx: '📈' };
        return icons[type] || '📎';
    }
    
    formatDate(dateString) {
        return new Date(dateString).toLocaleDateString('pt-BR');
    }
    
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

const secoesZabbix = ['dashboard-zabbix', 'zabbix-monitoramento', 'zabbix-relatorios', 'zabbix-hosts', 'zabbix-dados-recentes', 'zabbix-mapas'];
const secoesAcessoLivre = ['perfil', 'configuracoes', 'contatos', 'pop-info', 'ferramentas', 'zabbix', ...secoesZabbix];

function usuarioPodeAcessarSecao(sectionId) {
    if (currentUserProfile.role === 'admin') return true;
    if (!sectionId) return false;

    // Usuários logados têm acesso livre às sessões compartilhadas da topbar.
    if (secoesAcessoLivre.includes(sectionId)) return true;

    const permissoes = Array.isArray(currentUserProfile.permissions)
        ? currentUserProfile.permissions.filter(Boolean)
        : [];

    // Compatibilidade: usuários legados sem permissões no banco continuam acessando.
    if (permissoes.length === 0) return true;
    if (permissoes.includes(sectionId)) return true;

    // Permite ferramentas/dashboard para usuários que tenham a permissão do módulo ou a chave legacy.
    if (secoesZabbix.includes(sectionId)) {
        return permissoes.includes('dashboard-zabbix') || permissoes.includes('zabbix');
    }

    return false;
}

function applyUserPermissions() {
    if (currentUserProfile.role === 'admin') return;

    document.querySelectorAll('[data-permission-group="zabbix"]').forEach(group => {
        const hasVisibleSection = secoesZabbix.some(sectionId => usuarioPodeAcessarSecao(sectionId));
        group.style.display = hasVisibleSection ? '' : 'none';
    });

    document.querySelectorAll('[data-section]').forEach(link => {
        link.style.display = usuarioPodeAcessarSecao(link.dataset.section) ? '' : 'none';
    });
}

function getSidebarPreferenceKey() {
    const userKey = currentUserProfile.id || currentUserProfile.username || 'user';
    return `portal.sidebar.collapsed.${userKey}`;
}

function setSidebarCollapsed(collapsed, persist = true) {
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.getElementById('main-content');
    const menuButton = document.getElementById('menu-toggle');
    if (!sidebar) return;

    sidebar.classList.toggle('collapsed', collapsed);
    mainContent?.classList.toggle('expanded', !collapsed);
    menuButton?.setAttribute('aria-expanded', String(!collapsed));
    menuButton?.setAttribute('aria-label', collapsed ? 'Expandir barra lateral' : 'Recolher barra lateral');

    if (collapsed) {
                document.getElementById('zabbix-submenu')?.style.setProperty('display', 'none');
                document.getElementById('zabbix-submenu-toggle')?.setAttribute('aria-expanded', 'false');
                document.getElementById('zabbix-submenu-toggle')?.closest('.has-dropdown')?.classList.remove('open');
    }

    if (persist) {
        sessionStorage.setItem(getSidebarPreferenceKey(), String(collapsed));
    }
}

function restoreSidebarPreference() {
    const savedState = sessionStorage.getItem(getSidebarPreferenceKey());
    // O padrão para um usuário que ainda não escolheu é sidebar expandida.
    setSidebarCollapsed(savedState === 'true', false);
}

async function initializePage() {
    const isLoggedIn = await fetchUserProfile();
    if (isLoggedIn) {
        // 1. Carrega os componentes HTML primeiro.
        try {
            await Promise.all([
                loadComponent('/components/feed.html', 'feed-component-placeholder'),
                loadComponent('/components/admin-section.html', 'admin-component-placeholder'),
                loadComponent('/components/chamados.html', 'chamados-component-placeholder'),
                loadComponent('/components/contacts.html', 'contacts-component-placeholder'),
                loadComponent('/components/epbx.html', 'epbx-component-placeholder'),
                loadComponent('/components/agera-schedule.html', 'agera-schedule-component-placeholder'),
                loadComponent('/components/sag-schedule.html', 'sag-schedule-component-placeholder'),
                loadComponent('/components/welcome.html', 'welcome-component-placeholder'),
                loadComponent('/components/pop-info.html', 'pop-info-component-placeholder'),
                loadComponent('/components/knowledge-base.html', 'knowledge-base-component-placeholder'),
                loadComponent('/components/profile.html', 'profile-component-placeholder'),
                loadComponent('/components/dashboard-zabbix.html', 'dashboard-zabbix-component-placeholder'),
                loadComponent('/components/zabbix-hosts.html', 'zabbix-hosts-component-placeholder'),
                loadComponent('/components/settings.html', 'settings-component-placeholder'),
                loadComponent('/components/zabbix-placeholder-sections.html', 'zabbix-placeholder-sections-component-placeholder'),
                loadComponent('/components/zabbix-tools.html', 'zabbix-tools-component-placeholder'),
                loadComponent('/header.html', 'header-placeholder'),
                loadComponent('/sidebar.html', 'sidebar-placeholder'),
                loadComponent('/components/modals.html', 'modal-components-placeholder'),
                loadComponent('/components/personal-notes.html', 'personal-notes-component-placeholder')
            ]);
        } catch (error) {
            console.error("ERRO CRÍTICO: Falha ao carregar header ou sidebar.", error);
        }

        restoreSidebarPreference();

        setupAdminPanelTabs();
        applyUserPermissions();
        const adminMenuLink = document.getElementById('admin-menu-link');
        const adminSection = document.getElementById('admin-section');

        if (currentUserProfile.role === 'admin') {
            if (adminMenuLink) {
                adminMenuLink.style.display = 'list-item';
            }
            setupScheduleUpload();
            setupAddUserForm();
        } else {
            if (adminMenuLink) {
                adminMenuLink.style.display = 'none';
            }
            if (adminSection) {
                adminSection.style.display = 'none';
            }
        }
        // --- FIM DO BLOCO DE SEGURANÇA ---

        initializeProfileUI();
        window.personalNotesManager = new window.PersonalNotesManager();
        setupEventListeners();

        initializeTheme();
        setupThemeToggle();
        setupHomeDashboard();
        setupPriorityTicket();
        setupProfileEditing();
        setupPasswordChange();
        setupSearch('searchPOPS', '#popsGrid');
        setupSearch('searchChamados', '#chamadosGrid');
        setupSearch('searchContatos', '#contatosGrid');

        new EscalaAtendimento();
        window.ageraManager = new AgeraScheduleManager();
        window.zabbixDashboard = new ZabbixDashboard();
        window.baseConhecimento = new BaseConhecimento();
        window.gerenciadorContatos = new GerenciadorContatos();
        
        const requestedSection = decodeURIComponent(window.location.hash.slice(1));
        const savedSection = document.getElementById(`${requestedSection}-section`)
            && usuarioPodeAcessarSecao(requestedSection)
            ? requestedSection
            : 'boasvindas';
        showSection(savedSection, false);
        document.body.classList.add('body-loaded');

        // A navegação e os módulos independentes não devem esperar pelo banco/API.
        void fetchPosts();
        void initializeRecados();
        apiRequest('/api/posts')
            .then(updateWelcomeCardWithLatestPost)
            .catch(error => console.error('Falha ao carregar informativos da página inicial:', error));
        apiRequest('/api/schedules/sag')
            .then(initSagScheduleIfNeeded)
            .catch(error => {
                console.error('Falha ao carregar a escala SAG:', error);
                initSagScheduleIfNeeded([]);
            });
    }
}

function setupAdminPanelTabs() {
    const tabs = document.querySelectorAll('#admin-section [data-admin-tab]');
    if (tabs.length === 0) return;

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const targetPanelId = tab.dataset.adminTab;

            tabs.forEach((candidate) => {
                const isSelected = candidate === tab;
                candidate.classList.toggle('active', isSelected);
                candidate.setAttribute('aria-selected', String(isSelected));
            });

            document.querySelectorAll('#admin-section .admin-panel-tab-panel').forEach((panel) => {
                const isSelected = panel.id === targetPanelId;
                panel.hidden = !isSelected;
                panel.classList.toggle('active', isSelected);
            });
        });
    });
}

document.getElementById('btn-view-list')?.addEventListener('click', () => {
    if (currentViewMode === 'list') return; // Já está em lista, ignora
    
    currentViewMode = 'list';
    localStorage.setItem('zabbixViewMode', 'list');
    
    // Pega os dados da memória e manda desenhar a Lista instantaneamente
    if (problemasEmCache.length > 0) {
        renderCards(problemasEmCache); 
    }
});

// =============================================================================
// --- GESTÃO DE CONTATOS DINÂMICOS ---
// =============================================================================
class GerenciadorContatos {
    constructor() {
        this.contatos = [];
        this.init();
    }

    async init() {
        this.setupUI();
        await this.fetchContatos();
    }

    async fetchContatos() {
        try {
            this.contatos = await apiRequest('/api/contatos');
            this.renderContatos();
        } catch (error) {
            console.error("Falha ao carregar contatos", error);
            const grid = document.getElementById('contatosGrid');
            if(grid) grid.innerHTML = '<p style="text-align: center; color: var(--danger);">Falha ao carregar os contatos.</p>';
        }
    }

    setupUI() {
        const btnAdd = document.getElementById('btn-add-contato');
        const form = document.getElementById('form-contato');
        const btnCancel = document.getElementById('btn-cancel-contato');
        const inputTelefone = document.getElementById('contato-telefone'); // Pegamos o campo de telefone

        // Mostrar botão "Adicionar" apenas se for admin
        if (currentUserProfile && currentUserProfile.role === 'admin') {
            if (btnAdd) btnAdd.style.display = 'inline-flex';
        }
        if (btnAdd) btnAdd.addEventListener('click', () => this.openModal());
        if (btnCancel) btnCancel.addEventListener('click', () => this.closeModal());
        if (inputTelefone) {
            inputTelefone.addEventListener('input', function (e) {
                let x = e.target.value.replace(/\D/g, ''); 
                if (x.length > 11) x = x.slice(0, 11); 
                if (x.length > 10) {
                    e.target.value = x.replace(/^(\d{2})(\d{5})(\d{4}).*/, '($1) $2-$3');
                } else if (x.length > 5) {
                    e.target.value = x.replace(/^(\d{2})(\d{4})(\d{0,4}).*/, '($1) $2-$3');
                } else if (x.length > 2) {
                    e.target.value = x.replace(/^(\d{2})(\d{0,5})/, '($1) $2');
                } else if (x.length > 0) {
                    e.target.value = x.replace(/^(\d{0,2})/, '($1');
                }
            });
        }
        
        if (form) {
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.salvarContato();
            });
        }
    }

    renderContatos() {
        const grid = document.getElementById('contatosGrid');
        if (!grid) return;
        let isAdmin = false;
        if (typeof currentUserProfile !== 'undefined' && currentUserProfile.role === 'admin') {
            isAdmin = true;
        }
        if (this.contatos.length === 0) {
            grid.innerHTML = '<p style="text-align: center; grid-column: 1 / -1;">Nenhum contato cadastrado.</p>';
            return;
        }
        grid.innerHTML = this.contatos.map(c => `
            <div class="card card-hover" data-contato-id="${c.id}">
                <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--border);">
                    <h3 style="margin: 0; font-size: 1.1rem;"><i class="fa-solid fa-circle-user"></i> ${c.nome}</h3>
                    
                    ${isAdmin ? `
                    <div style="display: flex; gap: 10px;">
                        <button class="btn-edit-contato" data-id="${c.id}" title="Editar" style="cursor: pointer; background: transparent; border: none; font-size: 1.1rem; color: var(--primary); padding: 0;">
                            <i class="fa-solid fa-pen-to-square"></i>
                        </button>
                        <button class="btn-delete-contato" data-id="${c.id}" title="Excluir" style="cursor: pointer; background: transparent; border: none; font-size: 1.1rem; color: var(--danger); padding: 0;">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                    ` : ''}

                </div>
                <div class="card-content" style="padding-top: 12px;">
                    <p style="font-weight: 600; margin-bottom: 8px;">${c.setor}</p>
                    <span class="contact-phone" style="display: block; margin-bottom: 4px;"><i class="fa-solid fa-phone" style="font-size: 0.8em; margin-right: 4px;"></i> ${c.telefone}</span>
                    <a href="mailto:${c.email}" class="contact-link" style="display: block; word-break: break-all;"><i class="fa-solid fa-envelope" style="font-size: 0.8em; margin-right: 4px;"></i> ${c.email}</a>
                </div>
            </div>
        `).join('');

        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        if (isAdmin) {
            document.querySelectorAll('.btn-edit-contato').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const id = e.currentTarget.getAttribute('data-id');
                    this.openModal(id);
                });
            });
            document.querySelectorAll('.btn-delete-contato').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const id = e.currentTarget.getAttribute('data-id');
                    this.excluirContato(id);
                });
            });
        }
    }
    openModal(id = null) {
        const modal = document.getElementById('modal-contato');
        const title = document.getElementById('modal-contato-title');
        const form = document.getElementById('form-contato');
        
        form.reset();
        document.getElementById('contato-id').value = '';

        if (id) {
            title.textContent = 'Editar Contato';
            const contato = this.contatos.find(c => c.id == Number(id));
            if (contato) {
                document.getElementById('contato-id').value = contato.id;
                document.getElementById('contato-nome').value = contato.nome;
                document.getElementById('contato-setor').value = contato.setor;
                document.getElementById('contato-telefone').value = contato.telefone;
                document.getElementById('contato-email').value = contato.email;
            }
        } else {
            title.textContent = 'Adicionar Contato';
        }
        modal.classList.add('show');
    }
    closeModal() {
        document.getElementById('modal-contato').classList.remove('show');
    }
    async salvarContato() {
        const id = document.getElementById('contato-id').value;
        const payload = {
            nome: document.getElementById('contato-nome').value,
            setor: document.getElementById('contato-setor').value,
            telefone: document.getElementById('contato-telefone').value,
            email: document.getElementById('contato-email').value
        };
        try {
            if (id) {
                await apiRequest(`/api/contatos/${id}`, 'PUT', payload);
                showCustomAlert('Sucesso!', 'Contato atualizado com sucesso.');
            } else {
                await apiRequest('/api/contatos', 'POST', payload);
                showCustomAlert('Sucesso!', 'Contato adicionado com sucesso.');
            }
            this.closeModal();
            await this.fetchContatos();
        } catch (error) {
        }
    }

    async excluirContato(id) {
        const confirm = await showCustomConfirm(
            'Excluir Contato', 
            'Tem certeza que deseja excluir este contato? Esta ação não pode ser desfeita.'
        );

        if (confirm) {
            try {
                await apiRequest(`/api/contatos/${id}`, 'DELETE');
                await this.fetchContatos();
            } catch (error) {
            }
        }
    }
}


document.addEventListener('DOMContentLoaded', initializePage);

async function updateWelcomeCardWithLatestPost(homePosts = []) {
    renderHomeInformativos(homePosts.filter(post => post.is_home_pinned && getPostCategory(post) === 'Informativos'));
    await loadHomeInformativos();
}

function renderHomeInformativos(homePosts = []) {
    const container = document.getElementById('home-informatives-list');
    if (!container) return;
    container.replaceChildren();

    if (!homePosts.length) {
        const empty = document.createElement('div');
        empty.className = 'home-empty-state';
        empty.textContent = 'Nenhum informativo fixado no momento.';
        container.appendChild(empty);
        return;
    }

    homePosts.forEach(post => {
        const card = document.createElement('article');
        card.className = 'home-informative-card';
        const postLink = document.createElement('a');
        postLink.className = 'home-informative-link';
        postLink.href = '#feed';
        postLink.dataset.homePostLink = post.id;
        postLink.setAttribute('aria-label', 'Abrir este informativo no Feed');
        const header = document.createElement('div');
        header.className = 'home-informative-header';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'home-informative-title-wrap';
        const badge = document.createElement('span');
        badge.className = 'home-informative-badge';
        badge.textContent = 'Informativo';
        const title = document.createElement('h3');
        title.className = 'home-informative-title';
        const textContainer = document.createElement('div');
        textContainer.innerHTML = post.content || '';
        const plainText = (textContainer.textContent || '').replace(/\s+/g, ' ').trim();
        title.textContent = plainText.slice(0, 110) || 'Informativo da equipe';
        titleWrap.append(badge, title);
        header.appendChild(titleWrap);

        const content = document.createElement('p');
        content.className = 'home-informative-content';
        content.textContent = plainText.length > 110 ? `${plainText.slice(110, 340)}${plainText.length > 340 ? '…' : ''}` : '';

        postLink.append(header, content);

        const footer = document.createElement('div');
        footer.className = 'home-informative-footer';
        const meta = document.createElement('span');
        const date = new Date(post.created_at).toLocaleDateString('pt-BR');
        meta.textContent = `Publicado por: ${post.name || post.username || 'Equipe NOC'} · ${date}`;
        const actions = document.createElement('div');
        actions.className = 'home-informative-actions';
        const readButton = document.createElement('button');
        readButton.type = 'button';
        readButton.className = 'home-informative-read';
        readButton.dataset.homeAck = post.id;
        readButton.disabled = Boolean(post.acknowledged_by_me);
        readButton.textContent = post.acknowledged_by_me ? 'Ciente' : 'Marcar como lido';
        const count = document.createElement('span');
        count.className = 'home-informative-count';
        count.textContent = `${Number(post.acknowledgement_count) || 0} cientes`;
        actions.append(readButton, count);
        footer.append(meta, actions);
        card.append(postLink, footer);
        container.appendChild(card);
    });
}

async function loadHomeInformativos() {
    const container = document.getElementById('home-informatives-list');
    if (!container) return;
    try {
        const homePosts = await apiRequest('/api/home/informatives', 'GET', null, true);
        renderHomeInformativos(homePosts);
    } catch (error) {
        const empty = document.createElement('div');
        empty.className = 'home-empty-state';
        empty.textContent = 'Não foi possível carregar os informativos. Verifique a atualização do banco de dados.';
        container.replaceChildren(empty);
    }
}

function setupHomeDashboard() {
    const home = document.getElementById('boasvindas-section');
    if (!home) return;

    home.querySelectorAll('[data-home-section]').forEach(button => {
        button.addEventListener('click', () => showSection(button.dataset.homeSection));
    });

    const input = document.getElementById('home-search-input');
    const results = document.getElementById('home-search-results');
    let searchTimer;
    if (input && results) {
        const renderMessage = (message) => {
            const item = document.createElement('div');
            item.className = 'home-search-message';
            item.textContent = message;
            results.replaceChildren(item);
            results.hidden = false;
        };

        const renderSearchResults = (documents, contacts) => {
            results.replaceChildren();
            if (!documents.length && !contacts.length) {
                renderMessage('Nenhum resultado encontrado.');
                return;
            }
            documents.forEach(documentResult => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'home-search-result';
                button.dataset.searchDocument = documentResult.path;
                const icon = document.createElement('i');
                icon.dataset.lucide = 'file-text';
                const text = document.createElement('span');
                const name = document.createElement('strong');
                name.textContent = documentResult.name;
                const detail = document.createElement('small');
                detail.textContent = documentResult.snippet || documentResult.path;
                text.append(name, detail);
                button.append(icon, text);
                results.appendChild(button);
            });
            contacts.forEach(contact => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'home-search-result';
                button.dataset.searchContact = contact.nome;
                const icon = document.createElement('i');
                icon.dataset.lucide = 'user-round';
                const text = document.createElement('span');
                const name = document.createElement('strong');
                name.textContent = contact.nome;
                const detail = document.createElement('small');
                detail.textContent = [contact.setor, contact.telefone, contact.email].filter(Boolean).join(' · ');
                text.append(name, detail);
                button.append(icon, text);
                results.appendChild(button);
            });
            results.hidden = false;
            if (typeof lucide !== 'undefined') lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
        };

        input.addEventListener('input', () => {
            clearTimeout(searchTimer);
            const query = input.value.trim();
            if (query.length < 2) {
                results.hidden = true;
                results.replaceChildren();
                return;
            }
            renderMessage('Buscando na base de conhecimento e nos contatos...');
            searchTimer = setTimeout(async () => {
                try {
                    const [documents, allContacts] = await Promise.all([
                        apiRequest(`/api/bse/search?q=${encodeURIComponent(query)}`, 'GET', null, true),
                        apiRequest('/api/contatos', 'GET', null, true)
                    ]);
                    const normalizedQuery = normalizarTexto(query);
                    const contacts = allContacts.filter(contact =>
                        normalizarTexto([contact.nome, contact.setor, contact.telefone, contact.email].join(' ')).includes(normalizedQuery)
                    ).slice(0, 10);
                    renderSearchResults(documents, contacts);
                } catch (error) {
                    renderMessage('Busca indisponível no momento.');
                }
            }, 250);
        });

        input.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                results.hidden = true;
                input.blur();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                results.querySelector('.home-search-result')?.click();
            }
        });

        results.addEventListener('click', event => {
            const documentButton = event.target.closest('[data-search-document]');
            const contactButton = event.target.closest('[data-search-contact]');
            if (documentButton) {
                const documentPath = documentButton.dataset.searchDocument;
                const documentName = documentPath.split('/').pop();
                showSection('base-conhecimento');
                window.baseConhecimento?.openDocument(documentPath, documentName, '');
            } else if (contactButton) {
                showSection('contatos');
                const contactsSearch = document.getElementById('searchContatos');
                if (contactsSearch) {
                    contactsSearch.value = contactButton.dataset.searchContact;
                    contactsSearch.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            results.hidden = true;
        });

        document.addEventListener('click', event => {
            if (!event.target.closest('.home-search-section')) results.hidden = true;
        });
    }

    const informatives = document.getElementById('home-informatives-list');
    if (informatives && informatives.dataset.ready !== 'true') {
        informatives.dataset.ready = 'true';
        informatives.addEventListener('click', async event => {
            const informativeCard = event.target.closest('.home-informative-card');
            const postLink = event.target.closest('[data-home-post-link]');
            if (postLink || (informativeCard && !event.target.closest('button, a'))) {
                event.preventDefault();
                openFeedPost(postLink?.dataset.homePostLink || informativeCard.querySelector('[data-home-post-link]')?.dataset.homePostLink);
                return;
            }

            const button = event.target.closest('[data-home-ack]');
            if (!button || button.disabled) return;
            button.disabled = true;
            try {
                const result = await apiRequest(`/api/posts/${button.dataset.homeAck}/acknowledgements`, 'POST', {});
                button.textContent = 'Ciente';
                const card = button.closest('.home-informative-card');
                const count = card?.querySelector('.home-informative-count');
                if (count) count.textContent = `${result.count} cientes`;
            } catch (error) {
                button.disabled = false;
            }
        });
    }
}

function openFeedPost(postId) {
    activeFeedFilter = 'Todos';
    document.querySelectorAll('[data-feed-filter]').forEach(button => {
        const isActive = button.dataset.feedFilter === activeFeedFilter;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    });
    renderPosts();
    showSection('feed');
    const finishNavigation = () => {
        const postElement = document.querySelector(`#posts-container .post[data-post-id="${CSS.escape(String(postId))}"]`);
        if (!postElement) return false;
        postElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        postElement.classList.add('post-highlighted');
        window.setTimeout(() => postElement.classList.remove('post-highlighted'), 2200);
        return true;
    };

    if (!finishNavigation()) {
        void fetchPosts().then(() => {
            window.requestAnimationFrame(finishNavigation);
        });
    }
}

function setupZabbixMonitoringScreen() {
    const section = document.getElementById('zabbix-monitoramento-section');
    const form = document.getElementById('zmon-filter-form');
    const tableBody = document.getElementById('zmon-events-body');
    const status = document.getElementById('zmon-results-status');
    if (!section || !form || !tableBody || section.dataset.initialized === 'true') return;
    section.dataset.initialized = 'true';

    const severityNames = {
        0: 'Não classificada', 1: 'Informativo', 2: 'Baixo',
        3: 'Médio', 4: 'Alto', 5: 'Crítico'
    };
    const severityColors = {
        0: '#97a3ad', 1: '#4b9fc5', 2: '#749b39',
        3: '#d6a51d', 4: '#e97625', 5: '#cf3f3f'
    };
    let incidents = [];
    let confirmationFilter = 'all';
    let monitoringMode = 'recent';
    let tagLogic = 'and';
    let displayedTagCount = '3';
    let tagNameMode = 'full';
    let opdataMode = 'none';
    let inventoryFilters = [];

    const addCell = (row, value, className = '') => {
        const cell = document.createElement('td');
        if (className) cell.className = className;
        cell.textContent = value == null || value === '' ? '—' : String(value);
        row.appendChild(cell);
        return cell;
    };

    const formatDuration = clock => {
        const totalMinutes = Math.max(0, Math.floor((Date.now() / 1000 - Number(clock || 0)) / 60));
        const days = Math.floor(totalMinutes / 1440);
        const hours = Math.floor((totalMinutes % 1440) / 60);
        const minutes = totalMinutes % 60;
        return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
    };

    const selectedFilters = () => ({
        group: normalizarTexto(document.getElementById('zmon-host-group')?.value || ''),
        host: normalizarTexto(document.getElementById('zmon-host')?.value || ''),
        trigger: normalizarTexto(document.getElementById('zmon-trigger')?.value || ''),
        problem: normalizarTexto(document.getElementById('zmon-problem')?.value || ''),
        severities: Array.from(form.querySelectorAll('input[name="severity"]:checked')).map(input => input.value),
        tags: Array.from(form.querySelectorAll('.zmon-tag-filter-row')).map(row => ({
            name: normalizarTexto(row.querySelector('[data-tag-name]')?.value || ''),
            value: normalizarTexto(row.querySelector('[data-tag-value]')?.value || ''),
            operator: row.querySelector('[data-tag-operator]')?.value || 'contains'
        })).filter(tag => tag.name || tag.value),
        inventory: inventoryFilters.map(filter => ({ field: filter.field, value: normalizarTexto(filter.value) })).filter(filter => filter.field && filter.value),
        includeSuppressed: Boolean(document.getElementById('zmon-suppressed')?.checked),
        includeSymptoms: Boolean(document.getElementById('zmon-symptoms')?.checked)
    });

    const render = () => {
        const filters = selectedFilters();
        const showTimeline = Boolean(document.getElementById('zmon-show-timeline')?.checked);
        const timelineHeader = document.getElementById('zmon-timeline-header');
        if (timelineHeader) timelineHeader.hidden = !showTimeline;
        const matchingIncidents = incidents.filter(problem => {
            const tags = Array.isArray(problem.tags) ? problem.tags : [];
            const groupMatches = !filters.group || (problem.hostGroups || []).some(group => normalizarTexto(group).includes(filters.group));
            const hostMatches = !filters.host || normalizarTexto(problem.hostName || '').includes(filters.host);
            const triggerMatches = !filters.trigger || normalizarTexto(problem.name || '').includes(filters.trigger);
            const problemMatches = !filters.problem || normalizarTexto(`${problem.name || ''} ${problem.opdata || ''}`).includes(filters.problem);
            const severityMatches = filters.severities.includes(String(problem.severity));
            const tagMatches = !filters.tags.length || (tagLogic === 'and'
                ? filters.tags.every(filter => tags.some(tag => matchesTagFilter(tag, filter)))
                : filters.tags.some(filter => tags.some(tag => matchesTagFilter(tag, filter))));
            const inventoryMatches = !filters.inventory.length || filters.inventory.every(filter =>
                normalizarTexto(problem.hostInventory?.[filter.field] || '').includes(filter.value)
            );
            const suppressedMatches = filters.includeSuppressed || !(problem.suppressed && String(problem.suppressed) !== '0');
            const symptomsMatches = filters.includeSymptoms || !(Number(problem.cause_eventid) > 0);
            const isAcknowledged = Array.isArray(problem.acknowledges) && problem.acknowledges.length > 0;
            const acknowledgementMatches = confirmationFilter === 'all'
                || (confirmationFilter === 'acknowledged' && isAcknowledged)
                || (confirmationFilter === 'unacknowledged' && !isAcknowledged);
            return groupMatches && hostMatches && triggerMatches && problemMatches && severityMatches && tagMatches && inventoryMatches && suppressedMatches && symptomsMatches && acknowledgementMatches;
        });

        tableBody.replaceChildren();
        const selectAll = document.getElementById('zmon-select-all');
        if (selectAll) selectAll.checked = false;
        if (!matchingIncidents.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 12;
            cell.className = 'zmon-empty';
            cell.textContent = incidents.length ? 'Nenhum incidente corresponde aos filtros.' : 'Nenhum incidente encontrado no Zabbix.';
            row.appendChild(cell);
            tableBody.appendChild(row);
            if (status) status.textContent = incidents.length ? 'Ajuste os filtros para ampliar os resultados.' : 'Dados carregados da API do Zabbix.';
            return;
        }

        matchingIncidents.forEach(problem => {
            const row = document.createElement('tr');
            const selectCell = document.createElement('td');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.setAttribute('aria-label', `Selecionar ${problem.name || 'incidente'}`);
            selectCell.appendChild(checkbox);
            row.appendChild(selectCell);

            const eventDate = new Date(Number(problem.clock || 0) * 1000);
            addCell(row, Number.isNaN(eventDate.getTime()) ? '—' : eventDate.toLocaleString('pt-BR'));

            const severityCell = document.createElement('td');
            const severityBadge = document.createElement('span');
            severityBadge.className = 'zmon-severity-badge';
            severityBadge.style.backgroundColor = severityColors[problem.severity] || '#97a3ad';
            severityBadge.textContent = severityNames[problem.severity] || 'Desconhecida';
            severityCell.appendChild(severityBadge);
            row.appendChild(severityCell);

            const acknowledges = Array.isArray(problem.acknowledges) ? problem.acknowledges : [];
            const latestAcknowledge = acknowledges[acknowledges.length - 1];
            addCell(row, problem.recovery_clock ? new Date(Number(problem.recovery_clock) * 1000).toLocaleString('pt-BR') : '—');
            addCell(row, acknowledges.length ? 'Reconhecido' : 'Não reconhecido');
            addCell(row, opdataMode === 'separate' ? (problem.opdata || '—') : '—');
            addCell(row, problem.hostName || 'Host desconhecido');
            addCell(row, opdataMode === 'problem' && problem.opdata ? `${problem.name || '—'} — ${problem.opdata}` : (problem.name || '—'));
            addCell(row, formatDuration(problem.clock));
            const timelineCell = addCell(row, latestAcknowledge?.message || (problem.lastchange ? new Date(Number(problem.lastchange) * 1000).toLocaleString('pt-BR') : '—'));
            timelineCell.hidden = !showTimeline;

            const actionsCell = document.createElement('td');
            if (!acknowledges.length && window.zabbixDashboard?.promptAck) {
                const acknowledgeButton = document.createElement('button');
                acknowledgeButton.type = 'button';
                acknowledgeButton.className = 'zmon-ack-button';
                acknowledgeButton.textContent = 'Reconhecer';
                acknowledgeButton.addEventListener('click', () => {
                    window.zabbixDashboard.promptAck(problem.eventid, problem.hostName || 'Host desconhecido', problem.name || 'Incidente');
                });
                actionsCell.appendChild(acknowledgeButton);
            } else {
                actionsCell.textContent = acknowledges.length ? 'Atualizado' : '—';
            }
            row.appendChild(actionsCell);
            const tags = Array.isArray(problem.tags) ? problem.tags : [];
            const prioritizedTags = prioritizeTags(tags, document.getElementById('zmon-tag-priority')?.value || '');
            const visibleTags = displayedTagCount === 'all' ? prioritizedTags : prioritizedTags.slice(0, Number(displayedTagCount));
            const labelsCell = addCell(row, tagNameMode === 'none' || displayedTagCount === '0'
                ? ''
                : visibleTags.map(tag => tagNameMode === 'short' ? tag.value : `${tag.tag}: ${tag.value}`).join(' · '));
            if (document.getElementById('zmon-highlight-row')?.checked && Number(problem.severity) >= 4) {
                row.classList.add('zmon-highlighted-row');
            }
            if (document.getElementById('zmon-compact-view')?.checked) row.classList.add('zmon-compact-row');
            if (document.getElementById('zmon-show-details')?.checked) {
                const details = document.createElement('tr');
                details.className = 'zmon-details-row';
                const detailCell = document.createElement('td');
                detailCell.colSpan = 12;
                detailCell.textContent = `Host: ${problem.hostName || '—'} · IP: ${problem.hostIp || '—'} · Grupos: ${(problem.hostGroups || []).join(', ') || '—'} · Operacionais: ${problem.opdata || '—'}`;
                details.appendChild(detailCell);
                tableBody.append(row, details);
            } else {
                tableBody.appendChild(row);
            }
        });

        if (status) status.textContent = `${matchingIncidents.length} incidente(s) exibido(s) de ${incidents.length} recebido(s) do Zabbix.`;
    };

    const loadIncidents = async () => {
        const applyButton = form.querySelector('[type="submit"]');
        if (applyButton) applyButton.disabled = true;
        if (status) status.textContent = 'Consultando a API do Zabbix...';
        tableBody.innerHTML = '<tr><td colspan="12" class="zmon-empty">Carregando incidentes do Zabbix...</td></tr>';
        try {
            const filters = selectedFilters();
            const severityQuery = filters.severities.length ? filters.severities.join(',') : '0,1,2,3,4,5';
            if (monitoringMode === 'history') {
                const hours = document.getElementById('zmon-period-hours')?.value || '1';
                incidents = await apiRequest(`/api/zabbix/events/history?hours=${encodeURIComponent(hours)}&severities=${encodeURIComponent(severityQuery)}&suppressed=${filters.includeSuppressed}`, 'GET', null, true);
            } else {
                const recent = monitoringMode === 'recent';
                const hours = document.getElementById('zmon-period-hours')?.value || '1';
                incidents = await apiRequest(`/api/zabbix/problems?setor=Geral&recent=${recent}&hours=${encodeURIComponent(hours)}&severities=${encodeURIComponent(severityQuery)}&suppressed=${filters.includeSuppressed}&symptoms=${filters.includeSymptoms}`, 'GET', null, true);
            }
            if (!Array.isArray(incidents)) throw new Error('A API retornou um formato de incidentes inválido.');
            render();
        } catch (error) {
            tableBody.replaceChildren();
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 12;
            cell.className = 'zmon-empty';
            cell.textContent = `Falha ao carregar incidentes: ${error.message}`;
            row.appendChild(cell);
            tableBody.appendChild(row);
            if (status) status.textContent = 'Não foi possível consultar o Zabbix.';
        } finally {
            if (applyButton) applyButton.disabled = false;
        }
    };

    form.addEventListener('submit', event => {
        event.preventDefault();
        loadIncidents();
    });
    form.addEventListener('reset', () => {
        confirmationFilter = 'all';
        monitoringMode = 'recent';
        tagLogic = 'and';
        displayedTagCount = '3';
        tagNameMode = 'full';
        opdataMode = 'none';
        inventoryFilters = [];
        document.getElementById('zmon-tag-filters')?.replaceChildren();
        document.getElementById('zmon-extra-inventory-filters')?.replaceChildren();
        form.querySelectorAll('[data-monitor-mode]').forEach(button => {
            const selected = button.dataset.monitorMode === 'recent';
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', String(selected));
        });
        form.querySelectorAll('[data-ack-filter]').forEach(button => button.classList.toggle('active', button.dataset.ackFilter === 'all'));
        form.querySelectorAll('[data-tag-logic]').forEach(button => button.classList.toggle('active', button.dataset.tagLogic === 'and'));
        form.querySelectorAll('[data-tag-count]').forEach(button => button.classList.toggle('active', button.dataset.tagCount === '3'));
        form.querySelectorAll('[data-tag-name-mode]').forEach(button => button.classList.toggle('active', button.dataset.tagNameMode === 'full'));
        form.querySelectorAll('[data-opdata-mode]').forEach(button => button.classList.toggle('active', button.dataset.opdataMode === 'none'));
        setTimeout(loadIncidents, 0);
    });
    form.addEventListener('click', event => {
        const modeButton = event.target.closest('[data-monitor-mode]');
        if (modeButton) {
            monitoringMode = modeButton.dataset.monitorMode;
            form.querySelectorAll('[data-monitor-mode]').forEach(button => {
                const selected = button === modeButton;
                button.classList.toggle('active', selected);
                button.setAttribute('aria-selected', String(selected));
            });
            loadIncidents();
            return;
        }
        const ackButton = event.target.closest('[data-ack-filter]');
        if (ackButton) {
            confirmationFilter = ackButton.dataset.ackFilter;
            form.querySelectorAll('[data-ack-filter]').forEach(button => button.classList.toggle('active', button === ackButton));
            render();
            return;
        }
        const optionButton = event.target.closest('[data-tag-logic], [data-tag-count], [data-tag-name-mode], [data-opdata-mode]');
        if (optionButton) {
            const groupSelector = optionButton.dataset.tagLogic ? '[data-tag-logic]'
                : optionButton.dataset.tagCount ? '[data-tag-count]'
                : optionButton.dataset.tagNameMode ? '[data-tag-name-mode]' : '[data-opdata-mode]';
            optionButton.closest('.zmon-filter-grid').querySelectorAll(groupSelector).forEach(button => button.classList.toggle('active', button === optionButton));
            if (optionButton.dataset.tagLogic) tagLogic = optionButton.dataset.tagLogic;
            if (optionButton.dataset.tagCount != null) displayedTagCount = optionButton.dataset.tagCount;
            if (optionButton.dataset.tagNameMode) tagNameMode = optionButton.dataset.tagNameMode;
            if (optionButton.dataset.opdataMode) opdataMode = optionButton.dataset.opdataMode;
            render();
        }
    });

    const addTagFilter = () => {
        const list = document.getElementById('zmon-tag-filters');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'zmon-tag-inputs zmon-tag-filter-row';
        row.innerHTML = '<input class="zmon-input" data-tag-name type="text" placeholder="etiqueta"><select class="zmon-select" data-tag-operator><option value="contains">Contém</option><option value="equals">É igual</option><option value="not_equals">Não é igual</option></select><input class="zmon-input" data-tag-value type="text" placeholder="valor"><button type="button" class="zmon-text-button" data-remove-filter>Remover</button>';
        list.appendChild(row);
    };
    const addInventoryFilter = () => {
        const type = document.getElementById('zmon-inventory-type');
        const value = document.getElementById('zmon-inventory-value');
        if (!type?.value || !value?.value.trim()) return;
        inventoryFilters.push({ field: type.value, value: value.value.trim() });
        const list = document.getElementById('zmon-extra-inventory-filters');
        const chip = document.createElement('span');
        chip.className = 'zmon-inventory-chip';
        chip.dataset.inventoryIndex = String(inventoryFilters.length - 1);
        chip.textContent = `${type.options[type.selectedIndex].text}: ${value.value.trim()} `;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.removeInventory = String(inventoryFilters.length - 1);
        remove.setAttribute('aria-label', 'Remover filtro de inventário');
        remove.textContent = '×';
        chip.appendChild(remove);
        list.appendChild(chip);
        value.value = '';
        render();
    };
    const renderInventoryFilters = () => {
        const list = document.getElementById('zmon-extra-inventory-filters');
        if (!list) return;
        list.replaceChildren();
        inventoryFilters.forEach((filter, index) => {
            if (!filter.field || !filter.value) return;
            const chip = document.createElement('span');
            chip.className = 'zmon-inventory-chip';
            chip.dataset.inventoryIndex = String(index);
            const fieldLabel = document.querySelector(`#zmon-inventory-type option[value="${CSS.escape(filter.field)}"]`)?.textContent || filter.field;
            chip.append(document.createTextNode(`${fieldLabel}: ${filter.value} `));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.dataset.removeInventory = String(index);
            remove.setAttribute('aria-label', 'Remover filtro de inventário');
            remove.textContent = '×';
            chip.appendChild(remove);
            list.appendChild(chip);
        });
    };
    document.getElementById('zmon-add-tag')?.addEventListener('click', addTagFilter);
    document.getElementById('zmon-add-inventory')?.addEventListener('click', addInventoryFilter);
    document.getElementById('zmon-select-all')?.addEventListener('change', event => {
        tableBody.querySelectorAll('input[type="checkbox"]').forEach(checkbox => { checkbox.checked = event.target.checked; });
    });
    tableBody.addEventListener('change', event => {
        if (!event.target.matches('input[type="checkbox"]')) return;
        const rowCheckboxes = Array.from(tableBody.querySelectorAll('tr:not(.zmon-details-row) input[type="checkbox"]'));
        const selectAll = document.getElementById('zmon-select-all');
        if (selectAll) selectAll.checked = rowCheckboxes.length > 0 && rowCheckboxes.every(checkbox => checkbox.checked);
    });
    form.addEventListener('click', event => {
        const removeTag = event.target.closest('[data-remove-filter]');
        if (removeTag) {
            removeTag.closest('.zmon-tag-filter-row')?.remove();
            render();
        }
        const removeInventory = event.target.closest('[data-remove-inventory]');
        if (removeInventory) {
            const index = Number(removeInventory.dataset.removeInventory);
            inventoryFilters[index] = { field: '', value: '' };
            removeInventory.closest('.zmon-inventory-chip')?.remove();
            render();
        }
    });

    const filterToggle = document.getElementById('zmon-filter-toggle');
    filterToggle?.addEventListener('click', () => {
        const panel = form.querySelector('.zmon-filter-grid');
        const actions = form.querySelector('.zmon-filter-actions');
        const willHide = panel?.hidden !== true;
        if (panel) panel.hidden = willHide;
        if (actions) actions.hidden = willHide;
        filterToggle.setAttribute('aria-expanded', String(!willHide));
    });
    document.getElementById('zmon-refresh')?.addEventListener('click', loadIncidents);
    document.getElementById('zmon-period-hours')?.addEventListener('change', () => {
        loadIncidents();
    });
    form.addEventListener('input', event => {
        if (event.target.matches('#zmon-symptoms, #zmon-suppressed')) {
            loadIncidents();
            return;
        }
        if (event.target.matches('input[name="severity"], #zmon-highlight-row, #zmon-compact-view, #zmon-show-details, #zmon-show-timeline, #zmon-tag-priority, [data-tag-name], [data-tag-value], [data-tag-operator]')) render();
    });

    const saveFilterButton = document.getElementById('zmon-save-filter');
    saveFilterButton?.addEventListener('click', () => {
        const storageKey = `zabbix-monitoring-filters-${currentUserProfile.id || currentUserProfile.username || 'user'}`;
        let savedFilters = {};
        try { savedFilters = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (error) { savedFilters = {}; }
        const existingNames = Object.keys(savedFilters);
        const instruction = existingNames.length
            ? `Digite o nome de um filtro existente para carregar, ou um novo nome para salvar.\n\nSalvos: ${existingNames.join(', ')}`
            : 'Digite um nome para salvar este conjunto de filtros.';
        const filterName = window.prompt(instruction);
        if (!filterName?.trim()) return;
        const name = filterName.trim();
        if (Object.prototype.hasOwnProperty.call(savedFilters, name)) {
            const shouldLoad = window.confirm(`Carregar o filtro "${name}"?\n\nOK: carregar\nCancelar: substituir com a configuração atual`);
            if (shouldLoad) {
                applySavedFilter(savedFilters[name]);
                return;
            }
        }
        savedFilters[name] = {
            values: Object.fromEntries(Array.from(form.elements).filter(element => element.id && element.type !== 'button' && element.type !== 'submit' && element.type !== 'reset').map(element => [element.id, element.type === 'checkbox' ? element.checked : element.value])),
            severities: Array.from(form.querySelectorAll('input[name="severity"]')).filter(input => input.checked).map(input => input.value),
            tags: Array.from(form.querySelectorAll('.zmon-tag-filter-row')).map(row => ({
                name: row.querySelector('[data-tag-name]')?.value || '',
                value: row.querySelector('[data-tag-value]')?.value || '',
                operator: row.querySelector('[data-tag-operator]')?.value || 'contains'
            })),
            confirmationFilter, monitoringMode, tagLogic, displayedTagCount, tagNameMode, opdataMode, inventoryFilters
        };
        localStorage.setItem(storageKey, JSON.stringify(savedFilters));
        window.alert(`Filtro "${name}" salvo neste navegador.`);
    });

    function applySavedFilter(saved) {
        if (!saved) return;
        Object.entries(saved.values || {}).forEach(([id, value]) => {
            const control = document.getElementById(id);
            if (!control) return;
            if (control.type === 'checkbox') control.checked = Boolean(value);
            else control.value = value;
        });
        form.querySelectorAll('input[name="severity"]').forEach(input => { input.checked = (saved.severities || []).includes(input.value); });
        const tagList = document.getElementById('zmon-tag-filters');
        if (tagList) {
            tagList.replaceChildren();
            (saved.tags || []).forEach(tag => {
                const row = document.createElement('div');
                row.className = 'zmon-tag-inputs zmon-tag-filter-row';
                row.innerHTML = '<input class="zmon-input" data-tag-name type="text" placeholder="etiqueta"><select class="zmon-select" data-tag-operator><option value="contains">Contém</option><option value="equals">É igual</option><option value="not_equals">Não é igual</option></select><input class="zmon-input" data-tag-value type="text" placeholder="valor"><button type="button" class="zmon-text-button" data-remove-filter>Remover</button>';
                row.querySelector('[data-tag-name]').value = tag.name;
                row.querySelector('[data-tag-value]').value = tag.value;
                row.querySelector('[data-tag-operator]').value = tag.operator;
                tagList.appendChild(row);
            });
        }
        confirmationFilter = saved.confirmationFilter || 'all';
        monitoringMode = saved.monitoringMode || 'recent';
        tagLogic = saved.tagLogic || 'and';
        displayedTagCount = saved.displayedTagCount || '3';
        tagNameMode = saved.tagNameMode || 'full';
        opdataMode = saved.opdataMode || 'none';
        inventoryFilters = Array.isArray(saved.inventoryFilters) ? saved.inventoryFilters : [];
        renderInventoryFilters();
        form.querySelectorAll('[data-monitor-mode]').forEach(button => {
            const selected = button.dataset.monitorMode === monitoringMode;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', String(selected));
        });
        form.querySelectorAll('[data-ack-filter]').forEach(button => button.classList.toggle('active', button.dataset.ackFilter === confirmationFilter));
        form.querySelectorAll('[data-tag-logic]').forEach(button => button.classList.toggle('active', button.dataset.tagLogic === tagLogic));
        form.querySelectorAll('[data-tag-count]').forEach(button => button.classList.toggle('active', button.dataset.tagCount === displayedTagCount));
        form.querySelectorAll('[data-tag-name-mode]').forEach(button => button.classList.toggle('active', button.dataset.tagNameMode === tagNameMode));
        form.querySelectorAll('[data-opdata-mode]').forEach(button => button.classList.toggle('active', button.dataset.opdataMode === opdataMode));
        loadIncidents();
    }

    function matchesTagFilter(tag, filter) {
        const name = normalizarTexto(tag.tag || '');
        const value = normalizarTexto(tag.value || '');
        const nameMatches = !filter.name || name.includes(filter.name);
        const valueMatches = !filter.value || (filter.operator === 'equals' ? value === filter.value
            : filter.operator === 'not_equals' ? value !== filter.value : value.includes(filter.value));
        return nameMatches && valueMatches;
    }

    function prioritizeTags(tags, priorityText) {
        const priorities = priorityText.toLocaleLowerCase('pt-BR').split(/[,.\s]+/).filter(Boolean);
        return [...tags].sort((left, right) => {
            const leftIndex = priorities.indexOf((left.tag || '').toLocaleLowerCase('pt-BR'));
            const rightIndex = priorities.indexOf((right.tag || '').toLocaleLowerCase('pt-BR'));
            return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
        });
    }

    window.zabbixMonitoring = { refresh: loadIncidents };
    loadIncidents();
}

function setupZabbixReportsScreen() {
    const section = document.getElementById('zabbix-relatorios-section');
    const content = document.getElementById('zreports-content');
    const title = document.getElementById('zreports-panel-title');
    const status = document.getElementById('zreports-status');
    const periodControl = document.getElementById('zreports-period-control');
    const periodSelect = document.getElementById('zreports-period');
    if (!section || !content || section.dataset.initialized === 'true') return;
    section.dataset.initialized = 'true';

    const reports = {
        system: { title: 'Informação do sistema (Zabbix)', endpoint: '/api/zabbix/reports/system', columns: [['parameter', 'Parâmetro'], ['value', 'Valor'], ['details', 'Detalhes']] },
        scheduled: { title: 'Relatórios programados', endpoint: '/api/zabbix/reports/scheduled', columns: [['name', 'Nome'], ['description', 'Descrição'], ['cycle', 'Periodicidade'], ['start_time', 'Horário'], ['status', 'Status']] },
        availability: { title: 'Relatório de disponibilidade', endpoint: '/api/zabbix/reports/availability', columns: [['name', 'SLA'], ['status', 'Status'], ['sli', 'Disponibilidade'], ['effective_date', 'Início efetivo'], ['report_error', 'Observação']] },
        'top-triggers': { title: '100 principais gatilhos', endpoint: '/api/zabbix/reports/top-triggers', columns: [['priority', 'Prioridade'], ['description', 'Gatilho'], ['host', 'Host'], ['status', 'Status'], ['value', 'Condição'], ['lastchange', 'Última alteração']] },
        audit: { title: 'Log de auditoria', endpoint: '/api/zabbix/reports/audit', columns: [['clock', 'Data e hora'], ['username', 'Usuário'], ['action', 'Ação'], ['resourcetype', 'Tipo de recurso'], ['resourceid', 'ID do recurso'], ['ip', 'Endereço IP'], ['recordsetid', 'Detalhes']] },
        actions: { title: 'Log de ações', endpoint: '/api/zabbix/reports/actions', columns: [['clock', 'Data e hora'], ['name', 'Ação'], ['mediatype', 'Canal'], ['sendto', 'Destinatário'], ['subject', 'Assunto'], ['status', 'Status'], ['error', 'Erro']] },
        notifications: { title: 'Notificações', endpoint: '/api/zabbix/reports/notifications', columns: [['clock', 'Data e hora'], ['sendto', 'Destinatário'], ['subject', 'Assunto'], ['message', 'Mensagem'], ['status', 'Status'], ['error', 'Erro']] }
    };
    let activeReport = 'system';
    let currentRows = [];

    const valueFor = (row, key) => {
        let value = row?.[key];
        if (key === 'clock' && value) return new Date(Number(value) * 1000).toLocaleString('pt-BR');
        if (key === 'lastchange' && value) return new Date(Number(value) * 1000).toLocaleString('pt-BR');
        if (key === 'status') {
            if (String(value) === '0') return 'Ativo / Êxito';
            if (String(value) === '1') return 'Desabilitado / Falha';
        }
        if (key === 'value') {
            if (String(value) === '0') return 'Normal';
            if (String(value) === '1') return 'Problema';
        }
        if (key === 'priority') {
            return ({ 0: 'Não classificada', 1: 'Informativo', 2: 'Baixo', 3: 'Médio', 4: 'Alto', 5: 'Crítico' })[value] || value;
        }
        if (key === 'action') return ({ 0: 'Login', 1: 'Logout', 2: 'Adicionar', 3: 'Atualizar', 4: 'Excluir', 5: 'Falha de login' })[value] || value;
        if (key === 'resourcetype') return ({ 0: 'Usuário', 12: 'Host', 13: 'Item', 14: 'Trigger', 15: 'Gráfico', 16: 'Host group', 23: 'Ação' })[value] || value;
        if (key === 'host') return (row.hosts || []).map(host => host.name).join(', ') || value;
        if (key === 'mediatype') return row.mediatype?.name || value;
        if (key === 'sli') {
            if (typeof value === 'number' || typeof value === 'string') return `${value}%`;
            if (value && typeof value === 'object') return Object.entries(value).map(([name, sli]) => `${name}: ${sli}`).join(' · ');
        }
        if (value == null || value === '') return '—';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    };

    const renderTable = (report, rows) => {
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'zreports-empty';
            empty.textContent = 'Nenhum registro retornado para esta consulta.';
            content.replaceChildren(empty);
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'zreports-table-wrap';
        const table = document.createElement('table');
        table.className = 'zreports-table';
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        report.columns.forEach(([, label]) => {
            const th = document.createElement('th');
            th.textContent = label;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        const tbody = document.createElement('tbody');
        rows.forEach(row => {
            const tr = document.createElement('tr');
            report.columns.forEach(([key]) => {
                const td = document.createElement('td');
                td.textContent = valueFor(row, key);
                if (key === 'status' && String(row.status) === '0') {
                    const badge = document.createElement('span');
                    badge.className = 'zreports-status-badge';
                    badge.textContent = td.textContent;
                    td.replaceChildren(badge);
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.append(thead, tbody);
        wrap.appendChild(table);
        content.replaceChildren(wrap);
    };

    const loadReport = async () => {
        const report = reports[activeReport];
        if (!report) return;
        title.textContent = report.title;
        periodControl.hidden = !['availability', 'audit', 'actions', 'notifications'].includes(activeReport);
        content.innerHTML = '<div class="zreports-loading"><i class="fa-solid fa-spinner fa-spin"></i> Consultando a API do Zabbix...</div>';
        status.className = 'zreports-status';
        status.textContent = '';
        try {
            const query = periodControl.hidden ? '' : `?hours=${encodeURIComponent(periodSelect.value)}`;
            const rows = await apiRequest(`${report.endpoint}${query}`, 'GET', null, true);
            if (!Array.isArray(rows)) throw new Error('A API retornou um formato inesperado.');
            currentRows = rows;
            renderTable(report, rows);
            status.textContent = `${rows.length} registro(s) · atualizado ${new Date().toLocaleTimeString('pt-BR')}`;
        } catch (error) {
            currentRows = [];
            const message = document.createElement('div');
            message.className = 'zreports-empty';
            message.textContent = error.message;
            content.replaceChildren(message);
            status.className = 'zreports-status error';
            status.textContent = 'Confira a disponibilidade deste método na versão e nas permissões da API do Zabbix.';
        }
    };

    section.querySelectorAll('[data-report-tab]').forEach(button => {
        button.addEventListener('click', () => {
            activeReport = button.dataset.reportTab;
            section.querySelectorAll('[data-report-tab]').forEach(tab => {
                const selected = tab === button;
                tab.classList.toggle('active', selected);
                tab.setAttribute('aria-selected', String(selected));
            });
            loadReport();
        });
    });
    document.getElementById('zreports-refresh')?.addEventListener('click', loadReport);
    periodSelect?.addEventListener('change', loadReport);
    document.getElementById('zreports-export')?.addEventListener('click', () => {
        if (!currentRows.length) return;
        const report = reports[activeReport];
        const escapeCsv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const lines = [
            report.columns.map(([, label]) => escapeCsv(label)).join(','),
            ...currentRows.map(row => report.columns.map(([key]) => escapeCsv(valueFor(row, key))).join(','))
        ];
        const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `zabbix-${activeReport}-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    });

    loadReport();
}

function setupScheduleUpload() {
    const form = document.getElementById('schedule-upload-form');
    const statusDiv = document.getElementById('upload-status');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        statusDiv.textContent = 'Enviando...';
        statusDiv.className = '';
        const formData = new FormData(form);
        try {
            const response = await fetch('/api/admin/upload-sag-schedule', {
                method: 'POST', body: formData, credentials: 'include'
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message);
            statusDiv.textContent = result.message;
            statusDiv.classList.add('success');
            await showCustomAlert('Escala atualizada! A página será recarregada.');
            location.reload();
        } catch (error) {
            statusDiv.textContent = `Falha no upload: ${error.message}`;
            statusDiv.classList.add('error');
        }
    });
}
function initializeProfileUI() {
    // --- Dados Básicos ---
    const avatarUrl = currentUserProfile.avatar_url || "/imagens/logocircular.png";
    const displayName = currentUserProfile.name || currentUserProfile.username;

    // --- Atualiza o Header ---
    const headerAvatar = document.querySelector('.header-user .avatar-img');
    if (headerAvatar) headerAvatar.src = avatarUrl;
    const headerUserName = document.querySelector('.header-user #user-name');
    if (headerUserName) headerUserName.textContent = displayName;

    // --- Atualiza a Página de Perfil ---
    const profilePhoto = document.getElementById('profile-photo');
    if (profilePhoto) profilePhoto.src = avatarUrl;

    // Campos de exibição de texto
    const displayNameText = document.getElementById('display-name-text');
    if (displayNameText) displayNameText.textContent = displayName;

    const welcomeName = document.getElementById('welcome-name');
    if (welcomeName) welcomeName.textContent = displayName;
    
    // --- CORREÇÃO: Adiciona as linhas que faltavam ---
    const cargoDisplay = document.getElementById('user-cargo-display');
    if (cargoDisplay) cargoDisplay.textContent = currentUserProfile.cargo || 'Não informado';

    const jornadaDisplay = document.getElementById('user-jornada-display');
    if (jornadaDisplay) jornadaDisplay.textContent = currentUserProfile.jornada_trabalho || 'Não informada';
    
    const telefoneText = document.getElementById('user-telefone-text');
    if (telefoneText) telefoneText.textContent = currentUserProfile.telefone || 'Não informado';
    
    const emailDisplay = document.getElementById('user-email-display');
    if (emailDisplay) emailDisplay.textContent = currentUserProfile.email || 'Não informado';
    
    // Campos de input (para o modo de edição)
    const displayNameInput = document.getElementById('display-name-input');
    if (displayNameInput) displayNameInput.value = displayName;

    const telefoneInput = document.getElementById('user-telefone-input');
    if (telefoneInput) telefoneInput.value = currentUserProfile.telefone || '';
}

// =============================================================================
// --- 4. FUNÇÕES DO FEED (POSTS) ---
// Lógica para buscar, renderizar e gerenciar os posts.
// =============================================================================
async function fetchPosts() {
  try {
    posts = await apiRequest(`/api/posts?timestamp=${new Date().getTime()}`);
    renderPosts();
  } catch (error) {
    console.error("Falha ao buscar posts.");
  }
}

function renderPosts() {
  const postsContainer = document.getElementById('posts-container');
    if (!postsContainer) return;

    const visiblePosts = activeFeedFilter === 'Todos'
        ? posts
        : activeFeedFilter === 'Salvos'
            ? posts.filter(post => Boolean(post.is_saved_by_me))
            : posts.filter(post => getPostCategory(post) === activeFeedFilter);

    postsContainer.innerHTML = visiblePosts.length
        ? visiblePosts.map(renderPostMarkup).join('')
        : `<div class="empty-state"><i class="fa-${activeFeedFilter === 'Salvos' ? 'regular fa-bookmark' : 'regular fa-comments'}" aria-hidden="true"></i><p>${activeFeedFilter === 'Salvos' ? 'Você ainda não salvou nenhuma publicação.' : posts.length ? 'Nenhuma publicação nesta categoria.' : 'Nenhuma publicação ainda. Seja o primeiro a compartilhar!'}</p></div>`;
}

function getPostCategory(post) {
    const storedCategory = (post.title || '').trim();
    if (/^Pendências do turno\s*-\s*\d{2}\/\d{2}$/i.test(storedCategory)) return 'Pendências';
    return ['Pendências', 'Procedimentos', 'Alertas', 'Informativos'].includes(storedCategory)
        ? storedCategory
        : 'Outros';
}

function renderPostMarkup(post) {
  const canEditOrDelete = post.username === currentUserProfile.username;
    const category = getPostCategory(post);
    const authorName = escapeHtml(post.name || post.username || 'Usuário Desconhecido');
    const avatarUrl = escapeHtml(post.avatar_url || '/imagens/logocircular.png');
    const safeCategory = escapeHtml(category);
    const safePostId = escapeHtml(post.id);
    return `
        <article class="post" data-post-id="${safePostId}">
        <div class="post-header">
            <div class="post-details post-author">
                <img src="${avatarUrl}" alt="Avatar" class="avatar-img-post">
                <div class="author-details">
                    <div class="post-user">${authorName}</div>
                    <div class="post-date">${new Date(post.created_at).toLocaleString('pt-BR')}</div>
                </div>
            </div>
            <div class="post-header-actions">
                <span class="post-category-badge" data-category="${safeCategory}">${safeCategory}</span>
                ${canEditOrDelete ? `
                    <div class="post-actions-menu">
                        <button class="post-menu-btn" data-post-id="${post.id}" aria-label="Opções da publicação">⋮</button>
                        <div class="post-menu" id="menu-${post.id}">
                            <button onclick="startEditPost(${post.id})">Editar</button>
                            <button onclick="confirmDeletePost(${post.id})">Excluir</button>
                            ${category === 'Informativos' && (canEditOrDelete || currentUserProfile.role === 'admin') ? `<button type="button" data-home-pin="${post.id}" data-pinned="${Boolean(post.is_home_pinned)}">${post.is_home_pinned ? 'Desafixar da Início' : 'Fixar na Início'}</button>` : ''}
                        </div>
                    </div>` : ''}
            </div>
        </div>
    <div class="post-content" id="content-${post.id}">${post.content}</div>
        <footer class="feed-post-footer">
            <div class="feed-ack-control" role="group" aria-label="Confirmações de leitura">
                <button type="button" class="feed-post-action feed-acknowledge ${post.acknowledged_by_me ? 'is-acknowledged' : ''}" data-post-ack="${post.id}" aria-label="${post.acknowledged_by_me ? 'Você marcou como ciente' : 'Marcar como ciente'}" aria-pressed="${Boolean(post.acknowledged_by_me)}">
                    <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
                </button>
                <button type="button" class="feed-post-action feed-action-count" data-ack-users="${post.id}" data-ack-count="${post.id}" aria-label="Ver quem marcou como ciente" aria-expanded="false">${Number(post.acknowledgement_count) || 0}</button>
            </div>
            <button type="button" class="feed-post-action feed-comments-toggle" data-comments-toggle="${post.id}" aria-expanded="false">
                <i class="fa-regular fa-comment"></i> <span>Comentar</span>
                <span class="feed-action-count" data-comment-count="${post.id}">${Number(post.comment_count) || 0}</span>
            </button>
            <button type="button" class="feed-post-action feed-post-save ${post.is_saved_by_me ? 'is-saved' : ''}" data-post-save="${post.id}" aria-pressed="${Boolean(post.is_saved_by_me)}" aria-label="${post.is_saved_by_me ? 'Remover dos salvos' : 'Salvar publicação'}">
                <i class="fa-${post.is_saved_by_me ? 'solid' : 'regular'} fa-bookmark" aria-hidden="true"></i>
                <span>${post.is_saved_by_me ? 'Salvo' : 'Salvar'}</span>
            </button>
            <div class="feed-ack-users-popover" id="ack-users-${post.id}" hidden>
                <strong>Quem marcou como ciente</strong>
                <ul></ul>
            </div>
        </footer>
        <section class="feed-comments" id="comments-${post.id}" hidden>
            <div class="feed-comments-list" id="comments-list-${post.id}"></div>
            <form class="feed-comment-form" data-comment-form="${post.id}">
                <input class="form-input" name="comment" maxlength="2000" placeholder="Escreva um comentário..." required>
                <button type="submit" class="btn btn-primary" aria-label="Enviar comentário"><i class="fa-solid fa-paper-plane"></i></button>
            </form>
        </section>
    <div class="post-edit-form" id="edit-form-${post.id}" style="display: none;">
      <div id="edit-editor-${post.id}" style="height: 150px;"></div>
      <div class="post-edit-actions" style="margin-top: 10px;">
        <button class="btn btn-primary" onclick="saveEditPost(${post.id})">Salvar</button>
        <button class="btn btn-outline" onclick="cancelEditPost(${post.id})">Cancelar</button>
      </div>
    </div>
        </article>`;
}

function renderSinglePost(post, prepend = false) {
    const existingIndex = posts.findIndex(item => String(item.id) === String(post.id));
    if (existingIndex >= 0) {
        posts[existingIndex] = { ...posts[existingIndex], ...post };
    } else if (prepend) {
        posts.unshift(post);
    } else {
        posts.push(post);
    }
    renderPosts();
}

function appendPostComment(postId, comment) {
    const list = document.getElementById(`comments-list-${postId}`);
    if (!list) return;
    const item = document.createElement('article');
    item.className = 'feed-comment';
    item.dataset.commentId = comment.id;
    item.dataset.postId = postId;
    const avatar = document.createElement('img');
    avatar.className = 'feed-comment-avatar';
    avatar.src = comment.avatar_url || '/imagens/logocircular.png';
    avatar.alt = '';
    avatar.loading = 'lazy';
    const author = document.createElement('strong');
    author.textContent = comment.name || comment.username || 'Usuário';
    const date = document.createElement('time');
    date.dateTime = comment.created_at;
    date.textContent = new Date(comment.created_at).toLocaleString('pt-BR');
    const text = document.createElement('p');
    text.className = 'feed-comment-text';
    text.textContent = comment.comment;
    const header = document.createElement('div');
    header.className = 'feed-comment-header';
    header.append(avatar, author, date);
    const isOwnComment = (comment.user_id != null && String(comment.user_id) === String(currentUserProfile.id))
        || (comment.username && comment.username === currentUserProfile.username);
    if (isOwnComment) {
        const actions = document.createElement('div');
        actions.className = 'feed-comment-actions';
        const menuButton = document.createElement('button');
        menuButton.type = 'button';
        menuButton.className = 'feed-comment-menu-toggle';
        menuButton.dataset.commentMenuToggle = comment.id;
        menuButton.setAttribute('aria-label', 'Opções do comentário');
        menuButton.setAttribute('aria-expanded', 'false');
        menuButton.textContent = '⋮';
        const menu = document.createElement('div');
        menu.className = 'feed-comment-menu';
        menu.dataset.commentMenu = comment.id;
        menu.innerHTML = `<button type="button" data-edit-comment="${comment.id}" data-post-id="${postId}">Editar</button><button type="button" data-delete-comment="${comment.id}" data-post-id="${postId}">Excluir</button>`;
        actions.append(menuButton, menu);
        header.appendChild(actions);
    }
    item.append(header, text);
    list.appendChild(item);
}

function beginCommentEdit(postId, commentId) {
    const item = document.querySelector(`.feed-comment[data-post-id="${postId}"][data-comment-id="${commentId}"]`);
    if (!item || item.querySelector('.feed-comment-edit-form')) return;
    const currentText = item.querySelector('.feed-comment-text')?.textContent || '';
    const form = document.createElement('form');
    form.className = 'feed-comment-edit-form';
    const textarea = document.createElement('textarea');
    textarea.className = 'form-input';
    textarea.name = 'comment';
    textarea.maxLength = 2000;
    textarea.required = true;
    textarea.value = currentText;
    const actions = document.createElement('div');
    actions.className = 'feed-comment-edit-actions';
    actions.innerHTML = '<button type="submit" class="btn btn-primary">Salvar</button><button type="button" class="btn btn-outline" data-cancel-comment-edit>Cancelar</button>';
    form.append(textarea, actions);
    item.querySelector('.feed-comment-text')?.replaceWith(form);
    textarea.focus();

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const updatedText = textarea.value.trim();
        if (!updatedText) return;
        try {
            const result = await apiRequest(`/api/posts/${postId}/comments/${commentId}`, 'PUT', { comment: updatedText });
            const paragraph = document.createElement('p');
            paragraph.className = 'feed-comment-text';
            paragraph.textContent = result.comment;
            form.replaceWith(paragraph);
        } catch (error) {
            console.error('Erro ao editar comentário:', error);
        }
    });
    actions.querySelector('[data-cancel-comment-edit]').addEventListener('click', () => {
        const paragraph = document.createElement('p');
        paragraph.className = 'feed-comment-text';
        paragraph.textContent = currentText;
        form.replaceWith(paragraph);
    });
}

async function deleteOwnComment(postId, commentId) {
    const confirmed = await showCustomConfirm('Excluir comentário', 'Deseja excluir seu comentário? Esta ação não pode ser desfeita.', 'Excluir', 'Cancelar');
    if (!confirmed) return;
    try {
        const result = await apiRequest(`/api/posts/${postId}/comments/${commentId}`, 'DELETE');
        document.querySelector(`.feed-comment[data-post-id="${postId}"][data-comment-id="${commentId}"]`)?.remove();
        const counter = document.querySelector(`[data-comment-count="${postId}"]`);
        if (counter) counter.textContent = result.comment_count;
        const post = posts.find(item => String(item.id) === String(postId));
        if (post) post.comment_count = result.comment_count;
    } catch (error) {
        console.error('Erro ao excluir comentário:', error);
        await showCustomAlert('Não foi possível excluir o comentário', error.message || 'Verifique se o backend atualizado está ativo.');
    }
}

async function loadPostComments(postId) {
    const list = document.getElementById(`comments-list-${postId}`);
    if (!list || list.dataset.loaded === 'true' || list.dataset.loaded === 'loading') return;
    list.dataset.loaded = 'loading';
    try {
        const comments = await apiRequest(`/api/posts/${postId}/comments`);
        list.replaceChildren();
        comments.forEach(comment => appendPostComment(postId, comment));
        list.dataset.loaded = 'true';
    } catch (error) {
        list.dataset.loaded = 'false';
    }
}

async function loadAcknowledgementUsers(postId) {
    const popover = document.getElementById(`ack-users-${postId}`);
    const list = popover?.querySelector('ul');
    if (!popover || !list || list.dataset.loaded === 'true' || list.dataset.loaded === 'loading') return;
    list.dataset.loaded = 'loading';
    list.replaceChildren();
    const loading = document.createElement('li');
    loading.textContent = 'Carregando...';
    list.appendChild(loading);
    try {
        const users = await apiRequest(`/api/posts/${postId}/acknowledgements`);
        list.replaceChildren();
        if (users.length === 0) {
            const empty = document.createElement('li');
            empty.textContent = 'Ainda ninguém marcou como ciente.';
            list.appendChild(empty);
        } else {
            users.forEach(user => {
                const item = document.createElement('li');
                item.textContent = user.name || user.username || 'Usuário';
                list.appendChild(item);
            });
        }
        list.dataset.loaded = 'true';
    } catch (error) {
        list.replaceChildren();
        const message = document.createElement('li');
        message.textContent = 'Não foi possível carregar a lista.';
        list.appendChild(message);
        list.dataset.loaded = 'false';
    }
}

function startEditPost(postId) {
  console.log(`1. Função startEditPost chamada para o post ID: ${postId}`);
  const post = posts.find(p => p.id == postId);

  if (!post) {
    console.error(`2. ERRO: Post com ID ${postId} não foi encontrado no array 'posts'. A função vai parar aqui.`);
    console.log("Conteúdo atual do array 'posts':", posts);
    return;
  }
  console.log("2. Post encontrado com sucesso:", post);

  const contentDiv = document.getElementById(`content-${postId}`);
  const formDiv = document.getElementById(`edit-form-${postId}`);
  const menuDiv = document.getElementById(`menu-${postId}`);
  console.log("3. Tentando alterar a visibilidade dos elementos no HTML...");

  if (contentDiv && formDiv && menuDiv) {
    contentDiv.style.display = 'none';
    formDiv.style.display = 'block';
    menuDiv.classList.remove('show');
    console.log("4. Visibilidade alterada com sucesso.");
  } else {
    console.error("ERRO: Um ou mais elementos do post (content, form, menu) não foram encontrados no HTML.");
    return;
  }

  console.log("5. Tentando inicializar o editor de texto Quill...");
  try {
    if (!editQuillInstances[postId]) {
            editQuillInstances[postId] = new Quill(`#edit-editor-${postId}`, {
                modules: {
                    toolbar: [
                        ['bold', 'italic', 'underline'],
                        [{ 'list': 'ordered'}, { 'list': 'bullet' }]
                    ]
                },
                theme: 'snow'
            });
        }
            const quill = editQuillInstances[postId];
    quill.root.innerHTML = post.content;
    quill.focus();
    editQuillInstances[postId].focus();
    console.log("6. Editor Quill inicializado e focado com sucesso!");
  } catch (error) {
    console.error("ERRO GRAVE ao inicializar o Quill:", error);
  }
}

async function saveProfileChanges() {
    const newName = document.getElementById('display-name-input').value.trim();
    const newTelefone = document.getElementById('user-telefone-input').value.trim();
    const currentUsername = currentUserProfile.username;

    if (!newName) {
        return showCustomAlert('O nome de exibição não pode ficar em branco.');
    }

    try {
        await apiRequest('/api/profile/update', 'PUT', {
            name: newName,
            username: currentUsername,
            telefone: newTelefone
        });

        // Atualiza os dados no frontend
        currentUserProfile.name = newName;
        currentUserProfile.telefone = newTelefone;
        
        document.getElementById('display-name-text').textContent = newName;
        document.getElementById('user-telefone-text').textContent = newTelefone;

        // Esconde os campos de edição e mostra os de exibição
        toggleProfileEdit(false);
        
        // Exibe uma mensagem de sucesso
        showCustomAlert('Sucesso!', 'Seu perfil foi atualizado.');

    } catch (error) {
        showCustomAlert('Erro', 'Não foi possível atualizar o perfil');
    }
}

async function saveEditPost(postId) {
  const editor = editQuillInstances[postId];
  if (!editor) return;

  const newContent = editor.root.innerHTML;
  if (editor.getLength() <= 1 || newContent === "<p><br></p>") {
     showCustomAlert('O conteúdo do post não pode estar vazio.');
    return;
  }

  try {
    const updatedPost = await apiRequest(`/api/posts/${postId}`, 'PUT', { content: newContent });
    const postIndex = posts.findIndex(p => p.id == postId);
    if (postIndex !== -1) { posts[postIndex].content = updatedPost.content; }

    const postContentDiv = document.getElementById(`content-${postId}`);
    if (postContentDiv) { postContentDiv.innerHTML = updatedPost.content; }

     cancelEditPost(postId);
  } catch (error) {
    showCustomAlert('Erro', 'Não foi possível atualizar o post');
  }
}

function cancelEditPost(postId) {
  const contentEl = document.getElementById(`content-${postId}`);
  const formEl = document.getElementById(`edit-form-${postId}`);
  if (contentEl) contentEl.style.display = 'block';
  if (formEl) formEl.style.display = 'none';
  if (editQuillInstances[postId]) { delete editQuillInstances[postId]; }
}

function confirmDeletePost(postId) {
  postToDelete = postId;
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.add('show');
}

async function deletePost() {
  if (!postToDelete) return;

  try {
    await apiRequest(`/api/posts/${postToDelete}`, 'DELETE');
    posts = posts.filter(p => p.id != postToDelete);
    renderPosts();

    postToDelete = null;
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.remove('show');
  } catch (error) {
    alert('Não foi possível excluir o post.');
    console.error("Falha ao excluir post:", error);
  }
}

async function initializeRecados() {
  const form = document.getElementById('recado-form');
  const input = document.getElementById('recado-input');
  const container = document.getElementById('recados-list-container');
  if (!form || !input || !container) return;

  const renderRecado = (recado) => {
        container.prepend(createRecadoElement(recado));
  };

  const fetchAndRenderRecados = async () => {
    try {
      const recados = await apiRequest('/api/recados');
      container.innerHTML = '';
      if (recados.length > 0) { recados.forEach(renderRecado); }
    } catch (error) {
      console.error("Não foi possível carregar os recados.", error);
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    try {
      await apiRequest('/api/recados', 'POST', { message });
      input.value = '';
    } catch (error) {
      alert('Não foi possível publicar o recado.');
    }
  });

container.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.recado-delete-btn');
    if (deleteBtn) {
        const recadoId = deleteBtn.dataset.recadoId;
        const userConfirmed = await showCustomConfirm(
            'Excluir Recado', 
            'Tem certeza que deseja excluir este recado? Esta ação não pode ser desfeita.'
        );

        if (userConfirmed) {
            try {
                await apiRequest(`/api/recados/${recadoId}`, 'DELETE');
            } catch (error) {
            }
        }
    }
});

  await fetchAndRenderRecados();
}

function renderSingleRecado(recado) {
  const container = document.getElementById('recados-list-container');
  if (!container) return;

    container.prepend(createRecadoElement(recado));
}

function createRecadoElement(recado) {
  const date = new Date(recado.created_at).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const recadoDiv = document.createElement('div');
  recadoDiv.className = 'recado-item';
  recadoDiv.dataset.recadoId = recado.id;
    const header = document.createElement('div');
    header.className = 'recado-header';
    const avatar = document.createElement('img');
    avatar.className = 'recado-author-avatar';
    avatar.src = recado.avatar_url || '/imagens/logocircular.png';
    avatar.alt = '';
    avatar.loading = 'lazy';
    const authorDate = document.createElement('div');
    authorDate.className = 'recado-author-date';
    const author = document.createElement('span');
    author.className = 'recado-author';
    author.textContent = recado.author_name || 'Usuário';
    const dateElement = document.createElement('span');
    dateElement.className = 'recado-date';
    dateElement.textContent = date;
    authorDate.append(author, dateElement);
    header.append(avatar, authorDate);
    if (currentUserProfile.role === 'admin') {
        const deleteButton = document.createElement('button');
        deleteButton.className = 'recado-delete-btn';
        deleteButton.dataset.recadoId = recado.id;
        deleteButton.title = 'Excluir recado';
        deleteButton.setAttribute('aria-label', 'Excluir recado');
        deleteButton.textContent = '×';
        header.appendChild(deleteButton);
    }
    const message = document.createElement('p');
    message.className = 'recado-message';
    message.textContent = recado.message;
    recadoDiv.append(header, message);
    return recadoDiv;
}

// =============================================================================
// --- 5. FUNÇÕES DE PERFIL E CONFIGURAÇÕES ---
// Lógica para gerenciar perfil de usuário, senha e tema.
// =============================================================================
async function initializeProfile() {
    try {
        const response = await fetch('/api/profile', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include', 
        });

        if (!response.ok) {
            window.location.href = 'login.html';
            return;
        }

        currentUserProfile = await response.json();
        const avatarKey = `avatar_${currentUserProfile.username}`;
        const savedAvatarUrl = localStorage.getItem(avatarKey);
        const defaultAvatarSvg = "data:image/svg+xml,...";
        const avatarUrl = savedAvatarUrl || currentUserProfile.avatar_url || defaultAvatarSvg;
        const displayName = currentUserProfile.name || currentUserProfile.username;
        const headerAvatar = document.querySelector('.header-user .avatar-img');
        if (headerAvatar) headerAvatar.src = avatarUrl;

        const headerUserName = document.querySelector('.header-user #user-name');
        if (headerUserName) headerUserName.textContent = displayName;
        
        const welcomeUserName = document.getElementById('welcome-user-greeting');
        if (welcomeUserName) {
            welcomeUserName.textContent = `Olá, ${displayName.split(' ')[0]}!`;
        }

        const profilePhoto = document.getElementById('profile-photo');
        if (profilePhoto) profilePhoto.src = avatarUrl;

        const displayNameInput = document.getElementById('display-name');
        if (displayNameInput) displayNameInput.value = displayName;

    } catch (error) {
        console.error('Falha ao inicializar o perfil. Redirecionando para o login.', error);
        window.location.href = 'login.html';
    }
}


function setupPasswordChange() {
  const passwordForm = document.getElementById('password-form');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('current-password').value;
      const newPassword = document.getElementById('new-password').value;
      const confirmPassword = document.getElementById('confirm-password').value;
      if (newPassword.length < 6) {
        await showCustomAlert('A nova senha deve ter pelo menos 6 caracteres.', response.message);
        return;
      }
      if (newPassword !== confirmPassword) {
        await showCustomAlert('As senhas não coincidem.', response.message);
        return;
      }
      try {
        const response = await apiRequest('/api/password/change', 'PUT', { currentPassword, newPassword });
        await showCustomAlert('Sucesso!', response.message);
        passwordForm.reset();
      } catch (error) { }
    });
  }
}

function updateThemeToggle(theme) {
  const themeOptions = document.querySelectorAll('.theme-option');
  if (themeOptions) {
    themeOptions.forEach(option => {
      option.classList.remove('active');
      if (option.getAttribute('data-theme') === theme) {
        option.classList.add('active');
      }
    });
  }
}

function initializeTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeToggle(savedTheme);
}

function setupThemeToggle() {
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', (e) => {
      const themeOption = e.target.closest('.theme-option');
      if (themeOption) {
        const theme = themeOption.getAttribute('data-theme');
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        updateThemeToggle(theme);
      }
    });
  }
}
async function setupProfileEditing() {
    // --- Seletores dos Elementos ---
    const displayNameText = document.getElementById('display-name-text');
    const telefoneText = document.getElementById('user-telefone-text');
    const displayNameInput = document.getElementById('display-name-input');
    const telefoneInput = document.getElementById('user-telefone-input');
    const avatarControls = document.getElementById('avatar-controls');
    const actionsContainer = document.getElementById('profile-actions-container');
    const editBtn = document.getElementById('profile-edit-btn');
    const saveBtn = document.getElementById('profile-save-btn');
    const cancelBtn = document.getElementById('profile-cancel-btn');
    const avatarForm = document.getElementById('avatar-form');
    const elements = [displayNameText, telefoneText, displayNameInput, telefoneInput, avatarControls, actionsContainer, editBtn, saveBtn, cancelBtn, avatarForm];
    if (elements.some(el => !el)) {
        console.error("ERRO: Um ou mais elementos essenciais para a edição do perfil não foram encontrados no HTML. Verifique os IDs.");
        return;
    }

    // --- Funções de Controle de UI ---
    const toggleEditMode = (isEditing) => {
        // Esconde os textos de visualização, mostra os inputs de edição
        displayNameText.style.display = isEditing ? 'none' : 'block';
        displayNameInput.style.display = isEditing ? 'block' : 'none';
        
        telefoneText.style.display = isEditing ? 'none' : 'block';
        telefoneInput.style.display = isEditing ? 'block' : 'none';

        // Mostra/esconde os controles de edição (botões de foto, salvar/cancelar)
        avatarControls.style.display = isEditing ? 'flex' : 'none';
        actionsContainer.style.display = isEditing ? 'flex' : 'none';

        // Alterna a visibilidade do botão principal de "Editar"
        editBtn.style.display = isEditing ? 'none' : 'block';
    };

    // --- Event Listeners (Ouvintes de Eventos) ---
    editBtn.addEventListener('click', async () => {
        displayNameInput.value = displayNameText.textContent;
        telefoneInput.value = (telefoneText.textContent === 'Não informado' ? '' : telefoneText.textContent);
        toggleEditMode(true);
    });

    cancelBtn.addEventListener('click', async () => {
        avatarForm.reset(); 
        toggleEditMode(false);
    });

    saveBtn.addEventListener('click', async () => {
        const newName = displayNameInput.value.trim();
        const newTelefone = telefoneInput.value.trim();
        
        if (!newName) return await showCustomAlert('O nome de exibição não pode ficar em branco.');

        try {
            await apiRequest('/api/profile/update', 'PUT', { 
                name: newName, 
                username: currentUserProfile.username,
                telefone: newTelefone
            });
            currentUserProfile.name = newName;
            currentUserProfile.telefone = newTelefone;
            const fileInput = document.getElementById('avatar-input');
            if (fileInput.files.length > 0) {
                const formData = new FormData(avatarForm);
                const result = await apiRequest('/api/profile/avatar', 'POST', formData);
                currentUserProfile.avatar_url = result.avatar_url;
            }

            await showCustomAlert('Perfil atualizado com sucesso!');
            initializeProfileUI();
            toggleEditMode(false);

        } catch (error) {
            console.error('Falha ao salvar o perfil:', error);
        }
    });
}

// --- 6. FUNÇÕES DA ESCALA DE ATENDIMENTO (APENAS EPBX AGORA) ---
class EscalaAtendimento {
  constructor() {
        this.schedule = [];
        this.config = null;
        this.adminStatus = document.getElementById('epbx-admin-status');
        this.init();
    }

    async init() {
        await this.refreshPublicSchedule();
        if (currentUserProfile.role === 'admin' && document.getElementById('epbx-settings-form')) {
            await this.loadAdminConfig();
            this.bindAdminForms();
        }
        this.clockInterval = setInterval(() => this.refreshPublicSchedule(), 60000);
    }

    async refreshPublicSchedule() {
        try {
            const data = await apiRequest('/api/schedules/epbx', 'GET', null, true);
            this.schedule = Array.isArray(data.schedule) ? data.schedule : [];
            this.renderPublicSchedule(data.currentShift, data.todayAssignment, data.roster || []);
        } catch (error) {
            console.error('Falha ao carregar a escala EPBX:', error);
            const name = document.getElementById('epbx-current-name');
            const table = document.getElementById('epbx-schedule');
            if (name) name.textContent = 'Escala indisponível';
            if (table) table.innerHTML = '<div class="table-row"><span class="table-cell">Não foi possível carregar a escala.</span></div>';
        }
    }

    renderPublicSchedule(currentShift, todayAssignment, roster) {
        const now = new Date();
          const displayedShift = currentShift || todayAssignment;
        const name = document.getElementById('epbx-current-name');
        const phone = document.getElementById('epbx-current-phone');
        const status = document.getElementById('epbx-current-status');
        const date = document.getElementById('epbx-current-date');
        const day = document.getElementById('epbx-current-day');
        const shift = document.getElementById('epbx-current-shift');

        if (name) name.textContent = displayedShift?.name || 'Sem plantonista escalado';
        if (phone) phone.textContent = displayedShift?.phone || '—';
        if (status) status.innerHTML = currentShift
            ? '<span class="status-badge on-duty">Em Plantão</span>'
            : displayedShift
                ? '<span class="status-badge off-duty">Fora do horário de plantão</span>'
                : '<span class="status-badge ausente">Sem cobertura</span>';
        if (date) date.textContent = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        if (day) day.textContent = now.toLocaleDateString('pt-BR', { weekday: 'long' }).replace(/^./, char => char.toUpperCase());
        if (shift) shift.textContent = displayedShift
            ? `${displayedShift.type} (${displayedShift.start}–${displayedShift.end})`
            : 'Sem plantão definido';
        if (shift && todayAssignment?.isHoliday) shift.textContent += ` · ${todayAssignment.holidayName || 'Feriado'}`;

        const table = document.getElementById('epbx-schedule');
        if (!table) return;
        table.replaceChildren();
        if (!roster.length) {
            const empty = document.createElement('div');
            empty.className = 'table-row';
            empty.textContent = 'Nenhum plantonista ativo cadastrado.';
            table.appendChild(empty);
            return;
        }

        roster.forEach(member => {
            const row = document.createElement('div');
            row.className = 'table-row';
            const nameCell = document.createElement('span');
            nameCell.className = 'table-cell';
            nameCell.textContent = member.name;
            const shiftCell = document.createElement('span');
            shiftCell.className = 'table-cell';
            const currentAssignment = member.id === currentShift?.memberId;
            shiftCell.textContent = `${todayAssignment?.type || 'Escala'} (${todayAssignment?.start || '—'}–${todayAssignment?.end || '—'})`;
            const daysCell = document.createElement('span');
            daysCell.className = 'table-cell epbx-roster-days';
            daysCell.textContent = 'Diário';
            const phoneCell = document.createElement('span');
            phoneCell.className = 'table-cell';
            phoneCell.textContent = member.phone || '—';
            const emailCell = document.createElement('span');
            emailCell.className = 'table-cell';
            emailCell.textContent = member.email || '—';
            const stateCell = document.createElement('span');
            stateCell.className = 'table-cell';
            const badge = document.createElement('span');
            badge.className = `status-badge ${currentAssignment ? 'on-duty' : member.isAbsentToday ? 'ausente' : 'off-duty'}`;
            badge.textContent = currentAssignment ? 'Em plantão agora'
                : member.isScheduledToday ? 'Escalado hoje'
                    : member.isAbsentToday ? 'Ausente hoje' : 'Não escalado hoje';
            if (member.isScheduledToday && todayAssignment?.isOverride) badge.textContent += ' · Troca';
            stateCell.appendChild(badge);
            row.classList.toggle('is-current', currentAssignment);
            row.append(nameCell, shiftCell, daysCell, phoneCell, emailCell, stateCell);
            table.appendChild(row);
        });
    }

    async loadAdminConfig() {
        try {
            this.config = await apiRequest('/api/admin/schedules/epbx', 'GET', null, true);
            this.renderAdminConfig(true);
        } catch (error) {
            this.setAdminStatus(error.message || 'Não foi possível carregar a configuração da escala.', true);
        }
    }

    bindAdminForms() {
        document.getElementById('epbx-settings-form')?.addEventListener('submit', event => {
            event.preventDefault();
            const form = event.currentTarget;
            this.config.settings = {
                rotationStartDate: form.querySelector('#epbx-rotation-start').value,
                weekdayStart: form.querySelector('#epbx-weekday-start').value,
                weekdayEnd: form.querySelector('#epbx-weekday-end').value,
                weekendStart: form.querySelector('#epbx-weekend-start').value,
                weekendEnd: form.querySelector('#epbx-weekend-end').value
            };
            void this.saveConfig('Horários e início da rotação salvos.');
        });

        document.getElementById('epbx-add-member-form')?.addEventListener('submit', event => {
            event.preventDefault();
            const form = event.currentTarget;
            const name = form.querySelector('#epbx-member-name').value.trim();
            if (!name) return;
            this.config.members.push({
                id: `epbx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                name,
                phone: form.querySelector('#epbx-member-phone').value.trim(),
                email: form.querySelector('#epbx-member-email').value.trim(),
                order: Math.max(-1, ...this.config.members.map(member => member.order)) + 1,
                active: true
            });
            form.reset();
            void this.saveConfig('Plantonista adicionado.');
        });

        document.getElementById('epbx-override-form')?.addEventListener('submit', event => {
            event.preventDefault();
            const form = event.currentTarget;
            const date = form.querySelector('#epbx-override-date').value;
            const memberId = form.querySelector('#epbx-override-member').value;
            if (!date || !memberId) return;
            this.config.overrides = this.config.overrides.filter(item => item.date !== date);
            this.config.overrides.push({ date, memberId });
            void this.saveConfig(`Troca para ${new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR')} adicionada.`);
        });

        document.getElementById('epbx-absence-form')?.addEventListener('submit', event => {
            event.preventDefault();
            const form = event.currentTarget;
            const memberId = form.querySelector('#epbx-absence-member').value;
            const startDate = form.querySelector('#epbx-absence-start').value;
            const endDate = form.querySelector('#epbx-absence-end').value;
            if (!memberId || !startDate || !endDate || endDate < startDate) {
                this.setAdminStatus('Confira as datas da ausência: a data final precisa ser igual ou posterior à inicial.', true);
                return;
            }
            this.config.absences.push({
                id: `absence-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                memberId,
                startDate,
                endDate,
                reason: form.querySelector('#epbx-absence-reason').value.trim()
            });
            form.reset();
            void this.saveConfig('Período de férias/ausência registrado.');
        });

        document.getElementById('epbx-holiday-form')?.addEventListener('submit', event => {
            event.preventDefault();
            const form = event.currentTarget;
            const date = form.querySelector('#epbx-holiday-date').value;
            const name = form.querySelector('#epbx-holiday-name').value.trim();
            if (!date || !name) return;
            if ((this.config.calculatedHolidays || []).some(holiday => holiday.date === date)) {
                this.setAdminStatus('Essa data já consta no calendário de feriados calculados automaticamente.', true);
                return;
            }
            if ((this.config.holidays || []).some(holiday => holiday.date === date)) {
                this.setAdminStatus('Já existe um feriado cadastrado para essa data.', true);
                return;
            }
            this.config.holidays = [...(this.config.holidays || []), { date, name }];
            form.reset();
            void this.saveConfig('Feriado cadastrado; nessa data o plantão será de 08:00 a 07:59.');
        });

        document.getElementById('epbx-roster-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-epbx-action]');
            if (!button) return;
            const member = this.config.members.find(item => item.id === button.dataset.memberId);
            if (!member) return;
            const activeMembers = this.getOrderedMembers();
            const index = activeMembers.findIndex(item => item.id === member.id);
            let successMessage = 'Ordem da escala atualizada.';
            if (button.dataset.epbxAction === 'up' || button.dataset.epbxAction === 'down') {
                const nextIndex = index + (button.dataset.epbxAction === 'up' ? -1 : 1);
                if (nextIndex < 0 || nextIndex >= activeMembers.length) return;
                [activeMembers[index].order, activeMembers[nextIndex].order] = [activeMembers[nextIndex].order, activeMembers[index].order];
            } else if (button.dataset.epbxAction === 'toggle') {
                const orderedMembers = [...this.config.members].sort((a, b) => a.order - b.order);
                member.active = member.active === false;
                orderedMembers.forEach((item, order) => { item.order = order; });
                successMessage = member.active ? `${member.name} reativado na rotação.` : `${member.name} removido da rotação; histórico preservado.`;
            }
            void this.saveConfig(successMessage);
        });

        document.getElementById('epbx-overrides-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-remove-override]');
            if (!button) return;
            this.config.overrides = this.config.overrides.filter(item => item.date !== button.dataset.removeOverride);
            void this.saveConfig('Troca removida; a rotação base voltará a valer nessa data.');
        });

        document.getElementById('epbx-absences-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-remove-absence]');
            if (!button) return;
            this.config.absences = this.config.absences.filter(item => item.id !== button.dataset.removeAbsence);
            void this.saveConfig('Período de ausência removido.');
        });

        document.getElementById('epbx-holidays-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-remove-holiday]');
            if (!button) return;
            this.config.holidays = (this.config.holidays || []).filter(item => item.date !== button.dataset.removeHoliday);
            void this.saveConfig('Feriado removido; o horário normal da semana voltará a valer.');
        });
    }

    getOrderedMembers() {
        return [...this.config.members].filter(item => item.active !== false).sort((a, b) => a.order - b.order);
    }

    renderAdminConfig(initializeSettings = false) {
        const settings = this.config.settings;
        if (initializeSettings) {
            document.getElementById('epbx-rotation-start').value = settings.rotationStartDate;
            document.getElementById('epbx-weekday-start').value = settings.weekdayStart;
            document.getElementById('epbx-weekday-end').value = settings.weekdayEnd;
            document.getElementById('epbx-weekend-start').value = settings.weekendStart;
            document.getElementById('epbx-weekend-end').value = settings.weekendEnd;
        }

        const roster = document.getElementById('epbx-roster-list');
        roster.replaceChildren();
        [...this.config.members].sort((a, b) => a.order - b.order).forEach(member => {
            const row = document.createElement('div');
            row.className = `epbx-admin-roster-row${member.active === false ? ' is-inactive' : ''}`;
            const label = document.createElement('span');
            label.className = 'epbx-admin-member-label';
            label.textContent = `${member.name} · ${member.phone || 'Sem telefone'}${member.active === false ? ' · Desativado' : ''}`;
            row.appendChild(label);
            if (member.active !== false) {
                const active = this.getOrderedMembers();
                const index = active.findIndex(item => item.id === member.id);
                row.append(this.makeRosterButton('up', member.id, 'Subir', index === 0), this.makeRosterButton('down', member.id, 'Descer', index === active.length - 1));
            }
            row.appendChild(this.makeRosterButton('toggle', member.id, member.active === false ? 'Reativar' : 'Desativar', false));
            roster.appendChild(row);
        });

        const activeMembers = this.getOrderedMembers();
        ['epbx-override-member', 'epbx-absence-member'].forEach(id => {
            const select = document.getElementById(id);
            const selected = select.value;
            select.replaceChildren(new Option('Selecione...', ''));
            activeMembers.forEach(member => select.add(new Option(member.name, member.id)));
            if (activeMembers.some(member => member.id === selected)) select.value = selected;
        });

        const overrides = document.getElementById('epbx-overrides-list');
        overrides.replaceChildren();
        [...this.config.overrides].sort((a, b) => a.date.localeCompare(b.date)).forEach(item => {
            const member = this.config.members.find(candidate => candidate.id === item.memberId);
            const row = document.createElement('div');
            row.className = 'epbx-admin-record-row';
            const label = document.createElement('span');
            label.textContent = `${new Date(`${item.date}T12:00:00`).toLocaleDateString('pt-BR')} · ${member?.name || 'Plantonista indisponível'}`;
            const remove = this.makeRosterButton('', '', 'Remover', false);
            remove.dataset.removeOverride = item.date;
            row.append(label, remove);
            overrides.appendChild(row);
        });

        const absences = document.getElementById('epbx-absences-list');
        absences.replaceChildren();
        [...this.config.absences].sort((a, b) => a.startDate.localeCompare(b.startDate)).forEach(item => {
            const member = this.config.members.find(candidate => candidate.id === item.memberId);
            const row = document.createElement('div');
            row.className = 'epbx-admin-record-row';
            const label = document.createElement('span');
            label.textContent = `${member?.name || 'Plantonista'} · ${new Date(`${item.startDate}T12:00:00`).toLocaleDateString('pt-BR')}–${new Date(`${item.endDate}T12:00:00`).toLocaleDateString('pt-BR')}${item.reason ? ` · ${item.reason}` : ''}`;
            const remove = this.makeRosterButton('', '', 'Remover', false);
            remove.dataset.removeAbsence = item.id;
            row.append(label, remove);
            absences.appendChild(row);
        });

        const holidays = document.getElementById('epbx-holidays-list');
        holidays.replaceChildren();
        [...(this.config.holidays || [])].sort((a, b) => a.date.localeCompare(b.date)).forEach(item => {
            const row = document.createElement('div');
            row.className = 'epbx-admin-record-row';
            const label = document.createElement('span');
            label.textContent = `${new Date(`${item.date}T12:00:00`).toLocaleDateString('pt-BR')} · ${item.name}`;
            const remove = this.makeRosterButton('', '', 'Remover', false);
            remove.dataset.removeHoliday = item.date;
            row.append(label, remove);
            holidays.appendChild(row);
        });

        const automaticHolidays = document.getElementById('epbx-auto-holidays-list');
        automaticHolidays.replaceChildren();
        const calculatedHolidays = this.config.calculatedHolidays || [];
        if (!calculatedHolidays.length) {
            const empty = document.createElement('p');
            empty.className = 'epbx-admin-holiday-empty';
            empty.textContent = 'Nenhum feriado calculado para este ano.';
            automaticHolidays.appendChild(empty);
        } else {
            calculatedHolidays.forEach(item => {
                const chip = document.createElement('span');
                chip.className = 'epbx-admin-holiday-chip';
                const date = document.createElement('time');
                date.dateTime = item.date;
                date.textContent = new Date(`${item.date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
                const name = document.createElement('span');
                name.textContent = item.name;
                chip.append(date, name);
                automaticHolidays.appendChild(chip);
            });
        }
    }

    makeRosterButton(action, memberId, label, disabled) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline epbx-admin-action';
        button.textContent = label;
        button.disabled = disabled;
        if (action) button.dataset.epbxAction = action;
        if (memberId) button.dataset.memberId = memberId;
        return button;
    }

    async saveConfig(successMessage) {
        try {
            const result = await apiRequest('/api/admin/schedules/epbx', 'PUT', this.config, true);
            this.config = result.config;
            this.renderAdminConfig();
            this.setAdminStatus(successMessage, false);
            await this.refreshPublicSchedule();
        } catch (error) {
            this.setAdminStatus(error.message || 'Não foi possível salvar a escala.', true);
        }
    }

    setAdminStatus(message, isError) {
        if (!this.adminStatus) return;
        this.adminStatus.textContent = message;
        this.adminStatus.classList.toggle('error', isError);
        this.adminStatus.classList.toggle('success', !isError);
    }
}

const plantonistas = [
  { name: 'Operador exemplo', phone: '(00) 00000-0000', class: 'operator' }
];

// Eu não faço ideia de como isso aqui ta funcionando
const scheduleData = [
 
  { date: '2025-08-31', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-01', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-02', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-03', shifts: [
    { ...plantonistas[0], start: '00:00', end: '08:59' },
    { ...plantonistas[1], start: '09:00', end: '23:59' }
  ], isShiftChange: true },
  { date: '2025-09-04', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-05', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-06', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },

  
  { date: '2025-09-07', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-08', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-09', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-10', shifts: [
    { ...plantonistas[1], start: '00:00', end: '08:59' },
    { ...plantonistas[2], start: '09:00', end: '23:59' }
  ], isShiftChange: true },
  { date: '2025-09-11', shifts: [{ ...plantonistas[2], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-12', shifts: [{ ...plantonistas[2], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-13', shifts: [{ ...plantonistas[2], start: '00:00', end: '23:59' }], isShiftChange: false },

  
  { date: '2025-09-14', shifts: [{ ...plantonistas[2], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-15', shifts: [{ ...plantonistas[2], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-16', shifts: [{ ...plantonistas[2], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-17', shifts: [
    { ...plantonistas[2], start: '00:00', end: '08:59' },
    { ...plantonistas[3], start: '09:00', end: '23:59' }
  ], isShiftChange: true },
  { date: '2025-09-18', shifts: [{ ...plantonistas[3], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-19', shifts: [{ ...plantonistas[3], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-20', shifts: [{ ...plantonistas[3], start: '00:00', end: '23:59' }], isShiftChange: false },

  
  { date: '2025-09-21', shifts: [{ ...plantonistas[3], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-22', shifts: [{ ...plantonistas[3], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-23', shifts: [{ ...plantonistas[3], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-24', shifts: [
    { ...plantonistas[3], start: '00:00', end: '08:59' },
    { ...plantonistas[0], start: '09:00', end: '23:59' }
  ], isShiftChange: true },
  { date: '2025-09-25', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-26', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-27', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },

  
  { date: '2025-09-28', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-29', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-09-30', shifts: [{ ...plantonistas[0], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-10-01', shifts: [
    { ...plantonistas[0], start: '00:00', end: '08:59' },
    { ...plantonistas[1], start: '09:00', end: '23:59' }
  ], isShiftChange: true },
  { date: '2025-10-02', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-10-03', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },
  { date: '2025-10-04', shifts: [{ ...plantonistas[1], start: '00:00', end: '23:59' }], isShiftChange: false },
];

const dayNames = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
const monthNames = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];


function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const mainContent = document.getElementById('mainContent');
  sidebar.classList.toggle('collapsed');
  mainContent.classList.toggle('expanded');
}

function toggleDropdown(event, dropdownId) {
  event.preventDefault();
  event.stopPropagation();
  const navItem = event.currentTarget.parentElement;
  const dropdown = document.getElementById(dropdownId + '-dropdown');

  document.querySelectorAll('.nav-item').forEach(item => {
    if (item !== navItem) { item.classList.remove('active'); }
  });

  navItem.classList.toggle('active');
}

document.addEventListener('click', function(event) {
  if (!event.target.closest('.nav-item')) {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });
  }
});


function updateClock() {
  const now = new Date();
  const timeString = now.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit'
  });
  const dateString = now.toLocaleDateString('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const timeElement = document.getElementById('currentTime');
  const dateElement = document.getElementById('currentDate');
  if (timeElement) timeElement.textContent = timeString;
  if (dateElement) dateElement.textContent = dateString;

  updateCurrentPlantonista(now);
}

function getCurrentPlantonista(sagData, date = new Date()) {
  if (!sagData || sagData.length === 0) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const currentDateStr = `${year}-${month}-${day}`;
  
  const currentHour = date.getHours();
  const currentMinute = date.getMinutes();
  const currentTime = currentHour * 60 + currentMinute;

  const daySchedule = sagData.find(d => d.date === currentDateStr);
  if (!daySchedule) return null;

  if (daySchedule.shifts.length === 1) {
    return daySchedule.shifts[0];
  }

  for (const shift of daySchedule.shifts) {
    const [startHour, startMin] = shift.start.split(':').map(Number);
    const [endHour, endMin] = shift.end.split(':').map(Number);
    const startTime = startHour * 60 + startMin;
    const endTime = endHour * 60 + endMin;
    if (currentTime >= startTime && currentTime <= endTime) {
      return shift;
    }
  }
  return daySchedule.shifts[0];
}

function updateCurrentPlantonista(sagData, date = new Date()) {
  const currentShift = getCurrentPlantonista(sagData, date);
  const container = document.getElementById('currentPlantonista');
  if (!container) return;

  if (currentShift) {
    container.innerHTML = `
      <div class="plantonista-info">
        <h3 class="plantonista-name">${currentShift.name}</h3>
        <div class="shift-time-badge">${currentShift.start} - ${currentShift.end}</div>
        <button class="btn btn-primary" onclick="handleCall('${currentShift.phone}')">
          <i class="fa-solid fa-phone"></i> Ligar: ${currentShift.phone}
        </button>
      </div>`;
  } else {
    container.innerHTML = `
      <div class="no-plantonista">
        <i data-lucide="alert-triangle" class="icon-large"></i>
        <p>Nenhum plantonista encontrado para o horário atual</p>
      </div>`;
  }
  if (typeof lucide !== 'undefined') { lucide.createIcons(); }
}

function formatDate(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  return date.getDate().toString().padStart(2, '0');
}
function formatMonth(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  return monthNames[date.getMonth()];
}

function createDayCard(day) {
  const date = new Date(day.date + 'T12:00:00');
  const dayOfWeek = dayNames[date.getDay()];

  let shiftsHtml = day.shifts.map(shift => {
    const timeLabel = day.isShiftChange && shift.start !== '00:00' ? `${shift.start}-${shift.end}` : '';
    return `
      <div class="shift-info">
        <div class="shift-name ${shift.class}">
          ${timeLabel ? `<div style="font-size: 0.625rem; margin-bottom: 0.125rem;">${timeLabel}</div>` : ''}
          <div>${shift.name}</div>
        </div>
        <div class="shift-phone">
          <i data-lucide="phone" class="icon"></i>
          <span>${shift.phone}</span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="day-card ${day.isShiftChange ? 'shift-change' : ''}">
      <div class="day-header">
        <div class="day-name">${dayOfWeek}</div>
        <div class="day-number">${formatDate(day.date)}-${formatMonth(day.date)}</div>
      </div>
      <div class="day-content">${shiftsHtml}</div>
    </div>`;
}

function renderCalendar(sagData) {
  const calendarContainer = document.getElementById('scheduleCalendar');
  if (!calendarContainer) return;

  if (!sagData || sagData.length === 0) {
      calendarContainer.innerHTML = '<div class="week-row"><p style="text-align: center; width: 100%; padding: 20px;">Não foi possível carregar os dados da escala.</p></div>';
      return;
  }

  const weeks = [];
  for (let i = 0; i < sagData.length; i += 7) {
    weeks.push(sagData.slice(i, i + 7));
  }

  calendarContainer.innerHTML = weeks.map(week => `
    <div class="week-row">
      ${week.map(day => createDayCard(day)).join('')}
    </div>
  `).join('');
  
  if (typeof lucide !== 'undefined') { lucide.createIcons(); }
}
async function logoutConfirm() {
  const userConfirmed = await showCustomConfirm(
    'Confirmar Saída',                            // title
    'Deseja realmente sair do sistema?',           // text
    'Sair',                                       // confirmText
    'Cancelar'                                    // cancelText
  );

  if (userConfirmed) {
    if (typeof logout === 'function') {
      logout();
    }
  }
}

function showCustomAlert(title, text) {
  // Chama a função principal sem o texto do botão de cancelar
  return showCustomConfirm(title, text, 'OK');
}

// =============================================================================
// --- 7. FUNÇÕES GERAIS DE UI E EVENTOS ---
// Funções que controlam a interface do usuário e eventos globais.
// =============================================================================
function setupEventListeners() {
    if (typeof socket !== 'undefined' && !socketListenersInitialized) {
        socketListenersInitialized = true;
        socket.on('new_post', newPost => renderSinglePost(newPost, true));
        socket.on('recado_deleted', ({ id }) => {
            document.querySelector(`.recado-item[data-recado-id="${id}"]`)?.remove();
        });
        socket.on('new_recado', newRecado => renderSingleRecado(newRecado));
    }

  document.body.addEventListener('click', async (e) => {
const profileToggle = e.target.closest('#user-profile-toggle');
    const profileDropdown = document.getElementById('user-dropdown-menu');
    if (profileToggle) {
        e.preventDefault();
        const isOpen = profileDropdown.style.display === 'block';
        profileDropdown.style.display = isOpen ? 'none' : 'block';
        return; 
    }

    if (profileDropdown && profileDropdown.style.display === 'block') {
        if (e.target.closest('.user-dropdown-menu') || !e.target.closest('.header-user')) {
            profileDropdown.style.display = 'none';
        }
    }
    if (e.target.closest('#logout-btn')) {
      e.preventDefault();
      const userConfirmed = await showCustomConfirm(
          'Confirmar Saída',
          'Você tem certeza que deseja sair do sistema?'
      );

      if (userConfirmed) {
        logout();
      }
    }

    if (e.target.closest('#menu-toggle')) {
      const sidebar = document.getElementById('sidebar');
            setSidebarCollapsed(!sidebar?.classList.contains('collapsed'));
    }

        // ---------------------------------------------------------
    // NOVO: Toggle do Menu Dropdown (Zabbix) na Sidebar
    // ---------------------------------------------------------
    const dropdownToggle = e.target.closest('#zabbix-submenu-toggle');
    if (dropdownToggle) {
        e.preventDefault();
        const navItem = dropdownToggle.closest('.has-dropdown');
        const submenu = document.getElementById('zabbix-submenu');
        
        if (submenu) {
            const isOpen = submenu.style.display === 'block';
            submenu.style.display = isOpen ? 'none' : 'block';
            navItem.classList.toggle('open', !isOpen);
            dropdownToggle.setAttribute('aria-expanded', String(!isOpen));
        }
        return; // Sai da função para não acionar as lógicas de clique abaixo
    }

    const sectionLink = e.target.closest('[data-section]');
    if (sectionLink) {
      e.preventDefault();
      const section = sectionLink.dataset.section;
            if (section) {
                showSection(section);
                if (window.matchMedia('(max-width: 768px)').matches) {
                    setSidebarCollapsed(true);
                }
            }
    }

    const postMenuBtn = e.target.closest('.post-menu-btn');
    if (postMenuBtn) {
      e.stopPropagation();
      const postId = postMenuBtn.getAttribute('data-post-id');
      const menu = document.getElementById(`menu-${postId}`);
      document.querySelectorAll('.post-menu').forEach(m => { if (m !== menu) m.classList.remove('show'); });
      if (menu) menu.classList.toggle('show');
    }

        const homePinButton = e.target.closest('[data-home-pin]');
        if (homePinButton) {
            e.preventDefault();
            e.stopPropagation();
            const postId = homePinButton.dataset.homePin;
            const pinned = homePinButton.dataset.pinned === 'true';
            homePinButton.disabled = true;
            try {
                await apiRequest(`/api/posts/${postId}/home-pin`, 'PUT', { pinned: !pinned });
                const post = posts.find(item => String(item.id) === String(postId));
                if (post) post.is_home_pinned = !pinned;
                homePinButton.dataset.pinned = String(!pinned);
                homePinButton.textContent = pinned ? 'Fixar na Início' : 'Desafixar da Início';
                await loadHomeInformativos();
            } catch (error) {
                console.error('Não foi possível atualizar o informativo fixado:', error);
            } finally {
                homePinButton.disabled = false;
            }
        }

        const savePostButton = e.target.closest('[data-post-save]');
        if (savePostButton) {
            e.preventDefault();
            e.stopPropagation();
            const postId = String(savePostButton.dataset.postSave);
            const post = posts.find(item => String(item.id) === postId);
            if (!post) return;

            const shouldSave = !post.is_saved_by_me;
            savePostButton.disabled = true;
            try {
                await apiRequest(`/api/posts/${encodeURIComponent(postId)}/saved`, 'PUT', { saved: shouldSave }, true);
                post.is_saved_by_me = shouldSave;
                renderPosts();
            } catch (error) {
                console.error('Não foi possível atualizar os posts salvos:', error);
                savePostButton.disabled = false;
            }
        }

        const acknowledgeButton = e.target.closest('[data-post-ack]');
        if (acknowledgeButton && !e.target.closest('[data-ack-users]') && acknowledgeButton.getAttribute('aria-pressed') !== 'true') {
            acknowledgeButton.disabled = true;
            try {
                const result = await apiRequest(`/api/posts/${acknowledgeButton.dataset.postAck}/acknowledgements`, 'POST', {});
                const post = posts.find(item => String(item.id) === acknowledgeButton.dataset.postAck);
                if (post) {
                    post.acknowledged_by_me = true;
                    post.acknowledgement_count = result.count;
                }
                const count = document.querySelector(`[data-ack-count="${acknowledgeButton.dataset.postAck}"]`);
                if (count) count.textContent = result.count;
                const acknowledgementList = document.querySelector(`#ack-users-${acknowledgeButton.dataset.postAck} ul`);
                if (acknowledgementList) acknowledgementList.dataset.loaded = 'false';
                acknowledgeButton.classList.add('is-acknowledged');
                acknowledgeButton.setAttribute('aria-label', 'Você marcou como ciente');
                acknowledgeButton.setAttribute('aria-pressed', 'true');
            } catch (error) {
                // apiRequest já informa a falha; permitir uma nova tentativa.
            } finally {
                acknowledgeButton.disabled = false;
            }
        }

        const commentsToggle = e.target.closest('[data-comments-toggle]');
        if (commentsToggle) {
            const postId = commentsToggle.dataset.commentsToggle;
            const commentsPanel = document.getElementById(`comments-${postId}`);
            const willOpen = commentsPanel?.hidden;
            if (commentsPanel) commentsPanel.hidden = !willOpen;
            commentsToggle.setAttribute('aria-expanded', String(Boolean(willOpen)));
            if (willOpen) loadPostComments(postId);
        }

        const feedFilter = e.target.closest('[data-feed-filter]');
        if (feedFilter) {
            activeFeedFilter = feedFilter.dataset.feedFilter;
            document.querySelectorAll('[data-feed-filter]').forEach(button => {
                const isActive = button === feedFilter;
                button.classList.toggle('active', isActive);
                button.setAttribute('aria-pressed', String(isActive));
            });
            renderPosts();
        }

    const navLink = e.target.closest('.nav-link');
    if (navLink) {
      e.preventDefault();
      e.stopPropagation();
      const parentItem = navLink.closest('.nav-item');
      const isActive = parentItem && parentItem.classList.contains('active');
      document.querySelectorAll('.nav-item').forEach(otherItem => {
        if (otherItem !== parentItem) { otherItem.classList.remove('active'); }
      });
      if (parentItem) parentItem.classList.toggle('active', !isActive);
    }

    const dropdownItem = e.target.closest('.dropdown-item');
    if (dropdownItem) {
      e.preventDefault();
      const system = dropdownItem.getAttribute('data-system');
      if (system) { showSection(system); }
      document.querySelectorAll('.nav-item').forEach(navItem => navItem.classList.remove('active'));
    }
  });

  if (document.getElementById('editor-container')) {
    quill = new Quill('#editor-container', {
      modules: { toolbar: '#toolbar-container' },
      theme: 'snow',
            placeholder: 'Escreva uma atualização, procedimento, alerta ou informação para a equipe...'
    });
  }

    const postForm = document.getElementById('post-form');
    const attachmentInput = document.getElementById('feed-attachments');
    const dropzone = document.getElementById('feed-dropzone');
    const attachmentList = document.getElementById('feed-attachment-list');
    let pendingAttachments = [];

    const renderPendingAttachments = () => {
        if (!attachmentList) return;
        attachmentList.replaceChildren();
        pendingAttachments.forEach((file, index) => {
            const chip = document.createElement('span');
            chip.className = 'feed-attachment-chip';
            const label = document.createElement('span');
            label.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.dataset.removeFeedFile = String(index);
            removeButton.setAttribute('aria-label', `Remover ${file.name}`);
            removeButton.textContent = '×';
            chip.append(label, removeButton);
            attachmentList.appendChild(chip);
        });
    };

    const addPendingAttachments = async (files) => {
        const allowed = files.filter(file => /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/i.test(file.type));
        if (allowed.length !== files.length) await showCustomAlert('Anexo não permitido', 'Selecione somente imagens JPG, PNG, GIF, WEBP ou arquivos PDF.');
        const combined = [...pendingAttachments, ...allowed];
        const unique = combined.filter((file, index, list) => list.findIndex(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified) === index);
        const oversized = unique.filter(file => file.size > 10 * 1024 * 1024);
        if (oversized.length) await showCustomAlert('Arquivo muito grande', 'Cada anexo pode ter no máximo 10 MB.');
        pendingAttachments = unique.filter(file => file.size <= 10 * 1024 * 1024).slice(0, 5);
        if (unique.length > 5) await showCustomAlert('Limite de anexos', 'É possível anexar até 5 arquivos por publicação.');
        renderPendingAttachments();
    };

    if (attachmentInput) {
        attachmentInput.addEventListener('change', async () => {
            await addPendingAttachments(Array.from(attachmentInput.files || []));
            attachmentInput.value = '';
        });
    }

    if (dropzone) {
        dropzone.addEventListener('dragover', (event) => {
            event.preventDefault();
            dropzone.classList.add('drag-over');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
        dropzone.addEventListener('drop', async (event) => {
            event.preventDefault();
            dropzone.classList.remove('drag-over');
            await addPendingAttachments(Array.from(event.dataTransfer.files || []));
        });
    }

    if (attachmentList) {
        attachmentList.addEventListener('click', (event) => {
            const removeButton = event.target.closest('[data-remove-feed-file]');
            if (!removeButton) return;
            pendingAttachments.splice(Number(removeButton.dataset.removeFeedFile), 1);
            renderPendingAttachments();
        });
    }

    if (postForm) {
        postForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!quill) {
                await showCustomAlert('Editor não está disponível.');
                return;
            }

            const plainText = quill.getText().trim();
            if (!plainText && pendingAttachments.length === 0) {
                await showCustomAlert('Adicione um texto ou pelo menos um anexo para publicar.');
                return;
            }

            const postData = {
                content: quill.root.innerHTML,
                category: document.getElementById('post-category')?.value || 'Outros'
            };
            let requestBody = postData;
            if (pendingAttachments.length > 0) {
                requestBody = new FormData();
                requestBody.append('content', postData.content);
                requestBody.append('category', postData.category);
                pendingAttachments.forEach(file => requestBody.append('attachments', file));
            }

            const submitButton = postForm.querySelector('.feed-submit');
            if (submitButton) submitButton.disabled = true;
            try {
                const createdPost = await apiRequest('/api/posts', 'POST', requestBody);
                if (createdPost && createdPost.id != null) {
                    renderSinglePost(createdPost, true);
                }
                quill.setContents([]);
                pendingAttachments = [];
                renderPendingAttachments();
            } catch (error) {
                console.error('Erro ao criar publicação:', error);
            } finally {
                if (submitButton) submitButton.disabled = false;
            }
        });
    }

    const commentsContainer = document.getElementById('posts-container');
    if (commentsContainer && commentsContainer.dataset.commentSubmitReady !== 'true') {
        commentsContainer.dataset.commentSubmitReady = 'true';
        commentsContainer.addEventListener('submit', async (event) => {
            const form = event.target.closest('[data-comment-form]');
            if (!form) return;
            event.preventDefault();
            const postId = form.dataset.commentForm;
            const input = form.elements.comment;
            const submitButton = form.querySelector('button[type="submit"]');
            const comment = input.value.trim();
            if (!comment) return;
            if (submitButton) submitButton.disabled = true;
            try {
                const savedComment = await apiRequest(`/api/posts/${postId}/comments`, 'POST', { comment });
                appendPostComment(postId, savedComment);
                input.value = '';
                const count = document.querySelector(`[data-comment-count="${postId}"]`);
                if (count) count.textContent = savedComment.comment_count;
                const post = posts.find(item => String(item.id) === postId);
                if (post) post.comment_count = savedComment.comment_count;
            } catch (error) {
                console.error('Erro ao publicar comentário:', error);
            } finally {
                if (submitButton) submitButton.disabled = false;
            }
        });
    }

    if (commentsContainer && commentsContainer.dataset.commentActionsReady !== 'true') {
        commentsContainer.dataset.commentActionsReady = 'true';
        commentsContainer.addEventListener('click', async (event) => {
            const menuToggle = event.target.closest('[data-comment-menu-toggle]');
            if (menuToggle) {
                const menu = menuToggle.parentElement?.querySelector('.feed-comment-menu');
                document.querySelectorAll('.feed-comment-menu.show').forEach(openMenu => {
                    if (openMenu !== menu) openMenu.classList.remove('show');
                });
                menu?.classList.toggle('show');
                menuToggle.setAttribute('aria-expanded', String(menu?.classList.contains('show')));
                return;
            }
            const editButton = event.target.closest('[data-edit-comment]');
            const deleteButton = event.target.closest('[data-delete-comment]');
            if (editButton) beginCommentEdit(editButton.dataset.postId, editButton.dataset.editComment);
            if (deleteButton) await deleteOwnComment(deleteButton.dataset.postId, deleteButton.dataset.deleteComment);
            if (editButton || deleteButton) {
                event.target.closest('.feed-comment-menu')?.classList.remove('show');
            }
        });
    }

    if (commentsContainer && commentsContainer.dataset.ackHoverReady !== 'true') {
        commentsContainer.dataset.ackHoverReady = 'true';
        const openAcknowledgementPopover = (trigger) => {
            const postId = trigger.dataset.ackUsers;
            const popover = document.getElementById(`ack-users-${postId}`);
            if (!popover) return;
            popover.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            loadAcknowledgementUsers(postId);
        };
        const closeAcknowledgementPopover = (trigger) => {
            const postId = trigger.dataset.ackUsers;
            const popover = document.getElementById(`ack-users-${postId}`);
            if (popover) popover.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        };

        commentsContainer.addEventListener('pointerover', (event) => {
            const trigger = event.target.closest('[data-ack-users]');
            if (!trigger || trigger.contains(event.relatedTarget)) return;
            openAcknowledgementPopover(trigger);
        });
        commentsContainer.addEventListener('pointerout', (event) => {
            const trigger = event.target.closest('[data-ack-users]');
            const popover = event.target.closest('.feed-ack-users-popover');
            if (trigger) {
                if (popover && popover.id === `ack-users-${trigger.dataset.ackUsers}`) return;
                if (event.relatedTarget?.closest?.(`#ack-users-${trigger.dataset.ackUsers}`)) return;
                closeAcknowledgementPopover(trigger);
                return;
            }
            if (popover && !event.relatedTarget?.closest?.(`#ack-users-${popover.id.replace('ack-users-', '')}`)
                && !event.relatedTarget?.closest?.(`[data-ack-users="${popover.id.replace('ack-users-', '')}"]`)) {
                const triggerForPopover = commentsContainer.querySelector(`[data-ack-users="${popover.id.replace('ack-users-', '')}"]`);
                if (triggerForPopover) closeAcknowledgementPopover(triggerForPopover);
            }
        });
        commentsContainer.addEventListener('focusin', (event) => {
            const trigger = event.target.closest('[data-ack-users]');
            if (trigger) openAcknowledgementPopover(trigger);
        });
        commentsContainer.addEventListener('focusout', (event) => {
            const trigger = event.target.closest('[data-ack-users]');
            if (!trigger || event.relatedTarget?.closest?.(`#ack-users-${trigger.dataset.ackUsers}`)) return;
            closeAcknowledgementPopover(trigger);
        });
    }

const saveProfileBtn = document.getElementById('save-profile-btn');
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', async () => {
            const nameInput = document.getElementById('display-name');
            const newName = nameInput ? nameInput.value.trim() : '';
            const currentUsername = currentUserProfile.username;

            if (!newName) return await showCustomAlert('O nome não pode ficar em branco.');

            try {
                const result = await apiRequest('/api/profile/update', 'PUT', { name: newName, username: currentUsername });
                await showCustomAlert(result.message);
                currentUserProfile.name = newName;
                initializeProfileUI(); 
            } catch (error) {
            }
        });
    }

  const modalConfirm = document.getElementById('modal-confirm');
  if (modalConfirm) modalConfirm.addEventListener('click', deletePost);

  const modalCancel = document.getElementById('modal-cancel');
  if (modalCancel) modalCancel.addEventListener('click', () => {
    postToDelete = null;
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.remove('show');
  });

    const avatarForm = document.getElementById('avatar-form');
    if (avatarForm) {
        avatarForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(avatarForm);
            if (!formData.get('avatar') || !formData.get('avatar').size) return await showCustomAlert('Escolha um arquivo.');

            try {
                const response = await fetch('/api/profile/avatar', { method: 'POST', body: formData, credentials: 'include' });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                await showCustomAlert(result.message);
                currentUserProfile.avatar_url = result.avatar_url;
                initializeProfileUI(); 
            } catch (error) {
                await showCustomAlert(`Erro: ${error.message}`);
            }
        });
    }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.post-menu') && !e.target.closest('.post-menu-btn')) {
      document.querySelectorAll('.post-menu').forEach(menu => menu.classList.remove('show'));
    }
        if (!e.target.closest('.feed-comment-actions')) {
            document.querySelectorAll('.feed-comment-menu.show').forEach(menu => menu.classList.remove('show'));
            document.querySelectorAll('.feed-comment-menu-toggle').forEach(button => button.setAttribute('aria-expanded', 'false'));
        }
    if (!e.target.closest('.nav-item')) {
      document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    }
  });
}

function showSection(sectionId, updateLocation = true) {

    if (currentUserProfile && !usuarioPodeAcessarSecao(sectionId)) {
          showCustomAlert("Acesso Negado", "Você não tem permissão para visualizar este módulo.");
          return; // Para a execução da função e não mostra a tela
  }

    const targetSection = document.getElementById(sectionId + '-section');
    if (!targetSection) return;

    currentSection = sectionId;
    if (updateLocation && window.location.hash !== `#${encodeURIComponent(sectionId)}`) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${encodeURIComponent(sectionId)}`);
    }

  // --- FIM DA TRAVA ---

  const mainContent = document.getElementById('main-content');
  if (sectionId === 'feed') {
    mainContent.classList.add('main-content--feed-active');
  } else {
    mainContent.classList.remove('main-content--feed-active');
  }

  document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));
  document.querySelectorAll('.menu-link').forEach(link => link.classList.remove('active'));

    targetSection.classList.add('active');

    if (sectionId === 'zabbix-monitoramento') {
        setupZabbixMonitoringScreen();
    }
    if (sectionId === 'zabbix-relatorios') {
        setupZabbixReportsScreen();
    }

  if (sectionId === 'pop-info') {
      if (!window.popMapManager.map) {
          window.popMapManager.init();
      }
      window.popMapManager.invalidateSize();
  }

  const activeLink = document.querySelector(`.menu-link[data-section="${sectionId}"]`);
  if (activeLink) activeLink.classList.add('active');

  initSagScheduleIfNeeded();
}

async function loadComponent(componentPath, placeholderId) {
  try {
    const response = await fetch(componentPath);
    if (!response.ok) throw new Error(`Não foi possível carregar ${componentPath}`);
    const content = await response.text();
    const placeholder = document.getElementById(placeholderId);
    if (placeholder) placeholder.innerHTML = content;
  } catch (error) {
    console.error(`Erro ao carregar o componente ${componentPath}:`, error);
  }
}

function showCustomConfirm(title, text, confirmText, cancelText) {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-confirm-modal');
        const titleEl = document.getElementById('custom-confirm-title');
        const textEl = document.getElementById('custom-confirm-text');
        const okBtn = document.getElementById('custom-confirm-ok');
        const cancelBtn = document.getElementById('custom-confirm-cancel');

        if (!modal || !titleEl || !textEl || !okBtn || !cancelBtn) {
            // Fallback para o confirm padrão se os elementos não existirem
            console.error("Elementos do modal personalizado não encontrados!");
            resolve(confirm(text));
            return;
        }

        titleEl.textContent = title;
        textEl.textContent = text;

        // Personaliza o texto do botão de confirmação ou usa o padrão
        okBtn.textContent = confirmText || 'Confirmar';

        // Lógica para mostrar ou esconder o botão de cancelar
        if (cancelText) {
            cancelBtn.textContent = cancelText;
            cancelBtn.style.display = 'inline-flex'; // Mostra o botão
        } else {
            cancelBtn.style.display = 'none'; // Esconde o botão
        }

        modal.classList.add('show');

        const cleanup = (result) => {
            modal.classList.remove('show');
            // Recria os botões para remover os event listeners antigos de forma segura
            okBtn.replaceWith(okBtn.cloneNode(true));
            cancelBtn.replaceWith(cancelBtn.cloneNode(true));
            resolve(result);
        };

        // Adiciona os listeners aos novos nós dos botões
        document.getElementById('custom-confirm-ok').onclick = () => cleanup(true);
        if (cancelText) {
            document.getElementById('custom-confirm-cancel').onclick = () => cleanup(false);
        }
    });
}

// =============================================================================
// --- 8. FUNÇÕES DE API E UTILITÁRIAS ---
// Funções para comunicação com o backend e outras tarefas auxiliares. */
// =============================================================================
// Substitua a sua função apiRequest INTEIRA por esta:
async function apiRequest(endpoint, method = 'GET', body = null, silent = false) {
    const controller = new AbortController();
    const timeoutMs = endpoint.startsWith('/api/zabbix/') ? 60000 : 15000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const config = {
    method,
    headers: {},
    cache: 'no-cache',
        credentials: 'include',
        signal: controller.signal
  };

  if (body instanceof FormData) {
    config.body = body;
  } else if (body) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(endpoint, config);

    if (response.status === 401 && !endpoint.includes('zabbix')) {
      await showCustomAlert('Sessão expirada', 'Sua sessão expirou. Por favor, faça login novamente.');
      window.location.href = '/login.html';
      return Promise.reject(new Error('Não autorizado'));
    }

    if (response.status === 204) {
      return; 
    }
    
        const responseText = await response.text();
        let responseData = {};
        if (responseText) {
            try {
                responseData = JSON.parse(responseText);
            } catch (parseError) {
                if (!response.ok) {
                    responseData = { message: response.status === 404
                        ? `O servidor não reconhece este endpoint (HTTP 404). Atualize/reinicie o backend.`
                        : `O servidor respondeu em formato inesperado (HTTP ${response.status}).` };
                } else {
                    throw new Error('O servidor retornou uma resposta inválida.');
                }
            }
        }
    
    if (!response.ok) {
        const errorMessage = responseData.message || 'Ocorreu um erro na requisição.';
        
        // Se silent for true (como no Zabbix), ele pula o alerta!
        if (!silent) {
            showCustomAlert('Aviso', errorMessage);
        }
        throw new Error(errorMessage);
    }

    return responseData;
  } catch (error) {
        if (error.name === 'AbortError') {
            error.message = `A requisição ${method} ${endpoint} excedeu o tempo limite de ${timeoutMs / 1000} segundos.`;
        }
    console.error(`Erro na API [${method} ${endpoint}]:`, error);
    return Promise.reject(error); 
    } finally {
        clearTimeout(timeoutId);
  }
}

async function logout() {
  try {
    await apiRequest('/api/logout', 'POST');
  } catch (error) { }
  finally {
        sessionStorage.removeItem(getSidebarPreferenceKey());
    localStorage.removeItem('userProfile');
    window.location.href = '/login.html';
  }
}

function normalizarTexto(texto) {
  return (texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function setupSearch(inputId, gridSelector) {
  const input = document.getElementById(inputId);
  const grid = document.querySelector(gridSelector);
  if (!input || !grid) return;

  input.addEventListener('input', function () {
    const termo = normalizarTexto(this.value);
    const cards = grid.querySelectorAll('.card');
    cards.forEach(card => {
      const textoCard = normalizarTexto(card.textContent);
      card.style.display = textoCard.includes(termo) ? '' : 'none';
    });
  });
}

function setupPriorityTicket() {
    const priorityForm = document.getElementById('priority-ticket-form');
    const priorityInput = document.getElementById('priority-ticket-input');
    const priorityStatusFeed = document.getElementById('priority-ticket-status');
    const priorityDisplayWelcome = document.getElementById('priority-ticket-display');

    const updateAllDisplays = (ticketNumber) => {
        const hasTicket = ticketNumber && ticketNumber.trim() !== '';

        if (priorityStatusFeed) {
            if (hasTicket) {
                priorityStatusFeed.innerHTML = `<i data-lucide="pin"></i> Chamado priorizado: <span class="priority-badge">${ticketNumber}</span>`;
            } else {
                priorityStatusFeed.innerHTML = '';
            }
        }

        if (priorityDisplayWelcome) {
            if (hasTicket) {
                priorityDisplayWelcome.textContent = ticketNumber;
                priorityDisplayWelcome.style.fontWeight = 'bold';
                priorityDisplayWelcome.style.color = 'var(--secondary-foreground)';
            } else {
                priorityDisplayWelcome.textContent = 'Nenhum';
                priorityDisplayWelcome.style.fontWeight = 'normal';
                priorityDisplayWelcome.style.color = 'var(--foreground)';
            }
        }
    };

    const savedTicket = localStorage.getItem('priorityTicket');
    updateAllDisplays(savedTicket);

    if (!priorityForm || !priorityInput) return;

    priorityForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const ticketNumber = priorityInput.value.trim();

        localStorage.setItem('priorityTicket', ticketNumber);
        updateAllDisplays(ticketNumber);
        
        priorityInput.value = '';
    });
}

// =============================================================================
// --- GERENCIADOR DA ESCALA TÉCNICA (COM BANCO DE DADOS) ---
// =============================================================================

const AgeraPhones = {
    'Operador 1': '(00) 00000-0000',
    'Operador 2': '(00) 00000-0000'
};

class AgeraScheduleManager {
    constructor() {
        this.schedule = [];
        this.holidays = [];
        this.init();
    }

    async init() {
        await this.loadSchedule();
        this.bindAdminForms();
        this.updatePeriodSubtitle();

        if (this.schedule.length > 0) this.renderCalendar();
        else {
            const calendar = document.getElementById('ageraCalendar');
            if (calendar) calendar.textContent = 'Escala indisponível no momento.';
        }
        this.updateCurrentShift();
        
        setInterval(() => {
            this.updateCurrentShift();
            this.updatePeriodSubtitle();
        }, 60000);
    }

    async loadSchedule() {
        try {
            this.schedule = await apiRequest('/api/schedules/agera');
        } catch (error) {
            console.error("Aviso: Não foi possível carregar a escala técnica do banco.");
        }
    }

    async fetchHolidays(year) {
        try {
            const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`);
            if (res.ok) {
                const data = await res.json();
                return data.map(h => h.date); 
            }
        } catch (e) {
            console.warn("Aviso: Não foi possível carregar feriados automáticos.", e);
        }
        return [];
    }

    async generateCycle(monthStr, p1, p2, p3) {
        const [year, month] = monthStr.split('-').map(Number);
        
        const startDate = new Date(year, month - 1, 11);
        const endDate = new Date(year, month, 10);

        let hols = await this.fetchHolidays(startDate.getFullYear());
        if (startDate.getFullYear() !== endDate.getFullYear()) {
            const holsNext = await this.fetchHolidays(endDate.getFullYear());
            hols = hols.concat(holsNext);
        }
        this.holidays = hols;

        const pattern = [p1, p2, p3];
        const newSchedule = [];
        let currentDate = new Date(startDate);
        let index = 0;

        while (currentDate <= endDate) {
            const dateStr = new Date(currentDate.getTime() - (currentDate.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
            const dayOfWeek = currentDate.getDay();
            const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
            const isHoliday = this.holidays.includes(dateStr);

            let start = "18:00", end = "09:00", type = "Semana";
            if (isWeekend || isHoliday) {
                start = "09:00"; end = "09:00";
                type = isHoliday ? "Feriado" : "Fim de Semana";
            }

            newSchedule.push({
                date: dateStr,
                name: pattern[index % 3],
                phone: AgeraPhones[pattern[index % 3]] || '(00) 00000-0000',
                start: start,
                end: end,
                type: type
            });
            currentDate.setDate(currentDate.getDate() + 1);
            index++;
        }

        try {
            const response = await apiRequest('/api/admin/schedules/agera/generate', 'POST', { schedule: newSchedule });
            this.schedule = newSchedule;
            this.renderCalendar();
            this.updateCurrentShift();
            this.updatePeriodSubtitle();
            showCustomAlert('Sucesso!', response.message);
        } catch (error) {
            showCustomAlert('Erro', 'Não foi possível salvar a escala no banco de dados.');
        }
    }

    bindAdminForms() {
        const genForm = document.getElementById('agera-generator-form');
        const overForm = document.getElementById('agera-override-form');

        if (genForm) {
            genForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const month = document.getElementById('agera-ref-month').value;
                const p1 = document.getElementById('agera-d1').value;
                const p2 = document.getElementById('agera-d2').value;
                const p3 = document.getElementById('agera-d3').value;
                
                const btn = genForm.querySelector('button');
                btn.textContent = "Gerando e Salvando...";
                btn.disabled = true;
                await this.generateCycle(month, p1, p2, p3);
                btn.textContent = "Gerar e Salvar Ciclo";
            });
        }

        if (overForm) {
            overForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const dateVal = document.getElementById('agera-override-date').value;
                const personVal = document.getElementById('agera-override-person').value;

                try {
                    const response = await apiRequest('/api/admin/schedules/agera/override', 'PUT', {
                        date: dateVal,
                        name: personVal,
                        phone: AgeraPhones[personVal]
                    });
                    
                    await this.loadSchedule(); 
                    this.renderCalendar();
                    this.updateCurrentShift();
                    showCustomAlert('Sucesso!', response.message);
                } catch (error) {
                    showCustomAlert('Erro', 'Falha ao alterar o plantonista no banco.');
                }
            });
        }
    }

    updatePeriodSubtitle() {
        const subtitleEl = document.getElementById('agera-period-subtitle');
        if (!subtitleEl) return;

        const now = new Date();
        const monthNames = [
            'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
            'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
        ];

        let monthStart, monthEnd;

        if (now.getDate() <= 10) {
            let start = new Date(now.getFullYear(), now.getMonth() - 1, 11);
            let end = new Date(now.getFullYear(), now.getMonth(), 10);
            monthStart = monthNames[start.getMonth()];
            monthEnd = monthNames[end.getMonth()];
        } else {
            let start = new Date(now.getFullYear(), now.getMonth(), 11);
            let end = new Date(now.getFullYear(), now.getMonth() + 1, 10);
            monthStart = monthNames[start.getMonth()];
            monthEnd = monthNames[end.getMonth()];
        }

        subtitleEl.textContent = `${monthStart}/${monthEnd}`;
    }

    renderCalendar() {
        const container = document.getElementById('ageraCalendar');
        if (!container || this.schedule.length === 0) return;

        const firstDayDate = new Date(this.schedule[0].date + 'T12:00:00');
        const emptyDaysAtStart = firstDayDate.getDay(); 
        
        let html = '<div class="week-row">';
        
        for (let i = 0; i < emptyDaysAtStart; i++) {
            html += `<div class="day-card" style="visibility: hidden;"></div>`;
        }

        let currentDayOfWeek = emptyDaysAtStart;

        this.schedule.forEach(day => {
            if (currentDayOfWeek === 7) {
                html += '</div><div class="week-row">';
                currentDayOfWeek = 0;
            }

            const dateObj = new Date(day.date + 'T12:00:00');
            const dayNum = String(dateObj.getDate()).padStart(2, '0');
            const monthNames = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
            const monthStr = monthNames[dateObj.getMonth()];
            
            let colorClass = 'shift-name';
            if(day.name === 'Operador 1') colorClass += ' operator-one';
            if(day.name === 'Operador 2') colorClass += ' operator-two';

            html += `
                <div class="day-card ${day.type === 'Feriado' ? 'shift-change' : ''}">
                    <div class="day-header">
                        <div class="day-name" style="font-size: 10px;">${day.type}</div>
                        <div class="day-number">${dayNum}-${monthStr}</div>
                    </div>
                    <div class="day-content">
                        <div class="shift-info">
                            <div class="${colorClass}" style="margin-bottom: 4px;">
                                <div style="font-size: 10px;">${day.start} - ${day.end}</div>
                                <div>${day.name}</div>
                            </div>
                            <div class="shift-phone" style="font-size: 11px;">
                                <i class="fa-solid fa-phone"></i> ${day.phone}
                            </div>
                        </div>
                    </div>
                </div>
            `;
            currentDayOfWeek++;
        });

        while (currentDayOfWeek < 7) {
            html += `<div class="day-card" style="visibility: hidden;"></div>`;
            currentDayOfWeek++;
        }
        
        html += '</div>';
        container.innerHTML = html;
    }

    updateCurrentShift() {
        if (this.schedule.length === 0) {
            const nameEl = document.getElementById('agera-current-name');
            const phoneEl = document.getElementById('agera-current-phone');
            const statusEl = document.getElementById('agera-current-status');
            if (nameEl) nameEl.textContent = 'Indisponível';
            if (phoneEl) phoneEl.textContent = '—';
            if (statusEl) statusEl.textContent = 'Escala não carregada';
            return;
        }

        const now = new Date();
        const currentDateStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
        const currentTimeMinutes = now.getHours() * 60 + now.getMinutes();

        let todayShift = this.schedule.find(d => d.date === currentDateStr);
        if (!todayShift) return;

        let activeShift = todayShift;

        if (todayShift.start === "18:00" && currentTimeMinutes < (9 * 60)) {
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = new Date(yesterday.getTime() - (yesterday.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
            const prevShift = this.schedule.find(d => d.date === yesterdayStr);
            if (prevShift) { activeShift = prevShift; }
        }

        const nameEl = document.getElementById('agera-current-name');
        const phoneEl = document.getElementById('agera-current-phone');
        const statusEl = document.getElementById('agera-current-status');
        const dateEl = document.getElementById('agera-current-date');
        const dayEl = document.getElementById('agera-current-day');
        const shiftEl = document.getElementById('agera-current-shift');

        if (nameEl) nameEl.textContent = activeShift.name;
        if (phoneEl) phoneEl.textContent = activeShift.phone;
        if (statusEl) statusEl.innerHTML = '<span class="status-badge on-duty">Em Plantão</span>';
        if (dateEl) dateEl.textContent = now.toLocaleDateString('pt-BR');
        if (dayEl) {
            let rawDay = now.toLocaleDateString('pt-BR', { weekday: 'long' });
            dayEl.textContent = rawDay.charAt(0).toUpperCase() + rawDay.slice(1);
        }
        if (shiftEl) shiftEl.textContent = `${activeShift.type} (${activeShift.start}-${activeShift.end})`;
    }
}

/* ==========================================================================
   === MAPA DE POPs (VERSÃO FINAL COM TODOS OS POPS) ===
   ========================================================================== */
class PopMapManager {
    constructor() {
        this.map = null;
        this.markers = {};
        this.pops = [
            { code: 'BHE', name: 'Belo Horizonte', lat: -19.9167, lng: -43.9345 },
            { code: 'BLM', name: 'Belém', lat: -1.4558, lng: -48.4902 },
            { code: 'BSA', name: 'Brasília', lat: -15.7938, lng: -47.8827 },
            { code: 'CAS', name: 'Campinas', lat: -22.9056, lng: -47.0608 },
            { code: 'CTA', name: 'Curitiba', lat: -25.4284, lng: -49.2733 },
            { code: 'PAE', name: 'Porto Alegre', lat: -30.0277, lng: -51.2287 },
            { code: 'RCE', name: 'Recife', lat: -8.0476, lng: -34.8770 },
            { code: 'RJO', name: 'Rio de Janeiro', lat: -22.9068, lng: -43.1729 },
            { code: 'SDR', name: 'Salvador', lat: -12.9777, lng: -38.5016 },
            { code: 'SJB', name: 'São Joaquim da Barra', lat: -20.5886, lng: -47.8575 },
            { code: 'SRR', name: 'S. J. Rio Preto', lat: -20.8113, lng: -49.3758 },
            { code: 'STS', name: 'Santos', lat: -23.9608, lng: -46.3331 },
            { code: 'VTA', name: 'Vitória', lat: -20.3155, lng: -40.3128 },
            { code: 'PPE', name: 'Presidente Prudente', lat: -22.1207, lng: -51.3917 }, // Adicionado PPE
            
            // SÃO PAULO
            { code: 'SPO', name: 'SP - Landmark', lat: -23.6149, lng: -46.6924 }, // Nações Unidas
            { code: 'EX', name: 'Local exemplo', lat: -23.5505, lng: -46.6333 }
        ];
    }

    init() {
        if (this.map) return; 

        this.map = L.map('pop-map').setView([-15.7801, -47.9292], 4);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap, &copy; CARTO',
            subdomains: 'abcd',
            maxZoom: 19
        }).addTo(this.map);

        this.plotMarkers();
    }

    plotMarkers() {
        this.pops.forEach(pop => {
            const marker = L.circleMarker([pop.lat, pop.lng], {
                radius: 7,
                fillColor: "#28a745", 
                color: "#fff",
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
            }).addTo(this.map);

            marker.bindPopup(`
                <div style="text-align:center;">
                    <strong style="font-size:14px;">${pop.code}</strong><br>
                    ${pop.name}<br>
                    <span style="color:#28a745; font-weight:bold;">Status: Normal</span>
                </div>
            `);

            this.markers[pop.code] = marker;
        });
    }

    invalidateSize() {
        if (this.map) setTimeout(() => { this.map.invalidateSize(); }, 200);
    }
}

window.popMapManager = new PopMapManager();

// =============================================================================
// --- GESTÃO DE USUÁRIOS (ADMIN) ---
// =============================================================================

function setupAddUserForm() {
    const form = document.getElementById('add-user-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const name = document.getElementById('new-user-name').value;
        const username = document.getElementById('new-user-username').value;
        const email = document.getElementById('new-user-email').value;
        const cargo = document.getElementById('new-user-cargo').value;
        const jornada = document.getElementById('new-user-jornada').value;
        const checkboxes = document.querySelectorAll('input[name="permissions"]:checked');
        const permissoesArray = Array.from(checkboxes).map(cb => cb.value);
        const btn = form.querySelector('button');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cadastrando...';
        btn.disabled = true;
        try {
            const payload = {
                username: username,
                password: "change-me",
                email: email,
                name: name,
                cargo: cargo,
                jornada_trabalho: jornada,
                permissions: permissoesArray
            };

            const response = await apiRequest('/api/admin/users', 'POST', payload);
            
            showCustomAlert('Sucesso!', response.message);
            form.reset();
        } catch (error) {
            showCustomAlert('Erro', error.message || 'Falha ao cadastrar usuário.');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });
}

let myChart = null; // Variável global para o gráfico

let hostHistoryChart = null;
let currentHostItems = [];

async function showHostHistory(hostName) {
    const modal = document.getElementById('host-history-modal');
    const title = document.getElementById('history-modal-title');
    const selector = document.getElementById('history-item-selector');
    
    title.innerHTML = `<i class="fa-solid fa-chart-line"></i> ${hostName}`;
    selector.innerHTML = '<option value="">Buscando métricas disponíveis...</option>';
    selector.disabled = true;
    
    // Limpa o gráfico anterior se existir
    if (hostHistoryChart) {
        hostHistoryChart.destroy();
        hostHistoryChart = null;
    }
    
    modal.classList.add('show');

    try {
        // 1. Busca todas as métricas do Host
        currentHostItems = await apiRequest(`/api/zabbix/host-items?hostName=${hostName}`);
        
        if (currentHostItems.length === 0) {
            selector.innerHTML = '<option value="">Nenhuma métrica coletada para este host</option>';
            return;
        }

        // 2. Preenche o Dropdown
        selector.innerHTML = currentHostItems.map(item => 
            `<option value="${item.itemid}" data-type="${item.value_type}">${item.name}</option>`
        ).join('');
        selector.disabled = false;

        // 3. Adiciona o evento de troca
        selector.onchange = async (e) => {
            const selectedOption = e.target.options[e.target.selectedIndex];
            await renderHostChart(selectedOption.value, selectedOption.dataset.type, selectedOption.text);
        };

        // 4. Já carrega automaticamente a primeira métrica da lista
        await renderHostChart(currentHostItems[0].itemid, currentHostItems[0].value_type, currentHostItems[0].name);

    } catch (error) {
        selector.innerHTML = '<option value="">Erro ao carregar métricas</option>';
    }
}

// Função que desenha o gráfico efetivamente
async function renderHostChart(itemid, valueType, itemName) {
    try {
        const historyData = await apiRequest(`/api/zabbix/item-history?itemid=${itemid}&valueType=${valueType}`);
        
        const labels = historyData.map(h => new Date(h.clock * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
        const values = historyData.map(h => parseFloat(h.value));

        const ctx = document.getElementById('hostHistoryChart').getContext('2d');
        
        if (hostHistoryChart) hostHistoryChart.destroy();

        hostHistoryChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: itemName,
                    data: values,
                    borderColor: '#00BFFF', // Azul no estilo dashboard NOC
                    backgroundColor: 'rgba(0, 191, 255, 0.1)',
                    borderWidth: 2,
                    pointRadius: 1,
                    fill: true,
                    tension: 0.3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { 
                    legend: { display: true, position: 'bottom' }
                },
                scales: {
                    y: { beginAtZero: false } // Ajuda a visualizar variações sutis (como voltagem ou temperatura)
                }
            }
        });
    } catch (error) {
        console.error("Falha ao desenhar o gráfico:", error);
    }
}


// =========================================================
    // FILTRO AVANÇADO DE HOSTS (ESTILO ZABBIX)
    // =========================================================
    const zbxFilterToggle = document.getElementById('zbx-filter-toggle');
    const zbxFilterBody = document.getElementById('zbx-filter-body');
    const zbxFilterArrow = document.getElementById('zbx-filter-arrow');
    const zbxFilterForm = document.getElementById('zbx-advanced-filter-form');
    const zbxFilterReset = document.getElementById('btn-zbx-filter-reset');

    // Abre e fecha o painel de filtro
    if (zbxFilterToggle && zbxFilterBody && zbxFilterArrow) {
        zbxFilterToggle.addEventListener('click', () => {
            const isClosed = zbxFilterBody.style.display === 'none';
            zbxFilterBody.style.display = isClosed ? 'block' : 'none';
            zbxFilterArrow.classList.toggle('closed', !isClosed);
        });
    }

    // Botão Limpar
    if (zbxFilterReset && zbxFilterForm) {
        zbxFilterReset.addEventListener('click', () => {
            zbxFilterForm.reset();
            // Volta o Status para 'Qualquer' manualmente se necessário
            document.getElementById('status-any').checked = true;
        });
    }

    // Botão Aplicar (Captura os dados e prepara para enviar pra API)
if (zbxFilterForm) {
        zbxFilterForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const resultsDiv = document.getElementById('zbx-hosts-results');
            
            // Captura o que o operador digitou
            const filterData = {
                hostgroup: document.getElementById('filter-hostgroup').value.trim(),
                hostname: document.getElementById('filter-hostname').value.trim(),
                ip: document.getElementById('filter-ip').value.trim(),
                status: document.querySelector('input[name="host-status"]:checked').value,
                tag_name: document.getElementById('filter-tag-name').value.trim(),
                tag_value: document.getElementById('filter-tag-value').value.trim()
            };

            // Loading state
            resultsDiv.innerHTML = `
                <div style="padding: 40px; text-align: center;">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--primary); margin-bottom: 10px;"></i>
                    <p>Buscando inventário no Zabbix...</p>
                </div>
            `;

try {
                // Chama a nossa API no Node
                const hosts = await apiRequest('/api/zabbix/hosts/filter', 'POST', filterData);

                if (hosts.length === 0) {
                    resultsDiv.innerHTML = `
                        <div style="padding: 40px; text-align: center; color: var(--muted-foreground);">
                            <i class="fa-solid fa-folder-open" style="font-size: 2.5rem; margin-bottom: 10px; opacity: 0.5;"></i>
                            <h3>Nenhum host encontrado</h3>
                            <p>Tente ajustar os parâmetros do filtro.</p>
                        </div>
                    `;
                    return;
                }

                // Fecha o filtro automaticamente para mostrar os resultados
                const isClosed = zbxFilterBody.style.display === 'none';
                if (!isClosed) {
                    zbxFilterBody.style.display = 'none';
                    zbxFilterArrow.classList.add('closed');
                }

                // ==========================================
                // DESENHANDO A TABELA (AGORA COM AÇÕES)
                // ==========================================
                let tableHtml = `
                    <div style="width: 100%; overflow-x: auto;">
                        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                            <thead>
                                <tr style="background: var(--background); color: var(--muted-foreground); text-transform: uppercase; font-size: 11px;">
                                    <th style="padding: 12px 15px; border-bottom: 2px solid var(--border);">Host</th>
                                    <th style="padding: 12px 15px; border-bottom: 2px solid var(--border);">Interface (IP)</th>
                                    <th style="padding: 12px 15px; border-bottom: 2px solid var(--border);">Grupos</th>
                                    <th style="padding: 12px 15px; border-bottom: 2px solid var(--border);">Tags</th>
                                    <th style="padding: 12px 15px; border-bottom: 2px solid var(--border); text-align: center;">Ações</th> </tr>
                            </thead>
                            <tbody>
                `;

                hosts.forEach(host => {
                    let mainIp = 'Sem IP';
                    if (host.interfaces && host.interfaces.length > 0) {
                        mainIp = host.interfaces[0].ip || host.interfaces[0].dns;
                    }

                    const groupsHtml = (host.groups || []).map(g => g.name).join(', ') || '--';

                    const tagsHtml = (host.tags || []).map(t => 
                        `<span style="background: var(--background); padding: 2px 6px; border-radius: 4px; font-size: 10px; border: 1px solid var(--border); display: inline-block; margin: 2px;">${t.tag}: ${t.value}</span>`
                    ).join('') || '--';

                    const statusBadge = host.status === "0" 
                        ? `<span style="color: #28a745; font-weight: 600;">Monitorado</span>`
                        : `<span style="color: var(--destructive); font-weight: 600;">Não Monitorado</span>`;

                    tableHtml += `
                        <tr style="border-bottom: 1px solid var(--border); transition: background 0.2s;" onmouseover="this.style.backgroundColor='rgba(128,128,128,0.05)'" onmouseout="this.style.backgroundColor='transparent'">
                            <td style="padding: 12px 15px; font-weight: 600; color: var(--foreground);">${host.name}</td>
                            <td style="padding: 12px 15px; color: var(--muted-foreground);">${mainIp}</td>
                            <td style="padding: 12px 15px; color: var(--muted-foreground); max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${groupsHtml}">${groupsHtml}</td>
                            <td style="padding: 12px 15px; max-width: 250px;">${tagsHtml}</td>
                            <td style="padding: 12px 15px; text-align: center;">
                                <button class="btn-host-action-history" data-hostname="${host.name}" style="background: none; border: none; color: var(--primary); cursor: pointer; font-size: 16px; padding: 4px; transition: transform 0.2s;" title="Ver Histórico de Métricas" onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'">
                                    <i class="fa-solid fa-chart-line"></i>
                                </button>
                            </td>
                        </tr>
                    `;
                });

                tableHtml += `</tbody></table></div>`;
                
                resultsDiv.style.alignItems = 'stretch';
                resultsDiv.style.justifyContent = 'flex-start';
                resultsDiv.style.flexDirection = 'column';
                resultsDiv.innerHTML = `
                    <div style="padding: 15px; font-weight: 600; border-bottom: 1px solid var(--border); background: var(--card);">
                        Total de Hosts Encontrados: ${hosts.length}
                    </div>
                    ${tableHtml}
                `;

                // ==========================================
                // ATIVANDO OS BOTÕES DE GRÁFICO
                // ==========================================
                document.querySelectorAll('.btn-host-action-history').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const hostName = e.currentTarget.getAttribute('data-hostname');
                        // Chama a nossa função maravilhosa que abre o modal do Chart.js
                        if (typeof showHostHistory === 'function') {
                            showHostHistory(hostName);
                        } else {
                            showCustomAlert("Atenção", "A função de histórico ainda não está carregada.");
                        }
                    });
                });

            } catch (error) {
                resultsDiv.innerHTML = `
                    <div style="padding: 40px; text-align: center; color: var(--destructive);">
                        <i class="fa-solid fa-triangle-exclamation" style="font-size: 2.5rem; margin-bottom: 10px;"></i>
                        <h3>Erro ao consultar Zabbix</h3>
                        <p>Verifique a comunicação com a API.</p>
                    </div>
                `;
            }
        });
    }

