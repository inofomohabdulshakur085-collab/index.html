// index_enterprise.js - enterprise backend with map, fleet, health, signaling
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const SECRET = process.env.JWT_SECRET || 'change-this-secret';
const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, 'data');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const robots = {}; // robot state & health
const maps = {}; // map_id -> metadata + json
const recordings = {};

const app = express();
app.use(cors());
app.use(bodyParser.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname, 'public')));

// simple login for demo
app.post('/api/login', (req,res)=>{
  const {user} = req.body;
  if(!user) return res.status(400).json({error:'user required'});
  const token = jwt.sign({user}, SECRET, {expiresIn:'12h'});
  res.json({token});
});

// Fleet endpoints
app.get('/api/fleet', (req,res)=>{
  res.json(Object.values(robots));
});
app.get('/api/fleet/:id', (req,res)=>{
  const r = robots[req.params.id];
  if(!r) return res.status(404).json({error:'not found'});
  res.json(r);
});

// Health endpoint
app.get('/api/health/:id', (req,res)=>{
  const r = robots[req.params.id];
  if(!r) return res.status(404).json({error:'not found'});
  res.json(r.health || {});
});

// Map endpoints
app.post('/api/maps', (req,res)=>{
  const id = 'map-'+Date.now();
  const payload = req.body;
  const file = path.join(DATA_DIR, id + '.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  maps[id] = { id, file, meta: payload.meta || {} };
  res.json({ id, meta: maps[id].meta });
});
app.get('/api/maps', (req,res)=>{
  res.json(Object.values(maps));
});
app.get('/api/maps/:id', (req,res)=>{
  const m = maps[req.params.id];
  if(!m) return res.status(404).json({error:'not found'});
  res.sendFile(m.file);
});

// export snapshot
app.post('/api/export_snapshot', (req,res)=>{
  const snapshot = { robots, maps, t: Date.now()/1000 };
  res.json(snapshot);
});

// WebSocket server: telemetry, commands, signaling
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// helper broadcast
function broadcast(msg, filterFn){
  const data = JSON.stringify(msg);
  wss.clients.forEach(c=>{
    if(c.readyState===WebSocket.OPEN){
      if(!filterFn || filterFn(c)) c.send(data);
    }
  });
}

wss.on('connection', (socket, req)=>{
  socket.isAlive = true;
  socket.on('pong', ()=> socket.isAlive = true);
  socket.on('message', (raw)=>{
    let msg;
    try{ msg = JSON.parse(raw); } catch(e){ return; }
    if(msg.type === 'auth'){
      try{
        const payload = jwt.verify(msg.token, SECRET);
        socket.user = payload.user;
        socket.send(JSON.stringify({type:'auth_ok'}));
      }catch(e){
        socket.send(JSON.stringify({type:'auth_error'}));
        socket.close();
      }
      return;
    }

    if(msg.type === 'telemetry'){
      // update robot state
      robots[msg.robot_id] = robots[msg.robot_id] || {};
      robots[msg.robot_id].robot_id = msg.robot_id;
      robots[msg.robot_id].pose = msg.pose;
      robots[msg.robot_id].speed = msg.speed;
      robots[msg.robot_id].battery = msg.battery;
      robots[msg.robot_id].last_seen = Date.now();
      // health may arrive under msg.health
      if(msg.health) robots[msg.robot_id].health = msg.health;
      // broadcast to frontends
      broadcast({type:'telemetry', ...msg});
      return;
    }

    if(msg.type === 'command'){
      // forward command to all robot clients (or specific)
      broadcast({type:'command', robot_id: msg.robot_id, cmd: msg.cmd});
      return;
    }

    if(msg.type === 'signal'){
      // simple signaling for WebRTC: forward to target id if connected
      const target = msg.target;
      wss.clients.forEach(c=>{
        if(c !== socket && c.readyState === WebSocket.OPEN && c.robot_id === target){
          c.send(JSON.stringify(msg));
        }
      });
      return;
    }

    // robot registration: robots can send 'register' with robot_id
    if(msg.type === 'register'){
      socket.robot_id = msg.robot_id;
      robots[msg.robot_id] = robots[msg.robot_id] || {};
      robots[msg.robot_id].robot_id = msg.robot_id;
      robots[msg.robot_id].last_seen = Date.now();
      socket.send(JSON.stringify({type:'registered', robot_id: msg.robot_id}));
      return;
    }
  });

  socket.on('close', ()=>{});
});

// ping/pong
setInterval(()=>{
  wss.clients.forEach(c=>{
    if(!c.isAlive) return c.terminate();
    c.isAlive = false;
    c.ping();
  });
}, 30000);

server.listen(PORT, ()=> console.log(`Enterprise backend listening on ${PORT}`));