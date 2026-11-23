window.ZABBIX_DASHBOARD_CONFIG = Object.freeze({
    // --- Tempos e envelhecimento ---
    staleAckHours: 4,              // bloco "Parados": ACK há mais de X horas
    chronicDays: 30,               // ACK há mais de X dias = backlog crônico (oculto por padrão)
    chronicIncludesUnacked: false, // true: incidentes SEM ACK abertos há mais de chronicDays também viram crônicos
    refreshSeconds: 15,            // intervalo de atualização da tela
    aging: Object.freeze({
        unacknowledgedMinutes: Object.freeze({ warning: 15, critical: 60, severe: 240 }),
        totalOpenHours: Object.freeze({ warning: 1, critical: 4, severe: 24 })
    }),

    // --- Aparência da lista ---
    defaultSort: 'time',           // 'time' = igual ao Zabbix (mais recentes primeiro) | 'priority' = sem tratativa e severidade primeiro
    rowStyle: 'tint',              // 'tint' = fundo suave por severidade nos sem ACK | 'minimal'
    newBlinkSeconds: 60,           // pulso em alarme novo sem ACK (0 desliga)
    newBadgeSeconds: 300,          // selo "Novo" (0 desliga)
    groupWindowMinutes: 30,        // alarmes do mesmo host dentro desta janela viram uma linha

    // --- Chamado no ACK ---
    // O número do chamado é lido do INÍCIO da mensagem do ACK (ex.: "12345 | operador: nome"; o antigo "CH-12345" também é aceito)
    // ticketPattern: '^\\s*(?:CH-?)?\\d{3,}',

    // --- Disponibilidade (tile) ---
    availabilityPatterns: ['Host Down', 'Unreachable', 'Unavailable by ICMP'],   // problemas que contam como "host fora"
    availabilityIgnoreChronic: false,
    availabilityThresholds: Object.freeze({ good: 99, warning: 95 }),            // verde >= good, amarelo >= warning, senão vermelho

    // --- Localidades e queda de site ---
    // A localidade é achada pelo código no nome do host (separado por - _ .), depois pelos grupos de hosts.
    localities: ['BHE', 'BLM', 'BSA', 'CAS', 'CTA', 'LM', 'PAE', 'PM', 'PPE', 'RCE', 'RJO', 'SDR', 'SJB', 'SJC', 'SOC', 'SPO', 'SRR', 'STS', 'TBR', 'TLK', 'VTA'],
    localityRules: [               // exceções: nome do host (regex) -> localidade; vencem o código no nome
        { pattern: '^SPOLM', locality: 'LM' },
        { pattern: '^SPOTLK|^TALK[-_]', locality: 'TLK' }
    ],
    massOutageMinHosts: 3,         // a partir de quantos hosts fora na mesma localidade aparece "Possível queda de site"
    massOutageWindowMinutes: 10,   // hosts que caem com até X minutos de diferença entre si contam como a mesma queda
    massOutageMaxAgeHours: 24,     // só vira card se a queda começou há menos de X horas (as antigas ficam no "Parados"/backlog)
    massOutageMinHostsByLocality: { LM: 8 },                 // localidades grandes exigem mais hosts (ajuste conforme o tamanho de cada uma)
    massOutageIgnoreHostPatterns: ['^SRV-', 'IDRAC', 'ESXI'], // hosts (regex no nome) que não indicam queda de site: servidores, iDRAC, ESXi
    decommissionedLocalities: ['VTA']                        // POPs em desativação: sem card de queda e fora da conta de disponibilidade
});
