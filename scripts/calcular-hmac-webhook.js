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

const segredo = String(process.env.MERCADOPAGO_WEBHOOK_SECRET || '').trim().replace(/^["']|["']$/g, '').trim();
const dataId = arg('data-id');
const requestId = arg('request-id');
const ts = arg('ts');
const v1 = arg('v1');

if (!segredo || !dataId || !ts) {
  console.error('Faltam dados. Defina MERCADOPAGO_WEBHOOK_SECRET e passe --data-id, --ts (e --request-id).');
  process.exit(1);
}

// Mesma montagem do servidor: id em minúsculas quando alfanumérico; request-id só entra se informado.
const idParaManifest = /^[a-zA-Z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId;
const manifest = `id:${idParaManifest};` + (requestId ? `request-id:${requestId};` : '') + `ts:${ts};`;
const hmac = crypto.createHmac('sha256', segredo).update(manifest).digest('hex');

console.log('manifest      :', JSON.stringify(manifest));
console.log('manifest bytes:', Buffer.byteLength(manifest, 'utf8'));
console.log('hmac_sha256   :', hmac);
console.log('segredo       :', `${segredo.length} caracteres, sha256 (12 primeiros)=${crypto.createHash('sha256').update(segredo).digest('hex').slice(0, 12)}`);
if (v1) console.log('bate com o v1 :', hmac === v1.trim().toLowerCase() ? 'SIM' : 'NÃO');
