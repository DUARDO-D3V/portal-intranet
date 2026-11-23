const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const express = require('express');
const axios = require('axios');
const cors = require('cors'); 
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { Server } = require("socket.io");
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const db = require('./db-mysql.js');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const ExcelJS = require('exceljs');

let zabbixToken = null;


const PORT = 3000;
const REMEMBER_ME_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const sessionSecret = process.env.SESSION_SECRET || process.env.SECRET_KEY;

if (!sessionSecret) {
    throw new Error('Defina SESSION_SECRET (ou SECRET_KEY) no arquivo .env.');
}


// --- 3. Inicialização de Instâncias ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('A política de CORS não permite acesso desta origem.'));
        }
    },
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        httpOnly: true,
    }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// Segurança: o express.static abaixo serve a pasta raiz do projeto. Estes caminhos nunca devem sair pela web
// (código do servidor, dependências, ambiente virtual, versionamento, bancos, logs e arquivos de configuração).
const BLOCKED_STATIC_PREFIXES = ['/backend', '/node_modules', '/.venv', '/venv', '/.git', '/.vscode', '/.github'];
const BLOCKED_STATIC_FILES = /(^|\/)(package(-lock)?\.json|\.env[^/]*)$|\.(env|db|sqlite3?|log|py|bak|pem|key)$/i;
app.use((req, res, next) => {
    let requestedPath;
    try { requestedPath = decodeURIComponent(req.path).toLowerCase(); }
    catch (error) { return res.status(400).end(); }
    const blocked = BLOCKED_STATIC_PREFIXES.some(prefix => requestedPath === prefix || requestedPath.startsWith(`${prefix}/`))
        || BLOCKED_STATIC_FILES.test(requestedPath)
        || /\/\.[^/]/.test(requestedPath);
    if (blocked) return res.status(404).end();
    return next();
});

app.use(express.static(path.join(__dirname, '..')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
    fallthrough: true,
    setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
    }
}));

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, '..', 'uploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, req.session.userId + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });
const avatarUpload = multer({
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadPath = path.join(__dirname, '..', 'uploads');
            if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
            cb(null, uploadPath);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = `${req.session.userId}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
            cb(null, `${uniqueSuffix}.upload`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: function (req, file, cb) {
        const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
        if (!allowedTypes.has(file.mimetype)) {
            return cb(new Error('Envie somente imagens JPG, PNG, GIF ou WEBP.'));
        }
        cb(null, true);
    }
});
const feedUpload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
        const extension = path.extname(file.originalname).toLowerCase();
        const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']);
        if (allowedTypes.has(file.mimetype) && allowedExtensions.has(extension)) {
            return cb(null, true);
        }
        return cb(new Error('Anexe somente imagens JPG, PNG, GIF, WEBP ou arquivos PDF.'));
    }
});


function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    return res.status(401).json({ message: 'Acesso não autorizado. Por favor, faça login.' });
}

function hasZabbixPermission(req, res, next) {
    const permissions = Array.isArray(req.session?.permissions) ? req.session.permissions : [];
    const role = req.session?.role;
    const allowed = role === 'admin' || permissions.includes('zabbix') || permissions.includes('zabbix:ack') || permissions.includes('monitoramento');
    if (allowed) return next();
    return res.status(403).json({ message: 'Sem permissão para registrar ACK no Zabbix.' });
}

function getShiftIdentifier() {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hour = now.getHours();
    let shift = (hour >= 6 && hour < 18) ? 'DIA' : 'NOITE';
    return `${year}-${month}-${day}-${shift}`;
}

app.post('/api/login', async (req, res) => {
    const { username, password, rememberMe } = req.body;
    const sql = 'SELECT * FROM users WHERE username = ?';
    try {
        const [rows] = await db.execute(sql, [username]);
        const user = rows[0];

        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ message: 'Usuário ou senha inválidos.' });
        }

        const permissionsValue = user.permissions;
        const parsedPermissions = (() => {
            if (!permissionsValue) return [];
            if (Array.isArray(permissionsValue)) return permissionsValue.filter(Boolean);
            try {
                const parsed = JSON.parse(permissionsValue);
                return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
            } catch (e) {
                return [];
            }
        })();

        const secretKey = process.env.SECRET_KEY;
        const token = jwt.sign({ sub: user.username }, secretKey, { expiresIn: '8h' });
        res.cookie('access_token', `Bearer ${token}`, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 48 * 60 * 60 * 1000
        });

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.name = user.name;
        req.session.role = user.role;
        req.session.permissions = parsedPermissions;
        req.session.cookie.maxAge = rememberMe === true ? REMEMBER_ME_MAX_AGE : null;

        res.json({
            message: 'Login bem-sucedido!',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar_url: user.avatar_url,
                name: user.name,
                permissions: parsedPermissions
            }
        });

    } catch (err) {
        console.error('Erro no servidor durante o login:', err.message);
        return res.status(500).json({ message: 'Erro interno no servidor.' });
    }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ message: 'Não foi possível fazer logout.' });
    }
    res.clearCookie('connect.sid'); 
    res.json({ message: 'Logout bem-sucedido.' });
  });
});

// --- ROTAS PROTEGIDAS (Precisam de login) ---

app.get('/api/profile', isAuthenticated, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const sql = 'SELECT id, username, email, avatar_url, name, role, cargo, jornada_trabalho, telefone, permissions FROM users WHERE id = ?';
        
        const [rows] = await db.execute(sql, [req.session.userId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        const userProfile = rows[0];
        let permissoesArray = [];
        try {
            if (userProfile.permissions) {
                if (Array.isArray(userProfile.permissions)) {
                    permissoesArray = userProfile.permissions;
                } else {
                    permissoesArray = JSON.parse(userProfile.permissions);
                }
            }
        } catch (e) {
            console.error("Erro ao ler permissões no banco:", e);
        }
        
        res.json({
            id: userProfile.id,
            username: userProfile.username,
            email: userProfile.email,
            avatar_url: userProfile.avatar_url,
            name: userProfile.name,
            role: userProfile.role,
            cargo: userProfile.cargo,
            jornada_trabalho: userProfile.jornada_trabalho,
            telefone: userProfile.telefone,
            permissions: permissoesArray 
        });

    } catch (err) {
        console.error("Erro ao buscar perfil:", err.message);
        res.status(500).json({ message: "Erro interno ao buscar perfil." });
    }
});

app.put('/api/profile/update', isAuthenticated, async (req, res) => {
    const { name, username, telefone } = req.body;
    const userId = req.session.userId;

    if (typeof name !== 'string' || typeof username !== 'string' ||
        typeof telefone !== 'string' || !name.trim() || !username.trim()) {
        return res.status(400).json({ message: 'Nome e nome de usuário são obrigatórios.' });
    }
    if (name.trim().length > 120 || username.trim().length > 120 || telefone.trim().length > 40) {
        return res.status(400).json({ message: 'Um ou mais campos excedem o tamanho permitido.' });
    }
    try {
        const sql = 'UPDATE users SET name = ?, username = ?, telefone = ? WHERE id = ?';
        await db.execute(sql, [name.trim(), username.trim(), telefone.trim(), userId]);
        
        req.session.username = username.trim();
        req.session.name = name.trim();

        res.json({ message: 'Perfil atualizado com sucesso!' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Erro: O novo nome de usuário já está em uso.' });
        }
        console.error('Erro ao atualizar perfil:', err.message);
        res.status(500).json({ message: 'Erro interno ao atualizar o perfil.' });
    }
});

let savedPostsTableReady;
async function ensureSavedPostsTable() {
    if (!savedPostsTableReady) {
        savedPostsTableReady = db.execute(`
            CREATE TABLE IF NOT EXISTS user_saved_posts (
                user_id BIGINT NOT NULL,
                post_id BIGINT NOT NULL,
                saved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, post_id),
                INDEX idx_user_saved_posts_post (post_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `).catch(error => {
            savedPostsTableReady = null;
            throw error;
        });
    }
    await savedPostsTableReady;
}

app.put('/api/posts/:id/saved', isAuthenticated, async (req, res) => {
    const postId = req.params.id;
    const isSaved = req.body.saved === true;
    try {
        await ensureSavedPostsTable();
        const [postRows] = await db.execute('SELECT id FROM posts WHERE id = ?', [postId]);
        if (!postRows.length) return res.status(404).json({ message: 'Publicação não encontrada.' });

        if (isSaved) {
            await db.execute('INSERT IGNORE INTO user_saved_posts (user_id, post_id) VALUES (?, ?)', [req.session.userId, postId]);
        } else {
            await db.execute('DELETE FROM user_saved_posts WHERE user_id = ? AND post_id = ?', [req.session.userId, postId]);
        }
        res.json({ post_id: Number(postId), saved: isSaved });
    } catch (error) {
        console.error('Erro ao atualizar publicações salvas:', error.message);
        res.status(500).json({ message: 'Não foi possível atualizar os posts salvos.' });
    }
});

let userNotesTableReady;
async function ensureUserNotesTable() {
    if (!userNotesTableReady) {
        userNotesTableReady = db.execute(`
            CREATE TABLE IF NOT EXISTS user_notes (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                title VARCHAR(120) NOT NULL DEFAULT 'Nova nota',
                category VARCHAR(20) NOT NULL DEFAULT 'Geral',
                content LONGTEXT NOT NULL,
                color VARCHAR(20) NOT NULL DEFAULT 'yellow',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user_notes_user_updated (user_id, updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `).catch(error => {
            userNotesTableReady = null;
            throw error;
        });
    }
    await userNotesTableReady;
}

const userNoteCategories = new Set(['Geral', 'Chamados', 'Acessos']);
const userNoteColors = new Set(['yellow', 'pink', 'blue', 'green', 'lavender']);

app.get('/api/notes', isAuthenticated, async (req, res) => {
    try {
        await ensureUserNotesTable();
        const [rows] = await db.execute(
            'SELECT id, title, category, content, color, created_at, updated_at FROM user_notes WHERE user_id = ? ORDER BY updated_at DESC, id DESC',
            [req.session.userId]
        );
        res.setHeader('Cache-Control', 'no-store');
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar notas pessoais:', error.message);
        res.status(500).json({ message: 'Não foi possível carregar suas notas.' });
    }
});

app.post('/api/notes', isAuthenticated, async (req, res) => {
    const title = String(req.body.title || 'Nova nota').trim().slice(0, 120) || 'Nova nota';
    const category = userNoteCategories.has(req.body.category) ? req.body.category : 'Geral';
    const content = String(req.body.content || '');
    const color = userNoteColors.has(req.body.color) ? req.body.color : 'yellow';
    if (content.length > 50000) return res.status(413).json({ message: 'A nota pode ter no máximo 50.000 caracteres.' });

    try {
        await ensureUserNotesTable();
        const [result] = await db.execute(
            'INSERT INTO user_notes (user_id, title, category, content, color) VALUES (?, ?, ?, ?, ?)',
            [req.session.userId, title, category, content, color]
        );
        const [rows] = await db.execute(
            'SELECT id, title, category, content, color, created_at, updated_at FROM user_notes WHERE id = ? AND user_id = ?',
            [result.insertId, req.session.userId]
        );
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Erro ao criar nota pessoal:', error.message);
        res.status(500).json({ message: 'Não foi possível criar a nota.' });
    }
});

app.put('/api/notes/:id', isAuthenticated, async (req, res) => {
    const title = String(req.body.title || 'Nova nota').trim().slice(0, 120) || 'Nova nota';
    const category = userNoteCategories.has(req.body.category) ? req.body.category : 'Geral';
    const content = String(req.body.content || '');
    const color = userNoteColors.has(req.body.color) ? req.body.color : 'yellow';
    if (content.length > 50000) return res.status(413).json({ message: 'A nota pode ter no máximo 50.000 caracteres.' });

    try {
        await ensureUserNotesTable();
        await db.execute(
            'UPDATE user_notes SET title = ?, category = ?, content = ?, color = ? WHERE id = ? AND user_id = ?',
            [title, category, content, color, req.params.id, req.session.userId]
        );
        const [rows] = await db.execute(
            'SELECT id, title, category, content, color, created_at, updated_at FROM user_notes WHERE id = ? AND user_id = ?',
            [req.params.id, req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ message: 'Nota não encontrada.' });
        res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao atualizar nota pessoal:', error.message);
        res.status(500).json({ message: 'Não foi possível salvar a nota.' });
    }
});

app.delete('/api/notes/:id', isAuthenticated, async (req, res) => {
    try {
        await ensureUserNotesTable();
        const [result] = await db.execute('DELETE FROM user_notes WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!result.affectedRows) return res.status(404).json({ message: 'Nota não encontrada.' });
        res.status(204).end();
    } catch (error) {
        console.error('Erro ao excluir nota pessoal:', error.message);
        res.status(500).json({ message: 'Não foi possível excluir a nota.' });
    }
});

app.post('/api/profile/avatar', isAuthenticated, avatarUpload.single('avatar'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Nenhum arquivo foi enviado.' });
    }
    try {
        const header = fs.readFileSync(req.file.path);
        let extension = null;
        if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) extension = '.jpg';
        else if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) extension = '.png';
        else if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') extension = '.gif';
        else if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') extension = '.webp';

        if (!extension) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ message: 'O conteúdo enviado não corresponde a uma imagem válida.' });
        }

        const safeFilename = `${req.session.userId}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
        const safePath = path.join(path.dirname(req.file.path), safeFilename);
        fs.renameSync(req.file.path, safePath);
        const avatarUrl = `/uploads/${safeFilename}`;

        const sql = 'UPDATE users SET avatar_url = ? WHERE id = ?';
        await db.execute(sql, [avatarUrl, req.session.userId]);

        res.json({
            message: 'Avatar atualizado com sucesso!',
            avatar_url: avatarUrl
        });

    } catch (err) {
        console.error("Erro ao salvar o avatar:", err.message);
        res.status(500).json({ message: "Erro interno ao salvar o avatar." });
    }
});
app.put('/api/password/change', isAuthenticated, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.session.userId;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ message: 'A nova senha deve ter pelo menos 6 caracteres.' });
    }

    try {
        const sqlSelect = 'SELECT password_hash FROM users WHERE id = ?';
        const [rows] = await db.execute(sqlSelect, [userId]);
        const user = rows[0];

        if (!user) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
            return res.status(401).json({ message: 'A senha atual está incorreta.' });
        }

        const salt = bcrypt.genSaltSync(10);
        const newPasswordHash = bcrypt.hashSync(newPassword, salt);
        const sqlUpdate = 'UPDATE users SET password_hash = ? WHERE id = ?';
        await db.execute(sqlUpdate, [newPasswordHash, userId]);

        res.json({ message: 'Senha alterada com sucesso!' });

    } catch (err) {
        console.error('Erro ao alterar senha:', err.message);
        res.status(500).json({ message: 'Erro interno ao alterar a senha.' });
    }
});

// ==========================================
// --- INTEGRAÇÃO ZABBIX API  ---
// ==========================================
const ZABBIX_URL = process.env.ZABBIX_URL;
const ZBX_ROBOT_USER = process.env.ZABBIX_ROBOT_USER;
const ZBX_ROBOT_PASS = process.env.ZABBIX_ROBOT_PASS;

let zabbixRobotToken = null; // Guarda o token do robô na memória do servidor

// Função inteligente que gera (ou reaproveita) o token do Robô
async function getRobotToken() {
    // Se já temos um token, tentamos usar. Mas se der erro, vamos gerar um novo.
    if (zabbixRobotToken) return zabbixRobotToken;

    if (!ZBX_ROBOT_USER || !ZBX_ROBOT_PASS) {
        throw new Error('Defina ZABBIX_ROBOT_USER e ZABBIX_ROBOT_PASS no arquivo .env.');
    }

    try {
        console.log(`🤖 Tentando autenticar robô: ${ZBX_ROBOT_USER}...`);
        
        const response = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0",
            method: "user.login",
            params: { 
                username: ZBX_ROBOT_USER, 
                password: ZBX_ROBOT_PASS 
            },
            id: 1,
            auth: null
        });

        if (response.data.error) {
            // Se o Zabbix responder com erro, mostramos o motivo real do Zabbix no terminal
            console.error("❌ Zabbix rejeitou o robô:", response.data.error.data || response.data.error.message);
            throw new Error(response.data.error.message);
        }

        zabbixRobotToken = response.data.result;
        console.log("✅ Token de serviço gerado!");
        return zabbixRobotToken;
    } catch (err) {
        zabbixRobotToken = null; // Limpa o token em caso de falha
        throw err;
    }
}

async function callZabbixApi(method, params = {}, id = 50, authenticated = true) {
    const payload = { jsonrpc: '2.0', method, params, id };
    if (authenticated) payload.auth = await getRobotToken();
    const response = await axios.post(ZABBIX_URL, payload);
    if (response.data.error) {
        const error = response.data.error;
        throw new Error(error.data || error.message || `Erro na API do Zabbix (${method}).`);
    }
    return response.data.result;
}

// --- Total de hosts monitorados (para a disponibilidade do dashboard) ---
// Uma única consulta host.get fica em cache por 60 s; a contagem por setor é feita em memória.
const MONITORED_HOSTS_TTL_MS = 60 * 1000;
let monitoredHostsCache = { at: 0, hosts: null, pending: null };

async function getMonitoredHosts() {
    const now = Date.now();
    if (monitoredHostsCache.hosts && now - monitoredHostsCache.at < MONITORED_HOSTS_TTL_MS) return monitoredHostsCache.hosts;
    if (monitoredHostsCache.pending) return monitoredHostsCache.pending;

    monitoredHostsCache.pending = (async () => {
        try {
            const result = await callZabbixApi('host.get', {
                output: ['hostid'],
                monitored_hosts: true,          // somente hosts habilitados
                selectTags: 'extend',
                selectInheritedTags: 'extend'   // tags herdadas de templates (Zabbix 6.2+)
            }, 60);
            const hosts = (result || []).map(host => ({
                hostid: host.hostid,
                tags: [...(host.tags || []), ...(host.inheritedTags || [])]
            }));
            monitoredHostsCache = { at: Date.now(), hosts, pending: null };
            return hosts;
        } catch (error) {
            monitoredHostsCache.pending = null;
            zabbixRobotToken = null;            // força novo login do robô na próxima chamada
            throw error;
        }
    })();
    return monitoredHostsCache.pending;
}

// Mesmos critérios usados nos problemas: tag Setor (contém, sem diferenciar maiúsculas) e exclusão de Local=EXTERNO
function countMonitoredHosts(hosts, setor) {
    const wanted = !setor || setor === 'Geral' ? null : String(setor).toLowerCase();
    return hosts.filter(host => {
        const isExternal = host.tags.some(tag => String(tag.tag || '').toLowerCase() === 'local' && String(tag.value || '').toUpperCase() === 'EXTERNO');
        if (isExternal) return false;
        if (!wanted) return true;
        return host.tags.some(tag => String(tag.tag || '').toLowerCase() === 'setor' && String(tag.value || '').toLowerCase().includes(wanted));
    }).length;
}

function getZabbixReportWindow(query) {
    const allowedHours = new Set([1, 24, 168, 720]);
    const hours = Number(query.hours || 24);
    const safeHours = allowedHours.has(hours) ? hours : 24;
    const to = Math.floor(Date.now() / 1000);
    return { from: to - safeHours * 60 * 60, to };
}

app.get('/api/zabbix/reports/system', isAuthenticated, async (req, res) => {
    const [version, enabledHosts, disabledHosts, enabledItems, activeTriggers, actions] = await Promise.allSettled([
        callZabbixApi('apiinfo.version', {}, 51, false),
        callZabbixApi('host.get', { countOutput: true, filter: { status: '0' } }, 52),
        callZabbixApi('host.get', { countOutput: true, filter: { status: '1' } }, 53),
        callZabbixApi('item.get', { countOutput: true, filter: { status: '0' } }, 54),
        callZabbixApi('trigger.get', { countOutput: true, filter: { status: '0', value: '1' } }, 55),
        callZabbixApi('action.get', { countOutput: true }, 56)
    ]);
    const valueOf = (result, fallback = 'Indisponível') => result.status === 'fulfilled' ? result.value : fallback;
    const versionValue = valueOf(version);
    res.setHeader('Cache-Control', 'no-store');
    res.json([
        { parameter: 'Status do Zabbix', value: version.status === 'fulfilled' ? 'Conectado' : 'Indisponível', details: version.status === 'fulfilled' ? 'API do Zabbix respondeu à solicitação.' : version.reason.message },
        { parameter: 'Versão do servidor', value: versionValue, details: 'Versão retornada por apiinfo.version.' },
        { parameter: 'Hosts habilitados/desabilitados', value: `${valueOf(enabledHosts)}/${valueOf(disabledHosts)}`, details: 'Contagem consultada na API de hosts.' },
        { parameter: 'Itens habilitados', value: valueOf(enabledItems), details: 'Itens de monitoramento com status habilitado.' },
        { parameter: 'Gatilhos ativos', value: valueOf(activeTriggers), details: 'Gatilhos habilitados atualmente em estado de problema.' },
        { parameter: 'Ações configuradas', value: valueOf(actions), details: 'Regras de ação registradas no Zabbix.' },
        { parameter: 'Última atualização', value: new Date().toLocaleString('pt-BR'), details: 'Horário local deste portal.' },
        { parameter: 'Desempenho do servidor', value: 'Não exposto pela API JSON-RPC', details: 'O desempenho interno do processo Zabbix não é fornecido por estes métodos públicos da API.' }
    ]);
});

app.get('/api/zabbix/reports/scheduled', isAuthenticated, async (req, res) => {
    try {
        // Mantém os parâmetros básicos para compatibilidade com versões antigas do Zabbix.
        const result = await callZabbixApi('report.get', { output: 'extend' }, 57);
        res.setHeader('Cache-Control', 'no-store');
        res.json((result || []).sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), 'pt-BR')));
    } catch (err) {
        res.status(502).json({ message: `A API do Zabbix não disponibilizou relatórios programados: ${err.message}` });
    }
});

app.get('/api/zabbix/reports/availability', isAuthenticated, async (req, res) => {
    try {
        const slas = await callZabbixApi('sla.get', { output: 'extend', selectSchedule: 'extend', sortfield: 'name', sortorder: 'ASC' }, 58);
        const { from, to } = getZabbixReportWindow(req.query);
        const results = await Promise.all((slas || []).map(async sla => {
            try {
                const sli = await callZabbixApi('sla.getsli', { slaid: sla.slaid, period_from: from, period_to: to }, 59);
                return { ...sla, sli };
            } catch (error) {
                return { ...sla, report_error: error.message };
            }
        }));
        res.setHeader('Cache-Control', 'no-store');
        res.json(results);
    } catch (err) {
        res.status(502).json({ message: `O relatório de disponibilidade requer a API SLA do Zabbix: ${err.message}` });
    }
});

app.get('/api/zabbix/reports/top-triggers', isAuthenticated, async (req, res) => {
    try {
        const triggers = await callZabbixApi('trigger.get', {
            output: ['triggerid', 'description', 'priority', 'status', 'value', 'lastchange', 'state'],
            monitored: true,
            active: true,
            expandDescription: true,
            selectHosts: ['hostid', 'name'],
            selectTags: 'extend',
            sortfield: 'priority',
            sortorder: 'DESC',
            limit: 100
        }, 60);
        res.setHeader('Cache-Control', 'no-store');
        res.json(triggers || []);
    } catch (err) {
        res.status(502).json({ message: `Não foi possível listar os principais gatilhos: ${err.message}` });
    }
});

app.get('/api/zabbix/reports/audit', isAuthenticated, async (req, res) => {
    const { from, to } = getZabbixReportWindow(req.query);
    try {
        const entries = await callZabbixApi('auditlog.get', {
            output: 'extend',
            time_from: from,
            time_till: to,
            sortfield: 'auditid',
            sortorder: 'DESC',
            limit: 500
        }, 61);
        res.setHeader('Cache-Control', 'no-store');
        res.json(entries || []);
    } catch (err) {
        res.status(502).json({ message: `Não foi possível consultar o log de auditoria: ${err.message}` });
    }
});

app.get('/api/zabbix/reports/actions', isAuthenticated, async (req, res) => {
    const { from, to } = getZabbixReportWindow(req.query);
    try {
        const alerts = await callZabbixApi('alert.get', {
            output: 'extend',
            time_from: from,
            time_till: to,
            sortfield: 'alertid',
            sortorder: 'DESC',
            limit: 500
        }, 62);
        res.setHeader('Cache-Control', 'no-store');
        res.json(alerts || []);
    } catch (err) {
        res.status(502).json({ message: `Não foi possível consultar o log de ações/notificações: ${err.message}` });
    }
});

app.get('/api/zabbix/reports/notifications', isAuthenticated, async (req, res) => {
    const { from, to } = getZabbixReportWindow(req.query);
    try {
        const alerts = await callZabbixApi('alert.get', {
            output: 'extend',
            time_from: from,
            time_till: to,
            sortfield: 'alertid',
            sortorder: 'DESC',
            limit: 500
        }, 63);
        res.setHeader('Cache-Control', 'no-store');
        res.json((alerts || []).filter(alert => String(alert.alerttype) === '0'));
    } catch (err) {
        res.status(502).json({ message: `Não foi possível consultar as notificações: ${err.message}` });
    }
});

// 1. Rota para buscar os Problemas 
app.get('/api/zabbix/problems', isAuthenticated, async (req, res) => {
    const setor = req.query.setor || 'Geral'; 
    try {
        const token = await getRobotToken();
        let apiParams = {
            output: "extend", recent: false, sortfield: "eventid", sortorder: "DESC",
            selectTags: "extend", selectAcknowledges: "extend",
            object: 0, severities: [0, 2, 3, 4, 5], suppressed: false
        };
        if (typeof req.query.severities === 'string') {
            const requestedSeverities = req.query.severities.split(',').map(value => Number(value.trim()));
            if (requestedSeverities.length > 0 && requestedSeverities.every(value => Number.isInteger(value) && value >= 0 && value <= 5)) {
                apiParams.severities = [...new Set(requestedSeverities)];
            }
        }
        if (req.query.recent === 'true') apiParams.recent = true;
        if (req.query.suppressed === 'true') apiParams.suppressed = true;
        if (req.query.symptoms === 'true') apiParams.symptom = true;
        const requestedHours = Number(req.query.hours || 0);
        if ([1, 24, 168, 720].includes(requestedHours)) {
            apiParams.time_from = Math.floor(Date.now() / 1000) - requestedHours * 60 * 60;
            apiParams.time_till = Math.floor(Date.now() / 1000);
        }
        if (setor !== 'Geral') {
            apiParams.tags = [{ tag: "Setor", value: setor, operator: 0 }];
            apiParams.evaltype = 0;
        }
        const response = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0", method: "problem.get", params: apiParams, auth: token, id: 2
        });
        let problemas = response.data.result || [];

        if (problemas.length > 0) {
            const triggerIds = [...new Set(problemas.map(p => p.objectid))];
            const triggersRes = await axios.post(ZABBIX_URL, {
                jsonrpc: "2.0", method: "trigger.get",
                params: { triggerids: triggerIds, output: ["triggerid", "description", "opdata"], selectHosts: ["hostid", "name"] },
                auth: token, id: 3
            });
            const triggers = triggersRes.data.result || [];
            const hostIds = [...new Set(triggers.map(t => t.hosts[0]?.hostid).filter(Boolean))];

            const hostInfoMap = {};
            if (hostIds.length > 0) {
                const hostsRes = await axios.post(ZABBIX_URL, {
                    jsonrpc: "2.0", method: "host.get",
                    params: { hostids: hostIds, output: ["hostid", "name"], selectInterfaces: ["ip"], selectGroups: ["name"], selectInventory: "extend" },
                    auth: token, id: 4
                });
                (hostsRes.data.result || []).forEach(h => {
                    hostInfoMap[h.hostid] = {
                        ip: h.interfaces?.[0]?.ip || h.interfaces?.[0]?.dns || 'Sem IP',
                        groups: (h.groups || []).map(group => group.name),
                        inventory: h.inventory || {}
                    };
                });
            }
            const triggerHostMap = {};
            triggers.forEach(t => {
                if (t.hosts?.length > 0) {
                    const host = t.hosts[0];
                    triggerHostMap[t.triggerid] = {
                        name: host.name,
                        ...(hostInfoMap[host.hostid] || { ip: 'Sem IP', groups: [], inventory: {} })
                    };
                }
            });
            problemas = problemas.map(p => ({
                ...p,
                hostName: triggerHostMap[p.objectid]?.name || 'Host Desconhecido',
                hostIp: triggerHostMap[p.objectid]?.ip || 'Sem IP',
                hostGroups: triggerHostMap[p.objectid]?.groups || [],
                hostInventory: triggerHostMap[p.objectid]?.inventory || {},
                opdata: p.opdata || triggers.find(trigger => trigger.triggerid === p.objectid)?.opdata || '--'
            }));

            const ackUserIds = [...new Set(problemas.flatMap(problem => (problem.acknowledges || [])
                .map(ack => ack.userid).filter(Boolean).map(String)))];
            const ackUserNames = {};
            if (ackUserIds.length) {
                try {
                    const usersResponse = await axios.post(ZABBIX_URL, {
                        jsonrpc: "2.0", method: "user.get",
                        params: { userids: ackUserIds, output: "extend" },
                        auth: token, id: 5
                    });
                    (usersResponse.data.result || []).forEach(user => {
                        ackUserNames[String(user.userid)] = [user.name, user.surname].filter(Boolean).join(' ')
                            || user.username || user.alias || `Usuário ${user.userid}`;
                    });
                } catch (userLookupError) {
                    console.warn('Não foi possível resolver os nomes dos usuários dos ACKs:', userLookupError.message);
                }
            }
            problemas = problemas.map(problem => ({
                ...problem,
                acknowledges: (problem.acknowledges || []).map(ack => ({
                    ...ack,
                    userName: ackUserNames[String(ack.userid)] || (ack.userid ? `Usuário ${ack.userid}` : 'Operador NOC')
                }))
            }));
        }
        const visibleProblems = problemas.filter(prob => !(prob.tags || []).some(t => t.tag.toLowerCase() === 'local' && t.value.toUpperCase() === 'EXTERNO'));
        const hiddenInformativeCount = visibleProblems.filter(prob => Number(prob.severity) === 1).length;
        const filteredProblems = visibleProblems.filter(prob => Number(prob.severity) !== 1);
        // Total de hosts monitorados (nulo se não for possível calcular; o painel mostra "—" nesse caso)
        let totalHosts = null;
        try {
            totalHosts = countMonitoredHosts(await getMonitoredHosts(), setor) || null;
        } catch (hostsError) {
            console.warn('Não foi possível obter o total de hosts monitorados:', hostsError.message);
        }
        res.json({
            serverTime: Math.floor(Date.now() / 1000),   // epoch em segundos (o painel também aceita milissegundos)
            hiddenInformativeCount,
            totalHosts,
            problems: filteredProblems
        });
    } catch (err) { res.status(500).json({ message: "Erro ao processar requisição." }); }
});

app.get('/api/zabbix/events/history', isAuthenticated, async (req, res) => {
    const requestedHours = Number(req.query.hours || 1);
    const allowedHours = new Set([1, 24, 168, 720]);
    const hours = allowedHours.has(requestedHours) ? requestedHours : 1;
    try {
        const token = await getRobotToken();
        const now = Math.floor(Date.now() / 1000);
        const severities = typeof req.query.severities === 'string'
            ? req.query.severities.split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value >= 0 && value <= 5)
            : [];
        const response = await axios.post(ZABBIX_URL, {
            jsonrpc: '2.0',
            method: 'event.get',
            params: {
                output: 'extend',
                source: 0,
                object: 0,
                value: 1,
                time_from: now - hours * 60 * 60,
                time_till: now,
                sortfield: ['clock', 'eventid'],
                sortorder: 'DESC',
                limit: 1000,
                selectTags: 'extend',
                select_acknowledges: 'extend'
            },
            auth: token,
            id: 32
        });
        if (response.data.error) throw new Error(response.data.error.message || 'Falha ao buscar histórico no Zabbix.');

        let events = response.data.result || [];
        if (severities.length) events = events.filter(event => severities.includes(Number(event.severity)));
        if (req.query.suppressed !== 'true') {
            events = events.filter(event => !event.suppressed && !(event.suppression_data || []).length);
        }
        if (events.length) {
            const triggerIds = [...new Set(events.map(event => event.objectid).filter(Boolean))];
            const triggersResponse = await axios.post(ZABBIX_URL, {
                jsonrpc: '2.0',
                method: 'trigger.get',
                params: { triggerids: triggerIds, output: ['triggerid', 'description', 'opdata'], selectHosts: ['hostid', 'name'] },
                auth: token,
                id: 33
            });
            const triggers = triggersResponse.data.result || [];
            const hostIds = [...new Set(triggers.flatMap(trigger => (trigger.hosts || []).map(host => host.hostid)))];
            const hostInfo = {};
            if (hostIds.length) {
                const hostsResponse = await axios.post(ZABBIX_URL, {
                    jsonrpc: '2.0',
                    method: 'host.get',
                    params: { hostids: hostIds, output: ['hostid', 'name'], selectInterfaces: ['ip'], selectGroups: ['name'], selectInventory: 'extend' },
                    auth: token,
                    id: 34
                });
                (hostsResponse.data.result || []).forEach(host => {
                    hostInfo[host.hostid] = {
                        ip: host.interfaces?.[0]?.ip || host.interfaces?.[0]?.dns || 'Sem IP',
                        groups: (host.groups || []).map(group => group.name),
                        inventory: host.inventory || {}
                    };
                });
            }
            const triggerMap = {};
            triggers.forEach(trigger => {
                const host = trigger.hosts?.[0];
                triggerMap[trigger.triggerid] = {
                    name: host?.name || 'Host desconhecido',
                    ...(hostInfo[host?.hostid] || { ip: 'Sem IP', groups: [], inventory: {} }),
                    description: trigger.description,
                    opdata: trigger.opdata
                };
            });
            events = events.map(event => ({
                ...event,
                severity: event.severity || event.acknowledges?.[0]?.severity || '0',
                name: triggerMap[event.objectid]?.description || event.name || 'Evento Zabbix',
                hostName: triggerMap[event.objectid]?.name || 'Host desconhecido',
                hostIp: triggerMap[event.objectid]?.ip || 'Sem IP',
                hostGroups: triggerMap[event.objectid]?.groups || [],
                hostInventory: triggerMap[event.objectid]?.inventory || {},
                opdata: triggerMap[event.objectid]?.opdata || '--',
                acknowledges: event.acknowledges || []
            }));
        }
        events = events.filter(event => !(event.tags || []).some(tag => tag.tag?.toLowerCase() === 'local' && tag.value?.toUpperCase() === 'EXTERNO'));
        res.setHeader('Cache-Control', 'no-store');
        res.json(events);
    } catch (err) {
        console.error('Erro ao consultar histórico do Zabbix:', err.message);
        res.status(500).json({ message: 'Não foi possível consultar o histórico do Zabbix.' });
    }
});

// 2. Rota para dar ACK 
app.post('/api/zabbix/ack', isAuthenticated, hasZabbixPermission, async (req, res) => {
    const { eventId, ticketNumber } = req.body;

    try {
        const token = await getRobotToken();
        const normalized = String(ticketNumber || '').trim().replace(/\s+/g, ' ');

        if (!eventId || !normalized || normalized.length > 200) {
            return res.status(400).json({ message: 'Informe um chamado ou mensagem de até 200 caracteres para registrar o ACK.' });
        }

        const operadorNome = req.session.name || req.session.username || 'Operador NOC';
        const message = `${normalized} | operador: ${operadorNome}`;
        if (message.length > 255) {
            return res.status(400).json({ message: 'O texto do ACK excede o limite aceito pelo Zabbix.' });
        }

        const response = await axios.post(ZABBIX_URL, {
            jsonrpc: '2.0',
            method: 'event.acknowledge',
            params: {
                eventids: [Number(eventId)],
                action: 6,
                message
            },
            auth: token,
            id: 3
        });

        if (response.data.error) {
            zabbixRobotToken = null;
            return res.status(400).json({ message: 'Erro ao registrar o ACK no Zabbix.' });
        }

        res.json({ message: 'Incidente reconhecido com sucesso!' });
    } catch (err) {
        console.error('Erro ao enviar ACK:', err.message);
        res.status(500).json({ message: 'Erro interno ao enviar ACK.' });
    }
});

// 3. Rota para buscar Hosts com Filtro Avançado
app.post('/api/zabbix/hosts/filter', isAuthenticated, async (req, res) => {
    try {
        const { hostgroup, hostname, ip, status, tag_name, tag_value } = req.body;
        const token = await getRobotToken();

        // Monta a consulta básica para a API do Zabbix
        let params = {
            output: ["hostid", "host", "name", "status"],
            selectInterfaces: ["ip", "dns", "useip"],
            selectTags: "extend",
            selectGroups: ["name"], // Traz os grupos que o host pertence
            search: {},
            filter: {}
        };

        // Filtro por Nome do Host
        if (hostname) {
            params.search.name = hostname;
            params.searchWildcardsEnabled = true;
        }

        // Filtro por Status (0 = Monitorado, 1 = Não monitorado)
        if (status && status !== 'any') {
            params.filter.status = status;
        }

        // Filtro por Tags nativo do Zabbix
        if (tag_name || tag_value) {
            params.tags = [{}];
            if (tag_name) params.tags[0].tag = tag_name;
            if (tag_value) params.tags[0].value = tag_value;
        }

        // Vai no Zabbix e busca
        const response = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0",
            method: "host.get",
            params: params,
            auth: token,
            id: 20
        });

        let hosts = response.data.result || [];

        // Filtros Pós-Busca (Mais rápidos para relações complexas como IP e Grupos)
        if (ip) {
            hosts = hosts.filter(h => 
                h.interfaces.some(inf => inf.ip.includes(ip) || inf.dns.includes(ip))
            );
        }

        if (hostgroup) {
            const hgLower = hostgroup.toLowerCase();
            hosts = hosts.filter(h => 
                h.groups.some(g => g.name.toLowerCase().includes(hgLower))
            );
        }

        res.json(hosts);
    } catch (err) {
        console.error("Erro ao buscar hosts no Zabbix:", err.message);
        res.status(500).json({ message: "Erro ao buscar hosts filtrados." });
    }
});

// Endpoint para buscar histórico de um Host
app.get('/api/zabbix/host-history', isAuthenticated, async (req, res) => {
    const { hostName } = req.query;
    try {
        const token = await getRobotToken();

        // 1. Buscar o Host ID pelo nome
        const hostRes = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0", method: "host.get",
            params: { filter: { name: [hostName] } },
            auth: token, id: 10
        });
        const hostId = hostRes.data.result[0]?.hostid;
        if (!hostId) return res.status(404).json({ message: "Host não encontrado" });

        // 2. Buscar um Item específico (Ex: ICMP Ping ou CPU Load)
        // Aqui buscamos itens que contenham "ICMP" no nome
        const itemRes = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0", method: "item.get",
            params: { hostids: hostId, search: { name: "ICMP" } },
            auth: token, id: 11
        });
        const item = itemRes.data.result[0];
        if (!item) return res.status(404).json({ message: "Nenhum item de histórico compatível" });

        // 3. Buscar o Histórico (últimas 24 horas)
        const historyRes = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0", method: "history.get",
            params: {
                itemids: item.itemid,
                history: item.value_type, // 0 para float, 3 para int
                sortfield: "clock",
                sortorder: "DESC",
                limit: 50
            },
            auth: token, id: 12
        });

        res.json({
            itemName: item.name,
            history: historyRes.data.result.reverse() // Inverte para ordem cronológica no gráfico
        });
    } catch (err) {
        res.status(500).json({ message: "Erro ao buscar histórico no Zabbix" });
    }
});

// Rota 1: Busca os itens (métricas) disponíveis para um Host
app.get('/api/zabbix/host-items', isAuthenticated, async (req, res) => {
    const { hostName } = req.query;
    try {
        const token = await getRobotToken();

        // 1. Descobre o ID do Host
        const hostRes = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0", method: "host.get",
            params: { filter: { name: [hostName] } },
            auth: token, id: 10
        });
        
        const hostId = hostRes.data.result[0]?.hostid;
        if (!hostId) return res.status(404).json({ message: "Host não encontrado" });

        // 2. Busca todos os Itens numéricos (value_type 0 = Float, 3 = Inteiro)
        const itemRes = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0", method: "item.get",
            params: {
                hostids: hostId,
                filter: { value_type: [0, 3] }, // Apenas métricas que geram gráficos
                output: ["itemid", "name", "value_type", "units"],
                sortfield: "name"
            },
            auth: token, id: 11
        });

        res.json(itemRes.data.result);
    } catch (err) {
        res.status(500).json({ message: "Erro ao buscar métricas no Zabbix" });
    }
});

// Rota 2: Busca o histórico de um Item específico
app.get('/api/zabbix/item-history', isAuthenticated, async (req, res) => {
    const { itemid, valueType } = req.query;
    try {
        const token = await getRobotToken();

        const historyRes = await axios.post(ZABBIX_URL, {
            jsonrpc: "2.0", method: "history.get",
            params: {
                itemids: itemid,
                history: valueType, 
                sortfield: "clock",
                sortorder: "DESC",
                limit: 100 // Traz os últimos 100 pontos
            },
            auth: token, id: 12
        });

        res.json(historyRes.data.result.reverse());
    } catch (err) {
        res.status(500).json({ message: "Erro ao buscar histórico do item" });
    }
});

app.get('/api/posts', isAuthenticated, async (req, res) => {
    const sql = `
        SELECT 
            posts.id, posts.title, posts.content, posts.created_at, 
            users.username, users.name, users.avatar_url,
            (SELECT COUNT(*) FROM post_acknowledgements pa WHERE pa.post_id = posts.id) AS acknowledgement_count,
            EXISTS(SELECT 1 FROM post_acknowledgements pa WHERE pa.post_id = posts.id AND pa.user_id = ?) AS acknowledged_by_me,
            (SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = posts.id) AS comment_count,
            EXISTS(SELECT 1 FROM home_pinned_posts hp WHERE hp.post_id = posts.id) AS is_home_pinned,
            EXISTS(SELECT 1 FROM user_saved_posts usp WHERE usp.post_id = posts.id AND usp.user_id = ?) AS is_saved_by_me
        FROM posts 
        JOIN users ON posts.user_id = users.id
        ORDER BY posts.created_at DESC`;
    try {
            await ensureSavedPostsTable();
            const [rows] = await db.execute(sql, [req.session.userId, req.session.userId]);
        res.setHeader('Cache-Control', 'no-store');
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar posts:", err.message);
        res.status(500).json({ message: "Erro ao buscar posts."});
    }
});

app.get('/api/home/informatives', isAuthenticated, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT p.id, p.title, p.content, p.created_at, u.username, u.name, u.avatar_url,
                (SELECT COUNT(*) FROM post_acknowledgements pa WHERE pa.post_id = p.id) AS acknowledgement_count,
                EXISTS(SELECT 1 FROM post_acknowledgements pa WHERE pa.post_id = p.id AND pa.user_id = ?) AS acknowledged_by_me
            FROM home_pinned_posts hp
            JOIN posts p ON p.id = hp.post_id
            JOIN users u ON u.id = p.user_id
            WHERE p.title = 'Informativos'
            ORDER BY hp.created_at DESC`, [req.session.userId]);
        res.setHeader('Cache-Control', 'no-store');
        res.json(rows);
    } catch (err) {
        console.error('Erro ao carregar informativos fixados:', err.message);
        res.status(500).json({ message: 'Não foi possível carregar os informativos fixados.' });
    }
});

app.put('/api/posts/:id/home-pin', isAuthenticated, async (req, res) => {
    const postId = req.params.id;
    const shouldPin = req.body.pinned === true;
    try {
        const [rows] = await db.execute('SELECT id, user_id, title FROM posts WHERE id = ?', [postId]);
        if (rows.length === 0) return res.status(404).json({ message: 'Publicação não encontrada.' });
        if (rows[0].title !== 'Informativos') return res.status(400).json({ message: 'Somente publicações da categoria Informativos podem ser fixadas na página inicial.' });
        if (Number(rows[0].user_id) !== Number(req.session.userId) && req.session.role !== 'admin') {
            return res.status(403).json({ message: 'Somente o autor ou um administrador pode fixar esta publicação.' });
        }

        if (shouldPin) {
            await db.execute('INSERT INTO home_pinned_posts (post_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE post_id = VALUES(post_id)', [postId, req.session.userId]);
        } else {
            await db.execute('DELETE FROM home_pinned_posts WHERE post_id = ?', [postId]);
        }
        res.json({ post_id: Number(postId), pinned: shouldPin });
    } catch (err) {
        console.error('Erro ao atualizar fixação do informativo:', err.message);
        res.status(500).json({ message: 'Não foi possível atualizar a publicação fixada.' });
    }
});

app.post('/api/posts/:id/acknowledgements', isAuthenticated, async (req, res) => {
    const postId = req.params.id;
    const userId = req.session.userId;
    try {
        const [postRows] = await db.execute('SELECT id FROM posts WHERE id = ?', [postId]);
        if (postRows.length === 0) return res.status(404).json({ message: 'Publicação não encontrada.' });

        await db.execute('INSERT IGNORE INTO post_acknowledgements (post_id, user_id) VALUES (?, ?)', [postId, userId]);
        const [[countRow]] = await db.execute('SELECT COUNT(*) AS total FROM post_acknowledgements WHERE post_id = ?', [postId]);
        res.json({ acknowledged: true, count: Number(countRow.total) });
    } catch (err) {
        console.error('Erro ao confirmar leitura da publicação:', err.message);
        res.status(500).json({ message: 'Não foi possível registrar a confirmação.' });
    }
});

app.get('/api/posts/:id/comments', isAuthenticated, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT pc.id, pc.post_id, pc.user_id, pc.comment, pc.created_at, u.username, u.name, u.avatar_url
            FROM post_comments pc
            JOIN users u ON u.id = pc.user_id
            WHERE pc.post_id = ?
            ORDER BY pc.created_at ASC`, [req.params.id]);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar comentários:', err.message);
        res.status(500).json({ message: 'Não foi possível carregar os comentários.' });
    }
});

app.put('/api/posts/:id/comments/:commentId', isAuthenticated, async (req, res) => {
    const comment = String(req.body.comment || '').trim();
    if (!comment) return res.status(400).json({ message: 'O comentário não pode ficar vazio.' });
    if (comment.length > 2000) return res.status(400).json({ message: 'O comentário deve ter no máximo 2.000 caracteres.' });

    try {
        const [result] = await db.execute(
            'UPDATE post_comments SET comment = ? WHERE id = ? AND post_id = ? AND user_id = ?',
            [comment, req.params.commentId, req.params.id, req.session.userId]
        );
        if (result.affectedRows === 0) {
            const [ownedRows] = await db.execute(
                'SELECT id FROM post_comments WHERE id = ? AND post_id = ? AND user_id = ?',
                [req.params.commentId, req.params.id, req.session.userId]
            );
            if (ownedRows.length === 0) return res.status(404).json({ message: 'Comentário não encontrado ou não pertence a você.' });
        }
        const [rows] = await db.execute(
            'SELECT id, post_id, user_id, comment, created_at FROM post_comments WHERE id = ?',
            [req.params.commentId]
        );
        res.json(rows[0]);
    } catch (err) {
        console.error('Erro ao editar comentário:', err.message);
        res.status(500).json({ message: 'Não foi possível editar o comentário.' });
    }
});

app.delete('/api/posts/:id/comments/:commentId', isAuthenticated, async (req, res) => {
    try {
        const [result] = await db.execute(
            'DELETE FROM post_comments WHERE id = ? AND post_id = ? AND user_id = ?',
            [req.params.commentId, req.params.id, req.session.userId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Comentário não encontrado ou não pertence a você.' });

        const [[countRow]] = await db.execute('SELECT COUNT(*) AS total FROM post_comments WHERE post_id = ?', [req.params.id]);
        res.json({ deleted: true, comment_count: Number(countRow.total) });
    } catch (err) {
        console.error('Erro ao excluir comentário:', err.message);
        res.status(500).json({ message: 'Não foi possível excluir o comentário.' });
    }
});

app.get('/api/posts/:id/acknowledgements', isAuthenticated, async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT u.id, u.name, u.username, pa.created_at
            FROM post_acknowledgements pa
            JOIN users u ON u.id = pa.user_id
            WHERE pa.post_id = ?
            ORDER BY pa.created_at DESC`, [req.params.id]);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao listar confirmações da publicação:', err.message);
        res.status(500).json({ message: 'Não foi possível carregar quem marcou como ciente.' });
    }
});

app.post('/api/posts/:id/comments', isAuthenticated, async (req, res) => {
    const comment = String(req.body.comment || '').trim();
    if (!comment) return res.status(400).json({ message: 'Escreva um comentário antes de enviar.' });
    if (comment.length > 2000) return res.status(400).json({ message: 'O comentário deve ter no máximo 2.000 caracteres.' });

    try {
        const [postRows] = await db.execute('SELECT id FROM posts WHERE id = ?', [req.params.id]);
        if (postRows.length === 0) return res.status(404).json({ message: 'Publicação não encontrada.' });

        const [result] = await db.execute(
            'INSERT INTO post_comments (post_id, user_id, comment) VALUES (?, ?, ?)',
            [req.params.id, req.session.userId, comment]
        );
        const [rows] = await db.execute(`
            SELECT pc.id, pc.post_id, pc.user_id, pc.comment, pc.created_at, u.username, u.name, u.avatar_url
            FROM post_comments pc
            JOIN users u ON u.id = pc.user_id
            WHERE pc.id = ?`, [result.insertId]);
        const [[countRow]] = await db.execute('SELECT COUNT(*) AS total FROM post_comments WHERE post_id = ?', [req.params.id]);
        res.status(201).json({ ...rows[0], comment_count: Number(countRow.total) });
    } catch (err) {
        console.error('Erro ao salvar comentário:', err.message);
        res.status(500).json({ message: 'Não foi possível salvar o comentário.' });
    }
});

app.post('/api/posts', isAuthenticated, (req, res, next) => {
    feedUpload.array('attachments', 5)(req, res, (err) => {
        if (err) {
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return res.status(status).json({ message: err.message || 'Não foi possível processar os anexos.' });
        }
        next();
    });
}, async (req, res) => {
    const { content, category } = req.body;
    const allowedCategories = new Set(['Pendências', 'Procedimentos', 'Alertas', 'Informativos', 'Outros']);
    const postCategory = allowedCategories.has(category) ? category : 'Outros';
    const cleanContent = DOMPurify.sanitize(content || '');
    const userId = req.session.userId;
    const attachments = req.files || [];
    const hasText = cleanContent && cleanContent !== '<p><br></p>';

    if (!hasText && attachments.length === 0) {
        attachments.forEach(file => fs.unlink(file.path, () => {}));
        return res.status(400).json({ message: 'Adicione um texto ou pelo menos um anexo para publicar.' });
    }

    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
    const attachmentMarkup = attachments.length
        ? `<div class="feed-post-attachments">${attachments.map(file => {
            const fileUrl = `/uploads/${encodeURIComponent(file.filename)}`;
            const icon = file.mimetype === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-image';
            return `<a class="feed-post-attachment" href="${fileUrl}" target="_blank" rel="noopener noreferrer"><i class="fa-solid ${icon}"></i><span>${escapeHtml(file.originalname)}</span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>`;
        }).join('')}</div>`
        : '';
    const postContent = `${hasText ? cleanContent : ''}${attachmentMarkup}`;

    const insertSql = 'INSERT INTO posts (title, content, user_id) VALUES (?, ?, ?)';
    
    let postInserted = false;
    try {
        const [result] = await db.execute(insertSql, [postCategory, postContent, userId]);
        postInserted = true;
        const newPostId = result.insertId;
        const selectSql = `
            SELECT posts.id, posts.title, posts.content, posts.created_at, users.username, users.name, users.avatar_url 
            FROM posts JOIN users ON posts.user_id = users.id
            WHERE posts.id = ?`;
        const [rows] = await db.execute(selectSql, [newPostId]);
        const newPost = rows[0];

        io.emit('new_post', newPost);
        
        res.status(201).json(newPost);

    } catch (err) {
        if (!postInserted) attachments.forEach(file => fs.unlink(file.path, () => {}));
        console.error('Erro ao salvar post:', err.message);
        res.status(500).json({ message: 'Erro ao salvar o post.' });
    }
});

app.delete('/api/posts/:id', isAuthenticated, async (req, res) => {
    const postId = req.params.id;
    const userId = req.session.userId;
    try {
        const deleteSql = 'DELETE FROM posts WHERE id = ? AND user_id = ?';
        const [result] = await db.execute(deleteSql, [postId, userId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Post não encontrado ou você não tem permissão para excluí-lo.' });
        }
        res.status(204).send();
    } catch (err) {
        console.error('Erro ao deletar post:', err.message);
        return res.status(500).json({ message: 'Erro ao deletar o post.' });
    }
});

app.put('/api/posts/:id', isAuthenticated, async (req, res) => {
    const postId = req.params.id;
    const userId = req.session.userId;
    const cleanContent = DOMPurify.sanitize(req.body.content);

    if (!cleanContent || cleanContent === '<p><br></p>') {
        return res.status(400).json({ message: 'O conteúdo do post não pode estar vazio.' });
    }

    try {
        const checkSql = 'SELECT user_id FROM posts WHERE id = ?';
        const [rows] = await db.execute(checkSql, [postId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Post não encontrado.' });
        }
        if (rows[0].user_id !== userId) {
            return res.status(403).json({ message: 'Você não tem permissão para editar este post.' });
        }

        const updateSql = 'UPDATE posts SET content = ? WHERE id = ?';
        await db.execute(updateSql, [cleanContent, postId]);
        
        const selectUpdatedSql = `
            SELECT posts.id, posts.content, posts.created_at, users.username 
            FROM posts JOIN users ON posts.user_id = users.id
            WHERE posts.id = ?`;
        const [updatedRows] = await db.execute(selectUpdatedSql, [postId]);
        
        res.json(updatedRows[0]);

    } catch (err) {
        console.error('Erro ao atualizar post:', err.message);
        res.status(500).json({ message: 'Erro interno ao atualizar o post.' });
    }
});

app.get('/api/bse/search', isAuthenticated, (req, res) => {
    const query = String(req.query.q || '').trim().toLocaleLowerCase('pt-BR');
    if (query.length < 2) return res.json([]);

    const basePath = path.resolve(__dirname, '..', 'base_conhecimento');
    const supportedExtensions = new Set(['.txt', '.md']);
    const results = [];
    let filesVisited = 0;
    const maximumFilesToInspect = 1500;

    const walk = (directory) => {
        if (results.length >= 20 || filesVisited >= maximumFilesToInspect) return;
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            return;
        }

        for (const entry of entries) {
            if (results.length >= 20 || filesVisited >= maximumFilesToInspect) break;
            const absolutePath = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                walk(absolutePath);
                continue;
            }
            if (!entry.isFile()) continue;

            filesVisited++;
            const relativePath = path.relative(basePath, absolutePath).split(path.sep).join('/');
            const fileName = entry.name;
            const nameMatches = fileName.toLocaleLowerCase('pt-BR').includes(query);
            const extension = path.extname(fileName).toLowerCase();
            let snippet = '';
            let contentMatches = false;

            if (supportedExtensions.has(extension)) {
                try {
                    const stats = fs.statSync(absolutePath);
                    if (stats.size <= 1024 * 1024) {
                        const content = fs.readFileSync(absolutePath, 'utf8');
                        const contentIndex = content.toLocaleLowerCase('pt-BR').indexOf(query);
                        if (contentIndex >= 0) {
                            contentMatches = true;
                            snippet = content.slice(Math.max(0, contentIndex - 70), Math.min(content.length, contentIndex + query.length + 130)).replace(/\s+/g, ' ').trim();
                        }
                    }
                } catch (error) {
                    // Ignora arquivos que não possam ser lidos.
                }
            }

            if (nameMatches || contentMatches) {
                results.push({
                    name: fileName,
                    path: `/${relativePath}`,
                    type: extension.slice(1),
                    snippet: snippet || 'Encontrado pelo nome do documento.'
                });
            }
        }
    };

    try {
        walk(basePath);
        res.setHeader('Cache-Control', 'no-store');
        res.json(results);
    } catch (err) {
        console.error('Erro na busca da base de conhecimento:', err.message);
        res.status(500).json({ message: 'Não foi possível pesquisar a base de conhecimento.' });
    }
});

app.get('/api/bse/items', isAuthenticated, (req, res) => {
    const basePath = path.join(__dirname, '..', 'base_conhecimento');
    const requestedPath = req.query.path ? path.join(basePath, req.query.path) : basePath;
    if (!requestedPath.startsWith(basePath)) {
        return res.status(403).json({ message: "Acesso negado." });
    }

    try {
        const items = fs.readdirSync(requestedPath, { withFileTypes: true });
        const responseData = { folders: [], documents: [] };

        for (const item of items) {
            const itemPath = path.join(requestedPath, item.name);
            const stats = fs.statSync(itemPath);

            if (item.isDirectory()) {
                responseData.folders.push({
                    name: item.name,
                    path: path.join(req.query.path || '/', item.name).replace(/\\/g, '/'),
                    created: stats.birthtime,
                    itemCount: fs.readdirSync(itemPath).length 
                });
            } else if (item.isFile()) {
                responseData.documents.push({
                    id: stats.ino, 
                    name: item.name,
                    type: path.extname(item.name).substring(1),
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime,
                    author: 'Equipe NOC',
                    path: path.join(req.query.path || '/', item.name).replace(/\\/g, '/')
                });
            }
        }
        res.json(responseData);
    } catch (err) {
        console.error("Erro ao listar itens da base de conhecimento:", err.message);
        res.status(500).json({ message: "Não foi possível carregar os itens." });
    }
});

app.get('/api/bse/content/*', isAuthenticated, (req, res) => {
    const basePath = path.join(__dirname, '..', 'base_conhecimento');
    const requestedFile = req.params[0]; 
    const filePath = path.join(basePath, requestedFile);
    if (!filePath.startsWith(basePath)) {
        return res.status(403).json({ message: "Acesso negado." });
    }

    if (fs.existsSync(filePath)) {
        const fileExtension = path.extname(filePath).toLowerCase();

        if (fileExtension === '.txt') {
            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) {
                    console.error("Erro ao ler arquivo .txt:", err);
                    return res.status(500).send('Erro ao ler o arquivo.');
                }
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.send(data);
            });
        } else {
            res.sendFile(filePath);
        }
    } else {
        res.status(404).send('Arquivo não encontrado.');
    }
});


app.get('/api/recados', isAuthenticated, async (req, res) => {
    const sql = `
        SELECT r.id, r.message, r.created_at, u.name as author_name, u.avatar_url
        FROM recados r
        JOIN users u ON r.user_id = u.id
        WHERE r.created_at >= NOW() - INTERVAL 24 HOUR
        ORDER BY r.created_at DESC;
    `;
    try {
        const [recados] = await db.execute(sql);
        res.json(recados);
    } catch (err) {
        console.error("Erro ao buscar recados:", err.message);
        res.status(500).json({ message: "Erro ao buscar recados." });
    }
});

app.post('/api/recados', isAuthenticated, async (req, res) => {
    const { message } = req.body;
    const userId = req.session.userId;

    if (!message || message.trim() === '') {
        return res.status(400).json({ message: 'A mensagem não pode estar vazia.' });
    }

    try {
        const insertSql = 'INSERT INTO recados (message, user_id) VALUES (?, ?)';
        const [result] = await db.execute(insertSql, [message.trim(), userId]);
        
        const selectSql = `
            SELECT r.id, r.message, r.created_at, u.name as author_name, u.avatar_url
            FROM recados r
            JOIN users u ON r.user_id = u.id
            WHERE r.id = ?;
        `;
        const [newRecadoRows] = await db.execute(selectSql, [result.insertId]);
        const newRecado = newRecadoRows[0];

        io.emit('new_recado', newRecado);
        
        res.status(201).json(newRecado);
    } catch (err) {
        console.error('Erro ao salvar recado:', err.message);
        res.status(500).json({ message: 'Erro ao salvar o recado.' });
    }
});

// --- ROTAS DE CONTATOS ---
app.get('/api/contatos', isAuthenticated, async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM contatos ORDER BY nome ASC');
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar contatos:", err.message);
        res.status(500).json({ message: "Erro ao buscar contatos." });
    }
});

app.post('/api/contatos', isAuthenticated, isAdmin, async (req, res) => {
    const { nome, setor, telefone, email } = req.body;
    try {
        const sql = 'INSERT INTO contatos (nome, setor, telefone, email) VALUES (?, ?, ?, ?)';
        const [result] = await db.execute(sql, [nome, setor, telefone, email]);
        res.status(201).json({ id: result.insertId, nome, setor, telefone, email, message: 'Contato adicionado!' });
    } catch (err) {
        console.error("Erro ao adicionar contato:", err.message);
        res.status(500).json({ message: "Erro ao adicionar o contato." });
    }
});

app.put('/api/contatos/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { id } = req.params;
    const { nome, setor, telefone, email } = req.body;
    try {
        const sql = 'UPDATE contatos SET nome=?, setor=?, telefone=?, email=? WHERE id=?';
        await db.execute(sql, [nome, setor, telefone, email, id]);
        res.json({ message: 'Contato atualizado com sucesso!' });
    } catch (err) {
        console.error("Erro ao atualizar contato:", err.message);
        res.status(500).json({ message: "Erro ao atualizar o contato." });
    }
});

app.delete('/api/contatos/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const sql = 'DELETE FROM contatos WHERE id=?';
        await db.execute(sql, [id]);
        res.json({ message: 'Contato excluído com sucesso!' });
    } catch (err) {
        console.error("Erro ao excluir contato:", err.message);
        res.status(500).json({ message: "Erro ao excluir o contato." });
    }
});

// --- NOVAS ROTAS PARA O PAINEL DE GESTÃO ---

app.post('/api/admin/users', isAuthenticated, isAdmin, async (req, res) => {
    // Agora desestruturamos também o 'permissions'
    const { name, username, email, password, cargo, jornada_trabalho, permissions } = req.body;

    if (!name || !username || !email || !password) {
        return res.status(400).json({ message: "Nome, Usuário, E-mail e Senha são obrigatórios." });
    }

    try {
        const [existing] = await db.execute('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
        if (existing.length > 0) {
            return res.status(400).json({ message: "Este Nome de Usuário ou E-mail já está cadastrado." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const permissoesArray = Array.isArray(permissions)
            ? permissions.filter(Boolean)
            : [];

        const permissoesJson = JSON.stringify(permissoesArray);

        const sql = 'INSERT INTO users (name, username, email, password_hash, role, cargo, jornada_trabalho, permissions) VALUES (?, ?, ?, ?, "user", ?, ?, ?)';
        
        await db.execute(sql, [name, username, email, hashedPassword, cargo || null, jornada_trabalho || null, permissoesJson]);

        res.status(201).json({ message: "Usuário cadastrado com sucesso!" });
    } catch (err) {
        console.error("Erro ao cadastrar usuário:", err);
        res.status(500).json({ message: "Erro interno ao cadastrar o usuário no banco de dados." });
    }
});

function isAdmin(req, res, next) {
    if (req.session && req.session.role === 'admin') {
        return next();
    }
    return res.status(403).json({ message: 'Acesso negado. Requer privilégios de administrador.' });
}

const epbxSchedulePath = path.join(__dirname, 'data', 'epbx_schedule.json');
const defaultEpbxSchedule = {
    settings: {
        rotationStartDate: '2026-08-11',
        weekdayStart: '18:01',
        weekdayEnd: '07:59',
        weekendStart: '08:00',
        weekendEnd: '07:59'
    },
    members: [
        { id: 'operador-1', name: 'Operador 1', phone: '(00) 00000-0000', email: 'operador1@example.com', order: 0, active: true },
        { id: 'operador-2', name: 'Operador 2', phone: '(00) 00000-0000', email: 'operador2@example.com', order: 1, active: true }
    ],
    overrides: [],
    absences: []
};

function readEpbxSchedule() {
    try {
        if (!fs.existsSync(epbxSchedulePath)) return JSON.parse(JSON.stringify(defaultEpbxSchedule));
        const saved = JSON.parse(fs.readFileSync(epbxSchedulePath, 'utf8'));
        const settings = { ...defaultEpbxSchedule.settings, ...(saved.settings || {}) };
        // Migra os horários-padrão anteriores para a regra nova solicitada.
        if (settings.weekdayStart === '18:00') settings.weekdayStart = '18:01';
        if (settings.weekdayEnd === '08:00') settings.weekdayEnd = '07:59';
        if (settings.weekendEnd === '08:00') settings.weekendEnd = '07:59';
        return {
            settings,
            members: Array.isArray(saved.members) ? saved.members : [...defaultEpbxSchedule.members],
            overrides: Array.isArray(saved.overrides) ? saved.overrides : [],
            absences: Array.isArray(saved.absences) ? saved.absences : [],
            holidays: Array.isArray(saved.holidays)
                ? saved.holidays.filter(item => !getAutomaticEpbxHolidays(Number(String(item.date || '').slice(0, 4))).some(holiday => holiday.date === item.date))
                : []
        };
    } catch (error) {
        console.error('Erro ao ler configuração EPBX:', error.message);
        return JSON.parse(JSON.stringify(defaultEpbxSchedule));
    }
}

function saveEpbxSchedule(config) {
    fs.mkdirSync(path.dirname(epbxSchedulePath), { recursive: true });
    const temporaryPath = `${epbxSchedulePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(temporaryPath, epbxSchedulePath);
}

function validEpbxDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validEpbxTime(value) {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function epbxDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function epbxDateFromKey(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12);
}

function epbxDayDistance(startKey, endKey) {
    return Math.round((Date.parse(`${endKey}T00:00:00Z`) - Date.parse(`${startKey}T00:00:00Z`)) / 86400000);
}

function epbxEasterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
}

function epbxShiftDate(date, offsetDays) {
    const shifted = new Date(date);
    shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function getAutomaticEpbxHolidays(year) {
    const fixed = [
        ['01-01', 'Confraternização Universal'], ['04-21', 'Tiradentes'],
        ['05-01', 'Dia do Trabalho'], ['09-07', 'Independência do Brasil'],
        ['10-12', 'Nossa Senhora Aparecida'], ['11-02', 'Finados'],
        ['11-15', 'Proclamação da República'], ['11-20', 'Dia da Consciência Negra'],
        ['12-25', 'Natal']
    ].map(([monthDay, name]) => ({ date: `${year}-${monthDay}`, name, kind: 'national' }));
    const easter = epbxEasterSunday(year);
    const movable = [
        { date: epbxShiftDate(easter, -48), name: 'Carnaval (segunda-feira)', kind: 'movable' },
        { date: epbxShiftDate(easter, -47), name: 'Carnaval (terça-feira)', kind: 'movable' },
        { date: epbxShiftDate(easter, -2), name: 'Paixão de Cristo', kind: 'movable' },
        { date: epbxShiftDate(easter, 60), name: 'Corpus Christi', kind: 'movable' }
    ];
    return [...fixed, ...movable].sort((a, b) => a.date.localeCompare(b.date));
}

function findEpbxHoliday(config, dateKey) {
    return getAutomaticEpbxHolidays(Number(dateKey.slice(0, 4))).find(item => item.date === dateKey)
        || (config.holidays || []).find(item => item.date === dateKey)
        || null;
}

function getEpbxAssignment(config, dateKey) {
    const activeMembers = config.members.filter(member => member.active !== false).sort((a, b) => a.order - b.order);
    const allMembers = [...config.members];
    if (!activeMembers.length && !allMembers.length) return null;

    const override = config.overrides.find(item => item.date === dateKey);
    let selectedMember = override ? allMembers.find(member => member.id === override.memberId) : null;
    const startKey = validEpbxDate(config.settings.rotationStartDate) ? config.settings.rotationStartDate : defaultEpbxSchedule.settings.rotationStartDate;
    const dayIndex = Math.max(0, epbxDayDistance(startKey, dateKey));
    const baseIndex = dayIndex % activeMembers.length;

    if (!selectedMember) {
        for (let offset = 0; offset < activeMembers.length; offset++) {
            const candidate = activeMembers[(baseIndex + offset) % activeMembers.length];
            const isAbsent = config.absences.some(absence => absence.memberId === candidate.id
                && absence.startDate <= dateKey && absence.endDate >= dateKey);
            if (!isAbsent) {
                selectedMember = candidate;
                break;
            }
        }
    }

    const date = epbxDateFromKey(dateKey);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const holidayInfo = findEpbxHoliday(config, dateKey);
    const holiday = Boolean(holidayInfo);
    const fullDay = weekend || holiday;
    const start = fullDay ? config.settings.weekendStart : config.settings.weekdayStart;
    const end = fullDay ? config.settings.weekendEnd : config.settings.weekdayEnd;
    return {
        date: dateKey,
        memberId: selectedMember?.id || null,
        name: selectedMember?.name || '',
        phone: selectedMember?.phone || '',
        email: selectedMember?.email || '',
        start,
        end,
        type: holiday && !weekend ? 'Feriado · Plantão 24h' : fullDay ? 'Plantão 24h' : 'Noturno',
        isOverride: Boolean(override),
        isHoliday: holiday,
        holidayName: holidayInfo?.name || ''
    };
}

app.get('/api/admin/schedules/epbx', isAuthenticated, isAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const config = readEpbxSchedule();
    const year = Number(req.query.year) || new Date().getFullYear();
    res.json({ ...config, calculatedHolidays: getAutomaticEpbxHolidays(year) });
});

app.put('/api/admin/schedules/epbx', isAuthenticated, isAdmin, (req, res) => {
    const config = req.body;
    if (!config || !config.settings || !Array.isArray(config.members)
        || !Array.isArray(config.overrides) || !Array.isArray(config.absences)
        || (config.holidays != null && !Array.isArray(config.holidays))) {
        return res.status(400).json({ message: 'Configuração EPBX inválida.' });
    }
    const settings = {
        rotationStartDate: String(config.settings.rotationStartDate || ''),
        weekdayStart: String(config.settings.weekdayStart || ''),
        weekdayEnd: String(config.settings.weekdayEnd || ''),
        weekendStart: String(config.settings.weekendStart || ''),
        weekendEnd: String(config.settings.weekendEnd || '')
    };
    if (!validEpbxDate(settings.rotationStartDate)
        || ![settings.weekdayStart, settings.weekdayEnd, settings.weekendStart, settings.weekendEnd].every(validEpbxTime)) {
        return res.status(400).json({ message: 'Informe uma data inicial e horários válidos para os turnos.' });
    }

    try {
        const memberIds = new Set();
        const members = config.members.map((member, index) => {
            const id = String(member.id || '').trim().slice(0, 80);
            const name = String(member.name || '').trim().slice(0, 120);
            const phone = String(member.phone || '').trim().slice(0, 40);
            const email = String(member.email || '').trim().slice(0, 160);
            if (!id || !name || memberIds.has(id)) throw new Error('Cada plantonista precisa de um ID único e nome.');
            memberIds.add(id);
            return { id, name, phone, email, order: Number.isInteger(member.order) ? member.order : index, active: member.active !== false };
        });
        if (!members.some(member => member.active)) throw new Error('É necessário manter pelo menos um plantonista ativo.');
        const overrides = config.overrides.map(item => {
            if (!validEpbxDate(item.date) || !memberIds.has(String(item.memberId))) throw new Error('Existe uma troca com data ou plantonista inválido.');
            return { date: item.date, memberId: String(item.memberId) };
        });
        const absences = config.absences.map(item => {
            const id = String(item.id || '').trim().slice(0, 80);
            const memberId = String(item.memberId || '');
            const startDate = String(item.startDate || '');
            const endDate = String(item.endDate || '');
            if (!id || !memberIds.has(memberId) || !validEpbxDate(startDate) || !validEpbxDate(endDate) || endDate < startDate) {
                throw new Error('Existe um período de ausência inválido.');
            }
            return { id, memberId, startDate, endDate, reason: String(item.reason || '').trim().slice(0, 160) };
        });
        const holidayDates = new Set();
        const holidays = (config.holidays || []).map(item => {
            const date = String(item.date || '');
            const name = String(item.name || 'Feriado').trim().slice(0, 120) || 'Feriado';
            if (!validEpbxDate(date)) throw new Error('Existe uma data de feriado inválida.');
            if (getAutomaticEpbxHolidays(Number(date.slice(0, 4))).some(holiday => holiday.date === date)) {
                throw new Error('Essa data já é calculada automaticamente como feriado nacional ou móvel.');
            }
            if (holidayDates.has(date)) throw new Error('Não é possível cadastrar o mesmo feriado duas vezes.');
            holidayDates.add(date);
            return { date, name };
        });
        const normalizedConfig = { settings, members, overrides, absences, holidays };
        saveEpbxSchedule(normalizedConfig);
        res.json({
            message: 'Configuração da escala EPBX salva.',
            config: { ...normalizedConfig, calculatedHolidays: getAutomaticEpbxHolidays(new Date().getFullYear()) }
        });
    } catch (error) {
            if (error.message.includes('inválido') || error.message.includes('único') || error.message.includes('plantonista') || error.message.includes('ativo') || error.message.includes('feriado')) {
            return res.status(400).json({ message: error.message });
        }
        console.error('Erro ao salvar escala EPBX:', error.message);
        res.status(500).json({ message: 'Não foi possível salvar a escala EPBX.' });
    }
});

app.get('/api/schedules/epbx', isAuthenticated, (req, res) => {
    const config = readEpbxSchedule();
    const now = new Date();
    const todayKey = epbxDateKey(now);
    const today = epbxDateFromKey(todayKey);
    const todayAssignment = getEpbxAssignment(config, todayKey);
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1, 12);
    const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 12);
    const schedule = [];
    const cursor = new Date(firstOfMonth);
    while (cursor <= lastOfMonth) {
        const key = epbxDateKey(cursor);
        schedule.push(getEpbxAssignment(config, key));
        cursor.setDate(cursor.getDate() + 1);
    }

    const candidates = [new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12), today];
    let currentShift = null;
    for (const date of candidates) {
        const assignment = getEpbxAssignment(config, epbxDateKey(date));
        if (!assignment?.name) continue;
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), ...assignment.start.split(':').map(Number));
        const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), ...assignment.end.split(':').map(Number));
        if (end <= start) end.setDate(end.getDate() + 1);
        end.setSeconds(59, 999);
        if (now >= start && now < end) {
            currentShift = assignment;
            break;
        }
    }
    const activeMembers = config.members.filter(member => member.active !== false).sort((a, b) => a.order - b.order);
    const todayMemberId = todayAssignment?.memberId || null;
    const publicRoster = activeMembers.map(member => ({
        id: member.id,
        name: member.name,
        phone: member.phone || '',
        email: member.email || '',
        isScheduledToday: member.id === todayMemberId,
        isAbsentToday: config.absences.some(absence => absence.memberId === member.id
            && absence.startDate <= todayKey && absence.endDate >= todayKey)
    }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ today: todayKey, currentShift, todayAssignment, isHolidayToday: Boolean(findEpbxHoliday(config, todayKey)), roster: publicRoster, schedule });
});

app.get('/api/schedules/sag', isAuthenticated, (req, res) => {
    const schedulePath = path.join(__dirname, 'data', 'sag_schedule.json');
    if (fs.existsSync(schedulePath)) {
        res.sendFile(schedulePath);
    } else {
        res.status(404).json([]);
    }
});

function normalizeSagHeader(header) {
    return String(header || '')
        .replace(/^\uFEFF/, '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\([^)]*\)/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeSagDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }

    if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
        const serial = Number(value);
        if (Number.isFinite(serial) && serial > 0) {
            const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
            if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
        }
    }

    const dateText = String(value || '').trim();
    const isoDate = dateText.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoDate) return `${isoDate[1]}-${isoDate[2].padStart(2, '0')}-${isoDate[3].padStart(2, '0')}`;

    const brazilianDate = dateText.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
    if (brazilianDate) return `${brazilianDate[3]}-${brazilianDate[2].padStart(2, '0')}-${brazilianDate[1].padStart(2, '0')}`;

    return null;
}

app.post('/api/admin/upload-sag-schedule', isAuthenticated, isAdmin, upload.single('scheduleFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
    }
    const filePath = req.file.path;
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const sagSheet = workbook.getWorksheet('SAG');
        if (!sagSheet) {
            throw new Error("Aba 'SAG' não foi encontrada na planilha. Verifique o nome da aba.");
        }
        const headerRow = sagSheet.getRow(1);
        const headers = [];
        headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
            headers[columnNumber - 1] = normalizeSagHeader(String(cell.value || '').trim());
        });
        if (sagSheet.rowCount < 2) {
            throw new Error("A planilha 'SAG' está vazia ou em um formato irreconhecível.");
        }
        const sagSchedule = [];
        sagSheet.eachRow((excelRow, rowNumber) => {
            if (rowNumber === 1) return;
            const row = Object.fromEntries(headers.map((header, index) => {
                if (!header) return ['', ''];
                const cellValue = sagSheet.getRow(rowNumber).getCell(index + 1).value;
                const value = cellValue && typeof cellValue === 'object'
                    ? (cellValue.text ?? cellValue.result ?? '')
                    : (cellValue ?? '');
                return [header, value];
            }).filter(([header]) => header));
            const dateValue = normalizeSagDate(row.data);
            const firstName = String(row.nome_turno_1 || '').trim();
            if (!dateValue || !firstName) return;
            const secondName = String(row.nome_turno_2 || '').trim();
            const shifts = [];
            shifts.push({
                name: firstName, phone: String(row.telefone_1 || '').trim(), class: String(row.classe_css_1 || 'default').trim(),
                start: '00:00', end: secondName ? '08:59' : '23:59'
            });
            if (secondName) {
                shifts.push({
                    name: secondName, phone: String(row.telefone_2 || '').trim(), class: String(row.classe_css_2 || 'default').trim(),
                    start: '09:00', end: '23:59'
                });
            }
            sagSchedule.push({ date: dateValue, shifts: shifts, isShiftChange: Boolean(secondName) });
        });

        if (sagSchedule.length === 0) {
            throw new Error("Nenhuma linha válida foi encontrada na planilha. Verifique se os cabeçalhos ('data', 'nome_turno_1', etc.) estão corretos.");
        }
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
        fs.writeFileSync(path.join(dataDir, 'sag_schedule.json'), JSON.stringify(sagSchedule, null, 2));
        fs.unlinkSync(filePath);
        res.json({ message: 'Escala SAG atualizada com sucesso!' });
    } catch (error) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        console.error("ERRO NO PROCESSAMENTO DA ESCALA:", error.message);
        res.status(500).json({ message: error.message || 'Erro interno ao processar a planilha.' });
    }
});

// --- ROTAS DA ESCALA TÉCNICA ---

app.get('/api/schedules/agera', isAuthenticated, async (req, res) => {
    try {
        // Lógica SQL: 
        // Se hoje for dia 10 ou menos, busca do dia 11 do mês passado até dia 10 deste mês.
        // Se hoje for dia 11 ou mais, busca do dia 11 deste mês até dia 10 do mês que vem.
        const sql = `
            SELECT DATE_FORMAT(date, '%Y-%m-%d') as date, name, phone, start_time as start, end_time as end, type 
            FROM agera_schedule 
            WHERE date >= DATE_FORMAT(IF(DAY(CURRENT_DATE()) <= 10, CURRENT_DATE() - INTERVAL 1 MONTH, CURRENT_DATE()), '%Y-%m-11')
              AND date <= DATE_FORMAT(IF(DAY(CURRENT_DATE()) <= 10, CURRENT_DATE(), CURRENT_DATE() + INTERVAL 1 MONTH), '%Y-%m-10')
            ORDER BY date ASC
        `;
        const [rows] = await db.execute(sql);
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar escala técnica:", err);
        res.status(500).json({ message: "Erro ao buscar escala técnica." });
    }
});

app.post('/api/admin/schedules/agera/generate', isAuthenticated, isAdmin, async (req, res) => {
    const { schedule } = req.body;
    if (!schedule || !Array.isArray(schedule)) {
        return res.status(400).json({ message: "Dados do ciclo inválidos." });
    }
    
    try {
        // Para cada dia gerado pelo Frontend, inserimos no banco. 
        // Se a data já existir (ON DUPLICATE KEY UPDATE), ele apenas atualiza os dados.
        for (const day of schedule) {
            const sql = `
                INSERT INTO agera_schedule (date, name, phone, start_time, end_time, type) 
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE name=?, phone=?, start_time=?, end_time=?, type=?
            `;
            await db.execute(sql, [
                day.date, day.name, day.phone, day.start, day.end, day.type,
                day.name, day.phone, day.start, day.end, day.type
            ]);
        }
        res.json({ message: "Ciclo gerado e salvo com sucesso no banco de dados!" });
    } catch (err) {
        console.error("Erro ao salvar ciclo técnico:", err);
        res.status(500).json({ message: "Erro interno ao salvar o ciclo técnico no banco." });
    }
});

app.put('/api/admin/schedules/agera/override', isAuthenticated, isAdmin, async (req, res) => {
    const { date, name, phone } = req.body;
    try {
        const sql = 'UPDATE agera_schedule SET name = ?, phone = ? WHERE date = ?';
        const [result] = await db.execute(sql, [name, phone, date]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Data não encontrada no ciclo atual. Gere o ciclo primeiro.' });
        }
        res.json({ message: `Plantonista do dia ${date} atualizado para ${name} com sucesso!` });
    } catch (err) {
        console.error("Erro ao sobrescrever plantonista:", err);
        res.status(500).json({ message: "Erro ao atualizar o plantonista pontual." });
    }
});                                                                                  

app.delete('/api/recados/:id', isAuthenticated, isAdmin, async (req, res) => {
    const recadoId = req.params.id;
    const userId = req.session.userId;

    try {
        const deleteSql = 'DELETE FROM recados WHERE id = ?';
        const [result] = await db.execute(deleteSql, [recadoId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Recado não encontrado.' });
        }

        io.emit('recado_deleted', { id: recadoId });
        
        console.log(`Usuário admin (ID: ${userId}) deletou o recado (ID: ${recadoId})`);
        res.status(200).json({ message: 'Recado excluído com sucesso.' });

    } catch (err) {
        console.error('Erro ao deletar recado:', err.message);
        res.status(500).json({ message: 'Erro interno ao deletar o recado.' });
    }
});

app.get('/', (req, res) => {
    if (req.session && req.session.userId) {
        res.sendFile(path.join(__dirname, '..', 'portal.html'));
    } else {
        res.redirect('/login.html');
    }
});

io.on('connection', (socket) => {
  const session = socket.request.session;
  const userName = (session && session.name) ? session.name : 'Um usuário desconhecido';

  console.log(`✅ ${userName} logou no portal`);

  socket.on('disconnect', () => {
    console.log(`❌ ${userName} deslogou do portal`);
  });
});


server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});