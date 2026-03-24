const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const adapter = new FileSync(path.join(DATA_DIR, 'db.json'));
const db = low(adapter);
db.defaults({ games: [], questions: [], players: [], answers: [] }).write();

// ─── Levenshtein fuzzy match ────────────────────────────────────────────────
function levenshtein(a, b) {
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function fuzzyMatch(guess, correct) {
  const g = guess.toLowerCase().trim();
  const c = correct.toLowerCase().trim();
  if (g === c) return true;
  const dist = levenshtein(g, c);
  // Allow 1 error for names ≤5 chars, 2 for ≤9, 3 for longer
  const tolerance = c.length <= 5 ? 1 : c.length <= 9 ? 2 : 3;
  return dist <= tolerance;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getGames()     { return db.get('games'); }
function getQuestions() { return db.get('questions'); }
function getPlayers()   { return db.get('players'); }
function getAnswers()   { return db.get('answers'); }
function gameById(id)   { return getGames().find({ id }).value(); }

function buildGameState(gameId) {
  const game = gameById(gameId);
  if (!game) return null;

  const questions = getQuestions().filter({ game_id: gameId }).sortBy('position').value();
  const players   = getPlayers().filter({ game_id: gameId }).sortBy('name').value();
  const answers   = getAnswers().filter({ game_id: gameId }).value();

  let currentQuestion = null;
  let currentAnswers  = [];
  let correctPlayers  = [];

  if (game.current_question_index >= 0 && questions[game.current_question_index]) {
    currentQuestion = questions[game.current_question_index];
    currentAnswers  = answers.filter(a => a.question_id === currentQuestion.id);
    correctPlayers  = currentAnswers
      .filter(a => a.is_correct)
      .map(a => {
        const p = players.find(p => p.id === a.player_id);
        return p ? { name: p.name, avatar: p.avatar || null } : null;
      })
      .filter(Boolean);
  }

  const scores = players.map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar || null,
    correct: answers.filter(a => a.player_id === p.id && a.is_correct).length
  })).sort((a, b) => b.correct - a.correct || a.name.localeCompare(b.name));

  // Which avatars are already claimed (for exclusive-pick logic)
  const claimedAvatars = players.filter(p => p.avatar).map(p => ({ playerId: p.id, avatar: p.avatar }));

  return {
    game,
    questions,
    players,
    currentQuestion,
    answers: currentAnswers,
    correctPlayers,
    scores,
    claimedAvatars,
    totalQuestions: questions.length,
    currentIndex: game.current_question_index,
    phase: game.phase,
    winner: game.winner,
    winnerAvatar: game.winnerAvatar || null
  };
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── SSE ─────────────────────────────────────────────────────────────────────
const sseClients = new Map();
function getSseClients(gameId) {
  if (!sseClients.has(gameId)) sseClients.set(gameId, new Set());
  return sseClients.get(gameId);
}
function broadcast(gameId, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  getSseClients(gameId).forEach(client => { try { client.res.write(msg); } catch(e) {} });
}

app.get('/api/events/:gameId', (req, res) => {
  const { gameId } = req.params;
  const { role, playerId } = req.query;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { res, role, playerId };
  getSseClients(gameId).add(client);

  const state = buildGameState(gameId);
  if (state) {
    res.write(`event: connected\ndata: ${JSON.stringify({ gameId, role })}\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  }

  if (role === 'player' && playerId) {
    getPlayers().find({ id: playerId }).assign({ connected: true }).write();
    broadcastPlayerList(gameId);
  }

  req.on('close', () => {
    getSseClients(gameId).delete(client);
    if (role === 'player' && playerId) {
      getPlayers().find({ id: playerId }).assign({ connected: false }).write();
      broadcastPlayerList(gameId);
    }
  });
});

function broadcastPlayerList(gameId) {
  const players = getPlayers().filter({ game_id: gameId }).sortBy('name').value();
  broadcast(gameId, 'players', { players });
}

// ─── Games ────────────────────────────────────────────────────────────────────
app.get('/api/games', (req, res) => {
  const games = getGames().value().map(g => ({
    ...g,
    question_count: getQuestions().filter({ game_id: g.id }).size().value(),
    player_count:   getPlayers().filter({ game_id: g.id }).size().value()
  })).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(games);
});

app.post('/api/games', (req, res) => {
  const { name, game_type } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const game = {
    id: uuidv4(), name,
    game_type: game_type || 'multiple_choice', // 'multiple_choice' | 'fill_in_the_blank'
    status: 'draft', current_question_index: -1,
    phase: 'waiting', winner: null, winnerAvatar: null,
    created_at: new Date().toISOString()
  };
  getGames().push(game).write();
  res.json(game);
});

app.get('/api/games/:id', (req, res) => {
  const state = buildGameState(req.params.id);
  if (!state) return res.status(404).json({ error: 'Not found' });
  res.json(state);
});

app.put('/api/games/:id', (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.game_type !== undefined) updates.game_type = req.body.game_type;
  getGames().find({ id: req.params.id }).assign(updates).write();
  res.json({ ok: true });
});

app.delete('/api/games/:id', (req, res) => {
  const id = req.params.id;
  getGames().remove({ id }).write();
  getQuestions().remove({ game_id: id }).write();
  getPlayers().remove({ game_id: id }).write();
  getAnswers().remove({ game_id: id }).write();
  res.json({ ok: true });
});

// ─── Questions ────────────────────────────────────────────────────────────────
app.get('/api/games/:id/questions', (req, res) => {
  res.json(getQuestions().filter({ game_id: req.params.id }).sortBy('position').value());
});

app.post('/api/games/:id/questions', (req, res) => {
  const { question_text, option_a, option_b, option_c, option_d, correct_answer } = req.body;
  const pos = (getQuestions().filter({ game_id: req.params.id }).maxBy('position').value()?.position || 0) + 1;
  const q = { id: uuidv4(), game_id: req.params.id, position: pos, question_text, option_a: option_a||null, option_b: option_b||null, option_c: option_c||null, option_d: option_d||null, correct_answer };
  getQuestions().push(q).write();
  res.json({ id: q.id });
});

app.put('/api/games/:id/questions/:qid', (req, res) => {
  const { question_text, option_a, option_b, option_c, option_d, correct_answer } = req.body;
  getQuestions().find({ id: req.params.qid, game_id: req.params.id })
    .assign({ question_text, option_a: option_a||null, option_b: option_b||null, option_c: option_c||null, option_d: option_d||null, correct_answer }).write();
  res.json({ ok: true });
});

app.delete('/api/games/:id/questions/:qid', (req, res) => {
  getQuestions().remove({ id: req.params.qid, game_id: req.params.id }).write();
  res.json({ ok: true });
});

// ─── Import ───────────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/games/:id/import', upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const gameId = req.params.id;
    if (req.query.replace === 'true') getQuestions().remove({ game_id: gameId }).write();
    let pos = (getQuestions().filter({ game_id: gameId }).maxBy('position').value()?.position || 0) + 1;
    let imported = 0;
    rows.forEach(row => {
      const qText   = row['Question'] || row['question'] || row['Q'] || row['question_text'];
      const correct = row['Correct Answer'] || row['correct_answer'] || row['Answer'] || row['correct'] || row['Correct'];
      if (!qText || !correct) return;
      getQuestions().push({
        id: uuidv4(), game_id: gameId, position: pos++,
        question_text: String(qText),
        option_a: row['A'] || row['Option A'] || row['option_a'] || null,
        option_b: row['B'] || row['Option B'] || row['option_b'] || null,
        option_c: row['C'] || row['Option C'] || row['option_c'] || null,
        option_d: row['D'] || row['Option D'] || row['option_d'] || null,
        correct_answer: String(correct)
      }).write();
      imported++;
    });
    res.json({ imported });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/games/:id/import-players', upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    const gameId = req.params.id;
    let imported = 0;
    rows.forEach(row => {
      const name = (row['Name'] || row['name'] || row['Player'] || row['player'] || '').toString().trim();
      if (!name) return;
      getPlayers().push({ id: uuidv4(), game_id: gameId, name, avatar: null, connected: false }).write();
      imported++;
    });
    res.json({ imported });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ─── Players ─────────────────────────────────────────────────────────────────
app.get('/api/games/:id/players', (req, res) => {
  res.json(getPlayers().filter({ game_id: req.params.id }).sortBy('name').value());
});

app.post('/api/games/:id/players', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const p = { id: uuidv4(), game_id: req.params.id, name: name.trim(), avatar: null, connected: false };
  getPlayers().push(p).write();
  res.json(p);
});

app.delete('/api/games/:id/players/:pid', (req, res) => {
  getPlayers().remove({ id: req.params.pid, game_id: req.params.id }).write();
  res.json({ ok: true });
});

// Set player avatar (with exclusive-pick logic: lock when < 19 players)
app.post('/api/players/:pid/avatar', (req, res) => {
  const { avatar } = req.body;
  const player = getPlayers().find({ id: req.params.pid }).value();
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const gameId = player.game_id;
  const totalPlayers = getPlayers().filter({ game_id: gameId }).size().value();

  // If < 19 players, check if avatar is already claimed by someone else
  if (totalPlayers < 19) {
    const alreadyClaimed = getPlayers().value().find(p =>
      p.game_id === gameId && p.avatar === avatar && p.id !== req.params.pid
    );
    if (alreadyClaimed) {
      return res.status(409).json({ error: 'Character already taken! Pick another one.' });
    }
  }

  getPlayers().find({ id: req.params.pid }).assign({ avatar }).write();
  broadcastPlayerList(gameId);
  res.json({ ok: true });
});

app.post('/api/join', (req, res) => {
  const { gameCode, playerName } = req.body;
  const code = gameCode.toUpperCase().trim();
  const game = getGames().value()
    .filter(g => g.status !== 'finished')
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
    .find(g => g.id.substring(0,6).toUpperCase() === code || g.id === gameCode);
  if (!game) return res.status(404).json({ error: 'Game not found. Check your code.' });
  const player = getPlayers().value()
    .find(p => p.game_id === game.id && p.name.toLowerCase() === playerName.trim().toLowerCase());
  if (!player) return res.status(404).json({ error: 'Name not found. Ask your host to add you.' });
  res.json({ gameId: game.id, playerId: player.id, playerName: player.name, gameName: game.name, gameType: game.game_type });
});

// ─── Answers ─────────────────────────────────────────────────────────────────
app.post('/api/games/:id/answers', (req, res) => {
  const { questionId, playerId, answer } = req.body;
  const question = getQuestions().find({ id: questionId }).value();
  if (!question) return res.status(404).json({ error: 'Question not found' });

  const game = gameById(req.params.id);
  let isCorrect;

  if (game && game.game_type === 'fill_in_the_blank') {
    // Fuzzy match for fill-in-the-blank
    isCorrect = fuzzyMatch(answer, question.correct_answer);
  } else {
    // Exact match (case-insensitive) for multiple choice
    isCorrect = answer.trim().toLowerCase() === question.correct_answer.trim().toLowerCase();
  }

  const existing = getAnswers().find({ question_id: questionId, player_id: playerId }).value();
  if (existing) {
    getAnswers().find({ question_id: questionId, player_id: playerId }).assign({ answer, is_correct: isCorrect }).write();
  } else {
    getAnswers().push({ id: uuidv4(), game_id: req.params.id, question_id: questionId, player_id: playerId, answer, is_correct: isCorrect, submitted_at: new Date().toISOString() }).write();
  }

  const allAnswers = getAnswers().filter({ question_id: questionId }).value();
  const totalPlayers = getPlayers().filter({ game_id: req.params.id }).size().value();
  broadcast(req.params.id, 'answer_update', { questionId, answers: allAnswers, answeredCount: allAnswers.length, totalPlayers });

  res.json({ ok: true, isCorrect });
});

// ─── Host Controls ────────────────────────────────────────────────────────────
app.post('/api/games/:id/start', (req, res) => {
  getGames().find({ id: req.params.id }).assign({ status: 'active', current_question_index: 0, phase: 'question' }).write();
  broadcast(req.params.id, 'state', buildGameState(req.params.id));
  res.json({ ok: true });
});

app.post('/api/games/:id/reveal', (req, res) => {
  getGames().find({ id: req.params.id }).assign({ phase: 'reveal' }).write();
  broadcast(req.params.id, 'state', buildGameState(req.params.id));
  res.json({ ok: true });
});

app.post('/api/games/:id/next', (req, res) => {
  const game = gameById(req.params.id);
  const totalQ = getQuestions().filter({ game_id: req.params.id }).size().value();
  const nextIdx = game.current_question_index + 1;
  if (nextIdx >= totalQ) {
    getGames().find({ id: req.params.id }).assign({ status: 'finished', phase: 'finished' }).write();
    broadcast(req.params.id, 'state', buildGameState(req.params.id));
    return res.json({ finished: true });
  }
  getGames().find({ id: req.params.id }).assign({ current_question_index: nextIdx, phase: 'question' }).write();
  broadcast(req.params.id, 'state', buildGameState(req.params.id));
  res.json({ ok: true, nextIdx });
});

app.post('/api/games/:id/winner', (req, res) => {
  const { winner } = req.body;
  const player = getPlayers().value().find(p => p.game_id === req.params.id && p.name === winner);
  const winnerAvatar = player ? player.avatar : null;
  getGames().find({ id: req.params.id }).assign({ winner, winnerAvatar, phase: 'winner' }).write();
  broadcast(req.params.id, 'state', buildGameState(req.params.id));
  res.json({ ok: true });
});

app.post('/api/games/:id/auto-winner', (req, res) => {
  const players = getPlayers().filter({ game_id: req.params.id }).value();
  const answers = getAnswers().filter({ game_id: req.params.id, is_correct: true }).value();
  let top = null, topScore = -1;
  players.forEach(p => {
    const score = answers.filter(a => a.player_id === p.id).length;
    if (score > topScore) { topScore = score; top = p; }
  });
  const winner = top ? top.name : 'Unknown';
  const winnerAvatar = top ? top.avatar : null;
  getGames().find({ id: req.params.id }).assign({ winner, winnerAvatar, phase: 'winner' }).write();
  broadcast(req.params.id, 'state', buildGameState(req.params.id));
  res.json({ ok: true, winner });
});

app.post('/api/games/:id/reset', (req, res) => {
  getGames().find({ id: req.params.id }).assign({ status: 'draft', current_question_index: -1, phase: 'waiting', winner: null, winnerAvatar: null }).write();
  getAnswers().remove({ game_id: req.params.id }).write();
  broadcast(req.params.id, 'state', buildGameState(req.params.id));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🎮 RealityChecking Games running at http://localhost:${PORT}`);
  console.log(`   Admin:  http://localhost:${PORT}/admin`);
  console.log(`   Host:   http://localhost:${PORT}/host`);
  console.log(`   Player: http://localhost:${PORT}/player\n`);
});
