import { serve } from "bun";

const clients = new Map<string, Bun.ServerWebSocket<any>>();

const server = serve({
  port: 3001,
  fetch(req, server) {
    // อัปเกรด HTTP Request เป็น WebSocket
    if (server.upgrade(req)) return;
    return new Response("WebRTC Signaling Server Running");
  },
  websocket: {
    open(ws) {
      // สร้าง ID แบบสุ่ม 8 ตัวอักษรให้ Client
      const id = crypto.randomUUID().slice(0, 8);
      (ws as any).id = id;
      
      // เก็บ Connection ไว้ใน Map
      clients.set(id, ws);
      
      // ส่ง ID กลับไปบอก Client
      ws.send(JSON.stringify({ type: "welcome", id }));
      console.log(`Client connected: ${id}`);
    },

    message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        const target = clients.get(data.to);
        
        // ถ้าเจอเป้าหมาย (data.to) ให้ส่งต่อข้อความไปหา
        if (target) {
          // console.log(`Forwarding ${data.type} from ${(ws as any).id} to ${data.to}`);
          target.send(JSON.stringify({
            ...data,
            from: (ws as any).id // แนบ ID ผู้ส่งไปด้วยเสมอ
          }));
        } else {
          // แจ้งเตือนถ้าหา user ปลายทางไม่เจอ (เฉพาะตอนเริ่มโทร)
          if (data.type === "offer") {
             ws.send(JSON.stringify({ type: "error", message: "User not found" }));
          }
        }
      } catch (e) {
        console.error("Error parsing message", e);
      }
    },

    close(ws) {
      const id = (ws as any).id;
      clients.delete(id);
      console.log(`Client disconnected: ${id}`);
    }
  }
});

// แสดง URL ที่ server กำลังรันอยู่
console.log(`🚀 WebRTC Signaling Server running at:`);
console.log(`   - HTTP: http://localhost:${server.port}`);
console.log(`   - WebSocket: ws://localhost:${server.port}`);
console.log(`   - Waiting for connections...`);