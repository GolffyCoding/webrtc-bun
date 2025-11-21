import { serve } from "bun";

// เก็บ client socket ทั้งหมด
const clients = new Map<string, Bun.ServerWebSocket<any>>();

// เก็บว่า room ไหนมี client ไหนอยู่
const rooms = new Map<string, Set<string>>();

const server = serve({
  hostname: "0.0.0.0",
  port: 3001,

  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("WebRTC Signaling Server Running");
  },

  websocket: {
    open(ws) {
      // สร้าง id ให้ client
      const id = crypto.randomUUID().slice(0, 8);
      (ws as any).id = id;
      clients.set(id, ws);

      ws.send(JSON.stringify({ type: "welcome", id }));
      console.log(`Client connected: ${id}`);
    },

    message(ws, message) {
      const senderId = (ws as any).id;

      let data: any;
      try {
        data = JSON.parse(message.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      // -----------------------------
      // JOIN ROOM (1:1)
      // -----------------------------
      if (data.type === "join") {
        const roomId = data.room;
        if (!roomId) {
          ws.send(JSON.stringify({ type: "error", message: "Room ID required" }));
          return;
        }

        // ถ้าไม่มีห้อง → สร้างใหม่
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set());
        }

        const room = rooms.get(roomId)!;

        // จำกัดแค่ 2 คนต่อห้อง
        if (room.size >= 2) {
          ws.send(JSON.stringify({ type: "error", message: "Room full" }));
          return;
        }

        room.add(senderId);

        ws.send(JSON.stringify({ type: "joined", room: roomId }));
        console.log(`Client ${senderId} joined room ${roomId}`);
        return;
      }

      // -----------------------------
      // ส่งเฉพาะคนในห้องเดียวกัน
      // (offer / answer / ice)
      // -----------------------------
      if (["offer", "answer", "ice"].includes(data.type)) {
        const roomId = data.room;
        if (!roomId || !rooms.has(roomId)) return;

        const room = rooms.get(roomId)!;

        for (const clientId of room) {
          if (clientId !== senderId) {
            clients.get(clientId)?.send(
              JSON.stringify({
                ...data,
                from: senderId,
              })
            );
          }
        }

        return;
      }
    },

    close(ws) {
      const id = (ws as any).id;
      clients.delete(id);

      // ลบ client ออกจากทุกห้อง
      for (const [roomId, members] of rooms) {
        if (members.has(id)) {
          members.delete(id);
          console.log(`Client ${id} removed from room ${roomId}`);
        }
      }

      console.log(`Client disconnected: ${id}`);
    },
  },
});

// แสดงตอน server เริ่มรัน
console.log("🚀 WebRTC v1 Signaling Server Running");
console.log(`   - HTTP: http://localhost:${server.port}`);
console.log(`   - WS:   ws://localhost:${server.port}`);
console.log("   - Waiting for connections...");
