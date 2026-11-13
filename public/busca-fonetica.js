// Busca tolerante a pronúncia e escrita: "tríceps", "tri ceps", "trai ceps", "leg press", "lec pres", "esmite" etc.
// Usada pela pesquisa (digitada ou por voz) da biblioteca de exercícios. Funciona no navegador (global BuscaFonetica)
// e no Node (require), para ser testada.
(function (raiz) {
  // Palavras em inglês (ou inglês abrasileirado) que as pessoas falam na academia -> termo usado na biblioteca.
  var APELIDOS = {
    deadlift: 'terra', 'dead lift': 'terra', 'dedlift': 'terra', squat: 'agachamento', bench: 'supino', 'bench press': 'supino',
    pulldown: 'puxada', 'pull down': 'puxada', 'puxador': 'puxada', pullover: 'pullover', 'pull over': 'pullover',
    row: 'remada', curl: 'rosca', 'biceps curl': 'rosca', lunge: 'afundo', lunges: 'afundo', plank: 'prancha', crunch: 'abdominal',
    kickback: 'coice', 'kick back': 'coice', 'chin up': 'barra fixa', 'pull up': 'barra fixa', pullup: 'barra fixa',
    'leg': 'leg', 'legpress': 'leg press', 'peckdeck': 'peck deck', 'pec deck': 'peck deck', 'pec dec': 'peck deck', 'voador': 'peck deck',
    'smith': 'smith', 'esmite': 'smith', 'esmith': 'smith', 'crossover': 'crossover', 'cross over': 'crossover', 'cross': 'cross',
    pulley: 'polia', puli: 'polia', pulei: 'polia', 'hack': 'hack', 'racc': 'hack', 'rack': 'hack', 'pecdeque': 'peck deck', 'pecdec': 'peck deck', 'quiquibeque': 'coice', 'kikibeque': 'coice', 'kiquibeque': 'coice', 'estife': 'stiff', 'stife': 'stiff',
  };

  function semAcento(t) {
    return String(t || '').toLowerCase().replace(/ç/g, 's').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Chave fonética simples (português + inglês abrasileirado): pronúncias parecidas viram o mesmo texto.
  function fonetica(palavra) {
    var s = semAcento(palavra).replace(/[^a-z0-9]/g, '');
    s = s.replace(/ph/g, 'f').replace(/th/g, 't').replace(/ck/g, 'c').replace(/qu/g, 'c').replace(/k/g, 'c')
      .replace(/ce|ci/g, function (m) { return 's' + m[1]; }).replace(/z/g, 's').replace(/y/g, 'i').replace(/w/g, 'u')
      .replace(/ai/g, 'i').replace(/ee/g, 'i').replace(/oo/g, 'u')
      .replace(/(.)\1+/g, '$1');
    // "e"/"i" final solto ("machine", "tricepi", "presse") não muda o som para quem fala rápido
    if (s.length > 4) s = s.replace(/[ei]$/, '');
    return s;
  }

  function distancia(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur.slice();
    }
    return prev[n];
  }

  var IGNORAR = { machine: 1, maquina: 1, exercicio: 1, exercicios: 1, treino: 1, de: 1, da: 1, do: 1, no: 1, na: 1, com: 1, para: 1, o: 1, a: 1, e: 1 };
  function palavras(t) { return semAcento(t).split(/[^a-z0-9]+/).filter(Boolean); }
  function palavrasDaConsulta(t) { var p = palavras(t); var u = p.filter(function (w) { return !IGNORAR[w]; }); return u.length ? u : p; }

  function aplicarApelidos(consulta) {
    var texto = ' ' + semAcento(consulta).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    Object.keys(APELIDOS).sort(function (a, b) { return b.length - a.length; }).forEach(function (k) {
      texto = texto.split(' ' + k + ' ').join(' ' + APELIDOS[k] + ' ');
    });
    return texto.trim();
  }

  // Devolve a lista dos itens que combinam com a consulta. `texto(item)` devolve o texto pesquisável (nome + grupo).
  function filtrar(itens, consulta, texto) {
    var q = aplicarApelidos(consulta);
    if (!q) return itens.slice();
    var qPalavras = palavrasDaConsulta(q);
    var qFon = qPalavras.map(fonetica).filter(Boolean);
    var qColado = fonetica(qPalavras.join(''));
    var info = itens.map(function (it) {
      var ps = palavras(texto(it));
      return { it: it, fon: ps.map(fonetica), colado: fonetica(ps.join('')) };
    });
    // 1) combinação direta: cada palavra dita aparece (como pedaço) no texto, ou a frase "colada" aparece ("tri ceps" = "triceps")
    var exato = info.filter(function (x) {
      return qFon.every(function (w) { return x.fon.some(function (f) { return w.length >= 3 ? f.indexOf(w) >= 0 : f.indexOf(w) === 0; }); }) || (qColado.length >= 4 && x.colado.indexOf(qColado) >= 0);
    });
    if (exato.length) return exato.map(function (x) { return x.it; });
    // 2) aproximada: cada palavra dita tem uma parecida (1 letra de diferença em palavras curtas, 2 nas longas)
    return info.filter(function (x) {
      return qFon.every(function (w) {
        var tol = w.length >= 7 ? 2 : (w.length >= 3 ? 1 : 0);
        return x.fon.some(function (f) {
          if (distancia(w, f) <= tol) return true;
          return f.length > w.length && distancia(w, f.slice(0, w.length)) <= tol; // começo da palavra
        });
      });
    }).map(function (x) { return x.it; });
  }

  var api = { filtrar: filtrar, fonetica: fonetica, aplicarApelidos: aplicarApelidos };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.BuscaFonetica = api;
})(typeof window !== 'undefined' ? window : this);
