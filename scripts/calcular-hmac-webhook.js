// Calcula localmente o HMAC-SHA256 que o servidor calcularia para uma notificação do Mercado Pago, para comparar com o v1
// do header x-signature (pedido do suporte, ticket WCS-58416). NÃO imprime nem grava o segredo.
//
// Uso (PowerShell):
//   $env:MERCADOPAGO_WEBHOOK_SECRET = "<assinatura secreta de PRODUÇÃO da aplicação>"
//   node scripts/calcular-hmac-webhook.js --data-id 187951020143 --request-id e0083d28-f2af-4fe5-92bf-f84dc690bf16 --ts <ts do x-signature>
// Opcional: --v1 <v1 recebido> para dizer se bate.
const crypto = require('crypto');

function arg(nome) {
  const i = process.argv.indexOf('--' + nome);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// Aceita VÁRIOS segredos em MERCADOPAGO_WEBHOOK_SECRET (separados por vírgula, ponto e vírgula ou quebra de linha), um por
// aplicação. Para cada um testa as variações do manifesto e diz qual bate com o v1 (sem mostrar o segredo).
const segredos = String(process.env.MERCADOPAGO_WEBHOOK_SECRET || '')
  .split(/[\s,;]+/).map((x) => x.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
const dataId = arg('data-id');
const requestId = arg('request-id');
const ts = arg('ts');
const v1 = (arg('v1') || '').trim().toLowerCase();

if (!segredos.length || !dataId || !ts) {
  console.error('Faltam dados. Defina MERCADOPAGO_WEBHOOK_SECRET e passe --data-id, --ts (e --request-id).');
  process.exit(1);
}

const idMin = /^[a-zA-Z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId;
const variantes = [
  ['padrão (id minúsculo + request-id + ts)', `id:${idMin};request-id:${requestId};ts:${ts};`],
  ['sem request-id', `id:${idMin};ts:${ts};`],
  ['id como recebido', `id:${dataId};request-id:${requestId};ts:${ts};`],
  ['ts em segundos→milissegundos', `id:${idMin};request-id:${requestId};ts:${ts}000;`],
].filter(([, m]) => !m.includes('request-id:undefined'));

console.log('manifest padrão:', JSON.stringify(variantes[0][1]));
let achou = false;
segredos.forEach((segredo, n) => {
  const marca = `segredo #${n + 1} (${segredo.length} caracteres, sha256=${crypto.createHash('sha256').update(segredo).digest('hex').slice(0, 12)})`;
  variantes.forEach(([nome, manifest]) => {
    const hmac = crypto.createHmac('sha256', segredo).update(manifest, 'utf8').digest('hex');
    const bate = v1 ? hmac === v1 : null;
    if (bate) achou = true;
    console.log(`${marca} | ${nome}: hmac=${hmac}${bate === null ? '' : bate ? '  <== BATE' : ''}`);
  });
});
if (v1) console.log(achou ? '\nResultado: um dos segredos bate.' : '\nResultado: nenhum segredo/variação bate com o v1.');
