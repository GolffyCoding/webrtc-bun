import { serve } from "bun";

const clients = new Map<string, Bun.ServerWebSocket<any>>();
const rooms = new Map<string, Set<string>>();
const heartbeatInterval = 30000; // 30 seconds
const heartbeatTimeout = 60000; // 60 seconds

// Heartbeat management
const heartbeats = new Map<string, number>();

// Cleanup inactive connections
const cleanupInactiveConnections = () => {
  const now = Date.now();
  for (const [clientId, lastHeartbeat] of heartbeats.entries()) {
    if (now - lastHeartbeat > heartbeatTimeout) {
      const client = clients.get(clientId);
      if (client) {
        console.log(`⚠️  Cleaning up inactive client: ${clientId}`);
        client.close();
        clients.delete(clientId);
        heartbeats.delete(clientId);
      }
    }
  }
  
  // Clean up empty rooms
  for (const [roomId, members] of rooms.entries()) {
    if (members.size === 0) {
      rooms.delete(roomId);
      console.log(`🧹 Cleaned up empty room: ${roomId}`);
    }
  }
};

// Start cleanup interval
setInterval(cleanupInactiveConnections, heartbeatInterval);

const server = serve({
  port: 3001,

  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      if (server.upgrade(req)) return;
      return new Response("WebRTC Signaling Server v2.3");
    }
    return new Response("NotFound", { status: 404 });
  },

  websocket: {
    open(ws) {
      const id = crypto.randomUUID().slice(0, 8);
      (ws as any).id = id;
      clients.set(id, ws);
      heartbeats.set(id, Date.now());
      ws.send(JSON.stringify({ type: "welcome", id }));
      console.log(`✅ ${id} connected (Total: ${clients.size})`);
    },

    message(ws, message) {
      const senderId = (ws as any).id;
      
      // Update heartbeat on any message
      heartbeats.set(senderId, Date.now());
      
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (e) {
        console.error(`❌ Invalid JSON from ${senderId}:`, message.toString().substring(0, 100));
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
        return;
      }

      // Handle heartbeat
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // ── CALL USER ─────────────────────────────────────────────────
      if (data.type === "call_user") {
        const targetId = data.to;
        const roomId = data.room;

        if (!roomId) {
          ws.send(JSON.stringify({ type: "error", message: "No room specified" }));
          return;
        }

        const targetClient = clients.get(targetId);

        if (!targetClient || targetClient.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: `User ${targetId} is offline` }));
          return;
        }

        // Create room if doesn't exist and add caller
        let room = rooms.get(roomId);
        if (!room) {
          room = new Set([senderId]);
          rooms.set(roomId, room);
        } else {
          room.add(senderId);
        }

        try {
          targetClient.send(JSON.stringify({
            type: "incoming_call",
            from: senderId,
            room: roomId,
            callType: data.callType || "voice"
          }));

          ws.send(JSON.stringify({ type: "call_initiated", room: roomId }));
          console.log(`📞 ${senderId} → ${targetId} [${roomId}]`);
        } catch (e) {
          console.error(`❌ Failed to send incoming_call to ${targetId}:`, e);
          ws.send(JSON.stringify({ type: "error", message: "Failed to connect to target user" }));
        }
        return;
      }

      // ── JOIN ROOM ───────────────────────────────────────────────
      if (data.type === "join") {
        const roomId = data.room;
        if (!roomId) {
          ws.send(JSON.stringify({ type: "error", message: "No room specified" }));
          return;
        }

        let room = rooms.get(roomId);
        if (!room) {
          room = new Set();
          rooms.set(roomId, room);
        }
        room.add(senderId);

        ws.send(JSON.stringify({ type: "joined", room: roomId }));

        // Notify other peers
        for (const peerId of room) {
          if (peerId !== senderId) {
            const peerClient = clients.get(peerId);
            if (peerClient?.readyState === WebSocket.OPEN) {
              try {
                peerClient.send(JSON.stringify({
                  type: "peer_joined",
                  peerId: senderId,
                  room: roomId
                }));
              } catch (e) {
                console.error(`❌ Failed to notify peer ${peerId}:`, e);
              }
            }
          }
        }
        console.log(`🚪 ${senderId} joined ${roomId} (Members: ${room.size})`);
        return;
      }

      // ── RELAY (offer, answer, ice, hangup, transcript, safemode_toggle) ──
      if (["offer", "answer", "ice", "hangup", "transcript", "safemode_toggle"].includes(data.type)) {
        const roomId = data.room;
        if (!roomId || !rooms.has(roomId)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid room" }));
          return;
        }

        const room = rooms.get(roomId)!;
        let successCount = 0;
        
        for (const clientId of room) {
          if (clientId !== senderId) {
            const target = clients.get(clientId);
            if (target?.readyState === WebSocket.OPEN) {
              try {
                target.send(JSON.stringify({ ...data, from: senderId }));
                successCount++;
              } catch (e) {
                console.error(`❌ Failed to relay message to ${clientId}:`, e);
              }
            }
          }
        }
        
        if (successCount === 0) {
          console.warn(`⚠️  No active peers to relay message in room ${roomId}`);
        }
      }
    },

    close(ws, code, message) {
      const id = (ws as any).id;
      clients.delete(id);
      heartbeats.delete(id);

      // Notify room members and clean up rooms
      for (const [roomId, members] of rooms.entries()) {
        if (members.has(id)) {
          members.delete(id);
          
          // Notify remaining members
          for (const memberId of members) {
            const memberClient = clients.get(memberId);
            if (memberClient?.readyState === WebSocket.OPEN) {
              try {
                memberClient.send(JSON.stringify({ type: "hangup", from: id }));
              } catch (e) {
                console.error(`❌ Failed to notify ${memberId} of disconnect:`, e);
              }
            }
          }
          
          // Remove empty rooms
          if (members.size === 0) {
            rooms.delete(roomId);
          }
        }
      }
      console.log(`❌ ${id} disconnected (Code: ${code}, Reason: ${message?.toString() || 'Unknown'}) (Remaining: ${clients.size})`);
    },
  },
});


console.log("🚀 WebRTC v2.3 Signaling Server Running");
console.log(`   - Local:   http://localhost:${server.port}`);
console.log(`   - Network: http://${server.hostname}:${server.port}`);
console.log(`   - Heartbeat: ${heartbeatInterval/1000}s | Timeout: ${heartbeatTimeout/1000}s`);
