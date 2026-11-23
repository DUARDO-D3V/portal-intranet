/* =============================================================================
   Dashboard Zabbix do Portal NOC (arquivo independente)
   Carregar ANTES do script.js:  <script src="/assets/js/zabbix-dashboard.js" defer></script>
   Depende de globais do script.js: apiRequest, showCustomAlert, showHostHistory,
   problemasEmCache e currentViewMode.
   Chaves de configuração (zabbix-dashboard-config.js): waitingThirdPartyHours,
   staleAckHours, chronicDays (padrão 30), refreshSeconds (padrão 15), aging.
   ============================================================================= */
class ZabbixDashboard {
    constructor() {
        this.intervalId = null;
        this.currentTab = 'Geral';
        this.hostFilter = null;
        this.severityFilter = null;      // número da severidade ou null
        this.stateFilter = 'all';        // all | untreated | treated | no-ticket | availability | stale | chronic
        this.selectedEventIds = [];
        this.searchTerm = '';
        this.oldestFirst = false;
        this.hideChronic = localStorage.getItem('zabbixHideChronic') !== '0';
        this.lastUpdatedAt = null;
        this.serverOffset = 0;           // segundos: hora do servidor Zabbix - hora do navegador
        this.hiddenInformative = 0;
        this.fetching = false;
        this.lastSignature = null;
        this.lastMinute = null;
        this.lastCounts = null;
        this.sendingAck = false;
        this.seenIds = null;             // ids já vistos (para animar só o que acabou de chegar)
        this.groupByHost = localStorage.getItem('zabbixGroupByHost') !== '0';
        this.totalHosts = null;          // total de hosts monitorados (vem do backend) para a disponibilidade
        this.localityFilter = null;      // código da localidade ('__none' = sem localidade)

        this.severityNames = { 5: 'Crítico', 4: 'Alto', 3: 'Médio', 2: 'Aviso', 1: 'Informativo', 0: 'Não classificado' };
        this.severityColors = { 5: '#d64545', 4: '#e56b3f', 3: '#dc9a35', 2: '#b7a52c', 1: '#3188b8', 0: '#77838f' };
        this.stateNames = {
            untreated: 'Sem tratativa', treated: 'Em tratativa', 'no-ticket': 'ACK sem chamado',
            availability: 'Hosts fora', stale: 'Parados', chronic: 'Backlog crônico'
        };

        this.clearHostFilter = () => {
            this.hostFilter = null;
            this.render(true);
        };
        this.init();
    }

    // ------------------------------------------------------------------ config
    get settings() {
        const c = window.ZABBIX_DASHBOARD_CONFIG || {};
        return {
            waitingHours: Number(c.waitingThirdPartyHours) || 4,
            staleHours: Number(c.staleAckHours) || 4,
            chronicDays: Number(c.chronicDays) || 30,
            refreshSeconds: Math.max(5, Number(c.refreshSeconds) || 15),
            ticketPattern: String(c.ticketPattern || '^\\s*(?:CH-?)?\\d{3,}'),   // número no início da mensagem do ACK (aceita o antigo CH-123)
            chronicIncludesUnacked: c.chronicIncludesUnacked === true,
            defaultSort: c.defaultSort === 'priority' ? 'priority' : 'time',   // 'time' = igual ao Zabbix
            rowStyle: c.rowStyle === 'minimal' ? 'minimal' : 'tint',            // 'tint' = fundo suave por severidade nos sem ACK
            newBlinkSeconds: c.newBlinkSeconds === 0 ? 0 : (Number(c.newBlinkSeconds) || 60),   // pulso em alarme novo (0 desliga)
            newBadgeSeconds: c.newBadgeSeconds === 0 ? 0 : (Number(c.newBadgeSeconds) || 300),  // selo NOVO (0 desliga)
            groupWindowMinutes: Number(c.groupWindowMinutes) > 0 ? Number(c.groupWindowMinutes) : 30,   // janela para juntar alarmes do mesmo host
            availabilityPatterns: Array.isArray(c.availabilityPatterns) && c.availabilityPatterns.length
                ? c.availabilityPatterns.map(String)
                : ['Host Down', 'Unreachable', 'Unavailable by ICMP'],   // problemas que contam como "host fora"
            availabilityIgnoreChronic: c.availabilityIgnoreChronic === true,
            availabilityThresholds: { good: Number(c.availabilityThresholds?.good) || 99, warning: Number(c.availabilityThresholds?.warning) || 95 },
            localities: Array.isArray(c.localities) && c.localities.length
                ? c.localities.map(code => String(code).toUpperCase())
                : ['BHE', 'BLM', 'BSA', 'CAS', 'CTA', 'LM', 'PAE', 'PM', 'PPE', 'RCE', 'RJO', 'SDR', 'SJB', 'SJC', 'SOC', 'SPO', 'SRR', 'STS', 'TBR', 'TLK', 'VTA'],
            localityRules: Array.isArray(c.localityRules)
                ? c.localityRules
                : [{ pattern: '^SPOLM', locality: 'LM' }, { pattern: '^SPOTLK|^TALK[-_]', locality: 'TLK' }],   // exceções por nome do host
            massOutageMinHosts: Number(c.massOutageMinHosts) >= 2 ? Number(c.massOutageMinHosts) : 3,
            massOutageWindowMinutes: Number(c.massOutageWindowMinutes) > 0 ? Number(c.massOutageWindowMinutes) : 10,
            massOutageMaxAgeHours: Number(c.massOutageMaxAgeHours) > 0 ? Number(c.massOutageMaxAgeHours) : 24,   // queda mais antiga que isso não vira card
            massOutageMinHostsByLocality: Object.fromEntries(Object.entries(c.massOutageMinHostsByLocality || {})
                .filter(([, value]) => Number(value) >= 2).map(([code, value]) => [String(code).toUpperCase(), Number(value)])),
            massOutageIgnoreHostPatterns: Array.isArray(c.massOutageIgnoreHostPatterns) ? c.massOutageIgnoreHostPatterns.map(String) : [],
            decommissionedLocalities: Array.isArray(c.decommissionedLocalities) ? c.decommissionedLocalities.map(code => String(code).toUpperCase()) : [],
            aging: c.aging || {}
        };
    }

    injectStyles() {
        if (document.getElementById('zabbix-dashboard-extra-style')) return;
        const style = document.createElement('style');
        style.id = 'zabbix-dashboard-extra-style';
        style.textContent = `
            #dashboard-zabbix-section #zabbix-kpis.zabbix-kpis { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 24px; }
            #dashboard-zabbix-section .zabbix-kpi-group { display: flex; flex-wrap: wrap; gap: 8px; }
            #dashboard-zabbix-section .zabbix-kpi-group .zabbix-kpi { flex: 0 0 auto; min-width: 96px; }
            #dashboard-zabbix-section .zabbix-chip { margin-left: 6px; padding: 2px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); color: var(--foreground); font-size: 11px; cursor: pointer; }
            #dashboard-zabbix-section .zabbix-chip:hover { background: var(--muted); }
            #dashboard-zabbix-section .zabbix-ticket-missing.is-warning { color: #b4690e; }
            #dashboard-zabbix-section .zabbix-stale-item > span:first-child { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; overflow-wrap: anywhere; }
            #dashboard-zabbix-section { padding-right: 56px; }
            #dashboard-zabbix-section .zabbix-day-divider { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; margin: 10px 0 2px; color: var(--primary); font-size: 12px; font-weight: 700; }
            #dashboard-zabbix-section .zabbix-day-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
            #dashboard-zabbix-section .zabbix-incident { --zbx-base: var(--card); }
            #dashboard-zabbix-section .zabbix-incident.zabbix-tinted { --zbx-base: color-mix(in srgb, var(--severity-color) 10%, var(--card)); background: var(--zbx-base); }
            #dashboard-zabbix-section .zabbix-incident-main > * { min-width: 0; }
            #dashboard-zabbix-section .zabbix-host-cell { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 7px; }
            #dashboard-zabbix-section .zabbix-host-link { max-width: 100%; color: inherit; line-height: 1.25; white-space: normal; overflow-wrap: anywhere; }
            #dashboard-zabbix-section .zabbix-incident-problem { display: block; overflow: visible; line-height: 1.3; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; -webkit-line-clamp: none; }
            #dashboard-zabbix-section .zabbix-state-badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; justify-self: start; }
            #dashboard-zabbix-section .zabbix-datetime { display: flex; flex-direction: column; gap: 1px; line-height: 1.2; white-space: nowrap; }
            #dashboard-zabbix-section .zabbix-datetime-date { color: var(--muted-foreground); font-size: 12px; font-weight: 600; }
            #dashboard-zabbix-section .zabbix-datetime-time { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
            #dashboard-zabbix-section .zabbix-ack-cell { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; max-width: 100%; }
            #dashboard-zabbix-section .zabbix-ack-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; color: var(--foreground); font-size: 12px; line-height: 1.3; overflow-wrap: anywhere; }
            #dashboard-zabbix-section .zabbix-child-state { overflow: hidden; text-overflow: ellipsis; }
            #dashboard-zabbix-section .zabbix-sector-tag { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 3px; color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
            #dashboard-zabbix-section .zabbix-sector-tag i { font-size: 9px; }
            #dashboard-zabbix-section .zabbix-new-badge { flex: 0 0 auto; padding: 2px 6px; border-radius: 3px; color: #fff; background: var(--severity-color); font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
            #dashboard-zabbix-section .zabbix-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
            @keyframes zbxPulse {
                0%, 100% { background-color: var(--zbx-base); box-shadow: inset 0 0 0 0 transparent; }
                50% { background-color: color-mix(in srgb, var(--severity-color) 34%, var(--card)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--severity-color) 55%, transparent); }
            }
            #dashboard-zabbix-section .zabbix-group-pill { flex: 0 0 auto; padding: 1px 7px; border: 1px solid var(--severity-color); border-radius: 999px; color: var(--severity-color); font-size: 10px; font-weight: 700; }
            #dashboard-zabbix-section .zabbix-children { display: grid; gap: 4px; margin: 8px 0 6px; padding: 0; list-style: none; }
            #dashboard-zabbix-section .zabbix-child { display: grid; grid-template-columns: 74px minmax(0, 1fr) 96px minmax(110px, 220px) auto; gap: 10px; align-items: center; padding: 5px 8px; border-left: 3px solid var(--severity-color); background: color-mix(in srgb, var(--card) 88%, var(--muted)); font-size: 12px; }
            #dashboard-zabbix-section .zabbix-child-sev { font-weight: 700; color: var(--severity-color); }
            #dashboard-zabbix-section .zabbix-child-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #dashboard-zabbix-section .zabbix-child-time, #dashboard-zabbix-section .zabbix-child-state { color: var(--muted-foreground); white-space: nowrap; }
            #dashboard-zabbix-section .zabbix-child-actions { display: flex; gap: 6px; }
            #dashboard-zabbix-section .zabbix-locality-panel { margin: 10px 0 12px; }
            #dashboard-zabbix-section .zabbix-locality-title { margin-bottom: 6px; color: var(--muted-foreground); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
            #dashboard-zabbix-section .zabbix-loc-list { display: flex; flex-wrap: wrap; gap: 6px; }
            #dashboard-zabbix-section .zabbix-loc-chip { display: inline-flex; align-items: center; gap: 7px; padding: 4px 9px; border: 1px solid var(--border); border-left: 3px solid var(--loc-color); border-radius: 4px; background: var(--card); color: var(--foreground); font-size: 12px; font-weight: 600; cursor: pointer; }
            #dashboard-zabbix-section .zabbix-loc-chip:hover { background: var(--muted); }
            #dashboard-zabbix-section .zabbix-loc-chip.is-active { outline: 2px solid var(--loc-color); outline-offset: 1px; }
            #dashboard-zabbix-section .zabbix-loc-chip.is-decom { border-style: dashed; border-left-style: solid; }
            #dashboard-zabbix-section .zabbix-loc-chip.is-clear { opacity: .55; font-weight: 500; }
            #dashboard-zabbix-section .zabbix-loc-count { min-width: 18px; padding: 0 6px; border-radius: 999px; background: var(--loc-color); color: #fff; font-size: 11px; font-weight: 700; text-align: center; }
            #dashboard-zabbix-section .zabbix-outage-panel { display: grid; gap: 8px; margin: 10px 0; }
            #dashboard-zabbix-section .zabbix-outage-panel:empty { display: none; }
            #dashboard-zabbix-section .zabbix-outage { display: grid; gap: 7px; padding: 10px 14px; border: 1px solid color-mix(in srgb, #c83e4d 40%, var(--border)); border-left: 4px solid #c83e4d; border-radius: 4px; background: color-mix(in srgb, #c83e4d 8%, var(--card)); }
            #dashboard-zabbix-section .zabbix-outage.is-acknowledged { border-left-color: #c89b26; background: var(--card); }
            #dashboard-zabbix-section .zabbix-outage-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 13px; }
            #dashboard-zabbix-section .zabbix-outage-head i { color: #c83e4d; }
            #dashboard-zabbix-section .zabbix-outage.is-acknowledged .zabbix-outage-head i { color: #c89b26; }
            #dashboard-zabbix-section .zabbix-outage-head span { color: var(--muted-foreground); }
            #dashboard-zabbix-section .zabbix-outage-state { margin-left: auto; font-weight: 700; color: #c83e4d !important; }
            #dashboard-zabbix-section .zabbix-outage.is-acknowledged .zabbix-outage-state { color: #b4690e !important; }
            #dashboard-zabbix-section .zabbix-outage-hosts { display: flex; flex-wrap: wrap; gap: 5px; }
            #dashboard-zabbix-section .zabbix-outage-host { padding: 1px 7px; border: 1px solid var(--border); border-radius: 3px; background: var(--card); font-size: 11px; }
            #dashboard-zabbix-section .zabbix-outage-host.is-more { color: var(--muted-foreground); }
            #dashboard-zabbix-section .zabbix-outage-actions { display: flex; gap: 8px; }
            @keyframes zbxEnter { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
            @media (prefers-reduced-motion: reduce) {
                #dashboard-zabbix-section .zabbix-incident { animation: none !important; }
                #dashboard-zabbix-section .zabbix-incident.zabbix-new { background-color: color-mix(in srgb, var(--severity-color) 24%, var(--card)); }
            }
            @media (min-width: 1200px) {
                #dashboard-zabbix-section .zabbix-is-list .zabbix-incident-main { grid-template-columns: minmax(150px, 1fr) minmax(200px, 1.6fr) 190px 92px 108px minmax(150px, 1.1fr) 112px; }
            }
        `;
        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------- init
    init() {
        this.injectStyles();

        // Botão "Ocultar crônicos" (criado aqui para não depender do HTML)
        const controls = document.querySelector('.zabbix-view-controls');
        const oldestBtn = document.getElementById('btn-zabbix-oldest');
        if (controls && !document.getElementById('btn-zabbix-chronic')) {
            const chronicBtn = document.createElement('button');
            chronicBtn.id = 'btn-zabbix-chronic';
            chronicBtn.type = 'button';
            chronicBtn.className = 'btn btn-outline';
            chronicBtn.title = 'Esconder da lista os incidentes com ACK antigo (backlog crônico)';
            controls.insertBefore(chronicBtn, oldestBtn ? oldestBtn.nextSibling : controls.firstChild);
        }
        if (controls && !document.getElementById('btn-zabbix-group')) {
            const groupBtn = document.createElement('button');
            groupBtn.id = 'btn-zabbix-group';
            groupBtn.type = 'button';
            groupBtn.className = 'btn btn-outline';
            groupBtn.title = 'Juntar em uma linha os alarmes do mesmo host em um intervalo curto';
            const chronicRef = document.getElementById('btn-zabbix-chronic');
            controls.insertBefore(groupBtn, chronicRef ? chronicRef.nextSibling : controls.firstChild);
        }
        document.getElementById('btn-zabbix-group')?.addEventListener('click', () => {
            this.groupByHost = !this.groupByHost;
            localStorage.setItem('zabbixGroupByHost', this.groupByHost ? '1' : '0');
            this.render(true);
        });
        // Painéis criados aqui (não dependem do HTML): queda de site (acima do bloco "Parados") e localidades (abaixo dele)
        const stalePanel = document.getElementById('zabbix-stale-panel');
        if (stalePanel && stalePanel.parentNode) {
            if (!document.getElementById('zabbix-outage-panel')) {
                const outagePanel = document.createElement('section');
                outagePanel.id = 'zabbix-outage-panel';
                outagePanel.className = 'zabbix-outage-panel';
                outagePanel.setAttribute('aria-live', 'polite');
                stalePanel.parentNode.insertBefore(outagePanel, stalePanel);
            }
            if (!document.getElementById('zabbix-locality-panel')) {
                const localityPanel = document.createElement('section');
                localityPanel.id = 'zabbix-locality-panel';
                localityPanel.className = 'zabbix-locality-panel';
                localityPanel.setAttribute('aria-label', 'Filtro por localidade');
                stalePanel.parentNode.insertBefore(localityPanel, stalePanel.nextSibling);
            }
        }
        document.getElementById('zabbix-outage-panel')?.addEventListener('click', event => this.onOutageClick(event));
        document.getElementById('zabbix-locality-panel')?.addEventListener('click', event => {
            const chip = event.target.closest('[data-loc]');
            if (!chip) return;
            this.localityFilter = this.localityFilter === chip.dataset.loc ? null : chip.dataset.loc;
            this.render(true);
        });
        document.getElementById('btn-zabbix-chronic')?.addEventListener('click', () => {
            this.hideChronic = !this.hideChronic;
            localStorage.setItem('zabbixHideChronic', this.hideChronic ? '1' : '0');
            if (this.hideChronic && this.stateFilter === 'chronic') this.stateFilter = 'all';
            this.render(true);
        });

        // 1. Atualização manual
        document.getElementById('btn-zabbix-refresh')?.addEventListener('click', event => {
            event.currentTarget.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            this.fetchProblems();
        });

        // 2. Abas de setor
        const tabButtons = document.querySelectorAll('.tab-btn');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', event => {
                tabButtons.forEach(b => b.classList.remove('active'));
                event.currentTarget.classList.add('active');
                this.currentTab = event.currentTarget.dataset.setor;
                this.lastSignature = null;
                this.seenIds = null;
                const grid = document.getElementById('zabbix-cards-grid');
                if (grid) grid.innerHTML = '<div class="zabbix-loading-state"><i class="fa-solid fa-spinner fa-spin fa-2x"></i></div>';
                this.fetchProblems();
            });
        });

        // 3. Visualização grade/lista
        document.getElementById('btn-view-grid')?.addEventListener('click', () => {
            if (currentViewMode === 'grid') return;
            currentViewMode = 'grid';
            localStorage.setItem('zabbixViewMode', 'grid');
            this.render(true);
        });
        document.getElementById('btn-view-list')?.addEventListener('click', () => {
            if (currentViewMode === 'list') return;
            currentViewMode = 'list';
            localStorage.setItem('zabbixViewMode', 'list');
            this.render(true);
        });

        // 4. Busca e ordenação
        document.getElementById('zabbix-search')?.addEventListener('input', event => {
            this.searchTerm = event.currentTarget.value.trim().toLocaleLowerCase('pt-BR');
            this.render(true);
        });
        document.getElementById('btn-zabbix-oldest')?.addEventListener('click', event => {
            this.oldestFirst = !this.oldestFirst;
            event.currentTarget.setAttribute('aria-pressed', String(this.oldestFirst));
            event.currentTarget.classList.toggle('active', this.oldestFirst);
            this.render(true);
        });

        // 5. Delegação de eventos (um listener por área, em vez de um por botão)
        document.getElementById('zabbix-cards-grid')?.addEventListener('click', event => this.onGridClick(event));
        document.getElementById('zabbix-kpis')?.addEventListener('click', event => this.onKpiClick(event));
        document.getElementById('zabbix-stale-panel')?.addEventListener('click', event => {
            if (event.target.closest('.zabbix-stale-filter')) {
                this.stateFilter = 'stale';
                this.selectedEventIds = [];
                this.render(true);
                return;
            }
            const item = event.target.closest('[data-stale-event]');
            if (item) {
                this.selectedEventIds = [item.dataset.staleEvent];
                this.render(true);
            }
        });

        // 6. Menu de contexto do host
        document.addEventListener('click', event => {
            const hostLink = event.target.closest('.host-clickable');
            const contextMenu = document.getElementById('zabbix-context-menu');
            if (!hostLink && !event.target.closest('#zabbix-context-menu')) {
                if (contextMenu) contextMenu.style.display = 'none';
                return;
            }
            if (!hostLink) return;
            event.preventDefault();
            if (!contextMenu) return;
            const clickedHost = hostLink.getAttribute('data-host');
            contextMenu.style.left = `${event.pageX}px`;
            contextMenu.style.top = `${event.pageY + 10}px`;
            contextMenu.style.display = 'block';
            const historyBtn = document.getElementById('menu-view-history');
            if (historyBtn) {
                historyBtn.onclick = ev => {
                    ev.preventDefault();
                    contextMenu.style.display = 'none';
                    showHostHistory(clickedHost);
                };
            }
            const filterBtn = document.getElementById('menu-filter-incidents');
            if (filterBtn) {
                filterBtn.onclick = ev => {
                    ev.preventDefault();
                    this.hostFilter = clickedHost;
                    contextMenu.style.display = 'none';
                    this.render(true);
                };
            }
        });

        this.fetchProblems();
        this.intervalId = setInterval(() => this.fetchProblems(), this.settings.refreshSeconds * 1000);
    }

    // --------------------------------------------------------------- eventos
    onGridClick(event) {
        const target = event.target;
        const ackGroup = target.closest('.btn-ack-group');
        if (ackGroup) {
            const ids = String(ackGroup.dataset.eventids || '').split(',').filter(Boolean);
            this.promptAck(ids.join(','), ackGroup.dataset.host, `${ids.length} alarme${ids.length > 1 ? 's' : ''} neste host`);
            return;
        }
        const ack = target.closest('.btn-ack');
        if (ack) { this.promptAck(ack.dataset.eventid, ack.dataset.host, ack.dataset.trigger); return; }
        const details = target.closest('.btn-details-trigger');
        if (details) { this.showDetailsModal(details.dataset); return; }
        const history = target.closest('.btn-host-history-trigger');
        if (history) { if (typeof showHostHistory === 'function') showHostHistory(history.dataset.host); return; }
        const clear = target.closest('[data-clear]');
        if (clear) {
            const what = clear.dataset.clear;
            if (what === 'severity') this.severityFilter = null;
            if (what === 'state') this.stateFilter = 'all';
            if (what === 'host') this.hostFilter = null;
            if (what === 'locality') this.localityFilter = null;
            if (what === 'event') this.selectedEventIds = [];
            this.render(true);
            return;
        }
        if (target.closest('#btn-zabbix-reset-filters') || target.closest('#btn-zabbix-clear-filter')) {
            this.resetFilters();
            return;
        }
        if (target.closest('#btn-zabbix-error-retry')) this.fetchProblems();
    }

    resetFilters() {
        this.severityFilter = null;
        this.stateFilter = 'all';
        this.selectedEventIds = [];
        this.hostFilter = null;
        this.localityFilter = null;
        this.searchTerm = '';
        const search = document.getElementById('zabbix-search');
        if (search) search.value = '';
        this.render(true);
    }

    onKpiClick(event) {
        const tile = event.target.closest('[data-kpi]');
        if (!tile) return;
        const kind = tile.dataset.kpi;
        const value = tile.dataset.value;
        if (kind === 'severity') {
            const severity = Number(value);
            this.severityFilter = this.severityFilter === severity ? null : severity;
        } else if (kind === 'state') {
            this.stateFilter = this.stateFilter === value ? 'all' : value;
        } else if (kind === 'event') {
            const ids = (tile.dataset.eventIds || '').split(',').filter(Boolean);
            this.selectedEventIds = this.selectedEventIds.join() === ids.join() ? [] : ids;
        }
        this.render(true);
    }

    // ------------------------------------------------------------------ dados
    normalizePayload(payload) {
        if (Array.isArray(payload)) return { problems: payload, serverTime: null, totalHosts: null, hiddenInformativeCount: null };
        const list = payload && (payload.problems || payload.data || payload.items);
        if (!Array.isArray(list)) throw new Error('O Zabbix enviou dados em um formato desconhecido.');
        return {
            problems: list,
            serverTime: this.toSeconds(payload.serverTime),
            totalHosts: Number(payload.totalHosts) > 0 ? Number(payload.totalHosts) : null,
            hiddenInformativeCount: Number.isFinite(Number(payload.hiddenInformativeCount)) ? Number(payload.hiddenInformativeCount) : null
        };
    }

    toSeconds(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);   // aceita epoch em ms ou em s
    }

    async fetchProblems() {
        if (this.fetching) return;
        this.fetching = true;
        const tab = this.currentTab;
        const refreshBtn = document.getElementById('btn-zabbix-refresh');
        try {
            const payload = await apiRequest(`/api/zabbix/problems?setor=${encodeURIComponent(tab)}`, 'GET', null, true);
            if (tab !== this.currentTab) return;   // a aba mudou durante a consulta
            const { problems, serverTime, totalHosts, hiddenInformativeCount } = this.normalizePayload(payload);
            this.totalHosts = totalHosts;
            if (serverTime) this.serverOffset = serverTime - Math.floor(Date.now() / 1000);
            this.hiddenInformative = hiddenInformativeCount !== null
                ? hiddenInformativeCount
                : problems.filter(problem => Number(problem.severity) === 1).length;
            problemasEmCache = problems;
            this.lastUpdatedAt = new Date();

            const signature = this.computeSignature(problems);
            const minute = Math.floor(this.nowSeconds() / 60);
            if (signature === this.lastSignature && minute === this.lastMinute) {
                this.updateStatusLabel();      // nada mudou: não recria a lista
            } else {
                this.lastSignature = signature;
                this.lastMinute = minute;
                this.render(true);
            }
        } catch (error) {
            this.showFetchError(error);
        } finally {
            this.fetching = false;
            if (refreshBtn) refreshBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Atualizar';
        }
    }

    computeSignature(problems) {
        let hash = 5381;
        const text = problems.map(p => `${p.eventid}:${p.acknowledged}:${(p.acknowledges || []).length}:${p.severity}:${p.name}`).join('|');
        for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
        return `${problems.length}:${hash}`;
    }

    showFetchError(error) {
        const updated = document.getElementById('zabbix-last-updated');
        const hasData = Array.isArray(problemasEmCache) && problemasEmCache.length > 0 && this.lastUpdatedAt;
        if (updated) {
            updated.textContent = this.lastUpdatedAt
                ? `Última atualização válida: ${this.lastUpdatedAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · falha na atualização`
                : 'Aguardando conexão com o Zabbix';
            updated.classList.add('is-stale');
        }
        if (hasData) return;   // mantém a lista anterior na tela (importante em wallboard)
        const grid = document.getElementById('zabbix-cards-grid');
        if (grid) {
            grid.innerHTML = `
                <div class="zabbix-empty-state zabbix-empty-error" role="alert">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                    <h3>Falha de comunicação com o Zabbix</h3>
                    <p>${this.escapeHtml(error.message || 'Não foi possível carregar os incidentes.')}</p>
                    <button class="btn btn-outline" type="button" id="btn-zabbix-error-retry">Tentar novamente</button>
                </div>`;
        }
    }

    // ---------------------------------------------------------------- utilitários
    nowSeconds() {
        return Math.floor(Date.now() / 1000) + this.serverOffset;
    }

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    formatDuration(totalSeconds) {
        let seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const days = Math.floor(seconds / 86400);
        seconds %= 86400;
        const hours = Math.floor(seconds / 3600);
        seconds %= 3600;
        const minutes = Math.floor(seconds / 60);
        const parts = [];
        if (days) parts.push(`${days}d`);
        if (hours) parts.push(`${hours}h`);
        if (minutes || parts.length === 0) parts.push(`${minutes}m`);
        return parts.join(' ');
    }

    parseOperator(message) {
        const text = String(message || '');
        const match = text.match(/\|\s*operador:\s*([^|\n]+?)\s*$/i) || text.match(/operador:\s*([^|\n]+)/i);
        return match ? match[1].trim() : '';
    }

    ackActorName(ack) {
        if (!ack) return 'Operador NOC';
        return this.parseOperator(ack.message) || ack.userName || (ack.userid ? `Usuário ${ack.userid}` : 'Operador NOC');
    }

    getAgeClass(seconds, thresholds, unit = 1) {
        if (!thresholds) return 'age-fresh';
        if (Number(thresholds.severe) > 0 && seconds >= Number(thresholds.severe) * unit) return 'age-severe';
        if (Number(thresholds.critical) > 0 && seconds >= Number(thresholds.critical) * unit) return 'age-critical';
        if (Number(thresholds.warning) > 0 && seconds >= Number(thresholds.warning) * unit) return 'age-warning';
        return 'age-fresh';
    }

    // Mensagem do ACK: "[número] [texto livre] | operador: nome". O número (opcional) fica no início.
    parseAckMessage(message, ticketRegex) {
        const body = String(message || '').replace(/\s*\|\s*operador:[^|]*$/i, '').trim();
        const match = body.match(ticketRegex);
        if (!match) return { ticket: '', text: body };
        const ticket = match[0].replace(/^\s*CH-?/i, '').trim();
        const text = body.search(ticketRegex) === 0
            ? body.slice(match[0].length).replace(/^[\s\-–—:;,.|]+/, '').trim()
            : body;
        return { ticket, text };
    }

    getTicketRegex(pattern) {
        if (this._ticketRegexSource !== pattern) {
            try { this._ticketRegex = new RegExp(pattern, 'i'); }
            catch (error) { this._ticketRegex = /^\s*(?:CH-?)?\d{3,}/i; }
            this._ticketRegexSource = pattern;
        }
        return this._ticketRegex;
    }

    getIncidentInfo(problem, nowSeconds) {
        const settings = this.settings;
        const acknowledges = (Array.isArray(problem.acknowledges) ? [...problem.acknowledges] : [])
            .sort((a, b) => Number(a.clock || 0) - Number(b.clock || 0));
        const acknowledged = String(problem.acknowledged) === '1' || problem.acknowledged === true || acknowledges.length > 0;
        const eventClock = Number(problem.clock) || nowSeconds;
        const timedAcks = acknowledges.filter(ack => Number(ack.clock) > 0);
        const firstAck = timedAcks[0] || null;
        const latestAck = timedAcks.length ? timedAcks[timedAcks.length - 1] : (acknowledges[acknowledges.length - 1] || null);
        const firstAckClock = firstAck ? Number(firstAck.clock) : null;
        const latestAckClock = timedAcks.length ? Number(timedAcks[timedAcks.length - 1].clock) : null;
        const noAckSeconds = Math.max(0, (acknowledged && firstAckClock ? firstAckClock : nowSeconds) - eventClock);
        const totalOpenSeconds = Math.max(0, nowSeconds - eventClock);
        const ticketRegex = this.getTicketRegex(settings.ticketPattern);
        const parsedAcks = [...acknowledges].reverse().map(ack => this.parseAckMessage(ack.message, ticketRegex));   // mais recente primeiro
        const ticket = parsedAcks.map(parsed => parsed.ticket).find(Boolean) || '';
        const ackText = parsedAcks.length ? parsedAcks[0].text : '';   // texto livre do ACK mais recente
        const sinceLastAck = latestAckClock ? Math.max(0, nowSeconds - latestAckClock) : null;
        const chronicLimit = settings.chronicDays * 86400;
        const chronic = acknowledged
            ? sinceLastAck !== null && sinceLastAck > chronicLimit
            : settings.chronicIncludesUnacked && totalOpenSeconds > chronicLimit;
        const stale = acknowledged && sinceLastAck !== null && sinceLastAck > settings.staleHours * 3600 && !chronic;
        return {
            acknowledged, acknowledges, firstAck, latestAck, firstAckClock, latestAckClock,
            noAckSeconds, totalOpenSeconds, sinceLastAck, ticket, ackText, chronic, stale,
            noTicket: acknowledged && !ticket
        };
    }

    // ------------------------------------------------------------------- filtros
    matchesFilters({ problem, info, locality }) {
        if (this.localityFilter && (locality || '__none') !== this.localityFilter) return false;
        if (this.hostFilter && problem.hostName !== this.hostFilter) return false;
        if (this.severityFilter !== null && Number(problem.severity) !== this.severityFilter) return false;
        if (this.selectedEventIds.length && !this.selectedEventIds.includes(String(problem.eventid))) return false;
        switch (this.stateFilter) {
            case 'untreated': if (info.acknowledged) return false; break;
            case 'treated': if (!info.acknowledged) return false; break;
            case 'availability': if (!this.isAvailabilityProblem(problem)) return false; break;
            case 'no-ticket': if (!info.noTicket) return false; break;
            case 'stale': if (!info.stale) return false; break;
            case 'chronic': if (!info.chronic) return false; break;
            default: break;
        }
        if (this.searchTerm) {
            const searchable = `${problem.hostName || ''} ${problem.name || ''} ${info.ticket} ${info.ackText || ''} ${locality || ''}`.toLocaleLowerCase('pt-BR');
            if (!searchable.includes(this.searchTerm)) return false;
        }
        return true;
    }

    isTimeSort() {
        return this.oldestFirst || this.settings.defaultSort !== 'priority';
    }

    sortItems(items) {
        const clockOf = item => Number(item.problem.clock || 0);
        const idOf = item => Number(item.problem.eventid || 0);
        if (this.oldestFirst) {
            return items.sort((a, b) => clockOf(a) - clockOf(b) || idOf(a) - idOf(b));
        }
        if (this.settings.defaultSort === 'priority') {
            // opcional: sem tratativa primeiro, depois severidade, depois o mais antigo
            return items.sort((a, b) =>
                Number(a.info.acknowledged) - Number(b.info.acknowledged)
                || Number(b.problem.severity) - Number(a.problem.severity)
                || clockOf(a) - clockOf(b));
        }
        // padrão: mesma ordem do Zabbix (mais recentes primeiro)
        return items.sort((a, b) => clockOf(b) - clockOf(a) || idOf(b) - idOf(a));
    }

    dayKey(clock) {
        return new Date(Number(clock) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    }

    formatDateParts(clock) {
        if (!Number(clock)) return { date: '—', time: '' };
        const moment = new Date(Number(clock) * 1000);
        return {
            date: moment.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }),
            time: moment.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        };
    }

    dayLabel(clock, todayKey, yesterdayKey) {
        const key = this.dayKey(clock);
        if (key === todayKey) return 'Hoje';
        if (key === yesterdayKey) return 'Ontem';
        return new Date(Number(clock) * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    }

    // -------------------------------------------------------------------- render
    captureViewState(grid) {
        const scroller = document.scrollingElement;
        const main = document.getElementById('main-content');
        return {
            open: new Set([...grid.querySelectorAll('details[open][data-event]')].map(item => item.dataset.event)),
            top: scroller ? scroller.scrollTop : 0,
            mainTop: main ? main.scrollTop : 0
        };
    }

    restoreViewState(state) {
        const scroller = document.scrollingElement;
        const main = document.getElementById('main-content');
        if (scroller) scroller.scrollTop = state.top;
        if (main) main.scrollTop = state.mainTop;
    }

    renderCards(problems) {
        if (Array.isArray(problems)) problemasEmCache = problems;
        this.render(true);
    }

    render() {
        const grid = document.getElementById('zabbix-cards-grid');
        if (!grid) return;
        const problems = Array.isArray(problemasEmCache) ? problemasEmCache : [];
        const now = this.nowSeconds();
        const settings = this.settings;
        const viewState = this.captureViewState(grid);

        const visible = problems.filter(problem => Number(problem.severity) !== 1);
        const localityContext = this.getLocalityContext();
        const allItems = visible.map(problem => ({ problem, info: this.getIncidentInfo(problem, now), locality: this.resolveLocality(problem, localityContext) }));
        const chronicItems = allItems.filter(item => item.info.chronic);
        const hideChronicNow = this.hideChronic && this.stateFilter !== 'chronic';
        const baseItems = hideChronicNow ? allItems.filter(item => !item.info.chronic) : allItems;

        this.renderKpis(baseItems, chronicItems.length, now, allItems);
        this.renderOutagePanel(allItems, now);
        this.renderLocalityPanel(baseItems);
        this.renderStalePanel(allItems, now);
        this.updateChronicButton(chronicItems.length);
        this.updateGroupButton();

        const filtered = this.sortItems(baseItems.filter(item => this.matchesFilters(item)));
        const rows = this.groupByHost
            ? this.buildGroups(filtered)
            : filtered.map(item => ({ items: [item], leader: item, info: item.info, tickets: item.info.ticket ? [item.info.ticket] : [], sortClock: Number(item.problem.clock) || 0 }));
        const hostCount = new Set(baseItems.map(item => item.problem.hostName || `#${item.problem.eventid}`)).size;
        this.lastCounts = { shown: filtered.length, base: baseItems.length, hosts: hostCount, rows: rows.length, chronicHidden: hideChronicNow ? chronicItems.length : 0 };
        this.updateStatusLabel();
        grid.classList.toggle('zabbix-is-list', currentViewMode === 'list');

        const enterIds = new Set();
        if (this.seenIds) allItems.forEach(item => { if (!this.seenIds.has(String(item.problem.eventid))) enterIds.add(String(item.problem.eventid)); });
        this.seenIds = new Set(allItems.map(item => String(item.problem.eventid)));

        if (!filtered.length) {
            const hasIncidents = baseItems.length > 0;
            grid.innerHTML = `<div class="zabbix-empty-state"><i class="fa-solid ${hasIncidents ? 'fa-filter-circle-xmark' : 'fa-circle-check'}" aria-hidden="true"></i><h3>${hasIncidents ? 'Nenhum incidente corresponde a este filtro' : `Nenhum incidente ativo em ${this.escapeHtml(this.currentTab)}`}</h3><p>${hasIncidents ? 'Limpe o filtro ou ajuste a busca.' : 'O ambiente está limpo.'}</p>${hasIncidents ? '<button id="btn-zabbix-clear-filter" class="btn btn-outline" type="button">Limpar filtros</button>' : ''}</div>`;
            return;
        }

        const aging = settings.aging;
        const ctx = { now, enterIds };
        const withDays = this.isTimeSort();
        const todayKey = this.dayKey(now);
        const yesterdayKey = this.dayKey(now - 86400);
        let lastDay = null;
        grid.innerHTML = this.renderFilterBanner() + rows.map(row => {
            let divider = '';
            if (withDays && row.sortClock) {
                const key = this.dayKey(row.sortClock);
                if (key !== lastDay) {
                    lastDay = key;
                    divider = `<div class="zabbix-day-divider">${this.escapeHtml(this.dayLabel(row.sortClock, todayKey, yesterdayKey))}</div>`;
                }
            }
            const html = row.items.length > 1
                ? this.renderIncident(row.leader.problem, row.info, aging, viewState.open, ctx, row)
                : this.renderIncident(row.leader.problem, row.leader.info, aging, viewState.open, ctx);
            return divider + html;
        }).join('');
        this.restoreViewState(viewState);
    }

    // ------------------------------------------------------------ agrupamento por host
    buildGroups(items) {
        const windowSeconds = this.settings.groupWindowMinutes * 60;
        const clockOf = item => Number(item.problem.clock || 0);
        const byHost = new Map();
        items.forEach(item => {
            const key = item.problem.hostName || `#${item.problem.eventid}`;   // sem nome de host: não agrupa
            if (!byHost.has(key)) byHost.set(key, []);
            byHost.get(key).push(item);
        });
        const groups = [];
        byHost.forEach(list => {
            list.sort((a, b) => clockOf(a) - clockOf(b));
            let current = null;
            list.forEach(item => {
                if (current && clockOf(item) - current.lastClock <= windowSeconds) {
                    current.items.push(item);
                    current.lastClock = clockOf(item);
                } else {
                    current = { items: [item], lastClock: clockOf(item) };
                    groups.push(current);
                }
            });
        });
        groups.forEach(group => this.finalizeGroup(group));
        return this.sortGroups(groups);
    }

    finalizeGroup(group) {
        const items = group.items;
        const clockOf = item => Number(item.problem.clock || 0);
        const unacked = items.filter(item => !item.info.acknowledged);
        const pool = unacked.length ? unacked : items;
        // alarme em destaque: o de maior severidade (empate: o mais antigo)
        const leader = pool.reduce((best, item) => (
            Number(item.problem.severity) > Number(best.problem.severity)
            || (Number(item.problem.severity) === Number(best.problem.severity) && clockOf(item) < clockOf(best)) ? item : best), pool[0]);
        const tickets = [...new Set(items.map(item => item.info.ticket).filter(Boolean))];
        const latestAckItem = items.filter(item => item.info.latestAckClock).sort((a, b) => b.info.latestAckClock - a.info.latestAckClock)[0] || null;
        const maxOf = (list, field) => list.reduce((max, item) => Math.max(max, item.info[field]), 0);
        group.leader = leader;
        group.tickets = tickets;
        group.minClock = Math.min(...items.map(clockOf));
        group.maxClock = Math.max(...items.map(clockOf));
        group.minEventId = Math.min(...items.map(item => Number(item.problem.eventid) || 0));
        group.info = {
            ...leader.info,
            acknowledged: unacked.length === 0,
            noAckSeconds: unacked.length ? maxOf(unacked, 'noAckSeconds') : maxOf(items, 'noAckSeconds'),
            totalOpenSeconds: maxOf(items, 'totalOpenSeconds'),
            ticket: tickets[0] || '',
            ackText: latestAckItem ? latestAckItem.info.ackText : leader.info.ackText,
            noTicket: unacked.length === 0 && tickets.length === 0,
            latestAck: latestAckItem ? latestAckItem.info.latestAck : leader.info.latestAck,
            latestAckClock: latestAckItem ? latestAckItem.info.latestAckClock : leader.info.latestAckClock
        };
    }

    sortGroups(groups) {
        const severityOf = group => Number(group.leader.problem.severity);
        if (this.oldestFirst) {
            groups.forEach(group => { group.sortClock = group.minClock; });
            return groups.sort((a, b) => a.minClock - b.minClock || a.minEventId - b.minEventId);
        }
        if (this.settings.defaultSort === 'priority') {
            groups.forEach(group => { group.sortClock = group.minClock; });
            return groups.sort((a, b) =>
                Number(a.info.acknowledged) - Number(b.info.acknowledged)
                || severityOf(b) - severityOf(a)
                || a.minClock - b.minClock);
        }
        groups.forEach(group => { group.sortClock = group.maxClock; });   // igual ao Zabbix: pelo alarme mais recente
        return groups.sort((a, b) => b.maxClock - a.maxClock || b.minEventId - a.minEventId);
    }

    updateGroupButton() {
        const button = document.getElementById('btn-zabbix-group');
        if (!button) return;
        button.setAttribute('aria-pressed', String(this.groupByHost));
        button.classList.toggle('active', this.groupByHost);
        button.innerHTML = `<i class="fa-solid fa-layer-group"></i> ${this.groupByHost ? 'Agrupado por host' : 'Agrupar por host'}`;
    }

    // ---------------------------------------------------------------- localidades
    getLocalityContext() {
        const settings = this.settings;
        const key = JSON.stringify([settings.localities, settings.localityRules]);
        if (this._localityKey !== key) {
            this._localityKey = key;
            this._localityCodes = new Set(settings.localities);
            this._localityRules = settings.localityRules.map(rule => {
                try { return { regex: new RegExp(rule.pattern, 'i'), locality: String(rule.locality).toUpperCase() }; }
                catch (error) { return null; }
            }).filter(Boolean);
            this._localityCache = new Map();
        }
        return { codes: this._localityCodes, rules: this._localityRules, cache: this._localityCache };
    }

    // Ordem: regras por nome (SPOLM*, SPOTLK*...) > código no nome do host (separado por - _ . ) > grupos de hosts
    resolveLocality(problem, context = this.getLocalityContext()) {
        const host = String(problem.hostName || '').trim();
        const groups = Array.isArray(problem.hostGroups) ? problem.hostGroups.map(group => String(group).trim().toUpperCase()) : [];
        const cacheKey = `${host}|${groups.join('|')}`;
        if (context.cache.has(cacheKey)) return context.cache.get(cacheKey);
        const lastCode = text => {
            const hits = text.toUpperCase().split(/[^A-Z0-9]+/).filter(token => context.codes.has(token));
            return hits.length ? hits[hits.length - 1] : null;
        };
        const rule = context.rules.find(item => item.regex.test(host));
        let found = rule ? rule.locality : null;
        if (!found) found = lastCode(host);
        if (!found) found = groups.find(group => context.codes.has(group)) || null;
        if (!found) { for (const group of groups) { found = lastCode(group); if (found) break; } }
        if (context.cache.size > 5000) context.cache.clear();
        context.cache.set(cacheKey, found);
        return found;
    }

    localityLabel(code) {
        return !code || code === '__none' ? 'Sem localidade' : code;
    }

    renderLocalityPanel(baseItems) {
        const panel = document.getElementById('zabbix-locality-panel');
        if (!panel) return;
        const stats = new Map();
        baseItems.forEach(item => {
            const key = item.locality || '__none';
            if (!stats.has(key)) stats.set(key, { alarms: 0, hosts: new Set(), worst: -1 });
            const stat = stats.get(key);
            stat.alarms += 1;
            stat.hosts.add(item.problem.hostName || `#${item.problem.eventid}`);
            if (!item.info.acknowledged) stat.worst = Math.max(stat.worst, Number(item.problem.severity));
        });
        const keys = [...this.settings.localities];
        const decommissioned = new Set(this.settings.decommissionedLocalities);
        if (stats.has('__none')) keys.push('__none');
        const chip = key => {
            const stat = stats.get(key);
            const color = !stat ? '#2f9e5a' : (stat.worst >= 0 ? this.severityColors[stat.worst] : '#8a94a0');
            const active = this.localityFilter === key;
            const decom = decommissioned.has(key) ? ' (em desativação)' : '';
            const title = (stat ? `${this.localityLabel(key)}: ${stat.alarms} alarme${stat.alarms > 1 ? 's' : ''} em ${stat.hosts.size} host${stat.hosts.size > 1 ? 's' : ''}` : `${this.localityLabel(key)}: sem alarmes`) + decom;
            return `<button type="button" class="zabbix-loc-chip${active ? ' is-active' : ''}${stat ? '' : ' is-clear'}${decom ? ' is-decom' : ''}" style="--loc-color:${color}" data-loc="${this.escapeHtml(key)}" aria-pressed="${active}" title="${this.escapeHtml(title)}"><span class="zabbix-loc-code">${this.escapeHtml(this.localityLabel(key))}</span>${stat ? `<span class="zabbix-loc-count">${stat.alarms}</span>` : ''}</button>`;
        };
        panel.innerHTML = `<div class="zabbix-locality-title">Localidades</div><div class="zabbix-loc-list">${keys.map(chip).join('')}</div>`;
    }

    // ------------------------------------------------------------- queda de site
    detectOutages(allItems, now = this.nowSeconds()) {
        const settings = this.settings;
        const windowSeconds = settings.massOutageWindowMinutes * 60;
        const clockOf = item => Number(item.problem.clock || 0);
        const maxAgeSeconds = settings.massOutageMaxAgeHours * 3600;
        const decommissioned = new Set(settings.decommissionedLocalities);
        const ignoreHosts = settings.massOutageIgnoreHostPatterns.map(pattern => {
            try { return new RegExp(pattern, 'i'); } catch (error) { return null; }
        }).filter(Boolean);
        const byLocality = new Map();
        allItems.forEach(item => {
            if (item.info.chronic || !item.locality || !this.isAvailabilityProblem(item.problem)) return;
            if (decommissioned.has(item.locality)) return;                                            // POP em desativação
            if (ignoreHosts.some(regex => regex.test(String(item.problem.hostName || '')))) return;   // ex.: servidores não indicam queda de site
            if (!byLocality.has(item.locality)) byLocality.set(item.locality, []);
            byLocality.get(item.locality).push(item);
        });
        const outages = [];
        byLocality.forEach((list, locality) => {
            list.sort((a, b) => clockOf(a) - clockOf(b));
            let cluster = null;
            const closeCluster = () => {
                if (!cluster) return;
                const hosts = [...new Set(cluster.items.map(item => item.problem.hostName).filter(Boolean))];
                const minHosts = settings.massOutageMinHostsByLocality[locality] || settings.massOutageMinHosts;
                const startClock = clockOf(cluster.items[0]);
                if (hosts.length >= minHosts && now - startClock <= maxAgeSeconds) {
                    outages.push({
                        locality, hosts, items: cluster.items,
                        unacked: cluster.items.filter(item => !item.info.acknowledged),
                        startClock, lastClock: cluster.lastClock
                    });
                }
            };
            list.forEach(item => {
                if (cluster && clockOf(item) - cluster.lastClock <= windowSeconds) {
                    cluster.items.push(item);
                    cluster.lastClock = clockOf(item);
                } else {
                    closeCluster();
                    cluster = { items: [item], lastClock: clockOf(item) };
                }
            });
            closeCluster();
        });
        return outages.sort((a, b) => b.unacked.length - a.unacked.length || b.startClock - a.startClock);
    }

    renderOutagePanel(allItems, now) {
        const panel = document.getElementById('zabbix-outage-panel');
        if (!panel) return;
        const outages = this.detectOutages(allItems, now);
        if (!outages.length) { panel.innerHTML = ''; return; }
        const e = value => this.escapeHtml(value);
        const todayKey = this.dayKey(now);
        panel.innerHTML = outages.map(outage => {
            const since = new Date(outage.startClock * 1000);
            const sameDay = this.dayKey(outage.startClock) === todayKey;
            const sinceLabel = since.toLocaleString('pt-BR', sameDay
                ? { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }
                : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
            const treated = outage.unacked.length === 0;
            const shownHosts = outage.hosts.slice(0, 10).map(host => `<span class="zabbix-outage-host">${e(host)}</span>`).join('');
            const more = outage.hosts.length > 10 ? `<span class="zabbix-outage-host is-more">+${outage.hosts.length - 10}</span>` : '';
            const ackButton = treated ? '' : `<button type="button" class="btn-ack-group zabbix-ack-button" data-eventids="${outage.unacked.map(item => e(item.problem.eventid)).join(',')}" data-host="Queda de site ${e(outage.locality)}">Dar ACK (${outage.unacked.length})</button>`;
            return `<article class="zabbix-outage${treated ? ' is-acknowledged' : ''}">
                <div class="zabbix-outage-head"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><strong>Possível queda de site ${e(outage.locality)}</strong><span>${outage.hosts.length} hosts fora · desde ${e(sinceLabel)} (há ${this.formatDuration(now - outage.startClock)})</span><span class="zabbix-outage-state">${treated ? 'Em tratativa' : `${outage.unacked.length} alarme${outage.unacked.length > 1 ? 's' : ''} sem ACK`}</span></div>
                <div class="zabbix-outage-hosts">${shownHosts}${more}</div>
                <div class="zabbix-outage-actions"><button type="button" class="zabbix-more-details" data-outage-locality="${e(outage.locality)}">Ver na lista</button>${ackButton}</div>
            </article>`;
        }).join('');
    }

    onOutageClick(event) {
        const ack = event.target.closest('.btn-ack-group');
        if (ack) {
            const ids = String(ack.dataset.eventids || '').split(',').filter(Boolean);
            this.promptAck(ids.join(','), ack.dataset.host, `${ids.length} alarme${ids.length > 1 ? 's' : ''} da queda de site`);
            return;
        }
        const filter = event.target.closest('[data-outage-locality]');
        if (filter) {
            this.localityFilter = filter.dataset.outageLocality;
            this.stateFilter = 'availability';
            this.selectedEventIds = [];
            this.render(true);
            const grid = document.getElementById('zabbix-cards-grid');
            if (grid && typeof grid.scrollIntoView === 'function') grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // ------------------------------------------------------------- disponibilidade
    getAvailabilityRegex() {
        const source = this.settings.availabilityPatterns.join('|');
        if (this._availabilitySource !== source) {
            try { this._availabilityRegex = new RegExp(source, 'i'); }
            catch (error) { this._availabilityRegex = /Host Down|Unreachable|Unavailable by ICMP/i; }
            this._availabilitySource = source;
        }
        return this._availabilityRegex;
    }

    isAvailabilityProblem(problem) {
        return this.getAvailabilityRegex().test(String(problem.name || ''));
    }

    computeAvailability(allItems) {
        const total = Number(this.totalHosts);
        if (!(total > 0)) return null;
        const decommissioned = new Set(this.settings.decommissionedLocalities);
        const down = new Set();
        const excluded = new Set();   // hosts fora de localidades em desativação: não contam nem como fora nem no total
        allItems.forEach(({ problem, info, locality }) => {
            if (this.settings.availabilityIgnoreChronic && info.chronic) return;
            if (!problem.hostName || !this.isAvailabilityProblem(problem)) return;
            if (locality && decommissioned.has(locality)) { excluded.add(problem.hostName); return; }
            down.add(problem.hostName);
        });
        const adjustedTotal = Math.max(1, total - excluded.size);
        const downCount = Math.min(down.size, adjustedTotal);
        let percent = ((adjustedTotal - downCount) / adjustedTotal) * 100;
        if (downCount > 0) percent = Math.min(percent, 99.9);   // nunca arredondar para 100% com host fora
        return { total: adjustedTotal, down: downCount, excluded: excluded.size, percent: downCount > 0 ? Math.floor(percent * 10) / 10 : 100 };
    }

    renderFilterBanner() {
        const chips = [];
        if (this.severityFilter !== null) chips.push(`<button type="button" class="zabbix-chip" data-clear="severity">Severidade: ${this.escapeHtml(this.severityNames[this.severityFilter] || this.severityFilter)} ✕</button>`);
        if (this.stateFilter !== 'all') chips.push(`<button type="button" class="zabbix-chip" data-clear="state">${this.escapeHtml(this.stateNames[this.stateFilter] || this.stateFilter)} ✕</button>`);
        if (this.localityFilter) chips.push(`<button type="button" class="zabbix-chip" data-clear="locality">Localidade: ${this.escapeHtml(this.localityLabel(this.localityFilter))} ✕</button>`);
        if (this.hostFilter) chips.push(`<button type="button" class="zabbix-chip" data-clear="host">Host: ${this.escapeHtml(this.hostFilter)} ✕</button>`);
        if (this.selectedEventIds.length) chips.push('<button type="button" class="zabbix-chip" data-clear="event">Incidente selecionado ✕</button>');
        if (!chips.length) return '';
        return `<div class="zabbix-filter-banner"><span>Filtros ativos:${chips.join('')}</span><button type="button" id="btn-zabbix-reset-filters">Limpar tudo</button></div>`;
    }

    detailsAttrs(problem) {
        const e = value => this.escapeHtml(value);
        const tags = Array.isArray(problem.tags) ? problem.tags : [];
        const sector = tags.find(tag => String(tag.tag || '').toLowerCase() === 'setor')?.value || '—';
        const local = tags.find(tag => String(tag.tag || '').toLowerCase() === 'local')?.value || '—';
        return `data-host="${e(problem.hostName || 'Host desconhecido')}" data-ip="${e(problem.hostIp || 'N/A')}" data-setor="${e(sector)}" data-local="${e(local)}" data-trigger="${e(problem.name || 'Problema sem descrição')}" data-opdata="${e(problem.opdata || 'N/A')}" data-severity="${e(this.severityNames[Number(problem.severity)] || 'Desconhecida')}" data-eventid="${e(problem.eventid)}" data-clock="${e(problem.clock)}"`;
    }

    renderChildRow({ problem, info }, ctx) {
        const e = value => this.escapeHtml(value);
        const severity = Number(problem.severity);
        const host = problem.hostName || 'Host desconhecido';
        const title = problem.name || 'Problema sem descrição';
        const openFor = this.formatDuration(ctx.now - (Number(problem.clock) || ctx.now));
        const stateText = info.acknowledged ? `ACK${info.ticket ? ` · #${info.ticket}` : ''}${info.ackText ? ` · ${info.ackText}` : ''}` : 'Sem ACK';
        return `<li class="zabbix-child ${info.acknowledged ? 'is-acknowledged' : 'is-unacknowledged'}" style="--severity-color:${this.severityColors[severity] || '#77838f'}">
            <span class="zabbix-child-sev">${e(this.severityNames[severity] || '')}</span>
            <span class="zabbix-child-title" title="${e(title)}">${e(title)}</span>
            <span class="zabbix-child-time">há ${openFor}</span>
            <span class="zabbix-child-state" title="${e(stateText)}">${e(stateText)}</span>
            <span class="zabbix-child-actions"><button class="btn-ack zabbix-ack-button" data-eventid="${e(problem.eventid)}" data-host="${e(host)}" data-trigger="${e(title)}" type="button">${info.acknowledged ? 'Atualizar' : 'ACK'}</button><button class="btn-details-trigger zabbix-more-details" ${this.detailsAttrs(problem)} type="button">Detalhes</button></span>
        </li>`;
    }

    renderIncident(problem, info, aging, openSet, ctx = { now: this.nowSeconds(), enterIds: new Set() }, group = null) {
        const e = value => this.escapeHtml(value);
        const settings = this.settings;
        const severity = Number(problem.severity);
        const severityName = this.severityNames[severity] || 'Desconhecida';
        const host = problem.hostName || 'Host desconhecido';
        const title = problem.name || 'Problema sem descrição';
        const tags = Array.isArray(problem.tags) ? problem.tags : [];
        const sector = tags.find(tag => String(tag.tag || '').toLowerCase() === 'setor')?.value || '—';
        const local = tags.find(tag => String(tag.tag || '').toLowerCase() === 'local')?.value || '—';
        const members = group ? group.items : [{ problem, info }];
        const unackedMembers = members.filter(member => !member.info.acknowledged);
        const ackTargets = unackedMembers.length ? unackedMembers : members;
        const partial = Boolean(group) && unackedMembers.length > 0 && unackedMembers.length < members.length;

        // Cor de envelhecimento só para o que ainda não foi reconhecido (ACK já indica que alguém está tratando)
        const noAckClass = info.acknowledged ? 'age-fresh' : this.getAgeClass(info.noAckSeconds, aging.unacknowledgedMinutes, 60);
        const totalClass = info.acknowledged ? 'age-fresh' : this.getAgeClass(info.totalOpenSeconds, aging.totalOpenHours, 3600);
        const statusClass = info.acknowledged ? 'is-acknowledged' : 'is-unacknowledged';
        const ackActor = this.ackActorName(info.latestAck);
        const ackWhen = info.latestAckClock ? new Date(info.latestAckClock * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Horário não informado';
        const stateLabel = partial
            ? `ACK parcial · ${members.length - unackedMembers.length}/${members.length}`
            : (info.acknowledged ? `Em tratativa · ${e(ackActor)}` : 'Sem tratativa');

        const tickets = group ? group.tickets : (info.ticket ? [info.ticket] : []);
        const ackText = (info.acknowledged || partial) ? String(info.ackText || '') : '';   // grupo com ACK parcial também mostra o texto
        const ticketBadge = tickets.length
            ? `<span class="zabbix-ticket-badge" title="${e(tickets.map(ticket => `#${ticket}`).join(', '))}">#${e(tickets[0])}${tickets.length > 1 ? ` +${tickets.length - 1}` : ''}</span>`
            : '';
        const ackTextHtml = ackText ? `<span class="zabbix-ack-text" title="${e(ackText)}">${e(ackText)}</span>` : '';
        const ticketHtml = (ticketBadge || ackTextHtml)
            ? `<span class="zabbix-ack-cell">${ticketBadge}${ackTextHtml}</span>`
            : `<span class="zabbix-ticket-missing${info.acknowledged ? ' is-warning' : ''}">${info.acknowledged ? 'ACK sem chamado' : 'Sem chamado'}</span>`;
        // Data (em cima) e hora (embaixo) em que o alarme surgiu; em grupo, o do primeiro alarme
        const firstClock = group ? group.minClock : (Number(problem.clock) || 0);
        const appeared = this.formatDateParts(firstClock);
        const appearedTitle = `Surgiu em ${appeared.date} ${appeared.time}${group ? ` (primeiro de ${members.length} alarmes)` : ''} · ${info.acknowledged ? `ACK em ${this.formatDuration(info.noAckSeconds)}` : `sem ACK há ${this.formatDuration(info.noAckSeconds)}`}`;
        const datetimeCell = `<span class="zabbix-datetime" title="${e(appearedTitle)}"><span class="zabbix-datetime-date">${e(appeared.date)}</span><time class="zabbix-datetime-time">${e(appeared.time)}</time></span>`;
        const totalCell = `<span class="zabbix-time-cell ${info.acknowledged ? 'age-fresh' : noAckClass}" title="${e(info.acknowledged ? 'Tempo desde a abertura do evento no Zabbix' : 'Sem ACK: tempo desde a abertura do evento no Zabbix')}">Total ${this.formatDuration(info.totalOpenSeconds)}</span>`;

        // Pulso e selo "novo": consideram o alarme sem ACK mais recente do grupo
        const youngestUnackedClock = unackedMembers.reduce((max, member) => Math.max(max, Number(member.problem.clock) || 0), 0);
        const ageSeconds = unackedMembers.length ? Math.max(0, ctx.now - (youngestUnackedClock || ctx.now)) : Infinity;
        const isNew = settings.newBlinkSeconds > 0 && ageSeconds < settings.newBlinkSeconds;
        const showBadge = settings.newBadgeSeconds > 0 && ageSeconds < settings.newBadgeSeconds;
        const entering = members.some(member => ctx.enterIds.has(String(member.problem.eventid)));
        const animations = [];
        if (isNew) animations.push(`zbxPulse 1.6s ease-in-out ${(-(ageSeconds % 1.6)).toFixed(2)}s ${Math.max(1, Math.ceil((settings.newBlinkSeconds - ageSeconds) / 1.6))}`);   // só o tempo que falta até completar o período
        if (entering) animations.push('zbxEnter .45s ease-out');
        const classes = ['zabbix-incident', statusClass];
        if (currentViewMode === 'grid') classes.push('zabbix-incident-card');
        if (settings.rowStyle === 'tint' && !info.acknowledged) classes.push('zabbix-tinted');
        if (isNew) classes.push('zabbix-new');
        if (group) classes.push('zabbix-grouped');
        const styleAttr = `--severity-color:${this.severityColors[severity] || '#77838f'}${animations.length ? `;animation:${animations.join(', ')}` : ''}`;

        const sectorChip = sector && sector !== '—' ? `<span class="zabbix-sector-tag" title="Setor"><i class="fa-solid fa-layer-group" aria-hidden="true"></i>${e(sector)}</span>` : '';
        const newChip = showBadge ? '<span class="zabbix-new-badge">Novo</span>' : '';
        const groupPill = group ? `<span class="zabbix-group-pill" title="${members.length} alarmes neste host">×${members.length}</span>` : '';
        const rowTitle = `${severityName} · ${title}${group ? ` · +${members.length - 1} alarme${members.length > 2 ? 's' : ''} neste host` : ''}`;

        const ackButton = group
            ? `<button class="btn-ack-group zabbix-ack-button" data-eventids="${ackTargets.map(member => e(member.problem.eventid)).join(',')}" data-host="${e(host)}" type="button">${info.acknowledged ? 'Atualizar ACK' : 'Dar ACK'} (${ackTargets.length})</button>`
            : `<button class="btn-ack zabbix-ack-button" data-eventid="${e(problem.eventid)}" data-host="${e(host)}" data-trigger="${e(title)}" type="button">${info.acknowledged ? 'Atualizar ACK' : 'Dar ACK'}</button>`;

        let detailsKey;
        let detailsSummary;
        let detailsBody;
        if (group) {
            detailsKey = `g-${host}-${group.minEventId}`;
            detailsSummary = `Ver os ${members.length} alarmes deste host`;
            const ordered = [...members].sort((a, b) => Number(b.problem.severity) - Number(a.problem.severity) || Number(b.problem.clock) - Number(a.problem.clock));
            detailsBody = `<ul class="zabbix-children">${ordered.map(member => this.renderChildRow(member, ctx)).join('')}</ul><button class="btn-host-history-trigger zabbix-more-details" data-host="${e(host)}" type="button">Ver histórico do host</button>`;
        } else {
            detailsKey = String(problem.eventid);
            detailsSummary = 'Detalhes operacionais';
            const ackHistory = info.acknowledges.length
                ? info.acknowledges.map(ack => `<li><strong>${e(this.ackActorName(ack))}</strong><time>${Number(ack.clock) ? new Date(Number(ack.clock) * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''}</time><span>${e(ack.message || 'ACK sem mensagem')}</span></li>`).join('')
                : '<li>Nenhum ACK registrado.</li>';
            const detailTags = tags.map(tag => `<span class="zabbix-detail-tag">${e(tag.tag)}: ${e(tag.value)}</span>`).join('');
            const date = Number(problem.clock) ? new Date(Number(problem.clock) * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Horário desconhecido';
            detailsBody = `<div class="zabbix-details-content"><div><strong>Severidade:</strong> ${e(severityName)} · <strong>Setor:</strong> ${e(sector)} · <strong>Local:</strong> ${e(local)} · <strong>Localidade:</strong> ${e(this.localityLabel(this.resolveLocality(problem)))}</div><div><strong>Evento Zabbix:</strong> ${e(problem.eventid)} · <strong>Aberto em:</strong> ${e(date)} · <strong>IP:</strong> ${e(problem.hostIp || 'N/A')}</div><div><strong>Último valor:</strong> ${e(problem.opdata || 'N/A')}</div><div class="zabbix-detail-tags">${detailTags || 'Sem tags'}</div><div><strong>ACK mais recente:</strong> ${info.acknowledged ? `${e(ackActor)} · ${e(ackWhen)} · ${e(info.latestAck?.message || 'Sem mensagem')}` : 'Ainda não reconhecido'}</div><ol class="zabbix-ack-history">${ackHistory}</ol><button class="btn-details-trigger zabbix-more-details" ${this.detailsAttrs(problem)} type="button">Abrir detalhes completos</button><button class="btn-host-history-trigger zabbix-more-details" data-host="${e(host)}" type="button">Ver histórico do host</button></div>`;
        }
        const isOpen = openSet.has(detailsKey) ? ' open' : '';

        return `<article class="${classes.join(' ')}" style="${styleAttr}" data-severity="${severity}">
            <div class="zabbix-incident-main"><div class="zabbix-incident-host zabbix-host-cell"><span class="zabbix-sr-only">${e(severityName)}: </span><a href="#" class="host-clickable zabbix-host-link" data-host="${e(host)}">${e(host)}</a>${groupPill}${newChip}${sectorChip}</div><span class="zabbix-incident-problem" title="${e(rowTitle)}">${e(title)}</span><span class="zabbix-state-badge ${partial ? 'is-unacknowledged' : statusClass}">${stateLabel}</span>${datetimeCell}${totalCell}${ticketHtml}${ackButton}</div>
            <details class="zabbix-incident-details" data-event="${e(detailsKey)}"${isOpen}><summary>${e(detailsSummary)}</summary>${detailsBody}</details>
        </article>`;
    }

    renderKpis(baseItems, chronicTotal, now, allItems = baseItems) {
        const container = document.getElementById('zabbix-kpis');
        if (!container) return;
        const count = predicate => baseItems.filter(predicate).length;
        const tile = (kind, value, label, amount, color, extra = '') => {
            const active = (kind === 'severity' && this.severityFilter === Number(value))
                || (kind === 'state' && this.stateFilter === value);
            return `<button type="button" class="zabbix-kpi${active ? ' is-active' : ''}" style="--kpi-color:${color}" data-kpi="${kind}" data-value="${this.escapeHtml(value)}"${extra}><span class="zabbix-kpi-label">${this.escapeHtml(label)}</span><strong>${this.escapeHtml(amount)}</strong></button>`;
        };

        const severityTiles = [5, 4, 3, 2, 0].map(severity => {
            const amount = count(item => Number(item.problem.severity) === severity);
            if (severity === 0 && amount === 0) return '';
            return tile('severity', severity, this.severityNames[severity], amount, this.severityColors[severity]);
        }).join('');

        const stateTiles = [
            tile('state', 'untreated', 'Sem tratativa', count(item => !item.info.acknowledged), '#c83e4d'),
            tile('state', 'treated', 'Em tratativa', count(item => item.info.acknowledged), '#c89b26'),
            tile('state', 'no-ticket', 'ACK sem chamado', count(item => item.info.noTicket), '#b4690e'),
            chronicTotal ? tile('state', 'chronic', 'Backlog crônico', chronicTotal, '#8a94a0') : ''
        ].join('');

        const availability = this.computeAvailability(allItems);
        let availabilityTile;
        if (availability) {
            const { good, warning } = this.settings.availabilityThresholds;
            const color = availability.percent >= good ? '#2f9e5a' : (availability.percent >= warning ? '#c89b26' : '#c83e4d');
            const text = availability.down === 0 ? '100%' : `${availability.percent.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
            const tooltip = `${availability.total - availability.down} de ${availability.total} hosts disponíveis · ${availability.down} fora.${availability.excluded ? ` ${availability.excluded} host(s) de localidade em desativação desconsiderado(s).` : ''} Clique para listar os hosts fora.`;
            availabilityTile = tile('state', 'availability', 'Disponibilidade', text, color, ` title="${this.escapeHtml(tooltip)}"`);
        } else {
            availabilityTile = tile('state', 'availability', 'Disponibilidade', '—', '#8a94a0', ' title="Sem o total de hosts monitorados: o backend precisa enviar totalHosts em /api/zabbix/problems."');
        }

        const oldestSeconds = baseItems.reduce((max, item) => Math.max(max, item.info.totalOpenSeconds), 0);
        const oldestIds = baseItems.filter(item => item.info.totalOpenSeconds === oldestSeconds).map(item => String(item.problem.eventid));
        const meshTiles = [
            availabilityTile,
            tile('event', 'oldest', 'Maior tempo aberto', baseItems.length ? this.formatDuration(oldestSeconds) : '—', '#667786', ` data-event-ids="${oldestIds.join(',')}"`)
        ].join('');

        container.innerHTML = `<div class="zabbix-kpi-group" aria-label="Por severidade">${severityTiles}</div><div class="zabbix-kpi-group" aria-label="Por tratativa">${stateTiles}</div><div class="zabbix-kpi-group" aria-label="Malha">${meshTiles}</div>`;
    }

    renderStalePanel(allItems, now) {
        const panel = document.getElementById('zabbix-stale-panel');
        if (!panel) return;
        const settings = this.settings;
        // mais tempo esperando desde o último ACK primeiro; backlog crônico fica de fora
        const staleItems = allItems.filter(item => item.info.stale).sort((a, b) => b.info.sinceLastAck - a.info.sinceLastAck);
        if (!staleItems.length) {
            panel.innerHTML = '';
            return;
        }
        const e = value => this.escapeHtml(value);
        panel.innerHTML = `<div class="zabbix-stale-heading"><strong>Parados há mais de ${settings.staleHours} horas (até ${settings.chronicDays} dias)</strong><button type="button" class="zabbix-stale-filter">Ver todos (${staleItems.length})</button></div><div class="zabbix-stale-items">${staleItems.slice(0, 8).map(({ problem, info }) => `<button type="button" class="zabbix-stale-item" data-stale-event="${e(problem.eventid)}"><span>${e(problem.hostName || 'Host desconhecido')}</span><span>${e(problem.name || 'Incidente')}</span><time>${this.formatDuration(info.sinceLastAck)}</time></button>`).join('')}${staleItems.length > 8 ? `<span class="zabbix-stale-more">+ ${staleItems.length - 8} incidentes</span>` : ''}</div>`;
    }

    updateChronicButton(chronicTotal) {
        const button = document.getElementById('btn-zabbix-chronic');
        if (!button) return;
        button.setAttribute('aria-pressed', String(this.hideChronic));
        button.classList.toggle('active', this.hideChronic);
        button.innerHTML = this.hideChronic
            ? `<i class="fa-solid fa-eye-slash"></i> Crônicos ocultos (${chronicTotal})`
            : '<i class="fa-solid fa-eye"></i> Ocultar crônicos';
    }

    updateStatusLabel() {
        const updated = document.getElementById('zabbix-last-updated');
        if (!updated || !this.lastUpdatedAt) return;
        const counts = this.lastCounts || { shown: 0, base: 0, chronicHidden: 0 };
        const parts = [`Atualizado ${this.lastUpdatedAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, `${counts.base} incidentes`];
        if (counts.hosts) parts.push(`${counts.hosts} hosts`);
        if (counts.chronicHidden) parts.push(`${counts.chronicHidden} crônicos ocultos`);
        updated.textContent = parts.join(' · ');
        updated.classList.remove('is-stale');
    }

    // ------------------------------------------------------------------------ ACK
    // Aceita só o número (vira chamado, com ou sem "CH-") ou uma mensagem curta de 3 a 200 caracteres
    normalizeAckText(raw) {
        const text = String(raw || '').replace(/\s+/g, ' ').trim();
        if (text.length < 3 || text.length > 200) return null;
        const ticket = text.match(/^(?:CH-?)?(\d{3,12})$/i);
        return ticket ? ticket[1] : text.replace(/\|/g, '/');
    }

    normalizeTicket(raw) {
        return this.normalizeAckText(raw);
    }

    promptAck(eventId, hostName, triggerName) {
        const modal = document.getElementById('ack-modal');
        if (!modal) {
            const typed = prompt(`Incidente em: ${hostName}\n${triggerName}\n\nInforme o número do chamado ou uma breve mensagem:`);
            const ticket = this.normalizeAckText(typed);
            if (typed && !ticket) showCustomAlert('ACK inválido', 'Informe o número do chamado ou uma breve mensagem (de 3 a 200 caracteres).');
            else if (ticket) this.sendAck(eventId, ticket);
            return;
        }

        const input = document.getElementById('ack-ticket-input');
        document.getElementById('ack-modal-host').textContent = hostName;
        document.getElementById('ack-modal-trigger').textContent = triggerName;
        document.getElementById('ack-event-id').value = eventId;
        input.type = 'text';
        input.removeAttribute('pattern');
        input.removeAttribute('inputmode');
        input.maxLength = 200;
        input.placeholder = 'Nº do chamado ou uma breve mensagem';
        input.value = '';
        input.setCustomValidity('');
        input.oninput = () => input.setCustomValidity('');
        modal.classList.add('show');
        input.focus();

        document.getElementById('ack-form').onsubmit = event => {
            event.preventDefault();
            const ticket = this.normalizeAckText(input.value);
            if (!ticket) {
                input.setCustomValidity('Informe o número do chamado ou uma breve mensagem (de 3 a 200 caracteres).');
                input.reportValidity();
                return;   // mantém o modal aberto
            }
            modal.classList.remove('show');
            this.sendAck(eventId, ticket);
        };
        document.getElementById('ack-cancel-btn').onclick = () => modal.classList.remove('show');
    }

    async sendAck(eventIds, ticketNumber) {
        const ids = String(eventIds || '').split(',').map(id => id.trim()).filter(Boolean);
        if (!ids.length || !ticketNumber || this.sendingAck) return;
        this.sendingAck = true;
        const ackText = String(ticketNumber);   // número do chamado ou mensagem; o servidor monta "<texto> | operador: <nome>"
        let done = 0;
        let lastError = '';
        try {
            for (const eventId of ids) {   // um por vez: mantém a validação de permissão do servidor em cada ACK
                try {
                    await apiRequest('/api/zabbix/ack', 'POST', { eventId, ticketNumber: ackText, message: ackText });
                    done += 1;
                } catch (error) {
                    lastError = error?.message || 'Erro ao reconhecer um dos alarmes.';
                }
            }
            if (done === ids.length) {
                const label = /^\d+$/.test(ackText) ? `com o chamado #${ackText}` : 'com a mensagem informada';
                showCustomAlert('Sucesso!', ids.length > 1 ? `${done} alarmes reconhecidos ${label}.` : `Incidente reconhecido ${label}.`);
            } else if (done > 0) {
                showCustomAlert('ACK parcial', `${done} de ${ids.length} alarmes reconhecidos. Falha: ${lastError}`);
            } else {
                showCustomAlert('Erro', lastError || 'Não foi possível enviar o reconhecimento ao Zabbix.');
            }
            this.fetchProblems();
        } finally {
            this.sendingAck = false;
        }
    }

    showDetailsModal(data) {
        const modal = document.getElementById('details-modal');
        const body = document.getElementById('details-modal-body');
        const closeIcon = document.getElementById('details-close-icon'); // Pegamos o X

        if (!modal || !body || !closeIcon) {
            alert("ERRO: O HTML do modal (details-modal) não foi encontrado no seu arquivo portal.html!");
            return;
        }

        // =======================================================
        // 1. INJETANDO OS BOTÕES NO CABEÇALHO (AO LADO DO X)
        // =======================================================
        const headerDiv = closeIcon.parentElement;
        
        // Limpa os botões antigos se houver (para não duplicar quando abrir outro incidente)
        const oldButtons = document.getElementById('header-copy-buttons');
        if (oldButtons) oldButtons.remove();

        // Cria a nova caixinha de botões
        const copyButtonsDiv = document.createElement('div');
        copyButtonsDiv.id = 'header-copy-buttons';
        copyButtonsDiv.style.display = 'flex';
        copyButtonsDiv.style.gap = '8px';
        copyButtonsDiv.style.marginLeft = 'auto'; // O pulo do gato! Isso empurra os botões para a direita.
        copyButtonsDiv.style.marginRight = '15px'; // Dá um espaço para o X não ficar colado.
        copyButtonsDiv.style.flexShrink = '0'; // Impede que os botões amassem se o título for longo.
        
        copyButtonsDiv.innerHTML = `
            <button id="btn-copy-sistel" style="background: transparent; border: 1px solid var(--border); color: var(--primary); padding: 4px 10px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; transition: all 0.2s;" title="Copiar formatado para Sistel (com <br>)">
                <i class="fa-regular fa-copy"></i> Sistel
            </button>
            <button id="btn-copy-modal" style="background: transparent; border: 1px solid var(--border); color: var(--primary); padding: 4px 10px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; transition: all 0.2s;" title="Copiar formato Padrão (GLPI)">
                <i class="fa-regular fa-copy"></i> Padrão
            </button>
        `;

        // Insere os botões de cópia logo antes do "X" de fechar
        headerDiv.insertBefore(copyButtonsDiv, closeIcon);

        // =======================================================
        // 2. PREPARANDO OS TEXTOS
        // =======================================================
        const dateObj = new Date(Number(data.clock) * 1000);
        const dataStr = dateObj.toLocaleDateString('pt-BR');
        const horaStr = dateObj.toLocaleTimeString('pt-BR');

        const copyText = `Host: ${data.host}\nIP: ${data.ip}\nSetor: ${data.setor}\nLocal: ${data.local}\nTrigger: ${data.trigger}\nÚltimo Valor: ${data.opdata}\nStatus: PROBLEM\nSeveridade: ${data.severity}\nID do Evento: ${data.eventid}\nData: ${dataStr} às ${horaStr}`;
        const copyTextSistel = copyText.replace(/\n/g, '<br>\n');

        // =======================================================
        // 3. DESENHANDO O CORPO (AGORA LIMPO, SEM BOTÕES)
        // =======================================================
        body.innerHTML = `
            <div style="margin-bottom: 16px; padding: 12px; background: rgba(220, 53, 69, 0.1); border-left: 4px solid var(--destructive); border-radius: 4px; line-height: 1.4; word-break: break-word;">
                <strong>Incidente:</strong> ${data.host} - ${data.trigger}
            </div>
            
            <div style="font-size: 13px; line-height: 1.8;">
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Host:</span> <span style="font-weight: 600;">${data.host}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">IP:</span> <span style="font-weight: 600;">${data.ip}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Setor:</span> <span style="font-weight: 600;">${data.setor}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Local:</span> <span style="font-weight: 600;">${data.local}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Trigger:</span> <span style="font-weight: 600;">${data.trigger}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Último Valor:</span> <span style="font-weight: 600;">${data.opdata}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Status:</span> <span style="font-weight: 600; color: var(--destructive);">PROBLEM</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Severidade:</span> <span style="font-weight: 600;">${data.severity}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">ID do Evento:</span> <span style="font-weight: 600;">${data.eventid}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Data do Evento:</span> <span style="font-weight: 600;">${dataStr}</span></div>
                <div style="margin-bottom: 4px;"><span style="color: var(--muted-foreground); display: inline-block; width: 110px;">Hora do Evento:</span> <span style="font-weight: 600;">${horaStr}</span></div>
            </div>
        `;

        modal.classList.add('show');

        // =======================================================
        // 4. ATIVANDO A LÓGICA DE CÓPIA
        // =======================================================
        const setupCopyLogic = (btnId, textToCopy) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            
            btn.onclick = () => {
                const showSuccess = () => {
                    const originalHtml = btn.innerHTML;
                    btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado!';
                    btn.style.color = '#28a745';
                    btn.style.borderColor = '#28a745';
                    
                    setTimeout(() => {
                        btn.innerHTML = originalHtml;
                        btn.style.color = btnId === 'btn-copy-sistel' ? 'var(--primary)' : 'var(--foreground)';
                        btn.style.borderColor = 'var(--border)';
                    }, 2000);
                };

                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(textToCopy).then(showSuccess);
                } else {
                    const textArea = document.createElement("textarea");
                    textArea.value = textToCopy;
                    textArea.style.position = "fixed";
                    textArea.style.left = "-9999px";
                    textArea.style.top = "0";
                    document.body.appendChild(textArea);
                    
                    textArea.focus();
                    textArea.select();
                    
                    try {
                        if (document.execCommand('copy')) showSuccess();
                        else alert("Seu navegador bloqueou a cópia. Copie manualmente.");
                    } catch (err) {
                        console.error('Fallback: Oops, unable to copy', err);
                    }
                    document.body.removeChild(textArea);
                }
            };
        };

        setupCopyLogic('btn-copy-modal', copyText);
        setupCopyLogic('btn-copy-sistel', copyTextSistel);

        // Funções para fechar o modal
        document.getElementById('details-close-btn').onclick = () => modal.classList.remove('show');
        closeIcon.onclick = () => modal.classList.remove('show');
    }

}
