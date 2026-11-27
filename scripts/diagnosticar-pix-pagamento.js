// Diagnóstico (SÓ LEITURA) de um pagamento Pix que aparece "Aprovado" no Mercado Pago mas não consta no sistema.
//
// Use os trechos que o app do Mercado Pago mostra na tela do pagamento (pode ser parte do código):
//   - "Referência adicional" (ex.: cda5a469-b5b ... c1f8e14808ae)
//   - "N.º da transação" (ex.: ORD01M8D0Z28 ... FPV1SEW5F9NR)
//
// Como rodar (na pasta academia-gestao do PC que usa o banco de PRODUÇÃO no .env):
//   node scripts/diagnosticar-pix-pagamento.js cda5a469-b5b c1f8e14808ae ORD01M8D0Z28 FPV1SEW5F9NR
//
// Não altera nada: só faz SELECT no banco e consulta o status do pedido no Mercado Pago.
// Não imprime CPF nem chaves.

const db = require('../src/db/client');

const trechos = process.argv.slice(2).map((t) => t.trim()).filter(Boolean);
if (!trechos.length) {
  console.error('Uso: node scripts/diagnosticar-pix-pagamento.js <trecho-da-referencia> [outros trechos...]');
  process.exit(1);
}

async function main() {
  const banco = process.env.DATABASE_URL || 'file:./local.db';
  console.log('Banco consultado:', /^libsql:|^https?:/.test(banco) ? 'remoto (Turso)' : `ARQUIVO LOCAL (${banco}) — se era pra ser produção, o .env deste PC não está apontando pro Turso`);
  console.log('Token do Mercado Pago configurado neste PC:', process.env.MERCADOPAGO_ACCESS_TOKEN ? `sim (termina em ...${process.env.MERCADOPAGO_ACCESS_TOKEN.slice(-4)})` : 'NÃO');
  console.log('');

  const achados = new Map();
  for (const t of trechos) {
    const pt = await db.execute({
      sql: `SELECT pt.*, a.nome AS aluno_nome, a.email AS aluno_email FROM pagamentos_totem pt LEFT JOIN alunos a ON a.id = pt.aluno_id
            WHERE pt.id LIKE ? OR pt.provedor_referencia LIKE ?`,
      args: [`%${t}%`, `%${t}%`],
    });
    pt.rows.forEach((r) => achados.set(`pt:${r.id}`, { tipo: 'pagamentos_totem (pagar contas em aberto)', r }));
    const cb = await db.execute({
      sql: `SELECT c.*, a.nome AS aluno_nome, a.email AS aluno_email FROM cobrancas c LEFT JOIN alunos a ON a.id = c.aluno_id
            WHERE c.id LIKE ? OR c.provedor_referencia LIKE ?`,
      args: [`%${t}%`, `%${t}%`],
    });
    cb.rows.forEach((r) => achados.set(`cb:${r.id}`, { tipo: 'cobrancas (matrícula/cadastro/upgrade)', r }));
  }

  if (!achados.size) {
    console.log('NADA encontrado no banco com esses trechos.');
    console.log('=> O pedido Pix provavelmente foi criado em OUTRO banco (ex.: servidor/PC apontando pra um banco diferente) ou o registro nunca chegou a ser gravado.');
    return;
  }

  for (const { tipo, r } of achados.values()) {
    console.log('— Encontrado em:', tipo);
    console.log('  id:', r.id);
    console.log('  aluno:', r.aluno_nome || '(não encontrado)');
    console.log('  e-mail cadastrado no sistema:', r.aluno_email ? 'sim' : 'NÃO (o Pix foi criado com e-mail genérico "aluno-<cpf>@academia-gestao.com", por isso o Mercado Pago não mostra o pagador)');
    console.log('  status:', r.status, '| valor (centavos):', r.valor_centavos);
    console.log('  criado em:', r.criado_em);
    console.log('  referência do pedido no Mercado Pago:', r.provedor_referencia);
    if (r.cobranca_ids) {
      const ids = JSON.parse(r.cobranca_ids);
      for (const id of ids) {
        const c = (await db.execute({ sql: 'SELECT id, descricao, status, vencimento, pago_em FROM cobrancas WHERE id = ?', args: [id] })).rows[0];
        const pg = (await db.execute({ sql: 'SELECT data, valor_centavos, tipo FROM pagamentos_cobranca WHERE cobranca_id = ?', args: [id] })).rows;
        console.log(`  conta ${id.slice(0, 8)}…: ${c ? `${c.descricao} | status ${c.status} | venc ${c.vencimento} | pago_em ${c.pago_em}` : 'NÃO EXISTE'} | pagamentos lançados: ${pg.length}`);
      }
    } else {
      const pg = (await db.execute({ sql: 'SELECT data, valor_centavos, tipo FROM pagamentos_cobranca WHERE cobranca_id = ?', args: [r.id] })).rows;
      console.log('  pagamentos lançados nessa conta:', pg.length);
    }
    if (r.provedor_referencia) {
      try {
        const mp = require('../src/services/payment/mercadopago.service');
        const o = await mp.consultarOrder(r.provedor_referencia);
        const p = o.transactions?.payments?.[0] || {};
        console.log('  Mercado Pago (consulta agora): order.status =', o.status, '| pagamento.status =', p.status, '| detalhe =', p.status_detail || o.status_detail);
      } catch (e) {
        console.log('  Mercado Pago: NÃO consegui consultar o pedido com o token deste PC →', e.message);
        console.log('  (se o pedido foi criado por outro token/aplicativo, a consulta falha — e a reconciliação automática também)');
      }
    }
    console.log('');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('Erro:', e.message); process.exit(1); });
