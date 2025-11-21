import { serve } from "bun";

const clients = new Map<string, Bun.ServerWebSocket<any>>();
const rooms = new Map<string, Set<string>>();

const server = serve({
  port: 3001,

  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      if (server.upgrade(req)) return;
      return new Response("WebRTC Signaling Server v2.1");
    }
    return new Response("NotFound", { status: 404 });
  },

  websocket: {
    open(ws) {
      const id = crypto.randomUUID().slice(0, 8);
      (ws as any).id = id;
      clients.set(id, ws);
      ws.send(JSON.stringify({ type: "welcome", id }));
      console.log(`✅ ${id} connected`);
    },

    message(ws, message) {
      const senderId = (ws as any).id;
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch {
        return;
      }

      // ── CALL USER ─────────────────────────────────────────────────
      if (data.type === "call_user") {
        const targetId = data.to;
        const roomId = data.room; // ใช้ room ที่ client ส่งมา (sorted แล้ว)

        if (!roomId) {
          ws.send(JSON.stringify({ type: "error", message: "No room" }));
          return;
        }

        const targetClient = clients.get(targetId);

        if (!targetClient || targetClient.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: `User ${targetId} offline` }));
          return;
        }

        // สร้าง room ถ้ายังไม่มี และ add caller
        let room = rooms.get(roomId);
        if (!room) {
          room = new Set([senderId]);
          rooms.set(roomId, room);
        } else {
          room.add(senderId);
        }

        targetClient.send(JSON.stringify({
          type: "incoming_call",
          from: senderId,
          room: roomId,          // ส่ง room เดียวกันกลับไป
          callType: data.callType || "voice"
        }));

        ws.send(JSON.stringify({ type: "call_initiated", room: roomId }));

        console.log(`📞 ${senderId} → ${targetId} [${roomId}]`);
        return;
      }

      // ── JOIN ROOM ───────────────────────────────────────────────
      if (data.type === "join") {
        const roomId = data.room;
        if (!roomId) return;

        let room = rooms.get(roomId);
        if (!room) {
          room = new Set();
          rooms.set(roomId, room);
        }
        room.add(senderId);

        ws.send(JSON.stringify({ type: "joined", room: roomId }));

        for (const peerId of room) {
          if (peerId !== senderId) {
            clients.get(peerId)?.send(JSON.stringify({
              type: "peer_joined",
              peerId: senderId,
              room: roomId
            }));
          }
        }
        console.log(`🚪 ${senderId} joined ${roomId}`);
        return;
      }

      // ── RELAY (offer, answer, ice, hangup, transcript, safemode_toggle) ──
      if (["offer", "answer", "ice", "hangup", "transcript", "safemode_toggle"].includes(data.type)) {
        const roomId = data.room;
        if (!roomId || !rooms.has(roomId)) return;

        const room = rooms.get(roomId)!;
        for (const clientId of room) {
          if (clientId !== senderId) {
            const target = clients.get(clientId);
            if (target?.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify({ ...data, from: senderId }));
            }
          }
        }
      }
    },

    close(ws) {
      const id = (ws as any).id;
      clients.delete(id);

      for (const [roomId, members] of rooms.entries()) {
        if (members.has(id)) {
          members.delete(id);
          for (const memberId of members) {
            clients.get(memberId)?.send(JSON.stringify({ type: "hangup", from: id }));
          }
          if (members.size === 0) rooms.delete(roomId);
        }
      }
      console.log(`❌ ${id} disconnected`);
    },
  },
});


console.log("🚀 WebRTC v2 Signaling Server Running");
console.log(`   - Local:   http://localhost:${server.port}`);
console.log(`   - Network: http://${server.hostname}:${server.port}`);
