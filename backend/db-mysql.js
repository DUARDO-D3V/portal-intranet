const mysql = require('mysql2');

const databaseUrl = process.env.DATABASE_URL || '';
const databaseUrlParts = databaseUrl.match(/^mysql(?:\+[^:]+)?:\/\/([^:]+):(.+)@([^/]+)\/([^?]+)(?:\?.*)?$/);
const dbConfig = {
  host: process.env.DB_HOST || databaseUrlParts?.[3],
  user: process.env.DB_USER || (databaseUrlParts && decodeURIComponent(databaseUrlParts[1])),
  password: process.env.DB_PASSWORD || (databaseUrlParts && decodeURIComponent(databaseUrlParts[2])),
  database: process.env.DB_NAME || (databaseUrlParts && decodeURIComponent(databaseUrlParts[4]))
};
const missingConfig = Object.entries(dbConfig)
  .filter(([, value]) => !value)
  .map(([key]) => `DB_${key.toUpperCase()}`);

if (missingConfig.length > 0) {
  throw new Error(`Defina ${missingConfig.join(', ')} ou uma DATABASE_URL MySQL válida no arquivo .env.`);
}

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

console.log('Pool de conexões com o MySQL criado com sucesso.');

module.exports = pool.promise();