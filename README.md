# Portal Intranet

Um portal para operação, monitoramento e compartilhamento interno de conhecimento.

Ele foi pensado para equipes de NOC, suporte e operações: login, dashboard, contatos, recados, feed, base de conhecimento, notas pessoais, escalas e integração com Zabbix.

> Projeto: dados reais, credenciais, contatos e infraestrutura interna foram removidos. Cada instalação precisa usar seu próprio banco e configurações.

## O que tem aqui

- Login e controle de usuários
- Perfis, permissões e painel administrativo
- Feed de avisos e informativos
- Contatos e recados
- Base de conhecimento
- Notas pessoais
- Escalas de plantão
- Dashboard Zabbix
- Upload de avatar e anexos
- Interface responsiva com tema claro e escuro

## Requisitos

- Node.js 20 ou superior
- npm
- MySQL 8 ou compatível
- Zabbix opcional

## Instalação rápida

```bash
git clone https://github.com/DUARDO-D3V/portal-intranet.git
cd portal-intranet
npm install
```

Crie o arquivo `.env` a partir do exemplo:

```bash
Copy-Item .env.example .env
```

No Linux ou macOS:

```bash
cp .env.example .env
```

Preencha o `.env`. Use somente valores locais neste arquivo e nunca envie-o ao GitHub.

```env
DB_HOST=localhost
DB_USER=portal_noc
DB_PASSWORD=sua_senha_segura
DB_NAME=portal_noc

DATABASE_URL=mysql+aiomysql://portal_noc:sua_senha_segura@localhost/portal_noc

SESSION_SECRET=gere_um_valor_longo_e_aleatorio
SECRET_KEY=gere_um_valor_longo_e_aleatorio

CORS_ORIGINS=http://localhost:3000
ZABBIX_URL=https://zabbix.exemplo.com/api_jsonrpc.php
ZABBIX_ROBOT_USER=
ZABBIX_ROBOT_PASS=
```

> `DB_PASSWORD` e `DB_USER` são diferentes de `ZABBIX_ROBOT_USER` e `ZABBIX_ROBOT_PASS`.

## Preparar o banco MySQL

Crie o banco e o usuário no MySQL:

```sql
CREATE DATABASE portal_noc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'portal_noc'@'localhost' IDENTIFIED BY 'sua_senha_segura';
GRANT ALL PRIVILEGES ON portal_noc.* TO 'portal_noc'@'localhost';
FLUSH PRIVILEGES;
USE portal_noc;
```

Depois crie as tabelas principais usadas pela aplicação:

```sql
CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  username VARCHAR(120) NOT NULL UNIQUE,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(255) NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'user',
  cargo VARCHAR(120) NULL,
  jornada_trabalho VARCHAR(120) NULL,
  telefone VARCHAR(40) NULL,
  permissions JSON NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE posts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  content LONGTEXT NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE post_comments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  comment TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE post_acknowledgements (
  post_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE home_pinned_posts (
  post_id BIGINT UNSIGNED PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE recados (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message TEXT NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE contatos (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  setor VARCHAR(120) NOT NULL,
  telefone VARCHAR(40) NOT NULL,
  email VARCHAR(160) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE agera_schedule (
  date DATE NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40) NULL,
  start_time VARCHAR(5) NULL,
  end_time VARCHAR(5) NULL,
  type VARCHAR(20) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

O servidor cria automaticamente algumas tabelas auxiliares, como notas pessoais e publicações salvas, desde que o usuário do banco tenha permissão `CREATE TABLE`.

Crie o primeiro usuário administrativo pela própria interface ou usando o painel administrativo depois do primeiro login.

## Executar

```bash
npm start
```

Acesse:

- Aplicação: http://localhost:3000
- Login: http://localhost:3000/login.html

Para parar o servidor, use `Ctrl+C`.

## Zabbix

O Zabbix é opcional. Para ativar a integração:

1. Preencha `ZABBIX_URL` no `.env`.
2. Informe `ZABBIX_ROBOT_USER` e `ZABBIX_ROBOT_PASS`.
3. Use uma conta de integração dedicada, sem privilégios administrativos.
4. Reinicie o servidor.

Teste a conexão:

```bash
node teste-zabbix.js
```

## Upload de arquivos

- Avatares: imagens JPG, PNG, GIF ou WEBP, com limite de 2 MB
- Feed: imagens e PDF, com limite de 10 MB por arquivo
- Arquivos enviados ficam em `uploads/`
- Use armazenamento persistente em produção

Não faça upload de dados confidenciais em ambientes públicos.

## Segurança

- Nunca envie `.env`, bancos SQLite, certificados ou chaves privadas
- Gere um `SESSION_SECRET` e `SECRET_KEY` próprios
- Use HTTPS em produção
- Troque todas as senhas anteriores que já tenham sido expostas
- Não use a conta administrativa do Zabbix para a integração
- Faça revisões periódicas com `npm audit`
- Execute `npm audit` antes de atualizar ou publicar novas versões

```bash
npm audit
```

## Documentos legais e acessibilidade

O projeto inclui páginas públicas com textos básicos para adaptação pela organização:

- [Política de Privacidade](./politica-privacidade.html)
- [Termos de Uso](./termos-de-uso.html)
- [Acessibilidade](./acessibilidade.html)

As páginas de política e termos devem ser revisadas pelo responsável jurídico da organização antes de uso em produção.

## Estrutura

```text
backend/                 API Node.js e integração com banco
assets/css/              Estilos da interface
assets/js/               JavaScript do navegador
assets/libs/             Bibliotecas locais
components/              Componentes HTML carregados pela aplicação
uploads/                 Arquivos enviados em execução local
.env.example             Modelo seguro das variáveis
portal.html              Página principal
login.html               Tela de login
```

## Variáveis de ambiente

| Variável | Obrigatória | Uso |
|---|---:|---|
| `DB_HOST` | Sim | Servidor MySQL |
| `DB_USER` | Sim | Usuário do banco |
| `DB_PASSWORD` | Sim | Senha do banco |
| `DB_NAME` | Sim | Nome do banco |
| `DATABASE_URL` | Alternativa | URL MySQL completa |
| `SESSION_SECRET` | Sim | Assinatura da sessão |
| `SECRET_KEY` | Sim | Assinatura dos tokens |
| `CORS_ORIGINS` | Não | Origens permitidas separadas por vírgula |
| `ZABBIX_URL` | Não | Endpoint JSON-RPC do Zabbix |
| `ZABBIX_ROBOT_USER` | Não | Conta da integração Zabbix |
| `ZABBIX_ROBOT_PASS` | Não | Senha da integração Zabbix |

## Desenvolvimento

Antes de enviar alterações:

```bash
npm audit
node --check backend/server.js
node --check backend/db-mysql.js
node --check assets/js/script.js
```

Sugestões de contribuição:

- Abra uma issue antes de mudanças grandes
- Preserve o visual e os padrões já existentes
- Não inclua dados reais em fixtures ou exemplos
- Não faça commit de arquivos locais ou credenciais

## Licença

Defina a licença escolhida antes do uso comercial ou distribuição ampla. Um arquivo `LICENSE` ainda não foi incluído neste repositório.
