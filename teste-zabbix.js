require('dotenv').config();
const axios = require('axios');

// Pega as variáveis do .env
const url = process.env.ZABBIX_URL;
const user = process.env.ZABBIX_ROBOT_USER;
const pass = process.env.ZABBIX_ROBOT_PASS;

console.log("--- INICIANDO TESTE DE CONEXÃO ---");
console.log(`1. Lendo configurações do .env:`);
console.log(`   URL: ${url}`);
console.log(`   Usuário: ${user}`);
console.log(`   Senha: ${pass ? '****** (Carregada)' : 'NÃO ENCONTRADA'}`);

if (!url || !user || !pass) {
    console.error("ERRO: Faltam variáveis no arquivo .env");
    process.exit(1);
}

async function testarLogin() {
    try {
        console.log(`2. Tentando conectar via Axios...`);
        
        const response = await axios.post(url, {
            jsonrpc: "2.0",
            method: "user.login",
            params: { username: user, password: pass },
            id: 1
        }, {
            // Timeout de 5 segundos para não travar
            timeout: 5000, 
            // Cabeçalhos importantes para evitar bloqueios
            headers: { 'Content-Type': 'application/json-rpc' } 
        });

        console.log("3. Resposta recebida do servidor:");
        
        if (response.data.error) {
            console.error("❌ FALHA: O Zabbix recusou o login.");
            console.error("   Motivo:", response.data.error.data);
            console.error("   Código:", response.data.error.code);
        } else if (response.data.result) {
            console.log("✅ SUCESSO! Token gerado:", response.data.result);
        } else {
            console.log("⚠️  ALERTA: Resposta estranha (HTML?):", response.data.substring(0, 100));
        }

    } catch (error) {
        console.error("❌ ERRO CRÍTICO DE REDE/CÓDIGO:");
        if (error.response) {
            console.error(`   Status HTTP: ${error.response.status}`);
            console.error(`   Status Text: ${error.response.statusText}`);
            // Se for 301 ou 302, é problema de HTTP vs HTTPS
        } else {
            console.error(`   Erro: ${error.message}`);
        }
    }
}

testarLogin();