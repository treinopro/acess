/**
 * Mapa "id da tag NFC" -> nome do aparelho, usado pela feature "Chamar
 * instrutor" (ver src/routes/chamar.routes.js). Cada tag NFC colada num
 * aparelho é gravada com uma URL do tipo:
 *
 *   https://<seu-dominio>/chamar/leg-press-45-1
 *
 * O trecho final da URL ("leg-press-45-1") é a CHAVE deste objeto — pode ser
 * qualquer texto (sem espaço, sem barra), só precisa bater exatamente com o
 * que foi gravado na tag. O VALOR é o nome que aparece no aviso mandado pro
 * instrutor.
 *
 * Lista real da Academia Superação (2026-08-15). "Catraca" e "Recepção" não
 * são aparelhos de treino — são pontos de chamada extra (ex.: uma tag perto
 * da catraca ou do balcão, pra emergência/dúvida geral).
 *
 * Nota: "Cadeira Abdutora/Adutora" (linha combinada) e as duas entradas
 * separadas "Cadeira Adutora"/"Cadeira Abdutora" foram mantidas como veio na
 * lista passada — se for o mesmo aparelho duplicado (2x na lista por
 * engano), é só apagar a linha 'cadeira-abdutora-adutora' abaixo.
 */
module.exports = {
  'elevacao-pelvica': 'Elevação Pélvica',
  squat: 'Squat',
  'leg-press-45-1': 'Leg Press 45º 1',
  'leg-press-45-2': 'Leg Press 45º 2',
  'hack-1': 'Hack 1',
  'hack-2': 'Hack 2',
  'mesa-flexora': 'Mesa Flexora',
  smith: 'Smith',
  bulgaro: 'Búlgaro',
  graviton: 'Graviton',
  'cadeira-abdutora-adutora': 'Cadeira Abdutora/Adutora',
  'flexor-em-pe': 'Flexor em Pé',
  'panturrilha-sentado': 'Panturrilha Sentado',
  'cadeira-extensora-1': 'Cadeira Extensora 1',
  'cadeira-extensora-2': 'Cadeira Extensora 2',
  'cadeira-extensora-3': 'Cadeira Extensora 3',
  'gluteo-em-pe': 'Glúteo em Pé',
  'leg-press-180': 'Leg Press 180º',
  pendulo: 'Pêndulo',
  'cadeira-adutora': 'Cadeira Adutora',
  'cadeira-abdutora': 'Cadeira Abdutora',
  'agachamento-livre-1': 'Agachamento Livre 1',
  'agachamento-livre-2': 'Agachamento Livre 2',
  'puxada-alta': 'Puxada Alta',
  'remada-baixa': 'Remada Baixa',
  'supino-declinado': 'Supino Declinado',
  'supino-reto-1': 'Supino Reto 1',
  'supino-reto-2': 'Supino Reto 2',
  'supino-inclinado-1': 'Supino Inclinado 1',
  'supino-inclinado-2': 'Supino Inclinado 2',
  'cross-over-1': 'Cross Over 1',
  'cross-over-2': 'Cross Over 2',
  'peck-deck-voador': 'Peck Deck / Voador',
  'banco-scott-1': 'Banco Scott 1',
  'banco-scott-2': 'Banco Scott 2',
  'esteira-1': 'Esteira 1',
  'esteira-2': 'Esteira 2',
  'esteira-3': 'Esteira 3',
  catraca: 'Catraca',
  recepcao: 'Recepção',
};
