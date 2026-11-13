const test = require('node:test');
const assert = require('node:assert');
const B = require('../public/busca-fonetica.js');

const nomes = ['Tríceps corda na polia', 'Tríceps testa com barra', 'Rosca direta com barra', 'Rosca martelo', 'Leg press 45°', 'Leg press horizontal',
  'Agachamento no smith', 'Crossover na polia', 'Peck deck (voador)', 'Stiff com barra', 'Levantamento terra', 'Coice na polia (kickback)',
  'Agachamento no hack', 'Puxada frente na polia', 'Bíceps', 'Supino reto com barra'].map((nome) => ({ nome }));
const buscar = (q) => B.filtrar(nomes, q, (i) => i.nome).map((i) => i.nome);

test('busca tolerante: pronúncia e escrita variadas acham o exercício certo', () => {
  for (const q of ['tríceps', 'triceps', 'tri ceps', 'trai ceps', 'tricepis']) assert.ok(buscar(q).includes('Tríceps corda na polia'), q);
  assert.deepStrictEqual(buscar('bicepis'), ['Bíceps']);
  for (const q of ['leg press', 'lec pres', 'legue presse']) assert.ok(buscar(q).includes('Leg press 45°'), q);
  assert.deepStrictEqual(buscar('smith machine'), ['Agachamento no smith']);
  assert.deepStrictEqual(buscar('esmite'), ['Agachamento no smith']);
  assert.deepStrictEqual(buscar('pecdeque'), ['Peck deck (voador)']);
  assert.deepStrictEqual(buscar('estife'), ['Stiff com barra']);
  assert.deepStrictEqual(buscar('deadlift'), ['Levantamento terra']);
  assert.deepStrictEqual(buscar('rack'), ['Agachamento no hack']);
});

test('busca tolerante: não inventa resultado e vazio devolve tudo', () => {
  assert.deepStrictEqual(buscar('xyzabc'), []);
  assert.strictEqual(buscar('').length, nomes.length);
  assert.deepStrictEqual(buscar('rosca'), ['Rosca direta com barra', 'Rosca martelo']);
  // "hack" não pode achar "Agachamento" por pedaço de palavra
  assert.deepStrictEqual(buscar('hack'), ['Agachamento no hack']);
});
