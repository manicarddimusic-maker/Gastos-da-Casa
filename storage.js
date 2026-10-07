'use strict';
// Guarda o estado inteiro (salário + linhas) em um único documento.
// Com DATABASE_URL (Postgres do Railway) os dados ficam no banco.
// Sem DATABASE_URL, ficam em um arquivo JSON em DATA_DIR (use um Volume do Railway).

const fs = require('fs');
const path = require('path');

function estadoVazio() {
  return { rev: 0, renda: 0, linhas: {} };
}

function normaliza(e) {
  if (!e || typeof e !== 'object') return estadoVazio();
  return {
    rev: Number.isInteger(e.rev) ? e.rev : 0,
    renda: Number.isInteger(e.renda) ? e.renda : 0,
    linhas: e.linhas && typeof e.linhas === 'object' ? e.linhas : {}
  };
}

async function criarArmazenamento() {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { Pool } = require('pg');
    const usaSsl = !/railway\.internal|localhost|127\.0\.0\.1/.test(url) && process.env.PGSSL !== 'disable';
    const pool = new Pool({
      connectionString: url,
      ssl: usaSsl ? { rejectUnauthorized: false } : false,
      max: 3
    });
    await pool.query(
      'CREATE TABLE IF NOT EXISTS estado (id INT PRIMARY KEY, dados JSONB NOT NULL, atualizado TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    return {
      tipo: 'postgres',
      async carregar() {
        const r = await pool.query('SELECT dados FROM estado WHERE id = 1');
        return r.rows.length ? normaliza(r.rows[0].dados) : estadoVazio();
      },
      async salvar(estado) {
        await pool.query(
          'INSERT INTO estado (id, dados, atualizado) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados, atualizado = now()',
          [JSON.stringify(estado)]
        );
      }
    };
  }

  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const arquivo = path.join(dir, 'estado.json');
  fs.mkdirSync(dir, { recursive: true });
  return {
    tipo: 'arquivo (' + arquivo + ')',
    async carregar() {
      try {
        return normaliza(JSON.parse(fs.readFileSync(arquivo, 'utf8')));
      } catch (e) {
        if (e.code === 'ENOENT') return estadoVazio();
        throw e;
      }
    },
    async salvar(estado) {
      const tmp = arquivo + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(estado));
      fs.renameSync(tmp, arquivo);
    }
  };
}

module.exports = { criarArmazenamento };
