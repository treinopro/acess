// REMOVIDO — a integração com a InfinitePay foi desativada (decisão de
// 2026-07-07, ver análise de segurança: o webhook dela confiava cegamente no
// corpo da requisição para marcar cobranças como pagas, sem nenhuma
// verificação, permitindo fraude). Nada no projeto importa mais este arquivo
// (grep por "infinitepay" não retorna nenhum require deste módulo) — ele foi
// deixado aqui só porque este ambiente não tem uma ferramenta de exclusão de
// arquivo disponível. É seguro apagar este arquivo manualmente.
//
// Se a InfinitePay for reativada no futuro, implemente a verificação do
// webhook usando POST /payment_check (função verificarPagamento, que existia
// aqui) antes de marcar qualquer cobrança como paga — nunca confie em
// order_nsu/paid_amount vindos direto do corpo da requisição.
module.exports = {};
